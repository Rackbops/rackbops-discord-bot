import { join } from "node:path";
import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import type { Client, MessageMentionOptions } from "discord.js";
import { config } from "./config";
import { prefixedName } from "./commandNaming";
import type { TickCheck } from "./plugins/contract";
import { state, saveState } from "./state";
import { clampReply, fetchReleases, decideReleaseAnnouncements, createReachabilityLog, RELEASES_PER_PAGE, type Release } from "./github";
import { checkForUpdate, notifyAutoUpdateFailure } from "./update";
import { deliverAdminNotice, type AdminNoticeDeliverers } from "./adminNotice";
import { restartPending, requestRestart, withCritical } from "./restart";
import { DATA_DIR, readJsonOrFresh, writeJsonAtomic, createJsonWriter, createKeyedJsonMutator } from "./storage";
import { loadPluginIndex } from "./plugins";
import { readPluginState, mutatePluginState } from "./plugins/host";
import { checkPluginUpdates, runDuePluginSchedules, type PluginUpdateDeps } from "./plugins/updates";
import { consumePluginRequests, type PluginRequestDeps } from "./plugins/requests";
import { settledWithin } from "./plugins/drain";
import { HOST_API_VERSION, type HostStorage } from "./plugins/contract";
import { readDiscovery } from "./routing/discovery";
import { applyRouting, refreshDiscovery } from "./routing/live";
import { liveFetchWebhook } from "./routing/requests";
import { mutateRouting, mutateSecrets, readRouting, readSecrets } from "./routing/store";

// Exported so plugins/host.test.ts can pin PLUGIN_TICK_TIMEOUT_MS under it (#217).
export const TICK_MS = 60 * 1000;

// A watched repo's releases can be published at any hour (config.watchedRepos is an arbitrary
// operator list — there is no release cron in this fork), so poll on a flat cadence like the
// self-update check, plus once at startup to catch anything published while the bot was offline.
const RELEASE_POLL_GAP_MS = 15 * 60 * 1000;

/** The most of a release's name the announcement shows (#499): past it, `clampReply`'s suffix. A name is free text
 *  on GitHub; unbounded, one long enough would make every post for that repo fail and block the newer ones. */
export const RELEASE_NAME_MAX = 200;

// Bot commits land at any hour, so this polls on a flat cadence too.
const UPDATE_POLL_GAP_MS = 15 * 60 * 1000;

// #239: how often discovery.json is re-snapshotted, so the panel's list of servers and channels
// follows channels being created and permissions changing without anyone restarting the bot.
const DISCOVERY_REFRESH_GAP_MS = 15 * 60 * 1000;

let lastReleasePollAt = 0;
let lastUpdatePollAt = 0;
let lastPluginPollAt = 0;
let lastDiscoveryAt = 0;

// The plugin-update check must not run until the boot writePluginState (index.ts, after the
// scheduler starts) has landed — otherwise its keyed-mutator persist would race that one-time
// whole-file write. index.ts flips this on right after that write.
let pluginStateReady = false;

/** Called by index.ts once the boot state.json write has completed — see the race note above. */
export function markPluginStateReady(): void {
  pluginStateReady = true;
}

/** True once the boot state.json write has landed. `/plugins` WRITE subcommands (#104) check this
 *  before mutating state.json, so a command firing in the startup window (the gateway connects, and
 *  the interaction listener is live, before that one-time whole-file write) can't race it — the same
 *  race the update tick is gated against. */
export function isPluginStateReady(): boolean {
  return pluginStateReady;
}

const pluginStorage: HostStorage = { readJsonOrFresh, writeJsonAtomic, createJsonWriter, createKeyedJsonMutator };

/** Returns the FIRST tick's promise (settled, never rejecting) so the standby's probation can wait for
 *  one tick to have run (#548). Callers that do not care ignore it. */
export function startScheduler(client: Client, extraChecks: TickCheck[] = []): Promise<void> {
  const tick = () => onTick(client, extraChecks).catch((err) => console.error("[tick]", err));
  const first = tick();
  setInterval(tick, TICK_MS);
  return first;
}

type AnnounceKind = "release";

