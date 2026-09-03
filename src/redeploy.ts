// Self-contained redeploy (#879): the bot builds its own replacement through the Docker
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
  readMarker,
  RETIREMENT_DEADLINE_MS,
  writeMarker,
  type HandoffOutcome,
} from "./handoff";
import { beginHandoff, endHandoff } from "./restart";

const POLL_MS = 2_000;
/** Per-sha image tags kept around. More than one is what makes rolling back to a *previous*
 *  build possible at all; a small number is what stops that filling the box's disk. */
const KEEP_SHA_TAGS = 3;

/** Docker reports names with a leading slash. */
export function canonicalName(inspectedName: string): string {
  return inspectedName.replace(/^\//, "");
}

/**
 * The replacement can't be created under the canonical name — `container_name` in the compose
 * file pins it and the original still holds it — so it comes up beside it and takes the name
 * as it retires the original. Keeping the canonical name is what lets `bot-ops.sh` and the
 * desktop Ops panels, which filter on it, keep working across a swap with no change.
 */
export function replacementName(inspectedName: string): string {
  return `${canonicalName(inspectedName)}-next`;
}

/** A git URL the daemon can fetch a build context from: the whole repo at the target ref
 *  (a branch name or a full sha both work — GitHub serves a fetch by either). */
export function buildRemote(repo: string, ref: string): string {
  return `https://github.com/${repo}.git#${ref}`;
}

/**
 * The only tag a fresh build gets. Never `:latest` — see `latestTag` and `takeOver`'s
 * `tagLatest`. Before issue #39's fix this was one of two tags applied at build time (the other
 * being `:latest` itself), and the *build* result's tag array happening to put `:latest` first is
 * exactly what let a not-yet-verified image get used both to build and to create the replacement.
 */
export function shaTag(currentImage: string, sha: string): string {
  const repo = currentImage.split(":")[0] ?? currentImage;
  return `${repo}:${sha.slice(0, 7)}`;
}

/**
 * The floating tag every recreate path other than a fresh self-update resolves the service image
 * by (`bot-ops.sh env-set`'s `up -d --force-recreate`, a Dockge restart, a plain `compose up
 * -d`). Applied only once `takeOver` confirms the replacement running under it has verified
 * itself — never at build time (issue #39) — so none of those paths can ever recreate the bot on
 * a build that merely compiled but crashed at boot.
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
  // loosely and could sweep in another repo's sha tags.
  const isShaTag = (tag: string) =>
    tag.startsWith(`${repo}:`) && /^[0-9a-f]{7}$/.test(tag.slice(repo.length + 1));
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
 */
export function buildCreateSpec(
  self: ContainerInspect,
  o: { image: string; handoffFrom: string; oldImageEnv: string[] },
): CreateContainerSpec {
  const oldImageEnvSet = new Set(o.oldImageEnv);
  const env = self.Config.Env.filter(
    (e) => !e.startsWith("GIT_SHA=") && !e.startsWith(`${HANDOFF_FROM_ENV}=`) && !oldImageEnvSet.has(e),
  );
  env.push(`${HANDOFF_FROM_ENV}=${o.handoffFrom}`);
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
      RestartPolicy: { Name: self.HostConfig.RestartPolicy?.Name || "unless-stopped" },
      NetworkMode: self.HostConfig.NetworkMode,
      // Compose's `init: true` lives on the container, not the image — without carrying it
      // over, the replacement runs its process as PID 1 instead of under docker-init.
      Init: self.HostConfig.Init ?? undefined,
    },
  };
}

/** Only ever a failure: a redeploy that *works* kills this process before it can return. */
export interface RedeployResult {
  outcome?: HandoffOutcome;
  error?: string;
}

/**
 * Build the target sha, start it alongside, and wait for it to verify.
 *
 * Returns only when the swap has *failed* — on success the replacement retires this process
 * partway through the wait, so the successful path never returns at all. Observing `ready` is
 * therefore not a return: it starts the retirement wait, and outliving that wait is itself a
 * failure (`stalled`), because the one thing `ready` promised was a stop that never came.
 */
