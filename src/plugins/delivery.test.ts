import { describe, expect, test } from "bun:test";
import { DiscordAPIError } from "discord.js";
import { editOwnMessage, sendPayloadDm, sendPayloadToChannel } from "./delivery";
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
