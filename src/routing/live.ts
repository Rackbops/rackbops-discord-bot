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
// registers the joined server alone (routed mode, `applyRoutingFor`, #482), runs the full registration for a
// join of the home server, or only refreshes discovery (single mode), `guildLeft` refreshes discovery.
//
// Registration stays inside the bot's existing contract that a failure never takes it down: in
// `single` mode (today's behaviour) the error is rethrown once `discovery.json` has been written (it
// is not written when the bot's servers could not be read), so `index.ts` reaches its own long
// `catch`; in `routed` mode nothing here throws once routing and the previous discovery have been read (a read
// that fails for a reason other than a parse error rejects, #509; a logger that throws is swallowed by `tell`).
// The failure is written against the home server's entry -- when the bot can see that server -- and a
// failure of the global scope (no home server) in the file's `global` slot (#482).

import type { Client, RESTPostAPIChatInputApplicationCommandsJSONBody as CommandJson } from "discord.js";
import type { PluginCommandMap } from "../plugins/host";
import { buildDiscovery, readDiscovery, snapshotGuilds, writeDiscovery, type GuildSnapshot, type PluginSummary } from "./discovery";
import { clip, type RoutingFile } from "./model";
import {
  NOT_EMPTIED,
  NO_PREVIOUS,
  planRegistration,
  previousScopes,
  registerPlan,
  type GuildRegistration,
  type RegistrationPlan,
} from "./register";
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
// Whether a FULL registration run has completed in this process (#482): a join registers the joined server alone
// only on top of one, else it would rewrite `discovery.json` with that one record and erase what `previousScopes`
// depends on. A routed run that could not read the servers, or none at all, leaves it false.
let fullRunDone = false;
let chain: Promise<unknown> = Promise.resolve();
// What `applyRouting` has already said about the home server (#260): every join, leave-and-return and
// routing change registers again, so the same problem would otherwise be said each time.
const said = new Set<string>();

/** Stashes what registration needs. Called once, at boot, before the first `applyRouting`. */
export function initRouting(ctx: RoutingContext): void {
  context = ctx;
  lastRegistrations = [];
  fullRunDone = false;
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
    tell(c, "error", "[routing] could not read the bot's servers from Discord's cache", err);
    return null;
  }
}

/** Builds and writes `discovery.json`. A failure is logged and swallowed: it is a view for the panel,
 *  never a reason to fail a registration or a refresh. `why` names what was being done. Resolves `true` when the
 *  file was written, `false` when the write failed (#484: `refreshDiscovery` reports it; a registration ignores it). */
async function writeView(
  c: RoutingContext,
  snapshots: readonly GuildSnapshot[],
  registrations: readonly GuildRegistration[],
  why: string,
): Promise<boolean> {
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
    return true;
  } catch (err) {
    tell(c, "error", `[routing] writing discovery.json failed (${why}) -- the panel keeps the last copy it has`, err);
    return false;
  }
}

/** The routed-mode log lines, all through `tell` so a logger that throws cannot reject a finished registration (#421).
 *  ASCII only in what this code writes; a server's name is whatever Discord calls it, made one bounded line. */
function logRouted(c: RoutingContext, snapshots: readonly GuildSnapshot[], results: readonly GuildRegistration[]): void {
  const names = new Map(snapshots.map((s) => [s.id, s.name]));
  const nameOf = (id: string): string => logName(names.get(id) ?? id);
  const servers = results.filter((r) => r.guildId !== "global");
  const done = servers.filter((r) => r.error === undefined);
  tell(
    c,
    "log",
    `Registered commands in ${done.length} server${done.length === 1 ? "" : "s"}` +
      (done.length > 0 ? ` (${done.map((r) => `${nameOf(r.guildId)}: ${r.registered}`).join(", ")})` : ""),
  );
  for (const r of servers) {
    if (r.error !== undefined) tell(c, "error", `[routing] couldn't register commands in ${nameOf(r.guildId)} (${r.guildId}): ${r.error}`);
  }
  for (const r of results) {
    if (r.guildId !== "global" || r.error === undefined) continue;
    if (r.error === NOT_EMPTIED) {
      // No server took a list, so the global one is the only one and nothing shows twice.
      tell(c, "error", `[routing] the global command list was left as it is: no server accepted its commands`);
    } else {
      tell(c, "error", `[routing] the global command list was not emptied (${r.error}), so commands may show twice`);
    }
  }
}

/** A record that was one of the plan's EMPTIES (never the primary call; routed mode's global empty is logRouted's). */
function isClear(plan: RegistrationPlan, id: string): boolean {
  return (plan.clears as readonly string[]).includes(id) || (id === "global" && plan.mode === "single" && plan.clearGlobal);
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
  try {
    c.log.warn(message);
    said.add(message);
  } catch {
    /* A logger that throws must not turn a finished registration into a failure (`logRouted` goes through `tell`
       for the same reason); it is not recorded as said, so the next registration tries again. */
  }
}

