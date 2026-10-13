import { describe, expect, test } from "bun:test";
import { format } from "node:util";
import { DiscordAPIError, HTTPError } from "discord.js";
import { editOwnMessage, sendPayloadDm, sendPayloadToChannel, withoutRequest } from "./delivery";
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
