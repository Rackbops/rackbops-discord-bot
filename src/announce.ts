import { join } from "node:path";
import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import type { Client } from "discord.js";
import { config } from "./config";
import type { TickCheck } from "./plugins/contract";
import { state, saveState } from "./state";
import { fetchReleases, decideReleaseAnnouncements, createReachabilityLog, type Release } from "./github";
import { checkForUpdate } from "./update";
import { restartPending, requestRestart, withCritical } from "./restart";
import { DATA_DIR, readJsonOrFresh, writeJsonAtomic, createJsonWriter, createKeyedJsonMutator } from "./storage";
import { loadPluginIndex } from "./plugins";
import { readPluginState, mutatePluginState } from "./plugins/host";
import { checkPluginUpdates, type PluginUpdateDeps } from "./plugins/updates";
import { consumePluginRequests, type PluginRequestDeps } from "./plugins/requests";
import { HOST_API_VERSION, type HostStorage } from "./plugins/contract";

const TICK_MS = 60 * 1000;

// A watched repo's releases can be published at any hour (config.watchedRepos is an arbitrary
// operator list — there is no release cron in this fork), so poll on a flat cadence like the
// self-update check, plus once at startup to catch anything published while the bot was offline.
const RELEASE_POLL_GAP_MS = 15 * 60 * 1000;

// Bot commits land at any hour, so this polls on a flat cadence too.
const UPDATE_POLL_GAP_MS = 15 * 60 * 1000;

let lastReleasePollAt = 0;
let lastUpdatePollAt = 0;
let lastPluginPollAt = 0;

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

export function startScheduler(client: Client, extraChecks: TickCheck[] = []): void {
  const tick = () => onTick(client, extraChecks).catch((err) => console.error("[tick]", err));
  tick();
  setInterval(tick, TICK_MS);
}

type AnnounceKind = "release";

// Per-kind channel routing: the seam future announcement kinds plug into (see issue #528). Only
// `release` remains a core announcement — the WoW announcements moved to the wow plugin (#107), which
// posts through host.announce → ANNOUNCE_CHANNEL_ID — so this currently always resolves the release channel.
function channelFor(_kind: AnnounceKind): string {
  return config.releaseAnnounceChannelId;
}

/** Posts `message` to a specific channel, through the bot's own send path. Split out from
 * `announce` so a plugin's `HostApi.announce` (which posts to `ANNOUNCE_CHANNEL_ID`) reuses exactly
 * this path — the `[announce]` log line stays byte-identical. */
export async function announceTo(client: Client, channelId: string, message: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()) throw new Error(`Announce channel ${channelId} is not sendable`);
  await channel.send(message);
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

// Most of the network a tick can reach still carries no timeout of its own — the GitHub calls in
// github.ts and update.ts, plus a plugin's own ticks (#88; the docker-daemon calls under
// update.ts's redeploy path ARE bounded since #130). A genuinely hung socket (connected, but the
// far end never responds and never closes) leaves `run()` below never settling. Without this bound,
// that would leave tickInFlight stuck true forever, silently freezing EVERY future tick — not just
// the one stuck check, since they all now go through this one guard. Generous on purpose: a real
// tick should finish in well under a minute, even a slow one. Adding a timeout to each remaining
// fetch (closing the hang itself, not just its blast radius here) is #88.
const TICK_WATCHDOG_MS = 5 * 60 * 1000;

/**
 * Prevents a tick from starting while the previous one is still running (issue #52 item 1):
 * without this, a stalled send (discord.js retries 3x with a 15s timeout each and waits out a
 * 429's `retry_after`, so a single `announce()` can exceed the 60s tick interval) lets a second
 * tick pass the same dedup-key check (the release `seenReleaseIds`, or a plugin's own dedup state)
 * before the first tick has written it — producing a duplicate announcement.
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
        if (config.autoUpdate && shouldPollUpdate()) await checkAutoUpdate();
      },
    },
    {
      // Drain the plugin request MAILBOX (#105) — panel-dropped update/schedule/remind/skip/cancel
      // requests — every tick, and BEFORE the pluginUpdates pass so a just-queued request is applied
      // this tick (the panel promises "≤1 min"). Gated on pluginStateReady like pluginUpdates; the
      // consumer is single-flight vs the boot drain.
      name: "pluginRequests",
      run: async () => {
        if (pluginStateReady) await consumePluginRequests(livePluginRequestDeps());
      },
    },
    {
      // Notify admins of a newer plugin version, with what changed (#103) — and run a DUE scheduled
      // update, which moves the pin and restarts the bot (#104), the one place this tick acts on an
      // update, and only because an admin scheduled it.
      // Gated on pluginStateReady so it can't race the boot state.json write (see the flag above).
      name: "pluginUpdates",
      run: async () => {
        if (pluginStateReady && shouldPollPluginUpdates()) {
          lastPluginPollAt = Date.now(); // stamp at poll start, like checkReleases/checkAutoUpdate
          await checkPluginUpdates(livePluginUpdateDeps(client));
        }
      },
    },
    ...extra,
  ];
}

async function onTick(client: Client, extraChecks: TickCheck[]): Promise<void> {
  if (restartPending()) return; // on the way out — don't start work we can't finish
  await guardedTick(() =>
    // The whole tick is one critical section: a restart requested during it — by the self-update
    // check or by a due plugin-update schedule (#104) — lands only once every announcement and state
    // write has settled.
    withCritical(() => runTick(tickChecks(client, extraChecks))),
  );
}

function shouldPollUpdate(): boolean {
  return Date.now() - lastUpdatePollAt >= UPDATE_POLL_GAP_MS;
}

async function checkAutoUpdate(): Promise<void> {
  lastUpdatePollAt = Date.now();
  await checkForUpdate();
}

// Flat 15-min cadence with a startup catch-up (like shouldPollReleases), so a version published
// while the bot was offline is announced on the first eligible tick after boot.
function shouldPollPluginUpdates(): boolean {
  if (lastPluginPollAt === 0) return true; // startup catch-up
  return Date.now() - lastPluginPollAt >= UPDATE_POLL_GAP_MS;
}

/** Live deps for `checkPluginUpdates`, built from config + the shared storage + the Client's DM and
 *  announce paths. `loadIndex` re-fetches (and re-caches) the manifest; `mutateState` is host.ts's
 *  single race-safe state.json mutator; the fallback reuses `announceTo`. */
