// Pure tests for the plugin-update logic (#103 notifications + #104 actions) — no env priming, no
// Client. Every side effect of checkPluginUpdates is an injected fake. #104 added `restartPending`/
// `requestRestart` to the deps, so "never restarts without a due schedule" is now enforced
// BEHAVIORALLY (the restart-spy tests below), not structurally.
import { describe, expect, test, beforeEach } from "bun:test";
import type { PluginIndex, PluginIndexEntry, PluginRelease, PluginStateEntry, PluginStateFile } from "./contract";
import {
  compareSemver,
  decidePluginUpdates,
  releaseNotesBetween,
  notificationMessage,
  renderPluginsList,
  deliverPluginNotification,
  checkPluginUpdates,
  resetPluginUpdateStateForTest,
  parseScheduleTime,
  planPluginAction,
  pinUpdateNow,
  scheduleUpdate,
  remindLater,
  skipVersion,
  cancelPending,
  isDiscordUserId,
  decidePluginReportOutcome,
  reportPluginUpdateOutcome,
  type PluginActionContext,
  type PluginNotifyDeliverers,
  type PluginReportDeps,
  type PluginUpdateDeps,
} from "./updates";

function rel(version: string, o: { publishedAt?: string; notes?: string; url?: string } = {}): PluginRelease {
  return {
    version,
    publishedAt: o.publishedAt ?? "2026-09-05T12:00:00.000Z",
    url: o.url ?? `https://github.com/Rackbops/rackbops-bot-plugins/releases/tag/x-v${version}`,
    notes: o.notes ?? `notes for ${version}`,
  };
}
function entry(name: string, version: string, o: { hostApiVersion?: number; releases?: PluginRelease[] } = {}): PluginIndexEntry {
  return {
    name,
    package: `@rackbops/plugin-${name}`,
    version,
    description: name,
    hostApiVersion: o.hostApiVersion ?? 1,
    commands: [],
    env: [],
    releases: o.releases ?? [],
  };
}
function index(entries: PluginIndexEntry[]): PluginIndex {
  return { schemaVersion: 1, generatedAt: "2026-09-05T00:00:00.000Z", plugins: entries };
}
function stateEntry(name: string, installed: string | undefined, extra: Partial<PluginStateEntry> = {}): PluginStateEntry {
  return { name, enabled: true, configured: true, missingEnv: [], active: true, ...(installed ? { installedVersion: installed } : {}), ...extra };
}
function state(entries: PluginStateEntry[]): PluginStateFile {
  return { hostApiVersion: 1, writtenAt: "", plugins: entries };
}
const NOW = new Date("2026-09-05T12:00:00.000Z");

describe("compareSemver", () => {
  test("orders numeric release parts", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
    expect(compareSemver("1.2.0", "1.10.0")).toBe(-1); // numeric, not lexical
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });
  test("a prerelease is lower than its release, and prerelease identifiers order per semver", () => {
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareSemver("1.0.0-rc.1", "1.0.0-rc.2")).toBe(-1);
    expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1); // numeric identifiers compare numerically
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1); // alphanumeric ASCII
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1); // numeric ranks below alphanumeric
    expect(compareSemver("1.0.0-rc", "1.0.0-rc.1")).toBe(-1); // shorter prerelease is lower
  });
  test("ignores build metadata", () => {
    expect(compareSemver("1.0.0+build.9", "1.0.0")).toBe(0);
  });
});

