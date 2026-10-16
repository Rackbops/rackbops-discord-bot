// Self-contained redeploy (nazumods/wow#879): the bot builds its own replacement through the Docker
// daemon, starts it alongside, and lets it retire the original once it has verified itself.
//
// Everything here that talks to the daemon about the swap lives in this file; the protocol
// itself (marker, deadlines, outcome decision) is in `handoff.ts`, kept free of I/O so it
// can be tested as pure logic.

import { config } from "./config";
import {
  buildImage,
  createContainer,
  daemonReachable,
  inspectImage,
  inspectSelf,
  listImages,
  removeContainer,
  removeImage,
  renameContainer,
  startContainer,
  stopContainer,
  tagImage,
  tryInspectContainer,
  updateContainer,
  type ContainerInspect,
  type CreateContainerSpec,
  type ImageSummary,
} from "./docker";
import {
  bootMode,
  clearMarker,
  decideHandoffOutcome,
  HANDOFF_DEADLINE_MS,
  HANDOFF_FROM_ENV,
  HANDOFF_RESTART_POLICY_ENV,
  HANDOFF_RESTART_RETRIES_ENV,
  readMarker,
  RETIREMENT_DEADLINE_MS,
  writeMarker,
  type HandoffOutcome,
  type ReplacementDisposition,
} from "./handoff";
import { beginHandoff, endHandoff, isShuttingDown } from "./restart";
import { SHORT_SHA_LEN, shortSha } from "./storage";

const POLL_MS = 2_000;
/** Per-sha image tags kept around. More than one is what makes rolling back to a *previous*
 *  build possible at all; a small number is what stops that filling the box's disk. */
const KEEP_SHA_TAGS = 3;

