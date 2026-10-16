import { config } from "./config";
import { state, saveState, type PendingUpdateReport, type SwapInFlight } from "./state";
import { restartPending, requestRestart } from "./restart";
import { prefixedName } from "./commandNaming";
import { probeReplacement, redeploy, redeployAvailable, type RedeployResult, type ReplacementProbe } from "./redeploy";
import { GITHUB_TIMEOUT_MS, githubHeaders } from "./github";
import { shortSha } from "./storage";

// Self-update detection. The bot has no releases of its own, so "am I stale?" is answered
// against the newest commit on `config.botBranch` (in `config.githubRepo`, the whole repo —
// this fork lives at its root, not a monorepo subdirectory, so no path filter is needed).
//
// The question is ANCESTRY, not equality (nazumods/wow#871). GIT_SHA is baked as `git rev-parse HEAD`
// — the tip you built from — which is only occasionally the newest commit on the branch,
// because a build can lag behind commits landed after it. Asking "is my sha THE newest
// commit" therefore called a correct, up-to-date deploy stale as its normal state: one
// pointless exit-75 per deploy under AUTO_UPDATE, and every admin /update forcing another.
// Asking "does my build CONTAIN the newest commit" is the question that was always meant.

export type UpdateDecision =
  /** Can't tell: no GIT_SHA baked in, or the sha baked in isn't on the remote to compare against. */
  | "disabled"
  /** Running the newest bot commit. */
  | "current"
  /** Stale: exit and let the orchestrator bring up the new code. */
  | "restart"
  /** Stale, but we already exited for this sha and came back unchanged. */
  | "suppressed"
  /** A handoff, another check or a pending restart is already in flight — this call refuses before touching anything (#449). */
  | "busy";

/** Tolerant of short vs full shas, so GIT_SHA can be either. */
export function sameSha(a: string, b: string): boolean {
  const len = Math.min(a.length, b.length);
  if (len === 0) return false;
  return a.slice(0, len).toLowerCase() === b.slice(0, len).toLowerCase();
}

/**
 * How the running build relates to the newest bot commit, as GitHub's compare endpoint
 * answers it — plus two of our own for the cases it can't.
 */
export type ShaRelation =
  /** Built exactly that commit. */
  | "identical"
  /** The build contains it (the normal case: built from a main tip newer than it). */
  | "ahead"
  /** Genuinely missing bot code. */
  | "behind"
  /** Built off a side branch that doesn't contain it. */
  | "diverged"
  /** The running sha isn't on the remote at all — nothing to compare against. */
  | "unpublished"
  /** The compare call failed; fall back to treating a sha mismatch as stale. */
  | "unknown";

/**
 * Whether a stale build should exit to be replaced.
 *
 * `relation` is the ancestry answer; it decides everything the bare sha comparison used to
 * get wrong. `ahead` and `identical` both mean the build already contains the newest commit, so
 * both read as `current` (a fresh deploy reads `identical`; `ahead` also covers a build carrying
 * commits the compared sha lacks). Once newer code lands the ordinary stale state is `behind`.
 * `unpublished` disables rather than restarts: a build whose sha the remote has never seen
 * (an unpushed branch) can never be matched, so offering an update would be offering one that
 * can never be delivered. `unknown` — an API failure — deliberately falls through to the old
 * behaviour rather than inventing a verdict.
 *
 * `attemptedSha` is the sha we last exited for. If we're back and still stale for
 * that same sha, the orchestrator isn't supplying new code — exiting again would
 * just loop, so suppress it. `force` (an admin's /update) overrides that.
 */
export function decideUpdate(o: {
  runningSha?: string;
  latestSha: string;
  relation?: ShaRelation;
  attemptedSha?: string;
  force?: boolean;
}): UpdateDecision {
  if (!o.runningSha) return "disabled";
  // Equality shortcut: no relation needed, so the common path spends no extra API request.
  if (sameSha(o.runningSha, o.latestSha)) return "current";
  if (o.relation === "unpublished") return "disabled";
  if (o.relation === "identical" || o.relation === "ahead") return "current";
  // behind | diverged | unknown | absent. `diverged` restarts with `behind`: both answer the
  // question actually being asked — does this build contain the newest bot commit — with no.
  // A deliberate side-branch deploy points BOT_BRANCH at that branch and goes identical/ahead.
  if (!o.force && o.attemptedSha && sameSha(o.attemptedSha, o.latestSha)) return "suppressed";
  return "restart";
}

