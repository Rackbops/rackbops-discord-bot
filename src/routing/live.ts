// The one stateful routing module: it holds what `index.ts` handed it at boot and runs the two
// things that touch Discord and the disk -- registering commands and writing `discovery.json` --
// through ONE serialized chain.
//
// Why serialized: the request mailbox (#241) calls `applyRouting` and `refreshDiscovery`, while a boot
// registration or a periodic discovery refresh may be in flight. Two interleaved runs would each read
// the routing file, each PUT to the same servers, and race on discovery.json. Everything that
// re-registers or rewrites discovery therefore goes through `enqueue`, and a second call waits behind
// the first.
//
// A server the bot joins or leaves after boot (#259) goes through the same chain: `guildJoined`
// registers again (routed mode, or a join of the home server) or only refreshes discovery (single mode),
// `guildLeft` refreshes discovery.
//
// Registration stays inside the bot's existing contract that a failure never takes it down: in
// `single` mode (today's behaviour) the error is rethrown once `discovery.json` has been written (it
// is not written when the bot's servers could not be read), so `index.ts` reaches its own long
// `catch`; in `routed` mode nothing here ever throws. The failure is written against the home
// server's entry -- when the bot can see that server. A failure of the global scope (no home server)
// has no entry to go on, and `DiscoveryFile` has no other slot for it, so that one reaches the
// operator through `index.ts`'s message only.

import type { Client, RESTPostAPIChatInputApplicationCommandsJSONBody as CommandJson } from "discord.js";
import type { PluginCommandMap } from "../plugins/host";
import { buildDiscovery, snapshotGuilds, writeDiscovery, type GuildSnapshot, type PluginSummary } from "./discovery";
import type { RoutingFile } from "./model";
import { describeError, planRegistration, registerPlan, type GuildRegistration } from "./register";
import { hasPlacements, isPlaced, shown } from "./resolve";
import { readRouting } from "./store";

export interface RoutingContext {
  client: Client<true>;
  put: (route: `/${string}`, body: CommandJson[]) => Promise<unknown>;
  appId: string;
  /** The bot's own name, for `discovery.json`. */
  botUsername: string;
  dataDir: string;
  homeGuildId: string | undefined;
  prefix: string;
  fullBody: readonly CommandJson[];
  commandMap: PluginCommandMap;
  plugins: readonly PluginSummary[];
  now: () => Date;
  log: Pick<Console, "log" | "warn" | "error">;
}

export type ApplyResult = { mode: "single" | "routed"; results: GuildRegistration[] };

let context: RoutingContext | undefined;
let lastRegistrations: GuildRegistration[] = [];
let chain: Promise<unknown> = Promise.resolve();
// What `applyRouting` has already said about the home server (#260): every join, leave-and-return and
// routing change registers again, so the same problem would otherwise be said each time.
const said = new Set<string>();

/** Stashes what registration needs. Called once, at boot, before the first `applyRouting`. */
export function initRouting(ctx: RoutingContext): void {
  context = ctx;
  lastRegistrations = [];
}

function required(): RoutingContext {
  if (context === undefined) throw new Error("routing used before initRouting()");
  return context;
}

/** Runs `job` after everything already queued has settled, whether that succeeded or failed. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job);
  // The stored chain never rejects, so one failed job cannot stop the ones behind it.
  chain = next.catch(() => {});
  return next;
}

/** The servers the bot is in, or null when they could not be read. A failure here is logged and must
 *  not stop `single` mode's one PUT (which needs no server list), so it is contained. It is NOT
 *  the same as "no servers": the caller plans with none, so a routed run registers nowhere, and
 *  writes no `discovery.json`, so a passing failure never blanks the file the panel is showing. */
function takeSnapshots(c: RoutingContext): GuildSnapshot[] | null {
  try {
    return snapshotGuilds(c.client);
  } catch (err) {
    c.log.error("[routing] could not read the bot's servers from Discord's cache", err);
    return null;
  }
}

/** Builds and writes `discovery.json`. A failure is logged and swallowed: it is a view for the panel,
 *  never a reason to fail a registration or a refresh. `why` names what was being done. */
async function writeView(
  c: RoutingContext,
  snapshots: readonly GuildSnapshot[],
  registrations: readonly GuildRegistration[],
  why: string,
): Promise<void> {
  try {
    const file = buildDiscovery({
      now: c.now(),
      bot: { id: c.appId, username: c.botUsername },
      homeGuildId: c.homeGuildId,
      snapshots,
      registrations,
      plugins: c.plugins,
    });
    await writeDiscovery(c.dataDir, file);
  } catch (err) {
    c.log.error(`[routing] writing discovery.json failed (${why}) -- the panel keeps the last copy it has`, err);
  }
}