/**
 * Read routing, plan, register, write discovery. Serialized: a second call queues behind the first.
 * `reason` says why it ran (it names the trigger in a discovery write failure). Resolves with the mode
 * the plan took, so `index.ts` prints today's `Registered N slash commands` line only for `single`.
 *
 * `single` mode registers as before routing existed -- plus, once, the empties a routed past requires
 * (#420) -- and rethrows a failure of its primary call once discovery has been written (against the home
 * server's entry when the bot can see it, or in `global` for the global scope); `routed` mode throws only if
 * reading routing does (#509).
 */
export function applyRouting(reason: string): Promise<ApplyResult> {
  return enqueue(async () => {
    const c = required();
    const routing = await readRouting(c.dataDir);
    return fullRun(c, reason, routing, takeSnapshots(c));
  });
}

/** The body of `applyRouting`, run inside a queued job (never call the exported `applyRouting` from one: it
 *  queues behind itself). `routing` and `snapshots` are what the job read. */
async function fullRun(c: RoutingContext, reason: string, routing: RoutingFile, snapshots: GuildSnapshot[] | null): Promise<ApplyResult> {
  // #420: what the last published file says the bot still owns; nothing when there is none (a first boot). The
  // file is a VIEW: an unreadable one is said and treated as none, never allowed to stop the PUT below. One that parses but fails `readDiscovery`'s shape check (#482) reads as `null` WITHOUT a line, so this run skips its empties; it rewrites the file when the servers could be read, and the next run then has a valid record again.
  let previous = NO_PREVIOUS;
  try {
    previous = previousScopes(await readDiscovery(c.dataDir));
  } catch (err) {
    tell(
      c,
      "error",
      "[routing] could not read the previous discovery.json; registering as if there were none (a server an earlier routed run owned keeps its list until the next run that can read it)",
      err,
    );
  }
  const plan = planRegistration({
    routing,
    fullBody: c.fullBody,
    prefix: c.prefix,
    commandMap: c.commandMap,
    loaded: c.plugins.map((p) => p.name),
    guildIds: (snapshots ?? []).map((s) => s.id),
    homeGuildId: c.homeGuildId,
    previous,
  });
  const { results, failure } = await registerPlan(c.put, c.appId, plan, c.now);
  // A failed EMPTY is said, in both modes (nothing logged it in single mode; in routed mode logRouted names the
  // global one itself, so isClear excludes routed's global). The primary call is never a clear.
  for (const r of results) {
    if (r.error !== undefined && isClear(plan, r.guildId)) {
      const who = r.guildId === "global" ? "the global scope" : label(snapshots?.find((s) => s.id === r.guildId) ?? { id: r.guildId, name: r.guildId });
      tell(c, "error", `[routing] could not empty the stale command list of ${who}: ${r.error} (it is tried again at the next registration run)`);
    }
  }
  // #484 item 5: a routed run that could not read the servers registered nowhere and learned nothing; keep what the
  // last run that did knew. Single mode's one call needs no server list and did happen.
  if (plan.mode === "single" || snapshots !== null) {
    lastRegistrations = results;
    fullRunDone = true;
  }
  // After registering, not before: the file carries what each server was actually told.
  if (snapshots !== null) await writeView(c, snapshots, results, reason);
  if (plan.mode === "routed") {
    logRouted(c, snapshots ?? [], results);
    warnHomeServerMissing(c, routing, snapshots);
  }
  if (failure !== undefined) throw failure.error;
  return { mode: plan.mode, results };
}

/**
 * A server the bot has joined, in routed mode (#482 item 5): registers THAT server alone and merges its outcome
 * into what the last full run recorded, then rewrites `discovery.json`. Falls back to the full run, in the same
 * job, when it cannot be narrow: no full run has completed in this process yet, nothing is placed (single mode),
 * the servers could not be read, or the guild is not among them. A server whose earlier PUT failed is therefore
 * retried at the next full run (a boot, or a panel `routing-set`), no longer at the next join; a global empty that
 * the last full run could not do is still retried here.
 */
export function applyRoutingFor(guildId: string, reason: string): Promise<ApplyResult> {
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
      previous: NO_PREVIOUS,
    });
    const body = plan.mode === "routed" ? plan.bodies.get(guildId) : undefined;
    if (!fullRunDone || plan.mode !== "routed" || snapshots === null || body === undefined) {
      return fullRun(c, reason, routing, snapshots);
    }
    // A global empty the last full run could not do (it failed, or no server took a list) is retried here: the
    // joined server may be the first to take one, and its own list on top of a leftover global one shows twice.
    // registerPlan still empties only once a server has taken its commands.
    const globalPending = lastRegistrations.some((r) => r.guildId === "global" && r.error !== undefined);
    const { results } = await registerPlan(
      c.put,
      c.appId,
      { mode: "routed", bodies: new Map([[guildId, body]]), clears: [], clearGlobal: globalPending },
      c.now,
    );
    // Each new record replaces the earlier one for its scope (the joined server's, and the global one if retried).
    lastRegistrations = [...lastRegistrations.filter((r) => !results.some((n) => n.guildId === r.guildId)), ...results];
    await writeView(c, snapshots, lastRegistrations, reason);
    logRouted(c, snapshots, results);
    return { mode: "routed" as const, results };
  });
}