describe("decidePluginUpdates", () => {
  test("no decision when the index isn't strictly newer (same or older version)", () => {
    expect(decidePluginUpdates(state([stateEntry("a", "1.0.0")]), index([entry("a", "1.0.0")]), 1, NOW)).toEqual([]);
    expect(decidePluginUpdates(state([stateEntry("a", "2.0.0")]), index([entry("a", "1.0.0")]), 1, NOW)).toEqual([]);
  });
  test("no decision for a plugin that was never installed", () => {
    expect(decidePluginUpdates(state([stateEntry("a", undefined)]), index([entry("a", "1.0.0")]), 1, NOW)).toEqual([]);
  });
  test("a newer version not yet notified → notify", () => {
    const d = decidePluginUpdates(state([stateEntry("a", "1.0.0")]), index([entry("a", "1.1.0")]), 1, NOW);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ name: "a", from: "1.0.0", to: "1.1.0", compatible: true, action: "notify" });
  });
  test("already notified about that version → none", () => {
    const d = decidePluginUpdates(state([stateEntry("a", "1.0.0", { notifiedVersion: "1.1.0" })]), index([entry("a", "1.1.0")]), 1, NOW);
    expect(d[0]?.action).toBe("none");
  });
  test("a version newer than the notified one notifies again", () => {
    const d = decidePluginUpdates(state([stateEntry("a", "1.0.0", { notifiedVersion: "1.1.0" })]), index([entry("a", "1.2.0")]), 1, NOW);
    expect(d[0]).toMatchObject({ to: "1.2.0", action: "notify" });
  });
  test("skipped exactly that version → none, but a newer one notifies", () => {
    expect(decidePluginUpdates(state([stateEntry("a", "1.0.0", { skippedVersion: "1.1.0" })]), index([entry("a", "1.1.0")]), 1, NOW)[0]?.action).toBe("none");
    expect(decidePluginUpdates(state([stateEntry("a", "1.0.0", { skippedVersion: "1.1.0" })]), index([entry("a", "1.2.0")]), 1, NOW)[0]?.action).toBe("notify");
  });
  test("snoozed: none before remindAt, remind at/after it", () => {
    const s = (remindAt: string) => state([stateEntry("a", "1.0.0", { notifiedVersion: "1.1.0", remindAt })]);
    const idx = index([entry("a", "1.1.0")]);
    expect(decidePluginUpdates(s("2026-09-05T13:00:00.000Z"), idx, 1, NOW)[0]?.action).toBe("none"); // remindAt in the future
    expect(decidePluginUpdates(s("2026-09-05T11:00:00.000Z"), idx, 1, NOW)[0]?.action).toBe("remind"); // due
  });
  test("an incompatible newer version still surfaces, with compatible:false", () => {
    const d = decidePluginUpdates(state([stateEntry("a", "1.0.0")]), index([entry("a", "2.0.0", { hostApiVersion: 2 })]), 1, NOW);
    expect(d[0]).toMatchObject({ to: "2.0.0", compatible: false, neededHostApi: 2, action: "notify" });
  });
});

describe("releaseNotesBetween", () => {
  const e = entry("a", "1.3.0", { releases: [rel("1.3.0"), rel("1.2.0"), rel("1.1.0"), rel("1.0.0")] });
  test("only (from, to], newest first", () => {
    const notes = releaseNotesBetween(e, "1.0.0", "1.2.0");
    expect(notes).toContain("**1.2.0**");
    expect(notes).toContain("**1.1.0**");
    expect(notes).not.toContain("**1.3.0**"); // > to
    expect(notes).not.toContain("**1.0.0**"); // == from, excluded
    expect(notes.indexOf("**1.2.0**")).toBeLessThan(notes.indexOf("**1.1.0**")); // newest first
  });
  test("no releases in range → placeholder", () => {
    expect(releaseNotesBetween(entry("a", "1.1.0"), "1.0.0", "1.1.0")).toBe("(no release notes published)");
  });
  test("clamps to Discord's cap with a full-notes URL tail", () => {
    const big = entry("a", "9.0.0", { releases: [rel("9.0.0", { notes: "x".repeat(3000), url: "https://x/9" })] });
    const notes = releaseNotesBetween(big, "1.0.0", "9.0.0");
    expect(notes.length).toBeLessThanOrEqual(2000);
    expect(notes).toContain("… full notes: https://x/9");
  });
});

