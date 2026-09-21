// The one stateful routing module: it holds what `index.ts` handed it at boot and runs the two
// things that touch Discord and the disk -- registering commands and writing `discovery.json` --
// through ONE serialized chain.
//
// Why serialized: the next child (#241) calls `applyRouting` from the request mailbox, while a boot
// registration or a periodic discovery refresh may be in flight. Two interleaved runs would each read
// the routing file, each PUT to the same servers, and race on discovery.json. Everything that
// re-registers or rewrites discovery therefore goes through `enqueue`, and a second call waits behind
// the first.
//
// Registration stays inside the bot's existing contract that a failure never takes it down: in
// `single` mode (today's behaviour) the error is rethrown AFTER discovery has recorded it, so
// `index.ts` reaches its own long `catch`; in `routed` mode nothing here ever throws.

import type { Client, RESTPostAPIChatInputApplicationCommandsJSONBody as CommandJson } from "discord.js";
import type { PluginCommandMap } from "../plugins/host";
import { buildDiscovery, snapshotGuilds, writeDiscovery, type GuildSnapshot, type PluginSummary } from "./discovery";
import { describeError, planRegistration, registerPlan, type GuildRegistration } from "./register";
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

/** The servers the bot is in. A view for the panel and the plan's server list must never be the reason
 *  a registration cannot happen, so a failure here is logged and reads as "no servers". */
function takeSnapshots(c: RoutingContext): GuildSnapshot[] {
  try {
    return snapshotGuilds(c.client);
  } catch (err) {
    c.log.error("[routing] could not read the bot's servers from Discord's cache", err);
    return [];
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
      c.log.error(`[routing] couldn't empty the global command list, so commands may show twice: ${r.error}`);
    }
  }
}

/**
 * Read routing, plan, register, write discovery. Serialized: a second call queues behind the first.
 * `reason` says why it ran (it names the trigger in a discovery write failure). Resolves with the mode
 * the plan took, so `index.ts` prints today's `Registered N slash commands` line only for `single`.
 *
 * `single` mode registers exactly as before routing existed and rethrows a failure after recording it
 * in discovery; `routed` mode never throws.
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
      guildIds: snapshots.map((s) => s.id),
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
    await writeView(c, snapshots, results, reason);
    if (plan.mode === "routed") logRouted(c, snapshots, results);
    if (failure !== undefined) throw failure.error;
    return { mode: plan.mode, results };
  });
}

/** Re-snapshot the servers and rewrite `discovery.json` with the registrations already made. Before
 *  `initRouting` there is nothing to describe yet, so it does nothing. Serialized on the same chain. */
export function refreshDiscovery(): Promise<void> {
  return enqueue(async () => {
    if (context === undefined) return;
    await writeView(context, takeSnapshots(context), lastRegistrations, "refresh");
  });
}

export function resetRoutingForTest(): void {
  context = undefined;
  lastRegistrations = [];
  chain = Promise.resolve();
}