// Per-kind channel routing: the seam future announcement kinds plug into (see issue nazumods/wow#528). Only
// `release` remains a core announcement — the WoW announcements moved to the wow plugin (#107), which
// posts through host.announce (`postForPlugin`: the channels its routing names, ANNOUNCE_CHANNEL_ID when it
// names none) — so this currently always resolves the release channel.
function channelFor(_kind: AnnounceKind): string {
  return config.releaseAnnounceChannelId;
}

/**
 * #132: "fetch the channel, check it's sendable, send" — the one shared shape three call sites
 * (this file's own `announceTo`, `updateReport.ts`'s `viaChannel`, `index.ts`'s plugin
 * report-back) each hand-rolled independently, with the error text already having drifted between
 * two of them. Kept minimal: fetch, guard, send. `opts.allowedMentions` is threaded through rather
 * than hardcoded so a caller that needs to opt a specific ping in (past the Client-wide
 * `{ parse: [] }` default, #48) still can, while a caller with plain text keeps sending plain text
 * (Discord treats a bare string and `{ content: string }` identically, but the two callers'
 * existing test expectations distinguish them, so this preserves that rather than always wrapping).
 */
export async function sendToChannel(
  client: Client,
  channelId: string,
  content: string,
  opts?: { allowedMentions?: MessageMentionOptions },
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()) throw new Error(`Channel ${channelId} is not sendable`);
  if (opts?.allowedMentions) await channel.send({ content, allowedMentions: opts.allowedMentions });
  else await channel.send(content);
}

/** Posts `message` to a specific channel, through the bot's own send path. Split out from
 * `announce` so a plugin's `HostApi.announce` reuses exactly this path for every channel that has no
 * webhook (`postForPlugin` in src/routing/post.ts, which posts through the webhook instead when there
 * is one and prints the same line) — the `[announce]` log line stays byte-identical. */
export async function announceTo(client: Client, channelId: string, message: string): Promise<void> {
  await sendToChannel(client, channelId, message);
  console.log("[announce]", message);
}

async function announce(client: Client, kind: AnnounceKind, message: string): Promise<void> {
  return announceTo(client, channelFor(kind), message);
}

/**
 * Runs each check in order, isolating failures so one throwing can't starve the rest of the tick
 * (issue #43) — the same per-item try/catch shape `checkReleases` already uses per repo, now
 * applied across every check the scheduler runs instead of just that one. Exported so the isolation itself is
 * tested directly, without mocking discord.js's `Client` end-to-end.
 */
export async function runTick(checks: TickCheck[]): Promise<void> {
  for (const { name, run } of checks) {
    try {
      await run();
    } catch (err) {
      console.error(`[tick:${name}]`, err);
    }
  }
}

let tickInFlight = false;
let consecutiveSkips = 0;
// Distinguishes which "generation" of tick currently owns tickInFlight, so a watchdog or
// finally belonging to an old, still-hung tick can never stomp on a later, legitimately
// in-flight one — see the watchdog comment below.
let tickGeneration = 0;

// The bot's own network is bounded now — the GitHub calls in github.ts/update.ts since #88, the
// docker-daemon calls under the redeploy path since #130, the plugin index and bundle fetches by
// their own signals, and the WAIT on each plugin tick (the `...extra` checks below) by `pluginTicks`
// since #217 — at the bound the call's AbortSignal is aborted (#248), a call that ignores it is left
// running, and that tick isn't started again until it settles. What remains unbounded is what this watchdog is still for:
// discord.js's REST calls (they carry internal timeouts and retries of their own, so they are
// bounded in practice but not by us).
//
// A genuinely hung call there (connected, but the far end never responds and never closes) leaves
// `run()` below never settling, which without this bound would leave tickInFlight stuck true
// forever, silently freezing EVERY future tick — not just the one stuck check, since they all go
// through this one guard. Generous on purpose: a real tick should finish in well under a minute.
export const TICK_WATCHDOG_MS = 5 * 60 * 1000;