/** The routed-mode log lines. ASCII only in what this code writes; a server's name is whatever
 *  Discord calls it. */
function logRouted(c: RoutingContext, snapshots: readonly GuildSnapshot[], results: readonly GuildRegistration[]): void {
  const names = new Map(snapshots.map((s) => [s.id, s.name]));
  const nameOf = (id: string): string => names.get(id) ?? id;
  const servers = results.filter((r) => r.guildId !== "global");
  const done = servers.filter((r) => r.error === undefined);
  c.log.log(
    `Registered commands in ${done.length} server${done.length === 1 ? "" : "s"}` +
      (done.length > 0 ? ` (${done.map((r) => `${nameOf(r.guildId)}: ${r.registered}`).join(", ")})` : ""),
  );
  for (const r of servers) {
    if (r.error !== undefined) c.log.error(`[routing] couldn't register commands in ${nameOf(r.guildId)} (${r.guildId}): ${r.error}`);
  }
  for (const r of results) {
    if (r.guildId === "global" && r.error !== undefined) {
      c.log.error(`[routing] the global command list was not emptied (${r.error}), so commands may show twice`);
    }
  }
}

/**
 * Routed mode only: a plugin nobody has placed lives in the home server, so when `DISCORD_SERVER_ID` names
 * a server the bot is not in (kicked, or a typo) those plugins are registered nowhere, and nothing else
 * says so (`discovery.json` shows `homeGuildId` with no matching guild, which the panel does not read that
 * way yet). Said once per distinct message; a log line, nothing about what is registered changes. Nothing
 * is said when the bot's servers could not be read (`snapshots` is null), when there is no home server, or
 * when every loaded plugin that has commands is placed.
 */
function warnHomeServerMissing(c: RoutingContext, routing: RoutingFile, snapshots: readonly GuildSnapshot[] | null): void {
  if (c.homeGuildId === undefined || snapshots === null) return;
  if (snapshots.some((s) => s.id === c.homeGuildId)) return;
  // A plugin with no commands has nothing to register (its announcements go to the default channel by id,
  // whatever server that is in), so it loses nothing and is not named.
  const nowhere = c.plugins.filter((p) => p.commands.length > 0 && !isPlaced(routing, p.name)).map((p) => p.name);
  if (nowhere.length === 0) return;
  const message =
    `[routing] the home server ${shown(c.homeGuildId)} is not one the bot is in, so these plugins, ` +
    `which nobody has placed, are registered nowhere: ${nowhere.join(", ")}`;
  if (said.has(message)) return;
  said.add(message);
  try {
    c.log.warn(message);
  } catch {
    /* routed mode "never throws": a logger that does must not turn a finished registration into a failure */
  }
}

/**
 * Read routing, plan, register, write discovery. Serialized: a second call queues behind the first.
 * `reason` says why it ran (it names the trigger in a discovery write failure). Resolves with the mode
 * the plan took, so `index.ts` prints today's `Registered N slash commands` line only for `single`.
 *
 * `single` mode registers exactly as before routing existed and rethrows a failure once discovery has
 * been written (against the home server's entry when the bot can see it -- see the header for what it
 * cannot record); `routed` mode never throws.
 */
export function applyRouting(reason: string): Promise<ApplyResult> {
  return enqueue(async () => {
    const c = required();
    const routing = await readRouting(c.dataDir);
    const snapshots = takeSnapshots(c);
    const plan = planRegistration({
      routing,
      fullBody: c.fullBody,
      prefix: c.prefix,
      commandMap: c.commandMap,
      loaded: c.plugins.map((p) => p.name),
      guildIds: (snapshots ?? []).map((s) => s.id),
      homeGuildId: c.homeGuildId,
    });

    let results: GuildRegistration[];
    let failure: { error: unknown } | undefined;
    if (plan.mode === "single") {
      try {
        results = await registerPlan(c.put, c.appId, plan, c.now);
      } catch (err) {
        failure = { error: err };
        results = [
          {
            guildId: plan.scope === "guild" ? plan.guildId : "global",
            registered: 0,
            error: describeError(err),
            at: c.now().toISOString(),
          },
        ];
      }
    } else {
      results = await registerPlan(c.put, c.appId, plan, c.now);
    }

    lastRegistrations = results;
    // After registering, not before: the file carries what each server was actually told.
    if (snapshots !== null) await writeView(c, snapshots, results, reason);
    if (plan.mode === "routed") {
      logRouted(c, snapshots ?? [], results);
      warnHomeServerMissing(c, routing, snapshots);
    }
    if (failure !== undefined) throw failure.error;
    return { mode: plan.mode, results };
  });
}