describe("notificationMessage", () => {
  const base = { name: "warbandeer", from: "1.0.0", to: "1.1.0", neededHostApi: 1, releases: [rel("1.1.0")] };
  test("compatible: the four operator options, exact command names", () => {
    const msg = notificationMessage({ ...base, compatible: true, action: "notify" }, 1);
    expect(msg).toContain("📦 **warbandeer** 1.1.0 is available (installed 1.0.0).");
    expect(msg).toContain("`/plugins update warbandeer` (now, or `at:` a time)");
    expect(msg).toContain("`/plugins remind warbandeer`");
    expect(msg).toContain("`/plugins skip warbandeer`");
    expect(msg).toContain("or use the admin panel.");
  });
  test("incompatible: says the bot must update first, no install path", () => {
    const msg = notificationMessage({ ...base, to: "2.0.0", neededHostApi: 2, compatible: false, action: "notify" }, 1);
    expect(msg).toContain("This version needs a newer bot (host API v2, this bot is v1) — update the bot first.");
    expect(msg).not.toContain("/plugins update");
  });
  test("the WHOLE message stays within Discord's 2000-char cap, footer intact, on a long changelog", () => {
    const msg = notificationMessage(
      { ...base, to: "2.0.0", compatible: true, action: "notify", releases: [rel("2.0.0", { notes: "x".repeat(3000) })] },
      1,
    );
    expect(msg.length).toBeLessThanOrEqual(2000);
    expect(msg).toContain("📦 **warbandeer** 2.0.0 is available"); // head survives
    expect(msg).toContain("`/plugins update warbandeer`"); // footer survives the clamp
  });
  test("hard-caps even a pathologically long plugin name (belt-and-suspenders)", () => {
    const msg = notificationMessage(
      { ...base, name: "a".repeat(500), compatible: true, action: "notify", releases: [rel("1.1.0")] },
      1,
    );
    expect(msg.length).toBeLessThanOrEqual(2000);
  });
});

describe("renderPluginsList", () => {
  test("shows installed version, available + first note, and skip/remind markers", () => {
    const s = state([
      stateEntry("a", "1.0.0"),
      stateEntry("b", "2.0.0", { skippedVersion: "2.1.0" }),
      stateEntry("c", "3.0.0", { notifiedVersion: "3.1.0", remindAt: "2026-09-06T00:00:00.000Z" }),
    ]);
    const idx = index([
      entry("a", "1.1.0", { releases: [rel("1.1.0", { notes: "shiny" })] }),
      entry("b", "2.1.0"),
      entry("c", "3.1.0"),
    ]);
    const out = renderPluginsList(s, idx, NOW);
    expect(out).toContain("**a** — installed 1.0.0 → 1.1.0 available");
    expect(out).toContain("shiny");
    expect(out).toContain("**b** — installed 2.0.0 → 2.1.0 available (skipped)");
    // #132: pins the FULL discordTs markup (including the "R" relative-style suffix), not just the
    // "<t:" opener — the opener alone doesn't discriminate discordTs's style argument, so a routing
    // mistake (e.g. dropping the "R" and silently defaulting to "F") would pass an opener-only check.
    const remindTs = Math.floor(Date.parse("2026-09-06T00:00:00.000Z") / 1000);
    expect(out).toContain(`**c** — installed 3.0.0 → 3.1.0 available (remind <t:${remindTs}:R>)`);
  });
  test("shows a pending scheduled update (#104), so /plugins cancel has something visible to act on", () => {
    const s = state([stateEntry("a", "1.0.0", { scheduled: { version: "1.1.0", at: "2026-09-06T00:00:00.000Z", requestedBy: "admin1" } })]);
    const out = renderPluginsList(s, index([entry("a", "1.1.0")]), NOW);
    const scheduledTs = Math.floor(Date.parse("2026-09-06T00:00:00.000Z") / 1000);
    expect(out).toContain(`update to 1.1.0 scheduled <t:${scheduledTs}:R>`);
  });
  test("empty state → a plain line", () => {
    expect(renderPluginsList(state([]), index([]), NOW)).toBe("No plugins installed.");
  });
  test("clamps a long list to Discord's cap", () => {
    const plugins = Array.from({ length: 12 }, (_, i) => stateEntry(`p${i}`, "1.0.0"));
    const entries = Array.from({ length: 12 }, (_, i) => entry(`p${i}`, "2.0.0", { releases: [rel("2.0.0", { notes: "y".repeat(400) })] }));
    const out = renderPluginsList(state(plugins), index(entries), NOW);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain("… (list truncated)");
  });
});

