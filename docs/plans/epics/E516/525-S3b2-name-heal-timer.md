<!-- Plan for sub-epic #525 of Epic #516 (Rackbops/rackbops-discord-bot), bundle S3b-2: the replacement's name and
the verify timer. Written by the orchestrating session on 2026-10-16 against `main` @ `cccd683`; audited read-only
against that tree before it was committed (11 findings, all applied: the leftover check split into a pre-build
string check and a post-build inspect, the failure-path cleanup made non-forced where no id is known). Every
file:line below was read from that tree; the implementer re-reads each one on the tree it works from (which will
have S1 and S3a merged, so `src/redeploy.ts` lines below `:294` and `src/index.ts` lines below `:130` WILL have
moved) and corrects any that moved. -->

## Implementation plan -- #525 bundle S3b-2: a `-next` name converges, the leftover sweep never kills a live bot, the verify timer starts at the top

Children: **#547**, **#492 items 15 and 16** (closes #492; item 15 also closes **#494 item 13**, which bundle B2
closed by reference to #492), **#490 item 8**. One PR. Behaviour changes on the boot path and in
`redeploy()`, so the **three-reviewer gate** applies: you plus two read-only adversarial reviewers, up to
four rounds; every changed line mutation-tested in a scratch worktree.

**Prerequisites: S1 and S3a merged** (hard). S1 rewrites `redeploy()`'s verdict block, `RedeployResult`
(every failure return carries `replacement`) and the `redeploy — cleanup always runs` harness this bundle
adds to; S3a moves the rename into `completeTakeOver`, which this bundle's heal must agree with, and
rewrites the `CONTEXT.md` rows, the `resolveBootMode` docstring and the state-table rows this bundle edits
again. Branch from `origin/main` only once both are in (ask the orchestrator if unsure). S3b-1 (`ops/`
only) is independent in code; it shares `ops/README.md` and the state table in prose, and whichever lands
second rebases those onto the first's wording.

### What is wrong, verified at `cccd683`

