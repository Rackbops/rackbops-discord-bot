import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshRouting, freshSecrets, type RoutingFile, type RoutingSecretsFile, type WebhookMeta } from "./model";
import { liveExecuteWebhook, markWebhookBroken, postForPlugin, withWebhookBroken, type PostDeps, type WebhookPostResult } from "./post";
import { mutateRouting, readRouting, routingPath } from "./store";

const G1 = "111111111111111111";
const G2 = "222222222222222222";
const CHAN_A = "444444444444444001"; // G1's postTo
const CHAN_B = "444444444444444002"; // G2's postTo
const DEFAULT = "999999999999999999";
// Distinctive enough that finding it anywhere it should not be is unmistakable.
const TOKEN = "TOKEN_zqx9f3k2m8v1w7p4r6t5y0uabcdef";
const URL_A = `https://discord.com/api/webhooks/555555555555555001/${TOKEN}A`;
const URL_B = `https://discord.com/api/webhooks/555555555555555002/${TOKEN}B`;
const URL_DEFAULT = `https://discord.com/api/webhooks/555555555555555003/${TOKEN}D`;

const meta = (over: Partial<WebhookMeta> = {}): WebhookMeta => ({
  id: "555555555555555001",
  guildId: G1,
  addedAt: "2026-09-21T00:00:00.000Z",
  addedBy: "email:me@x.com",
  ...over,
});

/** `music` posts to CHAN_A (server G1) and, when `both`, also to CHAN_B (server G2). */
function routingFor(opts: { both?: boolean; webhooks?: Record<string, WebhookMeta> } = {}): RoutingFile {
  const servers: RoutingFile["plugins"][string]["servers"] = { [G1]: { commands: "all", postTo: CHAN_A } };
  if (opts.both) servers[G2] = { commands: "all", postTo: CHAN_B };
  return { ...freshRouting(), plugins: { music: { servers } }, webhooks: opts.webhooks ?? {} };
}

const secretsOf = (webhooks: Record<string, string>): RoutingSecretsFile => ({ ...freshSecrets(), webhooks });

type Log = ["log" | "warn" | "error", ...unknown[]];

function harness(
  opts: {
    routing?: RoutingFile | (() => never);
    secrets?: RoutingSecretsFile | (() => never);
    webhook?: (url: string, message: string) => Promise<WebhookPostResult>;
    bot?: (channelId: string, message: string) => Promise<void>;
    markBroken?: (channelId: string, reason: string, seen: WebhookMeta) => Promise<void>;
  } = {},
) {
  const events: string[] = [];
  const seenByMark: WebhookMeta[] = [];
  const logs: Log[] = [];
  let secretReads = 0;
  const deps: PostDeps = {
    readRouting: async () => {
      const r = opts.routing ?? freshRouting();
      return typeof r === "function" ? r() : r;
    },
    readSecrets: async () => {
      secretReads += 1;
      const s = opts.secrets ?? freshSecrets();
      return typeof s === "function" ? s() : s;
    },
    defaultChannelId: DEFAULT,
    sendAsBot: async (channelId, message) => {
      events.push(`bot:${channelId}:${message}`);
      await opts.bot?.(channelId, message);
    },
    executeWebhook: async (url, message) => {
      events.push(`hook:${url}:${message}`);
      return opts.webhook ? opts.webhook(url, message) : { ok: true };
    },
    markBroken: async (channelId, reason, seen) => {
      events.push(`broken:${channelId}:${reason}`);
      seenByMark.push(seen);
      await opts.markBroken?.(channelId, reason, seen);
    },
    log: {
      log: (...a: unknown[]) => void logs.push(["log", ...a]),
      warn: (...a: unknown[]) => void logs.push(["warn", ...a]),
      error: (...a: unknown[]) => void logs.push(["error", ...a]),
    },
  };
  return { deps, events, logs, seenByMark, get secretReads() { return secretReads; } };
}

