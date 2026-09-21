import { describe, expect, test } from "bun:test";
import {
  clip,
  droppedByRepair,
  freshRouting,
  freshSecrets,
  MAX_RESULTS,
  PLUGIN_NAME_RE,
  REQUEST_ID_RE,
  repairRouting,
  repairSecrets,
  ROUTING_VERSION,
  SNOWFLAKE_RE,
  withResult,
  type RequestResult,
  type RoutingFile,
} from "./model";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const CHAN_1 = "333333333333333331";
const CHAN_2 = "333333333333333332";
const HOOK = "444444444444444444";

/** A valid file with two plugins and one webhook. */
function good(): RoutingFile {
  return {
    v: 1,
    updatedAt: "2026-09-21T00:00:00.000Z",
    updatedBy: "admin@example.com",
    plugins: {
      music: { servers: { [GUILD_A]: { commands: [CHAN_1, CHAN_2], postTo: CHAN_1 }, [GUILD_B]: { commands: "all" } } },
      wow: { servers: {} },
    },
    webhooks: {
      [CHAN_1]: { id: HOOK, guildId: GUILD_A, addedAt: "2026-09-21T00:00:00.000Z", addedBy: "admin@example.com" },
    },
    results: [],
  };
}

/** Repair of one plugin's routing, for the cases that only vary a server entry. */
function repairServer(server: unknown): RoutingFile["plugins"] {
  return repairRouting({ v: 1, plugins: { music: { servers: { [GUILD_A]: server } } } }).plugins;
}

describe("the constants", () => {
  test("the version is 1", () => {
    expect(ROUTING_VERSION).toBe(1);
  });

  test("a plugin name is a lowercase word with digits and hyphens, as in the Plugin Index", () => {
    for (const name of ["music", "wow", "a", "wow-2", "plugin-x9"]) expect(PLUGIN_NAME_RE.test(name)).toBe(true);
    for (const name of ["", "Music", "1abc", "-a", "a_b", "a b", "a.b", "a/b", "__proto__"]) {
      expect(PLUGIN_NAME_RE.test(name)).toBe(false);
    }
  });

  test("a snowflake is 5 to 25 digits", () => {
    for (const id of ["12345", GUILD_A, "1".repeat(25)]) expect(SNOWFLAKE_RE.test(id)).toBe(true);
    for (const id of ["", "1234", "1".repeat(26), "12a45", "-12345", " 12345", "12345 ", "1.2345e5"]) {
      expect(SNOWFLAKE_RE.test(id)).toBe(false);
    }
  });
});

describe("freshRouting / freshSecrets", () => {
  test("a fresh file is empty and versioned", () => {
    expect(freshRouting()).toEqual({ v: 1, updatedAt: "", updatedBy: "", plugins: {}, webhooks: {}, results: [] });
    expect(freshSecrets()).toEqual({ v: 1, webhooks: {} });
  });

  test("every call returns a new object, so nobody can poison the next fresh file", () => {
    const a = freshRouting();
    a.plugins.music = { servers: {} };
    expect(freshRouting().plugins).toEqual({});
    const s = freshSecrets();
    s.webhooks[CHAN_1] = "https://example.invalid/x";
    expect(freshSecrets().webhooks).toEqual({});
  });
});