- **A live bot named `<name>-next` never converges** (#547). After S3a, the rename happens in
  `completeTakeOver` after probation; it can still fail (a rename error after a successful removal, a
  crash or reboot between the two), and the standby boot path that would retry it needs the original to
  still EXIST (`resolveBootMode`, `src/redeploy.ts:731`: a 404 is `normal`). A `normal` boot never renames.
  The bot then runs under `<name>-next` for good: `bot-ops.sh status`/`logs` show a stopped bot
  (`ops/bot-ops.sh:623`, `:655`), after S3b-1 the guard refuses every mutation with the "finishing"
  message, and the next swap names its replacement `<name>-next-next` (`replacementName`,
  `src/redeploy.ts:58-60`, `:249`).
- **The leftover sweep and the failure cleanup force-remove whatever holds `<name>-next`, running or
  not** (#492 item 16): `removeContainer(name, true)` at `:263` before the create, and
  `removeContainer(replacementId ?? name, true)` at `:286` after a failed create. With the name derived
  from the live bot's own name, a live `<name>-next` bot that starts a swap targets `<name>-next-next`;
  with the name derived from the base (the fix below) it would target ITSELF. And a container that takes
  the name during the up-to-15-minute build makes `createContainer` fail with a 409, after which the
  by-name cleanup at `:286` force-kills it (state table, Interactions item 5, `:243-250`). Both paths must
  refuse a running holder and never force-remove by name.
- **The standby's 90 s verify budget starts late** (#492 item 15 / #494 item 13): `verifyTimer` is
  created at `src/index.ts:488-500`, after `loadPluginIndex` (`:70`, bounded at 5 s), `readPluginState`
  (`:80`) and `resolveBootMode` (`:130`, bounded at 10 s). The original's `HANDOFF_DEADLINE_MS` (120 s,
  `src/handoff.ts:27`) runs from `startContainer`; `handoff.ts:29-31` says the 90 s is "inside" it, but
  worst-case wall time to the replacement's own `failed` marker is pre-work + 90 s, so a slow boot lets the
  original time out first and the reason is lost. Also unpinned: that `redeploy()` never stops or removes
  its own id (today only the stub's `unstubbed daemon call` throw would catch a self-stop, and a self-remove
  is absorbed by the `DELETE` catch-all at `redeploy.test.ts:841`), and the three deadline constants' values.
- **`README.md:62` says the swap's quiesce is "worst case around 10 minutes"**; the phases sum to about
  11 (#490 item 8, the reviewer's arithmetic: remove + create + start 3 min, the verify poll 2 + 1 for the
  call in flight, the retirement wait 3, the pre-removal inspect + remove 2).

### Decisions (defaults, named so the gate can contest them)

1. **`-next` is a reserved suffix.** `baseName(inspectedName)` strips any trailing `-next` repeats
   (`/(?:-next)+$/`) from the canonical name; `replacementName` becomes `${baseName(n)}-next`. A bot whose
   own name ends in `-next` cannot self-update: `redeploy()` refuses on a pure string check of
   `self.Name`, before any build and with no extra daemon call, and its message says what to do (decision
   4). Documented in `replacementName`'s docstring, `CONTEXT.md`, and beside `container_name` in
   `docker-compose.yml:31` (the compose file already uses `-admin` and `-tunnel` suffixes at `:73`, `:133`).
2. **The heal runs at a `normal` boot of a container that was CREATED as a standby** (`bootMode(env)` is
   `standby`, i.e. `HANDOFF_FROM` is set, and `resolveBootMode` said `normal`). An ordinary boot of a
   compose-created container still never touches the socket (`src/index.ts:128-129`, pinned by
   `redeploy.test.ts:1213`). The costs of that gate: a compose-created container an operator renames to
   `*-next` by hand is not healed, so #547's on-daemon acceptance bullet is run on an instance that has
   self-updated at least once (its env has `HANDOFF_FROM`), and the limit is stated on #547; and every
   restart of a swapped-in container pays one bounded `inspectSelf` (10 s cap), because `HANDOFF_FROM`
   never clears — say so in the `index.ts` comment.
3. **The heal is `healOwnName()` in `src/redeploy.ts`,** next to `resolveBootMode`, bounded like it
   (one `withTimeout` of `RESOLVE_BOOT_MODE_TIMEOUT_MS` around the whole thing) and never throwing: inspect
   self; if the name has no `-next` suffix, return `"canonical"`; else inspect the base name: absent →
   rename self, return `"renamed"`; present and running → log an error naming both containers, return
   `"occupied"` (two live bots were created by hand; this bot does not exit: an exit under
   `unless-stopped` would be a login-looping restart, and S3b-1's guard closes the path that creates the
   state); present, not running, and the SAME compose project and service labels as self
   (`com.docker.compose.project`, `com.docker.compose.service`, both present on both) → remove it (not
   forced: it is not running), rename self, return `"renamed"`; present, not running, other labels → log,
   return `"occupied"`. Any daemon error or the timeout → log, return `"unknown"`. The boot continues on
   every outcome. The stopped same-service holder this serves is a DIFFERENT container from the swap's
   own original: that one is `HANDOFF_FROM` itself, and while it exists `resolveBootMode` stays `standby`,
   so `completeTakeOver` handles it, never this heal. The docstring says so.
4. **The heal does not run at the start of `redeploy()`.** A swap started from a bot named `-next` is
   REFUSED by the string check instead, with a message that branches on `HANDOFF_FROM`: set → "this bot is
   still named `<name>` (the previous swap's rename never landed): `docker restart <name>` heals the name
   at boot (#547); the automatic check will not retry this sha, so run `/update` again afterwards" (a
   refusal leaves `attemptedUpdateToSha` set, `src/update.ts:300`, and `bot-ops.sh restart` is refused by
   S3b-1's guard in this very state, so the docker command is the one that works); unset → "this
   container's name ends in `-next`, which the self-update reserves for its replacement: give it another
   `container_name` and recreate it". One refusal path, no second rename to keep in agreement with
   `completeTakeOver`.
5. **The leftover check is a post-build inspect, outside the quiesce, and nothing is ever force-removed
   by name.** After the build and the old-image inspect, before `beginHandoff`:
   `tryInspectContainer(replacementName)`; running → return `{ error, replacement: "none" }` (nothing
   quiesced, nothing created); non-running → remember its `Id`; absent → nothing to sweep. The sweep after
   `beginHandoff` removes BY ID and NOT forced, only when a leftover was seen: a leftover that was started
   in the milliseconds since is a 409, which the existing catch turns into a reported failure, never a
   kill. The failure-path cleanup at `:286` becomes `replacementId ? removeContainer(replacementId, true)
   : removeContainer(name)`: with an id, the start may have taken effect and force is still right (the
   `:904-909` argument); with no id the container was never started, so a plain `DELETE` removes a
   `created` orphan and gets a 409 (logged, not fatal) from a running holder someone else started during
   the build. The pre-build inspect that the first draft of this plan had is gone: it widened the window
   between "seen stopped" and "removed" to the whole build. The quiesce arithmetic is unchanged (the
   inspect sits outside it; the one removal call exists only when a leftover was found).
6. **The verify timer arms at module top from the RAW env** (`bootMode(process.env) === "standby"`),
   before the first `await` (every import has evaluated by then), and is cleared right after
   `resolveBootMode` when that says `normal`. The 90 s then runs from module top; the margin to the
   original's 120 s is 30 s minus the container's own start latency and import time, which the comments
   state. `VERIFY_DEADLINE_MS` stays 90 s.
7. **The constants are pinned in `src/handoff.test.ts`:** the exact values (the README arithmetic and the
   state table cite them), and `VERIFY < HANDOFF` by at least 20 s. No relation is asserted for
   `RETIREMENT_DEADLINE_MS` beyond its value: nothing in `handoff.ts:33-44` or #492 asks for one. And
   `redeploy()` never touching its own id is pinned by an `afterEach` in the cleanup harness, so every
   existing and future test in that describe asserts it.
8. **The README's figure becomes "about 11 minutes", with the phases listed**, so the next change to a
   bound edits a line instead of re-deriving a sum, and it says the leftover removal happens only when
   there is one (the typical worst case is 10).

### Step 1 -- `src/redeploy.ts`

- Naming (`:47-60`): add `export function baseName(inspectedName: string): string` (strip the slash, then
  `/(?:-next)+$/`); `replacementName` returns `${baseName(inspectedName)}-next`; docstring (`:52-57`):
  the suffix is reserved, a drifted `<name>-next-next` folds back to `<name>-next`, and a bot that is
  itself `<name>-next` is refused by `redeploy()` rather than healed here.
- `redeploy()` (`:208-`), three edits (S1's rewrite is from `:294` down; these sit above it):
  - after `inspectSelf()` succeeds (`:218`), the string check:

    ```ts
    const name = replacementName(self.Name);
    if (canonicalName(self.Name) !== baseName(self.Name)) {
      // #547/#492: a bot that is itself `<name>-next` must not sweep or create under that name. Refused
      // here, before anything is built, on the name alone — no daemon call.
      const current = canonicalName(self.Name);
      return {
        error: process.env[HANDOFF_FROM_ENV]
          ? `this bot is still named ${current} (the previous swap's rename never landed): docker restart ${current} heals the name at boot (#547); the automatic check will not retry this sha, so run /update again afterwards`
          : `this container's name ends in -next, which the self-update reserves for its replacement: give it another container_name and recreate it`,
        replacement: "none",
      };
    }
    ```

    and delete the `const name = replacementName(self.Name);` at `:249`.
  - after the old-image inspect (`:245-247`) and before `beginHandoff` (`:260`):

    ```ts
    // #492: whatever holds the replacement's name is inspected here, after the build (so a holder that
    // appeared during it is seen) and before the quiesce. A RUNNING holder is never swept; a stopped one is
    // removed by id below, un-forced, so one that starts in between is a 409 and a reported failure, not a kill.
    let leftover: ContainerInspect | undefined;
    try {
      leftover = await tryInspectContainer(name);
    } catch (err) {
      return { error: `could not check for a leftover ${name}: ${(err as Error).message}`, replacement: "none" };
    }
    if (leftover?.State.Running) {
      return { error: `a running container already holds ${name} — not sweeping a live container; check docker ps`, replacement: "none" };
    }
    ```

    The sweep at `:263` becomes `if (leftover) await removeContainer(leftover.Id); // un-forced, by id (#492)`.
  - the cleanup at `:286`: `await (replacementId ? removeContainer(replacementId, true) : removeContainer(name)).catch(...)`,
    with the comment at `:270-285` rewritten: force only with an id (the start may have taken effect);
    by name, un-forced, because with no id the container was never started, so the orphan is `created`
    and a running holder is someone else's (409, logged).
  - the docstring at `:200-207` gains one sentence on the two refusals.
- `healOwnName` (new, after `resolveBootMode`, `:735`):

  ```ts
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
   * is free, or held by a stopped container of this compose service; leaves a RUNNING holder alone and
   * says so. The swap's own stopped original is never that holder: it is `HANDOFF_FROM` itself, and while
   * it exists the boot is `standby` and `completeTakeOver` converges it. Bounded and best-effort: the boot
   * continues on every outcome.
   */
  export async function healOwnName(deps: HealDeps = {}, timeoutMs = RESOLVE_BOOT_MODE_TIMEOUT_MS): Promise<HealOutcome> {
    const log = deps.log ?? console;
    const run = async (): Promise<HealOutcome> => {
      const self = await (deps.inspectSelf ?? inspectSelf)();
      const current = canonicalName(self.Name);
      const base = baseName(self.Name);
      if (current === base) return "canonical";
      const holder = await (deps.inspect ?? tryInspectContainer)(base);
      if (holder) {
        if (holder.State.Running) {
          log.error(`[handoff] this bot is ${current} but ${base} is running (${holder.Id.slice(0, 12)}) — two bots on one token; leaving both alone, see ops/README.md`);
          return "occupied";
        }
        if (!sameComposeService(self, holder)) {
          log.warn(`[handoff] this bot is ${current}; ${base} is held by a stopped container of another service (${holder.Id.slice(0, 12)}) — not touching it`);
          return "occupied";
        }
        await (deps.remove ?? removeContainer)(holder.Id);
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

  function sameComposeService(a: ContainerInspect, b: ContainerInspect): boolean {
    const project = "com.docker.compose.project";
    const service = "com.docker.compose.service";
    return Boolean(a.Config.Labels[project]) && a.Config.Labels[project] === b.Config.Labels[project]
      && Boolean(a.Config.Labels[service]) && a.Config.Labels[service] === b.Config.Labels[service];
  }
  ```

  `Config.Labels` is a required field of `ContainerInspect` (`docker.ts:64`), so no `?? {}`. `withTimeout`
  and `RESOLVE_BOOT_MODE_TIMEOUT_MS` are module-private (`:676-692`) and usable here; `renameContainer` is
  imported after S3a (`takeName`); check `tsc` for unused imports either way. Also edit the comments at
  `:674-675` (the 10 s bound now runs INSIDE the 90 s budget, not before it) and S3a's rewrite of the
  `resolveBootMode` docstring (`:706-713` at `cccd683`): add that a `normal` boot of a swapped-in container
  heals its own name.

### Step 2 -- `src/index.ts` and `src/handoff.ts`

- Move `:485-500` (the comment and `const verifyTimer = …`) to just before `:68` ("The boot-time half of
  plugin support"), i.e. after the last import and before the first top-level `await`. The condition
  becomes `bootMode(process.env) === "standby"` (import `bootMode` from `./handoff`, beside
  `VERIFY_DEADLINE_MS`; `config` and `writeMarker` are imported by `:16`). Extend its comment: armed before
  any boot await so the 90 s counts from module top (#492/#494); a raw standby the daemon later downgrades
  is cleared below.
- After `const mode = await resolveBootMode(process.env);` (`:130`; after S3a there is a `detectRollback`
  line right after it — keep that first):

  ```ts
  // A raw standby the daemon downgraded (the original is confirmed gone) has nothing to verify against.
  if (mode === "normal") clearTimeout(verifyTimer);
  // #547: a swapped-in container whose rename never landed converges here; an ordinary boot (no
  // HANDOFF_FROM) still never touches the socket. Every restart of a swapped-in container pays this one
  // bounded inspect, because HANDOFF_FROM never clears from its env.
  if (mode === "normal" && bootMode(process.env) === "standby") await healOwnName();
  ```

  Import `healOwnName` beside `resolveBootMode` (`:17`). The `createReadyHandler` call's
  `clearVerifyTimer` (`:144`) is unchanged (a `clearTimeout` on an already-cleared timer is a no-op).
- `src/handoff.ts:29-31` (`VERIFY_DEADLINE_MS`'s comment): state the arithmetic: armed at `index.ts`'s
  module top, so it counts from there; the original's `HANDOFF_DEADLINE_MS` counts from `startContainer`,
  so the margin is 30 s less the container's start and import time; `resolveBootMode`'s 10 s bound and
  `loadPluginIndex`'s 5 s bound now run inside the 90 s, not before it. (S1 edits `:110` down; S3a adds
  after `:24`; this is the only S3b-2 edit in the file.)

### Step 3 -- docs, in the same PR

- `README.md:62`: "worst case around 10 minutes, since each daemon call is capped at 60s, the verify poll
  at 2 minutes plus the bounded call in flight when it expires, and the retirement wait below at 3" →
  "worst case about 11 minutes: removing a leftover when there is one, creating and starting the
  replacement (one bounded daemon call each, 60 s), the verify poll (2 minutes, plus the one bounded call
  in flight when it expires), the retirement wait below (3 minutes), and the final inspect and removal of a
  replacement that failed (two more bounded calls); without a leftover, about 10". `:65` is S3a's edit;
  leave it.
- `ops/README.md`: beside S3b-1's runbook paragraph (or S3a's sentence at `:413-414` if S3b-1 is not in
  yet): "since #547 `docker restart <name>-next` takes the canonical name back at boot when it is free or
  held by a stopped container of the same service; a bot named `-next` refuses to self-update until then".
- `docker-compose.yml:31`: a comment beside `container_name`: names ending in `-next` are reserved for the
  self-update's replacement.
- `CONTEXT.md` (one writer per row; after S1 and S3a): the `src/redeploy.ts` row (grep
  `replacementName`): `baseName`, the reserved suffix, the string refusal, the post-build leftover inspect
  and the un-forced sweep, `healOwnName`; the `src/index.ts` row (grep `verifyTimer` or `standby`): the
  timer is armed at module top from the raw env and cleared on a downgrade; `healOwnName` after
  `resolveBootMode`; the `src/redeploy.test.ts` row: the new describes; the gotcha S3a rewrote (grep
  `A stopped-but-not-removed original stays`): add that a `normal` boot of a swapped-in container heals its
  name (#547); a new gotcha under the swap section: "**`-next` is a reserved suffix, and nothing is ever
  force-removed by name** (#492/#547)" with the refusal messages.
- `docs/plans/epics/E516/525-handoff-state-table.md`: rows 22 and 23 ("Recovered by": the next boot's
  `healOwnName` when the original is gone; `completeTakeOver`'s retry when the corpse remains),
  Interactions item 5 (`:243-250`: the hazard it describes is closed by the string check and the un-forced
  by-name cleanup), the #547 line under "Children filed", the #492 items. Row 13 is S3b-1's.

### Step 4 -- tests

`src/redeploy.test.ts`:

| # | Test | Pins |
|---|---|---|
| T1 | `naming` (`:52-64`): "baseName strips the slash and any -next suffixes" | `baseName("/warbandeer-discord-next")` → `warbandeer-discord`; `"/warbandeer-discord-next-next"` → `warbandeer-discord`; `"/warbandeer-discord"` → `warbandeer-discord`; `"/nextgen-bot"` → `nextgen-bot` |
| T2 | "the replacement's name is derived from the base, so a drifted name folds back" | `replacementName("/warbandeer-discord-next")` → `warbandeer-discord-next`; `replacementName("/warbandeer-discord-next-next")` → `warbandeer-discord-next` |
| T3 | `redeploy — cleanup always runs` harness (`:783-844`): add `self?: ContainerInspect` (default `SELF`) for the self-inspect at `:814`, `leftover?: () => Response` answering `GET /containers/warbandeer-discord-next/json` (default 404), a branch for `DELETE /containers/<LEFTOVER_ID>` that samples `pendingAt.sweep = restartPending()` and answers 204, and `touchedSelf = true` on `POST /containers/<SELF_ID or HOSTNAME>/stop` or `DELETE /containers/<SELF_ID or HOSTNAME>` (before the `:841` catch-all); the existing `afterEach` (`:768-773`) gets `expect(touchedSelf).toBe(false)` as its LAST line, after `globalThis.fetch = realFetch` and `resetForTest()` (a failing assertion placed first would skip the restores and leak into the next test; probed on Bun 1.4.2) (#492 item 15) | every test in the describe |
| T4 | "a bot named -next refuses before the build, on its name alone, and says docker restart heals it" (`self: { ...SELF, Name: "/warbandeer-discord-next" }`, `HANDOFF_FROM` set in env) | result `error` contains `docker restart warbandeer-discord-next` and `run /update again`; `replacement === "none"`; no `/build`, no `GET /containers/warbandeer-discord-next/json`; `restartPending()` never true |
| T4b | "a compose-created bot named -next is told to rename, not restart" (same self, `HANDOFF_FROM` unset) | `error` contains `container_name`; no `/build` |
| T5 | "a running holder of <name>-next after the build is refused before the quiesce" | `leftover` → 200 `{ Id: "f".repeat(64), State: { Running: true } }`; `/build` called; `error` contains `a running container already holds`; `replacement === "none"`; no `/containers/create`; `pendingAt.create` undefined; `restartPending()` false |
| T6 | "a stopped leftover is removed by id, un-forced, after beginHandoff and before the create" | `leftover` → 200 `{ Id: LEFTOVER_ID, State: { Running: false } }`; `DELETE /containers/<LEFTOVER_ID>` present with no `force` param, after `/build` and before `/containers/create`; `pendingAt.sweep === true` |
| T7 | "no leftover means no DELETE before the create" | no `DELETE /containers/warbandeer-discord-next` and no `DELETE /containers/<LEFTOVER_ID>` |
| T8 | "a leftover inspect that errors ends the redeploy before the quiesce, with the reason" | `leftover` → 500; `error` contains `could not check for a leftover`; no `/containers/create`; `restartPending()` false |
| T9 | the `:888` create-timeout test: the comment at `:899` and the `:903` count change to ONE by-name `DELETE` (the post-failure cleanup), and `:904-909` assert that DELETE carries NO `force` (with no id the container was never started); new sibling "a start that fails cleans up the created replacement by id, forcibly" if `:975` does not already pin `force=1` on the by-id DELETE (read it; extend it if it does) | `byName.length === 1`; `searchParams.get("force") === null`; the by-id cleanup `force === "1"` |
| T10 | new `describe("healOwnName")` with injected deps: "a canonical name is left alone, with one inspect" | self `/warbandeer-discord` → `"canonical"`; `inspect` not called; no rename |
| T11 | "a free base name is taken" | self `/warbandeer-discord-next`; `inspect` → undefined → rename `(SELF_ID, "warbandeer-discord")`; `"renamed"`; log contains `took the name warbandeer-discord` |
| T12 | "a stopped holder of the same compose service is removed, un-forced, then the name is taken" | holder `{ Id: H, State.Running: false, Labels: same project/service }` → `remove(H)` then rename; `"renamed"` |
| T13 | "a running holder is left alone and logged as two bots" | holder running → no remove, no rename; `"occupied"`; `log.error` once with `two bots` |
| T14 | "a stopped holder of another service is left alone" | labels differ (or absent) → no remove, no rename; `"occupied"` |
| T15 | "a daemon error is logged and the boot continues" | `inspectSelf` throws → `"unknown"`; `log.warn` once |
| T16 | "a hung daemon is bounded" | `inspect` never resolves; `timeoutMs: 20` → `"unknown"` within 200 ms |
| T17 | "a drifted -next-next name folds back to the base in one hop" | self `/warbandeer-discord-next-next`, base free → rename to `warbandeer-discord` |

`src/handoff.test.ts` (new describe "the deadlines, #492"; add `VERIFY_DEADLINE_MS` and
`RETIREMENT_DEADLINE_MS` to the import at `:2-10`):

| # | Test | Pins |
|---|---|---|
| T18 | "the replacement's verify budget sits inside the original's handoff deadline with margin" | `VERIFY_DEADLINE_MS === 90_000`; `HANDOFF_DEADLINE_MS === 120_000`; `HANDOFF - VERIFY >= 20_000` |
| T19 | "the retirement wait is the documented three minutes" | `RETIREMENT_DEADLINE_MS === 180_000` (the README's arithmetic and the state table cite it) |

`src/index.test.ts` (source pins, as the file's other boot-order tests, `:484-496`):

| # | Test | Pins |
|---|---|---|
| T20 | "the verify timer is armed from the raw env before the first boot await (#492/#494)" | `indexOf("const verifyTimer =") < indexOf("await loadPluginIndex(")`; `toMatch(/const verifyTimer =\s*\n\s*bootMode\(process\.env\) === "standby"/)`; `(source.match(/const verifyTimer =/g)).length === 1` |
| T21 | "a daemon-downgraded standby clears the timer and heals its name, right after resolveBootMode" | the slice after `await resolveBootMode(process.env);` up to `client.once(` contains `if (mode === "normal") clearTimeout(verifyTimer);` and `if (mode === "normal" && bootMode(process.env) === "standby") await healOwnName();`; `healOwnName(` count 1 |

### Coverage table

| Outcome (bullet) | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| #547: a `-next` bot whose base name is free or a same-service stopped holder converges at a normal boot | 1, 2 | T11, T12, T17, T21 | M1: delete the `healOwnName()` call in `index.ts` (T21); M2: delete the rename in `healOwnName` (T11/T17); M3: skip the removal (T12's `remove` never called) |
| #547: a running holder or another service's container is never touched | 1 | T13, T14 | M4: drop the `State.Running` check; M5: drop `sameComposeService` |
| #547: the heal never breaks the boot | 1 | T15, T16 | M6: delete the `try`/`catch`; M7: drop `withTimeout` |
| #547 on a daemon | -- | manual, operator step (decision 2): `docker rename <name> <name>-next` on an instance with `HANDOFF_FROM` in its env, `docker restart <name>-next`, `docker ps -a --filter name='^/<name>' --format '{{.Names}} {{.State}}'` prints `<name> running`; pasted on #547 by the orchestrator | -- |
| #492-16: the name is derived from the base | 1 | T1, T2 | M8: `replacementName` back to `canonicalName(n) + "-next"` |
| #492-16: a `-next` bot is refused on its name, before any build | 1 | T4, T4b | M9: delete the string check (T4: `/build` appears; T4b red) |
| #492-16: a running holder is refused after the build, nothing quiesced | 1 | T5, T8 | M10: drop the `State.Running` refusal (T5: `/containers/create` appears); M11: swallow the inspect error (T8) |
| #492-16: nothing is force-removed by name; a leftover is swept by id, un-forced | 1 | T6, T7, T9 | M12: restore `removeContainer(name, true)` unconditionally before the create (T7 and the `:888` count red); M13: pass `true` to the by-id sweep (T6); M14: force the by-name cleanup (T9's `force === null`) |
| #492-15: `redeploy()` never touches its own id | 4 | T3 (afterEach) | M15: add `await removeContainer(self.Id, true)` after `inspectSelf()` in `redeploy()` — absorbed by the stub's `DELETE` catch-all, so only the `afterEach` can catch it (a self-`stopContainer` would already be caught by the `unstubbed` throw, which is the incidental mechanism #492 complains about) |
| #492-15 / #494-13: the verify budget counts from module top | 2 | T20 | M16: move the timer back below `resolveBootMode` |
| #492-15: a downgraded standby clears it | 2 | T21 | M17: drop the `clearTimeout` line |
| #492-15: the deadline values are pinned | 2 | T18, T19 | M18: `RETIREMENT_DEADLINE_MS = 60_000`; M19: `VERIFY_DEADLINE_MS = 110_000` |
| #490-8: the README's figure matches the bounds | 3 | manual: reviewer B sums the phases from `docker.ts`/`handoff.ts` constants | -- |
| the docs say what the code does | 3 | manual: reviewer B, every edited sentence | -- |

Run each mutation in a scratch worktree (`git worktree add --detach <path> <sha>`), never in the tree a
reviewer or the suite is reading. Paste the red test's name per row in the PR.

### Checks, gate, PR

- `bun run check`; `bunx tsc --noEmit -p ops/tsconfig.json`; `bun run check` inside `ops/admin/`;
  `bun test` from the root, then `bun test --randomize` once. CI's Linux run is the evidence for the
  `ops/*` suites that skip here.
- Gate: reviewer A on correctness (the heal's six outcomes against `resolveBootMode`'s,
  `detectRollback`'s and `completeTakeOver`'s; a boot where the daemon is hung; a `-next` bot starting a
  swap; a holder that appears during the build, and one that starts between the post-build inspect and the
  sweep; the create-timeout orphan with the un-forced by-name cleanup; the timer at module top on a
  normal boot with a stale `HANDOFF_FROM` and a hung daemon; the afterEach pin's reach); reviewer B on
  claims-vs-code (the coverage table, every edited comment, README/CONTEXT/ops-README/compose sentences,
  the state table rows, the README arithmetic). Both read-only, both handed the merged tree, #547, #492,
  #490, #494 and the state table.
- Branch `fix/525-S3b2-name-heal-timer`; title
  `fix(redeploy): heal a -next name at boot, never force-remove by name, arm the verify timer first (#547, #492, #490)`.
  Body: `Closes #547` (its on-daemon bullet named as the orchestrator's operator step, with the
  `HANDOFF_FROM` limit), `Closes #492` (items 15 and 16; item 15 also closes #494's item 13, which B2
  pointed here — say so), `Part of #490 (item 8 lands here; items 5/7/9 in S3a, item 2 in S3b-1)`,
  `Part of #525`; the pasted checks; the mutation rows; the gate's rounds; decisions 1-8 as assumptions
  taken (decision 5's un-forced cleanup in its own paragraph). After the merge, comment on #494 that item
  13 is closed by this PR. Do not merge.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot. Work in a NEW worktree cut from origin/main AFTER S1 and S3a are merged (ask the orchestrator if unsure), never the shared checkout:
  git -C S:\Repos\rackbops-discord-bot fetch origin && git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-525-S3b2 origin/main -b fix/525-S3b2-name-heal-timer
Issues: Rackbops/rackbops-discord-bot #547 #492 #490 #494 (sub-epic #525 of Epic #516). Read their bodies and comments first, and rows 13, 22, 23 and Interactions item 5 of docs/plans/epics/E516/525-handoff-state-table.md.
Plan: docs/plans/epics/E516/525-S3b2-name-heal-timer.md on branch claude/525-plans:
  git -C S:\Repos\rackbops-discord-bot show origin/claude/525-plans:docs/plans/epics/E516/525-S3b2-name-heal-timer.md
The plan's line numbers are from main @ cccd683; S1 and S3a moved redeploy.ts and index.ts below the lines they edit, so re-anchor every cite on your tree before editing. Behaviour changes on the boot path: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Every mutation in a scratch worktree. Scratch files: task-unique names (pr-body-525S3b2.md, commit-msg-525S3b2.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds and any deviation. Do not merge.
```