/** Docker reports names with a leading slash. */
export function canonicalName(inspectedName: string): string {
  return inspectedName.replace(/^\//, "");
}

/**
 * `canonicalName` without any trailing `-next`: the name the compose file's `container_name` pins (#547). The
 * suffix is reserved for the replacement (`replacementName`), so a name that ends in it is a replacement
 * that has not taken the canonical name, and a drifted `<name>-next-next` folds back to `<name>`.
 */
export function baseName(inspectedName: string): string {
  return canonicalName(inspectedName).replace(/(?:-next)+$/, "");
}

/**
 * The replacement can't be created under the canonical name — `container_name` in the compose
 * file pins it and the original still holds it — so it comes up beside it and takes the name
 * once it has run (`completeTakeOver`, #548). Keeping the canonical name is what lets `bot-ops.sh` and the
 * desktop Ops panels, which filter on it, keep working across a swap with no change.
 *
 * Derived from the BASE name (#492): `-next` is a reserved suffix, so a bot that is still named
 * `<name>-next` is never asked for `<name>-next-next`, and `redeploy()` REFUSES to run from one rather than
 * target its own name — see its docstring. A drifted `<name>-next-next` folds back to `<name>-next`.
 */
export function replacementName(inspectedName: string): string {
  return `${baseName(inspectedName)}-next`;
}

/** A git URL the daemon can fetch a build context from: the whole repo at the target ref
 *  (a branch name or a full sha both work — GitHub serves a fetch by either). */
export function buildRemote(repo: string, ref: string): string {
  return `https://github.com/${repo}.git#${ref}`;
}

/**
 * The only tag a fresh build gets. Never `:latest` — see `latestTag` and `completeTakeOver`'s
 * `tagLatest`. Before issue #39's fix this was one of two tags applied at build time (the other
 * being `:latest` itself), and the *build* result's tag array happening to put `:latest` first is
 * exactly what let a not-yet-verified image get used both to build and to create the replacement.
 */
export function shaTag(currentImage: string, sha: string): string {
  const repo = currentImage.split(":")[0] ?? currentImage;
  return `${repo}:${shortSha(sha)}`;
}

/**
 * The floating tag every recreate path other than a fresh self-update resolves the service image
 * by (`bot-ops.sh env-set`'s `up -d --force-recreate`, a Dockge restart, a plain `compose up
 * -d`). Applied only once `completeTakeOver` runs for the replacement under it: it has logged in,
 * finished `activate()` and gone through its first tick (settled, or 60 s passed; #548) — never at
 * build time (issue #39), so none of those paths can ever recreate the bot on a build that merely
 * compiled but crashed at boot, or crashed before its start-up and first tick were through.
 */
export function latestTag(currentImage: string): string {
  const repo = currentImage.split(":")[0] ?? currentImage;
  return `${repo}:latest`;
}

/**
 * Per-sha tags to drop, oldest first, once more than `keep` exist. Only ever selects tags of
 * this image's own repo that look like a short sha — `:latest` and anything hand-tagged are
 * never candidates, so a rollback target someone parked by name survives pruning.
 */
export function selectImagesToPrune(
  images: ImageSummary[],
  currentImage: string,
  keep = KEEP_SHA_TAGS,
): string[] {
  const repo = currentImage.split(":")[0] ?? currentImage;
  // String ops, not a RegExp built from `repo` — a registry-qualified name's dots would match
  // loosely and could sweep in another repo's sha tags. The WIDTH regex, on the other hand, is
  // rebuilt from SHORT_SHA_LEN (not hand-written) so it can never silently drift from what
  // `shaTag` above actually produces — #132: a hand-written {7} left at the old width while
  // SHORT_SHA_LEN changed would make every future sha tag permanently un-prunable.
  const shaTagWidthRe = new RegExp(`^[0-9a-f]{${SHORT_SHA_LEN}}$`);
  const isShaTag = (tag: string) =>
    tag.startsWith(`${repo}:`) && shaTagWidthRe.test(tag.slice(repo.length + 1));
  const tagged = images
    .flatMap((img) => (img.RepoTags ?? []).map((tag) => ({ tag, created: img.Created })))
    .filter(({ tag }) => isShaTag(tag))
    .sort((a, b) => b.created - a.created);
  return tagged.slice(keep).map((t) => t.tag);
}

/**
 * The replacement's container spec, derived entirely from the original's own inspect — which
 * is what keeps this zero-config: the compose project, volumes, network and restart policy are
 * discovered, never configured.
 *
 * `GIT_SHA` is dropped from the copied env on purpose. `Config.Env` merges the image's baked-in
 * ENV with the container's own, so copying it verbatim would pin the *old* build's sha onto the
 * new container and override the new image's — leaving a correctly-updated bot convinced it was
 * still the old build, and reporting the update as a no-op.
 *
 * `oldImageEnv` generalizes that same fix to every other image-baked var (`PATH`,
 * `BUN_INSTALL_BIN`, the base image's cache path, anything future `ENV`-added the way `GIT_SHA`
 * was): `Config.Env` merges the image's own ENV with the container's, so copying it verbatim
 * pins *every* image default at the old image's value forever. An entry is dropped only when it
 * matches an `oldImageEnv` entry **verbatim** — matching by key alone would also drop a genuine
 * operator override that happens to share a key with an image default.
 *
 * The network's own `Aliases` (e.g. compose's `bot` service alias) are carried over too — without
 * them the replacement resolves by container name only, so `http://bot:<port>` (README's
 * documented tunnel mapping) stops resolving after the first self-update. Docker auto-adds a
 * container's own short id to this same array on top of any deliberately-configured alias, so
 * that one entry is dropped — it names the OLD container specifically and means nothing on the
 * new one, unlike a real service alias which is meant to be shared.
 *
 * #160: the replacement's OWN restart policy is always `{ Name: "no" }` — never the original's —
 * so Docker itself can never resurrect an unverified standby mid-boot-loop or mid-crash. The
 * original's real policy name rides along in the env instead (`HANDOFF_RESTART_POLICY_ENV`,
 * alongside `HANDOFF_FROM_ENV`), for `takeOver` to restore onto this container once it has
 * actually verified — see `takeOver`'s own docstring for why the ordering there is load-bearing.
 * #490: an `on-failure` original's `MaximumRetryCount` rides along too (`HANDOFF_RESTART_RETRIES_ENV`),
 * and only for `on-failure` with a positive cap, so the restore does not turn "retry 5 times" into
 * "retry forever".
 */
export function buildCreateSpec(
  self: ContainerInspect,
  o: { image: string; handoffFrom: string; oldImageEnv: string[] },
): CreateContainerSpec {
  const oldImageEnvSet = new Set(o.oldImageEnv);
  const originalPolicyName = self.HostConfig.RestartPolicy?.Name || "unless-stopped";
  const env = self.Config.Env.filter(
    (e) =>
      !e.startsWith("GIT_SHA=") &&
      !e.startsWith(`${HANDOFF_FROM_ENV}=`) &&
      !e.startsWith(`${HANDOFF_RESTART_POLICY_ENV}=`) &&
      !e.startsWith(`${HANDOFF_RESTART_RETRIES_ENV}=`) &&
      !oldImageEnvSet.has(e),
  );
  env.push(`${HANDOFF_FROM_ENV}=${o.handoffFrom}`);
  env.push(`${HANDOFF_RESTART_POLICY_ENV}=${originalPolicyName}`);
  const originalRetries = self.HostConfig.RestartPolicy?.MaximumRetryCount ?? 0;
  if (originalPolicyName === "on-failure" && originalRetries > 0) {
    env.push(`${HANDOFF_RESTART_RETRIES_ENV}=${originalRetries}`);
  }
  const netMode = self.HostConfig.NetworkMode;
  const selfShortId = self.Id.slice(0, 12);
  const aliases = netMode
    ? self.NetworkSettings.Networks[netMode]?.Aliases?.filter((a) => a !== selfShortId)
    : undefined;
  return {
    Image: o.image,
    Env: env,
    // Replicated verbatim so compose still recognises the container as its own service.
    Labels: { ...self.Config.Labels },
    // Without this the replacement falls back to the image's `USER bun`, and its entrypoint
    // then has no root to drop from — so it could never join the socket's group, and would
    // come up unable to retire anyone.
    User: self.Config.User,
    HostConfig: {
      // Derived from Mounts rather than HostConfig.Binds: compose may express a named volume
      // as either, and Mounts is the one that is always populated.
      Binds: self.Mounts.map(
        (m) => `${m.Name ?? m.Source}:${m.Destination}:${m.RW ? "rw" : "ro"}`,
      ),
      // #160: never the original's policy — see this function's own docstring. Never
      // {Name:"on-failure", MaximumRetryCount:0} either; Docker reads 0 as unlimited, not zero.
      RestartPolicy: { Name: "no" },
      NetworkMode: netMode,
      // Compose's `init: true` lives on the container, not the image — without carrying it
      // over, the replacement runs its process as PID 1 instead of under docker-init.
      Init: self.HostConfig.Init ?? undefined,
    },
    ...(netMode && aliases?.length ? { NetworkingConfig: { EndpointsConfig: { [netMode]: { Aliases: aliases } } } } : {}),
  };
}

/** Only ever a failure: a redeploy that *works* kills this process before it can return. */
export interface RedeployResult {
  outcome?: HandoffOutcome;
  error?: string;
  /** What became of the `<name>-next` container (#451): nothing to clean up (never created, or the daemon
   *  had nothing by that id or name), removed, left alone because it restarted after the verdict (the
   *  generation guard), or still there after a failed removal. */
  replacement?: ReplacementDisposition;
  /** Set with `remove-failed`: the daemon's answer. */
  replacementError?: string;
}

/** Test seams; real callers take every default. */
export interface RedeployOptions {
  /** `RETIREMENT_DEADLINE_MS`: the post-`ready` retirement wait. */
  deadlineMs?: number;
  /** `POLL_MS`: the interval of both the handoff poll and the retirement wait. */
  pollMs?: number;
  /** `HANDOFF_DEADLINE_MS`: how long the original waits for a verdict. */
  handoffDeadlineMs?: number;
  /** The clock the verdict times, the handoff deadline's elapsed time and the generation guard use. Not the
   *  retirement wait's, which keeps `Date.now()`: with a fixed clock the retirement wait would never end. */
  now?: () => number;
  /** The marker reads in the handoff poll and in `redeploy()`; not the retirement wait's. */
  readMarker?: typeof readMarker;
}

/**
 * Build the target sha, start it alongside, and wait for it to verify.
 *
 * Returns only when the swap has *failed* — on success the replacement retires this process
 * partway through the wait, so the successful path never returns at all. Observing `ready` is
 * therefore not a return: it starts the retirement wait, and outliving that wait is itself a
 * failure (`stalled`), because the one thing `ready` promised was a stop that never came.
 *
 * Two refusals, both before anything is quiesced or created (#492, #547): a bot whose own name ends in
 * `-next` (the suffix is reserved for the replacement; the message says what to do, and `healOwnName`
 * is what takes the canonical name back at boot), checked on the name alone before the build; and a
 * RUNNING container already holding the replacement's name, checked after the build so one that appeared
 * during it is seen. Nothing is ever force-removed by name.
 */
export async function redeploy(latestSha: string, opts: RedeployOptions = {}): Promise<RedeployResult> {
  const now = opts.now ?? Date.now;
  const read = opts.readMarker ?? readMarker;
  const pollMs = opts.pollMs ?? POLL_MS;
  await clearMarker();

  let self: ContainerInspect;
  try {
    self = await inspectSelf();
  } catch (err) {
    // Nothing was created yet, so there is nothing of ours to remove (#451).
    return { error: `could not inspect own container: ${(err as Error).message}`, replacement: "none" };
  }
  if (canonicalName(self.Name) !== baseName(self.Name)) {
    // #547/#492: a bot that is itself `<name>-next` must not sweep or create under that name. Refused here,
    // before anything is built, on the name alone: no daemon call beyond the self-inspect above, and nothing to
    // unwind. `docker restart` is only advised where `healOwnName` would act: a swap's replacement (HANDOFF_FROM
    // set), not one that is named after its compose project, which is the deployment's own name (install.sh).
    const current = canonicalName(self.Name);
    return {
      error:
        process.env[HANDOFF_FROM_ENV] && !namedAfterItsProject(self)
          ? `this bot is named ${current}, which is a swap's replacement name: if the swap that started it is still finishing, wait a minute; if it persists, the rename never landed and docker restart ${current} heals the name at boot (#547). The automatic check will not retry this sha, so run /update again afterwards`
          : "this container's name ends in -next, which the self-update reserves for its replacement, so it cannot self-update: give it another container_name (for an install.sh instance, another instance name) and recreate it",
      replacement: "none",
    };
  }

  const tag = shaTag(self.Config.Image, latestSha);
  console.log(`[redeploy] building ${tag} from ${shortSha(latestSha)}`);
  // Built from the exact compared sha, not `config.botBranch`'s current tip: the daemon fetches
  // at build *start*, seconds after `latestSha` was resolved, and a push landing in that window
  // would otherwise build newer code while still stamping it GIT_SHA=<the older, compared sha>.
  const built = await buildImage({
    remote: buildRemote(config.githubRepo, latestSha),
    tags: [tag],
    buildArgs: { GIT_SHA: latestSha },
  }).catch((err) => ({ ok: false, error: (err as Error).message }));

  if (!built.ok) {
    // A failed build is inert: nothing has been created, so there is nothing to unwind — and the
    // scheduler was never quiesced (beginHandoff runs only just before the create below), so a
    // failed or wedged build leaves nothing to resume.
    return { error: `build failed: ${built.error ?? "unknown error"}`, replacement: "none" };
  }
  await pruneOldImages(self.Config.Image);

  // Best-effort: this is what lets a var baked into the OLD image (not just GIT_SHA) fall back
  // to the new image's own default instead of staying pinned forever. A failed inspect degrades
  // to the old behavior (carry everything over) rather than failing a redeploy over housekeeping.
  const oldImageEnv = await inspectImage(self.Image)
    .then((img) => img.Config.Env)
    .catch(() => []);

  const name = replacementName(self.Name);
  // #492: whatever holds the replacement's name is inspected here, after the build (so a holder that appeared
  // during it is seen) and before the quiesce. A RUNNING holder is never swept; a stopped one is removed by id
  // below, un-forced, so one that starts in between is a 409 and a reported failure, not a kill.
  let leftover: ContainerInspect | undefined;
  try {
    leftover = await tryInspectContainer(name);
  } catch (err) {
    return { error: `could not check for a leftover ${name}: ${(err as Error).message}`, replacement: "none" };
  }
  if (leftover?.State.Running) {
    return {
      error: `a running container already holds ${name} — not sweeping a live container; check docker ps`,
      replacement: "none",
    };
  }
  // Quiesce the scheduler now, not before the build: only the create→verify window needs the
  // scheduler quiet (the replacement shares the state volume once it exists), and the build writes
  // no state at all. Quiescing through it therefore bought nothing but risk — an unbounded pause on
  // a wedged build (#130).
  //
  // This does NOT mean the scheduler always keeps ticking during the build. On the auto-update path
  // the build runs INSIDE a tick, so `guardedTick`'s own `tickInFlight` skips later ticks until its
  // 5-min watchdog releases them; only an admin `/update` (an interaction, outside the scheduler)
  // genuinely announces throughout. The win is that the pause is bounded either way, and the build
  // itself is now timeout-bounded.
  beginHandoff(`redeploy -> ${shortSha(latestSha)}`);
  let replacementId: string | undefined;
  try {
    // A stopped leftover from an earlier failed attempt, removed by id and NOT forced (#492): one that was
    // started since the inspect above is a 409 here, which the catch below reports as a failure instead of
    // killing a live bot. Only when one was seen: no leftover, no call.
    if (leftover) await removeContainer(leftover.Id);
    replacementId = await createContainer(
      name,
      buildCreateSpec(self, { image: tag, handoffFrom: self.Id, oldImageEnv }),
    );
    await startContainer(replacementId);
  } catch (err) {
    // createContainer can succeed and startContainer still throw (a bind-mount error, a network
    // alias conflict, a daemon hiccup) — without cleaning up here, that leaves a replacement that
    // exists but never started, and the ONLY other cleanup site is this same function's own
    // leftover-removal above, which doesn't run again until the next redeploy attempt. Since
    // #51 item 5, that lingering container also reads as "a swap is still in progress" to
    // bot-ops.sh's guard (a `created` one does, on purpose; an exited leftover no longer blocks it
    // since #490), refusing restart/env-set for however long until that next attempt —
    // which the update scheduler's own anti-loop suppression can push out indefinitely for the
    // same sha. Best-effort: a cleanup failure here must not shadow the real error being reported.
    //
    // Cleans up by NAME when there is no id (#130). `createContainer` is now timeout-bounded, so it
    // can abort while the daemon goes on to create the container anyway — a slow-then-recovering
    // daemon is exactly the case that bound exists for. `replacementId` is then never assigned, and
    // an id-only cleanup would skip the orphan entirely, leaving a `<name>-next` (`created`,
    // so not an exited leftover) that bot-ops.sh reads as "a swap is still in progress" until some
    // LATER redeploy's leftover sweep above runs
    // — which the anti-loop suppression can defer indefinitely for the same sha.
    //
    // Forced only WITH an id (#492): the start may have taken effect, and a plain DELETE of a running
    // container is a 409 that would leave a second live bot. By name, un-forced: with no id the container was
    // never started by us, so the orphan is `created` and a plain DELETE removes it. A RUNNING holder of the
    // name is someone else's (it took the name during the build, so the create failed on a 409, or the sweep
    // above did, and no create was attempted) and the 409 here is reported instead of killing it: in the error
    // text, with the disposition `none` (nothing of OURS is left), not `remove-failed`, whose requester message
    // says "remove the -next container by hand", which is the wrong advice for a live bot.
    let replacement: ReplacementDisposition = "none";
    let replacementError: string | undefined;
    let foreignHolder: string | undefined;
    try {
      // The daemon may have nothing by that name (a create it rejected outright, e.g. a 400 on a bad
      // bind): then nothing was started and the requester must not hear "removed" (#451).
      replacement = (await (replacementId ? removeContainer(replacementId, true) : removeContainer(name))) ? "removed" : "none";
    } catch (cleanupErr) {
      if (replacementId === undefined) {
        foreignHolder = (cleanupErr as Error).message;
        console.error(`[redeploy] ${name} is held by a container that could not be removed — leaving it alone: ${foreignHolder}`);
      } else {
        replacement = "remove-failed";
        replacementError = (cleanupErr as Error).message;
        console.error(`[redeploy] could not clean up the failed replacement: ${replacementError}`);
      }
    }
    endHandoff();
    return {
      error: `could not start the replacement: ${(err as Error).message}${foreignHolder !== undefined ? ` — and ${name} is held by a container that could not be removed (it may be running; check docker ps)` : ""}`,
      replacement,
      ...(replacementError !== undefined ? { replacementError } : {}),
    };
  }
  console.log(`[redeploy] replacement ${name} started — waiting for it to verify`);

  let outcome: HandoffOutcome;
  // #431: the verdict's own time, the baseline the generation guard below compares the replacement's
  // later StartedAt against. Replaced by the poll's own observation, re-sampled after the retirement wait
  // and in the backstop catch — never left at epoch 0, which made the guard read EVERY running replacement
  // as a later life and skip the removal. The pre-poll value here is a default no path reads today (the
  // poll's return and the catch both assign before the guard does); it stays so a path added later that
  // forgets to assign sees a real time, not epoch 0.
  let observedAt = now();
  let pollError: string | undefined;
  try {
    const decided = await awaitHandoff(replacementId, {
      deadlineMs: opts.handoffDeadlineMs ?? HANDOFF_DEADLINE_MS,
      pollMs,
      now,
      readMarker: read,
    });
    outcome = decided.outcome;
    observedAt = decided.observedAt;
    // Set only when the LAST poll's inspect failed: a deadline spent on a daemon that would not answer
    // is named to the requester; an error the daemon recovered from is not blamed for a silent replacement.
    if (outcome === "timeout") pollError = decided.lastPollError;
    if (outcome !== "ready") {
      // Row 15 of the handoff state table: a `ready` written after that poll's marker read and before its
      // verdict would otherwise lose to `timeout` or `failed`. What the replacement SAID outranks what the
      // poll saw, so read once more before acting on anything else. A `ready` that lands after THIS re-read
      // (before the removal below) is the residual window: the generation guard's inspect plus the removal
      // call — milliseconds against a healthy daemon, up to two sequential 60 s call bounds against a hanging one.
      const late = await read();
      if (late?.status === "ready") {
        console.warn(`[redeploy] the replacement signalled ready as the poll decided ${outcome} — honouring it`);
        outcome = "ready";
        pollError = undefined;
      } else if (late?.status === "failed" && outcome !== "failed") {
        // The poll said `timeout` but the replacement gave up in that window: its own word beats "never
        // reported in", and its own reason (read back from the marker below) beats the poll's last daemon
        // error. A poll that already decided `failed` from this very marker has nothing to correct.
        console.warn(`[redeploy] the replacement signalled failed as the poll decided ${outcome} — reporting that`);
        outcome = "failed";
        pollError = undefined;
      }
    }
    if (outcome === "ready") {
      // It has verified and is retiring us; this process is about to be stopped mid-sentence.
      // Almost. `ready` is a promise of a stop, not the stop itself — if `retireOriginal` dies
      // between writing the marker and stopping us, that promise is never kept, and without a
      // bound here this process would sit quiesced forever: alive, silent, and doing nothing,
      // which is the outage nazumods/wow#879 exists to prevent. So the wait for our own death gets a
      // deadline too. Reaching it demotes the outcome to `stalled` and falls through to the
      // same cleanup as any other failed swap.
      //
      // The wait polls the marker rather than sleeping blind for the whole deadline: `takeOver`
      // writes `failed` (with a reason) the moment its own retire attempt throws, and a blind
      // sleep would sit on that answer for up to `RETIREMENT_DEADLINE_MS` before ever reading it.
      console.log("[redeploy] replacement verified — handing over");
      if (await awaitRetirementFailure(opts.deadlineMs, pollMs)) {
        console.error("[redeploy] replacement signalled failed after verifying — reclaiming");
        outcome = "failed";
      } else {
        console.error("[redeploy] verified replacement never retired us — reclaiming");
        outcome = "stalled";
      }
      // #160: re-sample the removal guard's baseline HERE, not the much-earlier "ready" observation
      // above. awaitRetirementFailure can run for up to RETIREMENT_DEADLINE_MS (3 minutes) — a
      // replacement whose restorePolicy update genuinely landed at the daemon but whose response was
      // lost (the exact transport-drop class retireOriginal's own re-inspect already treats as
      // realistic) restarts under its now-correctly-restored policy sometime in that window, and its
      // StartedAt must be judged against when THIS decision was actually made, not against the stale
      // moment "ready" first arrived — an unrefreshed baseline biases the guard toward wrongly
      // skipping a removal it should make.
      observedAt = now();
    }
  } catch (err) {
    // The #37 safety net. A failed inspect no longer reaches here (awaitHandoff catches it per poll,
    // and `readMarker` never throws; the retirement wait has no throwing call either), so this is for
    // something new: a throw from a test seam, the clock, or code added later. It must not escape
    // uncaught — left unguarded, the rejection propagated straight through `applyUpdate` ->
    // `checkForUpdate` and skipped everything below, including `endHandoff()`, quiescing the bot forever.
    // It still un-quiesces on every exit, and it judges the replacement against the moment it fired
    // (#431): a throw late in a long wait must not leave the guard comparing against the pre-poll time.
    pollError = (err as Error).message;
    console.error(`[redeploy] handoff decision failed: ${pollError} — reclaiming`);
    outcome = "failed";
    observedAt = now();
  }

  const marker = await read();
  let replacement: ReplacementDisposition = "removed";
  let replacementError: string | undefined;
  try {
    // #160 change 5, defence in depth: change 2 (the standby's RestartPolicy:"no") already stops
    // Docker itself from producing this, so this guard is for what's left — a manual `docker
    // start` on the replacement, or a standby created by a pre-#160 original mid-rollout (still on
    // "unless-stopped"). Compares container GENERATIONS, not identity: if the replacement is
    // running again and its CURRENT StartedAt is strictly after the moment we decided its outcome,
    // it's a different life of the same container than the one we just judged — leave it alone
    // rather than force-remove a bot that may be genuinely up and serving. A tie (same instant) is
    // not ">" and is removed, same as before — an ordinary same-generation removal never races its
    // own StartedAt against itself.
    //
    // The confirmation inspect is allowed to fail WITHOUT skipping removal — a daemon blip here
    // must degrade to the ordinary attempt (same as before this guard existed), never become a new
    // reason cleanup is skipped; only a POSITIVE, confirmed "it's a later generation" ever does.
    let restartedSinceDecision = false;
    try {
      const current = await tryInspectContainer(replacementId);
      restartedSinceDecision =
        current?.State.Running === true &&
        !!current.State.StartedAt &&
        Date.parse(current.State.StartedAt) > observedAt;
    } catch (inspectErr) {
      console.warn(
        `[redeploy] couldn't confirm the replacement's generation before removing it — proceeding as usual: ${(inspectErr as Error).message}`,
      );
    }
    if (restartedSinceDecision) {
      replacement = "left";
      console.warn(`[redeploy] replacement restarted after we decided ${outcome} — leaving it alone`);
    } else {
      // The window left open: a `ready` written after the re-read in the try above and before this call — the
      // guard's inspect plus this removal, milliseconds against a healthy daemon, up to two sequential 60 s
      // call bounds against a hanging one — removes a replacement mid-retire. `none` when the daemon already
      // had nothing by that id (#451): the requester must not hear "removed" for what was never there.
      replacement = (await removeContainer(replacementId, true)) ? "removed" : "none";
    }
  } catch (err) {
    // Cleanup, not the verdict — a stuck removal (e.g. a 409 mid-teardown) must not skip the
    // `endHandoff()` below either, for the same reason a poll failure above must not.
    replacement = "remove-failed";
    replacementError = (err as Error).message;
    console.error(`[redeploy] could not remove the replacement: ${replacementError}`);
  } finally {
    // endHandoff FIRST, and synchronously. Everything this block exists to guarantee is that the
    // bot un-quiesces on every exit (#37); an await ahead of it puts a rejection between the
    // failure and the un-quiesce, which is the permanent-quiesce bug itself. `clearMarker` swallows
    // its own errors today, so the old order was safe by someone else's implementation detail
    // rather than by construction — this ordering costs nothing and needs no such assumption.
    endHandoff();
    await clearMarker();
  }
  console.warn(`[redeploy] handoff ${outcome} — staying on the current build (replacement: ${replacement})`);
  return {
    outcome,
    error: pollError ?? marker?.error,
    replacement,
    ...(replacementError !== undefined ? { replacementError } : {}),
  };
}

/** Poll the marker and the replacement's own state until one of them decides it. `observedAt` is
 *  sampled right before the observation that produced the terminal outcome (#160, change 5) — the
 *  baseline `redeploy()`'s pre-removal generation check compares the replacement's later
 *  `State.StartedAt` against, so a replacement that restarted after this observation isn't
 *  force-removed as if it were still the one this outcome was decided about. A failed inspect (#433)
 *  is not a verdict: the marker, read first, still decides; otherwise the replacement's state is
 *  unknown for that poll and the deadline bounds how long that can go on. `lastPollError` is the LAST
 *  poll's inspect error, or undefined when the last poll's inspect worked. */
async function awaitHandoff(
  replacementId: string,
  o: { deadlineMs: number; pollMs: number; now: () => number; readMarker: typeof readMarker },
): Promise<{ outcome: HandoffOutcome; observedAt: number; lastPollError?: string }> {
  const startedAt = o.now();
  let lastPollError: string | undefined;
  for (;;) {
    const observedAt = o.now();
    const marker = await o.readMarker();
    let container: ContainerInspect | undefined;
    let inspectFailed = false;
    try {
      container = await tryInspectContainer(replacementId);
      if (lastPollError !== undefined) console.log("[redeploy] the replacement's state is readable again");
      lastPollError = undefined;
    } catch (err) {
      inspectFailed = true;
      const message = (err as Error).message;
      if (lastPollError === undefined) {
        console.warn(`[redeploy] could not inspect the replacement (${message}); still waiting on the marker`);
      }
      lastPollError = message;
    }
    const outcome = decideHandoffOutcome({
      marker,
      replacement: container && {
        running: container.State.Running,
        status: container.State.Status,
        exitCode: container.State.ExitCode,
      },
      inspectFailed,
      elapsedMs: o.now() - startedAt,
      deadlineMs: o.deadlineMs,
    });
    if (outcome !== "waiting") return { outcome, observedAt, lastPollError };
    await Bun.sleep(o.pollMs);
  }
}

/**
 * Poll the marker during the post-`ready` retirement wait, so a `failed` written after the
 * replacement already signalled `ready` is caught within one `pollMs`, not left sitting until
 * `deadlineMs` (`RETIREMENT_DEADLINE_MS`, 3 minutes) elapses blind. Returns `true` the moment the
 * marker flips to `failed`; `false` once the whole deadline passes while it's still `ready`
 * (a genuine stall — the daemon socket itself is presumed stuck, per `handoffFailureMessage`).
 */
async function awaitRetirementFailure(
  deadlineMs = RETIREMENT_DEADLINE_MS,
  pollMs = POLL_MS,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    await Bun.sleep(pollMs);
    if ((await readMarker())?.status === "failed") return true;
  }
  return false;
}