describe("deliverPluginNotification", () => {
  const recording = () => {
    const dms: string[] = [];
    const posts: string[] = [];
    const deliverers: PluginNotifyDeliverers = {
      dmUser: async (id) => void dms.push(id),
      postAnnounce: async (c) => void posts.push(c),
    };
    return { dms, posts, deliverers };
  };
  const log = () => {
    const warns: string[] = [];
    return { log: { info: () => {}, warn: (m: string) => void warns.push(m), error: () => {} }, warns };
  };

  test("DMs each admin; no channel post when every DM succeeds", async () => {
    const r = recording();
    const l = log();
    const ok = await deliverPluginNotification("msg", ["1", "2"], r.deliverers, l.log);
    expect(ok).toBe(true);
    expect(r.dms).toEqual(["1", "2"]);
    expect(r.posts).toHaveLength(0);
  });
  test("a failed DM falls back to the channel ONCE, not per admin", async () => {
    const posts: string[] = [];
    const deliverers: PluginNotifyDeliverers = {
      dmUser: async () => { throw new Error("closed DMs"); },
      postAnnounce: async (c) => void posts.push(c),
    };
    const ok = await deliverPluginNotification("msg", ["1", "2", "3"], deliverers, log().log);
    expect(ok).toBe(true);
    expect(posts).toEqual(["msg"]); // one channel post despite three failed DMs
  });
  test("no admins → warn only, returns false", async () => {
    const r = recording();
    const l = log();
    const ok = await deliverPluginNotification("msg", [], r.deliverers, l.log);
    expect(ok).toBe(false);
    expect(r.dms).toHaveLength(0);
    expect(r.posts).toHaveLength(0);
    expect(l.warns.join(" ")).toContain("ADMIN_USER_IDS is empty");
  });
  test("all routes fail → returns false", async () => {
    const deliverers: PluginNotifyDeliverers = {
      dmUser: async () => { throw new Error("x"); },
      postAnnounce: async () => { throw new Error("y"); },
    };
    expect(await deliverPluginNotification("msg", ["1"], deliverers, { info() {}, warn() {}, error() {} })).toBe(false);
  });
});

