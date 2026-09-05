// Pure tests for the plugin-update NOTIFICATION logic (#103) — no env priming, no Client. Every
// side effect of checkPluginUpdates is an injected fake, so the "never installs/restarts" property
// is enforced structurally (the deps carry no such capability).
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
  type PluginNotifyDeliverers,
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
    expect(out).toContain("**c** — installed 3.0.0 → 3.1.0 available (remind <t:");
  });
  test("empty state → a plain line", () => {
    expect(renderPluginsList(state([]), index([]), NOW)).toBe("No plugins installed.");
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
    return { log: { warn: (m: string) => void warns.push(m), error: () => {} }, warns };
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
    expect(await deliverPluginNotification("msg", ["1"], deliverers, { warn() {}, error() {} })).toBe(false);
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
  }) {
    const dms: string[] = [];
    const posts: string[] = [];
    let current = opts.state;
    const mutations: PluginStateFile[] = [];
    let indexLoads = 0;
    const deps: PluginUpdateDeps = {
      loadIndex: async () => { indexLoads++; return opts.index; },
      readState: async () => current,
      mutateState: async (mutate) => { current = mutate(current); mutations.push(current); },
      deliverers: {
        dmUser: async (id) => { if (opts.dm) await opts.dm(); dms.push(id); },
        postAnnounce: async () => { if (opts.post) await opts.post(); posts.push("x"); },
      },
      adminUserIds: opts.adminUserIds ?? ["admin1"],
      hostApiVersion: 1,
      now: () => NOW,
      log: { warn() {}, error() {} },
    };
    return { deps, dms, posts, mutations, get state() { return current; }, get indexLoads() { return indexLoads; } };
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

  test("deps carry no restart/install capability — checkPluginUpdates cannot upgrade (structural guard)", async () => {
    // The only mutations checkPluginUpdates makes are notification DMs and a state.json write; there
    // is no requestRestart/install in PluginUpdateDeps to call. A run over a newer version records
    // notifiedVersion but leaves installedVersion untouched (the pin never moves in #103).
    const h = harness({ index: index([entry("a", "2.0.0")]), state: state([stateEntry("a", "1.0.0")]) });
    await checkPluginUpdates(h.deps);
    expect(h.state.plugins[0]?.installedVersion).toBe("1.0.0"); // pin unchanged — #103 never installs
  });
});
