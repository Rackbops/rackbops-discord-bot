<!-- Plan for sub-epic #525 of Epic #516 (Rackbops/rackbops-discord-bot), bundle S3a: the swap's tail. Written
by the orchestrating session on 2026-10-16 against `main` @ `cccd683`, with the handoff state table
(`docs/plans/epics/E516/525-handoff-state-table.md`, rows 19-25) as the design input and roshne's decision on
#548 (option 1, 2026-10-15). Audited read-only against that tree before it was committed (14 findings, all
applied, including the step-aside rule and the first-tick wait). Every file:line below was read from that
tree; the implementer re-reads each one on the tree it works from and corrects any that moved. -->

## Implementation plan -- #525 bundle S3a: keep the original until the new build has run

> **Status: implemented in PR #557, with the deviations below. Where this plan and the code disagree, the code
> wins.** (1) The removal in `completeTakeOver` is NOT forced (a forced one would kill and delete an original the
> operator started during the tag call); a refused removal looks again and steps aside. (2) Decision 4 ("a
> recreate during probation makes the replacement step aside") is false: a `recreate`/`env-set` creates a new
> container id that nothing follows, so two bots can run until #490 item 2's guard lands (S3b-1). (3) The
> rollback to recommend is `docker stop <name>-next`, then `docker start <name>`; a bare `docker start` overlaps
> until the replacement looks. (4) `detectRollback` ignores a standby with no `HANDOFF_RESTART_POLICY` in its env
> (a pre-#160 standby). (5) `completeTakeOver` steps aside before it tags (a rolled-back-from build must not
> become `:latest`) and returns early while the process is shutting down (`isShuttingDown()`). (6) `takeOver`
> looks once more before it writes `ready`.

Children: **#548** (option 1), and items 5, 7 and 9 of **#490** (item 9 is also `docker-restart-5` in #512,
closed there by reference). One PR. A behaviour change at the heart of the self-update swap, so the
**three-reviewer gate** applies: you plus two read-only adversarial reviewers with different lenses, up to
four rounds, then report. Every coverage row is mutation-tested in a scratch worktree, real output pasted.

