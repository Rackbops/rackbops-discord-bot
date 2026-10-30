import { describe, expect, test } from "bun:test";
import { format } from "node:util";
import { DiscordAPIError, HTTPError, RateLimitError, REST, Routes } from "discord.js";
import { editOwnMessage, fetchMember, sendPayloadDm, sendPayloadToChannel, withoutRequest } from "./delivery";
import type { BuiltPayload } from "./hostMessage";

const payload: BuiltPayload = { content: "hi", allowedMentions: { parse: [] } };

describe("sendPayloadToChannel", () => {
  test("sends the payload unchanged and returns the message id and guildId", async () => {
    const sendCalls: unknown[] = [];
    const fakeChannel = {
      isSendable: () => true,
      send: async (p: unknown) => {
        sendCalls.push(p);
        return { id: "555", guildId: "111" };
      },
    };
    const fakeClient = { channels: { fetch: async () => fakeChannel } } as unknown as import("discord.js").Client;

    const result = await sendPayloadToChannel(fakeClient, "222", payload);

    expect(sendCalls).toEqual([payload]);
    expect(result).toEqual({ messageId: "555", guildId: "111" });
  });

  // #132's shared shape: pins the same not-sendable wording announce.ts's own sendToChannel uses.
  test("throws when the channel isn't sendable", async () => {
    const fakeClient = {
      channels: { fetch: async () => ({ isSendable: () => false }) },
    } as unknown as import("discord.js").Client;
    await expect(sendPayloadToChannel(fakeClient, "222", payload)).rejects.toThrow(/not sendable/);
  });

  test("throws the same way when the channel does not exist", async () => {
    const fakeClient = { channels: { fetch: async () => null } } as unknown as import("discord.js").Client;
    await expect(sendPayloadToChannel(fakeClient, "222", payload)).rejects.toThrow(/not sendable/);
  });
});

describe("sendPayloadDm", () => {
  test("sends the payload unchanged and returns the message id and channel id", async () => {
    const sendCalls: unknown[] = [];
    const fakeUser = {
      send: async (p: unknown) => {
        sendCalls.push(p);
        return { id: "777", channelId: "888" };
      },
    };
    const fakeClient = { users: { fetch: async () => fakeUser } } as unknown as import("discord.js").Client;

    const result = await sendPayloadDm(fakeClient, "999", payload);

    expect(sendCalls).toEqual([payload]);
    expect(result).toEqual({ messageId: "777", channelId: "888" });
  });

  test("maps a 50007 DiscordAPIError to a clean refusal", async () => {
    // The real class, not a stand-in -- register.test.ts's own convention for pinning against a real
    // discord.js error shape rather than guessing at it.
    const real = new DiscordAPIError(
      { message: "Cannot send messages to this user", code: 50007 },
      50007,
      403,
      "POST",
      "https://discord.com/api/v10/channels/1/messages",
      { body: undefined, files: undefined },
    );
    const fakeUser = {
      send: async () => {
        throw real;
      },
    };
    const fakeClient = { users: { fetch: async () => fakeUser } } as unknown as import("discord.js").Client;

    await expect(sendPayloadDm(fakeClient, "999", payload)).rejects.toThrow("recipient cannot be messaged");
  });

  // #455: the code check is what keeps every OTHER Discord refusal from being misreported as closed DMs,
  // so it is pinned with real DiscordAPIErrors of other codes, not only a plain Error. #508: rethrown
  // without the request it carried, but with its message, name and code, so a caller still tells them apart.
  test("a DiscordAPIError with any other code is rethrown with its code, not reported as closed DMs", async () => {
    for (const [code, status, message] of [
      [40003, 429, "You are opening direct messages too fast"],
      [50013, 403, "Missing Permissions"],
      [10013, 404, "Unknown User"],
    ] as const) {
      const real = new DiscordAPIError(
        { message, code },
        code,
        status,
        "POST",
        "https://discord.com/api/v10/channels/1/messages",
        { body: undefined, files: undefined },
      );
      const fakeUser = {
        send: async () => {
          throw real;
        },
      };
      const fakeClient = { users: { fetch: async () => fakeUser } } as unknown as import("discord.js").Client;
      const thrown = (await sendPayloadDm(fakeClient, "999", payload).then(
        () => undefined,
        (err: unknown) => err,
      )) as Error & Record<string, unknown>;
      expect(thrown).toBeInstanceOf(Error);
      expect({ message: thrown.message, name: thrown.name, code: thrown.code, status: thrown.status, method: thrown.method }).toEqual({
        message,
        name: `DiscordAPIError[${code}]`,
        code,
        status,
        method: "POST",
      });
    }
  });

  test("a user that cannot be fetched rejects with Discord's code too (10013 is how a plugin spots an unknown user)", async () => {
    const unknown = new DiscordAPIError({ message: "Unknown User", code: 10013 }, 10013, 404, "GET", "https://discord.com/api/v10/users/9", {});
    const fakeClient = { users: { fetch: async () => Promise.reject(unknown) } } as unknown as import("discord.js").Client;
    const thrown = (await sendPayloadDm(fakeClient, "999", payload).catch((err: unknown) => err)) as Error & { code?: unknown };
    expect([thrown.message, thrown.code, "requestBody" in thrown]).toEqual(["Unknown User", 10013, false]);
  });

  test("any other error propagates as discord.js raised it", async () => {
    const fakeUser = {
      send: async () => {
        throw new Error("network blip");
      },
    };
    const fakeClient = { users: { fetch: async () => fakeUser } } as unknown as import("discord.js").Client;

    await expect(sendPayloadDm(fakeClient, "999", payload)).rejects.toThrow("network blip");
  });
});

