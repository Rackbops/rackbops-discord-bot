import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REST } from "discord.js";
import { expectCleanedLog, replyFailure } from "../test/restError";

// `updateReport.ts` reaches the `config` singleton, which resolves process.env at import time --
// the required vars are primed once by test/setup.ts's bunfig preload (#136).
const {
  decideUpdateOutcome,
  updateOutcomeMessage,
  tokenUsable,
  reportTooOld,
  deliverUpdateReport,
  liveDeliverers,
  owedReportNow,
  reportUpdateOutcome,
} = await import("./updateReport");
const { config } = await import("./config");
const { resetUpdateForTest } = await import("./update");
const { state, saveState } = await import("./state");
const { shortSha, DATA_DIR } = await import("./storage");
type PendingUpdateReport = import("./state").PendingUpdateReport;
type Deliverers = import("./updateReport").Deliverers;

const FROM = "a".repeat(40);
const TO = "b".repeat(40);
const THIRD = "c".repeat(40);
const NOW = 1_700_000_000_000;

const report = (over: Partial<PendingUpdateReport> = {}): PendingUpdateReport => ({
  fromSha: FROM,
  toSha: TO,
  userId: "42",
  channelId: "100",
  applicationId: "999",
  interactionToken: "tok",
  requestedAt: NOW,
  ...over,
});

describe("decideUpdateOutcome", () => {
  test("updated when back on the sha we exited for", () => {
    expect(decideUpdateOutcome({ report: report(), runningSha: TO })).toBe("updated");
  });

  // The whole point of the issue: this case otherwise looks identical to success.
  test("noop when back on the sha we left on", () => {
    expect(decideUpdateOutcome({ report: report(), runningSha: FROM })).toBe("noop");
  });

  test("unexpected when back on some third sha", () => {
    expect(decideUpdateOutcome({ report: report(), runningSha: THIRD })).toBe("unexpected");
  });

  test("unknown when the rebuild dropped GIT_SHA", () => {
    expect(decideUpdateOutcome({ report: report() })).toBe("unknown");
    expect(decideUpdateOutcome({ report: report(), runningSha: "" })).toBe("unknown");
  });

  test("tolerates a short GIT_SHA against the full recorded sha", () => {
    expect(decideUpdateOutcome({ report: report(), runningSha: shortSha(TO) })).toBe("updated");
    expect(decideUpdateOutcome({ report: report(), runningSha: shortSha(FROM) })).toBe("noop");
  });

  test("a report whose from and to are the same reads as updated, not noop", () => {
    expect(decideUpdateOutcome({ report: report({ toSha: FROM }), runningSha: FROM })).toBe(
      "updated",
    );
  });

  // R1 (#450): the boot's verdict rides on the report (`interrupted: true`, set and saved by `resolveUpdateAttempt`), and
  // it turns a would-be noop into the truthful outcome, and only that one.
  test("interrupted when the boot marked the report, and we are back on the source build", () => {
    expect(decideUpdateOutcome({ report: report({ interrupted: true }), runningSha: FROM })).toBe("interrupted");
    expect(decideUpdateOutcome({ report: report({ interrupted: true }), runningSha: shortSha(FROM) })).toBe("interrupted");
  });

  test("a marked report does not hide an update that landed, or a third build", () => {
    expect(decideUpdateOutcome({ report: report({ interrupted: true }), runningSha: TO })).toBe("updated");
    expect(decideUpdateOutcome({ report: report({ interrupted: true }), runningSha: THIRD })).toBe("unexpected");
    expect(decideUpdateOutcome({ report: report({ interrupted: true }) })).toBe("unknown");
  });

  test("an unmarked report back on the source build stays a noop", () => {
    expect(decideUpdateOutcome({ report: report(), runningSha: FROM })).toBe("noop");
  });

  // #558: a rolled-back swap did land first, so the rollback outranks the interrupted mark when both are on a report.
  // Mutation M19b: checking `interrupted` first.
  test("rolled-back when the boot found itself rolled back: the report carries the verdict, and it outranks interrupted", () => {
    expect(decideUpdateOutcome({ report: report({ rolledBack: true }), runningSha: FROM })).toBe("rolled-back");
    expect(decideUpdateOutcome({ report: report({ rolledBack: true }), runningSha: shortSha(FROM) })).toBe("rolled-back");
    expect(decideUpdateOutcome({ report: report({ rolledBack: true, interrupted: true }), runningSha: FROM })).toBe("rolled-back");
  });

  test("a rolled-back mark does not hide an update that landed, a third build, or a missing GIT_SHA", () => {
    expect(decideUpdateOutcome({ report: report({ rolledBack: true }), runningSha: TO })).toBe("updated");
    expect(decideUpdateOutcome({ report: report({ rolledBack: true }), runningSha: THIRD })).toBe("unexpected");
    expect(decideUpdateOutcome({ report: report({ rolledBack: true }) })).toBe("unknown");
  });
});