describe("repairRouting", () => {
  test("a valid file comes back unchanged", () => {
    expect(repairRouting(good())).toEqual(good());
  });

  test("a non-object becomes fresh", () => {
    for (const raw of [null, undefined, 42, "routing", true, [], [good()]]) {
      expect(repairRouting(raw)).toEqual(freshRouting());
    }
  });

  test("a file's own version is not consulted -- it is read by shape and comes back as v: 1", () => {
    // A hand-seeded file that forgot `v`, or one a newer version wrote, keeps every placement it
    // holds: throwing it away whole would be silent data loss on the next write.
    for (const v of [undefined, 0, 2, "1", null]) {
      expect(repairRouting({ ...good(), v })).toEqual(good());
    }
    const { v: _dropped, ...noVersion } = good();
    expect(repairRouting(noVersion)).toEqual(good());
  });

  test("a wrong-typed plugins or webhooks map becomes empty", () => {
    for (const bad of [null, [], "x", 7, true]) {
      const repaired = repairRouting({ ...good(), plugins: bad, webhooks: bad });
      expect(repaired.plugins).toEqual({});
      expect(repaired.webhooks).toEqual({});
      // The rest of the file is still read.
      expect(repaired.updatedBy).toBe("admin@example.com");
    }
  });

  test("a wrong-typed updatedAt or updatedBy becomes empty text", () => {
    const repaired = repairRouting({ ...good(), updatedAt: 5, updatedBy: { x: 1 } });
    expect(repaired.updatedAt).toBe("");
    expect(repaired.updatedBy).toBe("");
  });

  test("drops a plugin with a malformed name", () => {
    const entry = { servers: { [GUILD_A]: { commands: "all" } } };
    const repaired = repairRouting({
      v: 1,
      plugins: { Music: entry, "1abc": entry, "has space": entry, under_score: entry, "": entry, music: entry, "wow-2": entry },
    });
    expect(Object.keys(repaired.plugins).sort()).toEqual(["music", "wow-2"]);
  });

  test("drops a plugin whose entry is not an object with a servers object", () => {
    const repaired = repairRouting({
      v: 1,
      plugins: { a: null, b: [], c: "x", d: {}, e: { servers: null }, f: { servers: [] }, g: { servers: {} } },
    });
    // Only g is well-formed -- and an empty servers map is a real placement, not damage.
    expect(repaired.plugins).toEqual({ g: { servers: {} } });
  });

  test("drops a server with a malformed id", () => {
    const entry = { commands: "all" };
    const repaired = repairRouting({
      v: 1,
      plugins: { music: { servers: { abc: entry, "1234": entry, ["1".repeat(26)]: entry, "": entry, [GUILD_A]: entry } } },
    });
    expect(Object.keys(repaired.plugins.music!.servers)).toEqual([GUILD_A]);
  });

  test("drops a server whose channel list is empty", () => {
    expect(repairServer({ commands: [] })).toEqual({ music: { servers: {} } });
  });

  test("drops a server whose commands are neither all nor a list of channel ids", () => {
    for (const commands of [undefined, null, "some", 5, {}, [CHAN_1, 42], [CHAN_1, "not-a-channel"], ["1234"]]) {
      expect(repairServer({ commands })).toEqual({ music: { servers: {} } });
    }
    expect(repairServer("all")).toEqual({ music: { servers: {} } });
    expect(repairServer(null)).toEqual({ music: { servers: {} } });
  });

  test("keeps a server whose commands are all or a list of channel ids", () => {
    expect(repairServer({ commands: "all" }).music!.servers[GUILD_A]).toEqual({ commands: "all" });
    expect(repairServer({ commands: [CHAN_1] }).music!.servers[GUILD_A]).toEqual({ commands: [CHAN_1] });
  });

  test("drops a malformed postTo but keeps the server", () => {
    for (const postTo of [42, "abc", "", null, [CHAN_1], {}]) {
      expect(repairServer({ commands: "all", postTo }).music!.servers[GUILD_A]).toEqual({ commands: "all" });
    }
    expect(repairServer({ commands: "all", postTo: CHAN_2 }).music!.servers[GUILD_A]).toEqual({
      commands: "all",
      postTo: CHAN_2,
    });
  });

  test("drops a webhook whose entry is malformed, and only that webhook", () => {
    const ok = { id: HOOK, guildId: GUILD_A, addedAt: "t", addedBy: "u" };
    const repaired = repairRouting({
      v: 1,
      webhooks: {
        [CHAN_1]: ok,
        [CHAN_2]: { ...ok, id: "nope" },
        "333333333333333333": { ...ok, guildId: 5 },
        "333333333333333334": { ...ok, addedAt: undefined },
        "333333333333333335": "https://example.invalid/hook",
        "333333333333333336": null,
        notachannel: ok,
      },
    });
    expect(Object.keys(repaired.webhooks)).toEqual([CHAN_1]);
  });

  test("a webhook needs string addedAt and addedBy, and keeps a string broken only", () => {
    const ok = { id: HOOK, guildId: GUILD_A, addedAt: "t", addedBy: "u" };
    const repaired = repairRouting({
      v: 1,
      webhooks: {
        [CHAN_1]: { ...ok, addedBy: undefined },
        [CHAN_2]: { ...ok, addedBy: 5 },
        "333333333333333333": { ...ok, addedAt: 5 },
        // A `broken` that is not text costs the webhook its reason, not the webhook itself.
        "333333333333333334": { ...ok, broken: 7 },
        "333333333333333335": { ...ok, broken: { why: "x" } },
        "333333333333333336": { ...ok, broken: "Unknown Webhook" },
      },
    });
    expect(repaired.webhooks).toEqual({
      "333333333333333334": ok,
      "333333333333333335": ok,
      "333333333333333336": { ...ok, broken: "Unknown Webhook" },
    });
  });

  test("a webhook keeps only its metadata -- a url or token in the file is never carried over", () => {
    const repaired = repairRouting({
      v: 1,
      webhooks: {
        [CHAN_1]: {
          id: HOOK,
          guildId: GUILD_A,
          addedAt: "t",
          addedBy: "u",
          broken: "Unknown Webhook",
          url: "https://discord.com/api/webhooks/1/SECRET",
          token: "SECRET",
        },
      },
    });
    expect(repaired.webhooks[CHAN_1]).toEqual({ id: HOOK, guildId: GUILD_A, addedAt: "t", addedBy: "u", broken: "Unknown Webhook" });
    expect(JSON.stringify(repaired)).not.toContain("SECRET");
  });

  test("unknown keys are not carried into the repaired file", () => {
    const repaired = repairRouting({
      ...good(),
      extra: 1,
      plugins: { music: { servers: { [GUILD_A]: { commands: "all", note: "x" } }, note: "y" } },
    });
    expect(repaired).toEqual({
      v: 1,
      updatedAt: "2026-09-21T00:00:00.000Z",
      updatedBy: "admin@example.com",
      plugins: { music: { servers: { [GUILD_A]: { commands: "all" } } } },
      webhooks: good().webhooks,
      results: [],
    });
  });

  test("is not fooled by prototype keys", () => {
    // JSON.parse makes `__proto__` an OWN key, which is exactly what a hostile file does.
    const raw = JSON.parse(`{
      "v": 1,
      "__proto__": { "polluted": true },
      "plugins": {
        "__proto__": { "servers": { "${GUILD_A}": { "commands": "all" } } },
        "constructor": { "servers": { "${GUILD_A}": { "commands": "all" } } },
        "music": { "servers": {
          "__proto__": { "commands": "all" },
          "constructor": { "commands": "all" },
          "${GUILD_A}": { "commands": "all", "__proto__": { "polluted": true } }
        } }
      },
      "webhooks": { "__proto__": { "id": "${HOOK}", "guildId": "${GUILD_A}", "addedAt": "t", "addedBy": "u" } }
    }`) as unknown;
    const repaired = repairRouting(raw);

    // Nothing reached a prototype: not the result's, its maps', nor Object.prototype itself.
    expect(Object.getPrototypeOf(repaired)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(repaired.plugins)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(repaired.webhooks)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect((repaired as unknown as { polluted?: boolean }).polluted).toBeUndefined();

    // `__proto__` is not a valid plugin name, a server id or a channel id, so none of them survive...
    expect(Object.hasOwn(repaired.plugins, "__proto__")).toBe(false);
    expect(Object.keys(repaired.webhooks)).toEqual([]);
    expect(Object.keys(repaired.plugins.music!.servers)).toEqual([GUILD_A]);
    expect(repaired.plugins.music!.servers[GUILD_A]).toEqual({ commands: "all" });
    // ...while `constructor` IS a legal plugin name, and is kept as an ordinary own entry.
    expect(Object.hasOwn(repaired.plugins, "constructor")).toBe(true);
    expect(repaired.plugins["constructor"]).toEqual({ servers: { [GUILD_A]: { commands: "all" } } });
  });

  test("returns a new object, never the input", () => {
    const input = good();
    const repaired = repairRouting(input);
    expect(repaired).not.toBe(input);
    expect(repaired.plugins).not.toBe(input.plugins);
    expect(repaired.webhooks).not.toBe(input.webhooks);
    expect(repaired.plugins.music).not.toBe(input.plugins.music);
    expect(repaired.plugins.music!.servers).not.toBe(input.plugins.music!.servers);
    expect(repaired.plugins.music!.servers[GUILD_A]).not.toBe(input.plugins.music!.servers[GUILD_A]);
    expect(repaired.plugins.music!.servers[GUILD_A]!.commands).not.toBe(input.plugins.music!.servers[GUILD_A]!.commands);
    expect(repaired.webhooks[CHAN_1]).not.toBe(input.webhooks[CHAN_1]);

    // So changing the result cannot reach back into what it was built from.
    (repaired.plugins.music!.servers[GUILD_A]!.commands as string[]).push("999999");
    repaired.plugins.extra = { servers: {} };
    expect(input).toEqual(good());
  });

  test("never throws on hostile or absurd input", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 5000; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i += 1) many[`plugin-${i}`] = { servers: {} };
    for (const raw of [deep, { v: 1, plugins: many }, { v: 1, plugins: { music: { servers: { [GUILD_A]: { commands: Array(5000).fill(CHAN_1) } } } } }]) {
      expect(() => repairRouting(raw)).not.toThrow();
    }
    expect(Object.keys(repairRouting({ v: 1, plugins: many }).plugins)).toHaveLength(5000);
  });
});

