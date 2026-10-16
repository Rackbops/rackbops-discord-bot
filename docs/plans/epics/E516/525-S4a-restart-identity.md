<!-- Plan for sub-epic #525 of Epic #516 (Rackbops/rackbops-discord-bot), bundle S4a: the fallback restart path
and the bot's own identity. Written by the orchestrating session on 2026-10-16 against `main` @ `cccd683`; audited
read-only against that tree before it was committed (10 findings, all applied: the deferral deadline is 30 minutes
and exempts an active handoff, the state-guard edits name the right files, the redeploy harnesses move to a 12-hex
HOSTNAME). Every file:line below was read from that tree; the implementer re-reads each one on the tree it works
from and corrects any that moved. -->

## Implementation plan -- #525 bundle S4a: a deferred restart has a deadline, a shutdown owns the exit, and `inspectSelf` checks it is looking at itself

Children: **#512 items 2, 4, 6 and 8** (item 5, `docker-restart-5`, lands in bundle S3a; this PR closes #512 once
S3a is in — say so in the body and let the orchestrator close it). One PR. Behaviour changes in `restart.ts`
and `docker.ts`, so the **three-reviewer gate** applies: you plus two read-only adversarial reviewers, up to
four rounds; every changed line mutation-tested in a scratch worktree.

**Prerequisite: S2 merged** (`fix/525-S2-docker-transport`, PR #554): it edits `src/docker.ts` (the socket
constant), `src/docker.test.ts` (its D1-D4 tests), `src/restart.test.ts:202-204` and the `CONTEXT.md`
`docker.ts`/`restart.ts`/`restart.test.ts` rows. Branch from `origin/main` once it is in. S1 and S3a edit
`src/redeploy.test.ts` around the three `HOSTNAME` constants this bundle changes (step 4, last table); if they
have landed, re-anchor; if they land after you branch, the conflict is one line each and `SELF_SHORT_ID` wins.

### What is wrong, verified at `cccd683`

