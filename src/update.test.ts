import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReplacementProbe } from "./redeploy";
import type { SwapInFlight } from "./state";

// `update.ts` pulls in the `config` singleton, which resolves process.env at import time -- the
// required vars are primed once by test/setup.ts's bunfig preload (#136).
const {
  checkForUpdate,
  decideAttemptResolution,
  decideUpdate,
  sameSha,
  buildUpdateReport,
  fetchShaRelation,
  resetUpdateForTest,
  resolveUpdateAttempt,
  SWAP_RECORD_MAX_AGE_MS,
  updateStateForTest,
} = await import("./update");
const { beginHandoff, endHandoff, setExitFn, resetForTest: resetRestartForTest, restartPending, withCritical, RESTART_EXIT_CODE } =
  await import("./restart");
const { config } = await import("./config");
const { state, saveState } = await import("./state");
const { shortSha, DATA_DIR } = await import("./storage");

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

/** The requester an `/update` records (#450's tests read it back from disk). */
const REQUESTER = { userId: "42", channelId: "100", applicationId: "999", interactionToken: "tok" };
/** `state.json` as the arming save left it (the test data dir, test/setup.ts's per-run BOT_DATA_DIR). */
const onDisk = () => JSON.parse(readFileSync(join(DATA_DIR, "state.json"), "utf8")) as Record<string, any>;

/** GitHub answering "the newest bot commit is `latest`, and we are behind it". */
function stubGitHub(latest = NEW): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/commits?")) {
      return new Response(JSON.stringify([{ sha: latest }]), { status: 200 });
    }
    if (url.includes("/compare/")) {
      return new Response(JSON.stringify({ status: "behind" }), { status: 200 });
    }
    throw new Error(`unmocked fetch in test: ${url}`);
  }) as typeof fetch;
}