/** Who asked for the update, and where to reach them once the bot is back. */
export interface UpdateRequester {
  userId: string;
  channelId?: string;
  applicationId?: string;
  interactionToken?: string;
}

/**
 * The follow-up record to persist across a restart, or `undefined` when nobody asked —
 * an `AUTO_UPDATE` exit has no requester, so it leaves no report and stays silent.
 */
export function buildUpdateReport(o: {
  runningSha: string;
  latestSha: string;
  requester?: UpdateRequester;
  now: number;
}): PendingUpdateReport | undefined {
  if (!o.requester) return undefined;
  return { ...o.requester, fromSha: o.runningSha, toSha: o.latestSha, requestedAt: o.now };
}

/** Newest commit on `config.botBranch`. */
export async function fetchLatestBotSha(timeoutMs = GITHUB_TIMEOUT_MS): Promise<string> {
  const headers = githubHeaders();
  const res = await fetch(
    `https://api.github.com/repos/${config.githubRepo}/commits` +
      `?sha=${encodeURIComponent(config.botBranch)}&per_page=1`,
    { headers, signal: AbortSignal.timeout(timeoutMs) },
  );
  // 404 here is usually BOT_BRANCH naming a branch that doesn't exist on the remote.
  if (!res.ok) {
    throw new Error(
      `GitHub commits query failed: ${res.status} (repo ${config.githubRepo}, branch ${config.botBranch})`,
    );
  }
  const data = (await res.json()) as { sha: string }[];
  const sha = data[0]?.sha;
  if (!sha) throw new Error(`No commits found on ${config.botBranch}`);
  return sha;
}

/**
 * Ask GitHub how `runningSha` relates to `latestSha`.
 *
 * `compare/{base}...{head}` reports `head`'s position relative to `base`, so with the newest
 * bot commit as base the answer is read directly: `ahead` means the running build contains it.
 *
 * Never throws. A 404 is the meaningful case — the running sha isn't on the remote, which is a
 * real answer (`unpublished`) rather than an error. Anything else that goes wrong is `unknown`,
 * so a GitHub outage degrades the check instead of taking startup down with it.
 */