/**
 * Prevents a tick from starting while the previous one is still running (issue #52 item 1):
 * without this, a stalled send (discord.js retries 3x with a 15s timeout each and waits out a
 * 429's `retry_after`, so a single `announce()` can exceed the 60s tick interval) lets a second
 * tick pass the same dedup-key check (the release `seenReleaseIds`, or a plugin's own dedup state)
 * before the first tick has written it — producing a duplicate announcement. (A plugin tick over
 * PLUGIN_TICK_TIMEOUT_MS no longer holds this guard — `pluginTicks` stops waiting on it, #217 — so
 * `pluginTicks` itself skips that tick's next run until the call settles: within this process its
 * dedup-key check is still never re-entered, and a restart during that call aborts it and waits for
 * it to settle, bounded — see restart.ts's header, #248.)
 *
 * Skips outright rather than queuing, so a merely-slow tick never piles up work — the next tick
 * to actually run re-reads whatever state the (by-then-finished) previous one left behind. Warns
 * on every skip once skipping becomes REPEATED (2+ in a row), not the first one: an occasional
 * single skip under an ordinarily-slow tick is expected and not itself worth flagging.
 */
export async function guardedTick(
  run: () => Promise<void>,
  // Test seam: real callers always take the default. Overridable so a test can exercise the
  // watchdog firing without actually waiting out the real 5-minute bound.
  watchdogMs = TICK_WATCHDOG_MS,
): Promise<void> {
  if (tickInFlight) {
    consecutiveSkips++;
    if (consecutiveSkips >= 2) {
      console.warn(`[tick] skipped ${consecutiveSkips} ticks in a row — the previous one is still running`);
    }
    return;
  }
  tickInFlight = true;
  const myGeneration = ++tickGeneration;
  const watchdog = setTimeout(() => {
    // Only fires if `run()` is STILL pending this far in — release the guard so future ticks
    // aren't blocked forever; the stuck call itself is left running in the background (nothing
    // can safely cancel it without a signal threaded all the way down, which is the follow-up).
    console.error(
      `[tick] a tick has been running for over ${Math.round(watchdogMs / 1000)}s — releasing the guard so ` +
        `future ticks aren't blocked forever`,
    );
    tickInFlight = false;
  }, watchdogMs);
  try {
    await run();
  } finally {
    clearTimeout(watchdog);
    // Guards against the watchdog (or this finally itself, on a very late resolution) touching
    // state that a LATER generation's tick already owns — e.g. the watchdog fired, generation
    // N+1 started and is legitimately in flight, and only THEN does generation N's original
    // `run()` finally settle; without this check its finally would wrongly clear generation
    // N+1's in-progress guard.
    if (tickGeneration === myGeneration) {
      tickInFlight = false;
      consecutiveSkips = 0;
    }
  }
}

/** Reset module state between tests. */
export function resetTickGuardForTest(): void {
  tickInFlight = false;
  consecutiveSkips = 0;
  tickGeneration = 0;
}

/** The core scheduler checks in order, followed by any plugin ticks. Pure so the composition (the
 * core names in order, then the extras) is tested directly. */