describe("sameSha", () => {
  test("matches identical shas", () => {
    expect(sameSha(NEW, NEW)).toBe(true);
  });

  test("matches a short sha against the full one", () => {
    expect(sameSha("abc1234", "abc1234def5678")).toBe(true);
    expect(sameSha("abc1234def5678", "abc1234")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(sameSha("ABC1234", "abc1234")).toBe(true);
  });

  test("rejects differing shas", () => {
    expect(sameSha(OLD, NEW)).toBe(false);
    expect(sameSha("abc1234", "abc9999")).toBe(false);
  });

  test("an empty sha never matches", () => {
    expect(sameSha("", NEW)).toBe(false);
  });
});

describe("decideUpdate", () => {
  test("disabled without a baked-in GIT_SHA", () => {
    expect(decideUpdate({ latestSha: NEW })).toBe("disabled");
    expect(decideUpdate({ runningSha: "", latestSha: NEW })).toBe("disabled");
  });

  test("current when running the newest bot commit", () => {
    expect(decideUpdate({ runningSha: NEW, latestSha: NEW })).toBe("current");
  });

  test("current when a short GIT_SHA prefixes the newest commit", () => {
    expect(decideUpdate({ runningSha: shortSha(NEW), latestSha: NEW })).toBe("current");
  });

  test("restart when stale", () => {
    expect(decideUpdate({ runningSha: OLD, latestSha: NEW })).toBe("restart");
  });

  test("suppressed when we already exited for this sha and came back unchanged", () => {
    expect(decideUpdate({ runningSha: OLD, latestSha: NEW, attemptedSha: NEW })).toBe("suppressed");
  });

  test("restart when the attempt marker is for an older sha than the one now pending", () => {
    const NEWER = "c".repeat(40);
    expect(decideUpdate({ runningSha: OLD, latestSha: NEWER, attemptedSha: NEW })).toBe("restart");
  });

  test("force overrides suppression", () => {
    expect(
      decideUpdate({ runningSha: OLD, latestSha: NEW, attemptedSha: NEW, force: true }),
    ).toBe("restart");
  });

  test("force still reports current rather than restarting a fresh build", () => {
    expect(decideUpdate({ runningSha: NEW, latestSha: NEW, force: true })).toBe("current");
  });

  test("force cannot enable updates without a GIT_SHA", () => {
    expect(decideUpdate({ latestSha: NEW, force: true })).toBe("disabled");
  });
});

// nazumods/wow#871: staleness is an ancestry question, not an equality one. GIT_SHA is the tip the image was
// built from, which on most days is a main commit NEWER than the last bot-touching commit.
describe("decideUpdate ancestry", () => {
  // The regression that motivated the issue: a correct, current deploy built from a main tip that
  // already contains the newest bot commit. Under sha equality this was "restart" every time.
  test("ahead is current — a build newer than the last bot commit is not stale", () => {
    expect(decideUpdate({ runningSha: OLD, latestSha: NEW, relation: "ahead" })).toBe("current");
  });

  test("identical is current", () => {
    expect(decideUpdate({ runningSha: OLD, latestSha: NEW, relation: "identical" })).toBe("current");
  });

  test("behind still restarts — genuinely missing bot code", () => {
    expect(decideUpdate({ runningSha: OLD, latestSha: NEW, relation: "behind" })).toBe("restart");
  });

  // Answers the same question as `behind` with the same no: this build doesn't contain it.
  test("diverged restarts", () => {
    expect(decideUpdate({ runningSha: OLD, latestSha: NEW, relation: "diverged" })).toBe("restart");
  });

  // A sha the remote has never seen can never be matched, so an update would be undeliverable.
  test("unpublished disables rather than offering an update it can never deliver", () => {
    expect(decideUpdate({ runningSha: OLD, latestSha: NEW, relation: "unpublished" })).toBe(
      "disabled",
    );
  });

  test("unpublished outranks the anti-loop suppression", () => {
    expect(
      decideUpdate({ runningSha: OLD, latestSha: NEW, relation: "unpublished", attemptedSha: NEW }),
    ).toBe("disabled");
  });

  test("force cannot turn an unpublished sha into a restart", () => {
    expect(
      decideUpdate({ runningSha: OLD, latestSha: NEW, relation: "unpublished", force: true }),
    ).toBe("disabled");
  });

  // An API failure must not invent a verdict — it degrades to the pre-nazumods/wow#871 behaviour.
  test("unknown falls back to treating a sha mismatch as stale", () => {
    expect(decideUpdate({ runningSha: OLD, latestSha: NEW, relation: "unknown" })).toBe("restart");
    expect(
      decideUpdate({ runningSha: OLD, latestSha: NEW, relation: "unknown", attemptedSha: NEW }),
    ).toBe("suppressed");
  });

  // The shortcut is what keeps the common path at one request: matching shas never consult it.
  test("the equality shortcut wins before any relation is read", () => {
    expect(decideUpdate({ runningSha: NEW, latestSha: NEW, relation: "behind" })).toBe("current");
    expect(decideUpdate({ runningSha: shortSha(NEW), latestSha: NEW, relation: "unpublished" })).toBe(
      "current",
    );
  });

  // Missing GIT_SHA is decided before ancestry is even relevant.
  test("no running sha is disabled whatever the relation says", () => {
    expect(decideUpdate({ latestSha: NEW, relation: "ahead" })).toBe("disabled");
  });
});

describe("fetchShaRelation", () => {
  const realFetch = globalThis.fetch;
  const stub = (impl: () => Promise<Response> | Response) => {
    globalThis.fetch = impl as unknown as typeof fetch;
  };
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const ok = (status: string) =>
    new Response(JSON.stringify({ status }), { status: 200, headers: { "Content-Type": "application/json" } });

  for (const status of ["identical", "ahead", "behind", "diverged"] as const) {
    test(`passes through ${status}`, async () => {
      stub(() => ok(status));
      expect(await fetchShaRelation(NEW, OLD)).toBe(status);
    });
  }

  test("404 means the running sha isn't on the remote", async () => {
    stub(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    expect(await fetchShaRelation(NEW, OLD)).toBe("unpublished");
  });

  test("a 404 with no body at all still falls back to unpublished", async () => {
    stub(() => new Response("", { status: 404 }));
    expect(await fetchShaRelation(NEW, OLD)).toBe("unpublished");
  });

  // A history rewrite of BOT_BRANCH can leave a deployed sha still on the remote but sharing no
  // ancestry with the newest commit — GitHub answers that with a 404 too, but it means `diverged`
  // (a rebuild would work), not `unpublished` (nothing to compare against at all).
  test("a 404 with 'no common ancestor' means diverged, not unpublished", async () => {
    stub(() =>
      new Response(JSON.stringify({ message: "No common ancestor between abc123 and def456" }), { status: 404 }),
    );
    expect(await fetchShaRelation(NEW, OLD)).toBe("diverged");
  });

  test("the no-common-ancestor check is case-insensitive", async () => {
    stub(() => new Response(JSON.stringify({ message: "NO COMMON ANCESTOR" }), { status: 404 }));
    expect(await fetchShaRelation(NEW, OLD)).toBe("diverged");
  });

  test("a server error is unknown, not a throw", async () => {
    stub(() => new Response("", { status: 500 }));
    expect(await fetchShaRelation(NEW, OLD)).toBe("unknown");
  });

  // Startup awaits this, so a network failure escaping here would take the bot down with it.
  test("a network failure is unknown, not a throw", async () => {
    stub(() => Promise.reject(new Error("ECONNREFUSED")));
    expect(await fetchShaRelation(NEW, OLD)).toBe("unknown");
  });

  test("an unrecognised status is unknown", async () => {
    stub(() => ok("sideways"));
    expect(await fetchShaRelation(NEW, OLD)).toBe("unknown");
  });

  // Base is the newest bot commit, head is us — so `ahead` reads as "we contain it".
  test("compares latest...running, in that order", async () => {
    let seen = "";
    stub((...args: unknown[]) => {
      seen = String((args as [string])[0]);
      return ok("ahead");
    });
    await fetchShaRelation(NEW, OLD);
    expect(seen).toContain(`/compare/${NEW}...${OLD}`);
    // #506: only `status` is read, so the commits list the endpoint attaches is bounded to one.
    expect(seen).toContain("?per_page=1");
  });
});

describe("checkForUpdate during a handoff", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    endHandoff();
  });

  // The guard must come before everything — a second /update mid-swap would overwrite the
  // in-flight attempt's pendingUpdateReport and then force-remove its replacement. Proven by
  // making the network unreachable: `busy` coming back means no sha was ever fetched.
  test("refuses with busy before touching the network", async () => {
    globalThis.fetch = (() => {
      throw new Error("checkForUpdate reached the network while a handoff was active");
    }) as unknown as typeof fetch;
    beginHandoff("test swap in flight");
    expect((await checkForUpdate({ force: true })).decision).toBe("busy");
  });
});

