import { describe, expect, test } from "bun:test";
import { GatewayIntentBits, Partials } from "discord.js";
import { CLIENT_OPTIONS, CORE_INTENTS, clientOptions, createClient } from "./client";

describe("CLIENT_OPTIONS", () => {
  // #48: user-controlled text (e.g. /transmog's character option) can reach a public reply.
  // Without this default, discord.js falls back to Discord's parse-everything behavior for any
  // send that doesn't set its own allowedMentions — pinging users/roles the bot never meant to.
  test("defaults to no mentions parsed, so untrusted text in a reply can't ping anyone", () => {
    expect(CLIENT_OPTIONS.allowedMentions?.parse).toEqual([]);
  });
});

describe("createClient", () => {
  test("with no argument, keeps exactly the Guilds intent (pre-plugins behavior)", () => {
    const client = createClient();
    expect(client.options.intents.bitfield).toBe(GatewayIntentBits.Guilds);
  });

  test("CORE_INTENTS is exactly [Guilds]", () => {
    expect(CORE_INTENTS).toEqual([GatewayIntentBits.Guilds]);
  });

  test("a passed intent list is what the Client actually gets", () => {
    const client = createClient([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]);
    expect(client.options.intents.has(GatewayIntentBits.Guilds)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
  });

  test("still defaults to no mentions parsed regardless of the intents passed", () => {
    const client = createClient([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]);
    expect(client.options.allowedMentions?.parse).toEqual([]);
  });
});

describe("clientOptions", () => {
  // A DM's channel is usually uncached, and without the Channel partial discord.js drops its messageCreate.
  test("the DirectMessages intent brings the Channel partial with it", () => {
    const options = clientOptions([GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages]);
    expect(options.partials).toEqual([Partials.Channel]);
    const client = createClient([GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages]);
    expect(client.options.partials).toEqual([Partials.Channel]);
    expect(client.options.intents.has(GatewayIntentBits.DirectMessages)).toBe(true);
  });

  test("an intent value that carries the DirectMessages bit among others counts too", () => {
    const combined = GatewayIntentBits.DirectMessages | GatewayIntentBits.GuildMessages;
    expect(clientOptions([GatewayIntentBits.Guilds, combined]).partials).toEqual([Partials.Channel]);
  });

  test("without it the options are exactly what they were: no partials", () => {
    expect(clientOptions()).toEqual({ ...CLIENT_OPTIONS, intents: [GatewayIntentBits.Guilds] });
    expect("partials" in clientOptions([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages])).toBe(false);
  });
});