export function tickChecks(client: Client, extra: TickCheck[]): TickCheck[] {
  return [
    {
      name: "releases",
      run: async () => {
        if (shouldPollReleases(Date.now(), lastReleasePollAt)) await checkReleases(client);
      },
    },
    {
      name: "autoUpdate",
      run: async () => {
        if (config.autoUpdate && shouldPollUpdate()) await checkAutoUpdate(client);
      },
    },
    {
      // Drain the plugin request MAILBOX (#105) — panel-dropped update and routing requests. Since #241
      // the mailbox is also drained every few seconds on its own timer (src/plugins/drain.ts, started
      // from index.ts), so a panel change lands in seconds; this tick check is the backstop, and still
      // runs BEFORE the pluginUpdates pass so a request queued in the last seconds is applied this
      // tick. Gated on pluginStateReady like pluginUpdates; the consumer is single-flight vs the boot
      // drain and the timer's.
      name: "pluginRequests",
      run: async () => {
        if (!pluginStateReady) return;
        // #508: the consumer is single-flight, so this queues behind a timer drain that never settles, and
        // the whole tick is one critical section -- unbounded, it held every restart for good (the tick
        // watchdog frees the next tick, not the critical section). Bounded, like the timer's beats: past
        // PLUGIN_REQUESTS_TICK_WAIT_MS this tick goes on, and lets go of its hold, without the drain.
        if ((await settledWithin(consumePluginRequests(livePluginRequestDeps()), PLUGIN_REQUESTS_TICK_WAIT_MS)) === "timed-out") {
          console.error(
            `[tick:pluginRequests] the request-mailbox drain is still running after ${PLUGIN_REQUESTS_TICK_WAIT_MS / 1000}s — this tick goes on without it`,
          );
        }
      },
    },
    {
      // Notify admins of a newer plugin version, with what changed (#103) — and run a DUE scheduled
      // update, which moves the pin and restarts the bot (#104), the one place this tick acts on an
      // update, and only because an admin scheduled it.
      // Gated on pluginStateReady so it can't race the boot state.json write (see the flag above).
      // The index poll (the notices, then due schedules) runs on the 15-minute gap; on every other tick
      // only the due schedules are looked at (#442), so a schedule fires within a minute of its time.
      name: "pluginUpdates",
      run: async () => {
        if (!pluginStateReady) return;
        if (shouldPollPluginUpdates()) {
          lastPluginPollAt = Date.now(); // stamp at poll start, like checkReleases/checkAutoUpdate
          await checkPluginUpdates(livePluginUpdateDeps(client)); // the notice pass, then due schedules
        } else {
          // #442: a schedule fires within a minute of its time, not on the next 15-minute index poll.
          await runDuePluginSchedules(livePluginUpdateDeps(client));
        }
      },
    },
    {
      // Keep data/discovery.json fresh (#239). The refresh is QUEUED, not awaited: it runs behind any
      // registration on the routing chain, and the plugin ticks after this check must not wait for a
      // registration's PUTs -- index.ts starts the scheduler before registering precisely so they don't.
      // startScheduler fires the first tick without awaiting it and index.ts calls initRouting right
      // after it, so on that first tick the boot registration is already ahead of this refresh (which
      // is then a redundant rewrite, harmless). refreshDiscovery is built not to reject, but an
      // unawaited promise that did would be an unhandled rejection, which ends the process -- so it
      // is caught here rather than left to runTick, which is no longer holding it.
      name: "discovery",
      run: async () => {
        if (shouldRefreshDiscovery(Date.now(), lastDiscoveryAt)) {
          lastDiscoveryAt = Date.now(); // stamp at start, like checkReleases/checkAutoUpdate
          void refreshDiscovery().catch((err) => console.error("[tick:discovery]", err));
        }
      },
    },
    ...extra,
  ];
}

/** The most the `pluginRequests` check waits on a drain (#508): below `TICK_WATCHDOG_MS`, so this tick
 *  -- not its watchdog -- ends the wait, with room for the checks after it before the watchdog would
 *  reopen the guard under them. A drain this tick started itself and that runs longer goes on without
 *  the tick's hold; its writes are temp-then-rename and its request file is removed only once applied,
 *  so a restart meanwhile replays it at boot. */
export const PLUGIN_REQUESTS_TICK_WAIT_MS = 2 * 60 * 1000;

async function onTick(client: Client, extraChecks: TickCheck[]): Promise<void> {
  if (restartPending()) return; // on the way out — don't start work we can't finish
  await guardedTick(() =>
    // The whole tick is one critical section: a restart requested during it — by the self-update
    // check or by a due plugin-update schedule (#104) — lands only once every announcement and state
    // write has settled. A plugin tick that overruns PLUGIN_TICK_TIMEOUT_MS is no longer waited on here
    // (#217), but its call keeps its own hold on the critical section until it settles, and a restart
    // aborts it and waits PLUGIN_TICK_ABORT_GRACE_MS at most (#248) — see restart.ts's header.
    withCritical(() => runTick(tickChecks(client, extraChecks))),
  );
}

function shouldPollUpdate(): boolean {
  return Date.now() - lastUpdatePollAt >= UPDATE_POLL_GAP_MS;
}

async function checkAutoUpdate(client: Client): Promise<void> {
  lastUpdatePollAt = Date.now();
  const check = await checkForUpdate();
  // #505 item 2: a failed automatic update used to be one console.warn nobody reads; the admins are told once per failing
  // commit (a /update failure already gets its own reply, so only this path notifies).
  await notifyAutoUpdateFailure(check, {
    deliver: (message) =>
      deliverAdminNotice(message, config.adminUserIds, liveAdminDeliverers(client), console, {
        noAdmins: "[update] a failed automatic update needs reporting but ADMIN_USER_IDS is empty — no one to notify",
        dmFailed: (id, reason) => `[update] couldn't DM admin ${id} about a failed automatic update (${reason}) — will try the announce channel`,
        fallbackFailed: "[update] channel fallback for a failed automatic update notice failed",
      }),
    runningSha: config.gitSha!,
    updateCommand: prefixedName(config.commandPrefix, "update"),
  });
}

