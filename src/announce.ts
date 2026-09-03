import type { Client } from "discord.js";
import { config } from "./config";
import { state, saveState } from "./state";
import { decideDmfAnnouncement } from "./wow/dmf";
import { lastWeeklyReset } from "./wow/reset";
import { realmStatus, realmWatchConfigured, decideRealmTransition, type RealmStatus } from "./wow/realm";
import { fetchReleases, decideReleaseAnnouncements, createReachabilityLog, type Release } from "./github";
import { checkForUpdate } from "./update";
import { restartPending, withCritical } from "./restart";

const TICK_MS = 60 * 1000;
const RESET_ANNOUNCE_WINDOW_MS = 10 * 60 * 1000;
// Poll the realm continuously (not only around reset) so an unscheduled outage at any hour is
// caught. The gap keeps the Blizzard call cadence gentle while still catching short outages.
const REALM_POLL_GAP_MS = 2 * 60 * 1000;

// Releases publish from a daily cron at 14:00 UTC (.github/workflows/release.yml),
// so poll only inside a window after it — plus once at startup to catch anything
// published while the bot was offline.
const RELEASE_CRON_HOUR_UTC = 14;
const RELEASE_WINDOW_MS = 90 * 60 * 1000;
const RELEASE_POLL_GAP_MS = 5 * 60 * 1000;

// Bot commits land at any hour, so — unlike releases — this polls on a flat cadence.
const UPDATE_POLL_GAP_MS = 15 * 60 * 1000;

let lastReleasePollAt = 0;
let lastUpdatePollAt = 0;
let lastRealmPollAt = 0;

export function startScheduler(client: Client): void {
  const tick = () => onTick(client).catch((err) => console.error("[tick]", err));
  tick();
  setInterval(tick, TICK_MS);
}

type AnnounceKind = "dmf" | "weeklyReset" | "serverUp" | "serverDown" | "release";

// Per-kind channel routing: future announcement kinds plug in here (see issue #528).
function channelFor(kind: AnnounceKind): string {
  return kind === "release" ? config.releaseAnnounceChannelId : config.announceChannelId;
}

async function announce(client: Client, kind: AnnounceKind, message: string): Promise<void> {
  const channelId = channelFor(kind);
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()) throw new Error(`Announce channel ${channelId} is not sendable`);
  await channel.send(message);
  console.log("[announce]", message);
}

export interface TickCheck {
  name: string;
  run: () => Promise<void>;
}