describe("checkPluginUpdates", () => {
  beforeEach(resetPluginUpdateStateForTest);

  function harness(opts: {
    index: PluginIndex;
    state: PluginStateFile;
    adminUserIds?: string[];
    dm?: () => Promise<void>;
    post?: () => Promise<void>;
    restartPending?: boolean;
    /** Simulate a concurrent `/plugins cancel` winning the serialized queue: clear every `scheduled`
     *  from `current` just before the first mutate runs, so the arbiter closure sees it cancelled. */
    cancelRace?: boolean;
  }) {
    const dms: string[] = [];
    const posts: string[] = [];
    const restarts: string[] = [];
    let current = opts.state;
    const mutations: PluginStateFile[] = [];
    let indexLoads = 0;
    let raceApplied = false;
    const deps: PluginUpdateDeps = {
      loadIndex: async () => { indexLoads++; return opts.index; },
      readState: async () => current,
      mutateState: async (mutate) => {
        if (opts.cancelRace && !raceApplied) {
          raceApplied = true;
          current = { ...current, plugins: current.plugins.map((p) => { const n = { ...p }; delete n.scheduled; return n; }) };
        }
        current = mutate(current);
        mutations.push(current);
      },
      deliverers: {
        dmUser: async (id) => { if (opts.dm) await opts.dm(); dms.push(id); },
        postAnnounce: async () => { if (opts.post) await opts.post(); posts.push("x"); },
      },
      adminUserIds: opts.adminUserIds ?? ["admin1"],
      hostApiVersion: 1,
      now: () => NOW,
      log: { info() {}, warn() {}, error() {} },
      restartPending: () => opts.restartPending ?? false,
      requestRestart: (reason) => { restarts.push(reason); },
    };
    return { deps, dms, posts, restarts, mutations, get state() { return current; }, get indexLoads() { return indexLoads; } };
  }

  test("notifies once and records notifiedVersion/availableVersion; a second run is silent", async () => {
    const h = harness({ index: index([entry("a", "1.1.0", { releases: [rel("1.1.0")] })]), state: state([stateEntry("a", "1.0.0")]) });
    await checkPluginUpdates(h.deps);
    expect(h.dms).toEqual(["admin1"]);
    expect(h.state.plugins[0]).toMatchObject({ notifiedVersion: "1.1.0", availableVersion: "1.1.0" });
    h.dms.length = 0;
    await checkPluginUpdates(h.deps); // notifiedVersion now set → no re-notify
    expect(h.dms).toHaveLength(0);
  });

  test("re-fetches the index each run (cache write)", async () => {
    const h = harness({ index: index([entry("a", "1.0.0")]), state: state([stateEntry("a", "1.0.0")]) });
    await checkPluginUpdates(h.deps);
    expect(h.indexLoads).toBe(1);
  });

  test("a failed delivery does NOT record notified (retries), until the attempt cap", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0")]),
      dm: async () => { throw new Error("closed"); },
      post: async () => { throw new Error("no channel"); },
    });
    await checkPluginUpdates(h.deps); // attempt 1 — no persist
    await checkPluginUpdates(h.deps); // attempt 2 — no persist
    expect(h.state.plugins[0]?.notifiedVersion).toBeUndefined();
    await checkPluginUpdates(h.deps); // attempt 3 — give up, persist
    expect(h.state.plugins[0]?.notifiedVersion).toBe("1.1.0");
  });

  test("a fired remind clears remindAt so it doesn't re-fire", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", { notifiedVersion: "1.1.0", remindAt: "2026-09-05T11:00:00.000Z" })]),
    });
    await checkPluginUpdates(h.deps);
    expect(h.dms).toEqual(["admin1"]); // reminder delivered
    expect(h.state.plugins[0]?.remindAt).toBeUndefined();
  });

  test("with no admins: warns, delivers nothing, records nothing (a later admin still gets it)", async () => {
    const h = harness({ index: index([entry("a", "1.1.0")]), state: state([stateEntry("a", "1.0.0")]), adminUserIds: [] });
    await checkPluginUpdates(h.deps);
    expect(h.dms).toHaveLength(0);
    expect(h.state.plugins[0]?.notifiedVersion).toBeUndefined();
  });

  test("never restarts WITHOUT a due schedule — a plain newer version only notifies (#104 guard)", async () => {
    // A newer version with no scheduled update records notifiedVersion but never calls requestRestart
    // and never moves the pin: the bot upgrades only on an explicit action.
    const h = harness({ index: index([entry("a", "2.0.0")]), state: state([stateEntry("a", "1.0.0")]) });
    await checkPluginUpdates(h.deps);
    expect(h.restarts).toHaveLength(0);
    expect(h.state.plugins[0]?.installedVersion).toBe("1.0.0"); // pin unchanged
    expect(h.state.plugins[0]?.targetVersion).toBeUndefined();
  });

  // A Discord snowflake requestedBy (so the heads-up DM fires — a panel identity would be skipped by
  // isDiscordUserId; that path is covered by its own test below).
  const SNOWFLAKE = "200863115821318144";
  const scheduled = (version: string, at: string, by = SNOWFLAKE) => ({ scheduled: { version, at, requestedBy: by } });

  test("a due schedule: heads-up DM, sets targetVersion + pendingReport, clears scheduled, restarts once", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z"))]),
    });
    await checkPluginUpdates(h.deps);
    expect(h.dms).toEqual([SNOWFLAKE]); // the heads-up (the notify itself is suppressed while scheduled)
    expect(h.restarts).toHaveLength(1);
    expect(h.state.plugins[0]?.targetVersion).toBe("1.1.0");
    expect(h.state.plugins[0]?.scheduled).toBeUndefined();
    expect(h.state.pendingReport).toMatchObject({ plugin: "a", toVersion: "1.1.0", userId: SNOWFLAKE });
  });

  test("a due schedule requested from the PANEL (non-snowflake requestedBy) still fires but skips the DM", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z", "email:me@x.com"))]),
    });
    await checkPluginUpdates(h.deps);
    expect(h.dms).toEqual([]); // isDiscordUserId guard — no futile users.fetch(email)
    expect(h.restarts).toHaveLength(1); // the update still proceeds
    expect(h.state.plugins[0]?.targetVersion).toBe("1.1.0");
  });

  test("a schedule not yet due is left untouched", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", scheduled("1.1.0", "2026-09-05T18:00:00.000Z"))]), // after NOW
    });
    await checkPluginUpdates(h.deps);
    expect(h.restarts).toHaveLength(0);
    expect(h.state.plugins[0]?.scheduled).toMatchObject({ version: "1.1.0" });
    expect(h.state.plugins[0]?.targetVersion).toBeUndefined();
  });

  test("a due schedule defers while a restart is already pending (autoUpdate won the tick)", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z"))]),
      restartPending: true,
    });
    await checkPluginUpdates(h.deps);
    expect(h.restarts).toHaveLength(0);
    expect(h.state.plugins[0]?.scheduled).toMatchObject({ version: "1.1.0" }); // still scheduled for next tick
  });

  test("a cancel that wins the serialized race stops the restart (the mutate is the arbiter)", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z"))]),
      cancelRace: true,
    });
    await checkPluginUpdates(h.deps);
    expect(h.restarts).toHaveLength(0); // acted stayed false — never restarted onto a cancelled update
    expect(h.state.plugins[0]?.targetVersion).toBeUndefined();
    expect(h.state.plugins[0]?.scheduled).toBeUndefined(); // the cancel cleared it
    expect(h.state.pendingReport).toBeUndefined();
  });

  test("a scheduled version is not re-notified while it waits (scheduled suppression)", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", scheduled("1.1.0", "2026-09-05T18:00:00.000Z"))]), // not due
    });
    await checkPluginUpdates(h.deps);
    expect(h.dms).toHaveLength(0); // no notify DM — it's already scheduled
  });
});