// Flat 15-min cadence with a startup catch-up (like shouldPollReleases), so a version published
// while the bot was offline is announced on the first eligible tick after boot.
function shouldPollPluginUpdates(): boolean {
  if (lastPluginPollAt === 0) return true; // startup catch-up
  return Date.now() - lastPluginPollAt >= UPDATE_POLL_GAP_MS;
}

/** The two ways the bot reaches an admin — a DM, and the announce channel as the fallback — shared by the plugin update
 *  notice and the failed-automatic-update notice (#505). */
function liveAdminDeliverers(client: Client): AdminNoticeDeliverers {
  return {
    dmUser: async (userId, content) => {
      const user = await client.users.fetch(userId);
      await user.send(content);
    },
    postAnnounce: (content) => announceTo(client, config.announceChannelId, content),
  };
}

/** Live deps for `checkPluginUpdates`, built from config + the shared storage + the Client's DM and
 *  announce paths. `loadIndex` re-fetches (and re-caches) the manifest; `mutateState` is host.ts's
 *  single race-safe state.json mutator; the fallback reuses `announceTo`. Exported for the wiring
 *  test, which builds it (no Client call happens until a delivery) to read `pluginsCommand`. */
export function livePluginUpdateDeps(client: Client): PluginUpdateDeps {
  return {
    loadIndex: async () => (await loadPluginIndex(config.pluginIndexUrl, DATA_DIR)).index,
    readState: () => readPluginState(DATA_DIR, pluginStorage),
    mutateState: (mutate) => mutatePluginState(DATA_DIR, mutate),
    deliverers: liveAdminDeliverers(client),
    adminUserIds: config.adminUserIds,
    hostApiVersion: HOST_API_VERSION,
    // The notice tells admins to run `/plugins …` — under the name it is registered as here.
    pluginsCommand: prefixedName(config.commandPrefix, "plugins"),
    now: () => new Date(),
    log: console,
    // #104: a due scheduled update restarts the bot. requestRestart inside the tick's withCritical
    // defers the exit until the DM + state write settle (bounded by RESTART_DEFERRAL_MAX_MS, a handoff
    // exempt, #512); restartPending lets it stand down if an earlier restart (autoUpdate) already won this tick.
    restartPending,
    requestRestart,
  };
}

/** Live deps for the #105 request-mailbox consumer (real fs + the shared index/state/mutator), and since
 *  #241 for the routing requests too (the routing store, `applyRouting` / `refreshDiscovery`, and the
 *  webhook lookup). No Discord client — a panel request has no DM target; the report-back logs the
 *  outcome. Reused by the boot drain and the every-few-seconds timer in index.ts. */
export function livePluginRequestDeps(): PluginRequestDeps {
  return {
    requestsDir: join(DATA_DIR, "plugins", "requests"),
    readDir: (dir) => readdir(dir),
    readFile: (path) => readFile(path, "utf8"),
    unlink: (path) => unlink(path),
    rename: (from, to) => rename(from, to),
    mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
    loadIndex: async () => (await loadPluginIndex(config.pluginIndexUrl, DATA_DIR)).index,
    readState: () => readPluginState(DATA_DIR, pluginStorage),
    mutateState: (mutate) => mutatePluginState(DATA_DIR, mutate),
    requestRestart,
    hostApiVersion: HOST_API_VERSION,
    adminUserIds: config.adminUserIds,
    now: () => new Date(),
    log: console,
    routing: {
      readDiscovery: () => readDiscovery(DATA_DIR),
      readRouting: () => readRouting(DATA_DIR),
      readSecrets: () => readSecrets(DATA_DIR),
      mutateRouting: (mutate) => mutateRouting(DATA_DIR, mutate),
      mutateSecrets: (mutate) => mutateSecrets(DATA_DIR, mutate),
      fetchWebhook: liveFetchWebhook(),
      applyRouting,
      refreshDiscovery,
      now: () => new Date(),
      log: console,
    },
  };
}

