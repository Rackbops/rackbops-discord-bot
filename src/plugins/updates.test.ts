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
  cutUtf16,
  MAX_DELIVERY_ATTEMPTS,
  resetPluginUpdateStateForTest,
  pluginUpdateStateForTest,
  parseScheduleTime,
  planPluginAction,
  pinUpdateNow,
  scheduleUpdate,
  remindLater,
  skipVersion,
  sliceUtf16,
  cancelPending,
  isDiscordUserId,
  decidePluginReportOutcome,
  reportPluginUpdateOutcome,
  type PluginActionContext,
  type PluginNotifyDeliverers,
  type PluginReportDeps,
  type PluginUpdateDeps,
  type ScheduledEntry,
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
  // #225: an off plugin is never notified or reminded — it isn't running, so there's no one to nag.
  test("an off plugin is never notified or reminded", () => {
    const d = decidePluginUpdates(
      state([stateEntry("a", "1.0.0", { enabled: false, remindAt: "2026-09-01T00:00:00.000Z" })]),
      index([entry("a", "1.1.0")]),
      1,
      NOW,
    );
    expect(d).toEqual([]);
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
    const msg = notificationMessage({ ...base, compatible: true, action: "notify" }, 1, "plugins");
    expect(msg).toContain("📦 **warbandeer** 1.1.0 is available (installed 1.0.0).");
    expect(msg).toContain("`/plugins update warbandeer` (now, or `at:` a time)");
    expect(msg).toContain("`/plugins remind warbandeer`");
    expect(msg).toContain("`/plugins skip warbandeer`");
    expect(msg).toContain("or use the admin panel.");
  });
  // On a `COMMAND_PREFIX=pip` instance the command is `/pipplugins`; a bare `/plugins` doesn't exist.
  // Mutation: reverting any of the three options to a literal `/plugins` fails this.
  test("compatible: names the /plugins command by its registered (prefixed) name, all three times", () => {
    const msg = notificationMessage({ ...base, compatible: true, action: "notify" }, 1, "pipplugins");
    expect(msg).toContain(
      "Update with `/pipplugins update warbandeer` (now, or `at:` a time), `/pipplugins remind warbandeer`, " +
        "`/pipplugins skip warbandeer`, or use the admin panel.",
    );
    expect(msg).not.toContain("`/plugins");
  });
  test("incompatible: says the bot must update first, no install path", () => {
    const msg = notificationMessage({ ...base, to: "2.0.0", neededHostApi: 2, compatible: false, action: "notify" }, 1, "plugins");
    expect(msg).toContain("This version needs a newer bot (host API v2, this bot is v1) — update the bot first.");
    expect(msg).not.toContain("/plugins update");
  });
  test("the WHOLE message stays within Discord's 2000-char cap, footer intact, on a long changelog", () => {
    const msg = notificationMessage(
      { ...base, to: "2.0.0", compatible: true, action: "notify", releases: [rel("2.0.0", { notes: "x".repeat(3000) })] },
      1,
      "pipplugins",
    );
    expect(msg.length).toBeLessThanOrEqual(2000);
    expect(msg).toContain("📦 **warbandeer** 2.0.0 is available"); // head survives
    expect(msg).toContain("`/pipplugins update warbandeer`"); // footer survives the clamp, prefix and all
  });
  test("hard-caps even a pathologically long plugin name (belt-and-suspenders)", () => {
    const msg = notificationMessage(
      { ...base, name: "a".repeat(500), compatible: true, action: "notify", releases: [rel("1.1.0")] },
      1,
      "plugins",
    );
    expect(msg.length).toBeLessThanOrEqual(2000);
  });
  // #563's class on the notice: the hard cap is a cut like the list's, and the release url (the index only checks it is
  // a string) can sit at it, so it must not end inside a pair.
  // The same class in the notes budget (reviewer A, U3 gate): an emoji-heavy changelog cut to fit the notice. Four
  // consecutive offsets so the cut meets both parities of the emoji run.
  test("the release-notes clamp never ends inside a surrogate pair", () => {
    for (let k = 1500; k < 1504; k++) {
      const msg = notificationMessage(
        { ...base, to: "2.0.0", compatible: true, action: "notify", releases: [rel("2.0.0", { notes: "x".repeat(k) + "🙂".repeat(400) })] },
        1,
        "plugins",
      );
      expect(msg.length, `k=${k}`).toBeLessThanOrEqual(2000);
      expect(msg, `k=${k}`).toContain("full notes: "); // the notes WERE clamped
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(msg), `k=${k}`).toBe(false);
    }
  });
  test("the hard cap never ends inside a surrogate pair", () => {
    const make = (url: string) =>
      notificationMessage({ ...base, name: "a".repeat(1800), compatible: true, action: "notify", releases: [rel("1.1.0", { url })] }, 1, "plugins");
    const marker = "full notes: ";
    const urlAt = make("u").indexOf(marker) + marker.length;
    expect(urlAt).toBeGreaterThan(marker.length); // the marker was found (-1 + its length would make the test vacuous)
    const msg = make("u".repeat(1999 - urlAt) + "🙂" + "z".repeat(10)); // the high surrogate lands at unit 1999, the last one kept
    expect(msg.length).toBeLessThanOrEqual(2000);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(msg)).toBe(false);
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
    const out = renderPluginsList(s, idx, NOW, 1);
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
    const out = renderPluginsList(s, index([entry("a", "1.1.0")]), NOW, 1);
    const scheduledTs = Math.floor(Date.parse("2026-09-06T00:00:00.000Z") / 1000);
    expect(out).toContain(`update to 1.1.0 scheduled <t:${scheduledTs}:R>`);
  });
  test("empty state → a plain line", () => {
    expect(renderPluginsList(state([]), index([]), NOW, 1)).toBe("No plugins installed.");
  });
  test("clamps a long list to Discord's cap", () => {
    const plugins = Array.from({ length: 12 }, (_, i) => stateEntry(`p${i}`, "1.0.0"));
    const entries = Array.from({ length: 12 }, (_, i) => entry(`p${i}`, "2.0.0", { releases: [rel("2.0.0", { notes: "y".repeat(400) })] }));
    const out = renderPluginsList(state(plugins), index(entries), NOW, 1);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain("… (list truncated)");
  });
  // #502 item 13: the list says what the notice and /plugins update say about the same version.
  test("L3: a newer version that needs another host API says so; one for this host does not", () => {
    const s = state([stateEntry("a", "1.0.0"), stateEntry("b", "1.0.0")]);
    const out = renderPluginsList(s, index([entry("a", "2.0.0", { hostApiVersion: 2 }), entry("b", "2.0.0")]), NOW, 1);
    expect(out).toContain("**a** — installed 1.0.0 → 2.0.0 available (needs a newer bot)");
    // no caveat for the compatible one: its first line is exactly this
    expect(out.split("\n").find((l) => l.startsWith("• **b**"))).toBe("• **b** — installed 1.0.0 → 2.0.0 available");
    // "Differs", not "is higher": the notice and /plugins update say the same of any host API but this bot's.
    const older = renderPluginsList(state([stateEntry("a", "1.0.0")]), index([entry("a", "2.0.0", { hostApiVersion: 1 })]), NOW, 2);
    expect(older).toContain("**a** — installed 1.0.0 → 2.0.0 available (needs a newer bot)");
  });

  // #418: the schedule line names who asked for it (ops/README says a scheduled update's requestedBy is shown by /plugins list).
  describe("a pending schedule names its requester (#418)", () => {
    const at = "2026-09-06T00:00:00.000Z";
    const listFor = (requestedBy: string, extra: Partial<PluginStateEntry> = {}) =>
      renderPluginsList(state([stateEntry("a", "1.0.0", { scheduled: { version: "1.1.0", at, requestedBy }, ...extra })]), index([entry("a", "1.1.0")]), NOW, 1);
    test("L5: a Discord user is a mention, a panel identity is text", () => {
      expect(listFor("200863115821318144")).toContain("(requested by <@200863115821318144>)");
      expect(listFor("email:me@x.com")).toContain("(requested by email:me@x.com)");
      expect(listFor("token")).toContain("(requested by token)");
    });
    test("L5: a long requester is cut to 80 units, a multi-line one is one line, a blank one is '?'", () => {
      expect(listFor("x".repeat(200))).toContain(`(requested by ${"x".repeat(79)}…)`);
      expect(listFor("first\nsecond  third")).toContain("(requested by first second third)");
      expect(listFor("")).toContain("(requested by ?)");
      expect(listFor("  \n ")).toContain("(requested by ?)");
    });
    // A hand-edited state.json can hold anything: a missing or null requester reads as '?' (never "undefined"/"null")
    // and the list does not throw. (Other non-string values print as their text, which is not asserted.)
    test("L5: a requester that is not a string (a hand-edited state.json) reads as '?' or as its text, never 'undefined'", () => {
      const lines = (requestedBy: unknown) =>
        renderPluginsList(
          state([stateEntry("a", "1.0.0", { scheduled: { version: "1.1.0", at, requestedBy } as unknown as ScheduledEntry })]),
          index([entry("a", "1.1.0")]),
          NOW,
          1,
        );
      expect(lines(undefined)).toContain("(requested by ?)");
      expect(lines(null)).toContain("(requested by ?)");
      expect(lines(undefined)).not.toContain("undefined");
    });
    test("L5: the 80-unit cut of a requester does not split an emoji either (through the list, not only the helper)", () => {
      const out = listFor("x".repeat(78) + "🙂tail"); // the high surrogate is unit 78: the cut at 79 kept would end on it
      expect(out).toContain(`(requested by ${"x".repeat(78)}…)`);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
    });
    test("L5: an off plugin's paused schedule names it too", () => {
      const out = renderPluginsList(
        state([stateEntry("p", "1.0.0", { enabled: false, scheduled: { version: "1.1.0", at, requestedBy: "email:me@x.com" } })]),
        index([entry("p", "2.0.0")]),
        NOW,
        1,
      );
      expect(out).toContain("⏳ update to 1.1.0 scheduled");
      expect(out).toContain("(requested by email:me@x.com)");
    });
    test("L5: the schedule line FOLLOWS the release note, as it always did", () => {
      const out = renderPluginsList(
        state([stateEntry("a", "1.0.0", { scheduled: { version: "1.1.0", at, requestedBy: "email:me@x.com" } })]),
        index([entry("a", "1.1.0", { releases: [rel("1.1.0", { notes: "shiny" })] })]),
        NOW,
        1,
      );
      expect(out.indexOf("shiny")).toBeGreaterThan(-1);
      expect(out.indexOf("shiny")).toBeLessThan(out.indexOf("⏳"));
    });
  });

  // #563: the clamp. Discord's cap is 2000 units; the tail is appended only when something was dropped.
  describe("a list over Discord's cap (#563)", () => {
    const TRUNC = "\n… (list truncated)";
    const CAP = 2000 - TRUNC.length; // 1981
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    // An active plugin with no index entry: its first line is `24 + name` units. With an index entry at 2.0.0: `42 + name`.
    const bare = (name: string) => stateEntry(name, "1.0.0");
    const withNote = (name: string, note: string) => ({
      plugin: stateEntry(name, "1.0.0"),
      entry: entry(name, "2.0.0", { releases: [rel("2.0.0", { notes: note })] }),
    });
    const lineOf = (name: string) => `• **${name}** — installed 1.0.0 → 2.0.0 available`;
    const render = (plugins: PluginStateEntry[], entries: PluginIndexEntry[] = []) => renderPluginsList(state(plugins), index(entries), NOW, 1);

    test("L4a: a boundary emoji in a FIRST line is dropped whole, never split", () => {
      const name = "x".repeat(CAP - 2 - 4) + "🙂" + "y".repeat(50); // the high surrogate lands at CAP - 2: the last unit the cut would keep
      const out = render([bare(name)]);
      expect(out.length).toBeLessThanOrEqual(2000);
      expect(lone.test(out)).toBe(false);
      expect(out.endsWith(TRUNC)).toBe(true);
      expect(out.length).toBe(1999); // 1980 kept (the pair backed off) + the tail; a plain slice would give 2000 and a lone \ud83d
    });

    test("L4b: twelve plugins, the last one down: its '— not running' line survives the clamp", () => {
      const plugins: PluginStateEntry[] = [];
      const entries: PluginIndexEntry[] = [];
      for (let i = 0; i < 12; i++) {
        const { plugin, entry: e } = withNote(`p${i}`, "y".repeat(300));
        plugins.push(i === 11 ? { ...plugin, active: false, error: "boom" } : plugin);
        entries.push(e);
      }
      const out = render(plugins, entries);
      expect(out.length).toBeLessThanOrEqual(2000);
      expect(out).toContain("• **p11** — installed 1.0.0 → 2.0.0 available — not running (first error: boom)");
      expect(out.endsWith(TRUNC)).toBe(true);
    });

    test("L4c: cutUtf16 and sliceUtf16 never end inside a pair", () => {
      expect(cutUtf16("a🙂bc", 3)).toBe("a…"); // the cut index lands on the high surrogate and backs off
      expect(cutUtf16("abc", 3)).toBe("abc");
      expect(cutUtf16("abcd", 3)).toBe("ab…");
      expect(sliceUtf16("a🙂", 2)).toBe("a"); // the back-off
      expect(sliceUtf16("ab🙂", 2)).toBe("ab"); // control: the cut index is before the pair
      // The ends of the high-surrogate range (U+10000 is D800 DC00, U+10FFFF is DBFF DFFF), as code units so the
      // source holds no invisible characters; then the units just outside it, which do not back off: D7FF (below),
      // DC00 (a LOW surrogate) and E000 (above).
      const units = (...codes: number[]) => String.fromCharCode(...codes);
      expect(sliceUtf16(`a${units(0xd800, 0xdc00)}`, 2)).toBe("a");
      expect(sliceUtf16(`a${units(0xdbff, 0xdfff)}`, 2)).toBe("a");
      for (const code of [0xd7ff, 0xdc00, 0xe000]) expect(sliceUtf16(`a${units(code)}b`, 2), code.toString(16)).toBe(`a${units(code)}`);
    });

    test("L4d: when the first lines fit the cap but not with the tail, they go out bare (no note, no tail)", () => {
      const name = "n".repeat(1948);
      const { plugin, entry: e } = withNote(name, "y".repeat(300));
      const out = render([plugin], [e]);
      expect(out).toBe(lineOf(name));
      expect(out.length).toBe(1990);
    });

    test("L4e: when even the first lines overflow, whole first lines from the top: no partial line", () => {
      const a = "a".repeat(1060);
      const b = "b".repeat(1060);
      const out = render([bare(a), bare(b)]);
      expect(out).toBe(`• **${a}** — installed 1.0.0${TRUNC}`);
      expect(out).not.toContain("b");
    });

    test("L4f: the per-note cut does not split a pair either (a list that fits)", () => {
      const { plugin, entry: e } = withNote("a", "🙂".repeat(200));
      const out = render([plugin], [e]);
      expect(lone.test(out)).toBe(false);
      // The note block (its 23-unit header line, then the emoji) is cut at 300: the pair across unit 300 is dropped whole.
      expect(out.slice(out.indexOf("\n") + 1)).toHaveLength(299);
      expect(out.endsWith(TRUNC)).toBe(false);
    });

    test("L4g: after the first lines, notes are kept in list order while they fit", () => {
      const names = ["k", "m", "n"].map((c) => c.repeat(356));
      const notes = ["Q", "R", "S"].map((c) => c.repeat(300));
      const rows = names.map((n, i) => withNote(n, notes[i]!));
      const out = render(rows.map((r) => r.plugin), rows.map((r) => r.entry));
      expect(out).toContain("Q".repeat(277));
      expect(out).toContain("R".repeat(277));
      expect(out).not.toContain("S");
      expect(out.length).toBe(1817);
      expect(out.endsWith(TRUNC)).toBe(true);
    });

    test("L4i: a note that does not fit is skipped, and a later, smaller one is still kept (a greedy fill)", () => {
      const names = ["a", "b", "c"].map((c) => c.repeat(540)); // first lines 582 each: room = 1981 - 1748 = 233
      const big = withNote(names[0]!, "A".repeat(300)); // renders as 301 units: does not fit
      const tinyB = withNote(names[1]!, "B"); // 25 units
      const tinyC = withNote(names[2]!, "C");
      const out = render([big.plugin, tinyB.plugin, tinyC.plugin], [big.entry, tinyB.entry, tinyC.entry]);
      expect(out).not.toContain("A");
      expect(out).toContain("**2.0.0** (2026-09-05)\nB");
      expect(out).toContain("**2.0.0** (2026-09-05)\nC");
      expect(out.endsWith(TRUNC)).toBe(true);
    });

    test("L4j: tier 3 cuts by line, so a kept plugin's own schedule line can fall past the cut", () => {
      const a = "a".repeat(1900); // first line 1924, its schedule line follows it: 1924 + ~75 > CAP
      const plugin = { ...bare(a), scheduled: { version: "1.1.0", at: "2026-09-06T00:00:00.000Z", requestedBy: "email:me@x.com" } };
      const out = render([plugin, bare("b")]);
      expect(out).toBe(`• **${a}** — installed 1.0.0${TRUNC}`);
      expect(out).not.toContain("⏳");
    });

    test("L4g2: a schedule line still follows the note in the progressive tier", () => {
      const names = ["k", "m", "n"].map((c) => c.repeat(356));
      const notes = ["Q", "R", "S"].map((c) => c.repeat(300));
      const rows = names.map((n, i) => withNote(n, notes[i]!));
      const plugins = rows.map((r, i) =>
        i === 0 ? { ...r.plugin, scheduled: { version: "2.0.0", at: "2026-09-06T00:00:00.000Z", requestedBy: "email:me@x.com" } } : r.plugin,
      );
      const out = render(plugins, rows.map((r) => r.entry));
      expect(out.indexOf("Q")).toBeGreaterThan(-1);
      expect(out.indexOf("Q")).toBeLessThan(out.indexOf("⏳"));
    });

    // One case per operator of the tier boundaries.
    test("L4h-1: a list of exactly 2000 units is returned whole, with no tail", () => {
      const { plugin, entry: e } = withNote("n".repeat(1657), "y".repeat(300));
      const out = render([plugin], [e]);
      expect(out.length).toBe(2000);
      expect(out).not.toContain("list truncated");
      expect(out).toContain("y".repeat(277));
    });
    test("L4h-2: first lines of exactly the cap still get the tail", () => {
      const name = "n".repeat(1939);
      const { plugin, entry: e } = withNote(name, "y".repeat(300));
      const out = render([plugin], [e]);
      expect(out).toBe(lineOf(name) + TRUNC);
      expect(out.length).toBe(2000);
    });
    test("L4h-3: first lines of exactly 2000 go out bare", () => {
      const name = "n".repeat(1958);
      const { plugin, entry: e } = withNote(name, "y".repeat(300));
      const out = render([plugin], [e]);
      expect(out).toBe(lineOf(name));
      expect(out.length).toBe(2000);
    });
    test("L4h-4: a note that fills the room exactly is kept", () => {
      const a = withNote("a".repeat(800), "y".repeat(300));
      const b = withNote("b".repeat(795), "z".repeat(300));
      const out = render([a.plugin, b.plugin], [a.entry, b.entry]);
      expect(out.startsWith(lineOf("a".repeat(800)))).toBe(true);
      expect(out).toContain("y".repeat(277));
      expect(out.endsWith(`\n${lineOf("b".repeat(795))}${TRUNC}`)).toBe(true);
      expect(out).not.toContain("z");
      expect(out.length).toBe(2000);
    });
    test("L4h-5: a first line of exactly the cap, then another plugin: the break right after it is the cut", () => {
      const a = "a".repeat(1957);
      const out = render([bare(a), bare("b")]);
      expect(out).toBe(`• **${a}** — installed 1.0.0${TRUNC}`);
      expect(out.length).toBe(2000);
    });
  });

  // #225: an off entry shows only that it's off and its pin — no "available" line even when the
  // index offers something newer, and a pending (paused) schedule still shows.
  test("an off plugin shows off and its installed version, a pending schedule, and nothing else", () => {
    const noSchedule = renderPluginsList(state([stateEntry("p", "1.0.0", { enabled: false })]), index([entry("p", "2.0.0")]), NOW, 1);
    expect(noSchedule.split("\n")[0]).toMatch(/^• \*\*p\*\* — off \(installed 1\.0\.0\)$/);
    expect(noSchedule).not.toContain("available");
    const withSchedule = renderPluginsList(
      state([stateEntry("p", "1.0.0", { enabled: false, scheduled: { version: "1.1.0", at: "2026-09-06T00:00:00.000Z", requestedBy: "admin1" } })]),
      index([entry("p", "2.0.0")]),
      NOW,
      1,
    );
    const scheduledTs = Math.floor(Date.parse("2026-09-06T00:00:00.000Z") / 1000);
    expect(withSchedule).toContain(`⏳ update to 1.1.0 scheduled <t:${scheduledTs}:R>`);
    expect(withSchedule).not.toContain("available");
  });

  // #544: a plugin that failed to install, load or activate this boot (`active: false`) says so on its
  // first line, with its error as one short line — not only in the panel and `bot-ops.sh status`.
  describe("a plugin that is not running (#544)", () => {
    const firstLine = (s: PluginStateEntry, idx: PluginIndex = index([])) => renderPluginsList(state([s]), idx, NOW, 1).split("\n")[0];
    // The text inside the marker's parentheses.
    const parenthesised = (line: string | undefined) => /^• \*\*a\*\* — installed 1\.0\.0 — not running \(first error: (.*)\)$/.exec(line ?? "")?.[1];

    test("says so, with its error collapsed to one line and cut to 120 characters", () => {
      const line = firstLine(stateEntry("a", "1.0.0", { active: false, error: `activate threw\n  at x.js:1\n${"y".repeat(300)}` }));
      const shown = parenthesised(line);
      expect(shown).toBeDefined();
      expect(shown).toBe(`activate threw at x.js:1 ${"y".repeat(120 - "activate threw at x.js:1 ".length - 1)}…`);
      expect(shown).toHaveLength(120);
      expect(shown).not.toContain("\n");
    });
    test("the cut is at 120 characters, not 119 or 121", () => {
      expect(parenthesised(firstLine(stateEntry("a", "1.0.0", { active: false, error: "e".repeat(120) })))).toBe("e".repeat(120));
      const cut = parenthesised(firstLine(stateEntry("a", "1.0.0", { active: false, error: "e".repeat(121) })));
      expect(cut).toBe(`${"e".repeat(119)}…`);
      expect(cut).toHaveLength(120);
    });
    test("an emoji straddling the cut is dropped whole, never split into a lone surrogate", () => {
      const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
      // The pair's halves sit at indexes 118 and 119: the cut keeps 119 characters, so it would keep only the high half.
      const split = parenthesised(firstLine(stateEntry("a", "1.0.0", { active: false, error: `${"x".repeat(118)}😀tail` })));
      expect(split).toBe(`${"x".repeat(118)}…`);
      expect(lone.test(split ?? "")).toBe(false);
      // The pair's halves sit at indexes 117 and 118: both kept.
      const whole = parenthesised(firstLine(stateEntry("a", "1.0.0", { active: false, error: `${"x".repeat(117)}😀${"y".repeat(20)}` })));
      expect(whole).toBe(`${"x".repeat(117)}😀…`);
      expect(lone.test(whole ?? "")).toBe(false);
    });
    test("with no usable error it says just that", () => {
      for (const error of [undefined, "", "   \n ", 5 as unknown as string]) {
        const line = firstLine(stateEntry("a", "1.0.0", { active: false, ...(error === undefined ? {} : { error }) }));
        expect(line).toBe("• **a** — installed 1.0.0 — not running");
      }
    });
    test("a running plugin carries no marker, configured or not", () => {
      expect(renderPluginsList(state([stateEntry("a", "1.0.0")]), index([]), NOW, 1)).toBe("• **a** — installed 1.0.0");
      expect(renderPluginsList(state([stateEntry("a", "1.0.0", { configured: false, missingEnv: ["TOKEN"] })]), index([]), NOW, 1)).not.toContain("not running");
    });
    test("the marker sits after the available version and before the release note", () => {
      const idx = index([entry("a", "1.1.0", { releases: [rel("1.1.0", { notes: "shiny" })] })]);
      const out = renderPluginsList(state([stateEntry("a", "1.0.0", { active: false, error: "e" })]), idx, NOW, 1);
      const lines = out.split("\n");
      expect(lines[0]).toBe("• **a** — installed 1.0.0 → 1.1.0 available — not running (first error: e)");
      expect(lines.slice(1).join("\n")).toContain("shiny");
      expect(lines[0]).not.toContain("shiny");
    });
    test("a pending schedule still follows on its own line", () => {
      const scheduled = { version: "1.1.0", at: "2026-09-06T00:00:00.000Z", requestedBy: "admin1" };
      const lines = renderPluginsList(state([stateEntry("a", "1.0.0", { active: false, error: "e", scheduled })]), index([]), NOW, 1).split("\n");
      expect(lines[0]).toBe("• **a** — installed 1.0.0 — not running (first error: e)");
      expect(lines[1]).toContain("⏳ update to 1.1.0 scheduled");
    });
    test("an off plugin that is not running still reads only off", () => {
      const out = renderPluginsList(state([stateEntry("p", "1.0.0", { enabled: false, active: false, error: "e" })]), index([]), NOW, 1);
      expect(out.split("\n")[0]).toMatch(/^• \*\*p\*\* — off \(installed 1\.0\.0\)$/);
      expect(out).not.toContain("not running");
    });
    test("many down plugins with long errors still fit Discord's cap (the clamp predates #544; the marker must not break it)", () => {
      const plugins = Array.from({ length: 40 }, (_, i) => stateEntry(`p${i}`, "1.0.0", { active: false, error: "z".repeat(500) }));
      const out = renderPluginsList(state(plugins), index([]), NOW, 1);
      expect(out.length).toBeLessThanOrEqual(2000);
      expect(out).toContain("… (list truncated)");
    });
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

  // #505 (U2e, M2g): the delivery moved to src/adminNotice.ts; the plugin wording is pinned in full.
  test("logs its three strings exactly as before the extraction", async () => {
    const warns: string[] = [];
    const errors: string[] = [];
    const log = { info() {}, warn: (m: string) => void warns.push(m), error: (m: string) => void errors.push(m) };
    const failing: PluginNotifyDeliverers = {
      dmUser: async () => {
        throw new Error("closed DMs");
      },
      postAnnounce: async () => {
        throw new Error("y");
      },
    };
    await deliverPluginNotification("msg", [], failing, log);
    await deliverPluginNotification("msg", ["42"], failing, log);
    expect(warns).toEqual([
      "[plugins] a plugin update is available but ADMIN_USER_IDS is empty — no one to notify",
      "[plugins] couldn't DM admin 42 about a plugin update (closed DMs) — will try the announce channel",
    ]);
    expect(errors).toEqual(["[plugins] channel fallback for a plugin update notice failed"]);
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
    /** The re-schedule twin of `cancelRace` (#502 item 14): swap the named fields of every `scheduled` just before the
     *  first mutate runs, so the arbiter's version and time re-checks (not only its `!cur?.scheduled`) are exercised. */
    rescheduleRace?: { version?: string; at?: string; requestedBy?: string };
    /** Make the n-th (1-based) mutate call reject with the returned error instead of applying (#440's isolation). */
    mutateStateError?: (call: number) => Error | undefined;
    /** Make the n-th mutate call RUN the mutator (so the arbiter's closure variables are set) and then reject without
     *  committing, as a save that fails after the decision was made does. */
    mutateStateFailsAfterRun?: (call: number) => Error | undefined;
    pluginsCommand?: string;
  }) {
    const dms: string[] = [];
    const dmContents: string[] = [];
    const posts: string[] = [];
    const restarts: string[] = [];
    const warns: string[] = [];
    const errors: string[] = [];
    let current = opts.state;
    const mutations: PluginStateFile[] = [];
    let indexLoads = 0;
    let raceApplied = false;
    let mutateCalls = 0;
    const deps: PluginUpdateDeps = {
      loadIndex: async () => { indexLoads++; return opts.index; },
      readState: async () => current,
      mutateState: async (mutate) => {
        mutateCalls++;
        const failure = opts.mutateStateError?.(mutateCalls);
        if (failure) throw failure;
        if (opts.cancelRace && !raceApplied) {
          raceApplied = true;
          current = { ...current, plugins: current.plugins.map((p) => { const n = { ...p }; delete n.scheduled; return n; }) };
        }
        if (opts.rescheduleRace && !raceApplied) {
          raceApplied = true;
          const swap = opts.rescheduleRace;
          current = {
            ...current,
            plugins: current.plugins.map((p) => (p.scheduled ? { ...p, scheduled: { ...p.scheduled, ...swap } } : p)),
          };
        }
        const late = opts.mutateStateFailsAfterRun?.(mutateCalls);
        if (late) {
          mutate(current); // the decision is made (closure variables set); the result is never committed
          throw late;
        }
        current = mutate(current);
        mutations.push(current);
      },
      deliverers: {
        dmUser: async (id, content) => { if (opts.dm) await opts.dm(); dms.push(id); dmContents.push(content); },
        postAnnounce: async () => { if (opts.post) await opts.post(); posts.push("x"); },
      },
      adminUserIds: opts.adminUserIds ?? ["admin1"],
      hostApiVersion: 1,
      pluginsCommand: opts.pluginsCommand ?? "plugins",
      now: () => NOW,
      log: { info() {}, warn: (m) => void warns.push(m), error: (m) => void errors.push(m) },
      restartPending: () => opts.restartPending ?? false,
      requestRestart: (reason) => { restarts.push(reason); },
    };
    return { deps, dms, dmContents, posts, restarts, warns, errors, mutations, get state() { return current; }, get indexLoads() { return indexLoads; } };
  }

  // The consumer boundary for the prefixed name: what the tick actually DMs is built from
  // deps.pluginsCommand. Mutation: dropping that argument (or passing a literal) fails this.
  test("the DM it sends names the /plugins command by deps.pluginsCommand", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0", { releases: [rel("1.1.0")] })]),
      state: state([stateEntry("a", "1.0.0")]),
      pluginsCommand: "pipplugins",
    });
    await checkPluginUpdates(h.deps);
    expect(h.dmContents).toHaveLength(1);
    expect(h.dmContents[0]).toContain("`/pipplugins update a`");
    expect(h.dmContents[0]).not.toContain("`/plugins");
  });

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
    // The count the test-state guard (test/stateGuard.ts) reads tracks the live one.
    expect(pluginUpdateStateForTest().deliveryFailures).toBe(1);
    await checkPluginUpdates(h.deps); // attempt 2 — no persist
    expect(h.state.plugins[0]?.notifiedVersion).toBeUndefined();
    await checkPluginUpdates(h.deps); // attempt 3 — give up, persist
    expect(h.state.plugins[0]?.notifiedVersion).toBe("1.1.0");
    expect(pluginUpdateStateForTest().deliveryFailures).toBe(0);
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

  // #444: the exemption is about the retry CAP, so it is pinned across the cap and the later admin's DM is asserted,
  // which is the property the test's name claims. (The old one-tick test did fail with the guard deleted, but only
  // through the test-state guard's leftover failure count, not on any assertion of its own.)
  test("with no admins: warns, delivers nothing, records nothing across the retry cap (a later admin still gets it)", async () => {
    const h = harness({ index: index([entry("a", "1.1.0")]), state: state([stateEntry("a", "1.0.0")]), adminUserIds: [] });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 1; i++) await checkPluginUpdates(h.deps);
    expect(h.dms).toHaveLength(0);
    expect(h.state.plugins[0]?.notifiedVersion).toBeUndefined();
    expect(pluginUpdateStateForTest().deliveryFailures).toBe(0); // nothing was counted toward the cap
    h.deps.adminUserIds.push("admin1");
    await checkPluginUpdates(h.deps);
    expect(h.dms).toEqual(["admin1"]);
    expect(h.state.plugins[0]?.notifiedVersion).toBe("1.1.0");
  });

  // #440: one plugin's failed notice (here a rejecting save) is logged and the next plugin still gets its notice.
  test("one plugin's failing notice does not stop the others'", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0", { releases: [rel("1.1.0")] }), entry("b", "2.1.0", { releases: [rel("2.1.0")] })]),
      state: state([stateEntry("a", "1.0.0"), stateEntry("b", "2.0.0")]),
      mutateStateError: (call) => (call === 1 ? new Error("disk full") : undefined), // plugin a's markNotified
    });
    await checkPluginUpdates(h.deps);
    expect(h.dms).toEqual(["admin1", "admin1"]); // both DMed
    expect(h.state.plugins.find((p) => p.name === "b")?.notifiedVersion).toBe("2.1.0");
    expect(h.state.plugins.find((p) => p.name === "a")?.notifiedVersion).toBeUndefined(); // its save failed
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("update notice for a 1.1.0 failed");
  });

  // #440/#442: any throw of the notice pass leaves the due schedules to the `finally`. No production path hands the pass a
  // malformed release any more (loadPluginIndex validates fetched and cached copies alike), so the harness feeds one
  // straight in as a stand-in for whatever else may throw there.
  test("a due schedule still fires when the notice pass throws on a malformed release", async () => {
    const bad = { ...entry("a", "1.1.0"), releases: [null] } as unknown as PluginIndexEntry;
    const h = harness({
      index: index([bad]),
      state: state([stateEntry("a", "1.0.0"), stateEntry("b", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z"))]),
    });
    await expect(checkPluginUpdates(h.deps)).rejects.toBeInstanceOf(TypeError);
    expect(h.restarts).toHaveLength(1);
    expect(h.restarts[0]).toContain("b");
    expect(h.state.plugins.find((p) => p.name === "b")?.targetVersion).toBe("1.1.0");
  });

  // The pass's own failure is what the caller sees; a failure of the schedule look after it is logged, not substituted.
  test("when the notice pass and the schedule look both fail, the pass's error is thrown and the other logged", async () => {
    const h = harness({ index: index([]), state: state([]) });
    h.deps.loadIndex = async () => {
      throw new Error("index unreachable");
    };
    h.deps.readState = async () => {
      throw new Error("state unreadable");
    };
    await expect(checkPluginUpdates(h.deps)).rejects.toThrow("index unreachable");
    expect(h.errors.some((e) => e.includes("running the due scheduled updates failed after the notice pass did"))).toBe(true);
  });
  test("when only the schedule look fails, its error is thrown", async () => {
    const h = harness({ index: index([]), state: state([]) });
    let reads = 0;
    h.deps.readState = async () => {
      if (++reads > 1) throw new Error("state unreadable");
      return state([]);
    };
    await expect(checkPluginUpdates(h.deps)).rejects.toThrow("state unreadable");
  });

  // #501 item 8: the DM failure's cause is in the warning, and the give-up line points at where the causes are.
  test("a DM failure's cause is logged, and the give-up line names the command and where the causes are", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0")]),
      dm: async () => { throw new Error("Cannot send messages to this user"); },
      post: async () => { throw new Error("no channel"); },
      pluginsCommand: "pipplugins",
    });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) await checkPluginUpdates(h.deps);
    expect(h.warns.some((w) => w.includes("Cannot send messages to this user"))).toBe(true);
    const giveUp = h.errors.find((e) => e.includes("gave up notifying about a 1.1.0"));
    expect(giveUp).toContain("the causes are in the log lines above");
    expect(giveUp).toContain("/pipplugins list still shows the update");
    expect(giveUp).not.toContain("a restart tries again");
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

  // #225: an off plugin's schedule is paused, not fired — turning the plugin back on is what resumes it.
  test("a due schedule on an off plugin does not fire and is kept", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", { enabled: false, ...scheduled("1.1.0", "2026-09-05T11:00:00.000Z") })]),
    });
    await checkPluginUpdates(h.deps);
    expect(h.restarts).toHaveLength(0);
    expect(h.mutations).toHaveLength(0);
    expect(h.dms).toHaveLength(0);
    expect(h.state.plugins[0]?.scheduled).toEqual({ version: "1.1.0", at: "2026-09-05T11:00:00.000Z", requestedBy: SNOWFLAKE });
  });

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
    // #442 / the `:654` pre-filter: the arbiter must not even run (and so not rewrite state.json) for a schedule
    // that is not due, or every minute's look would write the file for every plugin with a pending schedule.
    expect(h.mutations).toHaveLength(0);
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

  // #502 item 14: the cancel race above clears `scheduled` and so exercises only `!cur?.scheduled`; these swap it for a
  // re-schedule, which is what the arbiter's version and time re-checks are for.
  test("a re-schedule to another version that wins the race stops the stale fire (the version re-check)", async () => {
    const h = harness({
      // The index stays at the scheduled version, so no notice runs first and the arbiter's mutate is the FIRST one,
      // the one the race is applied to.
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z"))]),
      rescheduleRace: { version: "1.2.0" },
    });
    await checkPluginUpdates(h.deps);
    expect(h.restarts).toHaveLength(0);
    expect(h.state.plugins[0]?.scheduled).toMatchObject({ version: "1.2.0" }); // the newer schedule is kept
    expect(h.state.plugins[0]?.targetVersion).toBeUndefined();
  });

  test("a re-schedule to a later time that wins the race stops the stale fire (the time re-check)", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z"))]),
      rescheduleRace: { at: "2026-09-05T18:00:00.000Z" }, // after NOW
    });
    await checkPluginUpdates(h.deps);
    expect(h.restarts).toHaveLength(0);
    expect(h.state.plugins[0]?.scheduled).toMatchObject({ version: "1.1.0", at: "2026-09-05T18:00:00.000Z" });
    expect(h.state.plugins[0]?.targetVersion).toBeUndefined();
  });

  // #441: a due schedule whose version is already installed (or older) is dropped inside the arbiter, not fired.
  test("a due schedule whose version is already installed is dropped, not fired: no restart, no pin, the requester told", async () => {
    for (const installed of ["1.1.0", "1.2.0"]) {
      const h = harness({
        index: index([entry("a", installed)]),
        state: state([stateEntry("a", installed, scheduled("1.1.0", "2026-09-05T11:00:00.000Z"))]),
      });
      await checkPluginUpdates(h.deps);
      expect(h.restarts, installed).toHaveLength(0);
      expect(h.state.plugins[0]?.scheduled, installed).toBeUndefined();
      expect(h.state.plugins[0]?.targetVersion, installed).toBeUndefined();
      expect(h.state.pendingReport, installed).toBeUndefined();
      expect(h.warns.some((w) => w.includes(`dropped the scheduled update to 1.1.0 — ${installed} is already installed`)), installed).toBe(true);
      expect(h.dms, installed).toEqual([SNOWFLAKE]);
      expect(h.dmContents[0], installed).toContain("was dropped");
    }
  });

  test("a dropped schedule does not stop the walk: the next plugin's due schedule still fires", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0"), entry("b", "1.1.0")]),
      state: state([
        stateEntry("a", "1.1.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z")), // moot
        stateEntry("b", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z")), // due
      ]),
    });
    await checkPluginUpdates(h.deps);
    expect(h.restarts).toHaveLength(1);
    expect(h.restarts[0]).toContain("b");
    expect(h.state.plugins.find((p) => p.name === "a")?.scheduled).toBeUndefined();
    expect(h.state.plugins.find((p) => p.name === "b")?.targetVersion).toBe("1.1.0");
  });

  test("a dropped schedule asked for from the panel is logged but not DMed (no futile users.fetch)", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.1.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z", "email:me@x.com"))]),
    });
    await checkPluginUpdates(h.deps);
    expect(h.dms).toEqual([]);
    expect(h.warns.some((w) => w.includes("dropped the scheduled update to 1.1.0"))).toBe(true);
    expect(h.state.plugins[0]?.scheduled).toBeUndefined();
  });

  test("a failing DM about a dropped schedule is swallowed: the pass resolves and the next plugin still fires", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0"), entry("b", "1.1.0")]),
      state: state([
        stateEntry("a", "1.1.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z")),
        stateEntry("b", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z")),
      ]),
      dm: async () => { throw new Error("closed DMs"); },
    });
    await checkPluginUpdates(h.deps); // resolves
    expect(h.restarts).toHaveLength(1);
    expect(h.restarts[0]).toContain("b");
  });

  // The arbiter's view of the schedule names the recipient, not the pre-read: a re-schedule by someone else lands
  // between the read and the mutate, and the DM about the dropped schedule goes to THAT requester.
  test("the dropped schedule's DM goes to the requester the arbiter saw", async () => {
    const OTHER = "300000000000000000";
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.1.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z"))]),
      rescheduleRace: { requestedBy: OTHER },
    });
    await checkPluginUpdates(h.deps);
    expect(h.dms).toEqual([OTHER]);
  });

  // The look at the schedules is isolated per plugin like the notice pass: one entry that cannot be judged, or one
  // failing save, does not starve the others' due schedules on every look.
  test("a schedule whose version is not a string is dropped, and the next plugin's due schedule still fires", async () => {
    const corrupt = { scheduled: { version: 110, at: "2026-09-05T11:00:00.000Z", requestedBy: SNOWFLAKE } } as unknown as Partial<PluginStateEntry>;
    const h = harness({
      index: index([entry("b", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", corrupt), stateEntry("b", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z"))]),
    });
    await checkPluginUpdates(h.deps);
    expect(h.warns.some((w) => w.includes("a: dropped the scheduled update") && w.includes("is not a version"))).toBe(true);
    expect(h.state.plugins.find((p) => p.name === "a")?.scheduled).toBeUndefined();
    expect(h.restarts).toHaveLength(1);
    expect(h.restarts[0]).toContain("b");
  });

  test("a failing save for one plugin's schedule is logged and the next plugin's due schedule still fires", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0"), entry("b", "1.1.0")]),
      state: state([
        stateEntry("a", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z")),
        stateEntry("b", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z")),
      ]),
      mutateStateError: (call) => (call === 1 ? new Error("disk full") : undefined), // plugin a's arbiter
    });
    await checkPluginUpdates(h.deps);
    expect(h.errors.some((e) => e.includes("a: running its scheduled update failed"))).toBe(true);
    expect(h.restarts).toHaveLength(1);
    expect(h.restarts[0]).toContain("b");
  });

  // A save that fails AFTER the arbiter decided to fire must not restart the bot onto a pin that was never saved, nor
  // send the heads-up: the schedule is still on file and the next look fires it.
  test("a save that fails after the arbiter ran restarts nothing and DMs nobody; the next look fires it", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z"))]),
      mutateStateFailsAfterRun: (call) => (call === 1 ? new Error("disk full") : undefined),
    });
    await checkPluginUpdates(h.deps);
    expect(h.restarts).toHaveLength(0);
    expect(h.dms).toEqual([]);
    expect(h.state.plugins[0]?.scheduled).toMatchObject({ version: "1.1.0" });
    expect(h.state.plugins[0]?.targetVersion).toBeUndefined();
    expect(h.errors.some((e) => e.includes("a: running its scheduled update failed"))).toBe(true);
    await checkPluginUpdates(h.deps); // the next look
    expect(h.restarts).toHaveLength(1);
    expect(h.state.plugins[0]?.targetVersion).toBe("1.1.0");
  });

  // The heads-up DM goes to the requester the arbiter fired for (the one the boot report-back goes to), as the drop's DM does.
  test("the heads-up DM goes to the requester the arbiter saw", async () => {
    const OTHER = "300000000000000000";
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", scheduled("1.1.0", "2026-09-05T11:00:00.000Z"))]),
      rescheduleRace: { requestedBy: OTHER },
    });
    await checkPluginUpdates(h.deps);
    expect(h.restarts).toHaveLength(1);
    expect(h.dms).toEqual([OTHER]);
    expect(h.state.pendingReport).toMatchObject({ userId: OTHER });
  });

  // plugin-updates-9: a hand-edited `at` that is not a date used to fire on the next look (`now < NaN` is false).
  test("a schedule whose time is not a date is dropped and logged, not fired", async () => {
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", scheduled("1.1.0", "garbage"))]),
    });
    await checkPluginUpdates(h.deps);
    expect(h.restarts).toHaveLength(0);
    expect(h.state.plugins[0]?.scheduled).toBeUndefined();
    expect(h.state.plugins[0]?.targetVersion).toBeUndefined();
    expect(h.warns.some((w) => w.includes("is not a date"))).toBe(true);
  });

  // #502 item 12: the schedule carries the channel it was requested from, and the fire hands it to the report-back.
  test("a due schedule's pendingReport carries the channel it was scheduled from", async () => {
    const withChannel: ScheduledEntry = { version: "1.1.0", at: "2026-09-05T11:00:00.000Z", requestedBy: SNOWFLAKE, channelId: "chan1" };
    const h = harness({
      index: index([entry("a", "1.1.0")]),
      state: state([stateEntry("a", "1.0.0", { scheduled: withChannel })]),
    });
    await checkPluginUpdates(h.deps);
    expect(h.restarts).toHaveLength(1);
    expect(h.state.pendingReport).toMatchObject({ plugin: "a", toVersion: "1.1.0", userId: SNOWFLAKE, channelId: "chan1" });
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
  // #442 (plugin-updates-9): HH:MM rolls to tomorrow, but an ISO time already behind us would have fired at the next look.
  test("an ISO-8601 time at or before now is refused as already passed; one second later is taken", () => {
    for (const past of ["2020-01-01T00:00:00Z", "2026-09-05T12:00:00.000Z"]) {
      const r = parseScheduleTime(past, now); // the second equals `now`
      expect("error" in r, past).toBe(true);
      if ("error" in r) expect(r.error).toContain("already passed");
    }
    expect(ok(parseScheduleTime("2026-09-05T12:00:01Z", now)).toISOString()).toBe("2026-09-05T12:00:01.000Z");
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
    enabled: true,
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
  // #441, the command path: an update-now supersedes a schedule already pending for the version it pins.
  test("update now drops a pending schedule for the version it pins", () => {
    const r = planPluginAction({ kind: "update" }, base());
    const pending = { version: "1.1.0", at: "2026-09-05T18:00:00.000Z", requestedBy: "admin1" };
    const after = r.mutate!(state([stateEntry("a", "1.0.0", { scheduled: pending })])).plugins[0]!;
    expect(after.scheduled).toBeUndefined();
    expect(after.targetVersion).toBe("1.1.0");
  });
  test("update at:<time> schedules and does NOT restart", () => {
    const at = new Date("2026-09-05T18:00:00.000Z");
    const r = planPluginAction({ kind: "update", at }, base());
    expect(r.restart).toBeUndefined();
    // base() carries the channel the command ran in; the schedule keeps it for the report-back's channel fallback (#502).
    expect(applied(r).scheduled as ScheduledEntry | undefined).toEqual({ version: "1.1.0", at: at.toISOString(), requestedBy: "admin1", channelId: "chan1" });
  });
  test("update at:<time> from a context with no channel stores no channelId", () => {
    const at = new Date("2026-09-05T18:00:00.000Z");
    const r = planPluginAction({ kind: "update", at }, base({ channelId: undefined }));
    expect(applied(r).scheduled).toEqual({ version: "1.1.0", at: at.toISOString(), requestedBy: "admin1" });
  });
  test("remind sets remindAt now+days", () => {
    const r = planPluginAction({ kind: "remind", days: 3 }, base());
    expect(applied(r).remindAt).toBe(new Date("2026-09-08T12:00:00.000Z").toISOString());
  });
  // #501 item 4: the remind branch passes the version it is about to snooze, so a skip is lifted and the snooze holds.
  test("remind after a skip clears the skip and acknowledges the version (the command path)", () => {
    const r = planPluginAction({ kind: "remind", days: 3 }, base());
    const after = r.mutate!(state([stateEntry("a", "1.0.0", { skippedVersion: "1.1.0" })])).plugins[0]!;
    expect(after.skippedVersion).toBeUndefined();
    expect(after.notifiedVersion).toBe("1.1.0");
    expect(after.remindAt).toBe(new Date("2026-09-08T12:00:00.000Z").toISOString());
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

  // #225: an off plugin (not in PLUGINS=) is never updated — it isn't running.
  test("update on an off plugin is refused with no mutation and no restart, now and at a time alike", () => {
    const now = planPluginAction({ kind: "update" }, base({ enabled: false }));
    expect(now.mutate).toBeUndefined();
    expect(now.restart).toBeUndefined();
    expect(now.reply).toContain("a");
    expect(now.reply).toContain("turned off");
    const at = new Date("2026-09-05T18:00:00.000Z");
    const scheduled = planPluginAction({ kind: "update", at }, base({ enabled: false }));
    expect(scheduled.mutate).toBeUndefined();
    expect(scheduled.restart).toBeUndefined();
    expect(scheduled.reply).toContain("turned off");
  });

  test("remind, skip and cancel still apply to an off plugin", () => {
    expect(applied(planPluginAction({ kind: "remind", days: 3 }, base({ enabled: false }))).remindAt).toBe(
      new Date("2026-09-08T12:00:00.000Z").toISOString(),
    );
    expect(applied(planPluginAction({ kind: "skip" }, base({ enabled: false }))).skippedVersion).toBe("1.1.0");
    const r = planPluginAction({ kind: "cancel" }, base({ enabled: false, hasPending: true }));
    const seeded = state([stateEntry("a", "1.0.0", { scheduled: { version: "1.1.0", at: "x", requestedBy: "admin1" } })]);
    expect(r.mutate!(seeded).plugins[0]?.scheduled).toBeUndefined();
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
  // #225: turned off in the same restart an update-now targeted (the pin was consumed but the plugin
  // never ran) — an honest report, not a false success or a confusing "still on" revert message.
  test("an off plugin reports that the update did not run", () => {
    const r = decidePluginReportOutcome(report, stateEntry("a", "1.0.0", { enabled: false, active: false }));
    expect(r).toEqual({ ok: false, message: "⚠️ **a** is turned off, so the update to 1.1.0 did not run." });
  });
  // #543: `entry.error` names the TARGET's failure (host.ts builds it first-failure-wins), and on
  // install.ts's last-good-failed path nothing was reused at all, so the message must neither attribute the
  // error to the previous version nor claim it was "reused": it only says the previous version is not running.
  test("reverted to a previous version that is not running either → says so, not 'still on'", () => {
    const r = decidePluginReportOutcome(report, stateEntry("a", "1.0.0", { active: false, error: "integrity mismatch for 1.1.0" }));
    expect(r).toEqual({
      ok: false,
      message: "⚠️ **a** could not be updated to 1.1.0 (integrity mismatch for 1.1.0) — and 1.0.0 is not running either.",
    });
    expect(r.message).not.toContain("still on");
    expect(r.message).not.toContain("reused");
  });
  test("reverted and not running, with no error → the same tail without a parenthesis", () => {
    const r = decidePluginReportOutcome(report, stateEntry("a", "1.0.0", { active: false }));
    expect(r).toEqual({ ok: false, message: "⚠️ **a** could not be updated to 1.1.0 — and 1.0.0 is not running either." });
  });
  test("reverted and running keeps the exact wording it always had (for a short one-line error)", () => {
    const r = decidePluginReportOutcome(report, stateEntry("a", "1.0.0", { active: true, error: "integrity mismatch for 1.1.0" }));
    expect(r).toEqual({ ok: false, message: "⚠️ **a** could not be updated to 1.1.0 (integrity mismatch for 1.1.0) — still on 1.0.0." });
  });
  test("a blank error adds no empty parenthesis, in any of the three failure branches", () => {
    for (const error of ["", "  \n "]) {
      expect(decidePluginReportOutcome(report, stateEntry("a", "1.0.0", { active: false, error })).message).toBe(
        "⚠️ **a** could not be updated to 1.1.0 — and 1.0.0 is not running either.",
      );
      expect(decidePluginReportOutcome(report, stateEntry("a", "1.0.0", { active: true, error })).message).toBe(
        "⚠️ **a** could not be updated to 1.1.0 — still on 1.0.0.",
      );
      expect(decidePluginReportOutcome(report, stateEntry("a", "1.1.0", { active: false, error })).message).toBe(
        "⚠️ **a** updated to 1.1.0 but failed to start.",
      );
    }
  });
  // No state entry at all, or one that never recorded an installed version: neither is a "reverted" update, so
  // neither may print "still on undefined" / "undefined is not running either".
  test("no entry, or an entry with no installed version, is the failed-to-start message", () => {
    const failed = "⚠️ **a** updated to 1.1.0 but failed to start.";
    expect(decidePluginReportOutcome(report, undefined)).toEqual({ ok: false, message: failed });
    expect(decidePluginReportOutcome(report, stateEntry("a", undefined, { active: false })).message).toBe(failed);
    expect(decidePluginReportOutcome(report, stateEntry("a", undefined, { active: true })).message).toBe(failed);
  });
  test("a long error in the report-back is collapsed and cut like the list's", () => {
    const reverted = decidePluginReportOutcome(report, stateEntry("a", "1.0.0", { active: false, error: `first\n${"q".repeat(300)}` }));
    const inParens = /\((.*)\)/.exec(reverted.message)?.[1];
    expect(inParens).toBe(`first ${"q".repeat(120 - "first ".length - 1)}…`);
    expect(inParens).toHaveLength(120);
    // The installed-but-failed-to-start branch shares `why`, so its DM gets the same short error.
    const started = decidePluginReportOutcome(report, stateEntry("a", "1.1.0", { active: false, error: `${"q".repeat(300)}` }));
    expect(started.message).toBe(`⚠️ **a** updated to 1.1.0 but failed to start (${"q".repeat(119)}…).`);
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
    const reminded = remindLater("a", "2026-02-02T00:00:00Z", "1.1.0")(seed()).plugins[0];
    expect(reminded?.remindAt).toBe("2026-02-02T00:00:00Z");
    expect(reminded?.notifiedVersion).toBe("1.1.0"); // #501 item 4: the snooze acknowledges the version it is for
  });
  // #502 item 12: the channel is stored only when there is one.
  test("scheduleUpdate stores the channel it is given, and none when there is none", () => {
    expect(scheduleUpdate("a", "1.1.0", "2026-01-01T00:00:00Z", "200863115821318144", "chan1")(seed()).plugins[0]?.scheduled as ScheduledEntry | undefined).toEqual({
      version: "1.1.0",
      at: "2026-01-01T00:00:00Z",
      requestedBy: "200863115821318144",
      channelId: "chan1",
    });
    expect(scheduleUpdate("a", "1.1.0", "2026-01-01T00:00:00Z", "u")(seed()).plugins[0]?.scheduled).not.toHaveProperty("channelId");
  });
  // #501 item 4, as a composition: a remind after a skip is a change of mind, and the snooze then actually holds.
  test("remindLater after skipVersion: the skip is gone, the snooze holds until it is due, then reminds", () => {
    const AT = "2026-09-08T12:00:00.000Z";
    const reminded = remindLater("a", AT, "1.1.0")(skipVersion("a", "1.1.0")(state([stateEntry("a", "1.0.0")])));
    expect(reminded.plugins[0]).toMatchObject({ remindAt: AT, notifiedVersion: "1.1.0" });
    expect(reminded.plugins[0]?.skippedVersion).toBeUndefined();
    const idx = index([entry("a", "1.1.0")]);
    expect(decidePluginUpdates(reminded, idx, 1, NOW).map((d) => d.action)).toEqual(["none"]); // before AT: holds
    expect(decidePluginUpdates(reminded, idx, 1, new Date(Date.parse(AT) + 1000)).map((d) => d.action)).toEqual(["remind"]);
    // Before this change a remind on a version nobody had been told about was followed by a notify that wiped the snooze.
    const unnotified = remindLater("a", AT, "1.1.0")(state([stateEntry("a", "1.0.0")]));
    expect(decidePluginUpdates(unnotified, idx, 1, NOW).map((d) => d.action)).toEqual(["none"]);
  });
  // A stale remind (a mailbox request naming an older version) must not turn the snooze of a newer, already-notified
  // version into a fresh notice, nor lift a skip of some other version.
  test("remindLater never steps the acknowledged version back, and lifts only a skip of its own version", () => {
    const AT = "2026-09-08T12:00:00.000Z";
    const seeded = state([stateEntry("a", "1.0.0", { notifiedVersion: "1.2.0", skippedVersion: "1.1.0" })]);
    const stale = remindLater("a", AT, "1.0.5")(seeded);
    expect(stale.plugins[0]).toMatchObject({ remindAt: AT, notifiedVersion: "1.2.0", skippedVersion: "1.1.0" });
    // the snooze of the notified 1.2.0 still holds, so the next tick stays quiet until AT
    expect(decidePluginUpdates(stale, index([entry("a", "1.2.0")]), 1, NOW).map((d) => d.action)).toEqual(["none"]);
    // a NEWER version is acknowledged
    expect(remindLater("a", AT, "1.3.0")(seeded).plugins[0]?.notifiedVersion).toBe("1.3.0");
    // and the skip of the version being reminded about is the one that goes
    expect(remindLater("a", AT, "1.1.0")(seeded).plugins[0]?.skippedVersion).toBeUndefined();
  });
  test("a release with no notes prints no 'undefined' in the notice (#440 lets `notes` be absent)", () => {
    const bare = { version: "1.1.0", publishedAt: "2026-09-05T12:00:00.000Z" } as unknown as PluginRelease;
    const [d] = decidePluginUpdates(state([stateEntry("a", "1.0.0")]), index([entry("a", "1.1.0", { releases: [bare] })]), 1, NOW);
    expect(d).toBeDefined();
    const message = notificationMessage(d!, 1, "plugins");
    expect(message).toContain("**1.1.0** (2026-09-05)");
    expect(message).not.toContain("undefined");
  });
  test("pinUpdateNow sets targetVersion + pendingReport; cancelPending clears scheduled + targetVersion", () => {
    const report = { plugin: "a", toVersion: "9.9.9", userId: "u", requestedAt: 0 };
    const after = pinUpdateNow("a", "9.9.9", report)(seed());
    expect(after.plugins[0]?.targetVersion).toBe("9.9.9");
    expect(after.pendingReport).toEqual(report);
    // #441: an update-now supersedes a pending schedule for the plugin (a later fire would restart for nothing).
    const withSched = state([stateEntry("a", "1.0.0", { scheduled: { version: "1.1.0", at: "x", requestedBy: "u" } }), stateEntry("b", "1.0.0", { scheduled: { version: "2.0.0", at: "y", requestedBy: "u" } })]);
    const pinned = pinUpdateNow("a", "9.9.9", report)(withSched);
    expect(pinned.plugins[0]?.scheduled).toBeUndefined();
    expect(pinned.plugins[0]?.targetVersion).toBe("9.9.9");
    expect(pinned.plugins[1]?.scheduled).toMatchObject({ version: "2.0.0" }); // another plugin's schedule is untouched
    // ...but a schedule for a NEWER version than the pin is still the admin's wish after it, and is kept.
    const newer = state([stateEntry("a", "1.0.0", { scheduled: { version: "10.0.0", at: "x", requestedBy: "u" } })]);
    expect(pinUpdateNow("a", "9.9.9", report)(newer).plugins[0]?.scheduled).toMatchObject({ version: "10.0.0" });
    expect(pinUpdateNow("a", "10.0.0", report)(newer).plugins[0]?.scheduled).toBeUndefined(); // the same version: superseded
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
  function reportHarness(opts: {
    state: PluginStateFile;
    dm?: () => Promise<void>;
    /** Swap `pendingReport` for this one just before the first mutate runs (#501 item 11): a report written by the
     *  request drain, the schedule tick or a /plugins update between the read and the clear. */
    raceReport?: PluginStateFile["pendingReport"];
  }) {
    let current = opts.state;
    let raced = false;
    const dms: string[] = [];
    const channels: string[] = [];
    const errors: string[] = [];
    // The pending report as it stood at the moment each delivery was attempted (#443): the clear must already be done.
    const seenAtDm: PluginStateFile["pendingReport"][] = [];
    const seenAtChannel: PluginStateFile["pendingReport"][] = [];
    const deps: PluginReportDeps = {
      readState: async () => current,
      mutateState: async (mutate) => {
        if (opts.raceReport && !raced) {
          raced = true;
          current = { ...current, pendingReport: opts.raceReport };
        }
        current = mutate(current);
      },
      dmUser: async (_id, content) => { seenAtDm.push(current.pendingReport); if (opts.dm) await opts.dm(); dms.push(content); },
      postChannel: async (_c, _u, content) => { seenAtChannel.push(current.pendingReport); channels.push(content); },
      log: { info() {}, warn() {}, error: (m) => errors.push(m) },
    };
    return { deps, dms, channels, errors, seenAtDm, seenAtChannel, get state() { return current; } };
  }
  const withReport = (report: PluginStateFile["pendingReport"], entry = stateEntry("a", "1.1.0", { active: true })) =>
    ({ ...state([entry]), pendingReport: report });

  test("no pendingReport → nothing delivered", async () => {
    const h = reportHarness({ state: state([stateEntry("a", "1.1.0")]) });
    await reportPluginUpdateOutcome(h.deps);
    expect(h.dms).toHaveLength(0);
  });
  const SNOWFLAKE = "200863115821318144";
  test("L1: clears pendingReport BEFORE delivering, then DMs the requester", async () => {
    const h = reportHarness({ state: withReport({ plugin: "a", toVersion: "1.1.0", userId: SNOWFLAKE, requestedAt: 0 }) });
    await reportPluginUpdateOutcome(h.deps);
    expect(h.state.pendingReport).toBeUndefined();
    expect(h.dms[0]).toContain("is now 1.1.0");
    // #443: at the moment of the DM the report was already gone (a clear moved below the delivery leaves it set).
    expect(h.seenAtDm).toEqual([undefined]);
  });
  test("L1: a failed DM still leaves pendingReport cleared (never re-fires) and falls back to the channel", async () => {
    const h = reportHarness({
      state: withReport({ plugin: "a", toVersion: "1.1.0", userId: SNOWFLAKE, channelId: "chan1", requestedAt: 0 }),
      dm: async () => { throw new Error("closed DMs"); },
    });
    await reportPluginUpdateOutcome(h.deps);
    expect(h.state.pendingReport).toBeUndefined(); // cleared before delivery — no boot-loop re-fire
    expect(h.channels[0]).toContain("is now 1.1.0");
    expect(h.seenAtDm).toEqual([undefined]); // ...and already cleared when the failing DM was tried
    expect(h.seenAtChannel).toEqual([undefined]); // ...and when the channel fallback went out
  });
  // #501 item 11: the clear deletes only the report that was read. A newer one written between the read and the clear
  // (the 5 s request drain, a due schedule on the 60 s tick, a /plugins update) survives to be delivered next time; the
  // DM that goes out is still the ORIGINAL report's. One case per conjunct of the guard.
  test("L2a: a report for ANOTHER plugin written meanwhile (same requestedAt) survives the clear", async () => {
    const raced = { plugin: "b", toVersion: "2.0.0", userId: SNOWFLAKE, requestedAt: 0 };
    const h = reportHarness({
      state: withReport({ plugin: "a", toVersion: "1.1.0", userId: SNOWFLAKE, requestedAt: 0 }),
      raceReport: raced,
    });
    await reportPluginUpdateOutcome(h.deps);
    expect(h.state.pendingReport).toEqual(raced);
    expect(h.dms).toHaveLength(1);
    expect(h.dms[0]).toContain("is now 1.1.0");
  });
  test("L2b: a newer report for the SAME plugin (another requestedAt) written meanwhile survives the clear", async () => {
    const raced = { plugin: "a", toVersion: "1.2.0", userId: SNOWFLAKE, requestedAt: 5 };
    const h = reportHarness({
      state: withReport({ plugin: "a", toVersion: "1.1.0", userId: SNOWFLAKE, requestedAt: 0 }),
      raceReport: raced,
    });
    await reportPluginUpdateOutcome(h.deps);
    expect(h.state.pendingReport).toEqual(raced);
    expect(h.dms).toHaveLength(1);
    expect(h.dms[0]).toContain("is now 1.1.0");
  });
  test("a PANEL-origin request (non-snowflake requestedBy) clears the report + logs, never DMs", async () => {
    const h = reportHarness({ state: withReport({ plugin: "a", toVersion: "1.1.0", userId: "email:me@x.com", requestedAt: 0 }) });
    await reportPluginUpdateOutcome(h.deps);
    expect(h.state.pendingReport).toBeUndefined(); // still cleared — never re-fires
    expect(h.dms).toHaveLength(0); // no futile users.fetch(email)
    expect(h.channels).toHaveLength(0);
  });
});