Bundle S1 (another session's PR, `fix/525-S1-swap-verdict`) rewrites `redeploy()`'s verdict block
(`src/redeploy.ts:294-418`) and `RedeployResult`, edits `handoff.ts` from `:110` down, and edits the
`redeploy.ts`, `handoff.ts` and test rows of `CONTEXT.md`. This bundle edits `redeploy.ts` at the import
list (`:28-38`, separate lines from S1's additions), `buildCreateSpec` (`:147-192`), `retireOriginal`
(`:451-524`), the `takeOver` block (`:526-663`) and new functions after it; `handoff.ts` only after `:24`;
`announce.ts:63-67`; `ready.ts`; `index.ts`'s boot and ready wiring; `ops/bot-ops.sh`'s reserved-keys
table; and the tests of those. Disjoint by line from S1. **The `CONTEXT.md` `redeploy.ts` row and several
gotchas are edited by both, so S1 merges first:** do every step but the `CONTEXT.md` edits of step 5, open
the PR as a draft, then `git merge origin/main` once S1 is in (tell the orchestrator if it is not when you
get there) and make the row edits on S1's wording. Bundle S2 (`fix/525-S2-docker-transport`) touches
`docker.ts`'s socket constant and `parseBuildOutput`, nothing here. Bundles S3b-1 (the `bot-ops.sh` guard)
and S3b-2 (the `-next` name heal, the leftover sweep, the verify timer) follow this one and are named
where they close a residual this bundle leaves.

### What is wrong, verified at `cccd683`

- The bar the replacement must clear before the original is retired is a completed gateway login
  (`src/ready.ts:19-26`: `takeOver` runs, then `activate`). `takeOver` (`src/redeploy.ts:613-663`) writes
  `ready`, tags `:latest` (`:628`), restores the original's restart policy onto itself (`:639`) and calls
  `retireOriginal` (`:640`), which stops the original and **removes** it (`:505-511`) and takes its name
  (`:515-523`). A new build that logs in and then dies in `activate()` or its first tick is restarted by
  Docker under the restored policy, boots `normal` (the original is a 404, `:731`), dies again: a crash
  loop with nothing left to start, `:latest` already pointing at the bad build, and nobody told
  (`reportUpdateOutcome`, `src/index.ts:467`, is the last thing `activate()` starts). State table row 25;
  #548.
- `:latest` moves before the retire (`:628` precedes `:639-640`), so a `retire` that throws after the tag
  leaves `:latest` on a build the requester is told was not deployed, and a later `env-set`, `recreate` or
  plain `compose up -d` deploys it silently (table rows 19-20; #490 item 7).
- `buildCreateSpec` carries only the policy *name* (`:152`, `:161`) and `restoreOriginalRestartPolicy`
  passes only the name (`:557-561`), so an original on `on-failure:5` comes back as `on-failure` with no
  cap, which Docker reads as unlimited (`docker.ts:280-287`'s own warning); `README.md:98` says the policy is
  preserved. (#490 item 9, #512's `docker-restart-5`.)
- Every `retireOriginal` test (`redeploy.test.ts:607-746`) answers the original's `DELETE` with 204 and the
  rename with 204 and records only `path` and `method`, so removing the `try`/`catch` around the removal,
  deleting the rename, renaming to a wrong name or dropping `force=1` all stay green. (#490 item 5.)

### Decisions (defaults, named so the gate can contest them)

1. **Probation: the swap's point of no return moves from "logged in" to "`activate()` returned and the
   first scheduler tick settled (or 60 s passed)".** `takeOver` keeps writing `ready`, restoring the policy
   and **stopping** the original, and clears the marker; it no longer removes or renames. After
   `activate()` resolves, the ready handler (standby only) calls `finishProbation`, which awaits the
   scheduler's first tick with a 60 s cap and then runs `completeTakeOver(originalId)`: tag `:latest`,
   remove the stopped original, take its name, each best-effort and logged, none throwing. This is
   roshne's decision verbatim ("finished `activate()` and run one tick"); the first tick is fired inside
   `startScheduler` (`announce.ts:63-67`) with its promise discarded, so `startScheduler` now returns it.
   What probation does and does not catch, stated honestly: `activate()` swallows most of its own
   failures (plugins degrade to core-only at `index.ts:228-230`; the routing, state-write and mailbox
   steps each catch, `:405-423`, `:443-447`, `:455-459`), so a rejection out of `activate()` is rare; what
   probation catches is the process DYING or hanging between the login and the end of the first tick
   (an unhandled rejection anywhere, an uncaught exception in a timer, a plugin that kills the process,
   OOM, a Bun crash). `index.ts` installs no `unhandledRejection` handler, and Bun 1.4.2 exits 1 on an
   async `EventEmitter` listener's rejection (probed on MILE 2026-10-16: `e.once("ready", async () => {
   throw ... }); e.emit("ready")` printed the error and exited 1 before a 300 ms timer fired; discord.js
   14 uses a plain `EventEmitter`), so a throw in `activate()` is a crash too, not a half-alive bot. The
   60 s cap exists because a first tick can contain a 15-minute build (an auto-update found on the first
   tick) or a wedged network call; 60 s of serving past `activate()` is the proof wanted anyway. State
   this on #548 when you report (its acceptance asks for the decision in writing).
2. **A running original after the stop means the operator rolled back, and the replacement steps
   aside.** This is what makes `docker start <name>` a ONE-command rollback, as the decision on #548
   promises. Without it, a crash-looping replacement restarts as standby (the original exists), re-runs
   `retireOriginal`'s live branch (`redeploy.ts:477-494`) and stops the revived original again within
   seconds. So, two checks, both in `redeploy.ts`: (a) at a standby boot, `detectRollback()`: the original
   is RUNNING and this container's own restart policy is no longer `no` (so `takeOver` has restored it
   at least once: this is not a first attempt) → `stepAside()`; (b) in `completeTakeOver`, when the
   original's inspect shows it RUNNING (revived during probation, or brought back by a daemon restart
   under `restart: always`) → `stepAside()` instead of removing it. `stepAside()` asks the daemon to stop
   THIS container (`stopContainer(self.Id)`): an explicit stop exempts it from `unless-stopped`, SIGTERM
   reaches the shutdown handler registered at `index.ts:125-126`, and the container stays down; after 30 s
   without the signal it exits 1 itself (Docker's restart backoff bounds that loop) and logs why. A
   first-attempt standby (own policy still `no`) never steps aside, so a swap in flight is untouched; the
   one recovery path this changes is `restorePolicy`'s transport-drop mirror case (`redeploy.ts:590-602`):
   that replacement, restarted under the restored policy with the original live, now steps aside, and
   the original reclaims through the `failed` marker `takeOver` already wrote, instead of re-running the
   whole standby cycle. Say so in the docstring. The alternative not taken: document a two-command
   rollback (`docker rm -f <name>-next`, then `docker start <name>`) and add no new behaviour; it
   contradicts the recorded decision and leaves `compose restart`/`up -d` starting the corpse beside a
   crash-looping replacement. Name both on #548.
3. **What a crash during probation now leaves:** the new build restarts under the restored policy, boots
   `standby` (the original still exists, stopped), re-runs `takeOver` (a 304 no-op stop, the policy restore
   again, harmless), dies again. `:latest` still names the old build, the stopped original still holds the
   canonical name and its image. **The rollback is `docker start <name>`** (documented in `README.md`,
   `ops/README.md` and `CONTEXT.md`): the replacement steps aside at its next boot (at once, if it is
   crash-looping; at `completeTakeOver`, if it is still in probation) and stays stopped as an exited
   `<name>-next`, which the next self-update sweeps (S3b-2) and the guard ignores (S3b-1). A replacement
   that is HUNG in `activate()` (#408, out of scope) never reaches either check: `docker rm -f
   <name>-next` first, then `docker start <name>`. Nothing automatic starts the original.
4. **The probation window is normally seconds, and in it the ops tooling sees the corpse.** `bot-ops.sh
   status` and `logs` look up the canonical name (`:623`, `:655`), so during probation they show a stopped
   bot; the guard (`bot-ops.sh:388-393`) allows `restart`/`recreate`/`env-set` because the canonical name
   is not running, and a `recreate` landing inside the window starts the OLD build from `:latest` beside
   the live replacement, which then steps aside by decision 2 (the operator's action wins; no two bots
   for longer than the inspect). S3b-1 makes the guard refuse while a RUNNING `-next` exists. During a
   crash loop the window is the whole outage, and the same step-aside rule applies to a `compose
   restart` or `up -d` that starts the corpse. Two more residuals, to state in the PR: the Cloudflare
   tunnel routes by container NAME (`ops/README.md:548-549`; ADR-0007 `:123-127` says the replacement takes
   the name before it serves), so the HTTP router is unreachable through the tunnel until
   `completeTakeOver` renames, i.e. for the tail of `activate()` after the listener binds (`index.ts:349`)
   plus the first tick, where today it is unreachable only until the listener binds; and a self-update
   that an auto-update check starts INSIDE the first tick runs while this build is still `<name>-next`, so
   its replacement is created as `<name>-next-next` and the chain converges only when that one's own
   `completeTakeOver` runs (S3b-2 gates the update paths on probation).
5. **`:latest` moves in `completeTakeOver`, after probation** (#490 item 7). A `retire` that throws now
   leaves `:latest` untouched, and a build that crash-loops in probation never becomes `:latest`. The #160
   ordering argument (restore before the stop) stands; the tag was never part of it (`redeploy.test.ts:366`
   calls the tag-before-restore order incidental; the gotcha at `CONTEXT.md:858-860` is about restore
   before stop).
6. **`MaximumRetryCount` rides along for `on-failure`** (#490 item 9): `buildCreateSpec` adds
   `HANDOFF_RESTART_RETRIES=<n>` when the original's policy is `on-failure` with `MaximumRetryCount > 0`;
   `restoreOriginalRestartPolicy` passes `{ Name, MaximumRetryCount }` only when the name is `on-failure`
   and the env is present and positive, else `{ Name }` as today. Additive and backward compatible: an
   original on today's code creates a standby without the new env, and the new standby restores the name
   alone. Never `{ Name: "on-failure", MaximumRetryCount: 0 }` (Docker reads 0 as unlimited; the comment at
   `docker.ts:285-286` and `redeploy.ts:182-183`). The new key must be in `bot-ops.sh`'s `RESERVED_KEYS`
   (step 4): `ops/bot-ops.test.ts:3659-3682` scans `src/**` for `const X_ENV = "X"` and fails on any key
   that is neither editable nor reserved, and that describe is not skipped on Windows.
7. **The old "retire removes and renames" tests move with the code** (#490 item 5): the removal and rename
   are `completeTakeOver`'s, tested with the daemon stub recording the query (`force=1`, `name=<canonical>`),
   a `DELETE` 500 that still renames, and a rename 409 that is tolerated.
8. **The on-daemon demonstration #548 asks for is an operator step, not this PR's:** no Docker on this box,
   and a full swap in CI is out of scope. The PR lands with the unit coverage below; the orchestrator runs
   the demonstration on nucbox's debug instance with roshne (a replacement that throws in `activate()`, then
   `docker start` of the kept original, then `docker ps -a` showing the original running and the
   replacement exited) and pastes it on #548 before it is closed. Name this in the PR as unverified.
9. **Not in this bundle:** #547 (a live `-next` bot never renamed back, at a NORMAL boot), #492 items 15 and
   16, #490 item 2 (the guard and the leftover sweep) and item 8 (the README minutes) are bundles S3b-1
   and S3b-2, which build on this one. #491 and the rest of #512 are S4.

### Step 1 -- `src/handoff.ts:19-24` and `src/announce.ts:63-67`

After `HANDOFF_RESTART_POLICY_ENV` (`:24`):

```ts
/** Set on the replacement only, beside {@link HANDOFF_RESTART_POLICY_ENV}, and only when the ORIGINAL's policy
 *  was `on-failure` with a positive `MaximumRetryCount`: that cap, so `takeOver` restores the whole policy and
 *  not just its name (#490). Absent for every other policy, and from a standby created by an older original. */
export const HANDOFF_RESTART_RETRIES_ENV = "HANDOFF_RESTART_RETRIES";
```

(`handoff.ts:7-10`, the header, is bundle A's and already on `main`; `:110` down is S1's. Nothing else here.)

`announce.ts:63-67`: `startScheduler` returns the first tick's promise, which never rejects (the `.catch`
at `:64` already logs):

```ts
/** Returns the FIRST tick's promise (settled, never rejecting) so the standby's probation can wait for
 *  one tick to have run (#548). Callers that do not care ignore it. */
export function startScheduler(client: Client, extraChecks: TickCheck[] = []): Promise<void> {
  const tick = () => onTick(client, extraChecks).catch((err) => console.error("[tick]", err));
  const first = tick();
  setInterval(tick, TICK_MS);
  return first;
}
```

### Step 2 -- `src/redeploy.ts`

- **Imports** (`:28-38`): add `HANDOFF_RESTART_RETRIES_ENV` to the `./handoff` list on its own line;
  `stopContainer` is already imported (`retireOriginal` uses it); check `tsc` for anything that lost its
  last use.
- **`buildCreateSpec`** (`:147-192`): filter the new key out of the copied env like the other two
  (`:156-157`); after `:161`:

  ```ts
    const originalRetries = self.HostConfig.RestartPolicy?.MaximumRetryCount ?? 0;
    if (originalPolicyName === "on-failure" && originalRetries > 0) {
      env.push(`${HANDOFF_RESTART_RETRIES_ENV}=${originalRetries}`);
    }
  ```

  Extend the docstring's #160 paragraph (`:141-145`): the cap rides along too (#490).
- **`restoreOriginalRestartPolicy`** (`:552-561`):

  ```ts
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
  ```

- **`retireOriginal`** (`:451-524`) becomes a stop only. Keep `:470-499` (the inspect, the live-branch stop
  with its late-stop re-inspect, the tolerant branch) and the log line at `:512` reworded to
  `[handoff] stopped the previous container ${originalId.slice(0, 12)} — kept until this build has run
  (#548)`; delete `:500-511` (the point-of-no-return comment and the removal) and `:513-523` (the
  `if (!original) return;` and the rename). The comment's rule ("past the stop every later step degrades")
  moves to `completeTakeOver`'s docstring; in `retireOriginal` nothing follows the stop any more. Rewrite
  the docstring (`:451-469`): stop only; the removal and the name move to `completeTakeOver`, after
  probation; the "point of no return" is now the stop AND a completed probation; the re-entrant case
  (a corpse, or an original fully gone) degrades a stop failure as before, and the corpse is now the
  NORMAL state between a login and the end of probation, not only the trace of a failed removal.
  `original` stays in use (`originalStillLive`).
- **`TakeOverEffects`** (`:528-543`): drop `tagLatest` (`:532-534`); reword `restorePolicy`'s comment
  (`:535-540`): "Runs BEFORE `retire`" and "**Not** best-effort:" (no `tagLatest` to compare with). The
  comment at `:634-638` loses "AFTER tagLatest,". In `takeOver`'s docstring, `:583-584` ("a no-op stop,
  then it removes it and takes the name") becomes "a no-op stop; `completeTakeOver` removes it and takes
  the name once probation ends". Also in this file: the comments at `:52-57` (the name is taken "as it
  retires the original" → "once it has run"), `:69-70` and `:82` (both name `takeOver`'s `tagLatest`),
  `:622-627` (the #39 paragraph moves to `completeTakeOver`), and `resolveBootMode`'s docstring at
  `:708-713` ("`retireOriginal` removes only best-effort" → the corpse is every swap's state until
  `completeTakeOver`, and a standby boot that finds it re-runs the sequence; a RUNNING original at a
  re-entrant boot is a rollback, see `detectRollback`).
- **`takeOver`** (`:613-663`): drop the `tagLatest` effect and its call (`:617`, `:628-633`); the sequence is
  `write(ready)` -> `restorePolicy()` -> `retire(originalId)` -> `clear()`. Keep the catch unchanged.
  Rewrite the docstring (`:563-612`): what the replacement does at login versus after probation; the
  probation and the step-aside rule (decision 2); the rollback recipe (decision 3); the #160 argument
  unchanged (restore before the stop); the `tagLatest` paragraph moves to `completeTakeOver`; the
  transport-drop mirror paragraph (`:590-602`) now ends in `detectRollback` stepping aside and the
  original reclaiming through the `failed` marker.
- **New functions**, after `takeOver`:

  ```ts
  /** Test seams for {@link completeTakeOver}; each defaults to the real effect. */
  export interface CompleteTakeOverEffects {
    inspect?: (id: string) => Promise<ContainerInspect | undefined>;
    tagLatest?: () => Promise<void>;
    remove?: (id: string, force?: boolean) => Promise<unknown>;
    /** This container takes `name` (already canonical, no leading slash). */
    rename?: (name: string) => Promise<void>;
    stepAside?: () => Promise<never>;
  }

  /**
   * The swap's last step, run by the replacement from the ready handler once probation is over (#548,
   * option 1: `activate()` has returned and the first scheduler tick has settled, or 60 s have passed), so
   * the stopped original is no longer needed as a way back. Only now: apply `:latest` onto this build
   * (#39, #490 -- a build that crash-loops in probation never becomes what a later recreate deploys), remove
   * the stopped original, and take its name (which `bot-ops.sh` and the panels filter on). Until this
   * runs, `docker start <name>` on the stopped original is the rollback -- and if that has happened, the
   * original is RUNNING when this looks at it, which means the operator chose it: this container steps
   * aside (stops itself) rather than kill it (decision 2 of the S3a plan).
   *
   * Every other step is best-effort and logged; none throws, because the bot is up and serving and a
   * cleanup failure must not take it down (a rejecting `ClientReady` handler ends the process). An
   * inspect that fails (not a 404) skips the removal AND the rename: without the name there is nothing
   * to rename to, and removing the corpse would lose both the name's source and the rollback; a later
   * standby boot finds the corpse and runs this again. A failed removal leaves the corpse holding the
   * canonical name, so the rename fails too and this bot stays `<name>-next` until a later boot retries
   * -- #547 (S3b-2) adds the normal-boot heal.
   */
  export async function completeTakeOver(originalId: string, effects: CompleteTakeOverEffects = {}): Promise<void> {
    const inspect = effects.inspect ?? tryInspectContainer;
    const tagLatest = effects.tagLatest ?? tagSelfAsLatest;
    const remove = effects.remove ?? removeContainer;
    const rename = effects.rename ?? takeName;
    const aside = effects.stepAside ?? stepAside;
    await tagLatest().catch((err) => {
      console.error(
        `[handoff] could not tag :latest onto the verified build (a later recreate may still use ` +
          `the previous one, until the next successful update retags it): ${(err as Error).message}`,
      );
    });
    // The name is read before the removal: once the corpse is gone there is nothing left to read it off.
    let original: ContainerInspect | undefined;
    try {
      original = await inspect(originalId);
    } catch (err) {
      console.warn(`[handoff] could not inspect the stopped original — leaving it (and its name) for a later boot: ${(err as Error).message}`);
      return;
    }
    if (original?.State.Running) {
      console.error(`[handoff] the original ${originalId.slice(0, 12)} is running again — rolled back by the operator; this build steps aside`);
      await aside();
    }
    try {
      await remove(originalId, true);
    } catch (err) {
      // An explicit stop is exempt from `unless-stopped`, so the corpse stays down; it merely still holds
      // the canonical name, which the rename below treats as non-fatal.
      console.warn(`[handoff] could not remove the stopped original: ${(err as Error).message}`);
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
  }

  /** The real `rename` effect: this container takes the canonical name read off the original. */
  async function takeName(name: string): Promise<void> {
    const self = await inspectSelf();
    await renameContainer(self.Id, name);
    console.log(`[handoff] took the name ${name}`);
  }

  /** The 60 s cap on waiting for the first tick (decision 1 of the S3a plan). */
  export const FIRST_TICK_CAP_MS = 60_000;

  /** Test seams for {@link finishProbation}. */
  export interface FinishProbationOptions {
    capMs?: number;
    sleep?: (ms: number) => Promise<void>;
    complete?: typeof completeTakeOver;
  }

  /**
   * Probation's end (#548): wait for the first scheduler tick to settle -- or for {@link FIRST_TICK_CAP_MS},
   * whichever comes first (a first tick can contain a 15-minute build, and 60 s of serving is the proof
   * wanted anyway) -- then {@link completeTakeOver}. Called from the ready handler, standby only, after
   * `activate()` has returned; never throws.
   */
  export async function finishProbation(originalId: string, firstTick: Promise<void>, o: FinishProbationOptions = {}): Promise<void> {
    const capMs = o.capMs ?? FIRST_TICK_CAP_MS;
    const sleep = o.sleep ?? Bun.sleep;
    const how = await Promise.race([firstTick.then(() => "settled" as const), sleep(capMs).then(() => "capped" as const)]);
    console.log(`[handoff] probation over (first tick ${how}) — completing the swap`);
    await (o.complete ?? completeTakeOver)(originalId);
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
   * At a standby boot (#548, decision 2 of the S3a plan): is the original RUNNING although this container
   * has taken over before? `takeOver` restores the original's restart policy onto this container before it
   * stops the original (#160), so an own policy other than `no` means a takeover has completed at least
   * once -- and an original running after that was started by the operator (`docker start <name>`, a
   * `compose up -d`/`restart` that revived the stopped corpse, or `restart: always` after a daemon
   * restart). That is a rollback: this container steps aside instead of re-retiring it. A first attempt
   * (own policy still `no`) is never a rollback, so a swap in flight is untouched. Bounded like
   * `resolveBootMode`; any failure to tell is `false` (proceed as standby, as today).
   */
  export async function detectRollback(
    env: Record<string, string | undefined>,
    deps: RollbackDeps = {},
    timeoutMs = RESOLVE_BOOT_MODE_TIMEOUT_MS,
  ): Promise<boolean> {
    const originalId = env[HANDOFF_FROM_ENV];
    if (!originalId) return false;
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
    }
    await sleep(STEP_ASIDE_GRACE_MS);
    console.error("[handoff] no stop signal arrived — exiting");
    exit(1);
    return new Promise<never>(() => {});
  }
  ```

  `stopContainer(id, timeoutSec, timeoutMs)` has two optional trailing parameters; the `stop` seam
  takes one. `removeContainer`'s return type is `Promise<boolean>` once S1 lands and `Promise<void>`
  before, which is why the `remove` seam is typed `Promise<unknown>` (a `Promise<void>` stub in a test
  would not satisfy `typeof removeContainer` after S1). `tryInspectContainer` returns `undefined` on a
  404 and throws on any other failure (`docker.ts:167-177`). `withTimeout` and
  `RESOLVE_BOOT_MODE_TIMEOUT_MS` are module-private (`:676-692`) and usable here. The `took the name` log
  line keeps its text.

### Step 3 -- `src/ready.ts` and `src/index.ts`

- `ReadyDeps<C>` gains:

  ```ts
    /** Probation's end (`redeploy.ts`'s `finishProbation`, #548): runs after `activate` has returned, and only
     *  in standby. Never throws. */
    afterActivate: () => Promise<void>;
  ```

  and the handler becomes:

  ```ts
    return async (client) => {
      deps.log.log(deps.describe(client));
      deps.clearVerifyTimer();
      if (deps.mode === "standby") await deps.takeOver();
      await deps.activate(client);
      if (deps.mode === "standby") await deps.afterActivate();
    };
  ```

  Extend the header comment: the original is stopped at `takeOver` and removed only after probation, so
  `docker start` on it is the rollback until then.
- `index.ts`:
  - `:17`: `import { completeTakeOver, detectRollback, finishProbation, resolveBootMode, stepAside, takeOver } from "./redeploy";`
    (drop `completeTakeOver` from that list if nothing in the file names it; the ready wiring names
    `finishProbation`).
  - A module-level `let firstTick: Promise<void> = Promise.resolve();` beside `currentLoadedPlugins`
    (`:100`), with a comment: assigned by `activate()` when it starts the scheduler; what probation waits
    on.
  - `:330`: `firstTick = startScheduler(client, pluginTicks(...));`.
  - After `const mode = await resolveBootMode(process.env);` (`:130`):

    ```ts
    // #548: a standby whose original is RUNNING although this container has taken over before was rolled
    // back by the operator (`docker start <name>`); it steps aside instead of retiring the original again.
    if (mode === "standby" && (await detectRollback(process.env))) await stepAside();
    ```

  - The `createReadyHandler({...})` call (`:138-148`) gains
    `afterActivate: () => finishProbation(process.env[HANDOFF_FROM_ENV]!, firstTick),` after the
    `takeOver:` line; the comment above the call (`:132-137`) gains two sentences: the login is the bar
    for stopping the original; the removal, the name and `:latest` wait for `activate()` and the first
    tick (#548), see `finishProbation`.
- `index.test.ts`'s wiring pin (`:100-124`, "the ClientReady handler is createReadyHandler (#435)") gains
  `expect(call).toContain("afterActivate: () => finishProbation(process.env[HANDOFF_FROM_ENV]!, firstTick),");`,
  `expect((source.match(/finishProbation\(process\.env\[HANDOFF_FROM_ENV\]!, firstTick\)/g) ?? []).length).toBe(1);`
  and `expect(source).not.toMatch(/await finishProbation\(/);`. `call` is the slice up to the first
  `\n  }),` after the opening (`:112`), so the new line must sit inside the object literal. The existing
  `/takeOver\(process\.env\[HANDOFF_FROM_ENV\]!\)/g` count (`:121`) is case-sensitive and unaffected. A
  second pin, in the boot-order style of `:484-496`: "a standby checks for a rollback right after
  resolveBootMode and before anything else" — the slice between `await resolveBootMode(process.env);` and
  `client.once(` contains `if (mode === "standby" && (await detectRollback(process.env))) await stepAside();`,
  `detectRollback(` appears once, `stepAside(` once; and `firstTick = startScheduler(` appears once.

### Step 4 -- `ops/bot-ops.sh` and its mirrors

- `ops/bot-ops.sh:315`: add `[HANDOFF_RESTART_RETRIES]=1   # src/redeploy.ts: the original's on-failure retry cap, carried with the policy (#490)`
  directly under `[HANDOFF_RESTART_POLICY]=1`. No `BOT_OPS_SCHEMA` bump (`:70`'s rule: a subcommand or
  `ALLOWED_SPEC` change only).
- `ops/README.md:262` and `:334-335` (the two reserved-key lists): add `HANDOFF_RESTART_RETRIES` after
  `HANDOFF_RESTART_POLICY`.
- `ops/bot-ops.test.ts:3678` (the reserved-key loop) and `CORE_SETTINGS` at `:3708-3727`: add
  `"HANDOFF_RESTART_RETRIES"` after `"HANDOFF_RESTART_POLICY"` in both.
- `CONTEXT.md:1328` (the reserved list in the config gotcha): same addition (with the step 5 edits, after
  S1).
- The guard's comment block (`ops/bot-ops.sh:341-387`): `:353` ("`:latest` isn't retagged until takeOver
  verifies" → "until `completeTakeOver`, after the new build has run"), `:366-373` (the "point of no
  return … typically milliseconds — two more daemon calls" paragraph: the remainder is now the probation,
  seconds to a minute, and `tagLatest` runs AFTER the stop, in `completeTakeOver`), `:371`. The guard's
  LOGIC is S3b-1's; do not change `:388-393` here.

### Step 5 -- docs, in the same PR

- `README.md`, the swap list: `:65` ("The verified new instance stops and removes the old container, takes
  its name, and goes active") → "The verified new instance stops the old container and goes active. Once
  its own start-up has finished and its first scheduled tick has run, it removes the old container, takes
  its name and moves `:latest` onto itself." Add after `:98`: "**The original is stopped at the handoff but
  kept until the new build has actually run.** If a new build logs in and then crashes before its start-up
  and first tick are through, it restarts into the same crash and nothing is lost: `:latest` still names
  the old build and the stopped original is still there. Roll back with `docker start <name>`: the new
  container steps aside (stops itself) at its next boot, or at once if it is still in its probation, and
  stays stopped; remove it when convenient, or let the next self-update sweep it. A new container that
  hangs rather than crashes never gets that far: `docker rm -f <name>-next` first, then `docker start
  <name>`." Reword `:99`'s "pin back" sentence to point at that. `:67` ("Rollback is the normal case, not a
  recovery procedure") gains "up to the login; past it, the kept original is the recovery, above". `:62`'s
  minutes are #490 item 8 (S3b-2); leave them.
- `ops/README.md:413-414` ("These subcommands keep working across a self-update: the replacement container
  takes the original's name as it retires it"): "takes the original's name once its own start-up and first
  tick are through (#548) — for those seconds `status` and `logs` show the stopped original under the
  canonical name and the live bot is `<name>-next`; a build that crashes in that window is rolled back
  with `docker start <name>`, which makes the new container step aside". One place; do not duplicate.
  `:548-549` (the tunnel routes by container name): add that the name moves at the end of probation, so
  the router is reachable through the tunnel from then on.
- `docs/adr/0007-host-owned-http-router.md:123-127` (the replacement takes the name before it serves): add
  a dated note: since #548 the name moves after `activate()` and the first tick; the listener binds
  earlier but is reachable by name only from then.
- `CONTEXT.md` (after S1 is on `main`; grep rows on short unique substrings, anchor on one line):
  - the `src/redeploy.ts` row (`:192`; grep `The swap itself.`): the `takeOver()` sentence -> "announces
    `ready`, restores the original's restart policy onto itself (`restorePolicy`, #160 — not best-effort),
    then `retireOriginal()` — a **stop** only (#548), then clears the marker; `finishProbation()` runs
    from the ready handler once `activate()` has returned, waits for the first tick (60 s cap) and calls
    `completeTakeOver()`: `latestTag()` via `tagImage()` (best-effort, #39/#490 — never before the new
    build has run), remove the stopped original, take the canonical name; a RUNNING original there, or at a
    re-entrant standby boot (`detectRollback()`), is a rollback and the replacement `stepAside()`s; until
    then `docker start <name>` is the rollback"; the `buildCreateSpec()` clause gains "and the
    `on-failure` retry cap (`HANDOFF_RESTART_RETRIES`, #490)".
  - the `src/handoff.ts` row (`:190`): add `HANDOFF_RESTART_RETRIES_ENV`.
  - the `src/announce.ts` row: `startScheduler` returns the first tick's promise.
  - the `src/index.ts` row (`:156`; grep `has retired the original`): "until `takeOver()` has retired the
    original" -> "until `takeOver()` has stopped the original; `finishProbation()` ends the swap after
    `activate()` and the first tick (#548); a standby that finds its original running again steps aside";
    its "clear the verify timer, `takeOver` only in standby, then `activate`" sequence gains "then
    `afterActivate` in standby".
  - the `src/ready.ts` and `src/ready.test.ts` rows (`:157-158`): add `afterActivate` and the five-step
    order.
  - the `src/redeploy.test.ts` row (`:193`): the `takeOver` clause -> "(ready/restore/retire/clear
    ordering; the removal, the name and `:latest` moved to `completeTakeOver`, tested with the daemon stub:
    the tag before the `DELETE`, `force=1`, the canonical name, a `DELETE` 500 that still renames, a rename
    409 tolerated, a running original that makes it step aside)"; "a retry-against-a-corpse stop failure
    is tolerated and removal still runs" -> "… is tolerated, and nothing is removed or renamed".
  - the #39 clause in the compose config-hash gotcha (`:743-745`): "`:latest` is now applied by
    `takeOver()` *after* the replacement verifies" -> "applied by `completeTakeOver()` once the
    replacement's `activate()` and first tick are through (#548, #490)"; "a build that merely compiled
    but crashed at boot" gains "or crashed in `activate()`".
  - the "A stopped-but-not-removed original stays `standby`" gotcha (`:805-816`): rewrite its first two
    sentences: the corpse is now EVERY swap's state between the login and the end of probation
    (`retireOriginal` stops only; `completeTakeOver` removes and renames afterwards), and a failed removal
    there leaves it as before; the rest (standby re-armed on later restarts, the retry via `takeOver` ->
    `retireOriginal` -> `activate()` -> `finishProbation`) is reworded to that sequence; add that a
    RUNNING original at such a boot is a rollback (`detectRollback`).
  - the "`ready` is a promise of a stop" gotcha (`:828-834`): "past the `stopContainer` point of no return
    `retireOriginal` degrades instead of throwing" -> "`retireOriginal` ends at the stop; every later step
    lives in `completeTakeOver`, after probation, and degrades instead of throwing".
  - the "`retireOriginal` can run against an original with nothing left alive to reclaim it" gotcha
    (`:835-854`): path (1) ("if a prior call's `removeContainer` failed") becomes "always, during the
    probation between the login and `completeTakeOver`, and for good if that removal failed";
    "(degrade a stop failure the same as every later step)" -> "(degrade a stop failure)".
  - the #160 gotcha (`:855-883`): "**`takeOver` restores it onto itself AFTER `tagLatest` and BEFORE
    `retire(originalId)`**" (`:858-859`) -> "**`takeOver` restores it onto itself BEFORE
    `retire(originalId)`**"; "not best-effort like `tagLatest`" (`:868`) -> "not best-effort"; add one
    sentence: the `:latest` tag now follows probation in `completeTakeOver` (#548, #490); the "RE-ENTRANT
    `takeOver`" sentences (`:876-883`) gain: a re-entrant boot whose original is RUNNING does not reach
    `takeOver` at all — `detectRollback` makes it step aside.
  - the late-stop gotcha (`:884-893`): "proceed to remove/rename exactly as the ordinary path would"
    (`:890`) -> "proceed exactly as the ordinary path would (the removal and rename follow probation)".
  - a new gotcha under the swap section: "**A running original after the stop is a rollback, and the
    replacement steps aside (#548).**" — the two checks, why own-policy ≠ `no` identifies a re-entrant
    boot, the transport-drop case it changes, the hung-`activate()` case it does not reach.
  - `CONTEXT.md:1328`: the reserved key (step 4).
- `docs/plans/epics/E516/525-handoff-state-table.md`: the path's step 8 (`:88-90`) and the "Point of no
  return" vocabulary (`:69`); rows 0, 12, 13 and 21 where they say the original is removed at the retire
  or that `:latest` moved at `takeOver`; rows 19, 20 (`:latest` is no longer moved before the retire),
  22-23 ("Recovered by": the corpse is now the normal state during probation and `completeTakeOver` is
  what converges it; the never-renamed live bot stays #547's), 25 (the kept original, the one-command
  rollback, the step-aside rule; nothing automatic); the #548 line in "Rows that wedge" and "Children
  filed". Grep `retire` and `:latest` in the file and list every row you touched in the PR.

### Step 6 -- tests

`src/redeploy.test.ts`:

| # | Test | Pins |
|---|---|---|
| T1 | `takeOver` `:351-374`: the order becomes `["write:ready", "restore", "retire", "clear"]`, with no `tag` effect; the comments at `:363-370` are rewritten | the exact sequence; `exits` empty |
| T2 | `:378-397` (tagLatest failure) is deleted from `takeOver`'s describe and re-homed as `completeTakeOver`'s (T7) | -- |
| T3 | `:405-425`, `:431-449`, `:453-465`, `:470-482`: drop the `tagLatest` effect from each call; expectations unchanged | -- |
| T4 | `takeOver — real daemon calls` (`:492-596`): the stub answers `POST /images/<id>/tag` with 201 and records it (today it throws `unstubbed`, which `.catch` swallows, so a tag call would be invisible); remove `tagLatest:` from the calls at `:540`, `:556`, `:565`, `:588` (an excess property fails `tsc`); rewrite the comment at `:488-490`; "POST .../update precedes POST .../stop" unchanged; new "takeOver stops the original and never tags, removes or renames" | no `POST …/tag`, no `DELETE`, no `/rename` in `calls` |
| T5 | new "restores on-failure with its retry cap, and any other policy by name alone" (#490 item 9); the `afterEach` at `:510-514` also deletes `HANDOFF_RESTART_RETRIES` | `HANDOFF_RESTART_POLICY=on-failure`, `HANDOFF_RESTART_RETRIES=5` -> update body `{ RestartPolicy: { Name: "on-failure", MaximumRetryCount: 5 } }`; `unless-stopped` with `RETRIES=5` -> `{ Name: "unless-stopped" }`; `on-failure` with no retries env, or `RETRIES=0`, or `RETRIES=abc` -> `{ Name: "on-failure" }` |
| T6 | new `describe("completeTakeOver")` with injected effects (`inspect` resolves `{ ...SELF, Name: "/warbandeer-discord", State: { Running: false } }`): "tags :latest, reads the name, removes the stopped original, takes its name — in that order, and never throws" | order `["tag", "inspect", "remove", "rename"]`; `remove` called with `(originalId, true)`; `rename` called with `"warbandeer-discord"` (no slash); `stepAside` not called |
| T7 | "a tagLatest failure still removes and renames" (the old `:378-397`) | both effects called; `console.error` once |
| T8 | "a removal failure still attempts the rename, and a rename failure is only logged" | `remove` throws; `rename` throws; resolves; `console.warn` twice |
| T8b | "an inspect failure keeps the corpse: the tag ran, nothing is removed or renamed" | `inspect` throws; `remove` and `rename` not called; resolves; `console.warn` once |
| T8c | "a running original is a rollback: step aside, remove nothing" | `inspect` resolves `State.Running: true`; `stepAside` called (a seam that records and returns a never-resolving promise, with the test not awaiting past it — or one that throws a sentinel the test expects); `remove` and `rename` not called |
| T9 | `describe("completeTakeOver — real daemon calls")` (the `:607-746` harness shape, plus the tag route): "the tag lands before the original's DELETE, the DELETE carries force=1, and the rename names the canonical container" (#490 items 5, 7) | the index of `POST /images/…/tag` < the index of the `DELETE`; `new URL(deleteCall.url).searchParams.get("force") === "1"`; the rename's `name` param equals `canonicalName(original.Name)`; the rename targets `SELF_ID` |
| T10 | "a DELETE 500 on the stopped original still renames" | `DELETE` -> 500; rename attempted and resolves |
| T11 | "a rename 409 is tolerated" | rename -> 409 "name already in use"; resolves; `console.warn` once |
| T12 | "an original already gone (404) means no rename, no throw" | inspect 404; resolves; no `/rename` call; the DELETE still issued (a 404 there is fine) |
| T13 | `retireOriginal` (`:607-746`): every test loses its `DELETE` assertion and gains "no DELETE and no /rename ever" (the live-branch, corpse and gone cases, the late-stop re-inspect); `:659`'s name "...and still removes it" becomes "...and nothing more"; the propagate-on-failure tests (`:651`, `:733`) unchanged | `calls.some(DELETE)` false, `calls.some(rename)` false |
| T14 | `buildCreateSpec` (`:172-346`): "carries an on-failure retry cap for takeOver to restore, and nothing for any other policy" | `RestartPolicy: { Name: "on-failure", MaximumRetryCount: 5 }` -> env contains `HANDOFF_RESTART_RETRIES=5`; `unless-stopped` -> no such entry; `on-failure` with `MaximumRetryCount: 0` -> none; "never stacks a second HANDOFF_RESTART_RETRIES" (as `:274` does for the policy name) |
| T19 | new `describe("finishProbation")`: "waits for the first tick, then completes" | a deferred `firstTick`; `complete` not called while pending; resolve -> called with `originalId`; the log says `settled` |
| T20 | "a first tick that never settles is capped" | `firstTick` pending forever, `capMs: 20`, `sleep` real -> `complete` called; the log says `capped`; resolves within 500 ms |
| T21 | new `describe("detectRollback")`: "a running original and an own policy other than no is a rollback" | `inspect` -> running; `inspectSelf` -> `RestartPolicy.Name: "unless-stopped"` -> `true` |
| T22 | "a first attempt (own policy no, or empty) is never a rollback, however the original looks" | own `"no"` -> `false`; own `""` -> `false`; `inspectSelf` NOT called when the original is not running |
| T23 | "a stopped or gone original is not a rollback; a failing or hanging inspect is not either" | not running -> `false`; `undefined` -> `false`; `inspect` throws -> `false` with one `console.warn`; `inspect` never resolves with `timeoutMs: 20` -> `false` |
| T24 | "no HANDOFF_FROM never touches the daemon" | `{}` -> `false`; `inspect` not called |
| T25 | new `describe("stepAside")`: "stops its own id through the daemon, then exits 1 only if no signal arrives" | `stop` called with `SELF_ID`; with `sleep` resolving at once, `exit(1)` called after it; with `sleep` pending, `exit` not called |
| T26 | "a stop that fails exits 1 at once" | `stop` throws -> `exit(1)` before any `sleep`; `console.error` twice |

`src/announce.test.ts` (find the harness that drives `onTick` or `tickChecks`; `:114-170` stubs tick
checks): "startScheduler returns the first tick's promise, which settles after the checks ran and never
rejects" — pass an `extraChecks` entry that records and one that throws; the returned promise resolves
after the recording check ran, and resolves (not rejects) when a check throws. If `onTick` cannot run in a
test without network, stub `globalThis.fetch` the way the file's other tests do.

`src/ready.test.ts`:

| # | Test | Pins |
|---|---|---|
| T15 | "standby: ... takes over, activates, then ends probation — in that order" (extend `:40-45`; the harness at `:11-37` gains an `afterActivate` default that pushes `"afterActivate"`; `:65`'s final order gains it too) | `["log", "clear", "takeOver", "activate", "afterActivate"]` |
| T16 | "normal: never calls takeOver or afterActivate" (extend `:68-77`) | `afterActivate` throws if called; order `["log", "clear", "activate"]` |
| T17 | "an activate that rejects means afterActivate never runs, and the rejection reaches the caller" (the shape of `:79-89`) | `activate` rejects; `afterActivate` not called; `rejects.toThrow` |
| T18 | "afterActivate runs only after activate has settled" (the slow shape of `:47-66`, on `activate`) | `activate` pending -> `afterActivate` not yet called; settle -> called |

`src/index.test.ts`: the two pins of step 3.

### Coverage table

#548's acceptance (the decision on the issue; a test that fails when the behaviour is removed; the
on-daemon demonstration; row 25 updated) and #490's items map as:

| Outcome | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| the original is stopped, not removed, at the handoff | 2 | T4, T13 | M1: restore the removal in `retireOriginal` |
| the removal, the name and `:latest` wait for `activate()` and the first tick | 2, 3 | T4, T15, T18, T19, T20 | M2: call `completeTakeOver` from inside `takeOver` (T4: a `DELETE`/`/rename` during `takeOver`); M3: in `ready.ts`, call `afterActivate` before `activate` (T15/T18); M4: drop the `await` on the race in `finishProbation` (T19: `complete` called while the tick is pending) |
| a crash in probation leaves the original to start | 2, 3 | T13, T17 | M1 and M2 again; the on-daemon demonstration (decision 8) is the executed acceptance, operator-run |
| `:latest` is never moved before the new build has run | 2 | T4, T9 | M5: move a real `tagSelfAsLatest()` call back into `takeOver` (T4: a `POST …/tag` during `takeOver`); M6: tag after the `DELETE` in `completeTakeOver` (T9's ordering) |
| `docker start <name>` is honoured: the replacement steps aside | 2, 3 | T8c, T21, T22, T25, index pin | M7: drop the `State.Running` branch in `completeTakeOver` (T8c: `remove` called); M8: `detectRollback` returns `false` when the original runs (T21); M9: drop the own-policy check (T22: a `no` policy reports a rollback); M10: delete the `detectRollback` line in `index.ts` (the pin) |
| the removal is forced and the rename names the canonical container | 2 | T9 | M11: drop `true` from `remove(originalId, true)`; M12: rename to `original.Name` with its leading slash |
| each completion step degrades, never throws | 2 | T7, T8, T8b, T10, T11, T12 | M13: delete the removal's `try`/`catch`; M14: delete the rename's `.catch`; M15: remove the corpse on an inspect failure (T8b) |
| the retry cap is carried and restored for `on-failure` only | 1, 2, 4 | T5, T14, `ops/bot-ops.test.ts:3659` | M16: always pass `MaximumRetryCount` (the `unless-stopped` row red); M17: drop the cap (T5's on-failure row red); M18: push the env for every policy (T14 red); M19: remove the `RESERVED_KEYS` row (the scan red) |
| `afterActivate` runs in standby only | 3 | T16 | M20: drop the `mode === "standby"` gate on `afterActivate` |
| the first tick is observable | 1 | the `announce.test.ts` test | M21: return `Promise.resolve()` instead of `first` |
| index.ts wires probation and the rollback check | 3 | `index.test.ts` pins | M22: drop `afterActivate` from the `createReadyHandler` call (tsc also catches it: say so); M23: assign `firstTick` nowhere (the `firstTick = startScheduler(` pin) |
| the docs say what the code does | 5 | manual: reviewer B reads every edited sentence, the gotchas, the ADR note and the table rows against the code | -- |

Run every mutation in a scratch copy (`git worktree add --detach <path> <sha>`), never in the tree the
tests or a reviewer are reading. Paste the red test's name per row in the PR.

### Checks, gate, PR

- `bun run check`; `bunx tsc --noEmit -p ops/tsconfig.json`; `bun run check` inside `ops/admin/`;
  `bun test` from the repo root, then `bun test --randomize` once. Name CI's Linux run as the evidence for
  the `ops/*` suites that skip here. The PR is not ready until CI is green.
- Review gate: reviewer A on correctness and failure modes (walk rows 19-25 of the state table against the
  new sequence; the crash-in-probation loop and whether anything in it can produce two live bots for
  longer than one inspect; `detectRollback` against every standby-boot state: first attempt, re-entrant
  with a corpse, re-entrant with a revived original, transport-drop after `restorePolicy`, a pre-#160
  standby; `stepAside` when the daemon is down; the probation window against the `bot-ops.sh` guard as it
  stands; a standby boot that finds the corpse and re-runs `takeOver` then `finishProbation`;
  `restorePolicy` idempotence; the retry-cap parsing against a junk env value; the ready handler's
  rejection path; the first-tick wait when the tick starts a redeploy); reviewer B on claims-vs-code,
  walking the coverage table, every edited comment, the README, `ops/README.md`, ADR and `CONTEXT.md`
  sentences and the table rows against the merged tree. Both read-only, both handed the merged tree, #548,
  #490 and the state table. Fix or decline every evidenced finding in writing; re-run the gate on the whole
  merged state after a behaviour fix.
- Branch `fix/525-S3a-probation`; commit and PR title
  `fix(redeploy): keep the stopped original until the new build has run a tick, step aside if it is started again, then tag, remove and rename (#548, #490)`.
  Body: one line each `Closes #548` (its on-daemon bullet named as the orchestrator's operator step, so the
  issue is reopened or kept open if that is preferred -- say which), `Part of #490 (items 5, 7, 9 here;
  2 in S3b-1, 8 in S3b-2)`, `Part of #512 (docker-restart-5 lands here)`; the pasted checks; the mutation
  rows; the gate's rounds; decisions 1-9 named as assumptions taken (decision 2's step-aside rule and
  decision 4's residuals each in their own paragraph); the merge-after-S1 note for `CONTEXT.md`. After the
  merge, comment on #512 naming the PR and the item (do not close it). Do not merge.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot. Work in a NEW worktree, never the shared checkout:
  git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-525-S3a origin/main -b fix/525-S3a-probation
Issues: Rackbops/rackbops-discord-bot #548 #490 (sub-epic #525 of Epic #516; roshne chose #548's option 1 on 2026-10-15, see its Decision comment). Read both issue bodies and their comments first, and rows 19-25 of docs/plans/epics/E516/525-handoff-state-table.md.
Plan: docs/plans/epics/E516/525-S3a-probation.md on branch claude/525-plans:
  git -C S:\Repos\rackbops-discord-bot show origin/claude/525-plans:docs/plans/epics/E516/525-S3a-probation.md
Behaviour change at the heart of the swap: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Every mutation in a scratch worktree. S1 (another session) merges before you: do everything but step 5's CONTEXT.md edits, open the PR as a draft, and make those edits on S1's merged text once it is on main (tell the orchestrator if it is not). Scratch files: task-unique names (pr-body-525S3a.md, commit-msg-525S3a.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds and any deviation. Do not merge.
```