describe("parseScheduleTime (#104)", () => {
  const now = new Date("2026-09-05T12:00:00.000Z");
  const ok = (r: { at: Date } | { error: string }): Date => {
    if ("error" in r) throw new Error(`expected a time, got error: ${r.error}`);
    return r.at;
  };

  test("HH:MM later today resolves to today in UTC", () => {
    expect(ok(parseScheduleTime("18:30", now)).toISOString()).toBe("2026-09-05T18:30:00.000Z");
  });
  test("HH:MM already passed today rolls to tomorrow in UTC (midnight cross)", () => {
    expect(ok(parseScheduleTime("06:00", now)).toISOString()).toBe("2026-09-06T06:00:00.000Z");
    // exactly now also rolls forward (must be strictly in the future)
    expect(ok(parseScheduleTime("12:00", now)).toISOString()).toBe("2026-09-06T12:00:00.000Z");
  });
  test("an ISO-8601 datetime with an offset is taken as-is", () => {
    expect(ok(parseScheduleTime("2026-09-06T18:30-07:00", now)).toISOString()).toBe("2026-09-07T01:30:00.000Z");
    expect(ok(parseScheduleTime("2026-09-06T09:00:00Z", now)).toISOString()).toBe("2026-09-06T09:00:00.000Z");
  });
  test("garbage, and an offset-less ISO string (ambiguous), are rejected with the two forms", () => {
    for (const bad of ["later", "25:00", "18:99", "2026-09-06T18:30", "6pm"]) {
      const r = parseScheduleTime(bad, now);
      expect("error" in r).toBe(true);
      if ("error" in r) expect(r.error).toContain("HH:MM");
    }
  });
});