export async function redeploy(latestSha: string): Promise<RedeployResult> {
  beginHandoff(`redeploy -> ${latestSha.slice(0, 7)}`);
  await clearMarker();

  let self: ContainerInspect;
  try {
    self = await inspectSelf();
  } catch (err) {
    endHandoff();
    return { error: `could not inspect own container: ${(err as Error).message}` };
  }

  const tag = shaTag(self.Config.Image, latestSha);
  console.log(`[redeploy] building ${tag} from ${latestSha.slice(0, 7)}`);
  // Built from the exact compared sha, not `config.botBranch`'s current tip: the daemon fetches
  // at build *start*, seconds after `latestSha` was resolved, and a push landing in that window
  // would otherwise build newer code while still stamping it GIT_SHA=<the older, compared sha>.
  const built = await buildImage({
    remote: buildRemote(config.githubRepo, latestSha),
    tags: [tag],
    buildArgs: { GIT_SHA: latestSha },
  }).catch((err) => ({ ok: false, error: (err as Error).message }));

  if (!built.ok) {
    // A failed build is inert: nothing has been created, so there is nothing to unwind.
    endHandoff();
    return { error: `build failed: ${built.error ?? "unknown error"}` };
  }
  await pruneOldImages(self.Config.Image);

  // Best-effort: this is what lets a var baked into the OLD image (not just GIT_SHA) fall back
  // to the new image's own default instead of staying pinned forever. A failed inspect degrades
  // to the old behavior (carry everything over) rather than failing a redeploy over housekeeping.
  const oldImageEnv = await inspectImage(self.Image)
    .then((img) => img.Config.Env)
    .catch(() => []);

  const name = replacementName(self.Name);
  let replacementId: string;
  try {
    await removeContainer(name, true); // a leftover from an earlier failed attempt
    replacementId = await createContainer(
      name,
      buildCreateSpec(self, { image: tag, handoffFrom: self.Id, oldImageEnv }),
    );
    await startContainer(replacementId);
  } catch (err) {
    endHandoff();
    return { error: `could not start the replacement: ${(err as Error).message}` };
  }
  console.log(`[redeploy] replacement ${name} started — waiting for it to verify`);

  let outcome: HandoffOutcome;
  let pollError: string | undefined;
  try {
    outcome = await awaitHandoff(replacementId);
    if (outcome === "ready") {
      // It has verified and is retiring us; this process is about to be stopped mid-sentence.
      // Almost. `ready` is a promise of a stop, not the stop itself — if `retireOriginal` dies
      // between writing the marker and stopping us, that promise is never kept, and without a
      // bound here this process would sit quiesced forever: alive, silent, and doing nothing,
      // which is the outage #879 exists to prevent. So the wait for our own death gets a
      // deadline too. Reaching it demotes the outcome to `stalled` and falls through to the
      // same cleanup as any other failed swap.
      console.log("[redeploy] replacement verified — handing over");
      await Bun.sleep(RETIREMENT_DEADLINE_MS);
      console.error("[redeploy] verified replacement never retired us — reclaiming");
      outcome = "stalled";
    }
  } catch (err) {
    // A daemon blip anywhere in this stretch (a dropped socket, one 500 from the poll, or —
    // pathologically — the retirement wait above) must not escape uncaught: left unguarded,
    // this rejection propagated straight through `applyUpdate` -> `checkForUpdate` and skipped
    // everything below, including `endHandoff()` — quiescing the bot forever (#37). Both the
    // poll and the wait land here so neither can reopen that gap on its own.
    pollError = (err as Error).message;
    console.error(`[redeploy] handoff decision failed: ${pollError} — reclaiming`);
    outcome = "failed";
  }

  const marker = await readMarker();
  try {
    await removeContainer(replacementId, true);
  } catch (err) {
    // Cleanup, not the verdict — a stuck removal (e.g. a 409 mid-teardown) must not skip the
    // `endHandoff()` below either, for the same reason a poll failure above must not.
    console.error(`[redeploy] could not remove the replacement: ${(err as Error).message}`);
  } finally {
    await clearMarker();
    endHandoff();
  }
  console.warn(`[redeploy] handoff ${outcome} — staying on the current build`);
  return { outcome, error: pollError ?? marker?.error };
}

