import { describe, expect, test } from "bun:test";
import { GatewayIntentBits } from "discord.js";
import type { Plugin, PluginDirectMessage, PluginIndexEntry } from "./contract";
import { dispatchDirectMessage, takesDirectMessages, toDirectMessage, type DirectMessageSource } from "./directMessages";
import type { LoadedPlugin } from "./host";

const DM = GatewayIntentBits.DirectMessages;

function source(over: Partial<DirectMessageSource> = {}): DirectMessageSource & { typed: number } {
  const s = {
    typed: 0,
    id: "1300000000000000001",
    content: "track the price of Wingspan",
    createdAt: new Date("2026-10-21T04:00:00.000Z"),
    guildId: null,
    system: false,
    webhookId: null,
    author: { id: "1200000000000000001", bot: false },
    channel: {
      sendTyping: async () => {
        s.typed++;
      },
    },
    ...over,
  };
  return s;
}

function loaded(name: string, plugin: Plugin, intents?: number[], running = true): LoadedPlugin {
  const entry = { name, intents } as unknown as PluginIndexEntry;
  return { entry, version: "1.0.0", plugin, running };
}

function quietLog() {
  const errors: unknown[][] = [];
  return { log: { info() {}, warn() {}, error: (...a: unknown[]) => void errors.push(a) }, errors };
}

describe("toDirectMessage", () => {
  test("a person's DM becomes plain data: user, message id, text and time", () => {
    const dm = toDirectMessage(source());
    expect(dm).toMatchObject({
      userId: "1200000000000000001",
      messageId: "1300000000000000001",
      content: "track the price of Wingspan",
      sentAt: "2026-10-21T04:00:00.000Z",
    });
  });

  test("server messages, bots (this one included), webhooks and system messages are dropped", () => {
    expect(toDirectMessage(source({ guildId: "1100000000000000001" }))).toBeNull();
    expect(toDirectMessage(source({ author: { id: "1", bot: true } }))).toBeNull();
    expect(toDirectMessage(source({ webhookId: "1400000000000000001" }))).toBeNull();
    expect(toDirectMessage(source({ system: true }))).toBeNull();
  });

  test("typing() shows the indicator in that DM and never rejects", async () => {
    const s = source();
    await toDirectMessage(s)?.typing();
    expect(s.typed).toBe(1);
    const failing = source({ channel: { sendTyping: () => Promise.reject(new Error("Missing Access")) } });
    await expect(toDirectMessage(failing)?.typing() as Promise<void>).resolves.toBeUndefined();
  });
});

describe("takesDirectMessages", () => {
  test("only an entry declaring the DirectMessages intent takes DMs", () => {
    expect(takesDirectMessages(loaded("a", {}, [DM]))).toBe(true);
    expect(takesDirectMessages(loaded("a", {}, [GatewayIntentBits.GuildMessages]))).toBe(false);
    expect(takesDirectMessages(loaded("a", {}, []))).toBe(false);
    expect(takesDirectMessages(loaded("a", {}))).toBe(false);
  });
});

describe("dispatchDirectMessage", () => {
  test("hands the DM to every running plugin that declares the intent and has the hook, and to no other", async () => {
    const got: Record<string, PluginDirectMessage[]> = { a: [], b: [], noIntent: [], stopped: [] };
    const hook = (name: string) => async (m: PluginDirectMessage) => void got[name]?.push(m);
    const { log, errors } = quietLog();
    const handed = await dispatchDirectMessage(
      [
        loaded("a", { directMessage: hook("a") }, [DM]),
        loaded("b", { directMessage: hook("b") }, [DM]),
        loaded("noIntent", { directMessage: hook("noIntent") }, []),
        loaded("stopped", { directMessage: hook("stopped") }, [DM], false),
        loaded("noHook", {}, [DM]),
      ],
      source(),
      log,
    );
    expect(handed).toBe(2);
    expect(got.a?.map((m) => m.content)).toEqual(["track the price of Wingspan"]);
    expect(got.b?.length).toBe(1);
    expect(got.noIntent?.length).toBe(0);
    expect(got.stopped?.length).toBe(0);
    expect(errors).toEqual([]);
  });

  test("each plugin gets its own copy, so one cannot change what another sees", async () => {
    const seen: string[] = [];
    const { log } = quietLog();
    await dispatchDirectMessage(
      [
        loaded("a", { directMessage: async (m) => void (m.content = "changed") }, [DM]),
        loaded("b", { directMessage: async (m) => void seen.push(m.content) }, [DM]),
      ],
      source(),
      log,
    );
    expect(seen).toEqual(["track the price of Wingspan"]);
  });

  test("a throwing plugin is logged by name, without the message, and the others still get it", async () => {
    const got: string[] = [];
    const { log, errors } = quietLog();
    const handed = await dispatchDirectMessage(
      [
        loaded("bad", { directMessage: async () => Promise.reject(new Error("boom")) }, [DM]),
        loaded("good", { directMessage: async (m) => void got.push(m.messageId) }, [DM]),
      ],
      source(),
      log,
    );
    expect(handed).toBe(2);
    expect(got).toEqual(["1300000000000000001"]);
    expect(errors.length).toBe(1);
    expect(String(errors[0]?.[0])).toBe("[plugins] bad directMessage failed");
    expect(JSON.stringify(errors)).not.toContain("Wingspan");
    expect(JSON.stringify(errors)).not.toContain("1200000000000000001");
  });

  test("a message that is not a person's DM reaches nobody", async () => {
    let calls = 0;
    const { log } = quietLog();
    const handed = await dispatchDirectMessage(
      [loaded("a", { directMessage: async () => void calls++ }, [DM])],
      source({ guildId: "1100000000000000001" }),
      log,
    );
    expect(handed).toBe(0);
    expect(calls).toBe(0);
  });
});