// #508: a discord.js REST error carries the request that failed -- `requestBody.json` is the message being
// sent -- so a plugin that logged a rejection whole on a LOG_FORMAT=json instance, or serialized it,
// printed a DM's text into the container logs.
describe("withoutRequest (#508)", () => {
  // Random, so the value is in no source line Bun.inspect prints beside a stack frame.
  const marker = crypto.randomUUID();
  const secret = { content: `your token is ${marker}`, embeds: [{ title: "private" }] };
  const discordError = () =>
    new DiscordAPIError({ message: "Missing Access", code: 50001 }, 50001, 403, "POST", "https://discord.com/api/v10/channels/1/messages", {
      body: secret,
      files: undefined,
    });
  const httpError = () => new HTTPError(503, "Service Unavailable", "PATCH", "https://discord.com/api/v10/channels/1/messages/2", { body: secret });

  test("keeps the message, name, code, status, method and stack; drops the request, the raw error and the url", () => {
    const original = discordError();
    const clean = withoutRequest(original) as Error & Record<string, unknown>;
    expect(clean).not.toBe(original);
    expect(clean).toBeInstanceOf(Error);
    expect([clean.message, clean.name, clean.code, clean.status, clean.method]).toEqual(["Missing Access", "DiscordAPIError[50001]", 50001, 403, "POST"]);
    expect(clean.stack).toBe(original.stack);
    for (const key of ["requestBody", "rawError", "url"]) expect(key in clean, key).toBe(false);
    // Nothing else either, enumerable or not: no `cause`, no back-reference a structured logger could walk.
    // (Bun gives every Error its own `line`/`column`/`sourceURL`, here the throw site in delivery.ts.)
    const plain = Object.getOwnPropertyNames(new Error("x"));
    expect(Object.getOwnPropertyNames(clean).sort()).toEqual([...new Set([...plain, "code", "method", "name", "stack", "status"])].sort());
    expect(clean.cause).toBeUndefined();
    // Bun 1.4's text console folds an error's `requestBody.json` to `[Object ...]`, but LOG_FORMAT=json
    // builds each line with util.format (src/logFormat.ts), which prints it -- so a plugin's plain
    // `log.error("dm failed", err)` put the text in a JSON-logging instance's logs -- as did serializing it.
    expect(format("dm failed", original)).toContain(marker);
    expect(format("dm failed", clean)).not.toContain(marker);
    expect(JSON.stringify(original)).toContain(marker);
    expect(JSON.stringify(clean)).not.toContain(marker);
    expect(Bun.inspect(clean)).not.toContain(marker);
  });

  test("an HTTPError (a 5xx with no Discord code) is cleaned the same way, and gains no code", () => {
    const clean = withoutRequest(httpError()) as Error & Record<string, unknown>;
    expect([clean.message, clean.status, clean.method, "code" in clean]).toEqual(["Service Unavailable", 503, "PATCH", false]);
    expect(JSON.stringify(clean)).not.toContain(marker);
  });

  test("anything that is not a REST error is returned as is", () => {
    const plain = new Error("network blip");
    expect(withoutRequest(plain)).toBe(plain);
    for (const value of ["text", 5, null, undefined, { requestBody: secret }]) expect(withoutRequest(value)).toBe(value);
  });

  // #545: a reply that never reached Discord (refused, reset, DNS) is no REST error at all on Bun: a bare
  // TypeError with no `requestBody`, whose `path` is the full request URL -- the interaction token in it.
  describe("a call that never reached Discord, and wrappers around a request-carrying error (#545)", () => {
    const token = `token-${crypto.randomUUID()}`;
    const url = `http://127.0.0.1:9/v10/interactions/5/${token}/callback`;
    const networkError = () => Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused", path: url, errno: 0 });
    /** Whether `value`, or anything under its `cause` / `errors`, still has a `requestBody` (looked at directly, however deep). */
    const carriesAnywhere = (value: unknown): boolean => {
      if (!(value instanceof Error)) return false;
      if ("requestBody" in value) return true;
      const members = value instanceof AggregateError ? value.errors : [];
      return [value.cause, ...members].some(carriesAnywhere);
    };
    const printedAll = (value: unknown) => [format("x", value), Bun.inspect(value), JSON.stringify(value)].join("\n");

    test("a bare network error whose path is the request URL is cleaned: name, message and code kept, path dropped", () => {
      const original = networkError();
      expect(printedAll(original)).toContain(token); // the control
      const clean = withoutRequest(original) as Error & Record<string, unknown>;
      expect(clean).not.toBe(original);
      expect([clean.name, clean.message, clean.code]).toEqual(["TypeError", original.message, "ConnectionRefused"]);
      for (const key of ["path", "errno", "url", "requestBody"]) expect(key in clean, key).toBe(false);
      expect(printedAll(clean)).not.toContain(token);
    });

    test("a real REST call to a port nothing listens on is cleaned the same way", async () => {
      const server = Bun.serve({ port: 0, fetch: () => new Response("") });
      const port = server.port;
      await server.stop(true);
      const rest = new REST({ version: "10", api: `http://127.0.0.1:${port}`, timeout: 3000, retries: 0 });
      const realToken = `token-${crypto.randomUUID()}`;
      const thrown = await rest.post(Routes.interactionCallback("5", realToken), { body: { type: 4, data: { content: marker } }, auth: false }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(Error);
      expect(printedAll(thrown)).toContain(realToken); // the control: the uncleaned error prints the token
      const clean = withoutRequest(thrown);
      expect(clean).not.toBe(thrown);
      expect(printedAll(clean)).not.toContain(realToken);
      expect(printedAll(clean)).not.toContain(marker);
    });

    test("a RateLimitError (a url, no requestBody) is cleaned", () => {
      const rateLimited = new RateLimitError({
        timeToReset: 1, limit: 5, method: "POST", hash: "h", url: `https://discord.com/api/v10/webhooks/2/${token}`, route: "/webhooks/:id/:token", majorParameter: "2", global: false, retryAfter: 1, sublimitTimeout: 0, scope: "user",
      });
      expect(printedAll(rateLimited)).toContain(token);
      const clean = withoutRequest(rateLimited) as Error & Record<string, unknown>;
      expect(clean.name).toBe(rateLimited.name);
      expect(printedAll(clean)).not.toContain(token);
    });

    test("an error that carries a requestBody and no URL at all is cleaned too", () => {
      const bare = Object.assign(new Error("odd"), { requestBody: { content: marker }, code: 7 });
      const clean = withoutRequest(bare) as Error & Record<string, unknown>;
      expect(clean).not.toBe(bare);
      expect([clean.message, clean.code, "requestBody" in clean]).toEqual(["odd", 7, false]);
      expect(printedAll(clean)).not.toContain(marker);
    });

    test("an error whose path or url is not an http(s) URL (an fs error's path) is returned as is", () => {
      const fsError = Object.assign(new Error("ENOENT: no such file or directory, open '/data/x.json'"), { code: "ENOENT", path: "/data/x.json", syscall: "open", errno: -2 });
      expect(withoutRequest(fsError)).toBe(fsError);
      const odd = Object.assign(new Error("x"), { url: 5, path: ["http://a"] });
      expect(withoutRequest(odd)).toBe(odd);
    });

    test("a wrapper whose cause is a request-carrying error is returned as a copy with the cleaned cause", () => {
      const inner = discordError();
      const wrapper = new Error("reply failed", { cause: inner });
      Object.assign(wrapper, { code: "E_WRAPPED" });
      wrapper.name = "ReplyFailed";
      const clean = withoutRequest(wrapper) as Error & Record<string, unknown>;
      expect(clean).not.toBe(wrapper);
      expect([clean.name, clean.message, clean.code, clean.stack]).toEqual([wrapper.name, "reply failed", "E_WRAPPED", wrapper.stack]);
      expect(clean.cause).toBeInstanceOf(Error);
      expect(clean.cause).not.toBe(inner);
      // the control: the wrapper prints its cause whole (a nested body is folded past util.format's depth, so the
      // request itself is what is looked for)
      expect(printedAll(wrapper)).toContain("requestBody:");
      for (const request of ["requestBody:", "rawError:"]) expect(printedAll(clean)).not.toContain(request);
      expect(format("x", clean)).toContain("DiscordAPIError[50001]");
      expect(wrapper.cause).toBe(inner); // the original is untouched
    });

    test("a cause that is a network error, three levels down, is cleaned too", () => {
      const wrapper = new Error("a", { cause: new Error("b", { cause: new Error("c", { cause: networkError() }) }) });
      expect(printedAll(wrapper)).toContain(token);
      expect(printedAll(withoutRequest(wrapper))).not.toContain(token);
    });

    test("an AggregateError is cleaned member by member, keeping the class, the message and the clean members", () => {
      const fine = new Error("fine");
      const aggregate = new AggregateError([fine, discordError(), networkError()], "several failed");
      const clean = withoutRequest(aggregate) as AggregateError;
      expect(clean).toBeInstanceOf(AggregateError);
      expect(clean.message).toBe("several failed");
      expect(clean.errors).toHaveLength(3);
      expect(clean.errors[0]).toBe(fine);
      expect(printedAll(aggregate)).toContain("requestBody:"); // the control
      expect(printedAll(clean)).not.toContain("requestBody:");
      expect(printedAll(clean)).not.toContain(token);
    });

    test("a request-free cause chain of six errors keeps its identity, and of seven is cut at the sixth", () => {
      const chain = (length: number) => {
        let deep = new Error("leaf");
        for (let i = 1; i < length; i += 1) deep = new Error(`level ${i}`, { cause: deep });
        return deep;
      };
      const six = chain(6);
      expect(withoutRequest(six)).toBe(six); // the sixth error is at the bound and has nothing below it
      const seven = chain(7);
      const clean = withoutRequest(seven) as Error;
      expect(clean).not.toBe(seven);
      let last: Error = clean;
      let levels = 1;
      while (last.cause instanceof Error) {
        last = last.cause;
        levels += 1;
      }
      expect(levels).toBe(6);
    });

    test("the URL scheme is matched without regard to case", () => {
      const upper = Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused", path: url.replace("http://", "HTTP://") });
      const clean = withoutRequest(upper) as Error & Record<string, unknown>;
      expect(clean).not.toBe(upper);
      expect("path" in clean).toBe(false);
    });

    test("an error with no request-carrying cause comes back as it is", () => {
      const plain = new Error("x", { cause: new Error("y") });
      expect(withoutRequest(plain)).toBe(plain);
      const notAnError = new Error("x", { cause: "just text" });
      expect(withoutRequest(notAnError)).toBe(notAnError);
    });

    test("a cause cycle ends at the bound, cut off, and does not hang", () => {
      const loop = new Error("loop");
      loop.cause = loop;
      const clean = withoutRequest(loop) as Error;
      expect(clean.message).toBe("loop");
      const aggregateLoop = new AggregateError([], "agg");
      (aggregateLoop.errors as unknown[]).push(aggregateLoop);
      const cleanAggregate = withoutRequest(aggregateLoop) as AggregateError;
      expect(cleanAggregate).toBeInstanceOf(AggregateError);
      expect(cleanAggregate.message).toBe("agg");
    });

    // It runs inside catch blocks: a throw out of it would cost the user's reply and hide the real error.
    test("an error whose properties it must read and cannot is replaced by a placeholder, never thrown out of it; one it need not read is left alone", () => {
      const withGetter = (key: string) => {
        const err = new Error("x");
        Object.defineProperty(err, key, { get: () => { throw new Error(`getter ${key}`); } });
        return err;
      };
      // Read on every error: replaced. `code` and `status` are read only when a copy is made, which a throwing
      // `cause` or `path` has already ended; on an error that is no copy candidate they are never touched.
      for (const key of ["cause", "path", "url"]) {
        const replaced = withoutRequest(withGetter(key)) as Error;
        expect(replaced, key).toBeInstanceOf(Error);
        expect(replaced.message, key).toContain("could not be inspected safely");
      }
      for (const key of ["code", "status"]) {
        const untouched = withGetter(key);
        expect(withoutRequest(untouched), key).toBe(untouched);
      }
      const requestWithBadCode = Object.assign(withGetter("code"), { requestBody: { content: marker } });
      expect((withoutRequest(requestWithBadCode) as Error).message).toContain("could not be inspected safely");
      const aggregate = new AggregateError([], "agg");
      Object.defineProperty(aggregate, "errors", { get: () => { throw new Error("getter errors"); } });
      expect((withoutRequest(aggregate) as Error).message).toContain("could not be inspected safely");
      const hostile = new Proxy(new Error("proxy"), { has: () => { throw new Error("has trap"); } });
      expect((withoutRequest(hostile) as Error).message).toContain("could not be inspected safely");
    });

    test("an AggregateError with a huge sparse errors array is replaced at once, not walked", () => {
      const sparse = new AggregateError([], "sparse");
      Object.defineProperty(sparse, "errors", { value: new Array(2 ** 32 - 1) });
      const started = Date.now();
      const replaced = withoutRequest(sparse) as Error;
      expect(Date.now() - started).toBeLessThan(500);
      expect(replaced.message).toContain("could not be inspected safely");
    });

    // The budget is exactly 1000 visits: the error itself, and each error reached counts once per visit.
    test("the walk budget is exactly 1000 visits: 1000 in all is walked, 1001 is replaced", () => {
      const plain = () => new Error("plain");
      const flat = (members: number) => new AggregateError(Array.from({ length: members }, plain), "flat");
      const exactly = flat(999); // 1 + 999 = 1000 visits
      expect(withoutRequest(exactly)).toBe(exactly);
      expect((withoutRequest(flat(1000)) as Error).message).toContain("could not be inspected safely"); // 1001
      // The last visit is the one that spends the last unit: a tree of exactly 1000 visits, found by walking, not by the width guard.
      const tree = new AggregateError(Array.from({ length: 9 }, () => new AggregateError(Array.from({ length: 110 }, plain), "inner")), "outer");
      expect(withoutRequest(tree)).toBe(tree); // 1 + 9 + 9 * 110 = 1000
    });

    test("a wide, self-referencing AggregateError is bounded: it is replaced, in milliseconds", () => {
      const wide = new AggregateError([], "wide");
      for (let i = 0; i < 30; i += 1) (wide.errors as unknown[]).push(wide);
      const started = Date.now();
      const replaced = withoutRequest(wide) as Error;
      expect(Date.now() - started).toBeLessThan(500);
      expect(replaced.message).toContain("could not be inspected safely");
    });

    test("an AggregateError past the last level followed is cut off too", () => {
      let deep: unknown = new AggregateError([discordError()], "deep aggregate");
      for (let i = 0; i < 5; i += 1) deep = new Error(`level ${i}`, { cause: deep });
      expect(carriesAnywhere(deep)).toBe(true);
      const clean = withoutRequest(deep);
      expect(carriesAnywhere(clean)).toBe(false);
      let last: unknown = clean;
      while (last instanceof Error && last.cause !== undefined) last = last.cause;
      expect(last).toBeInstanceOf(AggregateError);
      expect((last as AggregateError).errors).toEqual([]);
    });

    test("a mix of a shallow and a too-deep request-carrying error is cleaned in both", () => {
      let deep: unknown = discordError();
      for (let i = 0; i < 6; i += 1) deep = new Error(`deep ${i}`, { cause: deep });
      let near: unknown = new AggregateError([discordError(), deep], "mixed");
      for (let i = 0; i < 3; i += 1) near = new Error(`near ${i}`, { cause: near });
      expect(carriesAnywhere(near)).toBe(true); // the control
      expect(carriesAnywhere(withoutRequest(near))).toBe(false);
    });

    test("a copy keeps only the properties it has: a network error gains no status or method", () => {
      const clean = withoutRequest(networkError()) as Error & Record<string, unknown>;
      expect("status" in clean).toBe(false);
      expect("method" in clean).toBe(false);
    });

    test("a request-carrying error is found up to five levels down, and what hangs below that is cut off", () => {
      const wrapped = (levels: number) => {
        let deep: unknown = discordError();
        for (let i = 0; i < levels; i += 1) deep = new Error(`level ${i}`, { cause: deep });
        return deep as Error;
      };
      const five = wrapped(5);
      expect(printedAll(five)).toContain("requestBody:");
      expect(printedAll(withoutRequest(five))).not.toContain("requestBody:");
      // Six wrappers put the request-carrying error past the last level followed: the wrapper there is copied
      // with its cause cut off, never left raw (the chain's top is a copy too, since something below it changed).
      const six = wrapped(6);
      expect(printedAll(six)).toContain("requestBody:");
      const clean = withoutRequest(six) as Error;
      expect(clean).not.toBe(six);
      expect(printedAll(clean)).not.toContain("requestBody:");
      // The six wrappers stay, named; the request-carrying error under the last one is gone, not half-cleaned.
      const chain: Error[] = [];
      for (let e: unknown = clean; e instanceof Error; e = e.cause) chain.push(e);
      expect(chain.map((e) => e.message)).toEqual(["level 5", "level 4", "level 3", "level 2", "level 1", "level 0"]);
      expect(carriesAnywhere(clean)).toBe(false);
    });
  });

  // Every Discord call each one makes -- the fetches as well as the send or edit that carries the body.
  test("post, dm and edit reject with the cleaned error whichever Discord call fails, never the request", async () => {
    const failing = async () => {
      throw discordError();
    };
    const ok = <T>(value: T) => async () => value;
    const message = (edit: () => Promise<unknown>) => ({ author: { id: "1" }, edit });
    const clientWith = (o: { channelFetch?: () => Promise<unknown>; send?: () => Promise<unknown>; messageFetch?: () => Promise<unknown>; userFetch?: () => Promise<unknown> }) => {
      const channel = { isSendable: () => true, isTextBased: () => true, send: o.send ?? ok({ id: "5", guildId: "1" }), messages: { fetch: o.messageFetch ?? ok(message(ok(undefined))) } };
      return {
        channels: { fetch: o.channelFetch ?? ok(channel) },
        users: { fetch: o.userFetch ?? ok({ send: o.send ?? ok({ id: "5", channelId: "6" }) }) },
        user: { id: "1" },
      } as unknown as import("discord.js").Client;
    };
    const cases: [string, () => Promise<unknown>][] = [
      ["post: the channel fetch", () => sendPayloadToChannel(clientWith({ channelFetch: failing }), "1", payload)],
      ["post: the send", () => sendPayloadToChannel(clientWith({ send: failing }), "1", payload)],
      ["dm: the user fetch", () => sendPayloadDm(clientWith({ userFetch: failing }), "9", payload)],
      ["dm: the send", () => sendPayloadDm(clientWith({ send: failing }), "9", payload)],
      ["edit: the channel fetch", () => editOwnMessage(clientWith({ channelFetch: failing }), "1", "2", payload)],
      ["edit: the message fetch", () => editOwnMessage(clientWith({ messageFetch: failing }), "1", "2", payload)],
      ["edit: the edit", () => editOwnMessage(clientWith({ messageFetch: ok(message(failing)) }), "1", "2", payload)],
    ];
    for (const [label, call] of cases) {
      const thrown = (await call().then(
        () => undefined,
        (err: unknown) => err,
      )) as (Error & Record<string, unknown>) | undefined;
      expect(thrown?.code, label).toBe(50001);
      expect(thrown !== undefined && "requestBody" in thrown, label).toBe(false);
    }
  });
});

describe("editOwnMessage", () => {
  const BOT_ID = "111000";

  function fakeClientWith(message: { author: { id: string }; edit: (p: unknown) => Promise<void> } | undefined) {
    const channel = {
      isTextBased: () => true,
      messages: {
        fetch: async () => {
          if (message === undefined) throw new Error("Unknown Message");
          return message;
        },
      },
    };
    return { channels: { fetch: async () => channel }, user: { id: BOT_ID } } as unknown as import("discord.js").Client;
  }

  test("edits a message this bot authored, passing the payload through unchanged", async () => {
    const editCalls: unknown[] = [];
    const client = fakeClientWith({ author: { id: BOT_ID }, edit: async (p) => void editCalls.push(p) });
    await editOwnMessage(client, "222", "333", payload);
    expect(editCalls).toEqual([payload]);
  });

  test("refuses a message this bot did not author, without calling edit", async () => {
    const editCalls: unknown[] = [];
    const client = fakeClientWith({ author: { id: "someone-else" }, edit: async (p) => void editCalls.push(p) });
    await expect(editOwnMessage(client, "222", "333", payload)).rejects.toThrow("message was not sent by this bot");
    expect(editCalls).toEqual([]);
  });

  test("refuses a missing message", async () => {
    const client = fakeClientWith(undefined);
    await expect(editOwnMessage(client, "222", "333", payload)).rejects.toThrow();
  });

  test("throws when the channel is not text-based", async () => {
    const client = {
      channels: { fetch: async () => ({ isTextBased: () => false }) },
      user: { id: BOT_ID },
    } as unknown as import("discord.js").Client;
    await expect(editOwnMessage(client, "222", "333", payload)).rejects.toThrow(/not a text channel/);
  });
});

describe("fetchMember", () => {
  const clientWith = (memberFetch: (o: unknown) => Promise<unknown>, seen: unknown[] = []) =>
    ({
      guilds: {
        fetch: async (id: string) => {
          seen.push(id);
          if (id === "404") throw new DiscordAPIError({ message: "Unknown Guild", code: 10004 }, 10004, 404, "GET", "https://discord.com/api/v10/guilds/404", {});
          return { available: id !== "503", members: { fetch: async (o: unknown) => (seen.push(o), memberFetch(o)) }, roles: { cache: new Map([["r1", {}], ["r2", {}]]) } };
        },
      },
    }) as unknown as import("discord.js").Client;

  test("forces a fresh fetch and returns the member's and the server's role ids", async () => {
    const seen: unknown[] = [];
    const client = clientWith(async () => ({ roles: { cache: new Map([["r1", {}]]) } }), seen);
    expect(await fetchMember(client, "1", "9")).toEqual({ roleIds: ["r1"], guildRoleIds: ["r1", "r2"] });
    expect(seen).toEqual(["1", { user: "9", force: true, cache: false }]);
  });

  test("a server it cannot fetch, or one Discord reports unavailable, rejects rather than answering null", async () => {
    const client = clientWith(async () => ({ roles: { cache: new Map() } }));
    const unknown = (await fetchMember(client, "404", "9").catch((e: unknown) => e)) as Error & Record<string, unknown>;
    expect(unknown.code).toBe(10004);
    await expect(fetchMember(client, "503", "9")).rejects.toThrow("server 503 is unavailable");
  });

  test("Unknown Member and Unknown User mean not in the server: null", async () => {
    for (const code of [10007, 10013]) {
      const err = new DiscordAPIError({ message: "Unknown", code }, code, 404, "GET", "https://discord.com/api/v10/guilds/1/members/9", {});
      expect(await fetchMember(clientWith(async () => { throw err; }), "1", "9")).toBeNull();
    }
  });

  test("any other failure rejects with the cleaned error, never the request", async () => {
    const err = new DiscordAPIError({ message: "Missing Access", code: 50001 }, 50001, 403, "GET", "https://discord.com/api/v10/guilds/1/members/9", { body: { secret: 1 } });
    const thrown = (await fetchMember(clientWith(async () => { throw err; }), "1", "9").catch((e: unknown) => e)) as Error & Record<string, unknown>;
    expect(thrown.code).toBe(50001);
    expect("requestBody" in thrown).toBe(false);
  });
});
