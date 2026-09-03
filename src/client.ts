import { Client, GatewayIntentBits, type ClientOptions } from "discord.js";

// Every send made through this Client defaults to no mentions parsed, so user-controlled text
// that lands in a public reply (e.g. /transmog's character option, #48) can't ping anyone. A call
// site that needs a real ping opts in explicitly, per-message (see updateReport.ts's viaChannel).
// The one send path that doesn't go through this Client at all — updateReport.ts's viaToken,
// a raw REST().post() — sets the same default on its own body for the same reason.
export const CLIENT_OPTIONS: ClientOptions = {
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [] },
};

export function createClient(): Client {
  return new Client(CLIENT_OPTIONS);
}