- **`inspectSelf` accepts any 200 as itself** (#512 item 2). `src/docker.ts:141-156`: the hostname leg
  (`:147-151`) returns whatever `GET /containers/<HOSTNAME>/json` answers with, and only a non-ok status
  reaches the mountinfo leg (`:152-154`). The docstring (`:133-140`) says mountinfo covers the case where a
  pinned `hostname:` resolves "to some other container that happens to be called that"; it does not. A
  compose file with `hostname:` set to a sibling's name or id prefix makes the bot build from the sibling's
  spec with `HANDOFF_FROM` = the sibling, and a verified replacement then stops and removes the sibling. The
  verifier rated it Low (a contrived misconfiguration; the shipped compose pins no hostname) and the comment
  misleading.
- **A deferred restart has no deadline** (#512 item 6). `requestRestart` (`src/restart.ts:276-283`) sets
  `pending` and waits for `critical` to reach 0 (`endCritical`, `:168-170`); nothing bounds that wait, unlike
  `awaitCriticalIdle`'s timer (`:255-269`). While it waits, `restartPending()` is true (`:229-231`), so no new
  tick starts and the mailbox drain stops: the bot serves interactions with all scheduled work silently
  stopped, for as long as any critical section stays open. No unbounded section is known today; the deadline
  is defence in depth, and the log line it writes is the diagnosis. Legitimate sections are LONG, though:
  a scheduler tick is one section (`announce.ts:301`) and can hold a whole `redeploy()` — a build bounded at
  15 minutes (`docker.ts:40`), then a handoff of up to about 11 minutes (verify, retirement, cleanup) during
  which `restart.ts:203-205` says this process must never exit itself; the mailbox drain waits up to 5
  minutes (`drain.ts:26`); the `pluginRequests` wait 2 (`announce.ts:291`). A restart can be requested inside
  any of them (`commands.ts:264-272` runs `/plugins update … now` during a handoff, `update.ts:258` refuses
  only `/update`; `plugins/updates.ts:663` fires mid-tick).
- **A requested restart skips `dispose()`/`destroyClient`, and a SIGTERM mid-section with a restart pending
  exits before the drain** (#512 item 4). `doExit` (`:285-288`) is `process.exit(75)`. The dispose and
  gateway-close sequence lives only in `shutdown.ts`'s handler. And `endCritical` calls `doExit(pending)`
  BEFORE `maybeResolveIdle()` (`:170`, `:174`), so when a shutdown is already draining (`beginShutdown`,
  `:240-244`) and a restart is pending, the section's close exits 75 at once and the handler never gets to
  `disposePlugins`/`destroyClient`. The verifier: the behaviour is real; `contract.ts:425-` scopes `dispose()`
  to a `docker stop`, a self-update's retire and SIGINT, so no document is false; process exit frees the
  resources anyway.
- **`restart.test.ts` pins less than it looks** (#512 item 8): every exit assertion compares to the imported
  `RESTART_EXIT_CODE` (`:42`, `:51`, `:61`, `:69`), so `:25` could change and README's published 75 would be
  false with the suite green; the timeout test (`:246-254`) says "nothing left listening" and asserts only
  `idle === false`; the `Math.max(0, …)` clamp (`:169`) has no test.

### Decisions (defaults, named so the gate can contest them)

1. **The hostname leg verifies identity; mountinfo is the tiebreaker, not the default.** The order stays
   hostname-first (every test harness in the repo stubs `/containers/<HOSTNAME>/json`, and the common
   production case, no `hostname:` in compose, is a 12-hex short id that is its own proof). After a 200: if
   `HOSTNAME` matches `/^[0-9a-f]{12}$/`, the answer is self only if `res.Id.startsWith(HOSTNAME)` — no
   mountinfo read at all; otherwise (a pinned hostname) read `/proc/self/mountinfo` and, when it parses to an
   id, the answer is self only if that id equals `res.Id`. A mismatch falls through to the mountinfo leg as
   it stands, so a 12-hex mismatch with no parseable mountinfo ends in the existing "cannot determine own
   container id" error (D7), and the no-`HOSTNAME` leg's unreadable-mountinfo failure becomes that same error
   instead of a raw ENOENT. A pinned hostname whose mountinfo cannot be read (Windows, not Docker) or does
   not parse (a plain VM) is accepted as today. So an operator whose `container_name` and `hostname` are the
   same word still works, a sibling's name does not, and nothing changes for the short-id case. The reader is
   an injectable parameter (default `Bun.file("/proc/self/mountinfo").text()`), read at most once per call,
   so the tests do not swap `Bun.file` the way `docker.test.ts:306-312` does. The three `redeploy.test.ts`
   harnesses pin `HOSTNAME = "self-container-id"` (`:494`, `:609`, `:754`), not 12-hex, so on their 200 the
   real mountinfo would be read: harmless on Windows (the read rejects) and on CI's runner VM (`ci.yml:12`,
   no container line), but red for anyone running the suite inside a container (a devcontainer, `oven/bun`),
   whose mountinfo names the test container and mismatches `SELF.Id`. They move to `SELF_SHORT_ID`
   (`redeploy.test.ts:25`, the first 12 of `SELF.Id`), which takes the prefix path and reads nothing.
2. **A deferred restart exits after `RESTART_DEFERRAL_MAX_MS` = 30 minutes, and never while a handoff is
   active.** `requestRestart(reason, deferralMaxMs = RESTART_DEFERRAL_MAX_MS)` arms a ref'd timer when it
   defers. When it fires: a shutdown in progress → do nothing (decision 3); `handoffActive()` → log and re-arm
   for another `deferralMaxMs` (the original must stay alive through a handoff, `restart.ts:203-205`; a
   handoff that fails closes its section and exits normally, one that succeeds ends this process anyway);
   else log the depth and the reason and `doExit`. Thirty minutes: the longest legitimate section is a tick
   that runs a self-update, 15 minutes of build (no handoff flag yet, #130 moved `beginHandoff` past the
   build) plus a handoff the exemption covers; the mailbox drain's 5 minutes and the plugin waits sit far
   inside it. So a restart requested at the start of a build waits for the build, then for the handoff, then
   exits as soon as the section closes; only a section that is genuinely stuck ever sees the timer fire, and
   the log says at which depth. `doExit`, `beginShutdown` and `resetForTest` clear the timer.
3. **A shutdown in progress owns the exit.** `endCritical` runs `doExit(pending)` only when `!shuttingDown`;
   `requestRestart`'s immediate branch (`critical === 0`) also exits only when `!shuttingDown`, and arms no
   timer during a shutdown (unreachable today — every caller holds a section — but the rule is stated once).
   With a shutdown draining, the section's close resolves the drain (`maybeResolveIdle`) and `shutdown.ts`'s
   handler goes on to `disposePlugins`, `destroyClient` and `exit(0)` (`index.ts:121`; a drain that times out
   also ends in `exit(0)`, `shutdown.ts:154`). Exit 0, not 75: a SIGTERM means something external wants the
   process gone, and under `unless-stopped` the container stays stopped either way; nothing in `index.ts` or
   `update.ts` relies on 75 after a SIGTERM. The existing test at `restart.test.ts:345-351` ("a shutdown
   notifies too, and a later restart request does not notify again") expects `[75]` from that immediate
   branch; it now expects no exit, and its comment says why.
4. **A requested restart still does not run `dispose()`; this is documented, not changed.** Routing `doExit`
   through the shutdown sequence would mean a 75 that waits up to `SHUTDOWN_GRACE_MS` behind a drain, a
   second code path through `disposePlugins`/`destroyClient` to keep in step with the handler, and a
   behaviour `contract.ts` never promised (`:425-`: `dispose()` runs on a `docker stop`, a self-update's
   retire, SIGINT). `contract.ts` is not edited (the plugins repo vendors it byte-identical). The sentence
   goes in `CONTEXT.md`'s `restart.ts` row and the shutdown gotcha, and on #512 as the declined half of item
   4, for roshne to overrule.
5. **The pins** (#512 item 8): `RESTART_EXIT_CODE` is 75 by value, next to a comment naming README (`:84`,
   `:104`) and `.env.example:39` as the places that publish it; the timeout test asserts `idleWaiters` is 0
   afterwards; an unmatched `endCritical` leaves `critical` at 0 and a following `beginCritical` +
   `requestRestart` still defers (the observable the clamp protects: without it `critical` would be -1 and
   the next section would not count).

### Step 1 -- `src/docker.ts:133-156`

```ts
/**
 * Inspect the container this process is running in.
 *
 * Hostname first: Docker sets it to the short container id, and the daemon resolves a short id
 * fine — one request, no parsing. But a 200 is not proof (#512): a `hostname:` pinned in the compose
 * file may resolve to nothing, or to some other container that happens to be called that. So the answer
 * is checked: a short-id hostname must be a prefix of the returned id; any other hostname is compared
 * with the id in this process's own mountinfo when that can be read and parsed (Docker bind-mounts
 * `/etc/hostname` from `…/containers/<id>/…`, so the id is spelled out there even under cgroup v2).
 * A mismatch, like a non-ok answer, falls through to the mountinfo leg. Where mountinfo cannot be read
 * (not Docker) or names no container (a plain host), a pinned hostname's answer stands, as before.
 */
export async function inspectSelf(
  timeoutMs = DEFAULT_TIMEOUT_MS,
  readMountinfo: () => Promise<string> = () => Bun.file("/proc/self/mountinfo").text(),
): Promise<ContainerInspect> {
  // ONE bound across both attempts, not one each. (… keep the existing paragraph …)
  return bounded(timeoutMs, "inspect self", async (s) => {
    const host = process.env.HOSTNAME;
    let mountinfoRead = false;
    let mountinfoId: string | undefined;
    const ownId = async () => {
      if (!mountinfoRead) {
        mountinfoRead = true;
        try {
          mountinfoId = parseContainerId(await readMountinfo());
        } catch {
          mountinfoId = undefined;
        }
      }
      return mountinfoId;
    };
    if (host) {
      const res = await api(`/containers/${encodeURIComponent(host)}/json`, s);
      if (res.ok) {
        const answer = (await res.json()) as ContainerInspect;
        const isSelf = /^[0-9a-f]{12}$/.test(host)
          ? answer.Id.startsWith(host)
          : ((await ownId()) ?? answer.Id) === answer.Id;
        if (isSelf) return answer;
        console.warn(`[docker] HOSTNAME ${host} resolved to another container (${answer.Id.slice(0, 12)}); using mountinfo`);
      }
    }
    const id = await ownId();
    if (!id) throw new Error("cannot determine own container id (not running under Docker?)");
    return (await (await ok(`/containers/${encodeURIComponent(id)}/json`, s)).json()) as ContainerInspect;
  });
}
```

`parseContainerId` (`:128-131`) is unchanged. `inspectSelf(t)` call sites pass only the bound
(`docker.test.ts:227`), so the new parameter is additive. `bounded()` hands `fn` its own signal, which `api`
and `ok` take as their second argument, as today.

### Step 2 -- `src/restart.ts`

- After `RESTART_EXIT_CODE` (`:25`):

  ```ts
  /** The longest a requested restart waits for in-flight work before exiting anyway (#512): a deferred
   *  restart stops every new tick and mailbox drain (`restartPending`), so a critical section that never
   *  closes would leave the bot serving interactions with all scheduled work silently stopped. Thirty
   *  minutes sits above the longest legitimate section — a tick running a self-update's 15-minute build —
   *  and an active handoff is exempt outright (the original must stay alive through it); so only a stuck
   *  section ever sees this fire, and the log names its depth. Ref'd, like `awaitCriticalIdle`'s timer. */
  export const RESTART_DEFERRAL_MAX_MS = 30 * 60_000;
  ```

  and beside `pending`: `let deferralTimer: ReturnType<typeof setTimeout> | undefined;`.
- `requestRestart`:

  ```ts
  export function requestRestart(reason: string, deferralMaxMs = RESTART_DEFERRAL_MAX_MS): void {
    if (pending !== undefined) return;
    pending = reason;
    notifyStop(reason);
    if (shuttingDown) return; // the shutdown handler owns the exit (#512)
    if (critical === 0) {
      doExit(reason);
      return;
    }
    console.log(`[restart] deferred until in-flight work finishes: ${reason}`);
    armDeferral(reason, deferralMaxMs);
  }

  function armDeferral(reason: string, deferralMaxMs: number): void {
    deferralTimer = setTimeout(() => {
      deferralTimer = undefined;
      if (shuttingDown) return;
      if (handoffActive()) {
        // Never exit the original mid-swap (see beginHandoff): wait another round; the handoff's own end
        // closes the section, or ends this process.
        console.warn(`[restart] in-flight work has not finished after ${deferralMaxMs}ms, but a handoff is active — waiting on it`);
        armDeferral(reason, deferralMaxMs);
        return;
      }
      console.error(`[restart] in-flight work did not finish within ${deferralMaxMs}ms (critical depth ${critical}); exiting anyway`);
      doExit(reason);
    }, deferralMaxMs);
  }
  ```

- `endCritical`: `if (critical === 0 && pending !== undefined && !shuttingDown) doExit(pending);` with a
  comment: a shutdown already draining owns the exit (decision 3); `maybeResolveIdle()` lets it proceed.
- A private `clearDeferral()` (clears and unsets the timer), called first in `doExit`, in `beginShutdown`
  (say why) and in `resetForTest`. `RestartStateForTest`/`stateForTest` gain `deferralArmed: boolean`
  (`deferralTimer !== undefined`).
- The header comment (`:1-22`) gains two sentences: the deadline and its handoff exemption, and that a
  shutdown owns the exit; the `requestRestart` docstring (`:271-275`) too.
- The test-state guard (read these before editing; `test/stateGuard.ts` itself needs no change):
  `test/stateLeaks.ts:29-41` gets `if (s.deferralArmed) leaks.push("restart.deferralArmed")` in the shape of
  its neighbours; `test/stateGuard.test.ts`: `CLEAN_RESTART` (`:51-59`, typed `RestartStateForTest`) gains
  `deferralArmed: false`, the `rows` list (`:67-75`) gains a row, and `allDirty` (`:91-100`) expects 8 leaks,
  not 7; `src/restart.test.ts:284-292`'s `toEqual({...})` gains the field.

### Step 3 -- docs, in the same PR

- `CONTEXT.md` (grep each row on a short substring; one writer per row — S2 edits the `docker.ts`,
  `restart.ts` and `restart.test.ts` rows, so branch after it): the `src/docker.ts` row (`inspectSelf`: the
  identity check); the `src/restart.ts` row (`requestRestart`: the 30-minute deadline with the handoff
  exemption; a shutdown owns the exit; a requested restart does not run `dispose()`, by contract, #512 item 4
  declined); `:429-433` (the list of guarded `restart.ts` fields: add `deferralArmed`); the shutdown gotchas
  at `:939-960` (grep `destroyClient`): the pending-restart case now drains instead of exiting first; the
  `src/docker.test.ts` and `src/restart.test.ts` rows (the new tests).
- Comments that say the wait is unbounded: `src/update.ts:243-247` ("held until any in-flight announcement
  and state write finish" — add "bounded by `RESTART_DEFERRAL_MAX_MS`, a handoff exempt"),
  `src/announce.ts:343-345` (the same), `README.md:258` ("deferred past in-flight announcements" — add the
  bound in a clause).
- `README.md:84`/`:104` and `.env.example:39` already say 75; no change. Add nothing to `contract.ts`.

### Step 4 -- tests

`src/docker.test.ts` — a new describe NESTED inside `describe("daemon calls")` (`:84-433`, where `stub`,
`calls` and the fetch-restoring `afterEach` live), named "inspectSelf checks it is looking at itself (#512)";
import `spyOn` from `bun:test`; each test sets `process.env.HOSTNAME` and restores it in a `finally`
(`:306-322`'s shape) and injects `readMountinfo` as the second argument:

| # | Test | Pins |
|---|---|---|
| D1 | "a short-id hostname whose answer carries another id falls back to mountinfo" | `HOSTNAME=abcdef012345`; stub: `/containers/abcdef012345/json` → 200 `{ Id: "f".repeat(64) }`, `/containers/<"a".repeat(64)>/json` → 200 `{ Id: "a".repeat(64) }`; `readMountinfo` → a line with `"a".repeat(64)`, counting its calls; result `Id` is `"a".repeat(64)`; `calls` has both GETs in that order; the reader was called ONCE; `console.warn` spied, called once |
| D2 | "a short-id hostname whose answer matches is accepted without reading mountinfo" | `HOSTNAME=abcdef012345`; answer `Id: "abcdef012345" + "0".repeat(52)`; `readMountinfo` throws if called; result is the answer; one GET |
| D3 | "a pinned hostname that resolves to a sibling is rejected when mountinfo names another id" | `HOSTNAME=bot`; answer `Id: "f".repeat(64)`; `readMountinfo` → `"a".repeat(64)` line; result `Id` is `"a".repeat(64)`; two GETs; the reader called once |
| D4 | "a pinned hostname whose answer is this very container is accepted" | `HOSTNAME=bot`; answer `Id: "a".repeat(64)`; `readMountinfo` → the same id; result is the answer; one GET |
| D5 | "no readable mountinfo accepts a pinned hostname's answer, as before" | `HOSTNAME=bot`; `readMountinfo` rejects (ENOENT); result is the answer; one GET |
| D6 | "a mountinfo with no container line accepts it too" | `readMountinfo` → `"1 1 0:1 / / rw"`; one GET |
| D7 | "a rejected hostname answer and no mountinfo id is the existing error" | `HOSTNAME=abcdef012345`, answer another id, `readMountinfo` → no container line; rejects `/cannot determine own container id/` |
| D8 | the existing `:303-326` fallback test moves to the injected reader (no more `Bun.file` swap) | unchanged expectations |

`src/redeploy.test.ts`: the three `HOSTNAME = "self-container-id"` constants (`:494`, `:609`, `:754`) become
`SELF_SHORT_ID` (decision 1); the stub paths that use them follow. No other change in that file.

`src/restart.test.ts`:

| # | Test | Pins |
|---|---|---|
| R1 | "the exit code the supervisor contract publishes is 75" (#512 item 8) | `expect(RESTART_EXIT_CODE).toBe(75)`, with a comment naming README.md and .env.example |
| R2 | `:246-254`: add `expect(stateForTest().idleWaiters).toBe(0)` after the timed-out wait | the resolver was spliced |
| R3 | "an unmatched endCritical never drives the depth negative" | `endCritical()` on a clean state; `stateForTest().critical === 0`; then `beginCritical(); requestRestart("t")` → `exits` empty (deferred); `endCritical()` → `[75]` |
| R4 | "a deferred restart exits anyway once the deferral deadline passes, and says so" | `beginCritical(); requestRestart("t", 20)`; `exits` empty and `stateForTest().deferralArmed === true`; `await Bun.sleep(60)`; `exits` is `[RESTART_EXIT_CODE]`; `deferralArmed === false`; `console.error` (spied) once containing `did not finish within 20ms` and `depth 1` |
| R5 | "a section that closes in time exits once and disarms the deadline" | `beginCritical(); requestRestart("t", 20); endCritical()` → `[75]`; `deferralArmed === false`; `await Bun.sleep(60)` → still one exit |
| R6 | "a shutdown in progress owns the exit: a pending restart's section closing does not exit, it releases the drain" | `beginCritical(); requestRestart("t"); beginShutdown("SIGTERM"); const idle = awaitCriticalIdle(1000); endCritical()` → `exits` empty; `await idle` is `true` |
| R7 | "a shutdown that begins while a deferral is armed disarms it" | `beginCritical(); requestRestart("t", 20)`; `deferralArmed === true`; `beginShutdown("SIGTERM")`; `deferralArmed === false` at once; `await Bun.sleep(60)` → `exits` empty |
| R8 | "requestRestart's default deadline is the reviewed value, and is what the timer is armed with" | `RESTART_DEFERRAL_MAX_MS === 30 * 60_000`; `spyOn(globalThis, "setTimeout")`, `beginCritical(); requestRestart("t")`, the spy's last call's delay equals `RESTART_DEFERRAL_MAX_MS`; `endCritical()` and restore the spy |
| R9 | "the deadline elapsing under an active handoff does not exit; it waits, and fires once the handoff has ended" | `beginCritical(); beginHandoff("redeploy"); requestRestart("t", 20); await Bun.sleep(60)` → `exits` empty, `console.warn` contains `a handoff is active`, `deferralArmed === true`; `endHandoff(); await Bun.sleep(60)` → `exits` is `[75]` |
| R10 | "resetForTest disarms a deferral" | `beginCritical(); requestRestart("t", 20); resetForTest(); await Bun.sleep(60)` → `exits` empty |
| R11 | `:345-351` ("a shutdown notifies too, and a later restart request does not notify again"): the expectation becomes no exit (the shutdown owns it); the listener-count assertion stays | `exits` empty |

`test/stateGuard.test.ts`: the `deferralArmed` row (step 2).

### Coverage table

| Outcome | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| a short-id hostname's answer must carry that id | 1 | D1, D2 | M1: drop the `startsWith` check (D1: the sibling is returned) |
| a pinned hostname's answer is checked against mountinfo when it parses | 1 | D3, D4 | M2: drop the `ownId` comparison (D3 red) |
| mountinfo is read at most once per call | 1 | D1, D3 | M3: drop the `mountinfoRead` latch (the reader is called twice in D1) |
| no mountinfo, or none parseable, accepts as before | 1 | D5, D6 | M4: treat an unreadable mountinfo as a mismatch (D5 red) |
| the rejected case ends in the existing error | 1 | D7 | M5: return the sibling when mountinfo has no id |
| a deferred restart has a deadline, armed with the reviewed value | 2 | R4, R5, R8 | M6: delete the `setTimeout` (R4); M7: never clear the timer in `doExit` (R5: two exits); M8: `RESTART_DEFERRAL_MAX_MS = 60_000` (R8); M9: a literal delay in `armDeferral` (R8's spy) |
| an active handoff is exempt | 2 | R9 | M10: drop the `handoffActive()` branch (R9: an exit at the first sleep) |
| a shutdown owns the exit | 2 | R6, R7, R11 | M11: drop `!shuttingDown` in `endCritical` (R6: an exit); M12: drop the clear in `beginShutdown` (R7: `deferralArmed` still true); M13: drop the `shuttingDown` return in `requestRestart` (R11) |
| `resetForTest` disarms | 2 | R10 | M14: drop the clear in `resetForTest` |
| a leaked deferral is a reported leak | 2 | `test/stateGuard.test.ts`'s new row | M15: drop the `stateLeaks.ts` line |
| the published exit code | 2 | R1 | M16: `RESTART_EXIT_CODE = 76` |
| the timeout test cleans up | 2 | R2 | M17: delete the `splice` in `awaitCriticalIdle` |
| the depth never goes negative | 2 | R3 | M18: `critical -= 1` without the clamp |
| the docs say what the code does | 3 | manual: reviewer B reads every edited sentence against the code | -- |

Run every mutation in a scratch copy (`git worktree add --detach <path> <sha>`), never in the tree the tests
or a reviewer are reading. Paste the red test's name per row in the PR.

### Checks, gate, PR

- `bun run check`; `bunx tsc --noEmit -p ops/tsconfig.json`; `bun run check` inside `ops/admin/`;
  `bun test` from the root, then `bun test --randomize` once (the restart timers are real; keep R4, R5, R7,
  R9 and R10 under 150 ms each). CI's Linux run is the evidence for the `ops/*` suites that skip here.
- Gate: reviewer A on correctness (the four `HOSTNAME` × answer × mountinfo combinations; every
  `inspectSelf` caller and harness — grep `HOSTNAME` under `src/**/*.test.ts` and `test/` — on Windows, on
  a runner VM and inside a container; the deferral timer against a restart requested before, during and
  after a handoff, and against a 15-minute build with no handoff flag; the shutdown-owns-the-exit rule
  against `shutdown.ts`'s handler when the drain times out; a ref'd timer and the test runner); reviewer B
  on claims-vs-code (every edited comment, `CONTEXT.md` rows, the coverage table, the declined half of item
  4 as stated on #512). Both read-only, both handed the merged tree and #512.
- Branch `fix/525-S4a-restart-identity`; title
  `fix(restart): bound a deferred restart, let a shutdown own the exit, and make inspectSelf verify its answer (#512)`.
  Body: `Part of #512 (items 2, 4, 6, 8; item 5 lands in S3a — close #512 once both are in)`, `Part of
  #525`; the pasted checks; the mutation rows; the gate's rounds; decisions 1-5 as assumptions taken,
  decision 2's thirty minutes and decision 4 (the declined half of item 4) each in their own paragraph.
  Do not merge.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot. Work in a NEW worktree cut from origin/main AFTER S2 (PR #554) is merged, never the shared checkout:
  git -C S:\Repos\rackbops-discord-bot fetch origin && git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-525-S4a origin/main -b fix/525-S4a-restart-identity
Issue: Rackbops/rackbops-discord-bot #512 (items 2, 4, 6, 8; sub-epic #525 of Epic #516). Read its body and comments first.
Plan: docs/plans/epics/E516/525-S4a-restart-identity.md on branch claude/525-plans:
  git -C S:\Repos\rackbops-discord-bot show origin/claude/525-plans:docs/plans/epics/E516/525-S4a-restart-identity.md
Behaviour changes in restart.ts and docker.ts: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Every mutation in a scratch worktree. Scratch files: task-unique names (pr-body-525S4a.md, commit-msg-525S4a.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds and any deviation. Do not merge.
```