async function pruneOldImages(currentImage: string): Promise<void> {
  try {
    for (const tag of selectImagesToPrune(await listImages(), currentImage)) {
      console.log(`[redeploy] pruning old image ${tag}`);
      await removeImage(tag);
    }
  } catch (err) {
    // Disk housekeeping is never worth failing a good deploy over.
    console.warn("[redeploy] image prune skipped:", (err as Error).message);
  }
}

/**
 * The replacement's side of the swap, run once it has logged in: STOP the original, and nothing more
 * (#548). The removal, the canonical name and `:latest` wait for {@link completeTakeOver}, which runs after
 * this build has finished `activate()` and run its first tick -- so until then the stopped original is
 * still there, and `docker start <name>` on it is the way back from a build that logs in and then dies.
 *
 * A stop, not a removal: an explicit `docker stop` is exempt from `restart: unless-stopped`, so the
 * stopped original stays down on its own (under `always` a daemon restart would bring it back, which
 * {@link detectRollback} and {@link completeTakeOver} read as an operator's rollback and step aside for).
 *
 * This can also run a second time against the same original id, with nothing left alive to
 * reclaim if it fails: the stopped-but-not-removed corpse this leaves is now the NORMAL state between a
 * login and the end of probation (not only the trace of a failed removal), so a build that crashes in
 * probation restarts as a standby (env-based `bootMode`, or #46's daemon-confirmed `resolveBootMode`) and
 * retries `takeOver` -> `retireOriginal` against it — and separately, `HANDOFF_FROM` never clears from a
 * swapped-in container's own env, so any boot path that still honors it against an id since fully
 * removed lands here with the original already gone entirely. Only a genuinely *live* original — the one
 * case where this really is the first attempt — can still reclaim if the stop below fails, so only that
 * case gets the strict propagate-on-failure behavior; both "already stopped" and "already gone" degrade
 * a stop failure instead of crashing the sole live bot.
 */