describe("checkForUpdate — anti-loop suppression after a failed in-process redeploy (#50)", () => {
  const realFetch = globalThis.fetch;
  const realGitSha = config.gitSha;

  beforeEach(() => {
    config.gitSha = OLD;
    state.attemptedUpdateToSha = undefined;
    state.pendingUpdateReport = undefined;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    config.gitSha = realGitSha;
    state.attemptedUpdateToSha = undefined;
    state.pendingUpdateReport = undefined;
    state.swapInFlight = undefined;
    // A failing redeploy() records a failure and a once-per-sha warning in this module (#506): forget them,
    // or the test-state guard fails the test that left them.
    resetUpdateForTest();
    // No saveState() flush here any more (#139). This used to write the real, gitignored
    // data/state.json on purpose — mitigating the corruption by writing MORE — because the real
    // saveState() went to the checkout. It now goes to the test override, so there is nothing to
    // clean up and the in-memory reset above is the whole job.
  });

  // The crux of #50: applyUpdate used to clear attemptedUpdateToSha unconditionally after a
  // redeploy() failure (redeploy() resolving at all means it failed — success kills the process
  // mid-await), so decideUpdate could never reach `suppressed` for this path and the scheduler
  // rebuilt the same broken sha every tick, forever.
  test("a failed redeploy suppresses the next unforced check for the same sha", async () => {
    stubGitHub();
    const failing = {
      redeployAvailable: async () => true,
      redeploy: async () => ({ outcome: "failed" as const, error: "boom" }),
    };

    const first = await checkForUpdate({}, failing);
    expect(first.decision).toBe("restart");
    expect(state.attemptedUpdateToSha).toBe(NEW); // not cleared by the failed attempt

    let redeployCalled = false;
    const tracked = {
      redeployAvailable: async () => true,
      redeploy: async () => {
        redeployCalled = true;
        return { outcome: "failed" as const };
      },
    };
    const second = await checkForUpdate({}, tracked);
    expect(second.decision).toBe("suppressed");
    expect(redeployCalled).toBe(false);
  });

  test("force still retries a sha that already failed", async () => {
    stubGitHub();
    state.attemptedUpdateToSha = NEW; // as if a prior attempt already failed
    let redeployCalled = false;
    const deps = {
      redeployAvailable: async () => true,
      redeploy: async () => {
        redeployCalled = true;
        return { outcome: "failed" as const };
      },
    };
    expect((await checkForUpdate({ force: true }, deps)).decision).toBe("restart");
    expect(redeployCalled).toBe(true);
  });
});

describe("checkForUpdate — concurrent calls before any handoff begins (#51 item 4)", () => {
  const realFetch = globalThis.fetch;
  const realGitSha = config.gitSha;

  beforeEach(() => {
    config.gitSha = OLD;
    state.attemptedUpdateToSha = undefined;
    state.pendingUpdateReport = undefined;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    config.gitSha = realGitSha;
    state.attemptedUpdateToSha = undefined;
    state.pendingUpdateReport = undefined;
    state.swapInFlight = undefined;
    resetUpdateForTest(); // a failing redeploy() records a failure in this module (#506)
    // No saveState() flush — see the note on the sibling afterEach above (#139).
  });

  // `handoffActive()` alone doesn't read true until `redeploy()` calls `beginHandoff()` just
  // before creating the replacement (#130 moved it past the build) — so a second call fired while
  // the first is still mid-flight (two GitHub fetches, a state save, `redeployAvailable()`, and
  // the build) used to sail straight past the guard and reach `redeploy()` too, racing two
  // builds/containers targeting the same tag and container name.
  // Fired back-to-back with neither awaited first — mirrors two /update presses landing before
  // either has finished its own async work — this only exercises the guard if it is claimed
  // synchronously, before the first `await`.
  test("a second concurrent call refuses busy instead of racing the first into redeploy", async () => {
    stubGitHub();
    let redeployCalls = 0;
    const deps = {
      redeployAvailable: async () => true,
      redeploy: async () => {
        redeployCalls += 1;
        return { outcome: "failed" as const };
      },
    };

    const first = checkForUpdate({ force: true }, deps);
    const second = checkForUpdate({ force: true }, deps);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.decision).toBe("restart");
    expect(secondResult.decision).toBe("busy");
    expect(redeployCalls).toBe(1);
  });

  // The test-state guard (test/stateGuard.ts) decides from this snapshot alone, so it must track the
  // live flag, and the reset must really release it.
  test("updateStateForTest reports a check in flight, and resetUpdateForTest releases it", async () => {
    stubGitHub();
    const deps = { redeployAvailable: async () => true, redeploy: async () => ({ outcome: "failed" as const }) };
    expect(updateStateForTest().checkInFlight).toBe(false);
    const first = checkForUpdate({ force: true }, deps);
    expect(updateStateForTest().checkInFlight).toBe(true);
    resetUpdateForTest();
    expect(updateStateForTest().checkInFlight).toBe(false);
    await first;
    expect(updateStateForTest().checkInFlight).toBe(false);
  });

  // The flag must release on every exit, not just the "restart" path — otherwise one busy/current/
  // suppressed call would wedge every later one behind a guard nothing will ever clear.
  test("the guard releases after a non-restart decision, so the next call isn't wedged busy", async () => {
    config.gitSha = NEW; // current — decideUpdate short-circuits before the guard matters
    stubGitHub();

    const first = await checkForUpdate();
    expect(first.decision).toBe("current");

    const second = await checkForUpdate();
    expect(second.decision).toBe("current");
  });
});

