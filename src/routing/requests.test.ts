import { describe, expect, spyOn, test } from "bun:test";
import {
  freshRouting,
  freshSecrets,
  repairRouting,
  repairSecrets,
  type DiscoveryFile,
  type DiscoveryGuild,
  type RoutingFile,
  type RoutingSecretsFile,
} from "./model";
import {
  applyRoutingRequest,
  liveFetchWebhook,
  parseRoutingRequest,
  redactWebhookUrls,
  requestIdOf,
  ROUTING_ACTIONS,
  RoutingRefusal,
  WEBHOOK_URL_RE,
  type RoutingRequest,
  type RoutingRequestDeps,
  type WebhookLookup,
} from "./requests";

const HOME = "111111111111111111";
const OTHER = "222222222222222222";
const STRANGER = "999999999999999999";
const CH_HOME = "333333333333333331";
const CH_HOME_2 = "333333333333333332";
const CH_OTHER = "444444444444444441";
const WH_ID = "555555555555555555";
const TOKEN = "TOKEN_abcdefghij0123456789xyz";
const URL_OK = `https://discord.com/api/webhooks/${WH_ID}/${TOKEN}`;
const NOW = new Date("2026-09-21T12:00:00.000Z");
const ME = "admin@example.com";

function guild(id: string, name: string, channels: string[]): DiscoveryGuild {
  return { id, name, channels: channels.map((c) => ({ id: c, name: `chan-${c.slice(-2)}`, canSend: true })), commands: null };
}

function discoveryOf(...guilds: DiscoveryGuild[]): DiscoveryFile {
  return {
    v: 1,
    generatedAt: NOW.toISOString(),
    bot: { id: "900000000000000000", username: "Setlist Bot" },
    inviteUrl: "https://discord.com/oauth2/authorize?client_id=900000000000000000",
    homeGuildId: HOME,
    guilds,
    plugins: {},
  };
}

const bothServers = () => discoveryOf(guild(HOME, "Home", [CH_HOME, CH_HOME_2]), guild(OTHER, "Other", [CH_OTHER]));
const homeOnly = () => discoveryOf(guild(HOME, "Home", [CH_HOME, CH_HOME_2]));

const FOUND: WebhookLookup = { ok: true, id: WH_ID, channelId: CH_HOME, guildId: HOME };

/**
 * Deps over in-memory files. `mutate*` emulate the store (repair on the way in AND out) but also record
 * what the callback RETURNED before that repair -- what the code under test chose to write, which the
 * store's own repair would otherwise hide.
 */
function harness(
  opts: {
    discovery?: DiscoveryFile | null;
    afterRefresh?: DiscoveryFile | null;
    lookup?: WebhookLookup;
    applyFails?: unknown;
    routing?: RoutingFile;
    secrets?: RoutingSecretsFile;
    /** mutateRouting throws this (after being asked, before anything is written). */
    routingFails?: unknown;
    /** the Nth mutateSecrets call (1-based) throws this. */
    secretsFailOnCall?: { call: number; error: unknown };
  } = {},
) {
  let discovery = opts.discovery === undefined ? bothServers() : opts.discovery;
  let routing = opts.routing ?? freshRouting();
  let secrets = opts.secrets ?? freshSecrets();
  const events: string[] = [];
  const warns: string[] = [];
  let secretsCalls = 0;
  const routingWrites: RoutingFile[] = [];
  const secretsWrites: RoutingSecretsFile[] = [];
  const lookups: { id: string; token: string }[] = [];
  const deps: RoutingRequestDeps = {
    readDiscovery: async () => discovery,
    readRouting: async () => structuredClone(routing),
    readSecrets: async () => structuredClone(secrets),
    mutateRouting: async (mutate) => {
      events.push("mutateRouting");
      if (opts.routingFails !== undefined) throw opts.routingFails;
      const written = mutate(repairRouting(routing));
      routingWrites.push(written);
      routing = repairRouting(written);
    },
    mutateSecrets: async (mutate) => {
      events.push("mutateSecrets");
      secretsCalls += 1;
      if (opts.secretsFailOnCall?.call === secretsCalls) throw opts.secretsFailOnCall.error;
      const written = mutate(repairSecrets(secrets));
      secretsWrites.push(written);
      secrets = repairSecrets(written);
    },
    fetchWebhook: async (id, token) => {
      events.push("fetchWebhook");
      lookups.push({ id, token });
      return opts.lookup ?? FOUND;
    },
    applyRouting: async (reason) => {
      events.push(`applyRouting ${reason}`);
      if (opts.applyFails !== undefined) throw opts.applyFails;
      return {};
    },
    refreshDiscovery: async () => {
      events.push("refreshDiscovery");
      if (opts.afterRefresh !== undefined) discovery = opts.afterRefresh;
    },
    now: () => NOW,
    log: { warn: (...args: unknown[]) => void warns.push(args.map(String).join(" ")) },
  };
  return {
    deps,
    events,
    warns,
    routingWrites,
    secretsWrites,
    lookups,
    get routing() {
      return routing;
    },
    get secrets() {
      return secrets;
    },
  };
}

function must(raw: unknown): RoutingRequest {
  const parsed = parseRoutingRequest(raw);
  if (!parsed.ok) throw new Error(`test request did not parse: ${parsed.reason}`);
  return parsed.request;
}

const setRequest = (over: Record<string, unknown> = {}) =>
  must({ action: "routing-set", plugin: "music", servers: { [HOME]: { commands: "all" } }, requestedBy: ME, ...over });
const addRequest = (over: Record<string, unknown> = {}) => must({ action: "webhook-add", url: URL_OK, requestedBy: ME, ...over });
const removeRequest = (over: Record<string, unknown> = {}) => must({ action: "webhook-remove", channelId: CH_HOME, requestedBy: ME, ...over });

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(RoutingRefusal);
    return (err as Error).message;
  }
  throw new Error("expected a refusal, got success");
}