// Flat cadence with a startup catch-up (mirrors shouldPollPluginUpdates), so a release published
// while the bot was offline is polled for on the first eligible tick after boot. `now` and
// `lastPollAt` are both passed in (not read off module state) so every boundary is pinnable.
export function shouldPollReleases(now: number, lastPollAt: number): boolean {
  if (lastPollAt === 0) return true; // startup catch-up
  return now - lastPollAt >= RELEASE_POLL_GAP_MS;
}

// Same shape as shouldPollReleases: a flat cadence with a startup catch-up, `now` and `lastAt` both
// passed in so every boundary is pinnable.
export function shouldRefreshDiscovery(now: number, lastAt: number): boolean {
  if (lastAt === 0) return true; // startup catch-up
  return now - lastAt >= DISCOVERY_REFRESH_GAP_MS;
}

/** Forgets when discovery was last refreshed, so the next `discovery` check counts as the first. */
export function resetDiscoveryGapForTest(): void {
  lastDiscoveryAt = 0;
}

/** Forgets when releases, self-update and plugin updates were last polled, whether the boot
 *  state.json write has landed, and which watched repos were found unreachable. */
export function resetPollStateForTest(): void {
  lastReleasePollAt = 0;
  lastUpdatePollAt = 0;
  lastPluginPollAt = 0;
  pluginStateReady = false;
  releaseReachability = createReachabilityLog();
}

/** What `resetTickGuardForTest`, `resetDiscoveryGapForTest` and `resetPollStateForTest` reset, as
 *  plain values — what the test-state guard reads (test/stateGuard.ts). `tickGeneration` is left
 *  out: a tick only ever compares it with the generation it took itself, so its starting value
 *  changes nothing later. */
export interface AnnounceStateForTest {
  tickInFlight: boolean;
  consecutiveSkips: number;
  lastDiscoveryAt: number;
  lastReleasePollAt: number;
  lastUpdatePollAt: number;
  lastPluginPollAt: number;
  pluginStateReady: boolean;
  unreachableRepos: number;
}

export function announceStateForTest(): AnnounceStateForTest {
  return {
    tickInFlight,
    consecutiveSkips,
    lastDiscoveryAt,
    lastReleasePollAt,
    lastUpdatePollAt,
    lastPluginPollAt,
    pluginStateReady,
    unreachableRepos: releaseReachability.unreachableCount(),
  };
}

/** One line for the boot log: whether the release watcher is on (`WATCHED_REPOS=none` = off). */
export function describeReleaseWatch(repos: readonly string[]): string {
  return repos.length === 0
    ? "[release] watcher off (WATCHED_REPOS=none)"
    : `[release] watching ${repos.length} repo(s): ${repos.join(", ")}`;
}

// `repos`/`checkRepo` default to the live config and the real per-repo check; tests inject both.
// With `repos` empty (WATCHED_REPOS=none) the loop never runs, so no release is ever fetched.
export async function checkReleases(
  client: Client,
  repos: readonly string[] = config.watchedRepos,
  checkRepo: (repo: string) => Promise<void> = (repo) => checkRepoReleases(client, repo),
): Promise<void> {
  lastReleasePollAt = Date.now();
  // Poll each watched repo independently: one repo's fetch failure (e.g. a bad name → 404)
  // must not starve the others' announcements on this tick.
  for (const repo of repos) {
    // #499 item 6: a restart or shutdown pending mid-walk ends the walk here, between repos, instead of racing the
    // drain's grace through the ones left; they are polled by the next walk (the next boot's startup catch-up, or
    // the next 15-minute poll when this process carries on after a failed handoff).
    if (restartPending()) {
      console.log(`[release] a restart or shutdown is pending — stopping the walk before ${repo}`);
      return;
    }
    try {
      await checkRepo(repo);
    } catch (err) {
      console.error(`[release] ${repo}`, err);
    }
  }
}

// A watched repo can be unreadable for as long as it is watched — renamed, deleted, or private
// to the bot's token — and that must not reprint the same failure every poll, where it would
// bury a real one. Track it here so the condition is reported on its edges only. (`let` only so
// resetPollStateForTest can start a fresh record.)
let releaseReachability = createReachabilityLog();