describe("planPluginAction (#104)", () => {
  const base = (over: Partial<PluginActionContext> = {}): PluginActionContext => ({
    name: "a",
    installedVersion: "1.0.0",
    latestVersion: "1.1.0",
    compatible: true,
    neededHostApi: 1,
    botHostApi: 1,
    hasPending: false,
    now: new Date("2026-09-05T12:00:00.000Z"),
    requestedBy: "admin1",
    channelId: "chan1",
    ...over,
  });
  const applied = (r: ReturnType<typeof planPluginAction>) => {
    if (!r.mutate) throw new Error("expected a mutate");
    return r.mutate(state([stateEntry("a", "1.0.0")])).plugins[0]!;
  };

  test("update now sets targetVersion + pendingReport and asks for a restart", () => {
    const r = planPluginAction({ kind: "update" }, base());
    expect(r.restart).toEqual({ from: "1.0.0", to: "1.1.0" });
    const after = r.mutate!(state([stateEntry("a", "1.0.0")]));
    expect(after.plugins[0]?.targetVersion).toBe("1.1.0");
    expect(after.pendingReport).toMatchObject({ plugin: "a", toVersion: "1.1.0", userId: "admin1", channelId: "chan1" });
  });
  test("update at:<time> schedules and does NOT restart", () => {
    const at = new Date("2026-09-05T18:00:00.000Z");
    const r = planPluginAction({ kind: "update", at }, base());
    expect(r.restart).toBeUndefined();
    expect(applied(r).scheduled).toEqual({ version: "1.1.0", at: at.toISOString(), requestedBy: "admin1" });
  });
  test("remind sets remindAt now+days", () => {
    const r = planPluginAction({ kind: "remind", days: 3 }, base());
    expect(applied(r).remindAt).toBe(new Date("2026-09-08T12:00:00.000Z").toISOString());
  });
  test("skip sets skippedVersion to the available version", () => {
    expect(applied(planPluginAction({ kind: "skip" }, base())).skippedVersion).toBe("1.1.0");
  });
  test("cancel drops the schedule, or says there was none", () => {
    const withSched = planPluginAction({ kind: "cancel" }, base({ hasPending: true }));
    const seeded = state([stateEntry("a", "1.0.0", { scheduled: { version: "1.1.0", at: "x", requestedBy: "admin1" } })]);
    expect(withSched.mutate!(seeded).plugins[0]?.scheduled).toBeUndefined();
    const none = planPluginAction({ kind: "cancel" }, base({ hasPending: false }));
    expect(none.mutate).toBeUndefined();
    expect(none.reply).toContain("no scheduled update");
  });
  test("cancel also clears a targetVersion the fire set + a matching pendingReport (fire-instant race)", () => {
    // The schedule already fired: scheduled is gone but targetVersion + pendingReport are set. A cancel
    // must still undo them, else the update applies despite the 'Cancelled' reply.
    const r = planPluginAction({ kind: "cancel" }, base({ hasPending: true }));
    const fired: PluginStateFile = {
      ...state([stateEntry("a", "1.0.0", { targetVersion: "1.1.0" })]),
      pendingReport: { plugin: "a", toVersion: "1.1.0", userId: "admin1", requestedAt: 0 },
    };
    const after = r.mutate!(fired);
    expect(after.plugins[0]?.targetVersion).toBeUndefined();
    expect(after.pendingReport).toBeUndefined();
  });
  test("cancel leaves another plugin's pendingReport intact", () => {
    const r = planPluginAction({ kind: "cancel" }, base({ name: "a", hasPending: true }));
    const other: PluginStateFile = {
      ...state([stateEntry("a", "1.0.0", { scheduled: { version: "1.1.0", at: "x", requestedBy: "admin1" } })]),
      pendingReport: { plugin: "b", toVersion: "2.0.0", userId: "admin1", requestedAt: 0 },
    };
    expect(r.mutate!(other).pendingReport).toMatchObject({ plugin: "b" });
  });
  test("refuses update/remind/skip when there is no newer version (no mutate)", () => {
    for (const kind of ["update", "remind", "skip"] as const) {
      const action = kind === "remind" ? { kind, days: 7 } : { kind };
      const r = planPluginAction(action, base({ latestVersion: "1.0.0" }));
      expect(r.mutate).toBeUndefined();
      expect(r.restart).toBeUndefined();
      expect(r.reply).toContain("already on the latest");
    }
  });
  test("refuses update when the newer version is incompatible (no mutate, no restart)", () => {
    const r = planPluginAction({ kind: "update" }, base({ compatible: false, neededHostApi: 2 }));
    expect(r.mutate).toBeUndefined();
    expect(r.restart).toBeUndefined();
    expect(r.reply).toContain("needs a newer bot");
  });
});