export async function retireOriginal(originalId: string): Promise<void> {
  const original = await tryInspectContainer(originalId);
  // Only a running original is still around to reclaim us if the stop below fails — a first
  // attempt is the only case where that's true. `original` being `undefined` (fully gone) or
  // present-but-not-running (a corpse from an earlier incomplete cycle) are both "nothing left to
  // reclaim," so both get the same tolerant handling.
  const originalStillLive = original !== undefined && original.State.Running;
  if (originalStillLive) {
    // #160: with the replacement's own RestartPolicy now "no" until takeOver restores it, a stop
    // that THROWS here is no longer necessarily a failed stop — #130 bounds this call at 60s, so a
    // stop the daemon actually performed but answered slowly now looks identical to one that never
    // happened at all. Re-inspecting tells the two apart: if the original is confirmed down, the
    // stop worked and a slow response is not a reason to leave the sole live bot exiting — proceed
    // exactly as the ordinary path would. If it's still running, the stop
    // genuinely failed and the original really is alive to reclaim — rethrow, unchanged from before.
    try {
      await stopContainer(originalId);
    } catch (err) {
      const stillThere = await tryInspectContainer(originalId);
      if (stillThere === undefined || !stillThere.State.Running) {
        console.warn("[handoff] stop answered late — the original is already down; continuing");
      } else {
        throw err;
      }
    }
  } else {
    await stopContainer(originalId).catch((err) => {
      console.warn(`[handoff] stop of the already-gone-or-stopped original failed: ${(err as Error).message}`);
    });
  }
  // Nothing follows the stop: the removal, the name and `:latest` are completeTakeOver's, after probation.
  console.log(`[handoff] stopped the previous container ${originalId.slice(0, 12)} — kept until this build has run (#548)`);
}