/** A result a panel could have caused. `n` makes the id (and so the position) recognisable. */
function result(n: number, over: Partial<RequestResult> = {}): RequestResult {
  return { id: `request-${n}`, action: "routing-set", plugin: "music", ok: true, at: "2026-09-21T12:00:00.000Z", ...over };
}

describe("request results (#241)", () => {
  test("a request id is 8 to 64 characters of letters, digits, underscore and hyphen", () => {
    for (const id of ["12345678", "a-b_C9Zz", "x".repeat(64)]) expect(REQUEST_ID_RE.test(id), id).toBe(true);
    for (const id of ["", "1234567", "x".repeat(65), "has space", "a/b/c/d/e/f", "quo\"te-id", "line\nbreak", "id.with.dots"]) {
      expect(REQUEST_ID_RE.test(id), JSON.stringify(id)).toBe(false);
    }
  });

  test("a file without results repairs to an empty list", () => {
    expect(repairRouting({ v: 1, plugins: {}, webhooks: {} }).results).toEqual([]);
    expect(repairRouting(good()).results).toEqual([]);
    // A `results` that is not a list is no results, and costs the rest of the file nothing.
    for (const bad of [null, "x", 5, true, {}, { 0: result(1) }]) {
      const repaired = repairRouting({ ...good(), results: bad });
      expect(repaired.results, JSON.stringify(bad)).toEqual([]);
      expect(repaired.updatedBy).toBe("admin@example.com");
    }
  });

  test("a valid result comes back as it was", () => {
    const full = result(1, { channelId: CHAN_1, reason: "no webhook is registered for that channel", ok: false });
    expect(repairRouting({ ...good(), results: [full] }).results).toEqual([full]);
    expect(repairRouting({ ...good(), results: [result(2)] }).results).toEqual([result(2)]);
  });

  test("malformed results are dropped and the list is trimmed to the newest 20", () => {
    const valid = Array.from({ length: 30 }, (_, i) => result(i));
    const junk: unknown[] = [
      null,
      "text",
      [],
      result(50, { id: "short" }),
      result(51, { id: "has space in it" }),
      result(52, { id: "x".repeat(65) }),
      { ...result(53), ok: "yes" },
      { ...result(54), action: 7 },
      { ...result(55), at: undefined },
      { ...result(56), id: undefined },
    ];
    // Junk between the valid entries, so a drop that shifts the order or the count would show.
    const raw = valid.flatMap((entry, i) => [entry, junk[i % junk.length]]);
    const repaired = repairRouting({ ...good(), results: raw }).results;
    // The number itself, not the constant: the plan and the panel's own expectation are both "20".
    expect(MAX_RESULTS).toBe(20);
    expect(repaired).toHaveLength(20);
    // The newest 20 of the 30 valid ones, oldest first.
    expect(repaired.map((r) => r.id)).toEqual(valid.slice(-MAX_RESULTS).map((r) => r.id));
  });

  test("a result's reason is clipped and unknown keys are not carried", () => {
    const repaired = repairRouting({
      ...good(),
      results: [
        {
          ...result(1),
          reason: "x".repeat(1000),
          url: "https://discord.com/api/webhooks/123456/SECRET-TOKEN-VALUE-0123456789",
          token: "SECRET-TOKEN-VALUE-0123456789",
          extra: { nested: true },
        },
      ],
    }).results;
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.reason).toHaveLength(300);
    expect(Object.keys(repaired[0]!).sort()).toEqual(["action", "at", "id", "ok", "plugin", "reason"]);
    expect(JSON.stringify(repaired)).not.toContain("SECRET-TOKEN-VALUE");
  });

  test("a result keeps its plugin and channel only when they have the right shape", () => {
    const repaired = repairRouting({
      ...good(),
      results: [
        result(1, { plugin: "Not A Plugin", channelId: "12ab", reason: 42 as unknown as string }),
        result(2, { plugin: "wow-2", channelId: CHAN_2 }),
      ],
    }).results;
    expect(repaired[0]).toEqual({ id: "request-1", action: "routing-set", ok: true, at: "2026-09-21T12:00:00.000Z" });
    expect(repaired[1]).toMatchObject({ plugin: "wow-2", channelId: CHAN_2 });
  });

  test("withResult appends and trims", () => {
    const start: RoutingFile = { ...good(), results: Array.from({ length: MAX_RESULTS }, (_, i) => result(i)) };
    const next = withResult(start, result(99));
    // Appended last, and the oldest went to make room.
    expect(next.results).toHaveLength(MAX_RESULTS);
    expect(next.results.at(-1)!.id).toBe("request-99");
    expect(next.results[0]!.id).toBe("request-1");
    // Everything else in the file is untouched, and the input is not mutated.
    expect(next.plugins).toEqual(start.plugins);
    expect(next.webhooks).toEqual(start.webhooks);
    expect(next.updatedBy).toBe(start.updatedBy);
    expect(start.results).toHaveLength(MAX_RESULTS);
    expect(start.results[0]!.id).toBe("request-0");
    // Below the cap it just appends.
    expect(withResult(freshRouting(), result(1)).results).toEqual([result(1)]);
  });

  test("withResult replaces an earlier result under the same id, so a replayed request cannot flood the list", () => {
    let file = { ...freshRouting(), results: [result(1), result(2), result(3)] };
    const replay = result(2, { ok: false, reason: "second time" });
    file = withResult(file, replay);
    // One entry for id 2, moved to the end with its newest outcome; the others are untouched and in order.
    expect(file.results.map((r) => r.id)).toEqual(["request-1", "request-3", "request-2"]);
    expect(file.results.at(-1)).toEqual(replay);
    // Twenty-five replays of one id leave one entry.
    for (let i = 0; i < 25; i += 1) file = withResult(file, result(2, { reason: `try ${i}` }));
    expect(file.results.filter((r) => r.id === "request-2")).toHaveLength(1);
    expect(file.results).toHaveLength(3);
  });

  test("clip never ends on half a surrogate pair and always returns well-formed text", () => {
    const pair = String.fromCodePoint(0x1f600); // two UTF-16 units
    const lone = String.fromCharCode(0xd83d);
    // Cut in the middle of the pair: the half is dropped.
    expect(clip("x".repeat(199) + pair, 200)).toBe("x".repeat(199));
    // Cut just after the pair: kept whole.
    expect(clip("x".repeat(198) + pair, 200)).toBe("x".repeat(198) + pair);
    // A lone surrogate in the middle becomes U+FFFD rather than surviving to break encodeURIComponent.
    const cleaned = clip(`a${lone}b`, 10);
    expect(cleaned).toBe(`a${String.fromCharCode(0xfffd)}b`);
    expect(() => encodeURIComponent(cleaned)).not.toThrow();
    // The edges of the surrogate range: the first and last HIGH surrogate at the cut are dropped, the unit
    // just below the range is kept, and a lone LOW one is replaced.
    expect(clip("x".repeat(9) + String.fromCharCode(0xd800), 10)).toBe("x".repeat(9));
    expect(clip("x".repeat(9) + String.fromCharCode(0xdbff), 10)).toBe("x".repeat(9));
    expect(clip("x".repeat(9) + String.fromCharCode(0xd7ff), 10)).toBe("x".repeat(9) + String.fromCharCode(0xd7ff));
    expect(clip("x".repeat(9) + String.fromCharCode(0xdc00), 10)).toBe("x".repeat(9) + String.fromCharCode(0xfffd));
    // Short text and the empty string come back as they were.
    expect(clip("short", 200)).toBe("short");
    expect(clip("", 5)).toBe("");
    // And a stored reason is clipped this way.
    const stored = repairRouting({ ...good(), results: [{ ...result(1), reason: "y".repeat(299) + pair }] }).results[0]!.reason!;
    expect(stored).toBe("y".repeat(299));
    expect(() => encodeURIComponent(stored)).not.toThrow();
  });
});

