// #328: one log line per interaction, written by index.ts's InteractionCreate handler, so every
// command, button press and modal submit shows in the log -- for every plugin, with no plugin
// changing. Before this, only an exception reached the log (`[interaction]`), so a command that
// answered normally left no trace at all. The line is written once the interaction is handled or, for
// a command that ends the process (`/update`, `/plugins ... update ... now`, a self-update's retire),
// right before the process exits (#446, `createInteractionLine`): never twice, and never not at all.
//
// What a line may carry is deliberately narrow: the kind, the command's name (with its subcommand
// group and subcommand, which are names from the command's own definition), or a component's or
// modal's customId PREFIX only (the plugin's name; the rest of the id is the plugin's own data), the
// user's Discord id, where it ran, the outcome and the duration. Never an option value, a modal
// field or a reply's content: those hold personal data (a reminder's text) and secrets (a sign-in
// link), and none of them is read here.

import { shown } from "./routing/resolve";

export type InteractionKind = "command" | "component" | "modal";

/**
 * - `answered`: a handler ran and returned (what it answered is the handler's business).
 * - `gated`: the routing gate refused a plugin command in this channel (#243).
 * - `unclaimed`: nothing handles it -- no command by that name, a plugin command whose plugin is not
 *   running (#407, refused privately), or a component/modal no running plugin claims.
 * - `error`: a handler threw; the error itself is logged separately, as before (and, since #545, without
 *   the interaction token or the reply it carried).
 * - `exiting`: the process is exiting -- a requested restart, or a stop -- before the handler returned
 *   (#446). Written by the exit hook index.ts registers, so `/update` and `/plugins ... update ... now`,
 *   which end the process inside their handler, still leave a line.
 */
export type InteractionOutcome = "answered" | "gated" | "unclaimed" | "error" | "exiting";

/** The parts of an interaction a line is built from -- read by `describeInteraction`, nothing else. */
export interface InteractionFacts {
  kind: InteractionKind;
  name: string;
  userId: string;
  guildId: string | null;
  channelId: string | null;
}

/** What `describeInteraction` reads off a discord.js interaction; the names match discord.js's. */
export interface InteractionLike {
  user: { id: string };
  guildId: string | null;
  channelId: string | null;
  isChatInputCommand(): boolean;
  isMessageComponent(): boolean;
  isModalSubmit(): boolean;
  commandName?: string;
  customId?: string;
  /** Read only for a chat-input command, and only its subcommand names (`subcommandOf`). */
  options?: unknown;
}

type SubcommandReader = { getSubcommandGroup(required: false): string | null; getSubcommand(required: false): string | null };

/** The subcommand group and subcommand names, when the options carry them; never an option value. */
function subcommandOf(options: unknown): string[] {
  const o = options as Partial<SubcommandReader> | null | undefined;
  if (typeof o?.getSubcommandGroup !== "function" || typeof o.getSubcommand !== "function") return [];
  try {
    return [o.getSubcommandGroup(false), o.getSubcommand(false)].filter((p): p is string => typeof p === "string" && p !== "");
  } catch {
    return [];
  }
}

/**
 * A component's or modal's customId prefix -- the plugin (or `report`) it belongs to. A plain name
 * is shown as is; anything else (a customId comes from a message, so it is not trusted) is bounded
 * and quoted, so it can never break the line or forge another one.
 */
export function customIdPrefix(customId: string): string {
  const i = customId.indexOf(":");
  if (i === -1) return "(none)";
  const prefix = customId.slice(0, i);
  return /^[A-Za-z0-9_.-]{1,40}$/.test(prefix) ? prefix : JSON.stringify(shown(prefix));
}

/**
 * The facts for one interaction, or null for a kind this log skips (autocomplete, which fires on
 * every keystroke, and anything else that is not a command, component or modal). Pure, and never
 * throws: index.ts calls it before its try, so a surprise here answers null (no line), never an
 * unhandled rejection.
 */
export function describeInteraction(i: InteractionLike): InteractionFacts | null {
  try {
    return describe(i);
  } catch {
    return null;
  }
}

function describe(i: InteractionLike): InteractionFacts | null {
  const where = { userId: i.user.id, guildId: i.guildId, channelId: i.channelId };
  if (i.isChatInputCommand()) {
    // Subcommand names come from the command's definition, never from what the person typed. A
    // command without one answers null here (discord.js: `getSubcommand(false)`).
    const name = [`/${i.commandName ?? "?"}`, ...subcommandOf(i.options)].join(" ");
    return { kind: "command", name, ...where };
  }
  if (i.isModalSubmit()) return { kind: "modal", name: customIdPrefix(i.customId ?? ""), ...where };
  if (i.isMessageComponent()) return { kind: "component", name: customIdPrefix(i.customId ?? ""), ...where };
  return null;
}

/**
 * The line itself: `[interaction] command /task done user=<id> where=dm outcome=answered 42ms`, or
 * `where=guild:<guild id>/channel:<channel id>` in a server. Under `LOG_FORMAT=json` it becomes the
 * `msg` of one JSON object (logFormat.ts), like every other line. Pure.
 */
export function interactionLogLine(facts: InteractionFacts, outcome: InteractionOutcome, ms: number): string {
  const where = facts.guildId === null ? "dm" : `guild:${facts.guildId}/channel:${facts.channelId ?? "?"}`;
  const took = Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0;
  return `[interaction] ${facts.kind} ${facts.name} user=${facts.userId} where=${where} outcome=${outcome} ${took}ms`;
}

/**
 * #328/#446: the one writer of an interaction's line. Returns `line(outcome)`, which writes
 * `interactionLogLine(facts, outcome, now() - started)` through `write` the FIRST time it is called and
 * nothing after -- so the exit hook and the handler's `finally` can both call it and exactly one line
 * lands, whichever fires first. With `facts` null (autocomplete) it writes nothing. `started` is read when
 * this is called, so call it where the handling begins.
 */
export function createInteractionLine(
  facts: InteractionFacts | null,
  write: (line: string) => void,
  now: () => number = Date.now,
): (outcome: InteractionOutcome) => void {
  const started = now();
  let logged = false;
  return (outcome) => {
    if (logged || facts === null) return;
    logged = true;
    write(interactionLogLine(facts, outcome, now() - started));
  };
}