/** Test seams for {@link takeOver}: each defaults to the real effect, and is overridden in tests
 *  so the failure path can be exercised without a live daemon or touching the marker file. */
export interface TakeOverEffects {
  write?: typeof writeMarker;
  retire?: typeof retireOriginal;
  clear?: typeof clearMarker;
  /** Restores the ORIGINAL's real restart policy onto this (now-verified) container. Runs BEFORE
   *  `retire` — see {@link takeOver}'s own docstring for why the ordering is load-bearing.
   *  **Not** best-effort: a throw here propagates to the outer catch (failed marker + exit), because
   *  a swallowed failure would leave the *surviving* bot on `RestartPolicy: "no"` forever —
   *  silently, until a host reboot doesn't bring it back and someone notices weeks later. */
  restorePolicy?: () => Promise<void>;
  /** Whether the original is RUNNING although this container has taken over before — {@link detectRollback},
   *  asked AGAIN right before this container announces `ready` and stops the original (#548). The boot-time
   *  check cannot see an operator's `docker start <name>` that lands later, in the seconds between boot and
   *  login; without this second look `takeOver` would stop the original the operator had just started. What is
   *  left is the few daemon calls from here to the stop. */
  rolledBack?: () => Promise<boolean>;
  /** Stops this container instead of the original ({@link stepAside}); only reached when `rolledBack` says so. */
  stepAside?: () => Promise<never>;
  /** Seams for the DEFAULT `stepAside` (its `exit`, `sleep`, `stop`), so the real wiring of the rollback branch
   *  can be exercised without ending the test process. Ignored when `stepAside` is given. */
  stepAsideDeps?: RollbackDeps;
  exit?: (code: number) => void;
}

/** The real `tagLatest` effect (run from {@link completeTakeOver}): reads this container's own image
 *  (always a sha tag post-#39, never `:latest` itself) and points `:latest` at it. */
async function tagSelfAsLatest(): Promise<void> {
  const self = await inspectSelf();
  await tagImage(self.Config.Image, latestTag(self.Config.Image));
}

/** The real `restorePolicy` effect (#160): reads the original's restart policy carried in this
 *  (standby) container's own env — the name in `HANDOFF_RESTART_POLICY_ENV`, set by `buildCreateSpec`,
 *  and for `on-failure` the cap in `HANDOFF_RESTART_RETRIES_ENV` (#490) — and restores it onto THIS,
 *  now-verified, container before the original is ever stopped. Falls back to `"unless-stopped"` when
 *  the name is absent (a `takeOver` invoked outside the normal create path, or a standby created by a
 *  pre-#160 original mid-rollout); the cap is passed only for `on-failure` with a positive integer
 *  (never `MaximumRetryCount: 0`, which Docker reads as unlimited), so a standby created by an older
 *  original, or a junk value, restores the name alone as before. */
async function restoreOriginalRestartPolicy(): Promise<void> {
  const name = process.env[HANDOFF_RESTART_POLICY_ENV] ?? "unless-stopped";
  const retries = Number(process.env[HANDOFF_RESTART_RETRIES_ENV]);
  const policy =
    name === "on-failure" && Number.isInteger(retries) && retries > 0
      ? { Name: name, MaximumRetryCount: retries }
      : { Name: name };
  const self = await inspectSelf();
  await updateContainer(self.Id, { RestartPolicy: policy });
}

/**
 * The replacement's side of the swap once it has logged in, made crash-proof.
 *
 * Runs in the *replacement*: it announces `ready` (which stops the original counting toward its
 * deadline), restores the *original's* restart policy onto itself (#160 — not best-effort, see
 * {@link TakeOverEffects}), retires the *original* — `retireOriginal` STOPS that other container,
 * never this one, and removes nothing (#548) — and clears the marker. On success this returns, and
 * `index.ts` goes on to `activate()`; this process is the survivor that becomes the live bot.
 *
 * What happens at the login versus after probation (#548): the login is the bar for STOPPING the
 * original, which is then kept. Once `activate()` has returned and the first scheduler tick has
 * settled (or 60 s have passed), `finishProbation` runs {@link completeTakeOver}: the `:latest` tag
 * (#39, #490), the removal of the stopped original, and its name. Until then `docker start <name>` on
 * the original is the rollback: a replacement that finds the original RUNNING — at a standby boot after
 * it has taken over before ({@link detectRollback}), again right before it would stop the original
 * (`rolledBack`, below), or when `completeTakeOver` looks — steps aside instead of stopping it again
 * ({@link stepAside}). That is not instant: a replacement that is alive and in probation only looks at
 * the end of it (the rest of `activate()` plus up to 60 s), and both bots answer on the shared token
 * until then; stopping the replacement FIRST (`docker stop <name>-next`, which also ends a crash loop)
 * and then `docker start <name>` has no overlap, and also covers a replacement that hangs rather than
 * crashes (it never reaches any check): stop it first, `docker rm -f <name>-next` ends it at once. A
 * `recreate` or `env-set` is no rollback: it gives the original a NEW id, which none of these checks
 * follow (`bot-ops.sh` refuses both while `<name>-next` is alive, #490; a plain `compose up -d` does
 * not, and most likely just starts the stopped original, which is a rollback).
 *
 * The guard is for the unhappy path. Almost every throw site inside is at or before the original
 * is stopped: `write`, `restorePolicy`, and the pre-stop inspect all precede it, and
 * `stopContainer` throws on an HTTP error before the stop has taken — so a throw normally leaves
 * the original still alive and about to reclaim us, via `failed` if it is still polling or
 * `stalled` once it gives up waiting for a stop that never comes. Past the stop, `retireOriginal`
 * itself re-inspects a slow-but-real stop rather than treating it as a failure (#160) — so the one
 * remaining way both bots end up momentarily down is a transport-level drop *after* the daemon has
 * genuinely stopped the original but before its response returns *and* the re-inspect that follows
 * also can't confirm it; then `unless-stopped` restarts this process — this container's own policy
 * is restored by this point, so it is no longer `"no"` — its next `takeOver` finds the original
 * already stopped (a no-op stop; `completeTakeOver` removes it and takes the name once probation
 * ends) and goes live. So the
 * worst case is a bounded, self-recovering blip: never a permanent outage, and never two live bots.
 * (Before #160 the standby's own policy stayed the original's `unless-stopped` throughout, so this
 * recovery path existed unconditionally; now it depends on `restorePolicy` having already run —
 * which is exactly why that call is NOT best-effort and sits before the stop, never after it.)
 *
 * `restorePolicy` has a mirror transport-drop case of its own: the daemon genuinely applies the
 * policy update, but the response is lost before this process reads it, so `takeOver` treats it as
 * a failure and exits (this container's *own* policy is still `"no"` at that exact instant — the
 * update it doesn't know succeeded is the very thing it's about to be judged on). Recovery here is
 * NOT the cheap no-op-stop path above: this container comes back under the now-genuinely-restored
 * policy, finds the original still RUNNING (it was never touched, so it stays live and reclaims on
 * its own deadline or the `failed` marker written below), and — since #548 — STEPS ASIDE
 * ({@link detectRollback}: a running original plus an own policy other than `no`) instead of re-running
 * the whole standby cycle (boot, `resolveBootMode`, gateway login, `ClientReady`, a fresh `takeOver`)
 * and stopping the original a second time. It never produces two live bots or a permanent outage.
 * `redeploy()`'s generation-keyed removal guard (`awaitHandoff`'s `observedAt`, resampled at the point
 * the *original* actually decides `stalled`/`failed` — see its own comment) still keeps the original
 * from force-removing a replacement that is mid-flight.
 *
 * On failure, then, we do the one safe thing: write a `failed` marker — which lets an original
 * still polling reclaim at once instead of waiting its deadline out — and exit. We must not fall
 * through to `activate()`: two live bots on the one shared token would double every reply for the
 * seconds until the original tore us down regardless.
 *
 * Left unguarded, as it was, the throw became an unhandled rejection that crashed the replacement
 * mid-handoff — the same class of bug #33 fixed for slash-command registration, and it mirrors
 * the verify-deadline path in `index.ts`, which gives up in exactly this shape.
 */
