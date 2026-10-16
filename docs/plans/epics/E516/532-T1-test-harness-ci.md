<!-- Plan for #532 bundle T1 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #532): the test harness and CI
follow-ups -- #403, #461, #462 and #463 (every child of the sub-epic), plus the one fix-once it names: the CI-side guard
`posthoc-1-2` (#514, #529) asks for, so a tool-dependent suite cannot skip green on CI. Written by the orchestrating
session on 2026-10-16 against main `056bc24`; every `file:line` below was read at that sha. Audited read-only before it
was committed (a Sonnet agent, 180 tool calls, with the steps applied to a scratch copy and 28 mutants run); every
finding was applied: the Windows "held dir" case needs a process whose cwd is inside the dir, not an open handle (an
open handle does not make `rmSync` throw on Windows under Bun 1.4.2); the `isDir` read must sit inside the same
ENOENT-tolerant try as `mtimeOf` or a concurrent preload's remove fails every run (18 of 24 child runs under a 4-way
stress, against 0 with the fix); the remove-failure catch belongs in `sweep.ts` so a unit test guards it on every OS
and a failed removal is never logged as swept; the planted dirs go in a private temp dir (other sessions' preloads
sweep the shared one); every scrubbed key gets a bogus value in the child and the fixture deep-equals `config` to a
clean resolve (12 single-key drops survived the first design); `PLUGIN_REGISTRY_URL` joins the list (read at import,
`src/plugins/install.ts:32`); the `HTTP_PORT=abc` manual check and two shipped comments stop being true once the scrub
lands, so they are reworded here; `CONTEXT.md`'s File Map has no `test/` rows (the Gotchas prose is edited instead);
the `install.test.ts` anchor was one line early; #403's premise is corrected (the three keep-side mutants are caught
today, by accident, as an unnamed ENOENT in another suite). Round 2 (the same agent, the rewrite rebuilt from scratch
and the whole suite run: 3,403 pass, the 4-way sweep stress 0/24 failures twice, all 16 single-key drops killed)
found one blocker -- the manual check's temporary throw must be gated on the child run or it kills the parent -- and
two unpinned lines (the `swept` line's ten-name cap, now `formatSwept` with a unit test; the no-pid short-circuit),
applied. The implementer re-reads each anchor on the tree it works from. Nothing in flight touches these files (D1a edits `test/stateLeaks.ts`'s `updateLeaks` and
`test/stateGuard.test.ts`'s update-module cases, which this bundle does not; if D1a lands first, merge main and keep
both). -->

## Implementation plan -- #532 T1: pin the preload's real wiring, contain and tolerate the sweep, scrub ambient env, time-box and pin CI, and fix the stale test-infra text

Children: **#403** (closes), **#461** (closes: items 1, 2, 4 and 6 fixed, item 5 confirmed already true), **#462**
(closes: items 7-11), **#463** (closes: items 12 and 13 fixed, item 14's test fragility fixed and its heartbeat
declined in writing). Fix-once: **#514 item 2** (`posthoc-1-2`, the bot-ops suite green on CI without bash/jq) is
closed by reference to this PR. One PR, branch `fix/532-T1-test-harness-ci`, worktree `S:\Repos\_wt\rdb-532-T1` cut
from `origin/main` at or after `056bc24`. Behaviour changes in the preload, the sweep and CI -> the **three-reviewer
gate** applies; every changed production line mutation-tested in a scratch worktree (never the shared tree). The
branch protection on `main` requires the `checks` and `docker-build` jobs by name: both names stay.

### What is wrong, verified at `056bc24`

- **#403.** `test/setup.ts:30-38` calls `sweepStaleTestDirs` with the real seams (`mtimeOf` via `statSync`,
  `isAlive: isPidAlive`, `maxAgeMs: MAX_AGE_MS`, `remove` via `rmSync`); `test/sweep.test.ts` drives the pure function
  with fakes (`:9-24`) and the only preload-level test (`:125-131`) checks the `BOT_DATA_DIR` basename. Replace
  `isAlive` with `() => false`, or `maxAgeMs` with `0`, or `mtimeOf` with `() => 0`, and the ONLY failure is an unnamed
  `ENOENT: ... junit.xml` at `test/stateGuard.test.ts:441`: the child `bun test` that test spawns runs the mutated
  preload, which sweeps the parent's own live report dir (named with the parent's pid, `:423`). The keep side is
  guarded by accident, in another suite, with a message that points nowhere near the cause; the remove side (a dead or
  an old dir left in place) and the log line are guarded by nothing.
- **#461 item 1.** The `remove` seam is `rmSync(join(tmp, name), { recursive: true, force: true })` (`setup.ts:37`)
  on every `tmpdir()` child whose name starts with the prefix: no `lstat`, so a stray file or a link planted under the
  prefix is handled like a run's directory, and nothing says what was removed. (Measured on this box, Bun 1.4.2:
  `rmSync` does NOT follow a junction or a directory symlink on Windows -- the target survived both -- so the guard is
  defence in depth here; Linux is unmeasured.) **Item 2.** That `rmSync` is unguarded: an `EBUSY`/`EPERM` (a dead run's
  dir that an orphaned process still holds as its cwd, on Windows) throws out of the preload and every later `bun test`
  fails until the dir is removed by hand. (`mtimeOf`'s non-`ENOENT` rethrow at `sweep.ts:71` is deliberate and pinned
  at `sweep.test.ts:78-95`; it stays.) **Item 4.** `ci.yml` sets no `timeout-minutes` on either job and no `--timeout`
  on either `bun test`; a wedged test holds the runner for the 360-minute default. **Item 5.** `CONTEXT.md:426-427`
  now reads "no `ops/admin` test imports `src/`; `ops/bot-ops.test.ts` imports only `src/config` and
  `src/routing/model`, which read no data dir" -- and `ops/bot-ops.test.ts:14-15` imports exactly `resolveConfig` from
  `../src/config` and `repairRouting` from `../src/routing/model` (`src/routing/model.ts:17` imports only `./resolve`,
  which imports only `./model`), while no other `ops/**/*.ts` imports `src/`. The sentence is TRUE at `056bc24` (it was
  reworded since the review read `4ff8eef`); item 5 is confirmed and recorded, not changed. **Item 6.** `ci.yml:14`/`:16`/`:66`
  use `actions/checkout@v7` and `oven-sh/setup-bun@v2` by mutable tag, and the workflow has no `permissions` block, so
  each job runs with the repository-default `GITHUB_TOKEN`; `.github/workflows/push-notify.yml:40-65` pins its reusable
  workflow by commit with a `# main` comment (the form Renovate parses) and sets `permissions: {}`.