const routingWithWebhook = (extra: Partial<RoutingFile["webhooks"][string]> = {}): RoutingFile => ({
  ...freshRouting(),
  webhooks: { [CH_HOME]: { id: "666666666666666666", guildId: HOME, addedAt: "t", addedBy: "old", ...extra } },
});

// ---------------------------------------------------------------------------------------------------

describe("the constants", () => {
  test("the routing actions are exactly the four", () => {
    expect([...ROUTING_ACTIONS].sort()).toEqual(["discovery-refresh", "routing-set", "webhook-add", "webhook-remove"]);
  });

  test("the webhook url shape: discord.com and discordapp.com, canary and ptb, versioned or not, https only", () => {
    for (const host of ["discord.com", "canary.discord.com", "ptb.discord.com", "discordapp.com", "canary.discordapp.com"]) {
      for (const version of ["", "/v9", "/v10"]) {
        const url = `https://${host}/api${version}/webhooks/${WH_ID}/${TOKEN}`;
        const m = WEBHOOK_URL_RE.exec(url);
        expect(m?.[1], url).toBe(WH_ID);
        expect(m?.[2], url).toBe(TOKEN);
      }
    }
    for (const bad of [
      `http://discord.com/api/webhooks/${WH_ID}/${TOKEN}`,
      `https://evil.example/api/webhooks/${WH_ID}/${TOKEN}`,
      `https://discord.com.evil.example/api/webhooks/${WH_ID}/${TOKEN}`,
      `https://discord.com/api/webhooks/${WH_ID}`,
      `https://discord.com/api/webhooks/${WH_ID}/short`,
      `https://discord.com/api/webhooks/${WH_ID}/${TOKEN}?wait=true`,
      `https://discord.com/api/webhooks/${WH_ID}/${TOKEN}/`,
      ` https://discord.com/api/webhooks/${WH_ID}/${TOKEN}`,
      `https://discord.com/api/webhooks/${WH_ID}/${TOKEN}\n`,
      `https://discord.com/api/webhooks/abc/${TOKEN}`,
    ]) {
      expect(WEBHOOK_URL_RE.test(bad), bad).toBe(false);
    }
  });
});

describe("the id and token in a webhook url", () => {
  test("an id is 5 to 25 digits and a token 20 or more of letters, digits, underscore and hyphen", () => {
    const url = (id: string, token: string) => `https://discord.com/api/webhooks/${id}/${token}`;
    for (const id of ["12345", "1".repeat(25)]) expect(WEBHOOK_URL_RE.test(url(id, TOKEN)), id).toBe(true);
    for (const id of ["1234", "1".repeat(26), ""]) expect(WEBHOOK_URL_RE.test(url(id, TOKEN)), id).toBe(false);
    for (const token of ["a".repeat(20), "a".repeat(200), "A-b_C".repeat(8)]) expect(WEBHOOK_URL_RE.test(url(WH_ID, token)), token).toBe(true);
    for (const token of ["a".repeat(19), "a".repeat(20) + ".", "a".repeat(20) + "?x=1", "a b".repeat(10)]) {
      expect(WEBHOOK_URL_RE.test(url(WH_ID, token)), token).toBe(false);
    }
  });
});

