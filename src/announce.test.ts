import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Release } from "./github";

// announce.ts imports the `config` singleton (resolved from process.env at import time), so
// prime the required vars before pulling the module in — see config.test.ts.
process.env.DISCORD_TOKEN ??= "test-token";
process.env.ANNOUNCE_CHANNEL_ID ??= "100";
const { runTick, guardedTick, resetTickGuardForTest, commitReleaseAnnouncements } = await import("./announce");

// Scoped to runTick's isolation guarantee (issue #43) — not a wider push at #57's broader
// "no announce/dmf tests" gap. checkDmf/checkWeeklyReset/etc. call real discord.js/Blizzard/
// GitHub APIs and aren't exported, so this exercises the actual extracted isolation mechanism
// onTick delegates to, rather than mocking discord.js's Client end-to-end.
describe("runTick", () => {
  test("a throwing check doesn't stop the rest from running", async () => {
    const ran: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    await runTick([
      { name: "dmf", run: async () => void ran.push("dmf") },
      {
        name: "boom",
        run: async () => {
          throw new Error("bad DMF_TIMEZONE");
        },
      },
      { name: "realm", run: async () => void ran.push("realm") },
    ]);
    // The crux of the fix: realm still ran despite boom throwing between it and dmf. Asserted
    // before mockRestore(), which clears the spy's own call history.
    expect(ran).toEqual(["dmf", "realm"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("logs the failing check's name, not just a bare error", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    await runTick([
      {
        name: "dmf",
        run: async () => {
          throw new Error("bad DMF_TIMEZONE");
        },
      },
    ]);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("dmf");
    errorSpy.mockRestore();
  });

  test("runs checks in the given order", async () => {
    const ran: string[] = [];
    await runTick([
      { name: "a", run: async () => void ran.push("a") },
      { name: "b", run: async () => void ran.push("b") },
      { name: "c", run: async () => void ran.push("c") },
    ]);
    expect(ran).toEqual(["a", "b", "c"]);
  });

  test("a later check's throw doesn't retroactively affect an earlier one that already ran", async () => {
    const ran: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runTick([
        { name: "first", run: async () => void ran.push("first") },
        {
          name: "second",
          run: async () => {
            throw new Error("boom");
          },
        },
      ]);
    } finally {
      errorSpy.mockRestore();
    }
    expect(ran).toEqual(["first"]);
  });
});

// #52 item 1: without this guard, a second tick starting while the first is still stalled (e.g.
// a slow Discord send — discord.js retries 3x with a 15s timeout each) can race the same
// dedup-key check the first tick hasn't written yet, producing a duplicate announcement. Driven
// directly rather than through checkWeeklyReset (which calls real discord.js), since the guard
// is what actually closes the race for every check that goes through onTick — matching this
// file's existing pattern of testing the extracted isolation mechanism, not the discord.js-
// dependent checks themselves.
describe("guardedTick", () => {
  afterEach(() => {
    resetTickGuardForTest();
  });

  test("a second tick started while the first is still running skips entirely, not queues", async () => {
    let resolveFirst!: () => void;
    const firstBody = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let secondRan = false;

    const first = guardedTick(() => firstBody);
    const second = guardedTick(async () => void (secondRan = true));
    await second;
    expect(secondRan).toBe(false); // skipped outright, never queued behind the first

    resolveFirst();
    await first;

    // The guard is released once the first tick finishes — a later tick runs normally again.
    let thirdRan = false;
    await guardedTick(async () => void (thirdRan = true));
    expect(thirdRan).toBe(true);
  });

  test("a lone tick with no overlap always runs", async () => {
    let ran = false;
    await guardedTick(async () => void (ran = true));
    expect(ran).toBe(true);
  });

  test("a tick that throws still releases the guard for the next one", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        guardedTick(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    } finally {
      errorSpy.mockRestore();
    }
    let ranAfter = false;
    await guardedTick(async () => void (ranAfter = true));
    expect(ranAfter).toBe(true);
  });

  // An occasional single skip under an ordinarily-slow tick is expected and not itself worth
  // flagging — only repeated skipping (the previous tick genuinely stuck) is.
  test("logs only once skipping becomes repeated (2+ in a row), not on the first skip", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let resolveFirst!: () => void;
      const firstBody = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      const first = guardedTick(() => firstBody);

      await guardedTick(async () => {}); // 1st skip — silent
      expect(warnSpy).not.toHaveBeenCalled();

      await guardedTick(async () => {}); // 2nd skip in a row — now warns
      expect(warnSpy).toHaveBeenCalled();

      resolveFirst();
      await first;
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// #52 item 2: checkRepoReleases used to save `nextSeen` once after posting the whole batch, so a
// throw partway through a multi-release burst discarded the ids of releases already posted —
// the next poll re-announced them. commitReleaseAnnouncements is the extracted core (decoupled
// from discord.js/state.ts, injected instead — same shape as runTick/guardedTick above) that
// commits each id right after its own announce succeeds.
describe("commitReleaseAnnouncements", () => {
  const release = (id: number): Release => ({
    id,
    name: `v${id}`,
    tag: `v${id}`,
    url: `https://example.com/${id}`,
  });

  // The issue's literal acceptance bullet. `releases` is passed newest-first (GitHub's own API
  // order), which decideReleaseAnnouncements reverses — so toAnnounce ends up oldest-first,
  // [1, 2, 3], with id 2 the one that throws.
  test("a throw partway through a burst still persists the ids already announced", async () => {
    const releases = [release(3), release(2), release(1)];
    const announced: number[] = [];
    const persisted: number[][] = [];
    await expect(
      commitReleaseAnnouncements(releases, [], {
        announce: async (r) => {
          announced.push(r.id);
          if (r.id === 2) throw new Error("Discord 5xx");
        },
        persist: async (seen) => void persisted.push([...seen]),
      }),
    ).rejects.toThrow("Discord 5xx");
    expect(announced).toEqual([1, 2]); // #3 never attempted
    expect(persisted.at(-1)).toEqual([1]); // #1 survived #2's throw, not discarded with the batch
  });

  test("every release announces successfully — all ids persisted, saved once per release", async () => {
    const releases = [release(3), release(2), release(1)];
    const announced: number[] = [];
    const persisted: number[][] = [];
    await commitReleaseAnnouncements(releases, [], {
      announce: async (r) => void announced.push(r.id),
      persist: async (seen) => void persisted.push([...seen]),
    });
    expect(announced).toEqual([1, 2, 3]);
    expect(persisted).toEqual([[1], [1, 2], [1, 2, 3]]);
  });

  test("an existing seen list is extended, not replaced", async () => {
    const releases = [release(2), release(1)];
    const persisted: number[][] = [];
    await commitReleaseAnnouncements(releases, [0], {
      announce: async () => {},
      persist: async (seen) => void persisted.push([...seen]),
    });
    expect(persisted.at(-1)).toEqual([0, 1, 2]);
  });

  test("the first-ever poll (seen undefined) seeds silently — nothing announced, full list persisted", async () => {
    const releases = [release(2), release(1)];
    const announced: number[] = [];
    let persisted: number[] | undefined;
    await commitReleaseAnnouncements(releases, undefined, {
      announce: async (r) => void announced.push(r.id),
      persist: async (seen) => void (persisted = seen),
    });
    expect(announced).toEqual([]);
    expect(persisted).toEqual([2, 1]);
  });

  test("no new releases still persists (a harmless no-op save), nothing announced", async () => {
    const releases = [release(1)];
    const announced: number[] = [];
    let persisted: number[] | undefined;
    await commitReleaseAnnouncements(releases, [1], {
      announce: async (r) => void announced.push(r.id),
      persist: async (seen) => void (persisted = seen),
    });
    expect(announced).toEqual([]);
    expect(persisted).toEqual([1]);
  });
});