export async function takeOver(originalId: string, effects: TakeOverEffects = {}): Promise<void> {
  const write = effects.write ?? writeMarker;
  const retire = effects.retire ?? retireOriginal;
  const clear = effects.clear ?? clearMarker;
  const restorePolicy = effects.restorePolicy ?? restoreOriginalRestartPolicy;
  const rolledBack = effects.rolledBack ?? (() => detectRollback({ ...process.env, [HANDOFF_FROM_ENV]: originalId }));
  const aside = effects.stepAside ?? (() => stepAside(effects.stepAsideDeps));
  const exit = effects.exit ?? ((code: number) => process.exit(code));
  // #548: look again before touching anything. An operator's `docker start <name>` that landed after the
  // boot-time check is a rollback; `ready` and the stop would undo it. Outside the try: this never throws,
  // and stepping aside is not a failed handoff (no `failed` marker, no exit(1) from the catch below).
  if (await rolledBack()) await aside();
  try {
    await write({ status: "ready", sha: config.gitSha, at: Date.now() });
    // #160: restore the ORIGINAL's restart policy onto THIS container — BEFORE retire(originalId).
    // The standby was created with RestartPolicy:"no" precisely so Docker can never resurrect it
    // half-verified; that protection only stays safe if a policy-restored, genuinely-live bot
    // exists before the one still-answering bot is torn down. Deliberately NOT wrapped in a
    // `.catch` — see TakeOverEffects.restorePolicy's own comment. (`:latest` is no longer tagged
    // here: it follows probation, in completeTakeOver — #548, #490.)
    await restorePolicy();
    await retire(originalId);
    await clear();
  } catch (err) {
    console.error(
      "[handoff] takeover failed — the original was never stopped, so it stays live and reclaims" +
        " (via its failed/stalled path); this replacement exits rather than run a second live bot" +
        " on the shared token.",
      err,
    );
    // Best-effort: if the marker mechanism itself is what broke, the original still reclaims on
    // its own deadline — the exit is what matters, so a failed write here must not stop it.
    await write({
      status: "failed",
      sha: config.gitSha,
      // `instanceof`, not `(err as Error).message`: a bare `throw null` would otherwise raise a
      // TypeError here — inside the catch, before `.catch` attaches — re-rejecting the very
      // promise this guard exists to keep from rejecting. No production site throws a non-Error,
      // but "crash-proof" has to hold unconditionally.
      error: `takeover failed: ${err instanceof Error ? err.message : String(err)}`,
      at: Date.now(),
    }).catch(() => {});
    exit(1);
  }
}

/** Test seams for {@link completeTakeOver}; each defaults to the real effect. */
export interface CompleteTakeOverEffects {
  inspect?: (id: string) => Promise<ContainerInspect | undefined>;
  tagLatest?: () => Promise<void>;
  remove?: (id: string, force?: boolean) => Promise<unknown>;
  /** This container takes `name` (already canonical, no leading slash). */
  rename?: (name: string) => Promise<void>;
  stepAside?: () => Promise<never>;
  /** Seams for the DEFAULT `stepAside` (its `exit` and `sleep`, or a stub `stop`), so the real wiring of the
   *  rollback branch can be exercised without ending the test process. Ignored when `stepAside` is given. */
  stepAsideDeps?: RollbackDeps;
  /** Whether this process is shutting down (`restart.ts`'s `isShuttingDown`, the default). */
  shuttingDown?: () => boolean;
}

/**
 * The swap's last step, run by the replacement from the ready handler once probation is over (#548,
 * option 1: `activate()` has returned and the first scheduler tick has settled, or 60 s have passed), so
 * the stopped original is no longer needed as a way back. Only now: apply `:latest` onto this build
 * (#39, #490 — a build that crash-loops in probation never becomes what a later recreate deploys),
 * remove the stopped original, and take its name (which `bot-ops.sh` and the panels filter on). Until
 * this runs, `docker start <name>` on the stopped original is the rollback — and if that has happened,
 * the original is RUNNING when this looks at it, which means the operator chose it: this container
 * steps aside (stops itself) rather than kill it, and does so BEFORE tagging, so a build the operator
 * rolled back from before this looked never becomes `:latest`. The removal is NOT forced, and a refused
 * one looks again: an original started during the tag call is left alone (Docker's 409) and steps this
 * build aside too — the one gap left is that tag call itself, in which case `:latest` names the build
 * rolled back from until the next update retags it. What this cannot see is a `recreate`/`env-set`,
 * which gives the original a new id (see {@link takeOver}; `bot-ops.sh` refuses those while
 * `<name>-next` is alive).
 *
 * A process that is already shutting down at either check (before the tag, before the removal) does none
 * of the rest: a SIGTERM starts the shutdown drain, which lets the first tick finish (plugin ticks are told
 * to stop, the core checks run on) inside its 8 s grace, so probation can look over while this container is
 * on its way out, and completing then would remove the original while the operator is stopping this
 * container to roll back (`docker stop <name>-next`, then `docker start <name>`). A SIGTERM that lands
 * DURING the tag call or the removal call is not seen: the tag may then name the build being rolled back
 * (the gap above), and a removal already in flight removes the original — milliseconds against a healthy
 * daemon. A stopped replacement that is later restarted boots as a standby beside the kept original and
 * completes the swap itself. (A shutdown only — not a pending restart or a handoff of
 * this process's own: those leave the swap to complete, and the next boot or the next replacement
 * converges the names.)
 *
 * Every other step is best-effort and logged; none throws, because the bot is up and serving and a
 * cleanup failure must not take it down (a rejecting `ClientReady` handler ends the process). An
 * inspect that fails (not a 404) skips EVERYTHING: without it there is no telling whether the operator
 * rolled back, and no name to rename to, and removing the corpse would lose both the name's source and
 * the rollback; a later standby boot finds the corpse and runs this again. A failed removal leaves the
 * corpse holding the canonical name, so the rename fails too and this bot stays `<name>-next` until a
 * later boot retries — #547 adds the normal-boot heal. An original that is already gone (404)
 * is the healthy case of a swap whose removal already happened: tag, nothing to remove or rename.
 */
