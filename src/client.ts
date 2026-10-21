import { Client, GatewayIntentBits, Partials, type ClientOptions } from "discord.js";

// Every send made through this Client defaults to no mentions parsed, so user-controlled text
// that lands in a public reply (e.g. the wow plugin's /transmog character option, #48) can't ping anyone. A call
// site that needs a real ping opts in explicitly, per-message (see updateReport.ts's viaChannel).
// The one send path that doesn't go through this Client at all — updateReport.ts's viaToken,
// a raw REST().post() — sets the same default on its own body for the same reason.
export const CLIENT_OPTIONS: ClientOptions = {
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [] },
};

// What the Client gets when nothing else says otherwise — before plugins existed, this was the
// only intent set there ever was. src/index.ts now passes collectIntents(CORE_INTENTS, selected).
export const CORE_INTENTS: number[] = [GatewayIntentBits.Guilds];

// A DM channel is rarely in the cache when its first message arrives, and discord.js drops a
// messageCreate whose channel it cannot resolve unless the Channel partial is on. So the partial
// comes with the DirectMessages intent (a plugin's directMessage seam, contract.ts), and only then:
// a bot that never takes DMs keeps exactly the client options it always had.
export function clientOptions(intents: readonly number[] = CORE_INTENTS): ClientOptions {
  const dms = intents.includes(GatewayIntentBits.DirectMessages);
  return { ...CLIENT_OPTIONS, intents: [...intents], ...(dms ? { partials: [Partials.Channel] } : {}) };
}

export function createClient(intents: number[] = CORE_INTENTS): Client {
  return new Client(clientOptions(intents));
}
