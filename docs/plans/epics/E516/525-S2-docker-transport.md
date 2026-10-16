<!-- Plan for sub-epic #525 of Epic #516 (Rackbops/rackbops-discord-bot), bundle S2: the daemon transport and
the docker-restart doc drift. Written by the orchestrating session on 2026-10-16 against `main` @ `cccd683`.
Every file:line below was read from that tree; the implementer re-reads each one on the tree it works from
and corrects any that moved. -->

> Amended 2026-10-16 after the gate on PR #554: the key is `BOT_DOCKER_SOCKET` (reviewer A: a generic `DOCKER_SOCKET` copied from another stack's `.env` would redirect the transport), an empty value is unset, and `resolveDockerSocket(env)` is exported; the text below was renamed accordingly.

## Implementation plan -- #525 bundle S2: `src/docker.ts`'s transport pin, `parseBuildOutput`, the docker-restart drift

Children: **#459** and **#513** (items 9, 10, 11). One PR. A behaviour change (a socket-path seam read at
import, a `parseBuildOutput` guard), small but real, so the **three-reviewer gate** applies: you plus two
read-only adversarial reviewers with different lenses, up to four rounds, then report. Every coverage row
is mutation-tested in a scratch worktree, real output pasted.

Bundle S1 (another session's PR, `fix/525-S1-swap-verdict`) edits `src/docker.ts` at `removeContainer`
(`:263-271`), adds one `removeContainer` case to `docker.test.ts`, rewrites `redeploy.ts`'s verdict block
(`:294-418`) and edits `CONTEXT.md`'s `handoff.ts`, `redeploy.ts`, `docker.ts` and test rows. This bundle
touches `docker.ts` only at the socket constant (`:12`) and `parseBuildOutput` (`:184-197`), `redeploy.ts`
only at the comment `:698-699`, and `docker.test.ts` at its stub helper, the bound table's comments and new
tests -- all disjoint by line. **The `CONTEXT.md` `docker.ts` row is edited by both, so S1 merges first:** do
every step but the `CONTEXT.md` edits of step 5, then `git merge origin/main` once S1 is in (tell the
orchestrator if it is not when you get there), and make the row edits on S1's wording. Every `CONTEXT.md` row
keeps one writer at a time.

### What is wrong, verified at `cccd683`

- `src/docker.ts:12` `const SOCKET = "/var/run/docker.sock"` and `:96` `fetch(`${BASE}${path}`, { ...init,
  unix: SOCKET, signal })` are the module's one transport statement. Every test stubs `fetch`
  (`docker.test.ts:88-99` records `url`, `method`, `signal`, `body` and types `unix?` without recording it;
  `redeploy.test.ts:809-812` the same), so deleting `unix: SOCKET` leaves the suite green while every
  production call would go to TCP `http://docker`, `daemonReachable` would answer `false`, and the bot would
  silently take the exit-75 fallback. The abort semantics the bound tests model by hand (`:161-166`,
  `:184-192`) have never been exercised against a real socket. (#459.)
- `parseBuildOutput` (`docker.ts:184-197`) wraps only `JSON.parse` in its `try`; `parsed.errorDetail?.message`
  (`:193`) runs outside it, so a stream line that parses to `null` (valid JSON) throws a `TypeError` out of
  `buildImage` for what the test names call skippable noise. (#513 item 9.)
- Counts and cites: `CONTEXT.md:189` says the bound table drives "all 14 exported daemon calls" and
  `docker.test.ts:155` says "one call site of fourteen"; `everyDaemonCall` (`docker.test.ts:225-241`) has 15
  rows, one per exported async function. `restart.test.ts:203-204` cites `redeploy.ts:256`,
  `announce.ts:225` and `commands.ts:124`; `beginHandoff` is now called at `redeploy.ts:260`, and the
  callers moved too. `CONTEXT.md:184` says `awaitCriticalIdle` resolves "once `critical` falls back to (not
  below)" the exemption; the code is `critical <= handoffExemption()` (`restart.ts:87`, `:256`), at or below.
  (#513 item 10; the `restart.test.ts` cite is also `posthoc-1-5`'s in #514.)
- `CONTEXT.md:791` (the #46 gotcha) and `redeploy.ts:698-699` list "the ops panel's Restart" among the
  in-place restarts that re-read a stale `HANDOFF_FROM`. Since #277 the panel's button POSTs
  `/api/recreate` (`ops/admin/public/index.html:3215`; `ops/admin/server.ts:559`), which runs `bot-ops.sh
  recreate`, a compose `--force-recreate`: a fresh container with no `HANDOFF_FROM` at all, so it never
  exercises `resolveBootMode`'s existence check. (#513 item 11.)
- Probed 2026-10-16 on this box (Windows 11, Bun 1.4.2): `Bun.serve({ unix })` listens on an AF_UNIX path
  under `%TEMP%`, `fetch(url, { unix })` reaches it (`200 OK`), and a fetch against a handler that never
  answers is cut by an `AbortController` after 51 ms. So the end-to-end test below runs on both platforms;
  CI's Linux run is still the one that counts for the production kernel.

### Decisions (defaults, named so the gate can contest them)

1. **The socket path becomes a test seam read once at import:** `const BOT_DOCKER_SOCKET = process.env.BOT_DOCKER_SOCKET
   ?? "/var/run/docker.sock"` (not exported: nothing would import it, and the in-process pin asserts the
   literal). Like `BOT_DATA_DIR` it is deliberately absent from `.env.example`: the compose file always mounts
   the host's daemon at `/var/run/docker.sock` inside the container (`entrypoint.sh:13` hard-codes the same
   path for the group fix-up), so an operator never sets it. **It goes into `bot-ops.sh`'s `RESERVED_KEYS`,
   group 3** (`:312-323`, beside `HOSTNAME`, which `docker.ts` already reads at `:147`): the test "every
   environment variable the bot core's source reads is editable or reserved" (`ops/bot-ops.test.ts:3659`)
   scans `src/**` for `env.X` reads and goes red otherwise, and an unreserved key is one a Plugin Index
   manifest could claim as panel-editable, which would let the panel redirect the daemon transport. No
   `BOT_OPS_SCHEMA` bump: the rule at `bot-ops.sh:70` bumps for a subcommand or an `ALLOWED_SPEC` row, and
   `RESERVED_KEYS` is neither (the #278 and #324 reservations did not bump either). `docker.ts` is not
   config-free (it imports `./github`, which imports `./config`); the read is a plain `process.env` read in
   the module, as `HOSTNAME`'s is. The test preload clears it (`test/setup.ts`), the way it clears
   `COMMAND_PREFIX`, so an ambient value in a developer's shell cannot turn the in-process pin red or point
   the suite at a real daemon; the end-to-end test hands its child the path explicitly.
2. **Two pins for the transport:** the in-process stub records `init.unix` and the daemon-call tests assert
   it is the literal default; and one child process (`test/dockerSocketChild.ts`) runs the REAL `fetch` from
   `docker.ts` against a `Bun.serve({ unix })` it starts itself: `daemonReachable()` must be `true` through the
   socket; `inspectContainer("hang", 100)` against a handler that never answers, and
   `inspectContainer("wedge", 100)` against one that sends headers and one body byte and never closes, must
   both reject with the bound's own message in well under a second. The first proves the option is passed;
   the other two prove Bun's real abort cuts a hanging and a wedged unix fetch, the two shapes the stubbed
   tests only model (#130's first cut missed the second). The auditor probed the wedged shape on Windows:
   rejected in 102 ms for a 100 ms bound.
3. **`parseBuildOutput` skips any line that does not parse to a non-null object.** Only `null` would throw
   (a property read on a number or a string is `undefined`); the `typeof` half is kept for clarity and is an
   equivalent mutant the gate should not chase. The other suggestion, requiring a success marker before
   `ok: true`, is declined: the classic builder and BuildKit end their streams differently, and a cleanly
   truncated stream already fails one call later (`createContainer`'s 404 on the missing tag). Say so in
   the PR.
4. **The bound table's count becomes self-maintaining:** a test compares the table's names with the
   module's exported `async` functions, so the next daemon call either gets a row or turns the suite red;
   the comments and `CONTEXT.md` stop quoting a number. (A daemon call written as a plain function that
   returns `bounded(...)` would not be counted; the test's comment says so, and the module has none.)
5. **Cites by symbol, not line,** in `restart.test.ts:202-204`: `beginHandoff`'s one call site in
   `redeploy()`, reached through `checkForUpdate` under `withCritical` from `announce.ts`'s `onTick` (whose
   `withCritical` wraps the whole tick, `announce.ts:301`) and `commands.ts`'s `/update` handler. Re-read
   each on your tree and name what is there.
6. **Closed by reference:** `posthoc-1-5` in #514 names the same `restart.test.ts` cite; comment on #514
   after the merge (do not close it: its other items are #529's). `src/fetchTimeouts.test.ts:12`'s "12 of
   14 daemon calls" is #130's historical count and is left as it is.

### Step 1 -- `src/docker.ts`

- `:12-13`:

  ```ts
  /** The daemon socket. A TEST SEAM, not an operator knob (compare `BOT_DATA_DIR`): the compose file always
   *  mounts the host's daemon at this path inside the container (entrypoint.sh fixes the socket's group up at
   *  the same path), so a deployment never sets it; the suite's end-to-end transport test (#459) points a
   *  child process at a socket it serves itself. Deliberately absent from `.env.example`, reserved in
   *  `bot-ops.sh` (never panel-editable, never claimable by a plugin manifest), and cleared by the test
   *  preload so an ambient value cannot aim the suite at a real daemon. A plain environment read, like
   *  HOSTNAME's below. */
  const BOT_DOCKER_SOCKET = process.env.BOT_DOCKER_SOCKET ?? "/var/run/docker.sock";
  const BASE = "http://docker";
  ```

  and `:96` -> `unix: BOT_DOCKER_SOCKET`.
- `parseBuildOutput` (`:184-197`):

  ```ts
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a partial/non-JSON line is progress noise, not a verdict
      }
      // Valid JSON that is not an object is noise too (#513). `null` is the one such value whose property
      // read below would throw a TypeError out of buildImage; a number or a string reads as undefined and is
      // skipped here only for clarity.
      if (typeof parsed !== "object" || parsed === null) continue;
      const { error, errorDetail } = parsed as { error?: string; errorDetail?: { message?: string } };
      const message = errorDetail?.message ?? error;
      if (message) return { ok: false, error: message };
    }
    return { ok: true };
  ```

  Extend the docblock (`:179-183`): success is the absence of an error line; a truncated stream is caught
  one call later by `createContainer`'s 404 on the missing tag (decision 3).

### Step 2 -- `test/setup.ts` and `ops/bot-ops.sh`

- `test/setup.ts`, after the `COMMAND_PREFIX` line (`:76`):

  ```ts
  // #459: the daemon socket path is a test seam (src/docker.ts). Cleared, not defaulted: an ambient value
  // would aim every stubbed-fetch assertion and, worse, the real transport test's child at a real daemon.
  delete process.env.BOT_DOCKER_SOCKET;
  ```

- `ops/bot-ops.sh`, `RESERVED_KEYS` group 3, after the `HOSTNAME` line (`:318`):

  ```bash
    [BOT_DOCKER_SOCKET]=1            # src/docker.ts: the daemon socket path, a test seam (#459) -- set by nothing in a deployment, and no plugin may claim it
  ```

  No schema bump (decision 1). The `CORE_SETTINGS` behaviour table in `ops/bot-ops.test.ts` (grep
  `CORE_SETTINGS`) gets a row in the same shape as `HOSTNAME`'s if that table lists every group-3 key; read
  its header to see what it pins before adding one.

### Step 3 -- `test/dockerSocketChild.ts` (new; a fixture, not a test file)

```ts
// Child-process fixture for src/docker.test.ts's real-transport test (#459). Not a test file itself: the
// parent spawns it with BOT_DOCKER_SOCKET pointing at a path this process serves, it drives src/docker.ts's
// REAL fetch over that socket, prints one JSON object on stdout, and exits.
//
// Why a child: src/docker.ts reads BOT_DOCKER_SOCKET once at import and the suite runs in one process with one
// module registry, so the path cannot be changed for one test; and the point is the real `fetch(url,
// { unix })` plus the real abort, which every in-process test stubs away. Expects from the parent:
// BOT_DOCKER_SOCKET, and the inherited test env (src/docker.ts imports ./github, which imports ./config, so
// DISCORD_TOKEN and ANNOUNCE_CHANNEL_ID must be set -- the preload sets them in the parent's process.env).
const socket = process.env.BOT_DOCKER_SOCKET;
if (!socket) throw new Error("BOT_DOCKER_SOCKET must be set by the parent");

const server = Bun.serve({
  unix: socket,
  fetch(req) {
    const path = new URL(req.url).pathname;
    // The daemon's ping answers. `/containers/hang/json` never answers at all; `/containers/wedge/json`
    // sends headers and one body byte and then never closes -- the shape that caught #130's first cut,
    // where the bound was retired the moment the headers landed.
    if (path === "/_ping") return new Response("OK");
    if (path === "/containers/wedge/json") {
      return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("{")) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Promise<Response>(() => {});
  },
});

const { daemonReachable, inspectContainer } = await import("../src/docker");
const ping = await daemonReachable(2_000);
async function bounded(id: string): Promise<{ ok: boolean; message?: string; elapsedMs: number }> {
  const started = Date.now();
  try {
    await inspectContainer(id, 100);
    return { ok: true, elapsedMs: Date.now() - started };
  } catch (err) {
    return { ok: false, message: (err as Error).message, elapsedMs: Date.now() - started };
  }
}
const hang = await bounded("hang");
const wedge = await bounded("wedge");
server.stop(true);
console.log(JSON.stringify({ ping, hang, wedge }));
process.exit(0);
```

### Step 4 -- `src/docker.test.ts`

- The `stub` helper (`:88-99`): record `unix: init?.unix` on each call (widen the `calls` element type).
- The "answers then wedges" loop (`:275-285`): after `await settleWithin(call(20), name)`, add
  `expect(calls.length).toBeGreaterThan(0); for (const c of calls) expect(c.unix).toBe("/var/run/docker.sock");`
  (the never-answers loop replaces `fetch` wholesale and records nothing; the wedged loop goes through
  `stub`, so it sees every call's `init`). One more line in "daemonReachable is true on a ping" (`:111-115`):
  `expect(calls[0]?.unix).toBe("/var/run/docker.sock");`.
- `:155` "the one call site of fourteen" -> "the one call site in the table below"; and the table's
  comment (`:219-224`) gains "D3 below keeps this table complete against the module's exports".
- New tests:

| # | Test | Pins |
|---|---|---|
| D1 | `daemon calls` / the `unix` assertions above (#459) | every stubbed call carries `unix: "/var/run/docker.sock"` |
| D2 | new `describe("the real transport (#459)")` / "the real fetch reaches a unix socket at BOT_DOCKER_SOCKET, and a hanging and a wedged call are both cut by the bound" | a temp dir named like the suite's own (`mkdtempSync(join(tmpdir(), `${TEST_DATA_PREFIX}${process.pid}-`))`, as `commandPrefix.test.ts:32` does, so the preload's sweep catches a leftover) and `const socket = join(dir, "d.sock")` (short: Linux caps a socket path near 108 bytes); `Bun.spawnSync([process.execPath, "test/dockerSocketChild.ts"], { cwd: <repo root>, env: { ...process.env, BOT_DOCKER_SOCKET: socket }, stdout: "pipe", stderr: "pipe", timeout: 20_000 })` inside `try`/`finally` with `rmSync(dir, { recursive: true, force: true })` (a child the timeout kills leaves the `.sock` file behind; the auditor reproduced that); exit 0 (else throw with stderr, as `commandPrefix.test.ts:52-57` does); parse the last stdout line: `ping === true`; `hang.ok === false` with `hang.message` matching `/timed out after 100ms/` and `hang.elapsedMs < 1_000`; the same three for `wedge`; test timeout `30_000`. Runs on both platforms (probed on Windows, both shapes; CI's Linux is the one that matters) |
| D3 | "the bound table names every exported daemon call" (#513 item 10) | `const mod = await import("./docker"); const asyncExports = Object.entries(mod).filter(([, v]) => typeof v === "function" && (v as Function).constructor.name === "AsyncFunction").map(([k]) => k).sort(); expect(asyncExports).toEqual(everyDaemonCall.map(([n]) => n).sort())` (reference `everyDaemonCall` from inside the describe where it lives; the test's comment says a daemon call written as a plain function returning `bounded(...)` would have to be added by hand) |
| D4 | `parseBuildOutput` / "a line that parses to null, a number or a string is noise, and an error after it is still reported" (#513 item 9) | `parseBuildOutput('null\n42\n"x"\n{"stream":"ok"}')` -> `{ ok: true }`; `parseBuildOutput('null\n{"error":"boom","errorDetail":{"message":"boom"}}')` -> `{ ok: false, error: "boom" }` |

### Step 5 -- comments and docs, in the same PR

- `src/restart.test.ts:202-204` (the sentence starts on `:202`; anchor on one line): "`beginHandoff()` is
  only ever called from inside exactly one withCritical (redeploy.ts:256, reached via checkForUpdate under
  withCritical in both announce.ts:225 and commands.ts:124)" -> "`beginHandoff()` is only ever called from
  inside exactly one `withCritical`: the one call site in `redeploy()`, reached via `checkForUpdate` under
  the `withCritical` of `announce.ts`'s `onTick` (which wraps the whole tick) and of `commands.ts`'s
  `/update` handler" (confirm both on your tree; no line numbers).
- `src/redeploy.ts:698-700` (three lines; anchor each Edit on one): "`bot-ops.sh restart`, the ops panel's
  Restart, a reboot, a daemon restart, or a crash loop under `unless-stopped` — all of them, forever, against
  an original that's long gone." -> "`bot-ops.sh restart`, a reboot, a daemon restart, or a crash loop under
  `unless-stopped` — all of them, forever, against an original that's long gone. (The ops panel's Restart is
  not one of these since #277: it is a `recreate`, compose `--force-recreate`, a fresh container with no
  `HANDOFF_FROM` at all.)"
- `ops/README.md:264` (the sentence listing the hand-set reserved core keys) and `CONTEXT.md:1323-1332`
  (the `RESERVED_KEYS` description): add `BOT_DOCKER_SOCKET` (#459, "set by nothing in a deployment: the
  compose file mounts the daemon at the default path; a test seam"). Read `ops/README.md:333-341` too and add
  it there only if that passage enumerates the keys.
- `CONTEXT.md` File Map rows and gotchas (after S1 is on `main`; grep each row on a short unique substring
  and anchor each Edit on one line's worth of text, never Read a long row by line range; there are no
  `test/*` rows in the File Map, so the fixture is described inside the `docker.test.ts` row, as
  `test/prefixedInstance.ts` is inside `commandPrefix.test.ts`'s):
  - `:184` (`src/restart.ts` row): "falls back to (not below) that live exemption" -> "falls back to or below
    that live exemption (`critical <= handoffExemption()`)".
  - `:186` (`src/restart.test.ts` row; #513 item 10): append the tests the row omits -- grep the file's
    `describe(`/`test(` names for `beginShutdown`, `stateForTest`, `onStopRequested` (#248) and add one clause
    each.
  - `:188` (`src/docker.ts` row; grep `Minimal Docker Engine API client`): "over `/var/run/docker.sock` via
    Bun's `fetch(url, { unix })`" -> "over `BOT_DOCKER_SOCKET` (`/var/run/docker.sock`; a test seam like
    `BOT_DATA_DIR`, never an operator knob, reserved in `bot-ops.sh`, cleared by the test preload, #459) via
    Bun's `fetch(url, { unix })`"; the export list gains `inspectContainer`/`tryInspectContainer` (404 ->
    `undefined`), `updateContainer` (the restart policy, #160), `inspectImage` and `STOP_TIMEOUT_SEC` (#513
    item 10's "omits newer exports"); "Pure `parseBuildOutput()` because `/build` answers **200 even when
    the build failed**, with the error buried in the JSONL stream" -> append " -- a line that is valid JSON
    but not an object (`null`) is skipped as noise (#513)". S1 adds `removeContainer`'s return to this row
    first; keep it.
  - `:189` (`src/docker.test.ts` row): "a **table driving all 14 exported daemon calls**" -> "a **table
    driving every exported daemon call** (a test compares the table with the module's async exports, #513)";
    append the real-transport child test (#459: `test/dockerSocketChild.ts`, spawned with `BOT_DOCKER_SOCKET`
    pointing at a `Bun.serve({ unix })` it starts itself -- the real `fetch` answers the ping, and a hanging
    and a wedged inspect are both cut by the bound) and the `parseBuildOutput` noise cases.
  - `:192` (`src/redeploy.ts` row, #513 item 11's third copy; S1 edits this row too, so after S1): "every
    later in-place restart of the swapped-in container (`bot-ops.sh restart`, the ops panel, a reboot, a
    crash loop)" -> "every later in-place restart of the swapped-in container (`bot-ops.sh restart`, a
    reboot, a crash loop; not the ops panel's Restart, which recreates since #277)".
  - `:457` (the Gotchas paragraph on the preload): if it lists what `test/setup.ts` sets and clears, add the
    `BOT_DOCKER_SOCKET` clear beside `COMMAND_PREFIX`; if it does not enumerate, leave it.
  - `:791-792` (the #46 gotcha; the quote wraps, anchor on one line): "(`bot-ops.sh restart`, the ops panel's
    Restart, a host reboot, a daemon restart, a crash loop under `unless-stopped`)" -> "(`bot-ops.sh restart`,
    a host reboot, a daemon restart, a crash loop under `unless-stopped`; not the ops panel's Restart, which
    since #277 is a `recreate` -- compose `--force-recreate`, a fresh container with no `HANDOFF_FROM` at
    all)".
  - `:928` (grep `commands.ts:124`): the stale "`commands.ts:124`/`:252`" cite -> name the two handlers by
    symbol (the `/update` handler and the `/plugins update` handler), as #513 item 10 asks.

### Coverage table

| Outcome | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| every daemon call goes over the unix socket | 1 | D1, D2 | M1: delete `unix: BOT_DOCKER_SOCKET` from `api()` (D1's `unix` undefined; D2's ping false: the child's fetch goes to TCP `http://docker`) |
| the socket path is the seam, with the documented default | 1, 2 | D1, D2 | M2: hard-code `"/var/run/docker.sock"` and ignore the env (D2 red: the child never reaches its own socket); M3: change the default string (D1 red) |
| an ambient `BOT_DOCKER_SOCKET` cannot reach the suite | 2 | D1 | M4: delete the `delete process.env.BOT_DOCKER_SOCKET` line, with `BOT_DOCKER_SOCKET=/x` exported in the mutation run's shell (D1's literal assertion red) |
| the key is reserved, so no manifest can claim it | 2 | the existing `ops/bot-ops.test.ts:3659` scan, which turns red the moment `docker.ts` reads an unreserved key | M5: drop the `RESERVED_KEYS` line (that scan red; runs on every platform, no bash needed) |
| a hanging and a wedged unix call are cut by the bound, for real | 1, 3 | D2 | M6: replace `bounded`'s `setTimeout`/`AbortController` with no signal at all (`api()` gets `undefined`): D2's child never prints, the spawn's 20 s timeout kills it (`exitedDueToTimeout`), red, not a hang |
| a non-object JSON line is noise | 1 | D4 | M7: delete the whole guard, or only its `=== null` half (the `null` line throws a TypeError); the `typeof` half alone is an equivalent mutant (decision 3) |
| the bound table covers every daemon call | 4 | D3 | M8: delete any one row of `everyDaemonCall`; M9: add `export async function pauseContainer(...)` without a row |
| the cites, the reserved-key lists and the restart list say what the code does | 5 | manual: reviewer B reads every edited sentence against the code | -- |

Run every mutation in a scratch copy (`git worktree add --detach <path> <sha>`), never in the tree the
tests or a reviewer are reading; D2 spawns one short child per run.

### Checks, gate, PR

- `bun run check`; `bunx tsc --noEmit -p ops/tsconfig.json`; `bun run check` inside `ops/admin/`;
  `bun test` from the repo root, then `bun test --randomize` once. D2 is the one test here whose
  production meaning is Linux's; name CI's run as the evidence for it. The PR is not ready until CI is green.
- Review gate: reviewer A on correctness and failure modes (the env read at import against the module's
  config-free rule; the socket path length on Linux; the child's `server.stop(true)` and exit; whether
  anything in production could ever set `BOT_DOCKER_SOCKET`; the `parseBuildOutput` guard against the classic
  builder's and BuildKit's real stream lines); reviewer B on claims-vs-code, walking the coverage table,
  every edited comment and the `CONTEXT.md` rows against the merged tree. Both read-only, both handed the
  merged tree and the two issues. Fix or decline every evidenced finding in writing; re-run the gate on the
  whole merged state after a behaviour fix.
- Branch `fix/525-S2-docker-transport`; commit and PR title
  `fix(docker): make the socket path a reserved test seam, pin the unix transport for real, and skip non-object build lines (#459, #513)`.
  Body: one line each `Closes #459`, `Closes #513`; `Part of #514 (item 5's restart.test.ts cite lands
  here)`; the pasted checks; the mutation rows; the gate's rounds; decisions 1-6 named as assumptions taken
  (decision 3's declined half, and that no `BOT_OPS_SCHEMA` bump is made and why, each in its own line); the
  merge-after-S1 note for the `CONTEXT.md` rows. After the merge, comment on #514 naming the PR and the item
  (do not close it). Do not merge.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot. Work in a NEW worktree, never the shared checkout:
  git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-525-S2 origin/main -b fix/525-S2-docker-transport
Issues: Rackbops/rackbops-discord-bot #459 #513 (sub-epic #525 of Epic #516). Read each issue body first.
Plan: docs/plans/epics/E516/525-S2-docker-transport.md on branch claude/525-plans:
  git -C S:\Repos\rackbops-discord-bot show origin/claude/525-plans:docs/plans/epics/E516/525-S2-docker-transport.md
Behaviour change: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Every mutation in a scratch worktree. S1 (another session) merges before you: do everything but step 5's CONTEXT.md edits, open the PR as a draft, and make those edits on S1's merged text once it is on main (tell the orchestrator if it is not). Scratch files: task-unique names (pr-body-525S2.md, commit-msg-525S2.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds and any deviation. Do not merge.
```