describe("updateOutcomeMessage", () => {
  test("each outcome produces distinct text", () => {
    const msgs = (["updated", "noop", "interrupted", "rolled-back", "unexpected", "unknown"] as const).map((o) =>
      updateOutcomeMessage(o, report(), TO),
    );
    expect(new Set(msgs).size).toBe(6);
  });

  test("interrupted names the target and the build, says the update did not take, and names the command to run again (#450)", () => {
    const msg = updateOutcomeMessage("interrupted", report(), FROM);
    expect(msg).toContain(shortSha(TO));
    expect(msg).toContain(shortSha(FROM));
    expect(msg).toContain("did not take");
    expect(msg).toContain("/update"); // config.commandPrefix is empty in this process
    expect(msg).not.toContain("wasn't rebuilt"); // the wrong cause the noop text names
    // A rollback of a recorded swap is `rolled-back` now; the text no longer claims it (#558).
    expect(msg).not.toContain("rolled back");
  });

  // Mutation M19: the rolled-back outcome returning the interrupted text.
  test("rolled-back names the target, says it landed and was rolled back, that automatic updates skip it, and the command to apply it (#558)", () => {
    const msg = updateOutcomeMessage("rolled-back", report(), FROM);
    expect(msg).toContain(shortSha(TO));
    expect(msg).toContain(shortSha(FROM));
    expect(msg).toContain("landed and was then rolled back");
    expect(msg.split(shortSha(TO)).length - 1).toBe(2); // "the update to X" and "skip X"
    expect(msg).toContain("Automatic updates skip");
    expect(msg).toContain("/update"); // config.commandPrefix is empty in this process
    expect(msg).not.toContain("did not take");
    expect(msg).not.toContain("wasn't rebuilt");
  });

  test("unexpected admits an automatic update or a redeploy by hand may be the cause", () => {
    expect(updateOutcomeMessage("unexpected", report(), THIRD)).toContain("automatic update");
  });

  test("updated names the build it came back on and the one it left", () => {
    const msg = updateOutcomeMessage("updated", report(), TO);
    expect(msg).toContain(shortSha(TO));
    expect(msg).toContain(shortSha(FROM));
  });

  test("noop says plainly that the image wasn't rebuilt", () => {
    const msg = updateOutcomeMessage("noop", report(), FROM);
    expect(msg).toContain("same build");
    expect(msg).toContain("wasn't rebuilt");
    expect(msg).toContain(shortSha(TO));
  });

  test("unexpected names all three shas", () => {
    const msg = updateOutcomeMessage("unexpected", report(), THIRD);
    for (const sha of [THIRD, FROM, TO]) expect(msg).toContain(shortSha(sha));
  });

  test("unknown reports the missing GIT_SHA rather than guessing", () => {
    const msg = updateOutcomeMessage("unknown", report(), undefined);
    expect(msg).toContain("GIT_SHA");
    expect(msg).not.toContain(shortSha(FROM));
  });
});

describe("tokenUsable", () => {
  test("usable immediately after the restart was requested", () => {
    expect(tokenUsable(report(), NOW + 5_000)).toBe(true);
  });

  test("usable just inside the 15-minute window", () => {
    expect(tokenUsable(report(), NOW + 15 * 60 * 1000 - 1)).toBe(true);
  });

  test("expired at and beyond the window", () => {
    expect(tokenUsable(report(), NOW + 15 * 60 * 1000)).toBe(false);
    expect(tokenUsable(report(), NOW + 60 * 60 * 1000)).toBe(false);
  });

  test("unusable without a token or an application id", () => {
    expect(tokenUsable(report({ interactionToken: undefined }), NOW)).toBe(false);
    expect(tokenUsable(report({ applicationId: undefined }), NOW)).toBe(false);
  });
});

describe("reportTooOld", () => {
  test("a restart from minutes ago is still worth reporting", () => {
    expect(reportTooOld(report(), NOW + 60 * 60 * 1000)).toBe(false);
  });

  test("a box that was down for days does not get greeted with stale news", () => {
    expect(reportTooOld(report(), NOW + 25 * 60 * 60 * 1000)).toBe(true);
  });
});

