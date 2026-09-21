// Which slash commands go to which server (ADR-0006), and the calls that put them there.
//
// The governing rule of #239, the first child that changes what the bot does: with no `routing.json`,
// or one that places no plugin, the bot makes EXACTLY the registration call it made before routing
// existed -- one PUT, to the home guild or to the global scope, carrying the full command body
// unchanged. Everything routed sits behind `hasPlacements(routing)`.
//
// The body is built ONCE (`buildCommandBody` in `plugins/host.ts` runs every plugin's `build()` once)
// and a per-server body is only a FILTERED VIEW of that array by owning plugin. Plugin code is never
// run once per server, and a builder that fails is logged once, not once per server.
//
// Pure planning (`planRegistration`) is separate from the one function that does I/O
// (`registerPlan`, through an injected `put`), so the planning tests as data and the registration
// tests against a fake `put` -- no discord.js `Client` and no network.

import { Routes, type RESTPostAPIChatInputApplicationCommandsJSONBody as CommandJson } from "discord.js";
import type { PluginCommandMap } from "../plugins/host";
import type { RoutingFile } from "./model";
import { hasPlacements, pluginsForGuild } from "./resolve";

/**
 * The plugin that owns a built command, or null for a core command. `builtName` is the name as
 * registered -- with `COMMAND_PREFIX` on the front, which is stripped to find the bare name the
 * command map is keyed by.
 */
export function ownerOf(builtName: string, prefix: string, commandMap: PluginCommandMap): string | null {
  const bare = builtName.startsWith(prefix) ? builtName.slice(prefix.length) : builtName;
  return commandMap.get(bare)?.entry.name ?? null;
}

export type RegistrationPlan =
  | { mode: "single"; scope: "guild"; guildId: string; body: CommandJson[] }
  | { mode: "single"; scope: "global"; body: CommandJson[] }
  | { mode: "routed"; bodies: Map<string, CommandJson[]>; clearGlobal: boolean };

/**
 * `single`: nothing is placed, so today's one call -- `guild` when there is a home server, `global`
 * when there is not -- carrying `fullBody` untouched (same contents, same order).
 *
 * `routed`: for every server the bot is in, in the order given, that server's body is every entry of
 * `fullBody` that is a core command or belongs to a plugin living there, in `fullBody`'s order. Core
 * commands go everywhere (ADR-0006 decision 2), and a server nobody lives in gets the core commands
 * only. `clearGlobal` is set only with no home server: a bot that was registering globally has to
 * empty the global scope once it goes per-server, or every command would show twice.
 */
export function planRegistration(opts: {
  routing: RoutingFile;
  fullBody: readonly CommandJson[];
  prefix: string;
  commandMap: PluginCommandMap;
  loaded: readonly string[];
  guildIds: readonly string[];
  homeGuildId: string | undefined;
}): RegistrationPlan {
  const { routing, fullBody, prefix, commandMap, loaded, guildIds, homeGuildId } = opts;
  if (!hasPlacements(routing)) {
    return homeGuildId !== undefined
      ? { mode: "single", scope: "guild", guildId: homeGuildId, body: [...fullBody] }
      : { mode: "single", scope: "global", body: [...fullBody] };
  }
  const bodies = new Map<string, CommandJson[]>();
  for (const guildId of guildIds) {
    const living = new Set(pluginsForGuild(routing, guildId, loaded, homeGuildId));
    bodies.set(
      guildId,
      fullBody.filter((command) => {
        const owner = ownerOf(command.name, prefix, commandMap);
        return owner === null || living.has(owner);
      }),
    );
  }
  return { mode: "routed", bodies, clearGlobal: homeGuildId === undefined };
}

/** What one registration call did. `guildId` is "global" for the global scope. */
export interface GuildRegistration {
  guildId: string | "global";
  registered: number;
  error?: string;
  at: string;
}

const MAX_ERROR_LENGTH = 200;

/** What is recorded against "global" when the empty put was skipped because every server refused. */
const NOT_EMPTIED = "not attempted: no server accepted its commands";

/**
 * A failure as one line of text for `discovery.json` and the log: `<message> (<code>)` for a Discord
 * API error (duck-typed on a numeric `code`, so no discord.js class is needed), else `String(err)`,
 * clipped to 200 characters. Never throws.
 */
export function describeError(err: unknown): string {
  let text: string;
  try {
    const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
    const message = typeof err === "object" && err !== null ? (err as { message?: unknown }).message : undefined;
    text = typeof code === "number" ? `${typeof message === "string" ? message : String(err)} (${code})` : String(err);
  } catch {
    text = "unknown error";
  }
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 3)}...` : text;
}

/**
 * Carries a plan out. `single` issues exactly one `put` and LETS A FAILURE THROW: the caller keeps
 * today's `catch` and its long operator message. `routed` issues one `put` per server, sequentially
 * (a burst of PUTs invites a 429), each in its own try/catch, then -- when `clearGlobal` -- one
 * final `put` that empties the global scope, also guarded. A failure there is recorded against that
 * server (or "global") and the loop carries on; routed mode never throws.
 *
 * The global scope is emptied only once at least one server has taken its own commands. It is what
 * serves every server that has not been given a list of its own, so emptying it when nothing
 * replaced it -- no servers were read, or every one refused -- would leave the bot with no commands
 * anywhere until the next boot. In the second case that is recorded against "global" instead.
 */
export async function registerPlan(
  put: (route: `/${string}`, body: CommandJson[]) => Promise<unknown>,
  appId: string,
  plan: RegistrationPlan,
  now: () => Date,
): Promise<GuildRegistration[]> {
  if (plan.mode === "single") {
    const route = plan.scope === "guild" ? Routes.applicationGuildCommands(appId, plan.guildId) : Routes.applicationCommands(appId);
    await put(route, plan.body);
    return [{ guildId: plan.scope === "guild" ? plan.guildId : "global", registered: plan.body.length, at: now().toISOString() }];
  }

  const results: GuildRegistration[] = [];
  for (const [guildId, body] of plan.bodies) {
    try {
      await put(Routes.applicationGuildCommands(appId, guildId), body);
      results.push({ guildId, registered: body.length, at: now().toISOString() });
    } catch (err) {
      results.push({ guildId, registered: 0, error: describeError(err), at: now().toISOString() });
    }
  }
  if (plan.clearGlobal) {
    if (results.some((r) => r.error === undefined)) {
      try {
        await put(Routes.applicationCommands(appId), []);
      } catch (err) {
        // Reported only on failure: a global list that could not be emptied means every command may
        // show twice, which is worth surfacing; a successful empty has nothing to say.
        results.push({ guildId: "global", registered: 0, error: describeError(err), at: now().toISOString() });
      }
    } else if (results.length > 0) {
      // Servers were tried and every one refused: the global list is still all they have.
      results.push({ guildId: "global", registered: 0, error: NOT_EMPTIED, at: now().toISOString() });
    }
    // No servers at all: nothing to replace it with, and nothing to say -- a bot in no server has no
    // one to show a command twice.
  }
  return results;
}