- **#462 item 7.** `ci.yml:37-40`: "confirmed empirically: 491 tests across 18 files ... ~19s locally"; the suite is
  3,408 tests across 53 files (about 10 minutes for one full run on this box; CI's `checks` job took 115 s on run
  38894938584). **Item 8.** `setup.ts:71-72` prime `DISCORD_TOKEN` and `ANNOUNCE_CHANNEL_ID` with `??=`, so a real
  token in the shell survives into the suite and every subprocess it spawns, and nothing clears the other keys read at
  import: `resolveConfig`'s (`src/config.ts:81-182`: `GITHUB_REPO`, `WATCHED_REPOS`, `PLUGINS`, `PLUGIN_INDEX_URL`,
  `HTTP_PORT`, `TRUSTED_PROXY_HOST`, `RELEASE_ANNOUNCE_CHANNEL_ID`, `DISCORD_SERVER_ID`, `GITHUB_TOKEN`, `GIT_SHA`,
  `BOT_BRANCH`, `AUTO_UPDATE`, `ADMIN_USER_IDS`, `REPORT_ROLE_ID`), `LOG_FORMAT` (`src/logFormat.ts:20`, read when
  `src/bootLog.ts:43-44` swaps `console.*` for the whole process) and `PLUGIN_REGISTRY_URL` (`src/plugins/install.ts:25`,
  `:32`, read at import into `REGISTRY_BASE`). `COMMAND_PREFIX` is already cleared at `:76` (#472) and
  `BOT_DOCKER_SOCKET` deleted at `:81` (#459). Tests assume the rest unset (`commands.test.ts` pushes `"999"` onto an
  empty `config.adminUserIds`; `config.gitSha` is set per test). Measured: a shell exporting
  `ADMIN_USER_IDS=1,2 GIT_SHA=abc GITHUB_TOKEN=tok LOG_FORMAT=json` (and the rest) fails 10 tests at `056bc24` that CI
  passes (all `adminUserIds`); `PLUGIN_REGISTRY_URL=http://localhost:4873` alone fails `installPlugins > downloads,
  verifies integrity, extracts, and reports the registry URL`. **Item 9.** `test/stateLeaks.ts:18-26` `settled()` races the promise against
  `setImmediate`; its own tests (`stateGuard.test.ts:37-48`) use a resolved, a rejected and a never-settling promise and
  all three pass with `queueMicrotask` in its place (other suites then fail, far from the cause -- the mutant is caught
  by accident, not by name), while a promise that settles after two or more microtask hops would read as still running.
  **Item 10.** `stateGuard.test.ts:426-441`: when the child dies before writing its JUnit report (a preload that
  throws), `readFileSync(report)` fails with a bare `ENOENT` and the child's exit code and stderr are dropped (they are
  included only on timeout, `:437-439`). Confirmed at `056bc24`: a refusing preload writes no report. **Item 11.**
  `ops/tsconfig.json:15` includes `tools/*.ts` (no such directory); `noUnusedLocals`/`noUnusedParameters` are set in the
  root `tsconfig.json:16-17` only, not in `ops/tsconfig.json` or `ops/admin/tsconfig.json`; `ops/admin/package.json` has
  no `typescript` devDependency, so its `bunx tsc` resolves the root's install (CI installs the root first,
  `ci.yml:20-25`; it printed `Version 7.0.2` from there).
- **#463 item 12.** `package.json:7` describes "DMF/reset timers, server-up announcements, addon release
  notifications" (those are plugins now: `README.md:251`, `:253`, `src/state.ts:25`); `setup.ts:6`, `:21`, `sweep.ts:87`
  and `sweep.test.ts:135` cite measurements on Bun 1.3.14 while `package.json:6` pins 1.4.2; `sweepStaleTestDirs` takes
  `opts.tmp` and never reads it (`sweep.ts:38-40` admits it); `CONTEXT.md:1225-1231`'s CI bullet omits the ops
  typechecks and the `docker-build` job. **Item 13.** `src/announce.test.ts:299` passes `dataDir: tmpdir()` to
  `initRouting`, the shared temp root, where every sibling uses a `mkdtempSync` dir (`:180`, `:229`). **Item 14.**
  `sweep.test.ts:139` spawns bare `"bun"` from PATH (not `process.execPath`); the age bound and pid-liveness design is
  deliberate (`sweep.ts:26-29`, `:82-89`) and the hour bound is generous (pid reuse: 0 of 40 trials on this box).
- **#514 item 2 (fix-once).** `ops/bot-ops.test.ts:44-47`, `ops/install.test.ts:52-54` and
  `ops/docker-compose.test.ts:48-50` compute `runnable` and `describe.skipIf(!runnable)` with a loud warning; on CI's
  Linux (`CI=true` in every GitHub Actions job) a missing `bash`, `jq` or `docker compose` would skip the whole file and
  the job would pass. (`bot-ops.test.ts:1501` already reads `process.env.CI` by truthiness.)