// #450: what a boot makes of the swap record its previous life left. Pure: the table of rows the resolver acts on.
describe("decideAttemptResolution (#450)", () => {
  const NOW = 1_700_000_000_000;
  const swap = { fromSha: OLD, toSha: NEW, startedAt: NOW - 1000 };
  const alive = (status: string): ReplacementProbe => ({ kind: "alive", name: "bot-next", status });
  const stopped = (status: string): ReplacementProbe => ({ kind: "stopped", name: "bot-next", status });
  const unknown: ReplacementProbe = { kind: "unknown", name: "bot-next", error: "timed out" };

  test("no record is none", () => {
    expect(decideAttemptResolution({ runningSha: OLD, now: NOW })).toBe("none");
  });

  test("a build with no sha cannot resolve anything: stale", () => {
    expect(decideAttemptResolution({ swap, now: NOW })).toBe("stale");
    expect(decideAttemptResolution({ swap, runningSha: "", now: NOW })).toBe("stale");
  });

  test("running the target is the swap that landed, whole or short sha, and the probe is not read", () => {
    expect(decideAttemptResolution({ swap, runningSha: NEW, now: NOW })).toBe("landed");
    expect(decideAttemptResolution({ swap, runningSha: NEW.slice(0, 7), now: NOW })).toBe("landed");
    expect(decideAttemptResolution({ swap, runningSha: NEW, probe: alive("running"), now: NOW })).toBe("landed");
  });

  test("back on the source build beside a live replacement is in flight", () => {
    expect(decideAttemptResolution({ swap, runningSha: OLD, probe: alive("running"), now: NOW })).toBe("in-flight");
    expect(decideAttemptResolution({ swap, runningSha: OLD, probe: alive("restarting"), now: NOW })).toBe("in-flight");
  });

  test("a probe that cannot tell is in flight too, until the record is a day old", () => {
    expect(decideAttemptResolution({ swap, runningSha: OLD, probe: unknown, now: NOW })).toBe("in-flight");
    const bound = swap.startedAt + SWAP_RECORD_MAX_AGE_MS;
    expect(decideAttemptResolution({ swap, runningSha: OLD, probe: unknown, now: bound })).toBe("in-flight"); // strict
    expect(decideAttemptResolution({ swap, runningSha: OLD, probe: unknown, now: bound + 1 })).toBe("interrupted");
    expect(SWAP_RECORD_MAX_AGE_MS).toBe(86_400_000);
  });

  test("back on the source build with nothing alive is interrupted", () => {
    for (const status of ["exited", "created", "dead"]) {
      expect(decideAttemptResolution({ swap, runningSha: OLD, probe: stopped(status), now: NOW })).toBe("interrupted");
    }
    expect(decideAttemptResolution({ swap, runningSha: OLD, probe: { kind: "absent", name: "bot-next" }, now: NOW })).toBe("interrupted");
    expect(decideAttemptResolution({ swap, runningSha: OLD, now: NOW })).toBe("interrupted");
  });

  test("a third build is stale", () => {
    expect(decideAttemptResolution({ swap, runningSha: "c".repeat(40), probe: alive("running"), now: NOW })).toBe("stale");
  });
});