/** Re-snapshot the servers and rewrite `discovery.json` with the registrations already made. Before
 *  `initRouting` there is nothing to describe yet, so it does nothing. Serialized on the same chain. Resolves
 *  `true` when `discovery.json` was written; `false` before `initRouting` (no log line), when the servers could not
 *  be read, or when the write failed (both logged) -- a `discovery-refresh` request is refused on `false` (#484). */
export function refreshDiscovery(): Promise<boolean> {
  return enqueue(async () => {
    if (context === undefined) return false;
    const snapshots = takeSnapshots(context);
    if (snapshots === null) return false;
    return writeView(context, snapshots, lastRegistrations, "refresh");
  });
}

// U+FFFD, built from its code point (the form resolve.ts uses; a typed escape is normalised by the editing tools).
const REPLACEMENT = String.fromCharCode(0xfffd);

/** A name from Discord as one bounded line (#485 item 8): at most 80 units, every control character (C0, DEL, C1)
 *  replaced, so a server named with a newline and a forged `[routing]` line cannot start a second line. Total. */
function logName(value: unknown): string {
  return clip(String(value), 80).replace(/\p{Cc}/gu, REPLACEMENT);
}

/** A server as it is named in a log line. Total, so a malformed argument cannot make a catch block throw. */
const label = (guild: { id: string; name: string }): string => `${logName(guild?.name)} (${guild?.id})`;

/**
 * Writes through the context's logger. A logger that throws must neither hold up the work nor turn a join
 * or a leave into a rejection, so this is where that is swallowed: there is nothing left to tell it to. The
 * logger is read outside the `try` on purpose: a missing context is a bug to be seen, not one to be
 * swallowed here.
 */
function tell(c: RoutingContext, level: "log" | "error", message: string, err?: unknown): void {
  const log = c.log;
  try {
    // `err` only when there is one: `log.error(message, undefined)` prints a trailing " undefined".
    if (level === "error") err === undefined ? log.error(message) : log.error(message, err);
    else log.log(message);
  } catch {
    /* the logger is broken too */
  }
}

/**
 * The bot has joined a server (discord.js `guildCreate`). In routed mode the new server has no commands
 * until something registers there, so this registers THAT server alone (`applyRoutingFor`, #482; the full run
 * when it cannot be narrow) on the already serialized chain, and rewrites `discovery.json`, so the file the
 * panel reads lists the server within seconds. The price: a server whose earlier PUT failed is retried at the
 * next full run (a boot, or a panel routing change), no longer at the next join.
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
 * `applyRouting` (and `applyRoutingFor`, which falls back to the same full run) CAN reject here: single mode
 * rethrows a failed registration, and this run is a single-mode one when nothing is placed (a join of the home
 * server with no placements, or a last placement removed between the read and the call).
 */
export async function guildJoined(guild: { id: string; name: string }): Promise<void> {
  const c = context;
  if (c === undefined) return;
  try {
    tell(c, "log", `[routing] joined ${label(guild)}`);
    const routing = await readRouting(c.dataDir);
    // Routed: only the joined server is registered (#482). A join of the home server in single mode is the full
    // run: single mode's one call IS that registration.
    if (hasPlacements(routing)) await applyRoutingFor(guild.id, `joined ${logName(guild.name)}`);
    else if (guild.id === c.homeGuildId) await applyRouting(`joined ${logName(guild.name)}`);
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

/** Forgets the context, the last registrations and the home-server warnings said. Leaves the queue
 *  alone (that is `resetRoutingQueueForTest`), so a job a test leaked still reaches the guard. */
export function resetRoutingForTest(): void {
  context = undefined;
  lastRegistrations = [];
  fullRunDone = false;
  said.clear();
}

/** The test-state guard's own (test/stateGuard.ts): starts a fresh queue. The guard runs this once
 *  it has waited for the queue, so a job that never finishes can't hold every later test up. A job
 *  still running is not stopped, only no longer waited for — so not for a test's own cleanup, where
 *  it would hide a leaked job from the guard: a test awaits its jobs instead. */
export function resetRoutingQueueForTest(): void {
  chain = Promise.resolve();
}

/** What the test-state guard (test/stateGuard.ts) reads here: `initialized` and `said`, which
 *  `resetRoutingForTest` resets, and `chain`, handed over as is — the guard asks whether it is still
 *  pending (which `resetRoutingQueueForTest` drops). `lastRegistrations` is left out:
 *  nothing reads it without a `context` (`refreshDiscovery` does nothing before `initRouting`), and
 *  `initRouting` clears it — so a leftover value cannot reach a later test, unless a job was still
 *  running when the queue was reset (see test/stateGuardHook.ts's queue caveat), which guarding
 *  this field would not catch either. */
export interface RoutingStateForTest {
  initialized: boolean;
  said: number;
  chain: Promise<unknown>;
}

export function routingStateForTest(): RoutingStateForTest {
  return { initialized: context !== undefined, said: said.size, chain };
}