// #260: what the repair drops is said, by name -- see droppedByRepair.
describe("droppedByRepair (#260)", () => {
  const withPlugin = (name: string, entry: unknown) => ({ v: 1, plugins: { [name]: entry } });
  const withServer = (server: unknown, id = GUILD_A) => ({ v: 1, plugins: { music: { servers: { [id]: server } } } });
  const withWebhook = (entry: unknown, channel = CHAN_1) => ({ v: 1, webhooks: { [channel]: entry } });
  const goodHook = { id: HOOK, guildId: GUILD_A, addedAt: "2026-09-21T00:00:00.000Z", addedBy: "admin@example.com" };
  const NO_COMMANDS = `has no valid commands ("all" or a list of channel ids)`;
  // A distinctive token in a webhook URL: found in a message, it would be a leak.
  const TOKEN = "TOKENzq9f3k2m8v1w7p4r6t5y0uabcdefghij";
  const URL_WITH_TOKEN = `https://discord.com/api/webhooks/${HOOK}/${TOKEN}`;

  test("a plugin whose name is not valid", () => {
    expect(droppedByRepair(withPlugin("Music", { servers: {} }))).toEqual(["plugin Music is not a valid plugin name"]);
    expect(droppedByRepair(withPlugin("a_b", { servers: {} }))).toEqual(["plugin a_b is not a valid plugin name"]);
  });

  test("a plugin that is not an object with a servers object", () => {
    for (const entry of ["x", 7, null, [], { servers: [] }, { servers: "all" }, {}]) {
      expect(droppedByRepair(withPlugin("music", entry))).toEqual(["plugin music is not an object with a servers object"]);
    }
  });

  test("a server whose id is not a snowflake", () => {
    expect(droppedByRepair(withServer({ commands: "all" }, "main"))).toEqual(["plugin music: server main is not a server id"]);
    expect(droppedByRepair(withServer({ commands: "all" }, "1234"))).toEqual(["plugin music: server 1234 is not a server id"]);
  });

  test("a server with no valid commands", () => {
    for (const server of [{}, { commands: "none" }, { commands: [] }, { commands: [7] }, { commands: ["abc"] }, { commands: [CHAN_1, 7] }, { commands: null }, "all", 7, null, []]) {
      expect(droppedByRepair(withServer(server)), JSON.stringify(server)).toEqual([`plugin music: server ${GUILD_A} ${NO_COMMANDS}`]);
    }
  });

  test("a postTo that is not a channel id: the server entry is kept, and only that is said", () => {
    for (const postTo of [7, "x", "1234", null, {}, [], ""]) {
      const raw = withServer({ commands: "all", postTo });
      expect(droppedByRepair(raw), String(postTo)).toEqual([`plugin music: server ${GUILD_A}: postTo ${postTo === null ? "null" : Array.isArray(postTo) ? "[list]" : typeof postTo === "object" ? "[object]" : String(postTo)} is not a channel id`]);
      // The entry stays, exactly as the repair keeps it.
      expect(repairRouting(raw).plugins.music?.servers[GUILD_A]).toEqual({ commands: "all" });
    }
    // An absent postTo is not a dropped one.
    expect(droppedByRepair(withServer({ commands: "all" }))).toEqual([]);
  });

  test("a webhook whose key is not a channel id", () => {
    expect(droppedByRepair(withWebhook(goodHook, "general"))).toEqual(["webhook for general is not a channel id"]);
  });

  test("a webhook that is missing its ids", () => {
    for (const entry of ["x", null, [], {}, { ...goodHook, id: "abc" }, { ...goodHook, id: undefined }, { ...goodHook, guildId: 7 }, { ...goodHook, guildId: undefined }]) {
      expect(droppedByRepair(withWebhook(entry)), JSON.stringify(entry)).toEqual([`webhook for ${CHAN_1} is missing its ids`]);
    }
  });

  test("a webhook that is missing its addedAt or addedBy is not said to be missing its ids", () => {
    for (const entry of [{ ...goodHook, addedAt: 5 }, { ...goodHook, addedBy: undefined }, { ...goodHook, addedAt: undefined, addedBy: undefined }]) {
      expect(droppedByRepair(withWebhook(entry)), JSON.stringify(entry)).toEqual([`webhook for ${CHAN_1} is missing its addedAt or addedBy`]);
    }
  });

  test("a file with nothing wrong reports nothing", () => {
    expect(droppedByRepair(good())).toEqual([]);
    expect(droppedByRepair(freshRouting())).toEqual([]);
    // A missing file is the normal case, and so is a raw that is not an object at all.
    for (const raw of [null, undefined, 42, "routing", true, [], [good()]]) expect(droppedByRepair(raw)).toEqual([]);
    // Bookkeeping and stray keys are not configuration: none of these is reported.
    expect(droppedByRepair({ ...good(), results: [{ id: "x" }, 5, null], extra: 1, updatedAt: 5 })).toEqual([]);
    expect(droppedByRepair({ v: 1, plugins: {}, webhooks: {} })).toEqual([]);
  });

  test("a webhook entry with a stray url key reports nothing, and no message ever contains the url", () => {
    // The repair keeps the entry and drops the key, by design: that is not a dropped entry.
    const stray = { ...goodHook, url: URL_WITH_TOKEN, token: TOKEN, broken: 7 };
    expect(droppedByRepair(withWebhook(stray))).toEqual([]);
    expect(repairRouting(withWebhook(stray)).webhooks[CHAN_1]).toEqual(goodHook);
    // A dropped one that carried the url says which webhook, and nothing it held.
    const dropped = droppedByRepair(withWebhook({ url: URL_WITH_TOKEN, token: TOKEN, id: "x" }));
    expect(dropped).toEqual([`webhook for ${CHAN_1} is missing its ids`]);
    // The url everywhere a value or a key can be: nothing in any message.
    const everywhere = {
      v: 1,
      plugins: {
        [URL_WITH_TOKEN]: { servers: {} },
        music: {
          servers: {
            [URL_WITH_TOKEN]: { commands: "all" },
            [GUILD_A]: { commands: URL_WITH_TOKEN, postTo: URL_WITH_TOKEN },
            [GUILD_B]: { commands: [URL_WITH_TOKEN] },
          },
        },
        wow: URL_WITH_TOKEN,
      },
      webhooks: { [URL_WITH_TOKEN]: { url: URL_WITH_TOKEN }, [CHAN_1]: { id: URL_WITH_TOKEN, url: URL_WITH_TOKEN, guildId: URL_WITH_TOKEN } },
    };
    const messages = droppedByRepair(everywhere);
    expect(messages.length).toBeGreaterThanOrEqual(7);
    for (const message of messages) {
      // A key that is a url shows its first 37 characters (`shown`), which is before the token starts.
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(URL_WITH_TOKEN);
    }
  });

  test("a hostile key is clipped", () => {
    const key = "x".repeat(100_000);
    // (Upper case, because a run of lower-case letters is a valid plugin name.)
    expect(droppedByRepair(withPlugin(key.toUpperCase(), { servers: {} }))).toEqual([`plugin ${"X".repeat(37)}... is not a valid plugin name`]);
    expect(droppedByRepair(withServer({ commands: "all" }, key))).toEqual([`plugin music: server ${"x".repeat(37)}... is not a server id`]);
    expect(droppedByRepair(withWebhook(goodHook, key))).toEqual([`webhook for ${"x".repeat(37)}... is not a channel id`]);
    // A postTo value is clipped the same way, and a lone surrogate comes out well-formed.
    const [postTo] = droppedByRepair(withServer({ commands: "all", postTo: "y".repeat(100_000) }));
    expect(postTo).toBe(`plugin music: server ${GUILD_A}: postTo ${"y".repeat(37)}... is not a channel id`);
    const [lone] = droppedByRepair(withPlugin("Bad\ud83dName", { servers: {} }));
    expect(lone).toBe(`plugin Bad�Name is not a valid plugin name`);
    // Keys that are inherited property names are just keys: `__proto__` is not a valid plugin name and is
    // said; `constructor` is one (lower-case letters), the repair keeps it, and there is nothing to say.
    const inherited = JSON.parse('{"plugins":{"__proto__":{"servers":{}},"constructor":{"servers":{}}}}');
    expect(droppedByRepair(inherited)).toEqual(["plugin __proto__ is not a valid plugin name"]);
    expect(Object.keys(repairRouting(inherited).plugins)).toEqual(["constructor"]);
  });

  test("it never throws, whatever it is given", () => {
    for (const raw of [{ plugins: { music: { servers: { [GUILD_A]: { commands: { get x() { throw new Error("no"); } } } } } } }, { plugins: null, webhooks: 5 }, JSON.parse('{"plugins":{"music":{"servers":{"1":null}}}}')]) {
      expect(() => droppedByRepair(raw)).not.toThrow();
    }
  });

  describe("droppedByRepair and repairRouting agree on every fixture", () => {
    /**
     * An oracle that does not look at droppedByRepair: what `repairRouting` LEFT OUT, worked out by comparing
     * its output with the raw file. A plugin that is gone; a server that is gone from a plugin that is kept; a
     * postTo lost from a server that is kept; a webhook that is gone. (A dropped plugin's servers are not
     * counted separately: the plugin is the thing dropped.)
     */
    function leftOut(raw: unknown): string[] {
      const out: string[] = [];
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
      const file = raw as { plugins?: unknown; webhooks?: unknown };
      const repaired = repairRouting(raw);
      const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
      if (isObject(file.plugins)) {
        for (const [name, entry] of Object.entries(file.plugins)) {
          const kept = Object.hasOwn(repaired.plugins, name) ? repaired.plugins[name] : undefined;
          if (kept === undefined) {
            out.push(name);
            continue;
          }
          for (const [id, server] of Object.entries((entry as { servers: Record<string, unknown> }).servers)) {
            const keptServer = Object.hasOwn(kept.servers, id) ? kept.servers[id] : undefined;
            if (keptServer === undefined) out.push(id);
            else if (isObject(server) && server.postTo !== undefined && keptServer.postTo === undefined) out.push(id);
          }
        }
      }
      if (isObject(file.webhooks)) {
        for (const channel of Object.keys(file.webhooks)) if (!Object.hasOwn(repaired.webhooks, channel)) out.push(channel);
      }
      return out;
    }

    const A = GUILD_A;
    const fixtures: [string, unknown][] = [
      ["a valid file", good()],
      ["an empty file", {}],
      ["a fresh file", freshRouting()],
      ["a bad plugin name", { plugins: { Music: { servers: {} }, wow: { servers: {} } } }],
      ["an underscore plugin name", { plugins: { a_b: { servers: {} } } }],
      ["plugins that are not objects", { plugins: { music: "x", wow: 7, x1: null, x2: [], x3: { servers: [] } } }],
      ["a server id that is not a snowflake", { plugins: { music: { servers: { main: { commands: "all" }, [A]: { commands: "all" } } } } }],
      ["a 4-digit server id", { plugins: { music: { servers: { "1234": { commands: "all" } } } } }],
      ["a 26-digit server id", { plugins: { music: { servers: { ["1".repeat(26)]: { commands: "all" } } } } }],
      ["a 5-digit server id", { plugins: { music: { servers: { "12345": { commands: "all" } } } } }],
      ["a 25-digit server id", { plugins: { music: { servers: { ["1".repeat(25)]: { commands: "all" } } } } }],
      ["commands: every bad shape at once", { plugins: { music: { servers: { [A]: { commands: "none" }, [GUILD_B]: { commands: [] }, "333333333333333333": { commands: [7] }, "444444444444444444": { commands: ["abc"] }, "555555555555555555": {} } } } }],
      ["commands: a mixed list", { plugins: { music: { servers: { [A]: { commands: [CHAN_1, 7] } } } } }],
      ["commands: a 4-digit channel", { plugins: { music: { servers: { [A]: { commands: ["1234"] } } } } }],
      ["a server entry that is not an object", { plugins: { music: { servers: { [A]: "all", [GUILD_B]: null, "333333333333333333": [] } } } }],
      ["a bad postTo beside good commands", { plugins: { music: { servers: { [A]: { commands: "all", postTo: 7 } } } } }],
      ["a 4-digit postTo", { plugins: { music: { servers: { [A]: { commands: "all", postTo: "1234" } } } } }],
      ["a null postTo", { plugins: { music: { servers: { [A]: { commands: "all", postTo: null } } } } }],
      ["a good postTo", { plugins: { music: { servers: { [A]: { commands: "all", postTo: CHAN_1 } } } } }],
      ["a webhook with a bad key", { webhooks: { general: goodHook, [CHAN_1]: goodHook } }],
      ["a webhook keyed by a 4-digit channel id", { webhooks: { "1234": goodHook } }],
      ["a webhook keyed by a 5-digit channel id", { webhooks: { "12345": goodHook } }],
      ["a webhook keyed by a 19-digit channel id", { webhooks: { ["1".repeat(19)]: goodHook } }],
      ["a webhook keyed by a 25-digit channel id", { webhooks: { ["1".repeat(25)]: goodHook } }],
      ["a webhook keyed by a 26-digit channel id", { webhooks: { ["1".repeat(26)]: goodHook } }],
      ["a webhook that is not an object", { webhooks: { [CHAN_1]: "x", [CHAN_2]: null, "333333333333333333": [] } }],
      ["a webhook with a bad id", { webhooks: { [CHAN_1]: { ...goodHook, id: "abc" } } }],
      ["a webhook with a 4-digit id", { webhooks: { [CHAN_1]: { ...goodHook, id: "1234" } } }],
      ["a webhook with a bad guildId", { webhooks: { [CHAN_1]: { ...goodHook, guildId: 7 } } }],
      ["a webhook with no addedAt", { webhooks: { [CHAN_1]: { ...goodHook, addedAt: undefined } } }],
      ["a webhook with a numeric addedBy", { webhooks: { [CHAN_1]: { ...goodHook, addedBy: 7 } } }],
      ["a webhook with stray keys and a non-string broken", { webhooks: { [CHAN_1]: { ...goodHook, url: URL_WITH_TOKEN, token: TOKEN, broken: 7 } } }],
      ["a webhook with a string broken", { webhooks: { [CHAN_1]: { ...goodHook, broken: "gone" } } }],
      ["everything wrong at once", { plugins: { Bad: {}, music: { servers: { x: {}, [A]: { commands: [], postTo: 1 } } } }, webhooks: { y: {}, [CHAN_1]: {} }, results: [null] }],
      ["plugins and webhooks that are not objects (outside the kinds it reports)", { plugins: [], webhooks: "x" }],
    ];

    for (const [label, raw] of fixtures) {
      test(label, () => {
        const said = droppedByRepair(raw);
        const gone = leftOut(raw);
        // Something is said exactly when the repair left something out, and once for each.
        expect(said.length).toBe(gone.length);
        for (const key of gone) expect(said.some((message) => message.includes(shownKey(key))), key).toBe(true);
      });
    }
    /** How a key appears in a message: as `shown` writes it. */
    function shownKey(key: string): string {
      return key.length <= 40 ? key : `${key.slice(0, 37)}...`;
    }
  });
});

