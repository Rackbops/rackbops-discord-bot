import { GatewayIntentBits } from "discord.js";
import type { PluginDirectMessage } from "./contract";
import { withoutRequest } from "./delivery";
import type { BaseLog, LoadedPlugin } from "./host";

/**
 * The direct-message seam (contract.ts, `Plugin.directMessage`): the one gateway event the host
 * hands to plugins. index.ts's MessageCreate listener calls `dispatchDirectMessage` for every
 * message the Client sees; only a DM a person sent reaches a plugin, and only a running plugin
 * whose index entry declares the `DirectMessages` intent and that implements `directMessage`.
 */

/** The fields of a discord.js `Message` this module reads, so it can be tested without a Client. */
export interface DirectMessageSource {
  id: string;
  content: string;
  createdAt: Date;
  guildId: string | null;
  system: boolean;
  webhookId: string | null;
  author: { id: string; bot: boolean };
  channel: { sendTyping(): Promise<unknown> };
}

/** A person's DM to the bot, or `null` for anything else: a server message, a bot's (this bot's
 *  own replies included), a webhook's, or a system message. */
export function toDirectMessage(message: DirectMessageSource): PluginDirectMessage | null {
  if (message.guildId !== null || message.system || message.webhookId !== null || message.author.bot) return null;
  const channel = message.channel;
  return {
    userId: message.author.id,
    messageId: message.id,
    content: message.content,
    sentAt: message.createdAt.toISOString(),
    typing: () => channel.sendTyping().then(
      () => undefined,
      () => undefined,
    ),
  };
}

/** Whether `lp` takes DMs: its index entry declares the intent. Implementing the hook is checked at call time. */
export function takesDirectMessages(lp: LoadedPlugin): boolean {
  return (lp.entry.intents ?? []).some((intent) => (intent & GatewayIntentBits.DirectMessages) !== 0);
}

/**
 * Hands one message to every plugin that takes DMs, each isolated: a throw or rejection is logged
 * under the plugin's name, without the message, and the others still get it. Resolves once every
 * plugin has settled; never rejects. Logs nothing about the message itself -- no text, no user id.
 */
export async function dispatchDirectMessage(
  loaded: readonly LoadedPlugin[],
  message: DirectMessageSource,
  log: BaseLog,
): Promise<number> {
  const dm = toDirectMessage(message);
  if (!dm) return 0;
  let handed = 0;
  await Promise.all(
    loaded.filter((lp) => lp.running && takesDirectMessages(lp)).map(async (lp) => {
      try {
        // Plugin-controlled and only type-asserted: read inside the try, as dispatchPluginInteraction does (#470).
        const hook = lp.plugin.directMessage;
        if (typeof hook !== "function") return;
        handed++;
        await hook.call(lp.plugin, { ...dm });
      } catch (err) {
        log.error(`[plugins] ${lp.entry.name} directMessage failed`, withoutRequest(err));
      }
    }),
  );
  return handed;
}