/** Poll the marker and the replacement's own state until one of them decides it. */
async function awaitHandoff(replacementId: string): Promise<HandoffOutcome> {
  const startedAt = Date.now();
  for (;;) {
    const [marker, container] = await Promise.all([
      readMarker(),
      tryInspectContainer(replacementId),
    ]);
    const outcome = decideHandoffOutcome({
      marker,
      replacement: container && {
        running: container.State.Running,
        status: container.State.Status,
        exitCode: container.State.ExitCode,
      },
      elapsedMs: Date.now() - startedAt,
    });
    if (outcome !== "waiting") return outcome;
    await Bun.sleep(POLL_MS);
  }
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
 * The replacement's side of the swap, run once it has verified itself: stop and remove the
 * original, then take its name.
 *
 * Removal, not just a stop — under `restart: unless-stopped` an exited container is brought
 * back on its old image, which is the original #868 failure and would now leave two bots
 * running. An explicit `docker stop` is exempt from that policy, and the `rm` makes it moot.
 *
 * This can also run a second time against the same original id, with nothing left alive to
 * reclaim if it fails: if a prior call's `removeContainer` failed below, the original is left a
 * stopped-but-not-removed corpse that a standby boot mode (env-based `bootMode`, or #46's
 * daemon-confirmed `resolveBootMode`) can retry `takeOver` -> `retireOriginal` against — and
 * separately, `HANDOFF_FROM` never clears from a swapped-in container's own env, so any boot path
 * that still honors it against an id since fully removed lands here with the original already
 * gone entirely. Only a genuinely *live* original — the one case where this really is the first
 * attempt — can still reclaim if the stop below fails, so only that case gets the strict
 * propagate-on-failure behavior; both "already stopped" and "already gone" degrade a stop failure
 * like every other post-stop step instead of crashing the sole live bot.
 */
export async function retireOriginal(originalId: string): Promise<void> {
  const original = await tryInspectContainer(originalId);
  // Only a running original is still around to reclaim us if the stop below fails — a first
  // attempt is the only case where that's true. `original` being `undefined` (fully gone) or
  // present-but-not-running (a corpse from an earlier incomplete cycle) are both "nothing left to
  // reclaim," so both get the same tolerant handling.
  const originalStillLive = original !== undefined && original.State.Running;
  if (originalStillLive) {
    await stopContainer(originalId);
  } else {
    await stopContainer(originalId).catch((err) => {
      console.warn(`[handoff] stop of the already-gone-or-stopped original failed: ${(err as Error).message}`);
    });
  }
  // The stop is the point of no return: past it the original is dead and cannot reclaim, so
  // every later step must degrade rather than throw — a throw here rejects the replacement's
  // ClientReady, and with the only other bot already stopped that is a total outage. Before
  // the stop, throwing is the *right* move: the original is alive, watching, and reclaims at
  // its retirement deadline.
  try {
    await removeContainer(originalId, true);
  } catch (err) {
    // An explicit stop is exempt from `unless-stopped`, so the corpse stays down; it merely
    // still holds the canonical name, which the rename below already treats as non-fatal.
    console.warn(`[handoff] could not remove the stopped original: ${(err as Error).message}`);
  }
  console.log(`[handoff] retired the previous container ${originalId.slice(0, 12)}`);
  if (!original) return;

  const name = canonicalName(original.Name);
  try {
    const self = await inspectSelf();
    await renameContainer(self.Id, name);
    console.log(`[handoff] took the name ${name}`);
  } catch (err) {
    // Not fatal — the bot is up and serving. It just isn't where `bot-ops.sh` looks for it.
    console.warn(`[handoff] could not take the name ${name}: ${(err as Error).message}`);
  }
}

/** Test seams for {@link takeOver}: each defaults to the real effect, and is overridden in tests
 *  so the failure path can be exercised without a live daemon or touching the marker file. */
export interface TakeOverEffects {
  write?: typeof writeMarker;
  retire?: typeof retireOriginal;
  clear?: typeof clearMarker;
  /** Applies `:latest` onto this (now-verified) replacement's own image. Best-effort — see its
   *  call site in {@link takeOver}. */
  tagLatest?: () => Promise<void>;
  exit?: (code: number) => void;
}

/** The real `tagLatest` effect: reads this container's own image (always a sha tag post-#39,
 *  never `:latest` itself) and points `:latest` at it. */
async function tagSelfAsLatest(): Promise<void> {
  const self = await inspectSelf();
  await tagImage(self.Config.Image, latestTag(self.Config.Image));
}

/**
 * Complete the swap from the replacement's side, and make that completion crash-proof.
 *
 * Runs in the *replacement*: it announces `ready` (which stops the original counting toward its
 * deadline), applies `:latest` onto its own now-verified image (issue #39 — best-effort; a tag
 * hiccup must not turn a genuinely successful handoff into a reported failure), retires the
 * *original* — `retireOriginal` stops that other container, never this one — and clears the
 * marker. On success this returns, and `index.ts` goes on to `activate()`; this process is the
 * survivor that becomes the live bot.
 *
 * The guard is for the unhappy path. Almost every throw site inside is at or before the original
 * is stopped: `write` and the pre-stop inspect precede it, and `stopContainer` throws on an HTTP
 * error before the stop has taken — so a throw normally leaves the original still alive and about
 * to reclaim us, via `failed` if it is still polling or `stalled` once it gives up waiting for a
 * stop that never comes. The lone exception is a transport-level drop *after* the daemon has
 * already stopped the original but before its response returns; then both bots are momentarily
 * down, but only momentarily — `unless-stopped` restarts this process, its next `takeOver` finds
 * the original already stopped (a no-op stop, then it removes it and takes the name) and goes
 * live. So the worst case is a bounded, self-recovering blip: never a permanent outage, and never
 * two live bots.
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
  const tagLatest = effects.tagLatest ?? tagSelfAsLatest;
  const exit = effects.exit ?? ((code: number) => process.exit(code));
  try {
    await write({ status: "ready", sha: config.gitSha, at: Date.now() });
    // Best-effort, same "never fail a good deploy over housekeeping" rule as pruneOldImages: the
    // swap itself is real and correct regardless of whether this one tag succeeds. Applied only
    // now, post-verification — never at build time — which is issue #39's fix: a build that
    // merely *compiled* but crashed at boot used to leave `:latest` arming every later recreate
    // (env-set, a Dockge restart, a plain `compose up -d`) on itself, with no way back short of a
    // manual rebuild.
    await tagLatest().catch((err) => {
      console.error(
        `[handoff] could not tag :latest onto the verified build (a later recreate may still use ` +
          `the previous one, until the next successful update retags it): ${(err as Error).message}`,
      );
    });
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

/** Whether a self-contained redeploy is possible at all: the daemon socket has to be mounted. */
export async function redeployAvailable(): Promise<boolean> {
  return daemonReachable();
}

/** How long `resolveBootMode` waits on the one daemon call it makes before `client.login()` is
 *  even attempted. `docker.ts` carries no timeout of its own on any call, and this is the first
 *  place a hung (not merely erroring) daemon socket could block *boot itself* rather than
 *  something already gated behind a successful gateway login — bounded here so that case falls
 *  through to the same "can't confirm" handling as any other inspect failure, instead of hanging
 *  forever. Comfortably under `VERIFY_DEADLINE_MS` (90s), so it can't meaningfully eat into that
 *  budget on a boot that turns out to be a genuine handoff. */
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
 * restart`, the ops panel's Restart, a reboot, a daemon restart, or a crash loop under
 * `unless-stopped` — all of them, forever, against an original that's long gone.
 *
 * This confirms the instruction against the daemon before honoring it: standby only counts while
 * the named original still *exists*. Deliberately existence, not the original's live running
 * state — a container that merely hasn't been (re)started yet still exists, so keying on
 * existence keeps this immune to Docker's restart-ordering: a host reboot mid-handoff restarts
 * both containers, in no guaranteed order, and a running-state check caught the original between
 * "exists" and "running again" would wrongly read "gone," letting the replacement go live before
 * retiring it — two live bots on the same token. A stopped-but-not-removed original (`retireOriginal`
 * removes only best-effort) is a narrower, already-known-and-accepted degradation: on a failed
 * removal the corpse also keeps the canonical name, so the replacement's own rename fails right
 * alongside it (name conflict) and it's left visibly un-renamed — an operator-visible state
 * already documented as non-fatal in `retireOriginal`, not something this check needs to paper
 * over by risking the split-brain above.
 *
 * An inspect that can't confirm either way — a daemon blip or timeout, not a definite 404 — stays
 * "standby" rather than downgrading: a genuine handoff boot needs a live daemon connection for the
 * rest of the protocol regardless, and treating "can't tell" as "gone" risks two live bots
 * answering the same token concurrently, which is strictly worse than leaning on the existing
 * crash-proof paths (`verifyTimer`, `RETIREMENT_DEADLINE_MS`) to resolve it. Only a confirmed-gone
 * original ever downgrades to `normal`.
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