// #450, #452, #449 (the guard), #506 items 12 and 13: the arming save, the failure tail, the busy guard and the warning.
describe("checkForUpdate — the attempt record (#450, #452, #449, #506)", () => {
  const realFetch = globalThis.fetch;
  const realGitSha = config.gitSha;
  /** A redeploy() that failed, after recording what state.json held when it ran. */
  const failing = (seen?: (disk: ReturnType<typeof onDisk>) => void, error = "boom") => ({
    redeployAvailable: async () => true,
    redeploy: async () => {
      seen?.(onDisk());
      return { outcome: "failed" as const, error };
    },
  });
  const clearDisk = async () => {
    state.attemptedUpdateToSha = undefined;
    state.pendingUpdateReport = undefined;
    state.swapInFlight = undefined;
    await saveState();
  };

  beforeEach(async () => {
    config.gitSha = OLD;
    await clearDisk();
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    config.gitSha = realGitSha;
    await clearDisk();
    resetUpdateForTest();
    resetRestartForTest();
  });

  test("the attempt, the report and the swap record are on disk before redeploy runs; a failed swap clears the record and the report it armed (#452, #450)", async () => {
    stubGitHub();
    let seen: ReturnType<typeof onDisk> | undefined;
    const before = Date.now();
    const result = await checkForUpdate({ force: true, requester: REQUESTER }, failing((d) => (seen = d)));
    const finished = Date.now();

    expect(result.decision).toBe("restart");
    expect(seen!.attemptedUpdateToSha).toBe(NEW);
    expect(seen!.pendingUpdateReport).toMatchObject({ ...REQUESTER, fromSha: OLD, toSha: NEW });
    expect(typeof seen!.pendingUpdateReport.requestedAt).toBe("number");
    expect(seen!.swapInFlight).toMatchObject({ fromSha: OLD, toSha: NEW });
    // The clock the 24 h bound reads: a 0 here would make every `unknown` probe resolve `interrupted` at once.
    expect(seen!.swapInFlight.startedAt).toBeGreaterThanOrEqual(before);
    expect(seen!.swapInFlight.startedAt).toBeLessThanOrEqual(finished);

    const after = onDisk();
    expect(after.pendingUpdateReport).toBeUndefined();
    expect(after.swapInFlight).toBeUndefined();
    expect(after.attemptedUpdateToSha).toBe(NEW); // kept on purpose (#50)
    expect(updateStateForTest().lastFailure).toEqual({ sha: NEW, reason: "boom" });
  });

  // Mutation: a second `saveState()` before the build (the record written apart from the markers) leaves a window in
  // which a death records one without the other.
  test("the arming is ONE save, and the failure tail is one more (#450)", async () => {
    stubGitHub();
    const write = spyOn(Bun, "write");
    try {
      await saveState();
      const perSave = write.mock.calls.length;
      expect(perSave).toBeGreaterThan(0);
      write.mockClear();
      let atRedeploy = -1;
      await checkForUpdate(
        { force: true, requester: REQUESTER },
        failing(() => (atRedeploy = write.mock.calls.length)),
      );
      expect(atRedeploy).toBe(perSave); // the arming save, and nothing else, ran before the build
      expect(write.mock.calls.length).toBe(2 * perSave); // plus the failure tail's
    } finally {
      write.mockRestore();
    }
  });

  // Mutations: dropping the `outcome` leg or the "failed" fallback of the reason -- a timeout carries no error text,
  // and a result with neither would log and remember `undefined`.
  test("a failed swap's reason falls back from the error to the outcome to a plain 'failed' (#506 item 13)", async () => {
    stubGitHub();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const result = (r: object) => ({ redeployAvailable: async () => true, redeploy: async () => r });
    try {
      await checkForUpdate({ force: true }, result({ outcome: "timeout" }));
      expect(updateStateForTest().lastFailure).toEqual({ sha: NEW, reason: "timeout" });
      await checkForUpdate({ force: true }, result({}));
      expect(updateStateForTest().lastFailure).toEqual({ sha: NEW, reason: "failed" });
      expect(warn.mock.calls.some((c) => String(c[0]).includes("failed: failed"))).toBe(true);
      expect(warn.mock.calls.every((c) => !String(c[0]).includes("undefined"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("the no-socket branch arms the two markers and no swap record, and a second /update while that exit is deferred is refused (#452, #449)", async () => {
    stubGitHub();
    const exits: number[] = [];
    const restoreExit = setExitFn((code) => void exits.push(code));
    const deps = {
      redeployAvailable: async () => false,
      redeploy: async () => {
        throw new Error("redeploy must not run without a socket");
      },
    };
    try {
      await withCritical(async () => {
        const first = await checkForUpdate({ force: true, requester: REQUESTER }, deps);
        expect(first.decision).toBe("restart");
        expect(first.redeploy).toBeUndefined();
        expect(restartPending()).toBe(true);
        expect(exits).toEqual([]); // deferred behind this critical section
        const disk = onDisk();
        expect(disk.attemptedUpdateToSha).toBe(NEW);
        expect(disk.pendingUpdateReport).toMatchObject({ userId: "42" });
        expect(disk.swapInFlight).toBeUndefined();

        const second = await checkForUpdate({ force: true, requester: { ...REQUESTER, userId: "43" } }, deps);
        expect(second.decision).toBe("busy");
        expect(onDisk().pendingUpdateReport).toMatchObject({ userId: "42" }); // the first requester's report survives
      });
      expect(exits).toEqual([RESTART_EXIT_CODE]); // the section closing exits into the stub
    } finally {
      resetRestartForTest();
      restoreExit();
    }
  });

  test("the update landing clears the attempt marker in memory and on disk (#452)", async () => {
    config.gitSha = NEW;
    state.attemptedUpdateToSha = NEW;
    await saveState();
    stubGitHub();

    expect((await checkForUpdate()).decision).toBe("current");
    expect(state.attemptedUpdateToSha).toBeUndefined();
    expect(onDisk().attemptedUpdateToSha).toBeUndefined();
  });

  test("a check whose fetch throws releases the latch, so the next call is not wedged busy (#452)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(checkForUpdate()).rejects.toThrow("offline");
    expect(updateStateForTest().checkInFlight).toBe(false);

    config.gitSha = NEW;
    stubGitHub();
    expect((await checkForUpdate()).decision).toBe("current");
  });

  test("an automatic attempt neither overwrites nor wipes a /update report still owed (#506 item 12)", async () => {
    stubGitHub();
    const owed = buildUpdateReport({ runningSha: "c".repeat(40), latestSha: OLD, requester: REQUESTER, now: Date.now() })!;
    state.pendingUpdateReport = owed;
    await saveState();

    let during: ReturnType<typeof onDisk> | undefined;
    const result = await checkForUpdate({}, failing((d) => (during = d))); // the scheduler's tick: no requester

    expect(result.decision).toBe("restart");
    expect(during!.pendingUpdateReport).toEqual(owed); // not overwritten with nothing
    expect(during!.attemptedUpdateToSha).toBe(NEW);
    expect(during!.swapInFlight).toMatchObject({ fromSha: OLD, toSha: NEW });
    expect(state.pendingUpdateReport).toBe(owed); // the failure tail cleared only what it armed: nothing
    expect(onDisk().pendingUpdateReport).toEqual(owed);
    expect(onDisk().swapInFlight).toBeUndefined();
  });

  test("the suppressed warning is logged once per pending sha per process and names the failure (#506 item 13, #429)", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const pending = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith("[update] ") && m.includes("still pending"));
    try {
      stubGitHub();
      expect((await checkForUpdate({ force: true, requester: REQUESTER }, failing())).decision).toBe("restart");
      expect((await checkForUpdate({}, failing())).decision).toBe("suppressed");
      expect((await checkForUpdate({}, failing())).decision).toBe("suppressed");
      expect(pending()).toHaveLength(1);
      expect(pending()[0]).toContain("the last attempt failed: boom");
      expect(pending()[0]).toContain("/update"); // config.commandPrefix is empty in this process
      expect(pending()[0]).toContain("Not exiting again");

      // A new failure re-explains itself once.
      await checkForUpdate({ force: true }, failing(undefined, "boom again"));
      expect((await checkForUpdate({}, failing())).decision).toBe("suppressed");
      expect(pending()).toHaveLength(2);
      expect(pending()[1]).toContain("boom again");

      // Another pending sha, with no failure recorded for it: the same-build explanation, once.
      const NEWER = "c".repeat(40);
      stubGitHub(NEWER);
      state.attemptedUpdateToSha = NEWER;
      expect((await checkForUpdate({}, failing())).decision).toBe("suppressed");
      expect(pending()).toHaveLength(3);
      expect(pending()[2]).toContain(shortSha(NEWER));
      expect(pending()[2]).not.toContain("the last attempt failed");
      expect(pending()[2]).toContain("came back on the build it exited from");
      expect(pending()[2]).toContain("rebuild the image"); // the exit-75 respawn case keeps its advice...
      expect(pending()[2]).toContain("or is still landing"); // ...but a swap that may be in flight is not only told that
      expect(updateStateForTest().suppressedWarnedFor).toBe(NEWER);

      resetUpdateForTest();
      expect(updateStateForTest()).toEqual({ checkInFlight: false, suppressedWarnedFor: undefined, lastFailure: undefined });
    } finally {
      warn.mockRestore();
    }
  });
});

// #450: the boot's side. Each test seeds the record, the attempt marker and the report in memory AND on disk, as the
// previous life's arming save left them.
describe("resolveUpdateAttempt (#450)", () => {
  const realGitSha = config.gitSha;
  const quiet = () => {
    const lines: { level: "log" | "warn"; text: string }[] = [];
    return {
      lines,
      log: {
        log: (...a: unknown[]) => void lines.push({ level: "log", text: a.map(String).join(" ") }),
        warn: (...a: unknown[]) => void lines.push({ level: "warn", text: a.map(String).join(" ") }),
      } as Pick<Console, "log" | "warn">,
    };
  };
  const recorded = (startedAt = Date.now() - 1000): SwapInFlight => ({ fromSha: OLD, toSha: NEW, startedAt });
  const seed = async (swap: unknown) => {
    state.swapInFlight = swap as never;
    state.attemptedUpdateToSha = NEW;
    state.pendingUpdateReport = buildUpdateReport({ runningSha: OLD, latestSha: NEW, requester: REQUESTER, now: Date.now() })!;
    await saveState();
  };
  /** A probe seam that records whether it was asked. */
  const probing = (answer: ReplacementProbe) => {
    const asked = { n: 0 };
    return {
      asked,
      probe: async () => {
        asked.n += 1;
        return answer;
      },
    };
  };

  afterEach(async () => {
    config.gitSha = realGitSha;
    state.attemptedUpdateToSha = undefined;
    state.pendingUpdateReport = undefined;
    state.swapInFlight = undefined;
    await saveState();
  });

  test("the record names this build: the swap landed, and only the record is cleared", async () => {
    config.gitSha = NEW;
    await seed(recorded());
    const p = probing({ kind: "alive", name: "bot-next", status: "running" });
    const q = quiet();

    expect(await resolveUpdateAttempt({ probe: p.probe, log: q.log })).toBe("landed");
    expect(p.asked.n).toBe(0);
    expect(state.swapInFlight).toBeUndefined();
    expect(onDisk().swapInFlight).toBeUndefined();
    expect(state.attemptedUpdateToSha).toBe(NEW);
    expect(state.pendingUpdateReport).toBeDefined();
    expect(state.pendingUpdateReport?.interrupted).toBeUndefined(); // landed is not a failed swap: nothing is marked
    expect(onDisk().pendingUpdateReport.interrupted).toBeUndefined();
    expect(onDisk().attemptedUpdateToSha).toBe(NEW);
  });

  test("a live replacement beside the original: in flight, nothing touched in memory or on disk", async () => {
    config.gitSha = OLD;
    await seed(recorded());
    const before = onDisk();
    const p = probing({ kind: "alive", name: "bot-next", status: "running" });
    const q = quiet();

    expect(await resolveUpdateAttempt({ probe: p.probe, log: q.log })).toBe("in-flight");
    expect(p.asked.n).toBe(1);
    expect(state.swapInFlight).toBeDefined();
    expect(state.attemptedUpdateToSha).toBe(NEW);
    expect(state.pendingUpdateReport).toBeDefined();
    expect(onDisk()).toEqual(before);
    expect(q.lines.some((l) => l.text.includes("bot-next"))).toBe(true);
  });

  test("a probe that cannot tell is in flight too, until the record is a day old", async () => {
    config.gitSha = OLD;
    const unknown: ReplacementProbe = { kind: "unknown", name: "bot-next", error: "timed out after 10000ms" };

    await seed(recorded(Date.now() - 60_000));
    const before = onDisk();
    const q = quiet();
    expect(await resolveUpdateAttempt({ probe: probing(unknown).probe, log: q.log })).toBe("in-flight");
    expect(onDisk()).toEqual(before);
    expect(state.attemptedUpdateToSha).toBe(NEW);
    expect(q.lines.some((l) => l.text.includes("could not be told") && l.text.includes("timed out after 10000ms"))).toBe(true);

    await seed(recorded(Date.now() - SWAP_RECORD_MAX_AGE_MS - 60_000));
    const aged = quiet();
    expect(await resolveUpdateAttempt({ probe: probing(unknown).probe, log: aged.log })).toBe("interrupted");
    expect(state.swapInFlight).toBeUndefined();
    expect(state.attemptedUpdateToSha).toBeUndefined();
    expect(state.pendingUpdateReport).toMatchObject({ userId: "42", interrupted: true }); // the requester is still told
    // Nothing was learned about the replacement: the log says so, not "is not alive".
    const warned = aged.lines.find((l) => l.level === "warn")!.text;
    expect(warned).toContain("could not be told: timed out after 10000ms");
    expect(warned).toContain("over a day old");
    expect(warned).not.toContain("not alive");
  });

  test("a stopped or absent replacement: interrupted, the record and the attempt marker cleared, the report kept and marked", async () => {
    for (const [answer, seen] of [
      [{ kind: "stopped", name: "bot-next", status: "exited" } as ReplacementProbe, "bot-next is exited"],
      [{ kind: "absent", name: "bot-next" } as ReplacementProbe, "bot-next is gone"],
    ] as const) {
      config.gitSha = OLD;
      await seed(recorded());
      const owed = { ...state.pendingUpdateReport! }; // a copy: the verdict is set on the stored report itself
      const q = quiet();

      expect(await resolveUpdateAttempt({ probe: probing(answer).probe, log: q.log })).toBe("interrupted");
      expect(state.swapInFlight).toBeUndefined();
      expect(state.attemptedUpdateToSha).toBeUndefined();
      // The verdict is the report's own field, in memory and on disk (one save), the rest of it untouched.
      expect(state.pendingUpdateReport).toEqual({ ...owed, interrupted: true });
      const disk = onDisk();
      expect(disk.swapInFlight).toBeUndefined();
      expect(disk.attemptedUpdateToSha).toBeUndefined();
      expect(disk.pendingUpdateReport).toEqual({ ...owed, interrupted: true });
      const warned = q.lines.find((l) => l.level === "warn")!.text;
      expect(warned).toContain("cleared the attempt marker");
      expect(warned).toContain(seen);
      expect(warned).not.toContain("over a day old");
    }
  });

  // Mutations: marking whatever report is owed (drop either sha leg); throwing on a report with no shas.
  test("only the report this swap armed is marked: another owed report, a hand-edited one, and none at all are left alone", async () => {
    config.gitSha = OLD;
    const absent = { kind: "absent", name: "bot-next" } as ReplacementProbe;
    const armed = buildUpdateReport({ runningSha: OLD, latestSha: NEW, requester: REQUESTER, now: 1 })!;
    for (const owed of [{ ...armed, toSha: "c".repeat(40) }, { ...armed, fromSha: "c".repeat(40) }, {}, undefined]) {
      await seed(recorded());
      state.pendingUpdateReport = owed as never;
      const before = structuredClone(owed); // the verdict is set in place, so compare with a copy taken first
      expect(await resolveUpdateAttempt({ probe: probing(absent).probe, log: quiet().log })).toBe("interrupted");
      expect(state.pendingUpdateReport).toEqual(before as never); // not marked, not created, not thrown over
      expect((state.pendingUpdateReport as { interrupted?: true } | undefined)?.interrupted).toBeUndefined();
      expect(state.attemptedUpdateToSha).toBeUndefined();
      expect(state.swapInFlight).toBeUndefined();
    }
  });

  // The verdict survives a boot that dies between resolving and delivering: the next boot has no record, and the
  // report it reads carries the verdict.
  test("the verdict is saved with the report: a boot reading it back from disk, with no record left, still sees interrupted", async () => {
    config.gitSha = OLD;
    await seed(recorded());
    await resolveUpdateAttempt({ probe: probing({ kind: "absent", name: "bot-next" }).probe, log: quiet().log });

    const disk = onDisk();
    expect(disk.swapInFlight).toBeUndefined();
    expect(disk.pendingUpdateReport.interrupted).toBe(true);
    expect(disk.pendingUpdateReport).toMatchObject({ ...REQUESTER, fromSha: OLD, toSha: NEW });
    // The next boot: nothing to resolve.
    expect(await resolveUpdateAttempt({ probe: probing({ kind: "absent", name: "x" }).probe, log: quiet().log })).toBe("none");
  });

  // Mutation: dropping the `state.swapInFlight !== raw` re-check -- a /update armed while the probe ran is resolved
  // as the dead life's swap, clearing the marker and record of a build that is running.
  test("a record replaced while the probe is out belongs to a newer attempt: left alone, nothing written (#450)", async () => {
    config.gitSha = OLD;
    await seed(recorded());
    const before = onDisk();
    const newer: SwapInFlight = { fromSha: OLD, toSha: "c".repeat(40), startedAt: Date.now() };
    const q = quiet();
    const write = spyOn(Bun, "write");
    try {
      const resolved = await resolveUpdateAttempt({
        probe: async () => {
          state.swapInFlight = newer; // checkForUpdate's arming, mid-await
          return { kind: "absent", name: "bot-next" };
        },
        log: q.log,
      });
      expect(resolved).toBe("in-flight");
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
    expect(state.swapInFlight).toBe(newer);
    expect(state.attemptedUpdateToSha).toBe(NEW);
    expect(state.pendingUpdateReport).toMatchObject({ userId: "42" });
    expect(state.pendingUpdateReport?.interrupted).toBeUndefined();
    expect(onDisk()).toEqual(before);
    expect(q.lines.some((l) => l.text.includes("changed while it was being resolved"))).toBe(true);

    // Cleared during the probe (a failed swap's tail): also not this boot's to resolve.
    await seed(recorded());
    expect(
      await resolveUpdateAttempt({
        probe: async () => {
          state.swapInFlight = undefined;
          return { kind: "absent", name: "bot-next" };
        },
        log: quiet().log,
      }),
    ).toBe("in-flight");
    expect(state.attemptedUpdateToSha).toBe(NEW);
  });

  test("a third build, or no sha at all: stale — the record is cleared, the markers are left, the daemon is not asked", async () => {
    for (const sha of ["d".repeat(40), "", undefined]) {
      config.gitSha = sha; // undefined is what a build with no GIT_SHA really has: sameSha(…, undefined) would throw
      await seed(recorded());
      const p = probing({ kind: "alive", name: "bot-next", status: "running" });

      expect(await resolveUpdateAttempt({ probe: p.probe, log: quiet().log })).toBe("stale");
      expect(p.asked.n).toBe(0);
      expect(state.swapInFlight).toBeUndefined();
      expect(state.attemptedUpdateToSha).toBe(NEW);
      expect(state.pendingUpdateReport).toBeDefined();
    }
  });

  // One bad leg each, on a record that would otherwise name this build: dropping that leg of `isSwapInFlight` lets the
  // record through to the probe (or, for null, throws at boot).
  test("a malformed record is stale and never throws, whichever leg of the shape is wrong", async () => {
    config.gitSha = OLD;
    const good = recorded();
    const bad: [string, unknown][] = [
      ["null", null],
      ["a string", "junk"],
      ["a number", 42],
      ["empty", {}],
      ["no fromSha", { toSha: NEW, startedAt: good.startedAt }],
      ["a numeric fromSha", { ...good, fromSha: 1 }],
      ["no toSha", { fromSha: OLD, startedAt: good.startedAt }],
      ["a numeric toSha", { ...good, toSha: 5 }],
      ["no startedAt", { fromSha: OLD, toSha: NEW }],
      ["a string startedAt", { ...good, startedAt: "yesterday" }],
    ];
    for (const [what, record] of bad) {
      await seed(record);
      const p = probing({ kind: "alive", name: "bot-next", status: "running" });
      const q = quiet();

      expect({ what, resolution: await resolveUpdateAttempt({ probe: p.probe, log: q.log }) }).toEqual({ what, resolution: "stale" });
      expect({ what, asked: p.asked.n }).toEqual({ what, asked: 0 });
      expect(state.swapInFlight).toBeUndefined();
      expect(onDisk().swapInFlight).toBeUndefined();
      expect(state.attemptedUpdateToSha).toBe(NEW); // the markers are left to the existing paths
      expect(q.lines.some((l) => l.text.includes("belongs to another build or is malformed"))).toBe(true);
    }
  });

  // Mutation: replacing the `deps.probe ?? probeReplacement` default with a stub. The production call passes no deps,
  // so every seam above is bypassed; the real probe goes to the daemon (here a recording `fetch`).
  test("with no probe seam the real probe asks the daemon, by this container's own name", async () => {
    const realFetch = globalThis.fetch;
    const realHostname = process.env.HOSTNAME;
    const HOST = "abc123abc123";
    const paths: string[] = [];
    process.env.HOSTNAME = HOST;
    globalThis.fetch = (async (url: string) => {
      const { pathname } = new URL(String(url));
      paths.push(pathname);
      if (pathname === `/containers/${HOST}/json`) {
        return new Response(JSON.stringify({ Id: `${HOST}${"0".repeat(52)}`, Name: "/bot", Config: { Labels: {} } }), { status: 200 });
      }
      return new Response("", { status: 404 }); // no `bot-next` at all
    }) as unknown as typeof fetch;
    try {
      config.gitSha = OLD;
      await seed(recorded());
      expect(await resolveUpdateAttempt({ log: quiet().log })).toBe("interrupted");
      expect(paths).toEqual([`/containers/${HOST}/json`, "/containers/bot-next/json"]);
    } finally {
      globalThis.fetch = realFetch;
      if (realHostname === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = realHostname;
    }
  });

  test("no record: none, and not a single write", async () => {
    config.gitSha = OLD;
    state.swapInFlight = undefined;
    const write = spyOn(Bun, "write");
    try {
      expect(await resolveUpdateAttempt({ probe: probing({ kind: "absent", name: "x" }).probe, log: quiet().log })).toBe("none");
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  test("a save that fails is logged, and the verdict still stands", async () => {
    config.gitSha = OLD;
    await seed(recorded());
    const q = quiet();
    const write = spyOn(Bun, "write").mockImplementation((() => Promise.reject(new Error("disk full"))) as unknown as typeof Bun.write);
    try {
      expect(await resolveUpdateAttempt({ probe: probing({ kind: "absent", name: "bot-next" }).probe, log: q.log })).toBe("interrupted");
    } finally {
      write.mockRestore();
    }
    expect(q.lines.some((l) => l.level === "warn" && l.text.includes("could not save the resolved swap record"))).toBe(true);
    expect(state.swapInFlight).toBeUndefined(); // resolved in memory
  });
});

describe("buildUpdateReport", () => {
  const NOW = 1_700_000_000_000;

  test("records who asked, where to reach them, and both shas", () => {
    expect(
      buildUpdateReport({
        runningSha: OLD,
        latestSha: NEW,
        requester: {
          userId: "42",
          channelId: "100",
          applicationId: "999",
          interactionToken: "tok",
        },
        now: NOW,
      }),
    ).toEqual({
      fromSha: OLD,
      toSha: NEW,
      userId: "42",
      channelId: "100",
      applicationId: "999",
      interactionToken: "tok",
      requestedAt: NOW,
    });
  });

  // An AUTO_UPDATE exit or a host reboot has no requester, so it leaves nothing to follow up on.
  test("no requester means no report, so an unattended restart stays silent", () => {
    expect(buildUpdateReport({ runningSha: OLD, latestSha: NEW, now: NOW })).toBeUndefined();
  });
});