describe("postForPlugin", () => {
  test("with no routing it posts once, as the bot, to the default channel", async () => {
    const h = harness();
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`bot:${DEFAULT}:hello`]);
    expect(h.logs).toEqual([]);
    // The secrets file is not even opened.
    expect(h.secretReads).toBe(0);
  });

  test("a plugin with no entry of its own posts to the default channel, whatever others are placed", async () => {
    const h = harness({ routing: routingFor({ both: true }) });
    await postForPlugin("weather", "hello", h.deps);
    expect(h.events).toEqual([`bot:${DEFAULT}:hello`]);
  });

  test("... and a failure there rejects with the bot path's own error, unchanged", async () => {
    const boom = new Error("Channel 999999999999999999 is not sendable");
    const h = harness({ bot: async () => Promise.reject(boom) });
    await expect(postForPlugin("music", "hello", h.deps)).rejects.toBe(boom);
    // With one target this is today's behaviour exactly: nothing else is logged.
    expect(h.logs).toEqual([]);
  });

  test("a plugin with two postTo channels posts to both", async () => {
    const h = harness({ routing: routingFor({ both: true }) });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`bot:${CHAN_A}:hello`, `bot:${CHAN_B}:hello`]);
  });

  test("a channel with a webhook is posted through it and the bot is not used for it", async () => {
    const h = harness({ routing: routingFor({ webhooks: { [CHAN_A]: meta() } }), secrets: secretsOf({ [CHAN_A]: URL_A }) });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`hook:${URL_A}:hello`]);
    expect(h.secretReads).toBe(1);
  });

  test("two channels, one with a webhook: one webhook post and one bot post", async () => {
    const h = harness({ routing: routingFor({ both: true, webhooks: { [CHAN_A]: meta() } }), secrets: secretsOf({ [CHAN_A]: URL_A }) });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`hook:${URL_A}:hello`, `bot:${CHAN_B}:hello`]);
  });

  test("two channels both with webhooks post through each, and each with its own url", async () => {
    const h = harness({
      routing: routingFor({ both: true, webhooks: { [CHAN_A]: meta(), [CHAN_B]: meta({ id: "555555555555555002", guildId: G2 }) } }),
      secrets: secretsOf({ [CHAN_A]: URL_A, [CHAN_B]: URL_B }),
    });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`hook:${URL_A}:hello`, `hook:${URL_B}:hello`]);
  });

  test("the default channel uses its webhook too", async () => {
    const h = harness({ routing: { ...freshRouting(), webhooks: { [DEFAULT]: meta({ id: "555555555555555003" }) } }, secrets: secretsOf({ [DEFAULT]: URL_DEFAULT }) });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`hook:${URL_DEFAULT}:hello`]);
  });

  test("a webhook with no stored url posts as the bot", async () => {
    for (const secrets of [secretsOf({}), secretsOf({ [CHAN_A]: "" }), secretsOf({ [CHAN_B]: URL_B })]) {
      const h = harness({ routing: routingFor({ webhooks: { [CHAN_A]: meta() } }), secrets });
      await postForPlugin("music", "hello", h.deps);
      expect(h.events).toEqual([`bot:${CHAN_A}:hello`]);
    }
  });

  test("a broken webhook is skipped and the bot posts", async () => {
    const h = harness({
      routing: routingFor({ webhooks: { [CHAN_A]: meta({ broken: "Discord says that webhook is gone (404)" }) } }),
      secrets: secretsOf({ [CHAN_A]: URL_A }),
    });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`bot:${CHAN_A}:hello`]);
    // Nothing usable, so the secrets were never read either.
    expect(h.secretReads).toBe(0);
  });

  test("a broken webhook is skipped even when another channel's webhook makes the secrets get read", async () => {
    // A: broken, with its url still stored. B: fine. B makes the secrets get read, and A's url is right there.
    const h = harness({
      routing: routingFor({
        both: true,
        webhooks: { [CHAN_A]: meta({ broken: "Discord says that webhook is gone (404)" }), [CHAN_B]: meta({ id: "555555555555555002", guildId: G2 }) },
      }),
      secrets: secretsOf({ [CHAN_A]: URL_A, [CHAN_B]: URL_B }),
    });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`bot:${CHAN_A}:hello`, `hook:${URL_B}:hello`]);
  });

  test("an inherited property is not a stored url", async () => {
    // The channel really has webhook metadata, under a name every object has; the secrets file has no
    // entry for it. `secrets.webhooks["constructor"]` is a function, and must not be handed to fetch.
    const h = harness({
      routing: { ...freshRouting(), webhooks: { constructor: meta() } },
      secrets: secretsOf({}),
    });
    h.deps.defaultChannelId = "constructor";
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual(["bot:constructor:hello"]);
  });

  test("a 404 falls back to the bot and marks the webhook broken", async () => {
    const reason = "Discord says that webhook is gone (404)";
    const h = harness({
      routing: routingFor({ webhooks: { [CHAN_A]: meta() } }),
      secrets: secretsOf({ [CHAN_A]: URL_A }),
      webhook: async () => ({ ok: false, gone: true, reason }),
    });
    await postForPlugin("music", "hello", h.deps);
    // The post still arrives, through the bot, after the flag is written.
    expect(h.events).toEqual([`hook:${URL_A}:hello`, `broken:${CHAN_A}:${reason}`, `bot:${CHAN_A}:hello`]);
    expect(h.logs).toEqual([["warn", `[announce] music: the webhook for ${CHAN_A} failed: ${reason}`]]);
    // The flag is asked for on the webhook that was posted through: the metadata as it was read.
    expect(h.seenByMark).toEqual([meta()]);
  });

  test("a 401 does the same", async () => {
    const reason = "Discord says that webhook is gone (401)";
    const h = harness({
      routing: routingFor({ webhooks: { [CHAN_A]: meta() } }),
      secrets: secretsOf({ [CHAN_A]: URL_A }),
      webhook: liveExecuteWebhook((async () => new Response("", { status: 401 })) as unknown as typeof fetch),
    });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`hook:${URL_A}:hello`, `broken:${CHAN_A}:${reason}`, `bot:${CHAN_A}:hello`]);
  });

  test("a 429, a 500 and a timeout fall back to the bot and do NOT mark it broken", async () => {
    const failures: [string, WebhookPostResult][] = [
      ["429", { ok: false, gone: false, reason: "webhook post failed (429)" }],
      ["500", { ok: false, gone: false, reason: "webhook post failed (500)" }],
      ["a timeout", { ok: false, gone: false, reason: "could not reach Discord" }],
    ];
    for (const [name, result] of failures) {
      const h = harness({ routing: routingFor({ webhooks: { [CHAN_A]: meta() } }), secrets: secretsOf({ [CHAN_A]: URL_A }), webhook: async () => result });
      await postForPlugin("music", "hello", h.deps);
      expect(h.events, name).toEqual([`hook:${URL_A}:hello`, `bot:${CHAN_A}:hello`]);
    }
  });

  test("an executeWebhook that throws still falls back to the bot, and is not marked broken", async () => {
    const h = harness({
      routing: routingFor({ webhooks: { [CHAN_A]: meta() } }),
      secrets: secretsOf({ [CHAN_A]: URL_A }),
      webhook: async () => Promise.reject(new Error(`connect ECONNREFUSED ${URL_A}`)),
    });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`hook:${URL_A}:hello`, `bot:${CHAN_A}:hello`]);
  });

  test("a failing markBroken is logged and the post still arrives", async () => {
    const h = harness({
      routing: routingFor({ webhooks: { [CHAN_A]: meta() } }),
      secrets: secretsOf({ [CHAN_A]: URL_A }),
      webhook: async () => ({ ok: false, gone: true, reason: "Discord says that webhook is gone (404)" }),
      markBroken: async () => Promise.reject(new Error("EACCES: routing.json")),
    });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events.at(-1)).toBe(`bot:${CHAN_A}:hello`);
    expect(h.logs.some(([level, line]) => level === "error" && String(line).includes(`could not mark the webhook for ${CHAN_A} broken`))).toBe(true);
  });

  test("secrets are read only when some target has a usable webhook", async () => {
    // Metadata present but broken, or no metadata at all: not read.
    const none = harness({ routing: routingFor({ both: true }) });
    await postForPlugin("music", "hello", none.deps);
    expect(none.secretReads).toBe(0);
    // One usable webhook among the targets: read once.
    const some = harness({ routing: routingFor({ both: true, webhooks: { [CHAN_B]: meta({ guildId: G2 }) } }), secrets: secretsOf({ [CHAN_B]: URL_B }) });
    await postForPlugin("music", "hello", some.deps);
    expect(some.secretReads).toBe(1);
  });

  test("an id that is the name of an inherited property is not a webhook", async () => {
    // A default channel id that came from a file is never trusted to be a plain key: `constructor`
    // exists on every object, and `in` or a bare lookup would say a webhook is registered for it.
    const h = harness({ routing: freshRouting() });
    h.deps.defaultChannelId = "constructor";
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual(["bot:constructor:hello"]);
    expect(h.secretReads).toBe(0);
  });

  test("a routing read that throws posts to the default channel, and says so", async () => {
    const h = harness({
      routing: () => {
        throw new Error("EIO");
      },
    });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`bot:${DEFAULT}:hello`]);
    expect(h.logs).toEqual([["warn", "[announce] music: could not read routing; posting to the default channel"]]);
  });

  test("a secrets read that throws posts as the bot, and says so", async () => {
    const h = harness({
      routing: routingFor({ webhooks: { [CHAN_A]: meta() } }),
      secrets: () => {
        throw new Error("EIO");
      },
    });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`bot:${CHAN_A}:hello`]);
    expect(h.logs).toEqual([["warn", "[announce] music: could not read the webhook secrets; posting as the bot"]]);
  });

  test("one channel failing does not stop the others, and does not reject", async () => {
    const boom = new Error("Missing Access");
    const h = harness({
      routing: routingFor({ both: true }),
      bot: async (channelId) => {
        if (channelId === CHAN_A) throw boom;
      },
    });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`bot:${CHAN_A}:hello`, `bot:${CHAN_B}:hello`]);
    // The unreachable channel is logged, with the error itself.
    expect(h.logs).toEqual([["error", `[announce] music: could not post to ${CHAN_A}`, boom]]);
  });

  test("a failure of the LAST channel does not reject either", async () => {
    const h = harness({
      routing: routingFor({ both: true }),
      bot: async (channelId) => {
        if (channelId === CHAN_B) throw new Error("Missing Access");
      },
    });
    await postForPlugin("music", "hello", h.deps);
    expect(h.events).toEqual([`bot:${CHAN_A}:hello`, `bot:${CHAN_B}:hello`]);
  });

  test("every channel failing rejects, with the first error", async () => {
    const errA = new Error("A failed");
    const errB = new Error("B failed");
    const h = harness({
      routing: routingFor({ both: true }),
      bot: async (channelId) => {
        throw channelId === CHAN_A ? errA : errB;
      },
    });
    await expect(postForPlugin("music", "hello", h.deps)).rejects.toBe(errA);
    // Both were tried, and the one that is not thrown is not lost: it is logged.
    expect(h.events).toEqual([`bot:${CHAN_A}:hello`, `bot:${CHAN_B}:hello`]);
    expect(h.logs).toEqual([["error", `[announce] music: could not post to ${CHAN_B}`, errB]]);
  });

  test("a single target failing logs nothing more than today: the plugin gets the error", async () => {
    const boom = new Error("Missing Access");
    const h = harness({ routing: routingFor(), bot: async () => Promise.reject(boom) });
    await expect(postForPlugin("music", "hello", h.deps)).rejects.toBe(boom);
    expect(h.logs).toEqual([]);
  });

  test("the webhook success prints the same [announce] line the bot path does", async () => {
    const h = harness({ routing: routingFor({ both: true, webhooks: { [CHAN_A]: meta() } }), secrets: secretsOf({ [CHAN_A]: URL_A }) });
    await postForPlugin("music", "hello", h.deps);
    // One line for the webhook post; the bot's own line is printed by `announceTo`, not here.
    expect(h.logs).toEqual([["log", "[announce]", "hello"]]);
  });
});

