// Which slash commands go to which server (ADR-0006), and the calls that put them there.
//
// The governing rule of #239, the first child that changes what the bot does: with no `routing.json`,
// or one that places no plugin, the bot makes EXACTLY the registration call it made before routing
// existed -- one PUT, to the home guild or to the global scope, carrying the full command body
// unchanged -- plus, once, the empties a routed past requires (#420: the scopes an earlier run gave a list of
// their own, as the previous `discovery.json` records them). Everything routed sits behind `hasPlacements(routing)`.
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
import type { DiscoveryFile, RoutingFile } from "./model";
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

/** What the previous `discovery.json` says the bot still owns (#420): guild ids whose record shows a list may be
 *  there, and whether the global scope does. From `previousScopes(file)`; `NO_PREVIOUS` when there is no file. */
export interface PreviousScopes {
  guilds: readonly string[];
  global: boolean;
}
export const NO_PREVIOUS: PreviousScopes = { guilds: [], global: false };

/** A record shows a list may be there when it was ever registered (`registered > 0`) or the last call failed
 *  (`error`: whatever was there before stayed). A successful empty (`registered: 0`, no error) shows nothing is. */
export function previousScopes(file: DiscoveryFile | null): PreviousScopes {
  if (file === null) return NO_PREVIOUS;
  // Defensive on purpose: readDiscovery (#482) checks the guild and channel elements but not `commands`, so a
  // non-object `commands` still comes through, and this runs BEFORE single mode's one PUT -- a damaged view must never stop it.
  const owned = (r: unknown): boolean =>
    typeof r === "object" &&
    r !== null &&
    ((typeof (r as { registered?: unknown }).registered === "number" && (r as { registered: number }).registered > 0) ||
      (r as { error?: unknown }).error !== undefined);
  const guilds = Array.isArray(file.guilds) ? file.guilds : [];
  return {
    // De-duplicated: a damaged file listing a guild twice must not empty it twice.
    guilds: [
      ...new Set(
        guilds
          .filter((g): g is DiscoveryFile["guilds"][number] => typeof g === "object" && g !== null && typeof g.id === "string" && owned(g.commands))
          .map((g) => g.id),
      ),
    ],
    global: owned(file.global),
  };
}

export type RegistrationPlan =
  | { mode: "single"; scope: "guild"; guildId: string; body: CommandJson[]; clears: string[]; clearGlobal: boolean }
  | { mode: "single"; scope: "global"; body: CommandJson[]; clears: string[]; clearGlobal: false }
  | { mode: "routed"; bodies: Map<string, CommandJson[]>; clears: []; clearGlobal: boolean };

/**
 * `single`: nothing is placed, so today's one call -- `guild` when there is a home server, `global`
 * when there is not -- carrying `fullBody` untouched (same contents, same order). Before it, once, come the
 * empties an earlier run's records require (#420): every server (other than the home server) whose previous
 * record shows a list of its own and that the bot is still in, and -- with a home server -- the global scope
 * when it was last registered to. `previous` is `NO_PREVIOUS` on a first boot, which makes exactly today's call.
 *
 * `routed`: for every server the bot is in, in the order given, that server's body is every entry of
 * `fullBody` that is a core command or belongs to a plugin living there, in `fullBody`'s order. Core
 * commands go everywhere (ADR-0006 decision 2), and a server nobody lives in gets the core commands
 * only. `clearGlobal` is set with no home server -- a bot that was registering globally has to empty the
 * global scope once it goes per-server, or every command would show twice -- and also when the previous
 * record says a global list is there (a bot that ran global, then got a home server).
 */