async function checkRepoReleases(client: Client, repo: string): Promise<void> {
  const releases = await fetchReleases(repo);
  if (releases === null) {
    if (releaseReachability.observe(repo, false) === "lost") {
      console.warn(
        `[release] ${repo} is unreachable (missing, or GITHUB_TOKEN cannot see it) — ` +
          `skipping it quietly until it answers again`,
      );
    }
    // Leave its seen-id list untouched: when the repo answers again, commitReleaseAnnouncements announces
    // what was published meanwhile (the non-draft releases on the one page fetchReleases reads -- at most the
    // newest 15 -- that are not in the list, oldest first), and only a repo with NO list, its first-ever poll,
    // seeds silently (#437). A 404 that passes (a token that could not see the repo for a while; GitHub 404s
    // a private repo it cannot read) must not cost real announcements.
    return;
  }
  if (releaseReachability.observe(repo, true) === "recovered") {
    console.log(`[release] ${repo} is reachable again`);
  }
  const seen = state.seenReleaseIds[repo];
  // #499 item 5: one page per poll. A whole page of new releases on a repo we have polled before means older ones
  // may exist that were never fetched and never will be (they are not recorded either); with exactly a page's worth
  // of releases in all there are none, which the poll cannot tell, so the line says "may". Keyed on the page size the
  // request asked for; a page padded with drafts (dropped by fetchReleases) can slip under it, which is accepted.
  // It is logged BEFORE the posts, so a failing post cannot lose it, and it repeats each poll while the OLDEST post
  // keeps failing (the list does not advance until one succeeds; after that part of the page is seen and it stops).
  if (seen !== undefined && releases.length >= RELEASES_PER_PAGE && releases.every((r) => !seen.includes(r.id))) {
    console.warn(
      `[release] ${repo}: every one of the ${releases.length} releases on the page is new — anything older may not have been fetched and will not be announced`,
    );
  }
  await commitReleaseAnnouncements(releases, seen, {
    announce: (release) =>
      announce(
        client,
        "release",
        `📦 New ${release.prerelease ? "pre-release" : "release"}: **${clampReply(release.name, RELEASE_NAME_MAX)}**\n${release.url}`,
      ),
    persist: async (committed) => {
      state.seenReleaseIds[repo] = committed;
      await saveState();
    },
  });
}

/**
 * The core of a per-repo release check, decoupled from discord.js and the module's own
 * `announce`/`saveState` — the same "extract the isolable logic, inject the side effects"
 * shape `runTick` already uses, so the incremental-persistence fix (issue #52 item 2) can be
 * driven directly without mocking `Client`.
 *
 * Commits each id right after its announce succeeds, rather than saving `nextSeen` once after
 * the whole batch — a throw partway through a multi-release burst must not discard the ids of
 * releases already posted, or the next poll re-announces them. Among what remains at-least-once
 * (#499; CONTEXT.md's Behavior section lists the rest): an exit in the instant between a post and
 * its save, or a save that fails and is followed by a restart before a later save succeeds, re-posts
 * the releases whose saves had not landed (the ids are already in memory, so the same process does not
 * post them twice).
 */
export async function commitReleaseAnnouncements(
  releases: Release[],
  seen: number[] | undefined,
  deps: { announce: (release: Release) => Promise<void>; persist: (seen: number[]) => Promise<void> },
): Promise<void> {
  const { toAnnounce, nextSeen } = decideReleaseAnnouncements(releases, seen);
  if (toAnnounce.length === 0) {
    // Nothing to post. Persist only on the genuine first-poll seed (seen was undefined, so
    // nextSeen is the full current list, worth recording once) — the ordinary no-new-releases
    // case has nextSeen content-identical to seen (decideReleaseAnnouncements above), so saving
    // it would just be a state.json rewrite for zero information gain, every poll, per repo.
    if (seen === undefined) await deps.persist(nextSeen);
    return;
  }
  const committed = [...(seen ?? [])];
  for (const release of toAnnounce) {
    await deps.announce(release);
    committed.push(release.id);
    await deps.persist(committed);
  }
}