export async function completeTakeOver(originalId: string, effects: CompleteTakeOverEffects = {}): Promise<void> {
  const inspect = effects.inspect ?? tryInspectContainer;
  const tagLatest = effects.tagLatest ?? tagSelfAsLatest;
  const remove = effects.remove ?? removeContainer;
  const rename = effects.rename ?? takeName;
  const aside = effects.stepAside ?? (() => stepAside(effects.stepAsideDeps));
  const shuttingDown = effects.shuttingDown ?? isShuttingDown;
  const leaveForALaterBoot = () =>
    console.log("[handoff] this process is shutting down — leaving the stopped original for a later boot to remove");
  // Read first: whether the operator rolled back, and the original's name — which cannot be read once the
  // corpse is gone.
  let original: ContainerInspect | undefined;
  try {
    original = await inspect(originalId);
  } catch (err) {
    console.warn(
      `[handoff] could not inspect the stopped original — leaving it, its name and :latest for a later boot: ${(err as Error).message}`,
    );
    return;
  }
  if (original?.State.Running) {
    console.error(
      `[handoff] the original ${originalId.slice(0, 12)} is running again — rolled back by the operator; this build steps aside`,
    );
    await aside();
  }
  if (shuttingDown()) return leaveForALaterBoot();
  // Best-effort, same "never fail a good deploy over housekeeping" rule as pruneOldImages: applied only
  // now, post-verification — never at build time — which is issue #39's fix: a build that merely
  // *compiled* but crashed at boot used to leave `:latest` arming every later recreate (env-set, a
  // Dockge restart, a plain `compose up -d`) on itself, with no way back short of a manual rebuild. #548
  // moves it past probation too: a build that logs in and then dies in `activate()` is no better.
  await tagLatest().catch((err) => {
    console.error(
      `[handoff] could not tag :latest onto the verified build (a later recreate may still use ` +
        `the previous one, until the next successful update retags it): ${(err as Error).message}`,
    );
  });
  if (shuttingDown()) return leaveForALaterBoot();
  try {
    // NOT forced: the original was read as stopped above, and the tag call since may have taken a while. A
    // forced removal would kill and delete an original the operator started in that gap; Docker refuses
    // (409) to remove a running container without force, which lands in the warning below instead.
    await remove(originalId);
  } catch (err) {
    // An explicit stop is exempt from `unless-stopped`, so the corpse stays down; it merely still holds
    // the canonical name, which the rename below treats as non-fatal.
    console.warn(`[handoff] could not remove the stopped original: ${(err as Error).message}`);
    // A refused removal may be exactly that 409: the operator started the original after the read above.
    const again = await inspect(originalId).catch(() => undefined);
    if (again?.State.Running) {
      console.error(
        `[handoff] the original ${originalId.slice(0, 12)} is running again — rolled back by the operator; this build steps aside`,
      );
      await aside();
    }
  }
  if (!original) {
    console.log(`[handoff] completed the swap; the original ${originalId.slice(0, 12)} was already gone`);
    return;
  }
  const name = canonicalName(original.Name);
  await rename(name).catch((err) => {
    // Not fatal — the bot is up and serving. It just isn't where `bot-ops.sh` looks for it.
    console.warn(`[handoff] could not take the name ${name}: ${(err as Error).message}`);
  });
  console.log(`[handoff] completed the swap; retired the previous container ${originalId.slice(0, 12)}`);
}

/** The real `rename` effect: this container takes the canonical name read off the original. */
async function takeName(name: string): Promise<void> {
  const self = await inspectSelf();
  await renameContainer(self.Id, name);
  console.log(`[handoff] took the name ${name}`);
}

/** The cap on waiting for the first scheduler tick (#548): a first tick can contain a
 *  15-minute build (an auto-update found on the first tick) or a wedged network call, and 60 s of serving
 *  past `activate()` is the proof wanted anyway. */
export const FIRST_TICK_CAP_MS = 60_000;

/** Test seams for {@link finishProbation}. */
export interface FinishProbationOptions {
  capMs?: number;
  sleep?: (ms: number) => Promise<void>;
  complete?: typeof completeTakeOver;
}

/**
 * Probation's end (#548): wait for the first scheduler tick to settle — or for {@link FIRST_TICK_CAP_MS},
 * whichever comes first — then {@link completeTakeOver}. Called from the ready handler, standby only,
 * after `activate()` has returned; never throws: `startScheduler`'s first tick never rejects, but a tick
 * that did would still be a tick that ran (and a throw here would reject `ClientReady` and end the process),
 * and `completeTakeOver` and `stepAside` do not throw.
 */
export async function finishProbation(originalId: string, firstTick: Promise<void>, o: FinishProbationOptions = {}): Promise<void> {
  const capMs = o.capMs ?? FIRST_TICK_CAP_MS;
  const sleep = o.sleep ?? Bun.sleep;
  const settled = () => "settled" as const;
  const how = await Promise.race([firstTick.then(settled, settled), sleep(capMs).then(() => "capped" as const)]);
  console.log(`[handoff] probation over (first tick ${how}) — completing the swap`);
  await (o.complete ?? completeTakeOver)(originalId);
}

/** Whether a self-contained redeploy is possible at all: the daemon socket has to be mounted. */
export async function redeployAvailable(): Promise<boolean> {
  return daemonReachable();
}

/** How long `resolveBootMode` waits on the one daemon call it makes before `client.login()` is
 *  even attempted. `docker.ts` now bounds every call (`DEFAULT_TIMEOUT_MS`, 60s); this keeps a
 *  tighter bound on the first daemon dependency on the path *before* a gateway login, so a hung
 *  (not merely erroring) socket falls through to the same "can't confirm" handling as any other
 *  inspect failure without eating 60s of boot. Since #492 the standby's 90 s verify timer is armed at
 *  `index.ts`'s module top, so this bound (like `loadPluginIndex`'s 5 s) runs INSIDE that budget, not before
 *  it; `healOwnName` shares it. */
