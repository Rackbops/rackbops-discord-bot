<!-- Plan for #525 bundle S4b (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #525): #491's five Low items in the
redeploy path, plus two notes raised while S3a/S3b-2/#541 were under review. Written by the orchestrating session on
2026-10-16 against `main` @ `8b23559` (S3b-2 merged; the anchors are unchanged at `146fdc5`, which touched none of
the `src/` files this plan edits -- `index.test.ts`, run in Verification, gained six lines); audited read-only before
it was committed (round 1: three blockers, all applied -- the retirement
wait's new per-poll inspect broke an existing call-counting test; the carried-key list was guarded only by a test that
looped over the list itself; the Entrypoint/Cmd fixture did not typecheck -- and two design holes: carrying
`WorkingDir`/`Healthcheck`/`StopSignal` reintroduces the image-vs-container merge problem the `GIT_SHA` drop exists for,
so they are NOT carried; and reading the marker before the inspect let a "died" verdict hide the replacement's own
failure reason, so the inspect now comes first. The item-11 decline cited a false fact and is reworded; the
`finishProbation` log simply drops its suffix. Round 2: no blocker -- the inspect's time bound and the
marker-read-on-inspect-failure were unguarded, so T13e/T13f and M29/M30 exist; the bound's floor is `pollMs`, not 1 s,
so the small-deadline tests stay fast; T13c's marker is written inside the poll so the inspect-first order is what it
pins; the decline's "holds no alias" was wrong -- a stopped container's endpoint is gone). Every file:line below was
read from that tree; the implementer re-reads
each one on the tree it works from and corrects any that moved. Nothing in flight touches these files: L1 (Sub #2)
edits `commands.ts`/`report.ts`; L2 (Sub #3) edits `announce.ts`/`github.ts`; #567 (this sub, after this bundle) edits
`ops/install.sh`. Apply mutants with the Edit tool: the hooks refuse a shell `sed -i` on a `.ts` file. -->

## Implementation plan -- #525 S4b: the redeploy Lows -- carry what the create spec dropped, parse image names right, notice a replacement that dies after `ready`, clear the marker at the right moment, and two notes

Children: **#491** (items 10-14 -- closes it; item 11 is declined in writing, see Decision 2). Plus two notes with no
issue of their own, fixed here because they sit in the same functions: `stepAside`'s exit-1 fallback runs the #446 exit
hooks, and `finishProbation`'s log line stops announcing a swap it may not complete. One PR, branch
`fix/525-S4b-redeploy-lows`, worktree `S:\Repos\_wt\rdb-525-S4b` cut from `origin/main`. Behaviour changes in the
self-update path -> the **three-reviewer gate** applies; every changed line mutation-tested in a scratch worktree.

### What is wrong, verified at `8b23559`

- **#491 item 10.** `buildCreateSpec` (`src/redeploy.ts:194-244`) says it derives the spec "entirely from the
  original's own inspect" (`:162`) but carries a fixed set: `Image`, `Env`, `Labels`, `User`, `HostConfig.Binds`
  (from `Mounts`, `:231-233`), `RestartPolicy: no` (`:236`), `NetworkMode` (`:237`), `Init` (`:240`) and the one
  network's `Aliases` (`:242`). Everything else an operator set in compose is lost at the first swap: `logging:`
  (`HostConfig.LogConfig`), `mem_limit`/`cpus` and friends, `cap_add`/`cap_drop`, `extra_hosts`, `dns`,
  `security_opt`, `ulimits`, `read_only`, `pids_limit`, `stop_grace_period` (`Config.StopTimeout`), and any network
  beyond `NetworkMode`. Worse, a long-form tmpfs mount (compose's `volumes: - type: tmpfs`, or `--mount type=tmpfs`)
  is a `Mounts` entry of `Type: "tmpfs"` with an empty `Source` and no `Name`, so `:232` renders it as `:/path:rw`,
  `POST /containers/create` answers 400, and every self-update of that deployment fails. (The short form, compose's
  `tmpfs:` list or `--tmpfs`, lands in `HostConfig.Tmpfs` and not in `Mounts`; that map is simply not carried today.
  Both facts are from Docker's API shape, not verified against a daemon here; the PR says so.) `ContainerInspect`
  (`src/docker.ts:72-86`) and `CreateContainerSpec` (`:88-105`) type only the carried fields. What must NOT be carried
  from `Config`: the inspect's `Config` merges the image's values with the container's (the reason `GIT_SHA` is
  dropped at `:202`), so `WorkingDir`, `Healthcheck`, `StopSignal`, `Entrypoint` and `Cmd` carried verbatim would pin
  the OLD image's values onto the new container -- a later `WORKDIR` change in the Dockerfile (`Dockerfile:2` has
  `WORKDIR /app` and a relative `CMD`) would boot the standby in the wrong directory and fail every self-update until
  a manual recreate. `StopTimeout` is container-only and safe.
- **#491 item 11.** The compose service alias (`bot`) is attached at create time (`:242`); the standby binds its HTTP
  listener only inside `activate()` (`src/index.ts:420`), after its gateway login, so for the seconds between its
  create and that point Docker DNS can hand `http://bot:<port>` to a container that refuses the connection. The
  test comment at `src/redeploy.test.ts:394-396` ("inert today (no HTTP server yet)") predates the HTTP router
  (#220) and is stale.
- **#491 item 12.** `shaTag` (`:117-120`), `latestTag` (`:130-133`) and `selectImagesToPrune` (`:140-159`) take the
  image repo as `currentImage.split(":")[0]`. A registry with a port (`registry:5000/bot:tag`) yields `registry`,
  so the build is tagged `registry:abc1234` and `:latest` is applied to the wrong name; a digest reference
  (`ghcr.io/x/bot@sha256:…`) is never stripped. The tests (`src/redeploy.test.ts:129-221`, the three naming
  describes) use unqualified names only. (`tagImage` in `docker.ts` already splits at the last colon; this is the
  callers' parsing.)
- **#491 item 13.** After `ready`, `redeploy()` waits in `awaitRetirementFailure` (`:640-650`), which polls only the
  marker: a replacement that dies hard after writing `ready` and before it has stopped the original (an OOM kill,
  a crash) leaves the marker at `ready`, and the original sits quiesced for the whole `RETIREMENT_DEADLINE_MS`
  (3 minutes, `src/handoff.ts:54`) before `stalled`. `awaitHandoff` (`:594-631`) already inspects the replacement
  each poll; the retirement wait does not. (Once the replacement's `restorePolicy` has run, Docker restarts it on a
  crash and its status is not `exited`; the detection window is ready-written to original-stopped.)
- **#491 item 14.** `redeploy()`'s first awaited call clears the marker (`:293`, after three consts), then it inspects
  itself, builds (up to `BUILD_TIMEOUT_MS`, 15 minutes, `src/docker.ts:53`), prunes, inspects the leftover, and only
  then creates the replacement (`:378`). A surviving earlier standby that writes `ready` or `failed` during that
  window is attributed to the new attempt by the first poll. The marker's writers are a standby (`src/index.ts:84`,
  `takeOver`, which also clears it at `:858`), and its readers are this function's polls (`:602`, `:647`), the late
  re-read (`:465`) and the final read (`:523`) -- all after the create; nothing reads it outside a redeploy.
- **Note 1 (from R1/S4a's gate).** `stepAside` (`:1256-1272`) exits 1 at `:1265` and `:1270` without running the
  #446 exit hooks (`runExitHooks`, `src/restart.ts:219`, idempotent: it swaps the array before running), so an
  interaction line in flight is lost; its normal path (the daemon's SIGTERM into the shutdown handler) runs them
  (`src/index.ts:156`).
- **Note 2 (from #541's gate).** `finishProbation` (`:1029-1036`) logs "probation over (first tick …) — completing
  the swap" (`:1034`) before `completeTakeOver` decides: it may step aside (a rollback, `:954-959`) or return early
  under `isShuttingDown()` (`:960`), and it logs each of those itself. The suffix is the false part.

### Decisions (defaults, named so the gate can contest them)

1. **The create spec carries a deliberate, listed set, and says what it leaves.** No wholesale `HostConfig` copy.
   - Mounts by type: `volume` and `bind` -> `Binds` as today; `tmpfs`: the inspect's `HostConfig.Tmpfs` map is
     carried verbatim (the short form, with its options), and the `tmpfs` entries of `HostConfig.Mounts` (the long
     form, options in `TmpfsOptions`) are carried verbatim into the spec's `HostConfig.Mounts`; a `Mounts` entry of
     any other type is logged by name and dropped.
   - `HostConfig` keys carried verbatim when present and not null, listed in an exported `CARRIED_HOST_CONFIG_KEYS`:
     `LogConfig`, `CapAdd`, `CapDrop`, `ExtraHosts`, `Dns`, `DnsSearch`, `DnsOptions`, `SecurityOpt`, `Ulimits`,
     `ReadonlyRootfs`, `Memory`, `MemorySwap`, `MemoryReservation`, `NanoCpus`, `CpuShares`, `PidsLimit`, `ShmSize`,
     `Sysctls`, `Devices`, `GroupAdd`, `OomKillDisable`, `Privileged` (22). From `Config`: `StopTimeout` only.
   - NOT carried, on purpose: `WorkingDir`, `Healthcheck`, `StopSignal`, `Entrypoint`, `Cmd` (image-merged: the new
     image's must win; a compose `healthcheck:`/`stop_signal:`/`command:` override is therefore not carried across a
     self-update, as today -- mirroring the `oldImageEnv` fix for them needs the old image's config and is a
     follow-up if anyone needs it; the docstring says so); `PortBindings`/`ExposedPorts` (the original holds the
     port; warned when present); networks beyond `NetworkMode` (warned by name; joining more needs a connect call per
     network after create); `Hostname`, `IpcMode`, `PidMode`, `Runtime`, `CpuPeriod`/`CpuQuota`, `CpusetCpus`,
     `MemorySwappiness`, `OomScoreAdj`, `CgroupParent`, `StorageOpt` (named in the docstring as not carried).
   - `buildCreateSpec` gains a third parameter `log: Pick<Console, "warn"> = console`; what is dropped is warned by
     name; a `NetworkMode` of `default`/`bridge` does not warn about the `bridge` network.
2. **Item 11 is declined.** Docker cannot add an alias to a live endpoint: attaching it at the takeover would mean
   disconnecting and reconnecting the just-verified standby's network, likely dropping its gateway session, to close
   a window of seconds in which a connection to `bot:<port>` may be refused and retried; and attaching it only at
   `completeTakeOver` would leave `bot` resolving to nothing for all of probation (the original holds the alias
   while it runs, but it is stopped at `takeOver`, `:857`, and a stopped container's endpoint is gone). The stale
   comment is corrected and the window is documented. Declined in writing on #491 with these reasons.
3. **An `imageRepo(ref)` helper** strips a digest (`@` and everything after) and cuts a tag only at a `:` that
   follows the last `/` (so a registry port survives); the three callers use it.
4. **The retirement wait inspects the replacement each poll, inspect first.** `awaitRetirementFailure(replacementId,
   deadlineMs, pollMs, inspect = tryInspectContainer)` returns `{ kind: "failed" }` (marker), `{ kind: "died",
   status, exitCode }` (the container's status is `exited` or `dead`), or `{ kind: "stalled" }` (deadline). Each poll
   inspects FIRST, bounded by the time left in the deadline (at most docker.ts's default 60 s, at least 1 s), then
   reads the marker: a `failed` marker written as the replacement dies still wins, so its own reason is reported
   (`error: pollError ?? marker?.error`, `:580`). An inspect that throws is not a verdict (as in `awaitHandoff`): the
   marker is still read that poll (so a `failed` written during a daemon outage is seen, as today), then the wait
   goes on. `created`, `restarting`, `removing`, `running` and an
   absent container (404 -> `undefined`) are not "died" either; the deadline bounds them. Each inspect is bounded by
   the time left (a poll at least, 60 s at most), so the wait outlives the deadline by at most a poll plus one bounded
   inspect, and `README.md:62`'s "3 minutes" stays true (its worst-case sum has more slack than that); the README is
   unchanged.
5. **The marker is cleared right before `createContainer`**, after the leftover removal, inside the `try` at
   `:373`; the clear at the end (`:575`) stays. The early returns before the build no longer clear a stale marker,
   which is right: nothing reads it until the next attempt's own clear.
6. **`stepAside` runs `runExitHooks()` before each `exit(1)`.** Its normal path is unchanged.
7. **`finishProbation` drops the suffix:** it logs `[handoff] probation over (first tick …)` and calls `complete`;
   `completeTakeOver` already logs the step-aside and the shutdown cases itself. No new import.

### Step 1 -- `src/docker.ts`: the types

`ContainerInspect` (`:72-86`): `Config` gains, optional, `StopTimeout?: number; WorkingDir?: string;
Healthcheck?: unknown; StopSignal?: string; Entrypoint?: string[] | string | null; Cmd?: string[] | string | null;`
(the last five exist only so tests can put them on a fixture and assert they are NOT carried). `HostConfig` gains,
optional, `Tmpfs?: Record<string, string> | null; Mounts?: { Type: string; Target?: string; Source?: string;
TmpfsOptions?: unknown; [k: string]: unknown }[] | null; PortBindings?: Record<string, unknown> | null;` and one
optional entry per name in `CARRIED_HOST_CONFIG_KEYS` typed `unknown` (copied, never read). `CreateContainerSpec`
(`:88-105`): `HostConfig` gains the same optional carried keys plus `Tmpfs?: Record<string, string>` and
`Mounts?: unknown[]`; the top level gains `StopTimeout?: number`. Keep the comment style of the file.

### Step 2 -- `src/redeploy.ts`

2a. Beside `KEEP_SHA_TAGS` (`:49`):

```ts
/** `HostConfig` keys the replacement inherits verbatim from the original (#491 item 10): what compose sets per
 *  service and the create API accepts unchanged. Anything else in the inspect's HostConfig is NOT carried, and
 *  `buildCreateSpec` says so when it would have mattered (a mount of another type, a second network, a port binding). */
export const CARRIED_HOST_CONFIG_KEYS = [
  "LogConfig", "CapAdd", "CapDrop", "ExtraHosts", "Dns", "DnsSearch", "DnsOptions", "SecurityOpt", "Ulimits",
  "ReadonlyRootfs", "Memory", "MemorySwap", "MemoryReservation", "NanoCpus", "CpuShares", "PidsLimit", "ShmSize",
  "Sysctls", "Devices", "GroupAdd", "OomKillDisable", "Privileged",
] as const;
```

2b. `imageRepo` above `shaTag`'s docstring (`:111`):

```ts
/**
 * The repository part of an image reference (#491 item 12): `registry:5000/bot:tag` -> `registry:5000/bot`,
 * `ghcr.io/x/bot@sha256:…` -> `ghcr.io/x/bot`, `bot:latest` -> `bot`, `bot` -> `bot`. A tag is only ever after the
 * last `/`, so a registry port's colon is left alone; a digest is cut at its `@`.
 */
export function imageRepo(ref: string): string {
  const noDigest = ref.split("@")[0] ?? ref;
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.indexOf(":", slash + 1);
  return colon === -1 ? noDigest : noDigest.slice(0, colon);
}
```

`shaTag` (`:118`), `latestTag` (`:131`) and `selectImagesToPrune` (`:145`) each replace
`const repo = currentImage.split(":")[0] ?? currentImage;` with `const repo = imageRepo(currentImage);`.

2c. `buildCreateSpec` (`:194-244`): signature
`export function buildCreateSpec(self: ContainerInspect, o: {...}, log: Pick<Console, "warn"> = console): CreateContainerSpec`.
After the `aliases` const (`:216-218`) and before `return {` (`:219`):

```ts
  // #491 item 10: mounts by type. `volume`/`bind` are Binds (derived from Mounts rather than HostConfig.Binds:
  // compose may express a named volume as either, and Mounts is always populated); tmpfs comes two ways and both are
  // carried as the daemon reported them -- the short form (`tmpfs:` / --tmpfs) as HostConfig.Tmpfs, the long form
  // (`type: tmpfs` / --mount) as HostConfig.Mounts entries with their TmpfsOptions -- never as a Bind, which is the
  // `:/path:rw` that made every create 400; any other Mounts type is named in the log and dropped.
  const binds: string[] = [];
  for (const m of self.Mounts) {
    if (m.Type === "bind" || m.Type === "volume") binds.push(`${m.Name ?? m.Source}:${m.Destination}:${m.RW ? "rw" : "ro"}`);
    else if (m.Type !== "tmpfs") log.warn(`[redeploy] not carrying the ${m.Type} mount at ${m.Destination} onto the replacement — only bind, volume and tmpfs mounts are`);
  }
  const tmpfs = self.HostConfig.Tmpfs ?? undefined;
  const tmpfsMounts = (self.HostConfig.Mounts ?? []).filter((m) => m.Type === "tmpfs");
  const carried: Record<string, unknown> = {};
  for (const key of CARRIED_HOST_CONFIG_KEYS) {
    const value = (self.HostConfig as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) carried[key] = value;
  }
  const otherNetworks = Object.keys(self.NetworkSettings.Networks).filter(
    (n) => n !== netMode && !((netMode === undefined || netMode === "default" || netMode === "bridge") && n === "bridge"),
  );
  if (otherNetworks.length > 0) {
    log.warn(`[redeploy] the replacement joins ${netMode ?? "the default network"} only — not ${otherNetworks.join(", ")} (a self-update carries one network)`);
  }
  if (self.HostConfig.PortBindings && Object.keys(self.HostConfig.PortBindings).length > 0) {
    log.warn(`[redeploy] the original's published ports (${Object.keys(self.HostConfig.PortBindings).join(", ")}) are not carried onto the replacement: it would collide with the original while both exist`);
  }
```

The returned `HostConfig` becomes
`{ Binds: binds, ...(tmpfs && Object.keys(tmpfs).length ? { Tmpfs: tmpfs } : {}), ...(tmpfsMounts.length ? { Mounts: tmpfsMounts } : {}), RestartPolicy: { Name: "no" }, NetworkMode: netMode, Init: self.HostConfig.Init ?? undefined, ...carried }`,
and the top level gains `...(self.Config.StopTimeout !== undefined ? { StopTimeout: self.Config.StopTimeout } : {})`
(spread the way `NetworkingConfig` is). The docstring's first paragraph (`:162-164`) becomes: "The replacement's
container spec, derived from the original's own inspect — a deliberate subset: what compose sets per service and
the create API takes unchanged (`CARRIED_HOST_CONFIG_KEYS`; the mounts by type, tmpfs as the daemon reported it;
`StopTimeout`; the labels, the user, the one network and its alias). NOT carried: `WorkingDir`, `Healthcheck`,
`StopSignal`, `Entrypoint` and `Cmd` (the inspect merges the image's values with the container's, the same reason
`GIT_SHA` is dropped below, so the new image's must win; a compose override of those is lost across a swap, as it
always was); published ports, extra networks and the other `HostConfig` keys (`Hostname`, `IpcMode`, `PidMode`,
`Runtime`, `CpuPeriod`/`CpuQuota`, `CpusetCpus`, `MemorySwappiness`, `OomScoreAdj`, `CgroupParent`, `StorageOpt`).
What is dropped is named in the log when it would have mattered (#491 item 10)."

The call site (`:380`) is unchanged (the default `console`).

2d. `redeploy()`: delete `await clearMarker();` at `:293`; inside the `try` at `:373`, after the leftover removal
(`:377`) and before `createContainer` (`:378`):

```ts
    // #491 item 14: cleared HERE, after the sweep and right before the create, not at the top of this function:
    // a surviving earlier standby that writes during the build (up to 15 minutes) must not be read as this
    // attempt's replacement by the first poll. Nothing reads the marker outside a redeploy.
    await clearMarker();
```

2e. The `ready` branch (`:492-498`):

```ts
      const retirement = await awaitRetirementFailure(replacementId, opts.deadlineMs, pollMs);
      if (retirement.kind === "failed") {
        console.error("[redeploy] replacement signalled failed after verifying — reclaiming");
        outcome = "failed";
      } else if (retirement.kind === "died") {
        // #491 item 13: it wrote `ready` and then died before it had stopped us (an OOM kill, a crash) — the marker
        // never flips, so without this the original would sit quiesced for the whole deadline.
        pollError = `the replacement died after signalling ready (status ${retirement.status}, exit ${retirement.exitCode})`;
        console.error(`[redeploy] ${pollError} — reclaiming`);
        outcome = "failed";
      } else {
        console.error("[redeploy] verified replacement never retired us — reclaiming");
        outcome = "stalled";
      }
```

(`pollError` is the `let` declared above this block for the poll's error; `:580` reports it ahead of the marker's;
a `failed` marker written as the replacement died is read in the same poll and wins, see 2f.)

2f. `awaitRetirementFailure` (`:633-650`):

```ts
export type RetirementWait = { kind: "failed" } | { kind: "died"; status: string; exitCode: number } | { kind: "stalled" };

/**
 * Poll the replacement AND the marker during the post-`ready` retirement wait: a replacement that died after
 * writing `ready` (#491 item 13: `exited` or `dead`) and a `failed` written after `ready` are each caught within one
 * `pollMs`, not left until `deadlineMs` (`RETIREMENT_DEADLINE_MS`, 3 minutes) elapses blind. The inspect comes
 * FIRST and the marker second, so a `failed` the replacement wrote as it died still wins and its own reason is
 * reported. `created`/`restarting`/`removing`/`running`, an absent container and an inspect that throws are not a
 * verdict (as in `awaitHandoff`); the deadline bounds them. Each inspect is bounded by the time left, so the wait
 * never outlives the deadline by more than one poll.
 */
async function awaitRetirementFailure(
  replacementId: string,
  deadlineMs = RETIREMENT_DEADLINE_MS,
  pollMs = POLL_MS,
  inspect: (id: string, timeoutMs?: number) => Promise<ContainerInspect | undefined> = tryInspectContainer,
): Promise<RetirementWait> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    await Bun.sleep(pollMs);
    const remainingMs = deadlineMs - (Date.now() - startedAt);
    let current: ContainerInspect | undefined;
    try {
      // Bounded by the time left (a poll at least, docker.ts's default at most), so a hung daemon cannot hold this
      // wait past the deadline by more than one bounded call.
      current = await inspect(replacementId, Math.max(pollMs, Math.min(60_000, remainingMs)));
    } catch {
      // not a verdict: the marker below still decides this poll
    }
    if ((await readMarker())?.status === "failed") return { kind: "failed" };
    if (current && (current.State.Status === "exited" || current.State.Status === "dead")) {
      return { kind: "died", status: current.State.Status, exitCode: current.State.ExitCode };
    }
  }
  return { kind: "stalled" };
}
```

(`exited`/`dead` imply not running, so there is no `!Running` conjunct, and `current` is set only when the inspect
succeeded, so there is no "inspected" flag: each would be an equivalent mutant. The docstring's last sentence reads
"so the wait never outlives the deadline by more than a poll plus one bounded inspect".)

2g. `finishProbation` (`:1034`): `console.log(`[handoff] probation over (first tick ${how})`);` -- the suffix is gone;
no import change.

2h. `stepAside` (`:1256-1272`): import `runExitHooks` from `./restart` (the import at `:43` already has
`isShuttingDown`; add `runExitHooks` to it); before each `exit(1)` (`:1265`, `:1270`) add
`runExitHooks(); // #446: an interaction line in flight is written before this process ends`. The docstring
(`:1250-1254`) gains "Either exit runs the #446 exit hooks first, as the daemon's SIGTERM path does through the
shutdown handler."

### Step 3 -- docs

- `src/redeploy.test.ts:394-396` comment -> "#51 item 6: without this the replacement resolves by container name
  only, so `http://bot:<port>` (README's documented tunnel mapping) stops resolving after the first self-update.
  #491 item 11: the alias is attached at create, so for the seconds before the standby's HTTP router is up (started
  inside `activate()`, after its login) Docker DNS may hand `bot` to a container that refuses the connection;
  attaching it at the takeover would need a disconnect/connect of the live standby's network -- declined."
- `CONTEXT.md:192` (the `src/redeploy.ts` row, one long line): old ``Pure `buildCreateSpec()` derives the replacement entirely from the original's own inspect (compose labels replicated, mounts re-bound, `User` carried over, `GIT_SHA` **dropped** so the new image's baked sha wins)``
  -> new ``Pure `buildCreateSpec()` derives the replacement from the original's own inspect, a deliberate subset (compose labels replicated, bind/volume mounts re-bound and tmpfs carried as reported, `CARRIED_HOST_CONFIG_KEYS` and `StopTimeout` copied, `User` carried over, `GIT_SHA` **dropped** so the new image's baked sha wins, and `WorkingDir`/`Healthcheck`/`StopSignal`/`Entrypoint`/`Cmd` left to the new image for the same reason; what is dropped is warned by name, #491)``.
  Append to the same row (it ends `if the stop call itself fails |` with no full stop, so the appendix starts with
  `. `): `` . **#491:** `imageRepo()` parses a registry port and a digest for `shaTag`/`latestTag`/`selectImagesToPrune`; the post-`ready` retirement wait inspects the replacement each poll (bounded by the time left), so one that died after `ready` is `failed` within a poll with its status and exit code, a `failed` marker written as it died still winning; the marker is cleared right before the create, not at the top of `redeploy()`; the compose service alias is attached at create, so `bot` can resolve to the standby for the seconds before its router is up (item 11, declined: moving it needs a disconnect/connect of the live standby). ``
- `CONTEXT.md:795`: old `the original reads it, and clears it at the start of a redeploy and after a failed`
  -> new `the original reads it, and clears it right before it creates the replacement and after a failed` (read the
  rest of that sentence and keep it grammatical).
- Optional: `CONTEXT.md:193` (the `redeploy.test.ts` row) gains the new tests' names.
- `README.md`: no change (`README.md:62`'s "3 minutes" stays true, Decision 4; no README text mentions tmpfs,
  logging or mem_limit).
- `#491`: the decline of item 11 as a comment, with Decision 2's reasons (not "both serve during probation").

### Step 4 -- tests (`src/redeploy.test.ts` unless noted)

The destructure at `:7-28` gains `imageRepo` and `CARRIED_HOST_CONFIG_KEYS`; `beginShutdown` and `resetForTest` are
already imported (`:31`); `onBeforeExit` joins the `./restart` import and `readMarker` the `./handoff` destructure at
`:29` (alias it `readMarkerForTest` if a name clashes).

- **Existing test, must change:** `:2053-2066` "a ready marker decides in the same poll as a failed inspect" counts
  the inspects on the replacement route (`:2063` expects 2); the retirement wait now inspects each poll. Set its
  `deadlineMs: 60` (`:2059`) to `deadlineMs: 0` so the retirement loop makes no inspect; say so in the PR (a break
  outside the diff). `touchedSelf` is unaffected (the inspect is a GET).
- **T12** in the naming describes (`:129-221`): `imageRepo("registry:5000/bot:tag")` -> `registry:5000/bot`;
  `imageRepo("ghcr.io/x/bot@sha256:abc")` -> `ghcr.io/x/bot`; `imageRepo("localhost:5000/bot")` -> `localhost:5000/bot`;
  `imageRepo("bot:latest")` -> `bot`; `imageRepo("bot")` -> `bot`; `imageRepo("registry:5000/ns/bot:1.2@sha256:abc")`
  -> `registry:5000/ns/bot`. And one case each with `registry:5000/warbandeer-discord-debug-bot:latest`: `shaTag` ->
  `registry:5000/warbandeer-discord-debug-bot:abcdef1`, `latestTag` -> `...:latest`, and `selectImagesToPrune` with sha
  tags under that repo prunes them and leaves a `registry:1111111` image alone.
- **T10a-f (a, b, b2, c, d, e, e-bridge, e2, f)** in `describe("buildCreateSpec", …)` (`:223-432`; T10f in the
  `redeploy()` describe):
  - T10a (tmpfs): a SELF variant with `HostConfig.Tmpfs: { "/tmp": "size=64m" }` and `HostConfig.Mounts:
    [{ Type: "tmpfs", Target: "/run/x", TmpfsOptions: { SizeBytes: 1024 } }]` and `Mounts` containing
    `{ Type: "tmpfs", Source: "", Destination: "/run/x", RW: true }` -> `Binds` has no `/run/x` entry;
    `HostConfig.Tmpfs` equals `{ "/tmp": "size=64m" }` verbatim; `HostConfig.Mounts` equals the one tmpfs entry
    verbatim; a `bind` entry in `HostConfig.Mounts` is NOT copied. Plain `SELF` -> `HostConfig.Tmpfs` and
    `HostConfig.Mounts` are `undefined`.
  - T10b (carried keys): for each key in `CARRIED_HOST_CONFIG_KEYS`, a SELF variant with that key set to a sentinel
    object is carried verbatim (`toEqual`); plain SELF yields none of them; a variant with `CapAdd: null,
    OomKillDisable: null` yields neither key present.
  - T10b2 (the list itself): `expect([...CARRIED_HOST_CONFIG_KEYS]).toEqual([the 22 names, in order])` -- the pin that
    makes removing a name red (T10b loops over the constant and cannot see a removal).
  - T10c (Config): `StopTimeout: 25` carried; a variant with `WorkingDir`, `Healthcheck`, `StopSignal`, `Entrypoint`
    and `Cmd` set -> none of the five is on the spec.
  - T10d: a `Mounts` entry of `Type: "npipe"` -> one warn naming `npipe` and its destination, no Binds entry for it.
  - T10e: `NetworkSettings.Networks` with a second key `tunnel_net` -> one warn naming `tunnel_net`; `NetworkMode`
    and aliases unchanged. T10e-bridge: `NetworkMode: "default"` with `Networks: { bridge: {} }` -> no warn.
  - T10e2: `HostConfig.PortBindings: { "8080/tcp": [{ HostPort: "8080" }] }` -> one warn naming `8080/tcp`, and no
    `PortBindings` on the spec.
  - T10f (end to end, in the `redeploy()` describe beside `:2446-2459`): `stubDaemon({ self: { ...SELF, HostConfig:
    { ...SELF.HostConfig, LogConfig: { Type: "json-file", Config: { "max-size": "10m" } }, Tmpfs: { "/tmp": "" } },
    Mounts: [...SELF.Mounts, { Type: "tmpfs", Source: "", Destination: "/tmp", RW: true }] }, ... })` -> the
    `/containers/create` body carries `HostConfig.LogConfig` and `HostConfig.Tmpfs` verbatim and no `:/tmp:rw` bind.
- **T13 (+ b, c, d)** in the `redeploy()` describe, beside `:2465-2479`. The harness answers the handoff poll AND the
  retirement-wait inspects through `pollReplacement` (same route); check that and extend the harness rather than
  special-case if it distinguishes them.
  - T13: `afterStart` writes `ready`; `pollReplacement` answers running until a flag flips 60 ms in, then
    `{ ...SELF, State: { Running: false, Status: "exited", ExitCode: 137 } }`; `redeploy("4".repeat(40), { deadlineMs: 2000, pollMs: 20 })`
    -> `outcome` `failed`, `error` `the replacement died after signalling ready (status exited, exit 137)`, done in
    under 1 s, `handoffActive()` false, `wasRemovalAttempted()` true.
  - T13b (inspect throws, marker stays ready): `pollReplacement` answering 500 once the marker is `ready`,
    `{ deadlineMs: 120, pollMs: 15 }` -> `stalled`, not `failed`.
  - T13c (the marker wins): as T13, but the marker is written INSIDE `pollReplacement` -- when the flag is set, the
    stub does `await writeMarker({ status: "failed", sha: "4444444", error: "takeover failed: boom", at: Date.now() })`
    and THEN returns the exited inspect (so the marker lands between that poll's inspect and its marker read, which
    is exactly what the inspect-first order must survive) -> `outcome` `failed` and `error` is `takeover failed: boom`
    (the replacement's own reason, not the generic died message). Written before the flag instead, the marker is on
    disk before the poll and the test cannot tell the two orders apart.
  - T13d (`created` is not died): `pollReplacement` answering `{ Running: false, Status: "created", ExitCode: 0 }`
    after `ready`, `{ deadlineMs: 120, pollMs: 15 }` -> `stalled`.
  - T13e (the inspect is bounded by the time left): after `stubDaemon`, wrap `globalThis.fetch` so the SECOND GET of
    `/containers/<replacementId>/json` after `ready` hangs until `init.signal` aborts (reject with the signal's
    reason), the rest passing through; `redeploy("6".repeat(40), { deadlineMs: 60, pollMs: 15 })` -> `stalled`, and
    the whole call takes under 3000 ms (`Date.now()` before and after). With the bound replaced by a flat 60 s the
    test times out.
  - T13f (a `failed` marker is seen through a daemon outage): `pollReplacement` answering 500 on every call after
    `ready`; a `failed` marker with error `retire boom` written 60 ms in; `{ deadlineMs: 300, pollMs: 20 }` ->
    `failed` with `error` `retire boom`.
- **T14** in the `redeploy()` describe: write a stale marker `{ status: "ready", sha: "stale00", at: 0 }` BEFORE
  calling `redeploy`. Harness changes (the exact shape that compiles): the `leftover` option becomes
  `leftover?: () => Response | Promise<Response>` and its call `return o.leftover ? await o.leftover() : new Response("", { status: 404 })`;
  add `onCreate?: () => Promise<void>` and call `await o.onCreate?.();` right after `pendingAt.create = restartPending();`,
  before the `createTimesOut` throw. The test's `leftover` returns a stopped leftover after recording
  `markerAtSweep = await readMarker()`; `onCreate` records `markerAtCreate = await readMarker()`; assert
  `markerAtSweep?.sha === "stale00"` and `markerAtCreate === undefined`.
- **T-note1** in `describe("stepAside", …)` (`:1441`): register `onBeforeExit(() => ran.push("hook"))`
  (`resetForTest` in the `finally`), make `stop` reject -> the hook ran before `exit(1)` (`ran` holds `"hook"` before
  `exits` records); and the grace-expiry path (`sleep` resolving at once) also runs it.
- **T-note2** in `describe("finishProbation", …)` (`:1294`): the log line equals `[handoff] probation over (first tick settled)`
  (the `said` capture already exists there) and no captured line contains `completing the swap`; `complete` called
  once. Under `beginShutdown("test")` (`resetForTest` in `finally`; `beginShutdown` itself logs
  `[restart] shutdown in progress: test` into `said`, so assert on the specific line, not on `said.length`): the same
  line, still no `completing the swap`, `complete` still called once.

### Mutation table (run in a scratch worktree, never in the shared tree; apply each with the Edit tool)

```bash
git -C /s/repos/rackbops-discord-bot worktree add --detach /s/Repos/_wt/rdb-525-S4b-mut fix/525-S4b-redeploy-lows
cd /s/Repos/_wt/rdb-525-S4b-mut && bun install --frozen-lockfile
```

Run `bun test src/redeploy.test.ts src/docker.test.ts` per mutant; revert with `git -C /s/Repos/_wt/rdb-525-S4b-mut checkout -- .`;
remove the worktree at the end.

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | `imageRepo`: `indexOf(":", slash + 1)` -> `indexOf(":")` | T12 (registry port) |
| M2 | `imageRepo`: drop the `split("@")` | T12 (digest) |
| M3 | `shaTag`: back to `split(":")[0]` | T12's shaTag case |
| M3b | `latestTag`: back to `split(":")[0]` | T12's latestTag case |
| M4 | `selectImagesToPrune`: back to `split(":")[0]` | T12's prune case |
| M5 | `buildCreateSpec`: route `tmpfs` Mounts into `binds` as before | T10a (and T10f: a `:/tmp:rw` bind appears) |
| M6 | `buildCreateSpec`: drop the `...carried` spread | T10b, T10f |
| M7 | remove `LogConfig` from `CARRIED_HOST_CONFIG_KEYS` | T10b2, T10f |
| M7b | remove `Privileged` from `CARRIED_HOST_CONFIG_KEYS` | T10b2 |
| M8 | `buildCreateSpec`: carry `Entrypoint` too | T10c |
| M9 | `buildCreateSpec`: delete the unknown-mount warn | T10d |
| M10 | `buildCreateSpec`: delete the other-networks warn | T10e |
| M10b | `buildCreateSpec`: delete the port-bindings warn | T10e2 |
| M10c | `buildCreateSpec`: drop the `bridge`-under-`default` exclusion | T10e-bridge |
| M11 | `redeploy()`: move `clearMarker()` back to the top | T14 (`markerAtSweep` undefined) |
| M12 | `redeploy()`: delete the `clearMarker()` before the create | T14 (`markerAtCreate` defined) |
| M13 | `awaitRetirementFailure`: never inspect (marker only) | T13 (stalled at the deadline, > 1 s) |
| M14 | `awaitRetirementFailure`: treat an inspect throw as `died` | T13b |
| M15 | `awaitRetirementFailure`: `exited`/`dead` -> any status with `!Running` | T13d (`created` reported as died) |
| M18 | `awaitRetirementFailure`: read the marker BEFORE the inspect | T13c (the generic died message replaces the marker's reason) |
| M29 | `awaitRetirementFailure`: the inspect's timeout -> a flat `60_000` | T13e (the wait outlives a 60 ms deadline by a minute) |
| M30 | `awaitRetirementFailure`: `catch { }` -> `catch { continue; }` (skip the marker read when the inspect throws) | T13f |
| M21 | `buildCreateSpec`: emit `Tmpfs` always (`{}` for plain SELF) | T10a (plain SELF: `Tmpfs` must be undefined) |
| M22 | `buildCreateSpec`: drop the `!== null` filter on carried keys | T10b (the `CapAdd: null` case) |
| M16a/b | `stepAside`: delete one `runExitHooks()` | T-note1 (that path) |
| M17 | `finishProbation`: put the "— completing the swap" suffix back | T-note2 |

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #491-10: tmpfs no longer breaks the create; the listed HostConfig keys and `StopTimeout` are carried; the image-merged Config keys are not; what is dropped is named | 1, 2a, 2c | T10a, T10b, T10b2, T10c, T10d, T10e, T10e-bridge, T10e2, T10f | M5-M10c, M21, M22 |
| #491-11: declined in writing; the stale comment and the window documented | 3 | lens-B audit of the texts | n/a |
| #491-12: registry ports and digests parse | 2b | T12 | M1-M4, M3b |
| #491-13: a replacement that dies after `ready` is `failed` within a poll with the reason; the marker's own reason still wins; a throwing inspect and `created` are not verdicts; the inspect is bounded by the time left; the marker is read through a daemon outage | 2e, 2f | T13, T13b, T13c, T13d, T13e, T13f | M13, M14, M15, M18, M29, M30 |
| #491-14: the marker is cleared after the sweep, before the create | 2d | T14 | M11, M12 |
| note 1: `stepAside`'s exits run the exit hooks | 2h | T-note1 | M16a/b |
| note 2: `finishProbation` no longer announces the swap | 2g | T-note2 | M17 |
| (break outside the diff) the existing inspect-count test | 4 | `:2053-2066` with `deadlineMs: 0` | n/a |

### Verification (worktree root; paste real output in the PR)

```bash
bun install --frozen-lockfile
cd ops/admin && bun install --frozen-lockfile && cd ../..
bun run check
bunx tsc --noEmit -p ops/tsconfig.json
cd ops/admin && bun run check && cd ../..
bun test src/redeploy.test.ts src/docker.test.ts src/handoff.test.ts src/index.test.ts test/stateGuard.test.ts
bun test --randomize src/redeploy.test.ts
bun test
```

- T13/T14 drive the real `redeploy()` through the harness and write the marker file under `BOT_DATA_DIR`; the
  describe's `afterEach` already clears it and resets restart state.
- Unverifiable here and named as such in the PR: the create API accepting each carried key and the tmpfs shapes
  against a real daemon (the fields are copied from Docker's own inspect of a compose-made container, which is the
  shape the create API documents); the on-daemon demonstration is #547/#548's operator step on nucbox.

### Acceptance to paste per issue

- **#491:** T12, the T10 set, T13-T13f, T14 pass lines; M1, M5, M6, M7b, M11, M12, M13, M18, M29, M30 failing output; the item-11
  decline with Decision 2's reasons; the new `buildCreateSpec` docstring paragraph; the note on the existing
  test's `deadlineMs: 0`.

### PR

- Title: `fix(redeploy): carry the create settings compose set, parse registry ports and digests, notice a replacement that dies after ready, and clear the marker before the create (#491)`.
- Body: one line per item (item 11 as declined, with the reasons), the decisions (including what is deliberately
  not carried and why), the typecheck + test output, the mutation table, the unverified line about a real daemon.
  End with `Closes #491.`
- After merge: tick #491 on #525 (byte-exact; the body is CRLF).

### Out of scope, on purpose

- Joining extra networks after create; carrying published ports (both warned instead).
- Mirroring the `oldImageEnv` fix for `Healthcheck`/`StopSignal`/`WorkingDir` (needs the old image's config).
- Moving the service alias to the takeover (Decision 2).
- Wholesale `HostConfig` copying.
