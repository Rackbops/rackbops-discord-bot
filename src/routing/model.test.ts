import { describe, expect, test } from "bun:test";
import {
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
    expect(repaired).toHaveLength(MAX_RESULTS);
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