describe("deliverUpdateReport", () => {
  const spies = (fail: Partial<Record<keyof Deliverers, boolean>> = {}) => {
    const calls: string[] = [];
    const route = (name: keyof Deliverers) => async () => {
      calls.push(name);
      if (fail[name]) throw new Error(`${name} unavailable`);
    };
    const deliverers: Deliverers = {
      viaToken: route("viaToken"),
      viaDm: route("viaDm"),
      viaChannel: route("viaChannel"),
    };
    return { calls, deliverers };
  };

  test("prefers the interaction follow-up and stops there", async () => {
    const { calls, deliverers } = spies();
    expect(await deliverUpdateReport(report(), "hi", deliverers, NOW)).toBe("token");
    expect(calls).toEqual(["viaToken"]);
  });

  test("falls back to a DM when the token has expired", async () => {
    const { calls, deliverers } = spies();
    const later = NOW + 60 * 60 * 1000;
    expect(await deliverUpdateReport(report(), "hi", deliverers, later)).toBe("dm");
    expect(calls).toEqual(["viaDm"]);
  });

  test("falls back to a DM when the follow-up throws", async () => {
    const { calls, deliverers } = spies({ viaToken: true });
    expect(await deliverUpdateReport(report(), "hi", deliverers, NOW)).toBe("dm");
    expect(calls).toEqual(["viaToken", "viaDm"]);
  });

  test("falls back to the channel when DMs are closed", async () => {
    const { calls, deliverers } = spies({ viaToken: true, viaDm: true });
    expect(await deliverUpdateReport(report(), "hi", deliverers, NOW)).toBe("channel");
    expect(calls).toEqual(["viaToken", "viaDm", "viaChannel"]);
  });

  // An unreachable requester must degrade quietly, never blow up the boot path.
  test("resolves to none rather than throwing when every route fails", async () => {
    const { deliverers } = spies({ viaToken: true, viaDm: true, viaChannel: true });
    expect(await deliverUpdateReport(report(), "hi", deliverers, NOW)).toBe("none");
  });

  test("skips the channel route when no channel was recorded", async () => {
    const { calls, deliverers } = spies({ viaToken: true, viaDm: true });
    const r = report({ channelId: undefined });
    expect(await deliverUpdateReport(r, "hi", deliverers, NOW)).toBe("none");
    expect(calls).toEqual(["viaToken", "viaDm"]);
  });

  // #545: the token route posts to `/webhooks/<app>/<interaction token>`, so Discord refusing it (10015 Unknown
  // Webhook, or a token at its 15-minute edge) is a REST error whose `url` is the /update requester's token.
  test("a token-route delivery failure is logged without the interaction token or the reply (#545)", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failure = replyFailure("webhook");
      const deliverers: Deliverers = {
        viaToken: async () => Promise.reject(failure.error),
        viaDm: async () => {},
        viaChannel: async () => {},
      };
      expect(await deliverUpdateReport(report(), "hi", deliverers, NOW)).toBe("dm");
      expect(warn.mock.calls).toHaveLength(1);
      const call = warn.mock.calls[0]!;
      expect(call[0]).toBe("[updateReport] token delivery failed");
      expectCleanedLog(call, failure);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("liveDeliverers.viaChannel", () => {
  // The client-wide default is allowedMentions: { parse: [] } (#48) — the requester ping this
  // route prefixes onto `content` needs an explicit opt-in, or it silently stops pinging at all.
  // Content itself must stay unparsed even though it's concatenated right next to a real mention,
  // so anything an attacker smuggled into it (another <@id>, a role mention) can't ride along.
  test("opts the requester's own ping in, without opening content back up to arbitrary mentions", async () => {
    const sendCalls: unknown[] = [];
    const fakeChannel = {
      isSendable: () => true,
      send: async (payload: unknown) => {
        sendCalls.push(payload);
      },
    };
    const fakeClient = {
      channels: { fetch: async () => fakeChannel },
    } as unknown as import("discord.js").Client;

    await liveDeliverers(fakeClient).viaChannel(report(), "<@1337> gotcha @everyone");

    expect(sendCalls).toEqual([
      {
        content: "<@42> <@1337> gotcha @everyone",
        allowedMentions: { users: ["42"] },
      },
    ]);
  });

  // #132: routed through the shared sendToChannel (announce.ts) now, alongside announceTo's own
  // sendable=false coverage — this pins the false case for THIS caller too (previously only the
  // sendable=true/ping-opt-in path above was tested here, so dropping sendToChannel's isSendable
  // guard would not have failed anything in this file).
  test("throws when the channel isn't sendable", async () => {
    const fakeClient = {
      channels: { fetch: async () => ({ isSendable: () => false }) },
    } as unknown as import("discord.js").Client;
    await expect(liveDeliverers(fakeClient).viaChannel(report(), "x")).rejects.toThrow(/not sendable/);
  });
});

// R4 (#452): the other two routes had no test at all (viaChannel is the one above).
describe("liveDeliverers.viaDm and viaToken (#452)", () => {
  test("viaDm fetches the requester and sends the content to them", async () => {
    const sends: [string, string][] = [];
    const fakeClient = {
      users: { fetch: async (id: string) => ({ send: async (content: string) => void sends.push([id, content]) }) },
    } as unknown as import("discord.js").Client;
    await liveDeliverers(fakeClient).viaDm(report(), "hi");
    expect(sends).toEqual([["42", "hi"]]);
  });

  // Mutation: `auth: true` would send the bot's own token to a route the interaction token already authenticates.
  test("viaToken posts the ephemeral follow-up to the interaction's webhook, unauthenticated, mentioning nobody", async () => {
    const post = spyOn(REST.prototype, "post").mockImplementation((async () => ({})) as never);
    try {
      await liveDeliverers({} as unknown as import("discord.js").Client).viaToken(report(), "hi");
      expect(post).toHaveBeenCalledTimes(1);
      const [route, options] = post.mock.calls[0]! as [string, { body: unknown; auth: boolean }];
      expect(route).toBe("/webhooks/999/tok");
      expect(options.body).toEqual({ content: "hi", flags: 64, allowed_mentions: { parse: [] } });
      expect(options.auth).toBe(false);
    } finally {
      post.mockRestore();
    }
  });
});

// #450, #452, #506 item 12: the boot's report, driven through its injectable deliverers. State goes to the test data
// dir (test/setup.ts's per-run BOT_DATA_DIR); every test seeds the report on disk too, or the clear-before-deliver
// ordering could not be seen.
describe("reportUpdateOutcome", () => {
  const realGitSha = config.gitSha;
  const onDisk = () => JSON.parse(readFileSync(join(DATA_DIR, "state.json"), "utf8")) as Record<string, any>;
  const client = {} as unknown as import("discord.js").Client;
  /** Deliverers that fail the test when they are asked to deliver. */
  const forbidden: Deliverers = {
    viaToken: async () => {
      throw new Error("viaToken must not be called");
    },
    viaDm: async () => {
      throw new Error("viaDm must not be called");
    },
    viaChannel: async () => {
      throw new Error("viaChannel must not be called");
    },
  };

  afterEach(async () => {
    config.gitSha = realGitSha;
    state.pendingUpdateReport = undefined;
    state.swapInFlight = undefined;
    state.retiredBy = undefined;
    state.attemptedUpdateToSha = undefined;
    await saveState();
    resetUpdateForTest(); // a rolled-back boot remembers why the build is skipped (update.ts's `lastFailure`)
  });

  // R2: a swap in flight leaves the report to the new build, which is about to retire this process.
  test("a swap in flight leaves the report where it is and delivers nothing", async () => {
    const owed = report({ requestedAt: Date.now() });
    state.pendingUpdateReport = owed;
    await saveState();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await reportUpdateOutcome(client, "in-flight", forbidden);
      expect(state.pendingUpdateReport).toBe(owed);
      expect(onDisk().pendingUpdateReport).toBeDefined();
      expect(log.mock.calls.some((c) => String(c[0]).includes("in flight"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  // R2b: the age check comes BEFORE the in-flight hold, or a probe that stays `unknown` would keep a report forever.
  test("a report older than a day is dropped even while a swap may be in flight", async () => {
    state.pendingUpdateReport = report({ requestedAt: Date.now() - 25 * 3_600_000 });
    await saveState();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await reportUpdateOutcome(client, "in-flight", forbidden);
      expect(state.pendingUpdateReport).toBeUndefined();
      expect(onDisk().pendingUpdateReport).toBeUndefined();
      expect(log.mock.calls.some((c) => String(c[0]).includes("dropping a stale report"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  // R3: cleared (memory AND disk) before it is delivered; a clear that fails is logged and delivery goes ahead.
  test("the report is cleared in memory and on disk BEFORE delivery, and a failing save does not stop it", async () => {
    config.gitSha = TO;
    state.pendingUpdateReport = report({ requestedAt: Date.now() });
    await saveState();
    const seen: { memory?: unknown; disk?: unknown }[] = [];
    let delivered = 0;
    const recording: Deliverers = {
      ...forbidden,
      viaToken: async () => {
        delivered += 1;
        seen.push({ memory: state.pendingUpdateReport, disk: onDisk().pendingUpdateReport });
      },
    };
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await reportUpdateOutcome(client, "none", recording);
      expect(seen).toEqual([{ memory: undefined, disk: undefined }]);
      expect(log.mock.calls.some((c) => String(c[0]).includes("updated (delivered via token)"))).toBe(true);

      // Second phase: the seed lands first; only THEN does the disk start refusing writes.
      state.pendingUpdateReport = report({ requestedAt: Date.now() });
      await saveState();
      const write = spyOn(Bun, "write").mockImplementation((() => Promise.reject(new Error("disk full"))) as unknown as typeof Bun.write);
      try {
        await reportUpdateOutcome(client, "none", recording); // must not throw
      } finally {
        write.mockRestore();
      }
      expect(delivered).toBe(2);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("could not clear the pending report before delivering it"))).toBe(true);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("a report the boot marked interrupted is reported as such, not as a no-op, whatever resolution the caller passes", async () => {
    config.gitSha = FROM;
    state.pendingUpdateReport = report({ requestedAt: Date.now(), interrupted: true });
    await saveState();
    const contents: string[] = [];
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await reportUpdateOutcome(client, "none", { ...forbidden, viaToken: async (_r, content) => void contents.push(content) });
    } finally {
      log.mockRestore();
    }
    expect(contents).toHaveLength(1);
    expect(contents[0]!.startsWith("⚠️ Back up on")).toBe(true);
    expect(contents[0]).toContain("did not take");
    expect(contents[0]).not.toContain("wasn't rebuilt");
  });

  // #558: a rolled-back original's boot marks the report in place and passes "rolled-back": it is neither held nor
  // re-decided, and the outcome comes from the mark.
  test("a report the boot marked rolled-back is cleared and delivered as rolled-back", async () => {
    config.gitSha = FROM;
    const owed = report({ requestedAt: Date.now(), rolledBack: true });
    state.pendingUpdateReport = owed;
    await saveState();
    const contents: string[] = [];
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await reportUpdateOutcome(client, "rolled-back", { ...forbidden, viaToken: async (_r, content) => void contents.push(content) }, owed);
    } finally {
      log.mockRestore();
    }
    expect(contents).toHaveLength(1);
    expect(contents[0]!.startsWith("⚠️ Back up on")).toBe(true);
    expect(contents[0]).toContain("landed and was then rolled back");
    expect(state.pendingUpdateReport).toBeUndefined();
    expect(onDisk().pendingUpdateReport).toBeUndefined();
  });

  // #558, the crash between resolving and delivering (as for `interrupted`): boot N resolves `rolled-back` and dies;
  // boot N+1 finds no record at all, and the report it reads back from disk still says the swap was rolled back.
  test("a boot that dies after resolving a rollback: the next boot still reports rolled-back", async () => {
    const { resolveUpdateAttempt } = await import("./update");
    config.gitSha = FROM;
    state.retiredBy = { sha: TO, originalSha: FROM, at: 1 };
    state.pendingUpdateReport = report({ requestedAt: Date.now() });
    await saveState();
    const quiet = { log: () => {}, warn: () => {} };
    expect(await resolveUpdateAttempt({ log: quiet })).toBe("rolled-back");

    // Boot N dies here. Boot N+1 reads state.json back.
    const disk = onDisk();
    state.retiredBy = disk.retiredBy;
    state.attemptedUpdateToSha = disk.attemptedUpdateToSha;
    state.pendingUpdateReport = disk.pendingUpdateReport;
    const resolution = await resolveUpdateAttempt({ log: quiet });
    expect(resolution).toBe("none");

    const contents: string[] = [];
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await reportUpdateOutcome(client, resolution, { ...forbidden, viaToken: async (_r, content) => void contents.push(content) });
    } finally {
      log.mockRestore();
    }
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain("landed and was then rolled back");
    expect(contents[0]).not.toContain("wasn't rebuilt");
  });

  // Mutation: the `resolution = "none"` default becoming "in-flight" -- every report called without one would be held.
  test("with no resolution passed the report is delivered", async () => {
    config.gitSha = TO;
    state.pendingUpdateReport = report({ requestedAt: Date.now() });
    await saveState();
    const contents: string[] = [];
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await reportUpdateOutcome(client, undefined, { ...forbidden, viaToken: async (_r, content) => void contents.push(content) });
    } finally {
      log.mockRestore();
    }
    expect(contents).toHaveLength(1);
    expect(state.pendingUpdateReport).toBeUndefined();
  });

  // Mutation: holding the report on `interrupted` (or any resolution but `in-flight`) -- production passes the boot's
  // own resolution, so a hold here would never deliver the very report the verdict exists for.
  test("every resolution but in-flight delivers the report", async () => {
    config.gitSha = FROM;
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const resolution of ["none", "landed", "interrupted", "stale"] as const) {
        state.pendingUpdateReport = report({ requestedAt: Date.now(), interrupted: resolution === "interrupted" ? true : undefined });
        await saveState();
        const contents: string[] = [];
        await reportUpdateOutcome(client, resolution, { ...forbidden, viaToken: async (_r, content) => void contents.push(content) });
        expect({ resolution, delivered: contents.length }).toEqual({ resolution, delivered: 1 });
        expect(state.pendingUpdateReport).toBeUndefined();
      }
    } finally {
      log.mockRestore();
    }
  });

  // Mutation: dropping the `report !== owed` check. A `/update` taken after the boot resolved the swap record arms a
  // report for a restart still in progress; sending it as "back up on the same build" would be false, and clearing
  // it would lose the "updated" its replacement is about to send.
  test("a report armed after the boot looked is left to its own restart", async () => {
    config.gitSha = FROM;
    const seen = report({ requestedAt: Date.now() });
    const armedLater = report({ userId: "43", requestedAt: Date.now() });
    state.pendingUpdateReport = armedLater;
    await saveState();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await reportUpdateOutcome(client, "none", forbidden, seen); // the boot saw a different report
      await reportUpdateOutcome(client, "none", forbidden, null); // the boot saw none at all
      expect(state.pendingUpdateReport).toBe(armedLater);
      expect(onDisk().pendingUpdateReport.userId).toBe("43");
      const held = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("armed since this boot began"));
      expect(held).toHaveLength(2);
      expect(held.every((m) => m.includes(shortSha(TO)) && !m.includes(shortSha(FROM)))).toBe(true); // names where it was going

      // The report the boot did see is delivered, and cleared.
      const contents: string[] = [];
      await reportUpdateOutcome(client, "none", { ...forbidden, viaToken: async (_r, content) => void contents.push(content) }, armedLater);
      expect(contents).toHaveLength(1);
      expect(state.pendingUpdateReport).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });

  test("owedReportNow is the report owed right now, or null", async () => {
    state.pendingUpdateReport = undefined;
    expect(owedReportNow()).toBeNull();
    const owed = report();
    state.pendingUpdateReport = owed;
    expect(owedReportNow()).toBe(owed);
  });

  // #450, the crash between resolving and delivering: boot N resolves `interrupted` and dies before the end of
  // activate(); boot N+1 finds no record at all. Its report must still say the swap did not take, not that the
  // image was not rebuilt.
  test("a boot that dies after resolving an interrupted swap: the next boot, with no record, still reports interrupted", async () => {
    const { resolveUpdateAttempt } = await import("./update");
    config.gitSha = FROM;
    state.swapInFlight = { fromSha: FROM, toSha: TO, startedAt: Date.now() - 1000 };
    state.attemptedUpdateToSha = TO;
    state.pendingUpdateReport = report({ requestedAt: Date.now() });
    await saveState();
    const quiet = { log: () => {}, warn: () => {} };
    expect(await resolveUpdateAttempt({ probe: async () => ({ kind: "absent", name: "bot-next" }), log: quiet })).toBe("interrupted");

    // Boot N dies here. Boot N+1 reads state.json back.
    const disk = onDisk();
    state.swapInFlight = disk.swapInFlight;
    state.attemptedUpdateToSha = disk.attemptedUpdateToSha;
    state.pendingUpdateReport = disk.pendingUpdateReport;
    const resolution = await resolveUpdateAttempt({ probe: async () => ({ kind: "absent", name: "bot-next" }), log: quiet });
    expect(resolution).toBe("none");

    const contents: string[] = [];
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await reportUpdateOutcome(client, resolution, { ...forbidden, viaToken: async (_r, content) => void contents.push(content) });
    } finally {
      log.mockRestore();
    }
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain("did not take");
    expect(contents[0]).not.toContain("wasn't rebuilt");
  });
});