const RESOLVE_BOOT_MODE_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * The boot decision `index.ts` actually acts on (#46). `bootMode(env)` alone only reports what
 * the env *says* — and `HANDOFF_FROM` is baked into the replacement's env at creation time and
 * never cleared, since container env is immutable. So it still reads "standby" on every later
 * in-place restart of the very container that already completed the handoff: `bot-ops.sh
 * restart`, a reboot, a daemon restart, or a crash loop under `unless-stopped` — all of them,
 * forever, against an original that's long gone. (The ops panel's Restart is not one of these since
 * #277: it is a `recreate`, compose `--force-recreate`, a fresh container with no `HANDOFF_FROM` at all.)
 *
 * This confirms the instruction against the daemon before honoring it: standby only counts while
 * the named original still *exists*. Deliberately existence, not the original's live running
 * state — a container that merely hasn't been (re)started yet still exists, so keying on
 * existence keeps this immune to Docker's restart-ordering: a host reboot mid-handoff restarts
 * both containers, in no guaranteed order, and a running-state check caught the original between
 * "exists" and "running again" would wrongly read "gone," letting the replacement go live before
 * retiring it — two live bots on the same token. A stopped-but-not-removed original is every
 * swap's state between the login and `completeTakeOver` (#548: `retireOriginal` only stops), and a
 * standby boot that finds it re-runs the sequence — the same one a failed removal leaves behind for
 * good, with the corpse also keeping the canonical name, so the replacement's own rename fails right
 * alongside it (name conflict) and it's left visibly un-renamed — an operator-visible state
 * already documented as non-fatal in `completeTakeOver`, not something this check needs to paper
 * over by risking the split-brain above. A RUNNING original at such a boot is a different thing:
 * the operator rolled back, see `detectRollback`.
 *
 * An inspect that can't confirm either way — a daemon blip or timeout, not a definite 404 — stays
 * "standby" rather than downgrading: a genuine handoff boot needs a live daemon connection for the
 * rest of the protocol regardless, and treating "can't tell" as "gone" risks two live bots
 * answering the same token concurrently, which is strictly worse than leaning on the existing
 * crash-proof paths (`verifyTimer`, `RETIREMENT_DEADLINE_MS`) to resolve it. Only a confirmed-gone
 * original ever downgrades to `normal`.
 *
 * A `normal` boot of a container that was CREATED as a standby (`HANDOFF_FROM` still in its env) is a
 * swapped-in container whose original is gone; `index.ts` follows it with `healOwnName` (#547), because
 * nothing else renames it if the swap's own rename never landed.
 */
export async function resolveBootMode(
  env: Record<string, string | undefined>,
  inspect: typeof tryInspectContainer = tryInspectContainer,
  timeoutMs = RESOLVE_BOOT_MODE_TIMEOUT_MS,
): Promise<"standby" | "normal"> {
  const raw = bootMode(env);
  if (raw !== "standby") return raw;
  try {
    const original = await withTimeout(inspect(env[HANDOFF_FROM_ENV]!), timeoutMs);
    return original ? "standby" : "normal";
  } catch {
    return "standby";
  }
}

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

/**
 * Named after its own compose project: `ops/install.sh` names a deployed instance's container after its project
 * (`BOT_OPS_CONTAINER=$PROJECT`), so such a name is the deployment's own, whatever it ends in — `-next` included
 * (instance `next`, `canary-next`). The reserved suffix does not apply to it: `healOwnName` leaves it alone and
 * `redeploy()` does not advise a restart for it. Labels are read null-safely: a container with none has no project.
 */
function namedAfterItsProject(c: ContainerInspect): boolean {
  return canonicalName(c.Name) === c.Config.Labels?.[COMPOSE_PROJECT_LABEL];
}

export type HealOutcome = "canonical" | "renamed" | "occupied" | "unknown";

/** Test seams for {@link healOwnName}; each defaults to the real daemon call. */
export interface HealDeps {
  inspectSelf?: typeof inspectSelf;
  inspect?: typeof tryInspectContainer;
  remove?: (id: string) => Promise<unknown>;
  rename?: typeof renameContainer;
  log?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * #547: a swapped-in container whose own rename never landed boots `normal` once its original is gone
 * (`resolveBootMode`), and nothing on that path renames it, so it would run as `<name>-next` for good:
 * `bot-ops.sh` looks it up by the canonical name, the swap guard refuses every mutation, and `redeploy()`
 * refuses the next swap. Called by `index.ts` only when the env says standby (`HANDOFF_FROM` set) and the
 * daemon said normal; an ordinary boot still never touches the socket. Takes the canonical name when it
 * is free, or held by a stopped container of this compose service (removed first, un-forced); leaves a
 * RUNNING holder alone and says so. The swap's own stopped original is never that holder: it is
 * `HANDOFF_FROM` itself, and while it exists the boot is `standby` and `completeTakeOver` converges it
 * (remove, rename), so the corpse a failed removal leaves is the standby path's, never this one's.
 * Bounded and best-effort: the boot continues on every outcome. A container named after its own compose
 * project (`namedAfterItsProject`: how `ops/install.sh` names an instance, `-next` included) is never renamed.
 * The limit: that exemption, and the `HANDOFF_FROM` gate, are all that tell a deployment's own `*-next` name
 * from a swap's replacement; a container created by `compose` alone with a `container_name` ending in
 * `-next` that has also self-updated before #547 is indistinguishable and would be renamed.
 */
export async function healOwnName(deps: HealDeps = {}, timeoutMs = RESOLVE_BOOT_MODE_TIMEOUT_MS): Promise<HealOutcome> {
  const log = deps.log ?? console;
  const run = async (): Promise<HealOutcome> => {
    const self = await (deps.inspectSelf ?? inspectSelf)();
    const current = canonicalName(self.Name);
    const base = baseName(self.Name);
    if (current === base) return "canonical";
    if (namedAfterItsProject(self)) {
      // An install.sh instance named `next` or `canary-next`: the name is the deployment's own, not a swap's.
      log.log(`[handoff] this bot is named ${current}, like its compose project — that is its own name, leaving it`);
      return "canonical";
    }
    const holder = await (deps.inspect ?? tryInspectContainer)(base);
    if (holder) {
      if (holder.State.Running) {
        log.error(
          `[handoff] this bot is ${current} but ${base} is running (${holder.Id.slice(0, 12)}) — two bots on one token; leaving both alone, see ops/README.md`,
        );
        return "occupied";
      }
      if (!sameComposeService(self, holder)) {
        log.warn(
          `[handoff] this bot is ${current}; ${base} is held by a stopped container of another service (${holder.Id.slice(0, 12)}) — not touching it`,
        );
        return "occupied";
      }
      await (deps.remove ?? ((id: string) => removeContainer(id)))(holder.Id);
    }
    await (deps.rename ?? renameContainer)(self.Id, base);
    log.log(`[handoff] took the name ${base} (this container booted as ${current}, #547)`);
    return "renamed";
  };
  try {
    return await withTimeout(run(), timeoutMs);
  } catch (err) {
    log.warn(`[handoff] could not heal this container's name: ${(err as Error).message}`);
    return "unknown";
  }
}

/** Both on the same compose project AND service (labels present on both): the holder is this bot's own kind. */
function sameComposeService(a: ContainerInspect, b: ContainerInspect): boolean {
  // Null-safe: Docker can report a container with no labels as `null`, which is "not the same service", not a throw.
  const project = (c: ContainerInspect) => c.Config.Labels?.[COMPOSE_PROJECT_LABEL];
  const service = (c: ContainerInspect) => c.Config.Labels?.[COMPOSE_SERVICE_LABEL];
  return Boolean(project(a)) && project(a) === project(b) && Boolean(service(a)) && service(a) === service(b);
}

/** Test seams for {@link detectRollback} and {@link stepAside}. */
export interface RollbackDeps {
  inspect?: (id: string) => Promise<ContainerInspect | undefined>;
  inspectSelf?: () => Promise<ContainerInspect>;
  stop?: (id: string) => Promise<void>;
  exit?: (code: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * At a standby boot (#548): is the original RUNNING although this container has taken over before?
 * `takeOver` restores the original's restart policy onto this container before it stops the original
 * (#160), so an own policy other than `no` means a takeover has completed at least once — and an original
 * running after that was started by the operator (`docker start <name>`, a `compose up -d`/`restart` that
 * revived the stopped corpse, or `restart: always` after a daemon restart). That is a rollback: this
 * container steps aside instead of stopping it again. A first attempt (own policy still `no`) is never a
 * rollback, so a swap in flight is untouched; so is a standby created by an original from before #160, which
 * carries no `HANDOFF_RESTART_POLICY` in its env and whose own policy was never `no`. Bounded like
 * `resolveBootMode`; any failure to tell is `false` (proceed as standby, as before #548).
 *
 * What this changes beyond the operator's rollback: ANY restart of a replacement that has restored its
 * policy while the original is still running now steps aside, instead of re-running the standby cycle and
 * possibly landing the swap late. That is `takeOver`'s transport-drop mirror case (see its docstring), a
 * retire that threw after the restore (the original, alive, reclaims through the `failed` marker), and a
 * replacement killed between the restore and the stop (the original has written no verdict to act on and
 * waits out `RETIREMENT_DEADLINE_MS` before reclaiming, as it already does when the replacement stays down).
 */
export async function detectRollback(
  env: Record<string, string | undefined>,
  deps: RollbackDeps = {},
  timeoutMs = RESOLVE_BOOT_MODE_TIMEOUT_MS,
): Promise<boolean> {
  const originalId = env[HANDOFF_FROM_ENV];
  if (!originalId) return false;
  // Only a standby made by code that carries the policy (#160) has an own policy of `no` on a first attempt.
  if (env[HANDOFF_RESTART_POLICY_ENV] === undefined) return false;
  try {
    return await withTimeout(
      (async () => {
        const original = await (deps.inspect ?? tryInspectContainer)(originalId);
        if (!original?.State.Running) return false;
        const self = await (deps.inspectSelf ?? inspectSelf)();
        const own = self.HostConfig.RestartPolicy?.Name ?? "";
        return own !== "" && own !== "no";
      })(),
      timeoutMs,
    );
  } catch (err) {
    console.warn(`[handoff] could not tell whether the original was started again: ${(err as Error).message}`);
    return false;
  }
}

/** How long {@link stepAside} waits for the daemon's SIGTERM before exiting on its own. */
export const STEP_ASIDE_GRACE_MS = 30_000;

/**
 * Stop THIS container through the daemon (an explicit stop is exempt from `unless-stopped`, so it stays
 * down as an exited `<name>-next`), and let the SIGTERM reach `index.ts`'s shutdown handler. If the stop
 * call fails, or no signal arrives within {@link STEP_ASIDE_GRACE_MS}, exit 1 (Docker's backoff bounds
 * the loop; the log says why). Never returns.
 */
export async function stepAside(deps: RollbackDeps = {}): Promise<never> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const sleep = deps.sleep ?? Bun.sleep;
  try {
    const self = await (deps.inspectSelf ?? inspectSelf)();
    console.error(`[handoff] stepping aside: the original is running, so this container (${self.Id.slice(0, 12)}) stops itself`);
    await (deps.stop ?? stopContainer)(self.Id);
  } catch (err) {
    console.error(`[handoff] could not stop this container through the daemon — exiting instead: ${(err as Error).message}`);
    exit(1);
    return new Promise<never>(() => {});
  }
  await sleep(STEP_ASIDE_GRACE_MS);
  console.error("[handoff] no stop signal arrived — exiting");
  exit(1);
  return new Promise<never>(() => {});
}