export function planRegistration(opts: {
  routing: RoutingFile;
  fullBody: readonly CommandJson[];
  prefix: string;
  commandMap: PluginCommandMap;
  loaded: readonly string[];
  guildIds: readonly string[];
  homeGuildId: string | undefined;
  previous: PreviousScopes;
}): RegistrationPlan {
  const { routing, fullBody, prefix, commandMap, loaded, guildIds, homeGuildId, previous } = opts;
  const inSnapshot = new Set(guildIds);
  // #420: a scope this run does not write keeps whatever it had. The guilds an earlier routed run gave a list of
  // their own, and a global list an earlier run registered, are emptied -- once; the next discovery.json records
  // the empty and they are not candidates again. A guild the bot has left cannot be reached and is not tried.
  const staleGuilds = (except?: string): string[] => previous.guilds.filter((id) => id !== except && inSnapshot.has(id));
  if (!hasPlacements(routing)) {
    return homeGuildId !== undefined
      ? { mode: "single", scope: "guild", guildId: homeGuildId, body: [...fullBody], clears: staleGuilds(homeGuildId), clearGlobal: previous.global }
      : { mode: "single", scope: "global", body: [...fullBody], clears: staleGuilds(), clearGlobal: false };
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
  // No home server: the global list is what served every server until now (as before). With one: only a global
  // list an earlier global-mode run left behind.
  return { mode: "routed", bodies, clears: [], clearGlobal: homeGuildId === undefined || previous.global };
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
export const NOT_EMPTIED = "not attempted: no server accepted its commands";

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

export interface RegistrationOutcome {
  results: GuildRegistration[];
  /** Single mode's PRIMARY call failed: the thrown value, as thrown (`undefined` included, hence the wrapper).
   *  `applyRouting` rethrows it once discovery is written. Never set for a clear, never set in routed mode. */
  failure?: { error: unknown };
}

/**
 * Carries a plan out and NEVER THROWS. Every call is guarded and recorded against its scope. The order: the
 * plan's empties first (`clears`, then the global scope for a `single` plan with `clearGlobal` -- a scope that
 * keeps a stale list while the new one lands would show both), then the primary call(s): `single` issues one
 * `put`, `routed` one per server, sequentially (a burst of PUTs invites a 429), then -- when `clearGlobal` --
 * one final `put` that empties the global scope. A failed call is recorded against its scope (`registered: 0`
 * and the error, which also keeps the scope a candidate for the next run) and the run carries on. Single
 * mode's PRIMARY call failing is returned as `failure` (the thrown value, wrapped so `undefined` survives) for
 * the caller to rethrow once discovery is written; a failed empty is never `failure`.
 *
 * The global scope is emptied only once at least one server has taken its own commands. It is what
 * serves every server that has not been given a list of its own, so emptying it when nothing
 * replaced it -- no servers were read, or every one refused -- would leave the bot with no commands
 * anywhere until the next registration. In the second case that is recorded against "global" instead.
 * "At least one" is deliberate: requiring EVERY server to succeed would let one that refuses for good
 * (Discord's 50001) keep the global list, and so double every command everywhere, on every boot. The
 * price is that a server that failed for a passing reason while others succeeded has no commands
 * until the next full registration run (the next boot, or a routing change from the panel); it is in the
 * log and in `discovery.json` with its error. A server the bot JOINS is registered alone (`applyRoutingFor`),
 * so a join no longer retries the servers that failed (#482).
 *
 * A successful routed empty of the global scope is recorded too (`{ guildId: "global", registered: 0 }`):
 * that record is what tells the next run the scope is clean, and what `buildDiscovery` puts in `global`.
 */
export async function registerPlan(
  put: (route: `/${string}`, body: CommandJson[]) => Promise<unknown>,
  appId: string,
  plan: RegistrationPlan,
  now: () => Date,
): Promise<RegistrationOutcome> {
  const results: GuildRegistration[] = [];
  let caught: { error: unknown } | undefined;
  // `caught` is read only when the PRIMARY call failed, and `attempt` has just overwritten it then, so a clear's
  // failure can never be reported as the primary's.
  const attempt = async (guildId: string | "global", route: `/${string}`, body: CommandJson[]): Promise<boolean> => {
    try {
      await put(route, body);
      results.push({ guildId, registered: body.length, at: now().toISOString() });
      return true;
    } catch (err) {
      caught = { error: err };
      results.push({ guildId, registered: 0, error: describeError(err), at: now().toISOString() });
      return false;
    }
  };
  // #420: the empties first -- a scope that keeps a stale list while the new one lands would show both.
  for (const guildId of plan.clears) await attempt(guildId, Routes.applicationGuildCommands(appId, guildId), []);
  if (plan.mode === "single") {
    if (plan.clearGlobal) await attempt("global", Routes.applicationCommands(appId), []);
    const ok = await attempt(
      plan.scope === "guild" ? plan.guildId : "global",
      plan.scope === "guild" ? Routes.applicationGuildCommands(appId, plan.guildId) : Routes.applicationCommands(appId),
      plan.body,
    );
    return ok ? { results } : { results, failure: caught };
  }
  for (const [guildId, body] of plan.bodies) await attempt(guildId, Routes.applicationGuildCommands(appId, guildId), body);
  if (plan.clearGlobal) {
    const servers = results.filter((r) => r.guildId !== "global");
    if (servers.some((r) => r.error === undefined)) await attempt("global", Routes.applicationCommands(appId), []);
    // Servers were tried and every one refused: the global list is still all they have. With no servers at all
    // there is nothing to replace it with and nothing to say -- a bot in no server has no one to show a command twice.
    else if (servers.length > 0) results.push({ guildId: "global", registered: 0, error: NOT_EMPTIED, at: now().toISOString() });
  }
  return { results };
}
