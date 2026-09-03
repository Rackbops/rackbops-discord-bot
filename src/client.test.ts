import { describe, expect, test } from "bun:test";
import { CLIENT_OPTIONS } from "./client";

describe("CLIENT_OPTIONS", () => {
  // #48: user-controlled text (e.g. /transmog's character option) can reach a public reply.
  // Without this default, discord.js falls back to Discord's parse-everything behavior for any
  // send that doesn't set its own allowedMentions — pinging users/roles the bot never meant to.
  test("defaults to no mentions parsed, so untrusted text in a reply can't ping anyone", () => {
    expect(CLIENT_OPTIONS.allowedMentions?.parse).toEqual([]);
  });
});