describe("parseRoutingRequest", () => {
  const reasonOf = (raw: unknown): string | undefined => {
    const parsed = parseRoutingRequest(raw);
    return parsed.ok ? undefined : parsed.reason;
  };

  test("a value that is not an object is refused: not an object", () => {
    for (const raw of [null, undefined, "routing-set", 5, true, [], [{ action: "routing-set" }]]) {
      expect(reasonOf(raw), JSON.stringify(raw)).toBe("not an object");
    }
  });

  test("an action that is not a routing action is refused", () => {
    for (const action of [undefined, null, 5, "skip", "update-now", "ROUTING-SET", "routing-set ", {}]) {
      expect(reasonOf({ action, requestedBy: ME }), JSON.stringify(action)).toBe("not a routing action");
    }
  });

  test("a missing or empty requestedBy is refused: missing requestedBy", () => {
    for (const requestedBy of [undefined, null, "", 5, {}, ["x"]]) {
      expect(reasonOf({ action: "discovery-refresh", requestedBy }), JSON.stringify(requestedBy)).toBe("missing requestedBy");
    }
    expect(reasonOf({ action: "discovery-refresh" })).toBe("missing requestedBy");
  });

  test("requestedBy is kept, clipped to 200 characters", () => {
    const parsed = parseRoutingRequest({ action: "discovery-refresh", requestedBy: "x".repeat(500) });
    expect(parsed.ok && parsed.request.requestedBy).toBe("x".repeat(200));
  });

  test("requestedBy never carries a webhook url onward: it lands in routing.json", () => {
    const parsed = parseRoutingRequest({ action: "discovery-refresh", requestedBy: `me ${URL_OK}` });
    expect(parsed.ok && parsed.request.requestedBy).toBe("me [webhook url]");
    // A url that a clip would have cut in half is redacted first, so no fragment of the token remains.
    const clipped = parseRoutingRequest({ action: "discovery-refresh", requestedBy: `${"x".repeat(180)} ${URL_OK}` });
    expect(clipped.ok && clipped.request.requestedBy).not.toContain("TOKEN_");
    expect(clipped.ok && clipped.request.requestedBy).toBe(`${"x".repeat(180)} [webhook url]`);
  });

  test("for a webhook-add the token is scrubbed from requestedBy and id, in whatever shape it sits", () => {
    // Not a url at all, just the token where a name should be; and a shape no url pattern knows.
    const parsed = parseRoutingRequest({
      action: "webhook-add",
      url: URL_OK,
      requestedBy: `admin ${TOKEN} via https://discord.com:443/api/webhooks/${WH_ID}/${TOKEN}?x=1`,
      id: TOKEN,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // (The request itself carries the url it is about to be applied with; what is stored is requestedBy
    // and the id.)
    expect(parsed.request.requestedBy).not.toContain(TOKEN);
    // The id was the token: it is dropped, not fatal, and the request carries none.
    expect("id" in parsed.request).toBe(false);
    expect(parsed.request.requestedBy).toContain("admin ");
    // An id that merely resembles one is kept.
    const kept = parseRoutingRequest({ action: "webhook-add", url: URL_OK, requestedBy: ME, id: "req_12345678" });
    expect(kept.ok && kept.request.id).toBe("req_12345678");
  });

  test("requestedBy is only scanned so far, and a url cut short by that is still redacted", () => {
    const parsed = parseRoutingRequest({ action: "discovery-refresh", requestedBy: "x".repeat(4060) + URL_OK });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Clipped to 200; nothing of the url survives in what is stored.
    expect(parsed.request.requestedBy).toBe("x".repeat(200));
    // And when the cut falls inside the url, what is left of it is still removed.
    const inside = parseRoutingRequest({ action: "discovery-refresh", requestedBy: "y".repeat(4070) + URL_OK });
    expect(inside.ok && inside.request.requestedBy).toBe("y".repeat(200));
    const short = parseRoutingRequest({ action: "discovery-refresh", requestedBy: `${"z".repeat(100)} ${URL_OK}` });
    expect(short.ok && short.request.requestedBy).toBe(`${"z".repeat(100)} [webhook url]`);
  });

  test("requestedBy is well-formed text: a clip never ends on half a surrogate pair", () => {
    const pair = String.fromCodePoint(0x1f600);
    const parsed = parseRoutingRequest({ action: "discovery-refresh", requestedBy: "a".repeat(199) + pair });
    expect(parsed.ok && parsed.request.requestedBy).toBe("a".repeat(199));
    const lone = parseRoutingRequest({ action: "discovery-refresh", requestedBy: `a${String.fromCharCode(0xd83d)}b` });
    expect(lone.ok && lone.request.requestedBy).toBe(`a${String.fromCharCode(0xfffd)}b`);
  });

  test("routing-set: a bad plugin name is refused: bad plugin name", () => {
    for (const plugin of [undefined, null, 5, "", "Music", "1abc", "a_b", "a b", "../x", "__proto__", "x".repeat(10) + "!"]) {
      expect(reasonOf({ action: "routing-set", plugin, servers: {}, requestedBy: ME }), JSON.stringify(plugin)).toBe("bad plugin name");
    }
  });

  test("routing-set checks only the SHAPE of the plugin name: a plugin may be placed before it is enabled", () => {
    const parsed = parseRoutingRequest({ action: "routing-set", plugin: "not-installed-yet", servers: {}, requestedBy: ME });
    expect(parsed.ok).toBe(true);
  });

  test("routing-set: servers that is not an object is refused, in the validator's own words", () => {
    for (const servers of [undefined, null, [], "x", 5, true]) {
      expect(reasonOf({ action: "routing-set", plugin: "music", servers, requestedBy: ME }), JSON.stringify(servers)).toBe(
        "routing must be an object with a servers object",
      );
    }
  });

  test("routing-set: a well-formed request parses, and `servers` is top-level (there is no routing wrapper)", () => {
    const servers = { [HOME]: { commands: "all" } };
    expect(parseRoutingRequest({ action: "routing-set", plugin: "music", servers, requestedBy: ME })).toEqual({
      ok: true,
      request: { action: "routing-set", plugin: "music", servers, requestedBy: ME },
    });
    // The shape a panel might get wrong is refused rather than guessed at.
    expect(reasonOf({ action: "routing-set", plugin: "music", routing: { servers }, requestedBy: ME })).toBe(
      "routing must be an object with a servers object",
    );
  });

  test("webhook-add: a bad webhook url is refused: bad webhook url", () => {
    for (const url of [undefined, null, 5, "", "hello", `http://discord.com/api/webhooks/${WH_ID}/${TOKEN}`, `https://example.com/api/webhooks/${WH_ID}/${TOKEN}`]) {
      expect(reasonOf({ action: "webhook-add", url, requestedBy: ME }), JSON.stringify(url)).toBe("bad webhook url");
    }
    expect(parseRoutingRequest({ action: "webhook-add", url: URL_OK, requestedBy: ME })).toEqual({
      ok: true,
      request: { action: "webhook-add", url: URL_OK, requestedBy: ME },
    });
  });

  test("webhook-remove: a bad channel id is refused: bad channel id", () => {
    for (const channelId of [undefined, null, 5, "", "abc", "1234", "1".repeat(26), "12ab34567", `${CH_HOME} `]) {
      expect(reasonOf({ action: "webhook-remove", channelId, requestedBy: ME }), JSON.stringify(channelId)).toBe("bad channel id");
    }
    expect(parseRoutingRequest({ action: "webhook-remove", channelId: CH_HOME, requestedBy: ME }).ok).toBe(true);
  });

  test("discovery-refresh needs only a requestedBy", () => {
    expect(parseRoutingRequest({ action: "discovery-refresh", requestedBy: ME })).toEqual({
      ok: true,
      request: { action: "discovery-refresh", requestedBy: ME },
    });
  });

  test("an id that is well-formed is kept", () => {
    const parsed = parseRoutingRequest({ action: "discovery-refresh", requestedBy: ME, id: "req_12345678" });
    expect(parsed.ok && parsed.request.id).toBe("req_12345678");
    expect(requestIdOf({ id: "req_12345678" })).toBe("req_12345678");
  });

  test("an id that is malformed is dropped, not fatal", () => {
    for (const id of [undefined, null, 5, "", "short", "x".repeat(65), "has space", "quo\"te-id", "../../etc/x", {}, ["req_12345678"]]) {
      const parsed = parseRoutingRequest({ action: "discovery-refresh", requestedBy: ME, id });
      expect(parsed.ok, JSON.stringify(id)).toBe(true);
      expect(parsed.ok && "id" in parsed.request, JSON.stringify(id)).toBe(false);
      expect(requestIdOf({ id })).toBeUndefined();
    }
    expect(requestIdOf(null)).toBeUndefined();
    expect(requestIdOf("req_12345678")).toBeUndefined();
  });

  test("a deeply nested value in any field is refused without throwing", () => {
    const nest = (kind: "array" | "object"): unknown => {
      let value: unknown = "leaf";
      for (let i = 0; i < 100_000; i += 1) value = kind === "array" ? [value] : { next: value };
      return value;
    };
    for (const kind of ["array", "object"] as const) {
      const deep = nest(kind);
      for (const field of ["action", "requestedBy", "plugin", "url", "channelId", "id"]) {
        for (const action of ["routing-set", "webhook-add", "webhook-remove", "discovery-refresh"]) {
          const raw = { action, plugin: "music", servers: {}, url: URL_OK, channelId: CH_HOME, requestedBy: ME, [field]: deep };
          expect(() => parseRoutingRequest(raw), `${kind} in ${field} of ${action}`).not.toThrow();
          expect(() => requestIdOf(raw)).not.toThrow();
        }
      }
      // In `servers` it is a plain object holding something deep: shape-valid here, and the validator that
      // reads it later never walks into it either.
      expect(() => parseRoutingRequest({ action: "routing-set", plugin: "music", servers: { [HOME]: deep }, requestedBy: ME })).not.toThrow();
    }
  });

  test("a bad webhook url is refused without echoing any of it", () => {
    const secretish = "SECRETISH-TOKEN-VALUE-0123456789-ABCDEFGH";
    for (const url of [
      `http://discord.com/api/webhooks/${WH_ID}/${secretish}`,
      `https://example.com/api/webhooks/${WH_ID}/${secretish}`,
      `https://discord.com/api/webhooks/${WH_ID}/${secretish}?wait=true`,
      `not a url but it has ${secretish} in it`,
      secretish,
    ]) {
      const parsed = parseRoutingRequest({ action: "webhook-add", url, requestedBy: ME });
      expect(parsed).toEqual({ ok: false, reason: "bad webhook url" });
      // No part of the value, not even its length.
      expect(JSON.stringify(parsed)).not.toContain(secretish);
      expect(JSON.stringify(parsed)).not.toContain(String(url.length));
    }
  });
});

describe("applyRoutingRequest: routing-set", () => {
  test("routing-set writes the validator's clean value, stamps updatedBy, then applies", async () => {
    const h = harness();
    const request = setRequest({ servers: { [HOME]: { commands: "all", note: "x", token: "secretish" }, [OTHER]: { commands: [CH_OTHER], postTo: CH_OTHER } } });
    const result = await applyRoutingRequest(request, h.deps);

    expect(result).toEqual({});
    // Written before the registration, which reads what was just written...
    expect(h.events).toEqual(["mutateRouting", "applyRouting routing-set music"]);
    // ...and what was written is the validator's clean value: no unknown key rode through. (Asserted on
    // what the callback RETURNED, before the store's own repair could hide it.)
    expect(h.routingWrites).toHaveLength(1);
    expect(h.routingWrites[0]!.plugins.music).toEqual({
      servers: { [HOME]: { commands: "all" }, [OTHER]: { commands: [CH_OTHER], postTo: CH_OTHER } },
    });
    expect(JSON.stringify(h.routingWrites[0])).not.toContain("secretish");
    expect(h.routingWrites[0]!.updatedBy).toBe(ME);
    expect(h.routingWrites[0]!.updatedAt).toBe(NOW.toISOString());
  });

  test("routing-set replaces only that plugin's entry", async () => {
    const before: RoutingFile = { ...freshRouting(), plugins: { wow: { servers: { [HOME]: { commands: "all" } } } } };
    const h = harness({ routing: before });
    await applyRoutingRequest(setRequest(), h.deps);
    expect(Object.keys(h.routing.plugins).sort()).toEqual(["music", "wow"]);
    expect(h.routing.plugins.wow).toEqual(before.plugins.wow!);
  });

  test("routing-set may place a plugin that is not loaded", async () => {
    // Discovery lists no plugins at all here; a plugin may be placed before it is enabled.
    const h = harness({ discovery: bothServers() });
    await applyRoutingRequest(setRequest({ plugin: "not-installed-yet" }), h.deps);
    expect(h.routing.plugins["not-installed-yet"]).toEqual({ servers: { [HOME]: { commands: "all" } } });
  });

  test("routing-set with no servers places the plugin nowhere, which is a placement", async () => {
    const h = harness();
    await applyRoutingRequest(setRequest({ servers: {} }), h.deps);
    expect(h.routing.plugins.music).toEqual({ servers: {} });
  });

  test("a server missing from discovery is looked for once more after a refresh, then refused", async () => {
    const h = harness({ discovery: homeOnly(), afterRefresh: homeOnly() });
    const reason = await refusalOf(applyRoutingRequest(setRequest({ servers: { [OTHER]: { commands: "all" } } }), h.deps));
    expect(reason).toBe(`server ${OTHER} is not one the bot is in`);
    // Refreshed exactly once, and nothing was written or registered.
    expect(h.events).toEqual(["refreshDiscovery"]);
  });

  test("a server missing from discovery is accepted when the refresh finds it", async () => {
    const h = harness({ discovery: homeOnly(), afterRefresh: bothServers() });
    await applyRoutingRequest(setRequest({ servers: { [OTHER]: { commands: "all" } } }), h.deps);
    expect(h.events).toEqual(["refreshDiscovery", "mutateRouting", "applyRouting routing-set music"]);
    expect(h.routing.plugins.music).toEqual({ servers: { [OTHER]: { commands: "all" } } });
  });

  test("a request that discovery already accepts does not refresh at all", async () => {
    const h = harness();
    await applyRoutingRequest(setRequest(), h.deps);
    expect(h.events).not.toContain("refreshDiscovery");
  });

  test("with no discovery at all the request is refused", async () => {
    const h = harness({ discovery: null, afterRefresh: null });
    const reason = await refusalOf(applyRoutingRequest(setRequest(), h.deps));
    expect(reason).toBe("the bot has not published what it can see yet");
    expect(h.events).toEqual(["refreshDiscovery"]);
  });

  test("with no discovery, a refresh that produces it lets the request through", async () => {
    const h = harness({ discovery: null, afterRefresh: bothServers() });
    await applyRoutingRequest(setRequest(), h.deps);
    expect(h.events).toEqual(["refreshDiscovery", "mutateRouting", "applyRouting routing-set music"]);
  });

  test("a channel that does not belong to its server is refused, naming the channel", async () => {
    const h = harness();
    const reason = await refusalOf(applyRoutingRequest(setRequest({ servers: { [HOME]: { commands: [CH_OTHER] } } }), h.deps));
    expect(reason).toBe(`channel ${CH_OTHER} is not in server ${HOME}`);
    expect(h.routingWrites).toEqual([]);
  });

  test("a discovery.json damaged where readDiscovery cannot see is looked at again after a refresh", async () => {
    // A guild that is not an object: `readDiscovery` only checks that there is a list. Validating against
    // it throws, which is the same as a stale file -- refresh, then look again.
    const damaged = { ...bothServers(), guilds: [null as never] };
    const h = harness({ discovery: damaged, afterRefresh: bothServers() });
    await applyRoutingRequest(setRequest(), h.deps);
    expect(h.events).toEqual(["refreshDiscovery", "mutateRouting", "applyRouting routing-set music"]);
    expect(h.routing.plugins.music).toBeDefined();
  });

  test("a discovery.json that is still damaged after the refresh is a fault, not a refusal", async () => {
    const damaged = { ...bothServers(), guilds: [null as never] };
    const h = harness({ discovery: damaged, afterRefresh: damaged });
    const failure = await applyRoutingRequest(setRequest(), h.deps).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(RoutingRefusal);
    expect(h.routingWrites).toEqual([]);
  });

  test("a re-registration that fails does not fail the request", async () => {
    const h = harness({ applyFails: new Error("Missing Access") });
    await expect(applyRoutingRequest(setRequest(), h.deps)).resolves.toEqual({});
    // The change is applied: routing.json was written before the registration was tried.
    expect(h.routing.plugins.music).toBeDefined();
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toContain("routing-set music");
    expect(h.warns[0]).toContain("Missing Access");
  });

  test("a failing re-registration's message is redacted before it is logged", async () => {
    const h = harness({ applyFails: new Error(`bad thing at ${URL_OK}`) });
    await applyRoutingRequest(setRequest(), h.deps);
    expect(h.warns.join("\n")).not.toContain(TOKEN);
    expect(h.warns[0]).toContain("[webhook url]");
  });
});

describe("applyRoutingRequest: webhook-add", () => {
  test("webhook-add writes the secret before the metadata", async () => {
    const h = harness();
    const result = await applyRoutingRequest(addRequest(), h.deps);
    expect(result).toEqual({ channelId: CH_HOME });
    expect(h.events).toEqual(["fetchWebhook", "mutateSecrets", "mutateRouting"]);
    expect(h.routing.webhooks[CH_HOME]).toEqual({ id: WH_ID, guildId: HOME, addedAt: NOW.toISOString(), addedBy: ME });
    expect(h.routing.updatedBy).toBe(ME);
    // Nothing that names the URL is in routing.json.
    expect(JSON.stringify(h.routingWrites)).not.toContain(TOKEN);
    expect(JSON.stringify(h.routing)).not.toContain(TOKEN);
  });

  test("webhook-add stores the canonical url", async () => {
    const h = harness();
    await applyRoutingRequest(addRequest({ url: `https://canary.discordapp.com/api/v9/webhooks/${WH_ID}/${TOKEN}` }), h.deps);
    expect(h.secrets.webhooks[CH_HOME]).toBe(`https://discord.com/api/webhooks/${WH_ID}/${TOKEN}`);
  });

  test("webhook-add asks Discord about the id and token in the pasted url", async () => {
    const h = harness();
    await applyRoutingRequest(addRequest(), h.deps);
    expect(h.lookups).toEqual([{ id: WH_ID, token: TOKEN }]);
  });

  test("webhook-add for a channel that has one replaces it and clears broken", async () => {
    const h = harness({
      routing: routingWithWebhook({ broken: "Unknown Webhook" }),
      secrets: { ...freshSecrets(), webhooks: { [CH_HOME]: "https://discord.com/api/webhooks/666666666666666666/OLDTOKEN0123456789abcdef" } },
    });
    await applyRoutingRequest(addRequest(), h.deps);
    expect(h.routing.webhooks[CH_HOME]).toEqual({ id: WH_ID, guildId: HOME, addedAt: NOW.toISOString(), addedBy: ME });
    expect(Object.keys(h.routing.webhooks)).toEqual([CH_HOME]);
    expect(h.secrets.webhooks[CH_HOME]).toBe(URL_OK);
    expect(Object.keys(h.secrets.webhooks)).toEqual([CH_HOME]);
  });

  test("webhook-add leaves the webhooks of other channels alone", async () => {
    const h = harness({
      routing: { ...freshRouting(), webhooks: { [CH_OTHER]: { id: "666666666666666666", guildId: OTHER, addedAt: "t", addedBy: "old" } } },
      secrets: { ...freshSecrets(), webhooks: { [CH_OTHER]: "https://discord.com/api/webhooks/666666666666666666/OTHERTOKEN0123456789abcd" } },
    });
    await applyRoutingRequest(addRequest(), h.deps);
    expect(Object.keys(h.routing.webhooks).sort()).toEqual([CH_HOME, CH_OTHER]);
    expect(Object.keys(h.secrets.webhooks).sort()).toEqual([CH_HOME, CH_OTHER]);
  });

  test("webhook-add stamps routing.json's updatedAt as well as updatedBy", async () => {
    const h = harness();
    await applyRoutingRequest(addRequest(), h.deps);
    expect(h.routing.updatedAt).toBe(NOW.toISOString());
    expect(h.routing.webhooks[CH_HOME]!.addedAt).toBe(NOW.toISOString());
  });

  test("a failed metadata write puts the secret back as it was: a first add leaves no secret behind", async () => {
    const h = harness({ routingFails: new Error("EIO: write failed") });
    await expect(applyRoutingRequest(addRequest(), h.deps)).rejects.toThrow("EIO: write failed");
    // The secret was written, then taken out again; nothing names the webhook anywhere.
    expect(h.events).toEqual(["fetchWebhook", "mutateSecrets", "mutateRouting", "mutateSecrets"]);
    expect(h.secrets.webhooks).toEqual({});
    expect(h.routing.webhooks).toEqual({});
  });

  test("a failed metadata write on a replacement restores the previous url, so the two files still agree", async () => {
    const before = "https://discord.com/api/webhooks/666666666666666666/PREVIOUSTOKEN_0123456789abc";
    const h = harness({
      routingFails: new Error("EIO: write failed"),
      routing: routingWithWebhook(),
      secrets: { ...freshSecrets(), webhooks: { [CH_HOME]: before } },
    });
    await expect(applyRoutingRequest(addRequest(), h.deps)).rejects.toThrow("EIO: write failed");
    expect(h.secrets.webhooks[CH_HOME]).toBe(before);
    expect(h.routing.webhooks[CH_HOME]!.id).toBe("666666666666666666");
  });

  test("if the secret cannot be put back either, the original error still surfaces and the log carries no url", async () => {
    const h = harness({
      routingFails: new Error("EIO: write failed"),
      secretsFailOnCall: { call: 2, error: new Error(`EACCES writing ${URL_OK}`) },
    });
    await expect(applyRoutingRequest(addRequest(), h.deps)).rejects.toThrow("EIO: write failed");
    expect(h.warns).toEqual([`[routing] could not put back the webhook secret for channel ${CH_HOME} after a failed write`]);
    expect(JSON.stringify(h.warns)).not.toContain(TOKEN);
  });

  test("a webhook in a server the bot is not in is refused", async () => {
    const h = harness({ lookup: { ok: true, id: WH_ID, channelId: CH_HOME, guildId: STRANGER }, afterRefresh: bothServers() });
    const reason = await refusalOf(applyRoutingRequest(addRequest(), h.deps));
    expect(reason).toBe("that webhook posts to a server the bot is not in");
    // Looked for once more after a refresh, and nothing was written anywhere.
    expect(h.events).toEqual(["fetchWebhook", "refreshDiscovery"]);
    expect(h.secretsWrites).toEqual([]);
    expect(h.routingWrites).toEqual([]);
  });

  test("a webhook in a channel the bot cannot see is refused", async () => {
    const h = harness({ lookup: { ok: true, id: WH_ID, channelId: "777777777777777777", guildId: HOME } });
    const reason = await refusalOf(applyRoutingRequest(addRequest(), h.deps));
    expect(reason).toBe("that webhook posts to a channel the bot cannot see");
    expect(h.secretsWrites).toEqual([]);
    expect(h.routingWrites).toEqual([]);
  });

  test("a webhook in a server the bot joined since discovery was written is accepted after the refresh", async () => {
    const h = harness({
      discovery: homeOnly(),
      afterRefresh: bothServers(),
      lookup: { ok: true, id: WH_ID, channelId: CH_OTHER, guildId: OTHER },
    });
    await expect(applyRoutingRequest(addRequest(), h.deps)).resolves.toEqual({ channelId: CH_OTHER });
    expect(h.events).toEqual(["fetchWebhook", "refreshDiscovery", "mutateSecrets", "mutateRouting"]);
  });

  test("a webhook Discord does not know is refused, with Discord's reason and no writes", async () => {
    const h = harness({ lookup: { ok: false, reason: "Discord does not know that webhook" } });
    const reason = await refusalOf(applyRoutingRequest(addRequest(), h.deps));
    expect(reason).toBe("Discord does not know that webhook");
    expect(h.events).toEqual(["fetchWebhook"]);
  });

  test("a webhook whose answer names a different id is refused", async () => {
    const h = harness({ lookup: { ok: true, id: "888888888888888888", channelId: CH_HOME, guildId: HOME } });
    expect(await refusalOf(applyRoutingRequest(addRequest(), h.deps))).toBe("Discord does not know that webhook");
    expect(h.secretsWrites).toEqual([]);
  });

  test("with no discovery at all a webhook is refused", async () => {
    const h = harness({ discovery: null, afterRefresh: null });
    expect(await refusalOf(applyRoutingRequest(addRequest(), h.deps))).toBe("the bot has not published what it can see yet");
    expect(h.secretsWrites).toEqual([]);
  });
});

describe("applyRoutingRequest: webhook-remove and discovery-refresh", () => {
  test("webhook-remove deletes the metadata before the secret", async () => {
    const h = harness({
      routing: routingWithWebhook(),
      secrets: {
        ...freshSecrets(),
        webhooks: {
          [CH_HOME]: URL_OK,
          [CH_OTHER]: "https://discord.com/api/webhooks/666666666666666666/OTHERTOKEN0123456789abcd",
        },
      },
    });
    const result = await applyRoutingRequest(removeRequest(), h.deps);
    expect(result).toEqual({ channelId: CH_HOME });
    // The reverse of an add: routing.json never names a webhook whose URL is gone.
    expect(h.events).toEqual(["mutateRouting", "mutateSecrets"]);
    expect(h.routing.webhooks).toEqual({});
    expect(h.routing.updatedBy).toBe(ME);
    // Only that channel's secret went.
    expect(Object.keys(h.secrets.webhooks)).toEqual([CH_OTHER]);
  });

  test("webhook-remove keeps the other channels' webhooks", async () => {
    const h = harness({
      routing: {
        ...freshRouting(),
        webhooks: {
          [CH_HOME]: { id: "666666666666666666", guildId: HOME, addedAt: "t", addedBy: "u" },
          [CH_OTHER]: { id: "777777777777777777", guildId: OTHER, addedAt: "t", addedBy: "u" },
        },
      },
    });
    await applyRoutingRequest(removeRequest(), h.deps);
    expect(Object.keys(h.routing.webhooks)).toEqual([CH_OTHER]);
  });

  test("webhook-remove stamps routing.json's updatedAt as well as updatedBy", async () => {
    const h = harness({ routing: routingWithWebhook() });
    await applyRoutingRequest(removeRequest(), h.deps);
    expect(h.routing.updatedAt).toBe(NOW.toISOString());
  });

  test("webhook-remove clears a secret that routing.json no longer names", async () => {
    // A write that failed halfway, or a hand edit: the url is stored but nothing names it, and the
    // request must still be able to remove it.
    const h = harness({ secrets: { ...freshSecrets(), webhooks: { [CH_HOME]: URL_OK, [CH_OTHER]: URL_OK.replace(WH_ID, "666666666666666666") } } });
    await expect(applyRoutingRequest(removeRequest(), h.deps)).resolves.toEqual({ channelId: CH_HOME });
    expect(h.events).toEqual(["mutateSecrets"]);
    expect(Object.keys(h.secrets.webhooks)).toEqual([CH_OTHER]);
    // routing.json had nothing to remove and was not rewritten.
    expect(h.routingWrites).toEqual([]);
  });

  test("webhook-remove clears metadata that has no secret behind it", async () => {
    const h = harness({ routing: routingWithWebhook() });
    await expect(applyRoutingRequest(removeRequest(), h.deps)).resolves.toEqual({ channelId: CH_HOME });
    expect(h.events).toEqual(["mutateRouting"]);
    expect(h.routing.webhooks).toEqual({});
  });

  test("a webhook-remove that failed halfway can be sent again", async () => {
    const first = harness({
      routing: routingWithWebhook(),
      secrets: { ...freshSecrets(), webhooks: { [CH_HOME]: URL_OK } },
      secretsFailOnCall: { call: 1, error: new Error("EIO: write failed") },
    });
    await expect(applyRoutingRequest(removeRequest(), first.deps)).rejects.toThrow("EIO");
    // The metadata went and the secret stayed...
    expect(first.routing.webhooks).toEqual({});
    expect(first.secrets.webhooks[CH_HOME]).toBe(URL_OK);
    // ...and a second request finishes the job instead of being refused for having nothing to remove.
    const second = harness({ routing: first.routing, secrets: first.secrets });
    await expect(applyRoutingRequest(removeRequest(), second.deps)).resolves.toEqual({ channelId: CH_HOME });
    expect(second.secrets.webhooks).toEqual({});
  });

  test("webhook-remove for a channel with none is refused", async () => {
    const h = harness();
    expect(await refusalOf(applyRoutingRequest(removeRequest(), h.deps))).toBe("no webhook is registered for that channel");
    expect(h.events).toEqual([]);
  });

  test("webhook-remove looks only at the channels it holds, not at inherited keys", async () => {
    const h = harness();
    // "constructor" is not a snowflake so the parser refuses it first; the guard behind it is `Object.hasOwn`.
    expect(parseRoutingRequest({ action: "webhook-remove", channelId: "constructor", requestedBy: ME })).toEqual({ ok: false, reason: "bad channel id" });
    expect(await refusalOf(applyRoutingRequest(removeRequest({ channelId: "12345" }), h.deps))).toBe("no webhook is registered for that channel");
  });

  test("discovery-refresh refreshes", async () => {
    const h = harness();
    await expect(applyRoutingRequest(must({ action: "discovery-refresh", requestedBy: ME }), h.deps)).resolves.toEqual({});
    expect(h.events).toEqual(["refreshDiscovery"]);
  });
});

describe("liveFetchWebhook", () => {
  type Call = { url: string; init: RequestInit | undefined };
  const respond = (status: number, body: unknown = {}, asText?: string): typeof fetch => {
    return (async () => new Response(asText ?? JSON.stringify(body), { status })) as unknown as typeof fetch;
  };
  const recording = (calls: Call[], response: () => Response): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return response();
    }) as unknown as typeof fetch;
  const good = { id: WH_ID, channel_id: CH_HOME, guild_id: HOME };

  test("the lookup goes to discord.com whatever host was pasted", async () => {
    const calls: Call[] = [];
    const h = harness();
    const deps: RoutingRequestDeps = {
      ...h.deps,
      fetchWebhook: liveFetchWebhook(recording(calls, () => new Response(JSON.stringify(good), { status: 200 }))),
    };
    for (const pasted of [
      URL_OK,
      `https://canary.discordapp.com/api/v9/webhooks/${WH_ID}/${TOKEN}`,
      `https://ptb.discord.com/api/webhooks/${WH_ID}/${TOKEN}`,
    ]) {
      await applyRoutingRequest(addRequest({ url: pasted }), deps);
    }
    // Built from the id and token, never from what was pasted: the same URL every time.
    expect(calls.map((c) => c.url)).toEqual(Array(3).fill(`https://discord.com/api/v10/webhooks/${WH_ID}/${TOKEN}`));
    // A GET (no method override), bounded, and a redirect is an error rather than followed elsewhere.
    expect(calls[0]!.init?.method).toBeUndefined();
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("the lookup is bounded to ten seconds", async () => {
    const timeout = spyOn(AbortSignal, "timeout");
    try {
      await liveFetchWebhook(respond(200, good))(WH_ID, TOKEN);
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  test("a good answer returns the three ids and nothing else -- the token in the body goes nowhere", async () => {
    const lookup = liveFetchWebhook(respond(200, { ...good, token: "BODY-TOKEN-0123456789", name: "hook", url: URL_OK }));
    expect(await lookup(WH_ID, TOKEN)).toEqual({ ok: true, id: WH_ID, channelId: CH_HOME, guildId: HOME });
  });

  test('a 404 is "Discord does not know that webhook"', async () => {
    for (const status of [401, 403, 404]) {
      expect(await liveFetchWebhook(respond(status))(WH_ID, TOKEN), String(status)).toEqual({ ok: false, reason: "Discord does not know that webhook" });
    }
  });

  test('any other status is "could not reach Discord"', async () => {
    for (const status of [400, 429, 500, 502, 503]) {
      expect(await liveFetchWebhook(respond(status, good))(WH_ID, TOKEN), String(status)).toEqual({ ok: false, reason: "could not reach Discord" });
    }
  });

  test('a thrown fetch is "could not reach Discord" and its text is dropped', async () => {
    const throwing = (async () => {
      throw new Error(`connect ECONNREFUSED while fetching https://discord.com/api/v10/webhooks/${WH_ID}/${TOKEN}`);
    }) as unknown as typeof fetch;
    const result = await liveFetchWebhook(throwing)(WH_ID, TOKEN);
    expect(result).toEqual({ ok: false, reason: "could not reach Discord" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  test('a body missing an id is "could not reach Discord"', async () => {
    for (const body of [{}, { channel_id: CH_HOME, guild_id: HOME }, { id: WH_ID, guild_id: HOME }, { id: WH_ID, channel_id: CH_HOME }, { id: 5, channel_id: CH_HOME, guild_id: HOME }, null, [], "text"]) {
      expect(await liveFetchWebhook(respond(200, body))(WH_ID, TOKEN), JSON.stringify(body)).toEqual({ ok: false, reason: "could not reach Discord" });
    }
    // And one that is not JSON at all.
    expect(await liveFetchWebhook(respond(200, null, "<html>not json</html>"))(WH_ID, TOKEN)).toEqual({ ok: false, reason: "could not reach Discord" });
  });
});

describe("redactWebhookUrls", () => {
  const cases: [string, string][] = [
    ["plain https", `https://discord.com/api/webhooks/${WH_ID}/${TOKEN}`],
    ["http", `http://discord.com/api/webhooks/${WH_ID}/${TOKEN}`],
    ["mixed case", `HtTpS://DiScOrD.CoM/aPi/WeBhOoKs/${WH_ID}/${TOKEN}`],
    ["versioned", `https://discord.com/api/v10/webhooks/${WH_ID}/${TOKEN}`],
    ["discordapp", `https://discordapp.com/api/webhooks/${WH_ID}/${TOKEN}`],
    ["canary", `https://canary.discord.com/api/webhooks/${WH_ID}/${TOKEN}`],
    ["ptb + discordapp + version", `https://ptb.discordapp.com/api/v9/webhooks/${WH_ID}/${TOKEN}`],
    ["no scheme", `discord.com/api/webhooks/${WH_ID}/${TOKEN}`],
    ["a JSON-escaped slash", String.raw`https:\/\/discord.com\/api\/webhooks\/${WH_ID}\/${TOKEN}`],
    ["a query string", `https://discord.com/api/webhooks/${WH_ID}/${TOKEN}?wait=true&thread_id=1`],
  ];

  test("redacts http, https, mixed case, versioned and discordapp forms", () => {
    for (const [name, url] of cases) {
      const redacted = redactWebhookUrls(`could not use ${url} right now`);
      expect(redacted, name).toBe("could not use [webhook url] right now");
      expect(redacted, name).not.toContain(TOKEN);
    }
  });

  test("redacts every occurrence, in quotes and JSON too", () => {
    const text = `first ${URL_OK}, then "${URL_OK}" and {"url":"${URL_OK}"}`;
    const redacted = redactWebhookUrls(text);
    // Exactly: the url and nothing around it -- a quote, a comma and a brace are not part of one.
    expect(redacted).toBe('first [webhook url], then "[webhook url]" and {"url":"[webhook url]"}');
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).not.toContain(WH_ID);
  });

  test("redacts the path of a url whose host it does not recognise: a port, a doubled slash, no host at all", () => {
    for (const url of [
      `https://discord.com:443/api/webhooks/${WH_ID}/${TOKEN}`,
      `https://discord.com//api/webhooks/${WH_ID}/${TOKEN}`,
      `/api/webhooks/${WH_ID}/${TOKEN}`,
      `webhooks/${WH_ID}/${TOKEN}`,
      `https:%2F%2Fdiscord.com%2Fapi%2Fwebhooks%2F${WH_ID}%2F${TOKEN}`,
    ]) {
      const redacted = redactWebhookUrls(`could not use ${url} today`);
      expect(redacted, url).not.toContain(TOKEN);
      expect(redacted, url).not.toContain(WH_ID);
      expect(redacted, url).toContain("[webhook url]");
      expect(redacted, url).toContain(" today");
    }
  });

  test("leaves other text alone", () => {
    for (const text of [
      "",
      "bad webhook url",
      "no webhook is registered for that channel",
      `server ${HOME} is not one the bot is in`,
      "https://example.com/api/webhooks/123/abc",
      "https://discord.com/channels/123/456",
      "discord.com is a website",
      "Discord does not know that webhook",
    ]) {
      expect(redactWebhookUrls(text), text).toBe(text);
    }
  });

  test("stays fast on hostile text", () => {
    const started = Date.now();
    for (const text of ["a".repeat(500_000), "a.".repeat(250_000), "https://".repeat(60_000), "a-".repeat(250_000) + "discord.com"]) {
      redactWebhookUrls(text);
    }
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