/**
 * Runs each check in order, isolating failures so one throwing can't starve the rest of the tick
 * (issue #43) — the same per-item try/catch shape `checkReleases` already uses per repo, now
 * applied across all five checks instead of just that one. Exported so the isolation itself is
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

// None of the checks a tick can reach (Blizzard/GitHub calls in wow/realm.ts, wow/blizzard.ts,
// github.ts, update.ts) carry a timeout of their own — a genuinely hung socket (connected, but
// the far end never responds and never closes) leaves `run()` below never settling. Without this
// bound, that would leave tickInFlight stuck true forever, silently freezing EVERY future tick —
// not just the one stuck check, all five, since they all now go through this one guard. Generous
// on purpose: a real tick should finish in well under a minute, even a slow one. Adding a timeout
// to each individual fetch (closing the hang itself, not just its blast radius here) is tracked
// as a separate follow-up rather than folded into this fix.
const TICK_WATCHDOG_MS = 5 * 60 * 1000;

/**
 * Prevents a tick from starting while the previous one is still running (issue #52 item 1):
 * without this, a stalled send (discord.js retries 3x with a 15s timeout each and waits out a
 * 429's `retry_after`, so a single `announce()` can exceed the 60s tick interval) lets a second
 * tick pass the same dedup-key check (`weeklyAnnouncedFor`, `dmfAnnouncedFor`, `realmStatus`)
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

async function onTick(client: Client): Promise<void> {
  if (restartPending()) return; // on the way out — don't start work we can't finish
  await guardedTick(() =>
    // The whole tick is one critical section: a restart requested by the update check
    // below lands only once every announcement and state write has settled.
    withCritical(() =>
      runTick([
        { name: "dmf", run: () => checkDmf(client) },
        { name: "weeklyReset", run: () => checkWeeklyReset(client) },
        { name: "realm", run: () => checkRealm(client) },
        {
          name: "releases",
          run: async () => {
            if (shouldPollReleases(new Date())) await checkReleases(client);
          },
        },
        {
          name: "autoUpdate",
          run: async () => {
            if (config.autoUpdate && shouldPollUpdate()) await checkAutoUpdate();
          },
        },
      ]),
    ),
  );
}

function shouldPollUpdate(): boolean {
  return Date.now() - lastUpdatePollAt >= UPDATE_POLL_GAP_MS;
}

async function checkAutoUpdate(): Promise<void> {
  lastUpdatePollAt = Date.now();
  await checkForUpdate();
}

function shouldPollReleases(now: Date): boolean {
  if (lastReleasePollAt === 0) return true; // startup catch-up
  const windowStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    RELEASE_CRON_HOUR_UTC,
  );
  const inWindow = now.getTime() >= windowStart && now.getTime() < windowStart + RELEASE_WINDOW_MS;
  return inWindow && now.getTime() - lastReleasePollAt >= RELEASE_POLL_GAP_MS;
}

async function checkDmf(client: Client): Promise<void> {
  const decision = decideDmfAnnouncement(new Date(), state.dmfAnnouncedFor);
  if (!decision) return;
  const closes = Math.floor(decision.window.end.getTime() / 1000);
  await announce(client, "dmf", `🎪 The **Darkmoon Faire** is open! It runs until <t:${closes}:F>.`);
  state.dmfAnnouncedFor = decision.key;
  await saveState();
}

async function checkWeeklyReset(client: Client): Promise<void> {
  const now = new Date();
  const last = lastWeeklyReset(now);
  if (now.getTime() - last.getTime() > RESET_ANNOUNCE_WINDOW_MS) return;
  const key = last.toISOString();
  if (state.weeklyAnnouncedFor === key) return;
  await announce(client, "weeklyReset", "📅 **Weekly reset!** Vault, lockouts, and quests have rolled over.");
  state.weeklyAnnouncedFor = key;
  await saveState();
}

// Continuously watch the realm and announce every UP↔DOWN transition, so an outage at any hour
// is reported — not only weekly-reset maintenance. A Blizzard error is swallowed: it must never
// masquerade as a DOWN, nor block the rest of the tick.
async function checkRealm(client: Client): Promise<void> {
  if (!realmWatchConfigured()) return;
  if (Date.now() - lastRealmPollAt < REALM_POLL_GAP_MS) return;
  lastRealmPollAt = Date.now();
  let status: RealmStatus;
  try {
    status = await realmStatus();
  } catch (err) {
    console.error("[realm]", err);
    return;
  }
  const transition = decideRealmTransition(state.realmStatus, status);
  if (transition === "down") {
    await announce(client, "serverDown", `🔴 **${config.realmSlug}** is down — servers are offline.`);
  } else if (transition === "up") {
    await announce(client, "serverUp", `🟢 **${config.realmSlug}** is back up — servers are live!`);
  }
  if (state.realmStatus !== status) {
    state.realmStatus = status;
    await saveState();
  }
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
    // Nothing to post — still commit nextSeen: covers the first-poll seed (seen was undefined,
    // so nextSeen is the full current list) and the ordinary no-new-releases case.
    await deps.persist(nextSeen);
    return;
  }
  const committed = [...(seen ?? [])];
  for (const release of toAnnounce) {
    await deps.announce(release);
    committed.push(release.id);
    await deps.persist(committed);
  }
}