function livePluginUpdateDeps(client: Client): PluginUpdateDeps {
  return {
    loadIndex: async () => (await loadPluginIndex(config.pluginIndexUrl, DATA_DIR)).index,
    readState: () => readPluginState(DATA_DIR, pluginStorage),
    mutateState: (mutate) => mutatePluginState(DATA_DIR, mutate),
    deliverers: {
      dmUser: async (userId, content) => {
        const user = await client.users.fetch(userId);
        await user.send(content);
      },
      postAnnounce: (content) => announceTo(client, config.announceChannelId, content),
    },
    adminUserIds: config.adminUserIds,
    hostApiVersion: HOST_API_VERSION,
    now: () => new Date(),
    log: console,
    // #104: a due scheduled update restarts the bot. requestRestart inside the tick's withCritical
    // defers the exit until the DM + state write settle; restartPending lets it stand down if an
    // earlier restart (autoUpdate) already won this tick.
    restartPending,
    requestRestart,
  };
}

/** Live deps for the #105 request-mailbox consumer (real fs + the shared index/state/mutator). No
 *  Discord client — a panel request has no DM target; the report-back logs the outcome. Reused by the
 *  boot drain in index.ts. */
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
    now: () => new Date(),
    log: console,
  };
}

// Flat cadence with a startup catch-up (mirrors shouldPollPluginUpdates), so a release published
// while the bot was offline is polled for on the first eligible tick after boot. `now` and
// `lastPollAt` are both passed in (not read off module state) so every boundary is pinnable.
export function shouldPollReleases(now: number, lastPollAt: number): boolean {
  if (lastPollAt === 0) return true; // startup catch-up
  return now - lastPollAt >= RELEASE_POLL_GAP_MS;
}

async function checkReleases(client: Client): Promise<void> {
  lastReleasePollAt = Date.now();
  // Poll each watched repo independently: one repo's fetch failure (e.g. a bad name → 404)
  // must not starve the others' announcements on this tick.
  for (const repo of config.watchedRepos) {
    try {
      await checkRepoReleases(client, repo);
    } catch (err) {
      console.error(`[release] ${repo}`, err);
    }
  }
}

// A watched repo can be unreadable for as long as it is watched — renamed, deleted, or private
// to the bot's token — and that must not reprint the same failure every poll, where it would
// bury a real one. Track it here so the condition is reported on its edges only.
const releaseReachability = createReachabilityLog();

async function checkRepoReleases(client: Client, repo: string): Promise<void> {
  const releases = await fetchReleases(repo);
  if (releases === null) {
    if (releaseReachability.observe(repo, false) === "lost") {
      console.warn(
        `[release] ${repo} is unreachable (missing, or GITHUB_TOKEN cannot see it) — ` +
          `skipping it quietly until it answers again`,
      );
    }
    // Leave its seen-id list untouched, so a repo that comes back seeds silently rather
    // than announcing everything published while it was invisible.
    return;
  }
  if (releaseReachability.observe(repo, true) === "recovered") {
    console.log(`[release] ${repo} is reachable again`);
  }
  await commitReleaseAnnouncements(releases, state.seenReleaseIds[repo], {
    announce: (release) => announce(client, "release", `📦 New release: **${release.name}**\n${release.url}`),
    persist: async (seen) => {
      state.seenReleaseIds[repo] = seen;
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
 * releases already posted, or the next poll re-announces them.
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