describe("decidePluginReportOutcome (#104)", () => {
  const report = { plugin: "a", toVersion: "1.1.0", userId: "u", requestedAt: 0 };
  test("success when the plugin came up on the target and is active", () => {
    const r = decidePluginReportOutcome(report, stateEntry("a", "1.1.0", { active: true }));
    expect(r).toEqual({ ok: true, message: "✅ **a** is now 1.1.0." });
  });
  test("reverted: installed differs from the target → still on the previous", () => {
    const r = decidePluginReportOutcome(report, stateEntry("a", "1.0.0", { active: true, error: "integrity mismatch" }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("could not be updated to 1.1.0");
    expect(r.message).toContain("still on 1.0.0");
    expect(r.message).toContain("integrity mismatch");
  });
  test("installed the target but failed to start → distinct message", () => {
    const r = decidePluginReportOutcome(report, stateEntry("a", "1.1.0", { active: false, error: "activate threw" }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("failed to start");
    expect(r.message).not.toContain("still on");
  });
});

describe("version-parameterized builders (#105 — shared by planPluginAction + the request mailbox)", () => {
  const seed = () => state([stateEntry("a", "1.0.0")]);
  // The load-bearing property: each builder pins the version it's GIVEN (a request's explicit pin),
  // not the index's — a mutation that ignored the arg and read the index would break the mailbox.
  test("skipVersion / scheduleUpdate / remindLater pin the given values", () => {
    expect(skipVersion("a", "9.9.9")(seed()).plugins[0]?.skippedVersion).toBe("9.9.9");
    expect(scheduleUpdate("a", "9.9.9", "2026-01-01T00:00:00Z", "u")(seed()).plugins[0]?.scheduled).toEqual({
      version: "9.9.9",
      at: "2026-01-01T00:00:00Z",
      requestedBy: "u",
    });
    expect(remindLater("a", "2026-02-02T00:00:00Z")(seed()).plugins[0]?.remindAt).toBe("2026-02-02T00:00:00Z");
  });
  test("pinUpdateNow sets targetVersion + pendingReport; cancelPending clears scheduled + targetVersion", () => {
    const report = { plugin: "a", toVersion: "9.9.9", userId: "u", requestedAt: 0 };
    const after = pinUpdateNow("a", "9.9.9", report)(seed());
    expect(after.plugins[0]?.targetVersion).toBe("9.9.9");
    expect(after.pendingReport).toEqual(report);
    const seeded = state([stateEntry("a", "1.0.0", { scheduled: { version: "1.1.0", at: "x", requestedBy: "u" }, targetVersion: "1.1.0" })]);
    const cleared = cancelPending("a")(seeded).plugins[0];
    expect(cleared?.scheduled).toBeUndefined();
    expect(cleared?.targetVersion).toBeUndefined();
  });
  test("isDiscordUserId: a snowflake vs a panel identity", () => {
    expect(isDiscordUserId("200863115821318144")).toBe(true);
    expect(isDiscordUserId("email:me@x.com")).toBe(false);
    expect(isDiscordUserId("token")).toBe(false);
  });
});

describe("reportPluginUpdateOutcome (#104)", () => {
  function reportHarness(opts: { state: PluginStateFile; dm?: () => Promise<void> }) {
    let current = opts.state;
    const dms: string[] = [];
    const channels: string[] = [];
    const errors: string[] = [];
    const deps: PluginReportDeps = {
      readState: async () => current,
      mutateState: async (mutate) => { current = mutate(current); },
      dmUser: async (_id, content) => { if (opts.dm) await opts.dm(); dms.push(content); },
      postChannel: async (_c, _u, content) => { channels.push(content); },
      log: { info() {}, warn() {}, error: (m) => errors.push(m) },
    };
    return { deps, dms, channels, errors, get state() { return current; } };
  }
  const withReport = (report: PluginStateFile["pendingReport"], entry = stateEntry("a", "1.1.0", { active: true })) =>
    ({ ...state([entry]), pendingReport: report });

  test("no pendingReport → nothing delivered", async () => {
    const h = reportHarness({ state: state([stateEntry("a", "1.1.0")]) });
    await reportPluginUpdateOutcome(h.deps);
    expect(h.dms).toHaveLength(0);
  });
  const SNOWFLAKE = "200863115821318144";
  test("clears pendingReport BEFORE delivering, then DMs the requester", async () => {
    const h = reportHarness({ state: withReport({ plugin: "a", toVersion: "1.1.0", userId: SNOWFLAKE, requestedAt: 0 }) });
    await reportPluginUpdateOutcome(h.deps);
    expect(h.state.pendingReport).toBeUndefined();
    expect(h.dms[0]).toContain("is now 1.1.0");
  });
  test("a failed DM still leaves pendingReport cleared (never re-fires) and falls back to the channel", async () => {
    const h = reportHarness({
      state: withReport({ plugin: "a", toVersion: "1.1.0", userId: SNOWFLAKE, channelId: "chan1", requestedAt: 0 }),
      dm: async () => { throw new Error("closed DMs"); },
    });
    await reportPluginUpdateOutcome(h.deps);
    expect(h.state.pendingReport).toBeUndefined(); // cleared before delivery — no boot-loop re-fire
    expect(h.channels[0]).toContain("is now 1.1.0");
  });
  test("a PANEL-origin request (non-snowflake requestedBy) clears the report + logs, never DMs", async () => {
    const h = reportHarness({ state: withReport({ plugin: "a", toVersion: "1.1.0", userId: "email:me@x.com", requestedAt: 0 }) });
    await reportPluginUpdateOutcome(h.deps);
    expect(h.state.pendingReport).toBeUndefined(); // still cleared — never re-fires
    expect(h.dms).toHaveLength(0); // no futile users.fetch(email)
    expect(h.channels).toHaveLength(0);
  });
});