describe("liveExecuteWebhook", () => {
  const capture = () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  };

  test("sends content with allowed_mentions parse []", async () => {
    const { calls, fetchFn } = capture();
    const result = await liveExecuteWebhook(fetchFn)(URL_A, "@everyone hello <@123>");
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_A);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({ "Content-Type": "application/json" });
    // Exactly this body: the message, and no mention parsed -- a webhook post must be as mention-safe as
    // a bot post, which the Client sends with `allowedMentions: { parse: [] }`.
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ content: "@everyone hello <@123>", allowed_mentions: { parse: [] } });
  });

  test("gives up after ten seconds", async () => {
    const timeout = spyOn(AbortSignal, "timeout");
    try {
      const { calls, fetchFn } = capture();
      await liveExecuteWebhook(fetchFn)(URL_A, "hello");
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeout.mockRestore();
    }
  });

  test("maps 2xx to ok, 404/401 to gone, and everything else to not gone", async () => {
    const statuses: [number, WebhookPostResult][] = [
      [200, { ok: true }],
      [204, { ok: true }],
      [299, { ok: true }],
      [300, { ok: false, gone: false, reason: "webhook post failed (300)" }],
      [404,{ ok: false, gone: true, reason: "Discord says that webhook is gone (404)" }],
      [401, { ok: false, gone: true, reason: "Discord says that webhook is gone (401)" }],
      [400, { ok: false, gone: false, reason: "webhook post failed (400)" }],
      [403, { ok: false, gone: false, reason: "webhook post failed (403)" }],
      [429, { ok: false, gone: false, reason: "webhook post failed (429)" }],
      [500, { ok: false, gone: false, reason: "webhook post failed (500)" }],
      [502, { ok: false, gone: false, reason: "webhook post failed (502)" }],
    ];
    for (const [status, expected] of statuses) {
      const result = await liveExecuteWebhook((async () => new Response(null, { status })) as unknown as typeof fetch)(URL_A, "hello");
      expect(result, String(status)).toEqual(expected);
    }
  });

  test('a thrown fetch is "could not reach Discord" and its text is dropped', async () => {
    const fetchFn = (async () => {
      throw new Error(`request to ${URL_A} failed, reason: connect ETIMEDOUT`);
    }) as unknown as typeof fetch;
    const result = await liveExecuteWebhook(fetchFn)(URL_A, "hello");
    expect(result).toEqual({ ok: false, gone: false, reason: "could not reach Discord" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  test("a response body that carries the url is not echoed either", async () => {
    const result = await liveExecuteWebhook((async () => new Response(`{"message":"${URL_A}"}`, { status: 500 })) as unknown as typeof fetch)(URL_A, "hello");
    expect(result).toEqual({ ok: false, gone: false, reason: "webhook post failed (500)" });
  });
});

describe("markWebhookBroken", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "routing-post-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = (webhooks: Record<string, WebhookMeta>) =>
    mutateRouting(dir, (current) => ({
      ...current,
      updatedAt: "2026-09-20T10:00:00.000Z",
      updatedBy: "email:panel@x.com",
      plugins: { music: { servers: { [G1]: { commands: "all", postTo: CHAN_A } } } },
      webhooks,
    }));

  test("sets broken on an existing entry, leaves updatedAt and updatedBy alone", async () => {
    await seed({ [CHAN_A]: meta(), [CHAN_B]: meta({ id: "555555555555555002", guildId: G2 }) });
    await markWebhookBroken(dir)(CHAN_A, "Discord says that webhook is gone (404)", meta());
    const after = await readRouting(dir);
    expect(after.webhooks[CHAN_A]).toEqual({ ...meta(), broken: "Discord says that webhook is gone (404)" });
    // The other webhook, the placements and the edit stamp are untouched: nobody edited anything.
    expect(after.webhooks[CHAN_B]).toEqual(meta({ id: "555555555555555002", guildId: G2 }));
    expect(after.plugins.music).toEqual({ servers: { [G1]: { commands: "all", postTo: CHAN_A } } });
    expect(after.updatedAt).toBe("2026-09-20T10:00:00.000Z");
    expect(after.updatedBy).toBe("email:panel@x.com");
  });

  test("does nothing for a channel with no entry", async () => {
    await seed({ [CHAN_A]: meta() });
    await markWebhookBroken(dir)(CHAN_B, "Discord says that webhook is gone (404)", meta());
    const after = await readRouting(dir);
    expect(Object.keys(after.webhooks)).toEqual([CHAN_A]);
    expect(after.webhooks[CHAN_A]?.broken).toBeUndefined();
    // Not even an inherited name creates an entry.
    await markWebhookBroken(dir)("constructor", "Discord says that webhook is gone (404)", meta());
    expect(Object.keys((await readRouting(dir)).webhooks)).toEqual([CHAN_A]);
  });

  test("a webhook replaced while the post was in flight is not marked broken by the old one's 404", async () => {
    // The post went through W1 (this is what it saw); the operator then replaced it with W2; W1's 404 lands.
    const w1 = meta({ id: "555555555555555001", addedAt: "2026-09-21T00:00:00.000Z" });
    const w2 = meta({ id: "555555555555555002", addedAt: "2026-09-21T00:00:05.000Z", addedBy: "op" });
    await seed({ [CHAN_A]: w2 });
    await markWebhookBroken(dir)(CHAN_A, "Discord says that webhook is gone (404)", w1);
    expect((await readRouting(dir)).webhooks[CHAN_A]).toEqual(w2);
    // The same webhook added again under the same id is a different add: it is left alone too.
    const again = meta({ id: w1.id, addedAt: "2026-09-21T00:00:09.000Z" });
    await seed({ [CHAN_A]: again });
    await markWebhookBroken(dir)(CHAN_A, "Discord says that webhook is gone (404)", w1);
    expect((await readRouting(dir)).webhooks[CHAN_A]).toEqual(again);
    // ... while the entry that WAS posted through is marked.
    await markWebhookBroken(dir)(CHAN_A, "Discord says that webhook is gone (404)", again);
    expect((await readRouting(dir)).webhooks[CHAN_A]?.broken).toBe("Discord says that webhook is gone (404)");
  });
});

describe("withWebhookBroken", () => {
  const REASON = "Discord says that webhook is gone (404)";
  const file = (webhooks: Record<string, WebhookMeta>): RoutingFile => ({ ...freshRouting(), updatedAt: "T", updatedBy: "who", webhooks });

  test("sets broken on the entry that was seen, and touches nothing else", () => {
    const before = file({ [CHAN_A]: meta(), [CHAN_B]: meta({ id: "555555555555555002", guildId: G2 }) });
    const after = withWebhookBroken(before, CHAN_A, REASON, meta());
    expect(after.webhooks[CHAN_A]).toEqual({ ...meta(), broken: REASON });
    expect(after.webhooks[CHAN_B]).toEqual(meta({ id: "555555555555555002", guildId: G2 }));
    expect(after.updatedAt).toBe("T");
    expect(after.updatedBy).toBe("who");
    // The input is not changed.
    expect(before.webhooks[CHAN_A]).toEqual(meta());
  });

  test("returns the routing itself when there is nothing to mark", () => {
    const before = file({ [CHAN_A]: meta() });
    // No entry for the channel; an inherited name; a different webhook; the same webhook added again.
    expect(withWebhookBroken(before, CHAN_B, REASON, meta())).toBe(before);
    expect(withWebhookBroken(before, "constructor", REASON, meta())).toBe(before);
    expect(withWebhookBroken(before, CHAN_A, REASON, meta({ id: "555555555555555009" }))).toBe(before);
    expect(withWebhookBroken(before, CHAN_A, REASON, meta({ addedAt: "2026-09-22T00:00:00.000Z" }))).toBe(before);
  });
});

describe("the webhook url never appears", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "routing-post-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Everything a run printed or threw, as one string to search. An Error is searched with every own
   * property, because that is what a logger prints: Bun's fetch errors carry the whole request URL in `path`.
   */
  const everything = (logs: Log[], thrown: unknown[]): string =>
    JSON.stringify(
      [...logs, ...thrown].map((entry) =>
        (Array.isArray(entry) ? entry : [entry]).map((a) => (a instanceof Error ? { ...JSON.parse(JSON.stringify(a, Object.getOwnPropertyNames(a))) } : a)),
      ),
    );

  /** What Bun's fetch throws when it cannot connect: a generic message and the URL in `path`. */
  const connectError = (url: string): Error => Object.assign(new Error(`Unable to connect. Is the computer able to access ${url}?`), { code: "ConnectionRefused", path: url });

  test("the url appears in no log line, no error and no routing.json", async () => {
    // Each way a webhook post can fail, with a fetch that puts the url in what it throws or returns.
    const fetches: [string, typeof fetch][] = [
      ["a 404", (async () => new Response(`{"url":"${URL_A}"}`, { status: 404 })) as unknown as typeof fetch],
      ["a 401", (async () => new Response(URL_A, { status: 401 })) as unknown as typeof fetch],
      ["a 500", (async () => new Response(URL_A, { status: 500 })) as unknown as typeof fetch],
      ["a 429", (async () => new Response(URL_A, { status: 429 })) as unknown as typeof fetch],
      [
        "a thrown fetch",
        (async () => {
          throw connectError(URL_A);
        }) as unknown as typeof fetch,
      ],
      ["success", (async () => new Response(null, { status: 204 })) as unknown as typeof fetch],
    ];
    for (const [name, fetchFn] of fetches) {
      rmSync(routingPath(dir), { force: true });
      await mutateRouting(dir, (current) => ({ ...routingFor({ both: true, webhooks: { [CHAN_A]: meta() } }), updatedAt: current.updatedAt }));
      const h = harness({
        routing: await readRouting(dir),
        secrets: secretsOf({ [CHAN_A]: URL_A }),
        webhook: liveExecuteWebhook(fetchFn),
        // Both the bot and the flag write also fail, with errors of their own.
        bot: async (channelId) => {
          if (channelId === CHAN_B) throw new Error("Missing Access");
        },
      });
      h.deps.markBroken = async (channelId, reason, seen) => {
        await markWebhookBroken(dir)(channelId, reason, seen);
        throw new Error("could not record it");
      };
      const thrown: unknown[] = [];
      try {
        await postForPlugin("music", `hello ${name}`, h.deps);
      } catch (err) {
        thrown.push(err);
      }
      const seen = everything(h.logs, thrown);
      expect(seen, name).not.toContain(TOKEN);
      expect(seen, name).not.toContain("webhooks/");
      expect(readFileSync(routingPath(dir), "utf8"), name).not.toContain(TOKEN);
    }
  });

  test("... including when every channel fails and the post rejects", async () => {
    const h = harness({
      routing: routingFor({ webhooks: { [CHAN_A]: meta() } }),
      secrets: secretsOf({ [CHAN_A]: URL_A }),
      webhook: liveExecuteWebhook((async () => {
        throw connectError(URL_A);
      }) as unknown as typeof fetch),
      bot: async () => Promise.reject(new Error("Missing Access")),
    });
    const thrown: unknown[] = [];
    try {
      await postForPlugin("music", "hello", h.deps);
    } catch (err) {
      thrown.push(err);
    }
    expect(thrown).toHaveLength(1);
    const seen = everything(h.logs, thrown);
    expect(seen).not.toContain(TOKEN);
  });
});