### Decisions (defaults, named so the gate can contest them)

1. **The preload's wiring is pinned by a child `bun test`**, the pattern `stateGuard.test.ts:417-445` already uses
   (`process.execPath test <fixture>` with `cwd` at the repo root, so `bunfig.toml`'s preloads apply), run with its
   temp root pointed at a PRIVATE directory (`TEMP`/`TMP`/`TMPDIR` in the child's env): dirs planted there before the
   child runs tell the real `isAlive`/`maxAgeMs`/`mtimeOf`/`isDir`/`remove` apart afterwards, and no other session's
   preload (which sweeps the shared `tmpdir()` with the OLD rules until this lands) can touch them. The fixture prints
   the child's `tmpdir()` so a platform that ignored the env would fail by name.
2. **The sweep touches only real directories** (`lstat(...).isDirectory()`: Node reports a junction and a directory
   symlink as a symbolic link, not a directory, so one conjunct is enough), through a new pure seam `isDir`, read INSIDE
   the same ENOENT-tolerant try as `mtimeOf` (a concurrent preload's remove between `readdir` and `lstat` is "nothing
   left to do", exactly as `sweep.ts:60-73` already says for `mtimeOf`); what it removes is logged by name (count plus
   at most ten names); a `remove` that throws is caught IN `sweep.ts`, reported through a seam, kept out of the removed
   list, and the sweep goes on. The unused `tmp` option goes. This is defence in depth on Windows (`rmSync` does not
   follow a link there) and unmeasured on Linux; the real guard P2 asserts is that the link is still there.
3. **The preload forces the test environment**: `DISCORD_TOKEN` and `ANNOUNCE_CHANNEL_ID` with `=`, and every other key
   read at import deleted (the sixteen in item 8 above; `COMMAND_PREFIX` stays `""` and `BOT_DOCKER_SOCKET` deleted as
   today), so an in-process result cannot differ from CI's and no real token reaches a spawned subprocess. NOT deleted:
   `NODE_ENV` (`src/dataDir.ts:51`, the bun-test refusal depends on it), `HOSTNAME` (`src/docker.ts:231`, read per call
   and set per test), `BOT_ENV_FILE` (`src/bootLog.ts:30`, printed only), `BOT_DATA_DIR` (the preload sets it). A test
   that needs a value sets it (as `commandPrefix.test.ts` does, in a child).
4. **CI gets a top-level `permissions: contents: read`, `timeout-minutes` on both jobs, and SHA-pinned actions with the
   bare-ref comment Renovate parses** (`uses: owner/repo@<40-hex> # v7.0.1`), the form `push-notify.yml:46-56`
   explains. No `--timeout` on `bun test` (Bun's per-test default applies on Linux; the job bound is the backstop).
5. **A tool-dependent suite fails on CI instead of skipping**: each of the three `ops/*.test.ts` files throws at module
   load when `!runnable && process.env.CI` (truthiness, as `bot-ops.test.ts:1501` already reads it; GitHub sets
   `CI=true`); locally the loud skip stays. This is `posthoc-1-2`'s CI-side guard (#514), closed by reference.
6. **`ops/` and `ops/admin` typecheck with the root's strictness** (`noUnusedLocals`, `noUnusedParameters`), the dead
   include goes, and `ops/admin` declares `typescript` itself (same range as the root, `^7.0.0`; its `bun.lock` is
   regenerated and committed, since CI installs it `--frozen-lockfile`; the Dockerfile's `--frozen-lockfile --production`
   still installs `jose` only -- verified in audit).
7. **Declined in writing:** #463 item 14's heartbeat file or process-start-time liveness. The hour bound plus pid
   liveness is the documented design (`sweep.ts:26-29`); a run alive for over an hour with no write under its data dir
   root is not a case this repo's suite produces (a full run is about 10 minutes here, 2 on CI), and a heartbeat adds a
   writer to every run for it. The fragile spawn is fixed (`process.execPath`).
8. **#461 item 5 is recorded as already true** (the sentence was reworded since the review; the imports are quoted
   above) and the PR says so instead of editing it again.
9. **No `test/` section is started in `CONTEXT.md`'s File Map** (`:150-233` has no `test/` rows today); the test
   infrastructure is described where it already is, the Gotchas prose at `:430-436` and `:464-468`.

### Step 1 -- `test/sweep.ts`

1a. `sweepStaleTestDirs` (`:42-80`): drop `tmp`; add `isDir: (name: string) => boolean` and
`onRemoveFailed: (name: string, err: unknown) => void`. The loop body becomes:

```ts
  for (const entry of opts.entries) {
    if (!entry.startsWith(TEST_DATA_PREFIX)) continue;
    // Two sweeps can see the same stale entry in their `readdir` snapshot and race to remove it (the very
    // concurrent-invocations scenario #252 exists to make safe): `isDir` and `mtimeOf` read a path a sibling's
    // `remove` may have already deleted, and a seam backed by lstat/stat throws ENOENT for a vanished path. That
    // is not staleness, it is nothing left to do. #461: only a real directory is a run's dir -- a stray file or a
    // link under the prefix is left alone before anything else is read.
    let stale: boolean;
    try {
      if (!opts.isDir(entry)) continue;
      const pid = parsePid(entry);
      stale = pid === null || opts.now - opts.mtimeOf(entry) > opts.maxAgeMs || !opts.isAlive(pid);
    } catch (err) {
      // Narrowed to ENOENT specifically, matching `isPidAlive`'s error-code check below -- any other error
      // (EACCES, ENOTDIR, ...) is a real problem, not "already gone," and should surface loudly rather than be
      // swallowed as if a sibling sweep had won the race.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue;
    }
    if (!stale) continue;
    // #461: a dead run's dir an orphan still holds (EBUSY/EPERM on Windows) is reported and skipped; it must not
    // stop every later run, and it is not "removed".
    try {
      opts.remove(entry);
      removed.push(entry);
    } catch (err) {
      opts.onRemoveFailed(entry, err);
    }
  }
```

(`pid === null` short-circuits before `mtimeOf`, as today's `:55-59` never reads the mtime of a pre-#252 name; P4
pins that with a no-pid name whose `mtimeOf` throws `EACCES`.) The docstring: the "`opts.tmp` is carried through..."
paragraph goes; it gains "Entries that are not real directories (`isDir`) are skipped before anything else is read; a
`remove` that throws is handed to `onRemoveFailed` and left out of the returned list." Return type stays `string[]`.
Beside it, a pure `formatSwept(removed: string[]): string` returning
`` `[test/setup] swept ${removed.length} stale test dir(s): ${removed.slice(0, 10).join(", ")}${removed.length > 10 ? ", ..." : ""}` ``
(unit-tested, so the cap and the suffix are pinned without planting eleven directories).

1b. `:87`: "Verified on this Windows box (Bun 1.3.14)" -> "(Bun 1.4.2)" after re-running the probe on the pinned Bun
(`bun -e` the two `process.kill(pid, 0)` cases).

### Step 2 -- `test/setup.ts`

2a. `:29-38` becomes:

```ts
const tmp = tmpdir();
const removed = sweepStaleTestDirs({
  entries: readdirSync(tmp),
  now: Date.now(),
  // #461: a real directory only. lstat reports a junction or a directory symlink as a symbolic link, not a
  // directory, so a planted link is skipped (rmSync would not follow it on Windows either, measured on Bun 1.4.2;
  // this does not rely on that).
  isDir: (name) => lstatSync(join(tmp, name)).isDirectory(),
  mtimeOf: (name) => statSync(join(tmp, name)).mtimeMs,
  isAlive: isPidAlive,
  maxAgeMs: MAX_AGE_MS,
  remove: (name) => rmSync(join(tmp, name), { recursive: true, force: true }),
  onRemoveFailed: (name, err) =>
    console.warn(`[test/setup] could not remove the stale test dir ${name}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`),
});
if (removed.length > 0) console.log(formatSwept(removed));
```

(`lstatSync` joins the `node:fs` import at `:14`; `formatSwept` the `./sweep` import at `:17`.) The comment block above it (`:19-28`) keeps its content; "measured
on Bun 1.3.14" at `:6` and `:21` are re-measured on 1.4.2 (`:6`: two files setting different `process.env` values see
the first; `:21`: `process.on("exit")`/`"beforeExit"` do not fire under `bun test`) and the version updated to the one
the probe held on; if either no longer holds, say so in the PR and keep the design (the preload is right either way).

2b. `:68-72` becomes (#462 item 8):

```ts
// The two vars `config.ts` requires at import time (#136), FORCED (#462): a real DISCORD_TOKEN in the shell must not
// reach the suite or the subprocesses it spawns, and every other key read at import (config.ts, logFormat.ts,
// plugins/install.ts) is cleared so an in-process result cannot differ from CI's, where none is set. A test that needs
// a value sets it, in a child when it must. Left alone on purpose: NODE_ENV (dataDir.ts's bun-test refusal reads it),
// HOSTNAME (docker.ts reads it per call; tests set it), BOT_ENV_FILE (bootLog.ts prints it), BOT_DATA_DIR (above).
process.env.DISCORD_TOKEN = "test-token";
process.env.ANNOUNCE_CHANNEL_ID = "100";
for (const key of [
  "GITHUB_REPO", "WATCHED_REPOS", "PLUGINS", "PLUGIN_INDEX_URL", "HTTP_PORT", "TRUSTED_PROXY_HOST",
  "RELEASE_ANNOUNCE_CHANNEL_ID", "DISCORD_SERVER_ID", "GITHUB_TOKEN", "GIT_SHA", "BOT_BRANCH", "AUTO_UPDATE",
  "ADMIN_USER_IDS", "REPORT_ROLE_ID", "LOG_FORMAT", "PLUGIN_REGISTRY_URL",
]) {
  delete process.env[key];
}
```

(Before committing, confirm the list is still complete: Grep `process\.env\.|env\.[A-Z_]{3,}|env\["` in
`src/config.ts`, `src/logFormat.ts`, `src/plugins/install.ts`, and `process\.env` across the rest of `src/**/*.ts`
for any new reader; the recipe `env["..."]` alone misses `env.PLUGIN_REGISTRY_URL` and `env.LOG_FORMAT`. Keep
`:73-81` as they are.)

### Step 3 -- the preload tests (#403, #461, #462 item 8)

3a. A fixture `test/preload.fixture.ts` (the `.fixture.ts` name keeps it out of discovery, as
`stateLeak.fixture.ts:1-2` explains) with one test that imports `config` and `resolveConfig` from `../src/config`
and asserts the environment the preload leaves:
`expect(config).toEqual(resolveConfig({ DISCORD_TOKEN: "test-token", ANNOUNCE_CHANNEL_ID: "100", COMMAND_PREFIX: "" }))`
(a deep-equal, so any surviving key names its field; extend that expected env ONLY with keys the preload itself sets),
and `process.env.LOG_FORMAT`, `process.env.PLUGIN_REGISTRY_URL`, `process.env.GITHUB_TOKEN`,
`process.env.BOT_DOCKER_SOCKET` undefined, `process.env.COMMAND_PREFIX === ""`. It also prints
`[preload.fixture] tmpdir=${tmpdir()}` to stdout (Decision 1).

3b. A new `test/setup.test.ts` with `const CHILD_TIMEOUT_MS = 20_000;` and a helper
`runPreloadChild(env: Record<string, string>, sbx: string)` that returns `Bun.spawnSync([process.execPath, "test", "./test/preload.fixture.ts"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, ...env, TEMP: sbx, TMP: sbx, TMPDIR: sbx }, timeout: CHILD_TIMEOUT_MS, stdout: "pipe", stderr: "pipe" })`.
One `describe("the preload in test/setup.ts, run for real (#403, #461, #462)")` with a `beforeAll(fn, CHILD_TIMEOUT_MS + 10_000)`
(the hook default of 5 s is shorter than one child run plus planting; `stateGuard.test.ts:445` sets the same bound)
that creates `sbx = mkdtempSync(join(tmpdir(), "preload-sbx-"))` (NOT prefix-named) and plants, inside it, with
`TEST_DATA_PREFIX`:
- `live`: `${prefix}${process.pid}-live-<random>` (mkdtemp; this process is alive and the dir is young);
- `dead`: `${prefix}${deadPid}-dead-<random>` where `deadPid` is the pid of `Bun.spawn([process.execPath, "-e", ""])`
  after `await proc.exited` (the `isPidAlive` test's own probe, `sweep.test.ts:137-143`);
- `old`: `${prefix}${process.pid}-old-<random>` with its mtime set two hours back (`utimesSync(dir, past, past)` --
  works on a directory on Windows, measured);
- `link`: a symbolic link or junction named `${prefix}${deadPid}-link-<random>` pointing at a scratch dir inside `sbx`
  (`symlinkSync(target, link, "junction")` on Windows, `"dir"` elsewhere; junction creation needs no elevation) whose
  `sentinel.txt` must survive;
- `file`: a regular FILE named `${prefix}${deadPid}-file-<random>` (`writeFileSync`);
then runs `runPreloadChild({ DISCORD_TOKEN: "real-token", ANNOUNCE_CHANNEL_ID: "999", GITHUB_REPO: "x/y", WATCHED_REPOS: "x/z", PLUGINS: "<a value config.ts accepts>", PLUGIN_INDEX_URL: "http://127.0.0.1:9/index.json", HTTP_PORT: "1234", TRUSTED_PROXY_HOST: "proxy.test", RELEASE_ANNOUNCE_CHANNEL_ID: "777", DISCORD_SERVER_ID: "888", GITHUB_TOKEN: "ghp_x", GIT_SHA: "abc", BOT_BRANCH: "other", AUTO_UPDATE: "true", ADMIN_USER_IDS: "999", REPORT_ROLE_ID: "555", LOG_FORMAT: "json", PLUGIN_REGISTRY_URL: "http://localhost:4873" }, sbx)`
-- a bogus value for EVERY key step 2b deletes (each one `config.ts` accepts where it checks the format, so a surviving
key fails the fixture's deep-equal by name rather than the import) -- and records `exitCode`, `stdout`, `stderr`;
`afterAll` removes `sbx` (`rmSync` recursive, force). Tests:
- **P0:** the child's stdout line `[preload.fixture] tmpdir=` names `sbx` (compare through `realpathSync` on both
  sides) -- if a platform ignored `TMPDIR`, this says so instead of P1 failing obscurely. (POSIX `TMPDIR` handling in
  Bun's `os.tmpdir()` was not measured here; CI is where it is proven.)
- **P1 (#403):** `live` still exists; `dead` and `old` do not; the child's stdout contains `swept 2 stale test dir(s)`
  and names `dead` and `old` and not `live`.
- **P2 (#461 item 1):** `link` still exists (`lstatSync(link).isSymbolicLink()`), `target/sentinel.txt` is intact, and
  `file` still exists.
- **P3 (#462 item 8):** the child's `exitCode` is `0` (the fixture's assertions held) -- on failure the test prints
  `stderr` and `stdout` in its message.
- **W1 (#461 item 2, Windows only, `test.skipIf(process.platform !== "win32")(..., 60_000)`):** its own sandbox and a
  dir `${prefix}${deadPid}-held-<random>` held by a live process whose cwd is inside it --
  `const holder = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { cwd: held, stdout: "ignore", stderr: "ignore" }); await Bun.sleep(500);`
  (an OPEN FILE HANDLE does not make `rmSync` throw on Windows under Bun 1.4.2 -- measured; a cwd does: `EBUSY`) --
  plus a `dead` dir, runs the child, and asserts `exitCode === 0`, stderr contains
  `could not remove the stale test dir` naming `held` and `EBUSY`, stdout's `swept` line names `dead` and NOT `held`,
  and `held` still exists; `finally`: `holder.kill(); await holder.exited;` then remove the sandbox. (On Linux a held
  cwd deletes; the case is Windows's, and CI is Linux: the unit case P4 below guards the catch everywhere; say so in
  the PR.)
- **P4 (`sweep.test.ts`):** the `sweep` helper (`:9-24`) gets `isDir: () => true` by default, an optional `remove`
  override (the default records every name it is given into `removedByCallback`; an override records only the names it
  let through before throwing), and `onRemoveFailed: (name, err) => failed.push(name)` returning `failed` too; the
  `tmp: "/tmp"` arguments go. New cases: `isDir: () => false` with a dead pid -> not removed, `removedByCallback`
  empty; `isDir` throwing `Object.assign(new Error("gone"), { code: "ENOENT" })` -> skipped (nothing removed, no
  throw); `isDir` throwing `code: "EACCES"` -> the sweep throws it (the narrowing holds for the new read); a no-pid
  name (`${TEST_DATA_PREFIX}legacy`) with an `mtimeOf` that throws `EACCES` -> removed, no throw (the short-circuit:
  a pre-#252 name never reads its mtime); `remove` that throws for the FIRST of two dead entries -> `failed` is
  `[first]`, `removedByReturn` is `[second]`, `removedByCallback` is `[second]` (the catch, and continue-after-throw,
  on every OS); `formatSwept` with three names -> all three and no suffix, with eleven -> the first ten, then `, ...`,
  and the count `11`. `:139`: `Bun.spawn([process.execPath, "-e", ""], ...)` (#463 item 14); `:135`: "(Bun 1.4.2)".
- **C1 (step 5's guard, in `test/setup.test.ts`, a second describe, each case `30_000`):** for each of
  `ops/bot-ops.test.ts`, `ops/install.test.ts`, `ops/docker-compose.test.ts`: spawn `process.execPath test <file>`
  with `env: { ...process.env, CI: "true", PATH: <an empty mkdtemp dir> }` (so `Bun.which("bash")`/`("jq")`/`("git")`/
  `("docker")` find nothing; on Windows `resolveBash` falls back to `Bun.which("git")`, which the empty PATH also
  defeats; the child needs nothing on PATH because `process.execPath` is absolute -- measured: `bash (missing) and jq
  (missing)`) -> `exitCode !== 0` and stderr contains `required on CI; refusing to skip`. And the complement: the same
  with `CI` deleted from the env -> `exitCode === 0` and stderr contains `SKIPPING`. (Both are quick: the file throws
  or skips at module load.)
- **Y1 (`ci.yml`, a third describe):** `Bun.YAML.parse(text) as { permissions?: unknown; jobs: Record<string, Record<string, unknown>> }`
  over `readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")` (`Bun.YAML` is typed on
  the pinned Bun; `parse` returns `unknown`, hence the cast): `permissions` equals `{ contents: "read" }`; every entry
  of `jobs` has a numeric `timeout-minutes`; every raw line matching `/^\s*-?\s*uses:/` matches
  `/@[0-9a-f]{40} # v?\d[\w.]*$/` (anchored at the line start, so a comment that mentions `uses:` cannot fail it;
  `.gitattributes` forces LF, so no CR to strip).

### Step 4 -- `.github/workflows/ci.yml`

4a. After `concurrency:` (`:6-8`): `permissions:\n  contents: read` (top level, both jobs inherit). `checks` gains
`timeout-minutes: 20` (the job took 115 s on run 38894938584: a generous backstop); `docker-build` gains
`timeout-minutes: 15` (22 s on the same run). Keep both job names.

4b. Pin by commit. Resolved in audit (both tags are lightweight, so `gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq '.object | "\(.type) \(.sha)"'`
answers `commit <sha>` directly; re-run the two commands and confirm before writing):
- `actions/checkout` `v7` -> `3d3c42e5aac5ba805825da76410c181273ba90b1` (`v7.0.1`): `uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1` at `:14` and `:66`;
- `oven-sh/setup-bun` `v2` -> `0c5077e51419868618aeaa5fe8019c62421857d6` (`v2.2.0`): `uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0` at `:16`.
The comment is the bare ref and NOTHING else (`push-notify.yml:46-52`: Renovate matches it as a single token; prose
breaks the pin's updates). Record the resolved shas in the PR body.

4c. `:37-40`: the four comment lines become
`# A single unscoped \`bun test\` from the repo root covers both projects' suites (Bun resolves each test file's imports relative to its own location).`
(#462 item 7: no counts, no timings.)

### Step 5 -- the CI guard in the tool-dependent suites (#514 item 2)

In `ops/bot-ops.test.ts` after `:44` (`const runnable = BASH !== null && JQ !== null;`), `ops/install.test.ts` after
`:52` (`const runnable = BASH !== null;` -- `:51` is `const BASH = resolveBash();`, one line too early), and
`ops/docker-compose.test.ts` after `:48` (`const runnable = composeRunnable();`), before each existing
`if (!runnable) {` warning:

```ts
// #514 (posthoc-1-2): on CI a skipped suite would pass vacuously; the runner has bash, jq and docker compose, so a
// missing one there is a broken job, not an environment to tolerate. GitHub sets CI=true in every job.
if (!runnable && process.env.CI) throw new Error("[<file>.test] <tools> are required on CI; refusing to skip");
```

(name the tools each file needs: `bash + jq`, `bash`, `docker compose`.)

### Step 6 -- `test/stateLeaks.ts` tests, `test/stateGuard.test.ts`, `test/stateGuardHook.ts`, `src/announce.test.ts`

6a. `stateGuard.test.ts:37-48`, a fourth case (#462 item 9): `settled((async () => { for (let i = 0; i < 5; i++) await null; })())`
resolves `true` (a promise that settles after several microtask hops, before any macrotask, has settled by the time
`setImmediate` fires; `queueMicrotask` in its place reads it as still running, and this case names it).

6b. `stateGuard.test.ts:440-441` (#462 item 10): before `readFileSync(report, ...)`,
`if (!existsSync(report)) throw new Error(\`fixture run wrote no report (exit ${child.exitCode}):\n${child.stderr.toString()}\n${child.stdout.toString()}\`);`
(`existsSync` joins the import). Manual check, in the scratch worktree: put a temporary
`if (process.argv.some((a) => a.includes("stateLeak.fixture"))) throw new Error("preload refused on purpose");`
as the first statement of `test/stateGuardHook.ts` -- gated on the CHILD run: an unconditional throw kills the parent
`bun test` at its own preload and the child never runs (measured) -- run `bun test test/stateGuard.test.ts`, paste the
failure (`fixture run wrote no report (exit 1):` followed by the child's `preload refused on purpose`, not a bare
ENOENT), and revert the throw. (The plan's earlier `HTTP_PORT=abc` recipe stops working once step 2b lands: the
preload deletes the key before `config.ts` loads.)

6c. The two comments that promised that refusal are reworded, because step 2b makes them false:
`test/stateGuardHook.ts:25-27` -> "Loading those modules here means config.ts loads for every run, even of a single
file that never imports it. test/setup.ts forces the two keys it requires and clears every other key it reads (#462),
so a value left in your shell cannot stop a run; a preload that throws for any other reason still stops every run
before its first test, and a failure only the guard's own child run hits is reported by its test with the exit code
and stderr (#462)."
`CONTEXT.md:466-468` ("A side effect: `config.ts` now loads ... stops every run before its first test — unset it.")
-> "A side effect: `config.ts` now loads for every run, even of one file that never imports it; `test/setup.ts`
forces `DISCORD_TOKEN` and `ANNOUNCE_CHANNEL_ID` and clears the sixteen other keys `config.ts`, `logFormat.ts` and
`plugins/install.ts` read at import (#462; `NODE_ENV`, `HOSTNAME`, `BOT_ENV_FILE` and the handoff keys are left alone
and change no result), so a shell's values for those never reach the suite or the subprocesses it spawns, and cannot
stop a run."

6d. `src/announce.test.ts:299` (#463 item 13): `dataDir: tmpdir()` -> a `mkdtempSync(join(tmpdir(), "announce-refresh-test-"))`
created before `initRouting` and removed in the test's `finally` (the shape at `:180-184`/`:229-284`).

### Step 7 -- typecheck configs (#462 item 11)

- `ops/tsconfig.json`: `"include": ["*.ts"]` (drop `tools/*.ts`); add `"noUnusedLocals": true, "noUnusedParameters": true`
  after `verbatimModuleSyntax`.
- `ops/admin/tsconfig.json`: the same two flags.
- `ops/admin/package.json`: `"typescript": "^7.0.0"` in `devDependencies`; run `bun install` in `ops/admin` and commit
  its `bun.lock` (it gains `typescript@7.0.2` and about 35 `@typescript/typescript-*` platform entries; CI installs it
  `--frozen-lockfile`, and the Dockerfile's `--frozen-lockfile --production` still installs only `jose`).
- Run both typechecks. In audit the new flags reported exactly two sites, both `TS6133` in `ops/admin/server.test.ts`:
  `(6882,20) 'key'` and `(10644,28) 'path'` -- prefix each with `_`. `ops/` reported none. If the tree you work from
  reports more, fix them the same way and list every edit in the PR; past about ten, stop and report.

### Step 8 -- docs and text (#463 item 12, #461 item 5)

- `package.json:7`: `"description": "Discord bot: a plugin host with GitHub release announcements and in-place self-update"`.
- `CONTEXT.md:1225-1231` (wrapped bullet; per-line anchors): the parenthetical becomes "(`bun install --frozen-lockfile`
  for both projects, the three typechecks -- root, `ops/`, `ops/admin` -- one root `bun test`, then the same suite as
  `bun test --randomize` ...)" and the bullet gains, after "No lint beyond tsc.": "A second job, `docker-build`, builds
  both images without pushing (#83). Both jobs run with `contents: read` and a `timeout-minutes` bound, and the actions
  are pinned by commit (#461)."
- `CONTEXT.md:426-427`: unchanged (Decision 8); the PR quotes the two imports.
- `CONTEXT.md:430-436` (the `#252` sentence of the data-dir gotcha): append "The sweep removes real directories only
  (`lstat`; a stray file or a planted link under the prefix is left alone), logs what it removed, and a removal that
  fails (a dead run's dir an orphan still holds as its cwd, on Windows) is warned and skipped rather than failing the
  run (#461); `test/setup.test.ts` runs the preload for real in a child `bun test` against directories planted in a
  private temp root (#403)."
- `CONTEXT.md:466-468` per 6c.
- The Bun-version notes per steps 1b, 2a and P4.
- No File Map rows (Decision 9).

### Mutation table (run in a scratch worktree, never in the shared tree)

```bash
git -C /s/repos/rackbops-discord-bot worktree add --detach /s/Repos/_wt/rdb-532-T1-mut fix/532-T1-test-harness-ci
cd /s/Repos/_wt/rdb-532-T1-mut && bun install --frozen-lockfile && (cd ops/admin && bun install --frozen-lockfile)
```

Run `bun test test/setup.test.ts test/sweep.test.ts test/stateGuard.test.ts` per mutant (the first spawns child
`bun test`s, a few seconds each).

| # | Mutation (production line, after the steps) | Test that must fail |
|---|---|---|
| M1 | 2a: `isAlive: isPidAlive` -> `isAlive: () => false` | P1 (`live` removed), by name |
| M2 | 2a: `maxAgeMs: MAX_AGE_MS` -> `0` | P1 (`live` removed) |
| M3 | 2a: `mtimeOf` -> `() => 0` | P1 (`live` removed) |
| M3b | 1a: `!opts.isAlive(pid)` dropped from `stale` | P1 (`dead` kept), P4's dead-pid cases |
| M4 | 1a: `if (!opts.isDir(entry)) continue;` deleted | P2 (the link or the file removed), P4 |
| M5 | 2a: `isDir` -> `() => true` | P2 |
| M5b | 2a: `isDir` -> `(name) => !lstatSync(join(tmp, name)).isSymbolicLink()` (a file passes) | P2 (`file` removed) |
| M6 | 1a: the `try/catch` around `opts.remove` removed (rethrow) | P4's throwing-`remove` case (every OS); W1 on Windows |
| M6b | 1a: `removed.push(entry)` moved above `opts.remove(entry)` (a failed removal counted as swept) | P4 (`removedByReturn` holds the first); W1 (`swept` names `held`) |
| M6c | 1a: the ENOENT narrowing around the `isDir`/`mtimeOf` read -> swallow every error | P4's `EACCES` case |
| M6d | 1a: the `isDir` call moved OUT of the try (above it) | P4's ENOENT-from-`isDir` case |
| M7 | 2a: the `swept` log line deleted | P1 (stdout lacks `swept`) |
| M7c | 1a: `formatSwept`'s `slice(0, 10)` -> `slice(0, 1000)`, or the `, ...` suffix dropped | P4's eleven-name case |
| M3c | 1a: `mtimeOf` read before the `pid === null` test (no short-circuit) | P4's no-pid `EACCES` case |
| M7b | 2a: `onRemoveFailed`'s warn deleted (a no-op seam) | W1 (Windows only; on Linux review-guarded, named in the PR) |
| M8 | 2b: `process.env.DISCORD_TOKEN = "test-token"` -> `??=` | P3 (the fixture's deep-equal names `discordToken`) |
| M8b | 2b: `process.env.ANNOUNCE_CHANNEL_ID = "100"` -> `??=` | P3 |
| M9 | 2b: ONE key dropped from the delete list -- run once per key, all sixteen | P3 (the deep-equal names the field; `LOG_FORMAT` and `PLUGIN_REGISTRY_URL` by the `process.env` assertions) |
| M10 | 6a: `setImmediate` -> `queueMicrotask` in `settled` | the multi-hop case, by name |
| M11 | step 5: the CI guard removed from one of the three ops files -- run once per file | C1 (that file's case) |
| M12 | 4a: `permissions` removed; a `timeout-minutes` removed; one `uses:` back to `@v7` -- three runs | Y1 |
| M13 | 6b: the `existsSync` guard removed | the manual check (a bare ENOENT again); no automated test, named in the PR |

### Coverage table

| Bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| #403: the preload's real `isAlive`/`maxAgeMs`/`mtimeOf` keep a live young dir and remove a dead and an old one, with a named failure | 3 | P1 | M1, M2, M3, M3b |
| #461-1: the sweep never removes a link or a file and names what it removed (ten names, then `, ...`) | 1a, 2a | P2, P4, P1 | M4, M5, M5b, M7, M7c |
| the pre-#252 name never reads its mtime | 1a | P4 | M3c |
| #461-2: a `remove` that throws does not stop the run and is not counted as swept | 1a, 2a | P4, W1 (Windows) | M6, M6b, M7b |
| the #252 race holds for the new read | 1a | P4 | M6c, M6d |
| #461-4/-6: CI is time-boxed, least-privilege, pinned by commit | 4 | Y1 | M12 |
| #461-5: the CONTEXT sentence is true | -- | the two imports quoted in the PR | -- |
| #462-7/-11: the stale comment is gone; the typecheck configs are even | 4c, 7 | the three typechecks | -- |
| #462-8: ambient config keys never reach the suite | 2b | P3 | M8, M8b, M9 (x16) |
| #462-9: `settled()` holds across microtask hops | 6a | the multi-hop case | M10 |
| #462-10: a child that writes no report fails with its exit code and stderr | 6b, 6c | manual (the temporary throw) | M13 (manual) |
| #463-12/-13/-14: the text is current, the routing test uses its own dir, the spawn uses `process.execPath`, the heartbeat is declined | 1b, 2a, 6d, 8, P4 | lens-B audit; the edited tests pass | -- |
| #514-2: a tool-dependent suite fails on CI instead of skipping | 5 | C1 (x3) | M11 (x3) |

### Verification

```bash
bun install --frozen-lockfile
cd ops/admin && bun install --frozen-lockfile && cd ../..
bun run check
bunx tsc --noEmit -p ops/tsconfig.json
cd ops/admin && bun run check && cd ../..
bun test test/setup.test.ts test/sweep.test.ts test/stateGuard.test.ts src/announce.test.ts src/config.test.ts
bun test
bun test --randomize
```

- CI's own run is the evidence for `ci.yml` (the pinned shas resolve, the permissions suffice for checkout and the
  tests, the bounds are not hit), for the guard not firing where the tools exist, and for P0 (`TMPDIR` honoured on
  Linux); W1 runs only on Windows (this box). Name all three in the PR.
- The two full runs are about 10 minutes each here; run them in the background.

### Acceptance to paste per issue

- **#403:** P1's pass line and M1/M2/M3's failing output (P1's own message, not the stateGuard ENOENT).
- **#461:** P2, P4, W1 and the `ci.yml` diff; M4, M6, M6b; the quoted imports for item 5; Y1.
- **#462:** P3 and the multi-hop case; M8, M9 (the sixteen one-line results), M10; the temporary-throw output for item
  10; the typecheck configs' diff and the two `_` renames.
- **#463:** the text diffs; the declined heartbeat with Decision 7's reason.
- **#514 (item 2 by reference):** C1's three pass lines and M11; comment on #514 naming this PR.

### PR

- Title: `test(harness): pin the preload's real sweep wiring, contain and tolerate the sweep, force the test env, time-box and pin CI, and fail a tool-dependent suite on CI instead of skipping (#403, #461, #462, #463, #514)`.
- Body: one line per item, Decisions 1-9 (7 as declined, 8 as confirmed), the resolved action shas, the typecheck +
  test output, the mutation table, the Windows-only (W1, M7b) and CI-only (P0, the guard's non-firing) coverage named.
  End with `Closes #403. Closes #461. Closes #462. Closes #463.`; `Part of #514 (item 2)`.
- After merge: tick #403 #461 #462 #463 on #532; comment on #514 (item 2 closed by reference); #532's box on #516.

### Out of scope, on purpose

- A heartbeat or start-time liveness for the sweep (Decision 7).
- `--timeout` on `bun test` and a `[test] timeout` in `bunfig.toml` (the job bound is the backstop; a per-test bound
  would need the slow `ops/` subprocess tests re-measured).
- Renaming either CI job (branch protection names them).
- A `test/` section in `CONTEXT.md`'s File Map (Decision 9).
- A scan ratchet over `src/**/*.ts` for new `process.env` readers (P3's deep-equal catches any new `config.ts` key;
  a new import-time reader elsewhere is a review item).