/** Re-snapshot the servers and rewrite `discovery.json` with the registrations already made. Before
 *  `initRouting` there is nothing to describe yet, so it does nothing. Serialized on the same chain. */
export function refreshDiscovery(): Promise<void> {
  return enqueue(async () => {
    if (context === undefined) return;
    const snapshots = takeSnapshots(context);
    if (snapshots !== null) await writeView(context, snapshots, lastRegistrations, "refresh");
  });
}

/** A server as it is named in a log line. Total, so a malformed argument cannot make a catch block throw. */
const label = (guild: { id: string; name: string }): string => `${guild?.name} (${guild?.id})`;

/**
 * Writes through the context's logger. A logger that throws must neither hold up the work nor turn a join
 * or a leave into a rejection, so this is where that is swallowed: there is nothing left to tell it to. The
 * logger is read outside the `try` on purpose: a missing context is a bug to be seen, not one to be
 * swallowed here.
 */
function tell(c: RoutingContext, level: "log" | "error", message: string, err?: unknown): void {
  const log = c.log;
  try {
    if (level === "error") log.error(message, err);
    else log.log(message);
  } catch {
    /* the logger is broken too */
  }
}

/**
 * The bot has joined a server (discord.js `guildCreate`). In routed mode the new server has no commands
 * until something registers there, so this registers again -- the whole run, through `applyRouting`, the
 * one path that is already serialized, recorded and tested -- which also rewrites `discovery.json`, so the
 * file the panel reads lists the server within seconds.
 *
 * In single mode registration goes to ONE place, the home server's guild (or everywhere, when there is no
 * home server), and a join does not change where; only discovery is refreshed. The exception is a join OF
 * the home server: a bot that was not in it at boot (so that registration was refused) and is invited
 * later, or one that was removed from it and is added back, has nothing registered there until that is done
 * again -- it is understood that Discord drops a server's commands when the bot leaves it, which is not
 * verified against a live server -- and single mode's one call is exactly that registration, so this runs
 * it. Re-authorizing a bot that is still a member (the usual cure for a 50001) emits no join at all, and
 * still waits for the next registration. With a home server set, any other joined server gets no commands
 * in single mode, as before; with none, the global list already reaches it.
 *
 * The mode is decided HERE, from a fresh read of routing.json, and NOT inside the chain: `applyRouting`
 * and `refreshDiscovery` each queue themselves on it, so calling either from inside a queued job would
 * wait on itself forever. A join that arrives while the boot registration is running queues behind it.
 * Before `initRouting` it does nothing: the boot registration that follows snapshots the cache, which
 * already holds the new server.
 *
 * Never rejects. It is called from an event listener, where a rejection is a process-level event, and
 * `applyRouting` CAN reject here: single mode rethrows a failed registration, and this run is a single-mode
 * one when nothing is placed (a join of the home server with no placements, or a last placement removed
 * between the read and the call).
 */
export async function guildJoined(guild: { id: string; name: string }): Promise<void> {
  const c = context;
  if (c === undefined) return;
  try {
    tell(c, "log", `[routing] joined ${label(guild)}`);
    const routing = await readRouting(c.dataDir);
    if (hasPlacements(routing) || guild.id === c.homeGuildId) await applyRouting(`joined ${guild.name}`);
    else await refreshDiscovery();
  } catch (err) {
    tell(c, "error", `[routing] handling the join of ${label(guild)} failed`, err);
  }
}

/**
 * The bot has left a server (discord.js `guildDelete`: kicked, or the server is gone -- an outage is a
 * different event). The server stops being offered because discovery is rewritten from what the bot can
 * see now. routing.json is NOT touched: being kicked and re-invited must not lose a placement. (A server
 * that is in routing but not in discovery is one the panel has to be able to show as unavailable; the
 * panel's Servers tab, #246, is the child that builds that view, and its issue text does not yet list this
 * case.) Before `initRouting` it does nothing. Never rejects, for the reason `guildJoined` gives.
 */
export async function guildLeft(guild: { id: string; name: string }): Promise<void> {
  const c = context;
  if (c === undefined) return;
  try {
    tell(c, "log", `[routing] left ${label(guild)}`);
    await refreshDiscovery();
  } catch (err) {
    tell(c, "error", `[routing] handling the departure from ${label(guild)} failed`, err);
  }
}

/** Resolves once everything queued so far has settled. For tests, which need to wait for a refresh
 *  they started without awaiting it (the `discovery` tick check does not wait for its refresh). */
export function routingIdleForTest(): Promise<void> {
  return chain.then(() => {});
}

export function resetRoutingForTest(): void {
  context = undefined;
  lastRegistrations = [];
  chain = Promise.resolve();
  said.clear();
}
