import { describe, expect, test } from "bun:test";
import { customIdPrefix, describeInteraction, interactionLogLine, type InteractionLike } from "./interactionLog";
import { jsonLogLine } from "./logFormat";

// #328: the one line per interaction. index.ts can't run under test, so its wiring is pinned in
// index.test.ts; what is tested here is what a line may and may not carry.

const USER = "222222222222222222";
const GUILD = "999999999999999999";
const CHANNEL = "888888888888888888";
const SECRET = "Pick-up-the-dry-cleaning-4471";

function fake(kind: "command" | "component" | "modal" | "autocomplete", o: Partial<InteractionLike> = {}): InteractionLike {
  return {
    user: { id: USER },
    guildId: null,
    channelId: "dm-channel",
    isChatInputCommand: () => kind === "command",
    isMessageComponent: () => kind === "component",
    isModalSubmit: () => kind === "modal",
    ...o,
  };
}

/** A command's options as discord.js reads them, holding `SECRET` as a typed value. */
function options(sub: string | null, group: string | null = null) {
  return {
    getSubcommandGroup: () => group,
    getSubcommand: () => sub,
    getString: () => SECRET,
    data: [{ name: "text", value: SECRET }],
    toString: () => SECRET,
  };
}

describe("describeInteraction + interactionLogLine", () => {
  test("a command in a DM: its name, the user, dm, the outcome and the duration", () => {
    const facts = describeInteraction(fake("command", { commandName: "web", options: options(null) }));
    expect(facts).not.toBeNull();
    expect(interactionLogLine(facts!, "answered", 41.6)).toBe(`[interaction] command /web user=${USER} where=dm outcome=answered 42ms`);
  });

  test("a command in a server names the guild and the channel; subcommand group and name follow the command", () => {
    const facts = describeInteraction(fake("command", { commandName: "task", options: options("done", "admin"), guildId: GUILD, channelId: CHANNEL }));
    expect(interactionLogLine(facts!, "gated", 3)).toBe(
      `[interaction] command /task admin done user=${USER} where=guild:${GUILD}/channel:${CHANNEL} outcome=gated 3ms`,
    );
  });

  test("never an option value: a command carrying a distinctive value logs none of it", () => {
    for (const o of [options("remind"), options(null), { getSubcommand: () => { throw new Error(SECRET); }, getSubcommandGroup: () => null }, SECRET]) {
      const facts = describeInteraction(fake("command", { commandName: "remind", options: o }));
      const line = interactionLogLine(facts!, "answered", 1);
      expect(line).not.toContain(SECRET);
      expect(line).toContain("command /remind");
    }
  });

  test("a component or a modal logs only its customId's prefix, never the rest of the id", () => {
    const button = describeInteraction(fake("component", { customId: `tracker:d.o.${SECRET}` }));
    expect(interactionLogLine(button!, "answered", 5)).toBe(`[interaction] component tracker user=${USER} where=dm outcome=answered 5ms`);
    const modal = describeInteraction(fake("modal", { customId: `tracker:reply:${SECRET}` }));
    expect(interactionLogLine(modal!, "unclaimed", 0)).toBe(`[interaction] modal tracker user=${USER} where=dm outcome=unclaimed 0ms`);
  });

  test("a hostile prefix is quoted and bounded, so it cannot forge a line; no colon is (none)", () => {
    expect(customIdPrefix("a b\n[interaction] command /x:rest")).toBe(JSON.stringify("a b\n[interaction] command /x"));
    expect(customIdPrefix(`${"x".repeat(60)}:y`)).toBe(JSON.stringify(`${"x".repeat(37)}...`));
    expect(customIdPrefix("nocolon")).toBe("(none)");
    expect(customIdPrefix("report:abc")).toBe("report");
  });

  test("autocomplete (and anything else) writes no line", () => {
    expect(describeInteraction(fake("autocomplete", { commandName: "remind" }))).toBeNull();
  });

  test("a negative or non-finite duration is 0ms", () => {
    const facts = describeInteraction(fake("command", { commandName: "web" }))!;
    expect(interactionLogLine(facts, "error", -5)).toEndWith("outcome=error 0ms");
    expect(interactionLogLine(facts, "error", Number.NaN)).toEndWith("outcome=error 0ms");
  });

  test("under LOG_FORMAT=json the line is one JSON object", () => {
    const line = interactionLogLine(describeInteraction(fake("command", { commandName: "web" }))!, "answered", 7);
    const parsed = JSON.parse(jsonLogLine("info", [line], new Date("2026-09-30T00:00:00Z")));
    expect(parsed).toEqual({ time: "2026-09-30T00:00:00.000Z", level: "info", msg: line });
  });
});