export async function fetchShaRelation(
  latestSha: string,
  runningSha: string,
  timeoutMs = GITHUB_TIMEOUT_MS,
): Promise<ShaRelation> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${config.githubRepo}/compare/` +
        // per_page=1 (#506): only `status` is read; this bounds the commits list the compare endpoint attaches (30 by default).
        `${encodeURIComponent(latestSha)}...${encodeURIComponent(runningSha)}?per_page=1`,
      // A timeout here lands in the catch below as `unknown` — which `decideUpdate` resolves to
      // `restart`, i.e. a real self-redeploy. That is why GITHUB_TIMEOUT_MS is generous: this is
      // the one call where being too eager to give up is expensive rather than merely noisy.
      { headers: githubHeaders(), signal: AbortSignal.timeout(timeoutMs) },
    );
    if (res.status === 404) {
      // GitHub answers 404 for two different questions: the running sha genuinely isn't on the
      // remote (`unpublished`), or it IS on the remote but shares no history with the newest bot
      // commit — "No common ancestor" (probed: repos/git/git/compare/master...todo) — which is a
      // `diverged` deploy off a rewritten branch, not one the operator forgot to push.
      const body = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
      if (body?.message?.toLowerCase().includes("no common ancestor")) return "diverged";
      return "unpublished";
    }
    if (!res.ok) {
      console.warn(`[update] compare failed: ${res.status} — treating a sha mismatch as stale`);
      return "unknown";
    }
    const { status } = (await res.json()) as { status?: string };
    if (
      status === "identical" ||
      status === "ahead" ||
      status === "behind" ||
      status === "diverged"
    ) {
      return status;
    }
    console.warn(`[update] compare returned an unrecognised status: ${status}`);
    return "unknown";
  } catch (err) {
    console.warn(`[update] compare errored: ${(err as Error).message}`);
    return "unknown";
  }
}

/** Why self-update is off, when the decision is `disabled`. */
export type DisabledReason =
  /** No GIT_SHA baked in at image build. */
  | "no-sha"
  /** GIT_SHA is set but the remote has never seen it (an unpushed branch). */
  | "unpublished-sha";

export interface UpdateCheck {
  decision: UpdateDecision;
  latestSha: string;
  /** Set only when `decision` is `disabled`. */
  reason?: DisabledReason;
  /** Set when `decision` is `restart` and the swap was attempted in-process (nazumods/wow#879). Present
   *  only on failure — a successful handoff never returns, since the replacement retires us. */
  redeploy?: RedeployResult;
}

/** The two docker-daemon-touching calls `applyUpdate` makes, injectable so `checkForUpdate`'s
 *  orchestration is testable without a real daemon (mirrors updateReport.ts's `Deliverers`). */
export interface RedeployDeps {
  redeployAvailable: typeof redeployAvailable;
  redeploy: typeof redeploy;
}

const liveRedeployDeps: RedeployDeps = { redeployAvailable, redeploy };

// Closes the gap `handoffActive()` alone leaves open (#51 item 4): that flag doesn't read true
// until `redeploy()` calls `beginHandoff()` just before creating the replacement (#130 moved it
// past the build), so everything before that — both GitHub fetches, `saveState()`,
// `redeployAvailable()`'s daemon ping, and now the build itself — is async and yields the event
// loop while `handoffActive()` still reads false. A second call landing in that stretch (two
// /updates in quick succession, or an admin's /update racing the scheduler's auto-update tick)
// would otherwise sail through and reach `redeploy()` too: both
// build the same `shaTag`, both target the same `replacementName`, and a losing call's failure
// path calls `endHandoff()` unconditionally — un-quiescing the scheduler while the winner's
// replacement is still coming up. Set synchronously (no `await` before it) so a second call
// invoked before the first yields can never observe it as false, and cleared in `finally` so
// every exit — including a thrown fetch — releases it.
let checkInFlight = false;
/** #506 item 13: the sha the `suppressed` warning was last logged for, so it is logged once per pending sha per process. */
let suppressedWarnedFor: string | undefined;
/** #506 item 13: why the last socket-path swap this process ran failed, so the `suppressed` warning can say so. */
let lastFailure: { sha: string; reason: string } | undefined;

/** What `resetUpdateForTest` resets, for the test-state guard (test/stateGuard.ts). */
export function updateStateForTest(): {
  checkInFlight: boolean;
  suppressedWarnedFor: string | undefined;
  lastFailure: { sha: string; reason: string } | undefined;
} {
  return { checkInFlight, suppressedWarnedFor, lastFailure };
}

/** Releases the in-flight guard, as a check that finished would, and forgets what the warning remembers. */
export function resetUpdateForTest(): void {
  checkInFlight = false;
  suppressedWarnedFor = undefined;
  lastFailure = undefined;
}

/**
 * Compare this build against the newest bot commit and, when stale, ask for a
 * restart so the orchestrator can bring up the new code. `force` is an admin's
 * explicit /update: it overrides the anti-loop suppression. `requester` is that
 * admin, recorded so the next boot can report back what build it landed on.
 *
 * The restart is only *requested*. On the exit-75 fallback path (`requestRestart`) that request
 * is held until any in-flight announcement and state write finish (a plugin tick is aborted and waited
 * on for PLUGIN_TICK_ABORT_GRACE_MS at most, #248 — see `restart.ts`'s header; the whole wait is bounded by
 * `RESTART_DEFERRAL_MAX_MS`, a handoff exempt, #512); the socket-mounted redeploy path
 * instead quiesces via `beginHandoff` — now only for the create→verify window, after the build (#130) —
 * which stops new ticks but does not await a tick already running.
 */
export async function checkForUpdate(
  o: { force?: boolean; requester?: UpdateRequester } = {},
  deps: RedeployDeps = liveRedeployDeps,
): Promise<UpdateCheck> {
  // Refused before anything else — even reading the shas. A second /update mid-swap would
  // otherwise overwrite the in-flight attempt's pendingUpdateReport, then force-remove its
  // replacement (`force: true` bypasses the anti-loop suppression, and interaction handling
  // does not quiesce during a handoff — only the scheduler does); and a second one while an exit-75 restart is
  // DEFERRED behind the first command's critical section (#449) would overwrite that requester's report too,
  // since `checkInFlight` is released in `finally` and no handoff is active on that path — `restartPending()` is
  // true in all three cases (a handoff, a pending exit, a shutdown). `checkInFlight` covers the stretch before a
  // handoff has even begun, which `restartPending()` can't see.
  if (restartPending() || checkInFlight) return { decision: "busy", latestSha: "" };
  if (!config.gitSha) return { decision: "disabled", latestSha: "", reason: "no-sha" };

  checkInFlight = true;
  try {
    const latestSha = await fetchLatestBotSha();
    // Only when the shas differ — the equality shortcut in `decideUpdate` covers the rest, so the
    // ordinary "built exactly the newest bot commit" path still costs a single request.
    const relation = sameSha(config.gitSha, latestSha)
      ? undefined
      : await fetchShaRelation(latestSha, config.gitSha);
    const decision = decideUpdate({
      runningSha: config.gitSha,
      latestSha,
      relation,
      attemptedSha: state.attemptedUpdateToSha,
      force: o.force,
    });

    if (decision === "disabled") {
      // Reachable only via `unpublished` here — the no-sha case returned above.
      console.warn(
        `[update] self-update is off: ${shortSha(config.gitSha)} is not on ` +
          `${config.githubRepo}, so there is nothing to compare it against.`,
      );
      return { decision, latestSha, reason: "unpublished-sha" };
    }

    if (decision === "current" && state.attemptedUpdateToSha) {
      // The update landed — clear the marker so a later one isn't wrongly suppressed.
      state.attemptedUpdateToSha = undefined;
      await saveState();
    }

    if (decision === "suppressed" && suppressedWarnedFor !== latestSha) {
      // #506 item 13 / #429: once per pending sha per process (a new failed swap re-arms it, below), and with the real
      // cause when this process has one: a swap that failed names its reason; otherwise this process came back on the
      // build it exited from (the exit-75 path: whatever respawned it supplied no new code), or a swap it started did
      // not take or is still landing (#450 logs which at boot).
      suppressedWarnedFor = latestSha;
      const why =
        lastFailure && sameSha(lastFailure.sha, latestSha)
          ? `the last attempt failed: ${lastFailure.reason}`
          : "this process came back on the build it exited from (whatever respawned it supplied no new code — rebuild the image, see README), or a swap it started did not take or is still landing (the boot log says which)";
      console.warn(
        `[update] ${shortSha(latestSha)} is still pending — ${why}. The automatic check will not retry it until a ` +
          `newer commit lands; /${prefixedName(config.commandPrefix, "update")} retries it now. Not exiting again.`,
      );
    }

    if (decision === "restart") {
      // The path first, so ONE save records everything the next boot needs: the socket path writes `swapInFlight`
      // beside the two markers (#450); the exit-75 path writes only the markers, whose meaning across its respawn
      // is unchanged. Written before the replacement starts and read by it after — never by both at once, which
      // is what keeps two containers off the same state file (nazumods/wow#879).
      const viaSocket = await deps.redeployAvailable();
      state.attemptedUpdateToSha = latestSha;
      const report = buildUpdateReport({ runningSha: config.gitSha, latestSha, requester: o.requester, now: Date.now() });
      // #506 item 12: an AUTO tick (no requester) must not wipe a /update follow-up still owed — the scheduler's
      // first tick can run before reportUpdateOutcome has delivered it.
      if (report) state.pendingUpdateReport = report;
      state.swapInFlight = viaSocket ? { fromSha: config.gitSha, toSha: latestSha, startedAt: Date.now() } : undefined;
      await saveState();
      return { decision, latestSha, redeploy: await applyUpdate(latestSha, deps, viaSocket, report) };
    }

    return { decision, latestSha };
  } finally {
    checkInFlight = false;
  }
}

/**
 * Become the new build.
 *
 * With the daemon socket mounted the bot does the whole thing itself: build, start the
 * replacement, hand over. Without it there is nothing to build with, so it falls back to the
 * original behaviour — exit and let whatever supervises the container supply a new image. That
 * fallback is why an existing deployment on an older compose file keeps working unchanged.
 *
 * The caller decided the path (`viaSocket`, before the arming save) and passes the report it armed (`armed`,
 * absent for an automatic attempt), so the failure tail can clear exactly that one.
 */
async function applyUpdate(
  latestSha: string,
  deps: RedeployDeps,
  viaSocket: boolean,
  armed: PendingUpdateReport | undefined,
): Promise<RedeployResult | undefined> {
  const shortRun = shortSha(config.gitSha!);
  const shortNew = shortSha(latestSha);

  if (!viaSocket) {
    console.log("[update] no docker socket — falling back to exit-and-be-respawned");
    requestRestart(`update ${shortRun} -> ${shortNew}`);
    return undefined;
  }

  // `redeploy` resolving at all means the swap failed — success kills this process mid-await.
  const result = await deps.redeploy(latestSha);

  // We're still the live bot, so no restart occurred: the follow-up report THIS call armed is un-owed and would
  // otherwise describe a restart that never happened — only that one (#506 item 12: an AUTO attempt, which arms
  // none, must not wipe a /update report still owed from before this process's boot report ran) — and the swap
  // record (#450) is resolved here, not by a later boot. `attemptedUpdateToSha` stays set, though — it's what makes
  // decideUpdate suppress the NEXT scheduler tick for this same failing sha (#50) instead of rebuilding it every 15
  // minutes; an admin's /update (force: true) still bypasses it, and the suppressed warning names this failure.
  // `armed` is undefined for an AUTO attempt, and an owed report is never undefined, so identity alone leaves it be.
  if (state.pendingUpdateReport === armed) state.pendingUpdateReport = undefined;
  state.swapInFlight = undefined;
  const reason = result.error ?? result.outcome ?? "failed";
  lastFailure = { sha: latestSha, reason };
  suppressedWarnedFor = undefined; // a new failure re-explains itself once
  await saveState();
  console.warn(`[update] redeploy to ${shortNew} failed: ${reason} (replacement: ${result.replacement ?? "unknown"})`);
  return result;
}

/** What a boot makes of the swap record its previous life left (#450). */
export type AttemptResolution =
  /** No record: the two markers say the whole story (an exit-75 respawn, or nothing pending). */
  | "none"
  /** `toSha` is this build: the swap landed and this is the replacement. The record is cleared. */
  | "landed"
  /** Back on `fromSha` with a live `<name>-next` — or with a probe that could not tell: the original restarted beside a
   *  standby that is (or may be) taking over. Nothing is touched; the report is left for the new build, or for this
   *  container's next boot to resolve. */
  | "in-flight"
  /** Back on `fromSha` with no live replacement: nothing took over. The record and the attempt marker are cleared and
   *  the report this swap armed is marked `interrupted` in the same save, so it says so instead of "the image wasn't
   *  rebuilt" -- even if this boot dies before delivering it. */
  | "interrupted"
  /** Neither sha is this build (a third build, no GIT_SHA, or a record of the wrong shape): the record is cleared and
   *  the markers are left to the existing paths. */
  | "stale";

/** A record a probe could not resolve for this long is not a swap in flight any more (#450): the standby's own budget
 *  is minutes, and a running holder of its name would stop the next redeploy before anything was quiesced. */
export const SWAP_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Pure: the verdict from the record, this build's sha, (when it matters) the probe of `<name>-next`, and the clock. */
export function decideAttemptResolution(o: {
  swap?: SwapInFlight;
  runningSha?: string;
  probe?: ReplacementProbe;
  now: number;
}): AttemptResolution {
  if (!o.swap) return "none";
  if (!o.runningSha) return "stale";
  if (sameSha(o.swap.toSha, o.runningSha)) return "landed";
  if (!sameSha(o.swap.fromSha, o.runningSha)) return "stale";
  if (o.probe?.kind === "alive") return "in-flight";
  if (o.probe?.kind === "unknown") {
    // Leave it for the next boot — unless the record is a day old, when nothing can still be in flight.
    return o.now - o.swap.startedAt > SWAP_RECORD_MAX_AGE_MS ? "interrupted" : "in-flight";
  }
  return "interrupted";
}

/** A `swapInFlight` as written by this bot; a hand-edited or truncated one must not throw at boot. A primitive has
 *  none of these properties, so only `null` (whose property read throws) needs a leg of its own; `undefined` would
 *  throw too, but `resolveUpdateAttempt` returns on it before asking. */
function isSwapInFlight(v: unknown): v is SwapInFlight {
  return (
    v !== null &&
    typeof (v as SwapInFlight).fromSha === "string" &&
    typeof (v as SwapInFlight).toSha === "string" &&
    typeof (v as SwapInFlight).startedAt === "number"
  );
}

/** Test seams for {@link resolveUpdateAttempt}. */
export interface ResolveAttemptDeps {
  probe?: () => Promise<ReplacementProbe>;
  log?: Pick<Console, "log" | "warn">;
}

/** What a probe saw, for the boot log. */
function describeProbe(p: ReplacementProbe): string {
  switch (p.kind) {
    case "alive":
    case "stopped":
      return `${p.name} is ${p.status}`;
    case "absent":
      return `${p.name} is gone`;
    case "unknown":
      return `whether ${p.name} is alive could not be told: ${p.error}`;
  }
}

/**
 * Resolve the swap record at boot (#450): called by `index.ts`'s `activate()` BEFORE the interaction handler attaches
 * (so no `/update` can arm a fresh record for this to mistake for the dead life's) and so before `startScheduler`: an
 * interrupted attempt's marker is gone before the first tick can read it, and the verdict is saved on the owed report
 * (`interrupted`), which is how it reaches `reportUpdateOutcome` -- and survives a boot that dies before delivering it.
 * The daemon is asked only in the ambiguous case (back on `fromSha`), bounded like `resolveBootMode`; an ordinary boot,
 * and the replacement's own boot, make no daemon call here. Never throws.
 */
export async function resolveUpdateAttempt(deps: ResolveAttemptDeps = {}): Promise<AttemptResolution> {
  const log = deps.log ?? console;
  const raw: unknown = state.swapInFlight;
  if (raw === undefined) return "none";
  const swap = isSwapInFlight(raw) ? raw : undefined;
  // Only the build the swap left asks the daemon: a record this bot writes has `fromSha` != `toSha`, so the build it
  // landed on (the replacement's own boot) never matches `fromSha` and makes no call.
  const needsProbe = !!swap && !!config.gitSha && sameSha(swap.fromSha, config.gitSha);
  const probe = needsProbe ? await (deps.probe ?? probeReplacement)() : undefined;
  // The probe is the only await above. A swap that began while it ran replaced the record this boot read (and the
  // markers beside it): resolving over that would erase an attempt that is live, so leave it to its own path.
  if (state.swapInFlight !== raw) {
    log.log("[update] the swap record changed while it was being resolved — a newer attempt owns it now, leaving it");
    return "in-flight";
  }
  const resolution = swap ? decideAttemptResolution({ swap, runningSha: config.gitSha, probe, now: Date.now() }) : "stale";
  const target = swap ? shortSha(swap.toSha) : "an unknown build";
  if (resolution === "in-flight") {
    // `in-flight` comes only from a probe that was asked (alive, or unknown and not yet a day old).
    log.log(
      `[update] the swap to ${target} this container started may be in flight (${describeProbe(probe!)}) — leaving its record, the attempt marker and its report for the new build or the next boot`,
    );
    return resolution;
  }
  state.swapInFlight = undefined;
  if (resolution === "interrupted") {
    state.attemptedUpdateToSha = undefined;
    // The verdict rides on the report THIS swap armed (same shas, as written by one block in `checkForUpdate`, so
    // equality, not `sameSha` -- a hand-edited report must not throw here), in the same save that clears the record.
    const { fromSha, toSha } = swap!;
    const owed = state.pendingUpdateReport;
    if (owed?.fromSha === fromSha && owed.toSha === toSha) owed.interrupted = true;
    // `interrupted` comes only from a probe that was asked: absent, stopped, or unknown on a record over a day old.
    log.warn(
      `[update] the swap to ${target} this container started did not take (${describeProbe(probe!)}${probe!.kind === "unknown" ? "; the record is over a day old, so nothing can still be in flight" : ""}) — cleared the attempt marker, so the next check tries it again`,
    );
  } else if (resolution === "landed") {
    log.log(`[update] the swap to ${target} landed — this is the new build; cleared its record`);
  } else {
    log.log(`[update] a swap record for ${target} belongs to another build or is malformed — cleared it`);
  }
  try {
    await saveState();
  } catch (err) {
    log.warn("[update] could not save the resolved swap record (it is resolved in memory; the next boot resolves it again)", err);
  }
  return resolution;
}