describe("repairSecrets", () => {
  test("a valid file comes back unchanged, and as a new object", () => {
    const input = { v: 1 as const, webhooks: { [CHAN_1]: "https://example.invalid/hook/1" } };
    const repaired = repairSecrets(input);
    expect(repaired).toEqual(input);
    expect(repaired).not.toBe(input);
    expect(repaired.webhooks).not.toBe(input.webhooks);
  });

  test("anything that is not an object with a webhooks object is fresh", () => {
    for (const raw of [null, undefined, 5, "x", [], { v: 1 }, { v: 1, webhooks: [] }, { v: 1, webhooks: "x" }, { webhooks: null }]) {
      expect(repairSecrets(raw)).toEqual(freshSecrets());
    }
  });

  test("a secrets file's own version is not consulted either -- its URLs survive", () => {
    // Discarding a v: 2 or version-less file whole would destroy the only copy of every webhook URL.
    const webhooks = { [CHAN_1]: "https://example.invalid/hook/1" };
    for (const v of [undefined, 0, 2, "1", null]) {
      expect(repairSecrets({ v, webhooks })).toEqual({ v: 1, webhooks });
    }
    expect(repairSecrets({ webhooks })).toEqual({ v: 1, webhooks });
  });

  test("only channel id to non-empty string pairs survive", () => {
    const repaired = repairSecrets({
      v: 1,
      webhooks: { [CHAN_1]: "https://example.invalid/a", [CHAN_2]: "", "333333333333333333": 42, "333333333333333334": null, notachannel: "https://example.invalid/b" },
    });
    expect(repaired.webhooks).toEqual({ [CHAN_1]: "https://example.invalid/a" });
  });

  test("is not fooled by prototype keys, and drops unknown keys", () => {
    const repaired = repairSecrets(
      JSON.parse(`{"v":1,"extra":1,"webhooks":{"__proto__":"https://example.invalid/x","constructor":"y","${CHAN_1}":"https://example.invalid/a"}}`),
    );
    expect(repaired).toEqual({ v: 1, webhooks: { [CHAN_1]: "https://example.invalid/a" } });
    expect(Object.getPrototypeOf(repaired.webhooks)).toBe(Object.prototype);
  });
});
