<!-- Plan for #527 bundle U2 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #527): the plugin-update notice and
schedule path in `src/plugins/updates.ts` -- #440, #441, #442 (with its Low `plugin-updates-9`), #444, #501 items 4 and 8
(items 5 and 10 landed in U1 and are closed by reference), #502 items 12 and 14. Written by the orchestrating session on
2026-10-16 against main `bfb7d19`; every `file:line` below was read at that sha (`updates.ts` is unchanged since U1,
PR #562). Audited read-only before it was committed (round 1, Sonnet, which applied the production steps in a scratch
copy, typechecked them and ran the suite and the mutants): three blockers applied -- the mailbox `remind` request DOES
carry a version (`contract.ts:251`, `validate` requires it), so `remindLater`'s version is required and
`requests.test.ts:505`'s "skip then remind keeps the skip" flips, and `updates.test.ts:642`'s expected `scheduled`
gains the channel; "a restart tries again" after the give-up was false (`notifiedVersion` is persisted) and the text
and Decision 5 are corrected; five changed lines had no mutant (the `pluginStateReady` early return, the `continue`
after a drop, the dropped DM's snowflake guard and its `.catch`, and the `:654` pre-filter, now load-bearing against a
state write every minute) and have tests and rows now. Also applied: `CONTEXT.md:174`'s cadence sentence, the harness's
log capture, N8 as a composition test, #444's premise (the one-tick test already fails through the test-state guard,
at the review's own sha; N6 pins the later admin's DM by assertion), the release validator requires only the two
fields that can throw, and the boot blast radius of a stricter index is named with the live index checked. Round 2
(same auditor, the revised steps rebuilt in its scratch copy: typecheck clean, 2092 pass): one blocker -- the
required `version` breaks the two-argument `remindLater` call at `updates.test.ts:808` (a `tsc` error, not a test
failure) -- and three majors applied: the `droppedFor` capture and the validator's `url`/`notes` clauses each get a
killing test, "a scheduled rollback through the panel" is only reachable through the panel's API or
`bot-ops.sh plugin-request` (the UI offers only the latest version), and the #444 wording no longer blames the
guard's age. The implementer re-reads each anchor on the tree it works from. U3 (the list and report-back
rendering: #443, #501 item 11, #502 item 13, #563, #418) follows on the same files and waits for this PR. Nothing in
flight touches `updates.ts`, `plugins/index.ts` or the `pluginUpdates` check in `announce.ts`; D1a (#526) edits other
parts of `announce.ts`'s neighbours (`update.ts`, `index.ts`) and `CONTEXT.md` rows this bundle does not. -->

## Implementation plan -- #527 U2: validate releases, isolate one plugin's notice from the others, run due schedules every minute and after a failed notice pass, drop a schedule that is already installed, keep the no-admins notice for a later admin, and name the DM failure

Children: **#440** (closes), **#441** (closes), **#442** (closes, with `plugin-updates-9`), **#444** (closes), **#501**
items 4 and 8 (and items 5 and 10 closed by reference to U1's PR #562; item 11 stays for U3), **#502** items 12 and 14
(item 13 stays for U3). One PR, branch `fix/527-U2-notices-schedules`, worktree `S:\Repos\_wt\rdb-527-U2` cut from
`origin/main` at or after `bfb7d19`. Behaviour changes (a schedule that fires within a minute, a dropped schedule, a
validated index, a contract type gaining an optional field) -> the **three-reviewer gate** applies; every changed
production line mutation-tested in a scratch worktree.

### What is wrong, verified at `bfb7d19`

- **#440 (one malformed release stops every notice and every due schedule).** `entryProblem` checks only
  `Array.isArray(e.releases)` (`src/plugins/index.ts:84`); a release element that is `null` or lacks a string
  `version` is accepted and cached. `decidePluginUpdates` (`src/plugins/updates.ts:92-125`) calls `releasesBetween`
  (`:128-132`) for every plugin with a newer index version, which calls `compareSemver(r.version, …)` (`:130`) ->
  `splitPrerelease` (`:62-66`) -> `v.split` throws a `TypeError` on `undefined`. `checkPluginUpdates` (`:610-637`)
  throws before any notice is sent and before `runDueSchedules` (`:636`, the last line), so every 15 minutes
  (`src/announce.ts:264-270`) the whole pass dies: no notice for any plugin, no due schedule fires. `runTick` catches
  it per check (`announce.ts`), so the rest of the tick survives. The notice loop (`:614-635`) is not isolated per
  plugin either: a `mutateState` rejection for plugin A (`:621`) ends the pass before plugin B. `renderNotes` (`:139`)
  also reads `r.publishedAt.slice` and `r.notes` unguarded.
- **#441 (a fired schedule is never re-validated against the installed version).** `runDueSchedules` (`:647-698`)
  fires a schedule that exists, is due and still matches `to` (`:654`, `:662`) and sets `targetVersion = to`
  (`:675`); it never compares `to` with `cur.installedVersion`. `pinUpdateNow` (`:344-350`) leaves `scheduled` in
  place, and `buildPluginStateFile` carries `scheduled` across boots (`src/plugins/host.ts:1218`, `:1244`). So
  "schedule a to 1.1.0 for 18:00, then `/plugins update a` now" restarts again at 18:00 for nothing; and if 1.2.0 was
  installed meanwhile, `targetVersion = 1.1.0` out-ranks `installedVersion` in the installer
  (`src/plugins/install.ts:459`), a downgrade. Only `cancelPending` (`:377-392`) clears `scheduled`.
- **#442 (README says "at that time"; the code fires on the next 15-minute poll).** `runDueSchedules` has one caller
  (`:636`), inside `checkPluginUpdates`, which the `pluginUpdates` check runs only when `shouldPollPluginUpdates()`
  (`announce.ts:266`, `:323-326`: a flat 15-minute gap from `lastPluginPollAt`). A schedule at 03:00 fires between 03:00
  and about 03:16. `README.md:124`: "At that time the bot DMs a heads-up, restarts into the version, and reports back."
  `CONTEXT.md:371`: "the **same `pluginUpdates` tick** runs when due". `plugin-updates-9`: `now.getTime() <
  Date.parse(sched.at)` (`:654`, `:662`) is false for `NaN`, so a hand-edited `scheduled.at` that is not a date fires
  on the next poll; and `parseScheduleTime` (`:260-281`) accepts an ISO time already in the past (`:272-275`), so a
  year typo is "Scheduled for <past>" and fires at the next poll.
- **#444 (the no-admins test pins one tick).** `checkPluginUpdates` records a failure toward `MAX_DELIVERY_ATTEMPTS`
  (`:578`, 3) only when `deps.adminUserIds.length > 0` (`:622`), so with no admins nothing is recorded and a later
  admin still gets the notice (`deliverPluginNotification` returns `false` after a warn, `:527-530`). The test
  (`src/plugins/updates.test.ts:479-484`) runs ONE tick. Deleting the guard is not silent, and was not at the
  review's own sha either: the test-state guard fails that test ("1 failed notice delivery count(s) kept"; the
  guard's counter row, #392, is an ancestor of `4ff8eef`), so the review's "still passes" read the assertions, not the
  guard. What is true is that nothing asserts the property the test's name claims: that an admin added later gets the
  DM, and that the third no-admin poll does not call `markNotified`. `MAX_DELIVERY_ATTEMPTS` is not exported.
- **#501 item 4 (a remind after a skip is dead; a remind before the first notice is wiped).** `decidePluginUpdates`
  checks `skippedVersion` (`:110`) and `notifiedVersion` (`:111`) before `remindAt` (`:112`); `planPluginAction`'s
  remind branch (`:431-437`) requires only `hasNewer` and replies "I'll remind you", and `remindLater` (`:363-365`)
  sets only `remindAt`. After `/plugins skip a`, a `/plugins remind a` sets a snooze that `:110` ignores forever; a
  remind on a version not yet notified is followed by the next tick's notify, whose `markNotified` (`:593-600`) clears
  `remindAt`.
- **#501 item 8 (the DM failure's cause is dropped).** `deliverPluginNotification`'s DM catch (`:537-540`) logs
  "couldn't DM admin X … will try the announce channel" and discards `err`; the give-up line (`:628-630`) says only the
  attempt count. Closed DMs, Missing Access and a rate limit read the same.
- **#502 item 12 (a scheduled update's report-back has no channel fallback).** `scheduleUpdate` (`:353-360`) takes no
  channel; `runDueSchedules` builds the report with `channelId: undefined` (`:670`); `planPluginAction` has
  `ctx.channelId` (`:307`) at schedule time and uses it for update-now (`:456`). An admin with closed DMs who schedules
  an update gets neither the heads-up nor the outcome. `README.md:124` says the bot "reports back".
- **#502 item 14 (the arbiter's version and time re-checks are untested).** The harness's `cancelRace`
  (`updates.test.ts:383-403`) clears `scheduled`, which exercises only `!cur?.scheduled` at `:662`; deleting
  `cur.scheduled.version !== to` or the time re-check leaves the suite green.

### Decisions (defaults, named so the gate can contest them)

1. **A release element is validated like an entry, for the two fields that can throw:** an object with string
   `version` and `publishedAt` (`compareSemver` splits the first, `renderNotes` slices the second; `url` and `notes`
   are only printed, so when present they must be strings and when absent they render as today). One bad release
   makes the whole index unusable, the existing rule for a bad entry (`index.ts:94-98`), and the reason names the
   entry. Named consequence: with no valid cache a bad release now yields the empty index ("no plugins will load",
   `index.ts:140-150`) for every plugin, where before only the notice pass broke -- a stricter contract on the
   publisher. The live index (`Rackbops/rackbops-bot-plugins`'s `plugins.json`, 5 plugins, 30 releases at the time of
   the audit) passes the validator; the PR says so and the plugins repo's own CI is where a typo should be caught.
2. **One plugin's notice failure never stops the others, and due schedules run whatever the notice pass did:**
   the loop body is isolated per decision (logged, continue), and `runDueSchedules` moves into a `finally`.
3. **Due schedules are looked at on every 60 s tick, not only the 15-minute index poll:** `runDuePluginSchedules`
   is exported and the `pluginUpdates` check calls it when the poll gap has not elapsed (`checkPluginUpdates` still
   runs it in its `finally` on the poll tick, so nothing fires twice: the arbiter's `scheduled` delete makes the
   second look find nothing). One `readPluginState` per minute is the cost. README says "within a minute".
4. **A due schedule whose version is already installed, or older than what is installed, is dropped, not fired**,
   inside the serialized arbiter (so it cannot race an update-now), logged, and the requester is told by DM
   (best-effort, snowflake only) — the same wording rule as the heads-up. A schedule whose `at` is not a date is
   dropped the same way (corrupt state, logged). `pinUpdateNow` clears `scheduled`, so an update-now supersedes a
   schedule for the same plugin. `parseScheduleTime` rejects an ISO time in the past (the `HH:MM` form already rolls
   to tomorrow).
5. **The retry-cap exemption stays as it is and is pinned by a four-tick test** (`MAX_DELIVERY_ATTEMPTS` exported
   for the test). The DM failure's cause goes in the warn; the give-up keeps `markNotified` (the cap exists so an
   undeliverable notice stops retrying) and says that the warnings above carry the causes and that the plugins list
   still shows the update. A restart does NOT retry after the give-up: `notifiedVersion` is persisted, so the next
   boot's `decidePluginUpdates` answers `none` for that version (only the in-memory counter resets, and only below the
   cap); the text must not claim otherwise. "Back off instead of marking notified" (item 8's alternative) is declined:
   it would turn an in-memory cap into persisted state for a case the docs already describe.
6. **`remindLater` acknowledges the version it snoozes:** `remindLater(name, at, version)` -- the version is
   REQUIRED: the command path has `to`, and the mailbox `remind` request carries `version` too (`contract.ts:251`;
   `validate` requires it, `requests.ts:448-452`), so `requests.ts:512` passes `r.version`. It sets `notifiedVersion`
   to that version and clears `skippedVersion`. `decidePluginUpdates`' order is unchanged: the snooze then holds
   because `to === notifiedVersion`, a newer version still notifies, and a remind after a skip works -- which flips
   one existing mailbox test (`requests.test.ts:505`, "skip, remind and cancel for the installed version still apply":
   after skip 1.0.0 then remind 1.0.0 the skip is now GONE, a change of mind; the assertion becomes `toBeUndefined()`
   with that comment).
7. **`scheduled` carries the requesting channel:** `PluginStateEntry.scheduled` gains `channelId?: string`
   (`contract.ts:221`). This is an edit to the vendored contract file, deliberately compatible: an optional field on a
   host-only state type, no runtime code (`contract.test.ts` pins that), no `HOST_API_VERSION` change; the admin
   panel's own copy of the shape (`ops/admin/server.ts:830`, `:849`) ignores extra fields and needs no edit. Named in
   the PR body under "contract.ts" so the gate looks at it.
8. **The reschedule race is pinned through the harness**, as the cancel race is.

### Step 1 -- `src/plugins/index.ts`: release validation (#440)

`entryProblem` (`:70-92`), `:84` becomes:

```ts
  // #440: a release element's `version` is split by compareSemver and its `publishedAt` sliced by renderNotes; one that
  // is not an object with both as strings threw a TypeError inside the whole notice pass, every poll. `url` and
  // `notes` are only printed: strings when present, tolerated when absent (an absent `notes` prints as the word
  // "undefined" in the notice, as it does today; the live index carries both).
  if (
    !Array.isArray(e.releases) ||
    !e.releases.every((r) => {
      if (typeof r !== "object" || r === null) return false;
      const x = r as { version?: unknown; publishedAt?: unknown; url?: unknown; notes?: unknown };
      return (
        typeof x.version === "string" &&
        typeof x.publishedAt === "string" &&
        (x.url === undefined || typeof x.url === "string") &&
        (x.notes === undefined || typeof x.notes === "string")
      );
    })
  ) {
    return "releases is not a list of releases with a string version and publishedAt";
  }
```

(The position of the bad release is not named: the entry's name and position are, and the plugins repo's index has
few releases per entry. If the gate wants it, find the first failing index and append `releases[i]`.)

### Step 2 -- `src/plugins/contract.ts`

`:221`: `scheduled?: { version: string; at: string; requestedBy: string };` becomes
`scheduled?: { version: string; at: string; requestedBy: string; channelId?: string };` with the comment
`// channelId (#502): where the schedule was requested from, for the report-back's channel fallback; absent for a panel request`.
Check `src/plugins/contract.test.ts` still passes (it pins the file's shape, not this type).

### Step 3 -- `src/plugins/updates.ts`

3a. `parseScheduleTime` (`:272-275`): the ISO branch becomes

```ts
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:?\d{2}|Z)$/.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) {
      // #442 (plugin-updates-9): a time already behind us would fire on the next look; HH:MM rolls to tomorrow instead.
      if (ms <= now.getTime()) return { error: "That time has already passed — give a time in the future (HH:MM is the next such time)." };
      return { at: new Date(ms) };
    }
  }
```

3b. `pinUpdateNow` (`:344-350`): the entry mapper becomes `(e) => { const next = { ...e, targetVersion: version }; delete next.scheduled; return next; }`
with the docstring gaining "and drops a pending schedule for the plugin (#441): the update-now supersedes it, so a
later fire cannot restart for a version already installed".

3c. `scheduleUpdate` (`:353-360`) takes a fifth parameter `channelId?: string` and writes
`scheduled: { version, at, requestedBy, ...(channelId ? { channelId } : {}) }`; `planPluginAction` (`:448`) passes
`ctx.channelId`; `src/plugins/requests.ts:509` is unchanged (a panel request has no channel).

3d. `remindLater` (`:363-365`) becomes

```ts
/** Snooze the update reminder for `version` until `at` (ISO-8601). The snooze acknowledges that version (#501 item 4):
 *  `notifiedVersion` is set to it (so the next tick does not notify it and then wipe the snooze) and a
 *  `skippedVersion` is cleared (a remind after a skip is a change of mind, not a no-op). */
export function remindLater(name: string, at: string, version: string): (s: PluginStateFile) => PluginStateFile {
  return (s) =>
    updateEntry(s, name, (e) => {
      const next = { ...e, remindAt: at, notifiedVersion: version };
      delete next.skippedVersion;
      return next;
    });
}
```

`planPluginAction` (`:435`) passes `to`. `requests.ts:512` passes `r.version` (the `remind` request's required
version, `contract.ts:251`, `requests.ts:448-452`).

3e. `deliverPluginNotification` (`:537-540`): the warn becomes
`` log.warn(`[plugins] couldn't DM admin ${id} about a plugin update (${err instanceof Error ? err.message : String(err)}) — will try the announce channel`); ``
(#501 item 8). The give-up line (`:628-630`) becomes
`` `[plugins] gave up notifying about ${d.name} ${d.to} after ${attempts} attempts (the causes are in the warnings above) — recording it notified so it stops retrying; /plugins list still shows the update` ``
(no "a restart tries again": `notifiedVersion` is persisted, Decision 5). That string names `/plugins` after a space:
`commandNaming.test.ts` fails a bare `/plugins` in src/, so write it as `` `/${deps.pluginsCommand} list` `` (the
registered name the deps already carry, `:564`).

3f. `MAX_DELIVERY_ATTEMPTS` (`:578`) is exported (`export const`), with the comment unchanged.

3g. `checkPluginUpdates` (`:610-637`) becomes:

```ts
export async function checkPluginUpdates(deps: PluginUpdateDeps): Promise<void> {
  try {
    const index = await deps.loadIndex();
    const state = await deps.readState();
    const decisions = decidePluginUpdates(state, index, deps.hostApiVersion, deps.now());
    for (const d of decisions) {
      if (d.action === "none") continue; // already notified/skipped/scheduled, or a snooze not yet due
      try {
        await notifyOne(d, deps);
      } catch (err) {
        // #440: one plugin's failed notice (a rejecting save, a throwing deliverer) must not stop the others'.
        deps.log.error(`[plugins] update notice for ${d.name} ${d.to} failed — continuing with the other plugins`, err);
      }
    }
  } finally {
    // #440/#442: whatever the notice pass did (a bad index, a throwing save), a due schedule still runs. (A throw from
    // here would mask the pass's own error; runDuePluginSchedules catches nothing new, so the masking case is the one
    // that existed when the call sat after the loop.)
    await runDuePluginSchedules(deps);
  }
}

/** One decision's notice: deliver, and record it notified after a real delivery (or after the retry cap). */
async function notifyOne(d: PluginUpdateDecision, deps: PluginUpdateDeps): Promise<void> {
  const message = notificationMessage(d, deps.hostApiVersion, deps.pluginsCommand);
  const delivered = await deliverPluginNotification(message, deps.adminUserIds, deps.deliverers, deps.log);
  const key = `${d.name}@${d.to}`;
  if (delivered) {
    deliveryFailures.delete(key);
    await deps.mutateState((s) => markNotified(s, d.name, d.to));
  } else if (deps.adminUserIds.length > 0) {
    // ... the existing retry-cap block, unchanged apart from 3e's give-up text ...
  }
}
```

The docstring (`:602-609`) says: the notice pass, per plugin and isolated; THEN, in a `finally`, `runDueSchedules`;
and that the `pluginUpdates` check also runs `runDuePluginSchedules` on the ticks between index polls (#442).

3h. `runDueSchedules` (`:647-698`): RENAMED throughout to `runDuePluginSchedules` and exported (the docstring says it
is the every-tick entry point; 3g's `finally` and 4b call it by that name), and the arbiter gains two drops:

```ts
    let acted = false;
    let dropped: string | undefined; // #441 / plugin-updates-9: why the schedule was dropped instead of fired
    let droppedFor: string | undefined; // the requester as the arbiter saw it, not the pre-read `sched`
    await deps.mutateState((s) => {
      const cur = s.plugins.find((x) => x.name === p.name);
      // Re-check inside the serialized turn: a cancel that landed since the read wins.
      if (!cur?.scheduled || cur.scheduled.version !== to) return s;
      const atMs = Date.parse(cur.scheduled.at);
      if (Number.isNaN(atMs)) dropped = `its time ${JSON.stringify(cur.scheduled.at)} is not a date`;
      else if (now.getTime() < atMs) return s;
      else if (cur.installedVersion !== undefined && compareSemver(to, cur.installedVersion) <= 0) {
        // #441: an update-now, a pin or an earlier fire already installed this version or a newer one; firing would
        // restart for nothing, or set a `targetVersion` the installer ranks above the installed version — a downgrade.
        dropped = `${cur.installedVersion} is already installed`;
      }
      if (dropped !== undefined) {
        droppedFor = cur.scheduled.requestedBy;
        const plugins = s.plugins.map((x) => { if (x.name !== p.name) return x; const next = { ...x }; delete next.scheduled; return next; });
        return { ...s, plugins };
      }
      acted = true;
      const report: PluginStateFile["pendingReport"] = {
        plugin: p.name,
        toVersion: to,
        userId: cur.scheduled.requestedBy,
        channelId: cur.scheduled.channelId, // #502 item 12
        requestedAt: now.getTime(),
      };
      // ... unchanged: targetVersion = to, delete scheduled, pendingReport ...
    });
    if (dropped !== undefined) {
      deps.log.warn(`[plugins] ${p.name}: dropped the scheduled update to ${to} — ${dropped}`);
      if (droppedFor !== undefined && isDiscordUserId(droppedFor)) {
        await deps.deliverers
          .dmUser(droppedFor, `The scheduled update of **${p.name}** to ${to} was dropped: ${dropped}.`)
          .catch(() => {});
      }
      continue; // the next plugin's schedule may still be due
    }
    if (!acted) continue;
```

The outer due check (`:654`, `if (!sched || now.getTime() < Date.parse(sched.at)) continue;`) stays exactly as it
is: `now < NaN` is false, so a `NaN` schedule already reaches the arbiter today (probed), and the line is now
LOAD-BEARING -- without it the arbiter's `mutateState` would rewrite `state.json` every minute for every plugin with a
pending schedule (`mutatePluginState` always writes). It gets a mutant and an assertion (M22). Two consequences of the
drop to name in the docs and the PR: a mailbox `schedule` request to an OLDER version than installed (`validate`
refuses only equality, `requests.ts:478`) is now dropped at fire time -- reachable only through the panel's API
(`ops/admin/server.ts:1296` accepts any version) or `bot-ops.sh plugin-request`, since the panel's UI offers only a
plugin's latest version (`ops/admin/public/index.html:2986`, `:3019`) -- so a scheduled rollback asked for that way no
longer happens; and a mailbox schedule whose time is already past (which `validate` accepts, `requests.ts:454-456`)
now fires within about a minute instead of within 15.

### Step 4 -- `src/announce.ts`

4a. `:14`: `import { checkPluginUpdates, runDuePluginSchedules, type PluginUpdateDeps } from "./plugins/updates";`.

4b. The `pluginUpdates` check (`:263-270`) becomes:

```ts
      name: "pluginUpdates",
      run: async () => {
        if (!pluginStateReady) return;
        if (shouldPollPluginUpdates()) {
          lastPluginPollAt = Date.now(); // stamp at poll start, like checkReleases/checkAutoUpdate
          await checkPluginUpdates(livePluginUpdateDeps(client)); // the notice pass, then due schedules
        } else {
          // #442: a schedule fires within a minute of its time, not on the next 15-minute index poll.
          await runDuePluginSchedules(livePluginUpdateDeps(client));
        }
      },
```

The comment above it (`:260-263`) says both. `announce.test.ts:819-825` (#460: nothing before `markPluginStateReady`)
still holds: the early return is first.

### Step 5 -- docs

- `README.md:124`: old `At that time the bot DMs a heads-up, restarts into the version, and reports back.` -> new
  `Usually within a minute of that time (the bot looks every 60 seconds; a skipped tick can add one) it DMs a heads-up, restarts into the version, and reports back — by DM, or in the channel the schedule was made from when DMs are closed. A schedule whose version is already installed by then (you updated by hand, or a newer version landed) is dropped, not restarted for, and the requester is told by DM when there is one to tell (a panel-made schedule shows it in the log).`
- `CONTEXT.md:174` (the `announce.ts` row, one long line): the clause that describes the `pluginUpdates` check as
  "a 15-min-gap + startup-catch-up tick that runs `checkPluginUpdates` ... **and (#104) execute a due scheduled
  update**" (Grep `execute a due scheduled update`, one hit) gains, right after it, `` (since #442 the due-schedule
  half, `runDuePluginSchedules`, runs on every 60 s tick between index polls as well) ``. This is the only other
  cadence claim in README, `ops/README.md` or `CONTEXT.md` (the audit grepped).
- `README.md:119`: after `If DMs are closed it falls back to the announce channel once.` append ` (The log names why a DM failed.)` -- optional; skip if the gate calls it noise.
- `CONTEXT.md:371` (wrapped bullet; anchor the one line): old ``  `scheduled` entry that the **same `pluginUpdates` tick** runs when due (heads-up DM, then a restart).`` -> new ``  `scheduled` entry that the `pluginUpdates` check runs when due — looked at on every 60 s tick (`runDuePluginSchedules`), not only the 15-minute index poll (#442) — heads-up DM, then a restart; a schedule whose version is already installed, or whose time is not a date, is dropped inside the arbiter and the requester told (#441).`` (reflow the bullet).
- `CONTEXT.md:221` (the `updates.ts` row, one long line): append `` **#440/#441/#442/#444/#501/#502:** one plugin's failed notice is logged and the others still go out, and `runDueSchedules` runs in a `finally` and on every tick; a due schedule already installed (or older) is dropped, `pinUpdateNow` drops a pending schedule, a past ISO time is refused; `remindLater(version)` acknowledges the version and clears a skip; the DM failure's cause is logged; `scheduled.channelId` gives the report-back its channel fallback; `MAX_DELIVERY_ATTEMPTS` exported for the four-tick no-admins test.``
- `CONTEXT.md:222` (the `updates.test.ts` row): append the new tests in one clause (named below).
- `CONTEXT.md`'s `plugins/index.ts` row (Grep ``| `src/plugins/index.ts` |``): add "a release element must be a `{ version, publishedAt, url, notes }` of strings (#440)" beside the existing validation clause.
- `CONTEXT.md:1324-1327` (the off-plugin gotcha) is unchanged in meaning; re-read it and leave it.

### Step 6 -- tests

**`src/plugins/index.test.ts`:** in the `#496` describe (beside the env case, `:138-144`; there is no existing
"releases is not a list" case), five new rejections (a `null` element; a release with a numeric `version`; one with
a non-string `publishedAt`; one with `url: 5`; one with `notes: null`) each producing a reason containing
`releases is not a list of releases with a string version and publishedAt` and naming the entry, and two acceptances
(a full release; a release with no `url`/`notes`).

**`src/plugins/updates.test.ts`** (the harness at `:376-420` gains `rescheduleRace?: { version?: string; at?: string; requestedBy?: string }`,
applied like `cancelRace` before the first mutate; `mutateStateError?: (call: number) => Error | undefined`; and it
RECORDS the log: `warns: string[]`, `errors: string[]` filled by the `log` seam and returned, since N1, N3, N5 and N7
assert on their text). One existing call changes shape: `:808` `remindLater("a", "2026-02-02T00:00:00Z")(seed())` in
"skipVersion / scheduleUpdate / remindLater pin the given values" gains a third argument (`"1.1.0"`) and the test
asserts the `notifiedVersion` it now writes -- without it `bun run check` fails (TS2554), while the test itself still
passes at runtime.

- **N1 (#440, isolation):** two plugins with newer versions; `mutateStateError` rejects the FIRST mutate (plugin a's
  `markNotified`) -> plugin b is still DMed and recorded notified; `errors` has one line naming `a`.
- **N2 (#440/#442, `finally`):** the real trigger, not a seam: the harness's `loadIndex` returns an index whose entry
  for plugin a (newer version) has `releases: [null]` (the harness bypasses `loadPluginIndex`'s validation, as a cached
  pre-validation index would), and plugin b has a due schedule -> `checkPluginUpdates` rejects with the `TypeError`
  AND `restarts` has one entry naming b, b's `targetVersion` set (the schedule fired regardless).
- **N3 (#441):** a due schedule to `1.1.0` with `installedVersion: "1.1.0"` -> no restart, `scheduled` gone,
  `targetVersion` undefined, one warn containing `dropped the scheduled update to 1.1.0 — 1.1.0 is already installed`,
  one DM to the requester containing `was dropped`. The same with `installedVersion: "1.2.0"` (older target).
  `installedVersion: "1.0.0"` still fires (the existing `:514-525` test). **N3b:** two plugins in ONE call, a's
  schedule moot and b's due -> exactly one restart, whose reason names b (the loop continues past a drop). **N3c:** a
  moot schedule with `requestedBy: "email:me@x.com"` -> `dms` empty (no DM to a panel identity). **N3d:** a moot
  schedule for a whose `dm` throws, and b due -> `checkPluginUpdates` resolves (the DM's failure is swallowed) and b
  still restarts.
- **N4 (#441, builders):** `pinUpdateNow` on an entry with `scheduled` -> `scheduled` gone (extend `:810-818`).
- **N5 (plugin-updates-9):** `scheduled.at: "garbage"` -> dropped (no restart, `scheduled` gone, warn says
  `is not a date`); `parseScheduleTime("2020-01-01T00:00:00Z", now)` -> `error` containing `already passed`;
  `"2026-09-05T12:00:00.000Z"` (equal to `now`) -> error too; one second later -> `at`.
- **N6 (#444):** `adminUserIds: []`, run `MAX_DELIVERY_ATTEMPTS + 1` ticks -> `dms` empty, `notifiedVersion`
  undefined, `pluginUpdateStateForTest().deliveryFailures === 0`; then `h.deps.adminUserIds.push("admin1")` and one
  more tick -> `dms` is `["admin1"]` and `notifiedVersion` is set. Replace the one-tick test at `:479-484`.
- **N7 (#501 item 8):** `dm` throws `new Error("Cannot send messages to this user")` -> the `warn` line contains that
  text; after the third tick the `error` line contains `the causes are in the warnings above`.
- **N8 (#501 item 4), a composition test:** `remindLater("a", AT, "1.1.0")(skipVersion("a", "1.1.0")(state))`
  -> `remindAt: AT`, `notifiedVersion: "1.1.0"`, `skippedVersion` gone; then `decidePluginUpdates` on that state with
  the index at 1.1.0 gives `none` at NOW (the snooze holds) and `remind` at AT + 1 s; `remindLater(...)` on an
  un-notified entry gives `none` at NOW (before this change the next tick notified it and wiped the snooze);
  `planPluginAction({ kind: "remind", days: 3 }, ctx)`'s `mutate` applied to a skipped entry clears the skip and sets
  `notifiedVersion` to `ctx.latestVersion` (pins that the remind branch passes `to`). The existing `:644-647` remind
  test keeps passing. In **`src/plugins/requests.test.ts`**: `:505` flips to `expect(h.state.plugins[0]?.skippedVersion).toBeUndefined()`
  with the comment "a remind after a skip is a change of mind (#501 item 4)", and a new case pins that a mailbox
  `remind` request sets `notifiedVersion` to the request's version (kills "the mailbox drops `r.version`").
- **N9 (#502 item 12):** `scheduleUpdate("a", "1.1.0", AT, SNOWFLAKE, "chan1")` writes `scheduled.channelId: "chan1"`;
  `planPluginAction({ kind: "update", at }, { ...ctx, channelId: "chan1" })` -> the mutate writes it; a due schedule
  with `channelId: "chan1"` -> `pendingReport.channelId === "chan1"`. The existing `:642` expectation
  (`toEqual({ version, at, requestedBy: "admin1" })`) gains `channelId: "chan1"`, since `base()` carries that channel.
- **N10 (#502 item 14):** `rescheduleRace: { version: "1.2.0" }` -> no restart, `scheduled.version === "1.2.0"` kept,
  `targetVersion` undefined; `rescheduleRace: { at: "2026-09-05T18:00:00.000Z" }` (later than NOW) -> no restart,
  schedule kept. **N10b (the dropped DM's recipient):** a moot schedule (installed `1.1.0`, scheduled `1.1.0`) whose
  `rescheduleRace: { requestedBy: "300000000000000000" }` swaps the requester before the arbiter runs -> the dropped
  DM goes to the NEW requester and to nobody else (`dms` is exactly `["300000000000000000"]`): the arbiter's view
  of the schedule, not the pre-read one, names the recipient.
- **N11 (#442, announce.ts):** in `src/announce.test.ts`, beside the #460 tests (`:819-825`): write
  `data/plugins/state.json` under the test `DATA_DIR` (the shape `readPluginState` reads; `host.ts`'s
  `writePluginState`/`readPluginState` and L1's T3b in `commands.test.ts` show how) with a plugin whose `scheduled.at`
  is in the past, `markPluginStateReady()`, `setExitFn` stub, `fetch` stubbed to reject (so `loadPluginIndex` falls
  back to an empty index; spy `warn`/`error`/`log`, since it warns), `resetPollStateForTest()`; run the
  `pluginUpdates` check once with NO due schedule in the file (the poll tick: stamps `lastPluginPollAt`), then rewrite
  the file with the due schedule and run the check again within the gap -> `exits` has `RESTART_EXIT_CODE` and the
  file's entry has `targetVersion` set: the schedule fired between polls. **N11b (the ready gate):** the same setup
  with `markPluginStateReady()` NOT called and the due schedule on file from the start, two calls -> `exits` empty
  and the file's `scheduled` still there (neither branch runs before the boot write). Clean up:
  `resetPollStateForTest` (it also clears `pluginStateReady`, `announce.ts:414-420`; the guard resets it after every
  test too), `resetRestartForTest`, the `setExitFn` restore, the file. If the `{} as Client` deps throw on the heads-up
  DM, that is caught (`:691-693`); use a fake client with `users.fetch` rejecting if the typing needs one.
- **N12 (the `:654` pre-filter):** the existing "a schedule not yet due is left untouched" (`:538-547`) gains
  `expect(h.mutations).toHaveLength(0)` (the arbiter must not run, and so not write, for a schedule that is not due).

### Mutation table (run in a scratch worktree, never in the shared tree)

```bash
git -C /s/repos/rackbops-discord-bot worktree add --detach /s/Repos/_wt/rdb-527-U2-mut fix/527-U2-notices-schedules
cd /s/Repos/_wt/rdb-527-U2-mut && bun install --frozen-lockfile
```

Run `bun test src/plugins/updates.test.ts src/plugins/index.test.ts src/plugins/requests.test.ts src/announce.test.ts src/plugins/contract.test.ts src/commandNaming.test.ts` per mutant (M23's killer is in `requests.test.ts`; the bare-text mutant of the give-up line is the scan's).

| # | Mutation (production line, after the steps) | Test that must fail |
|---|---|---|
| M1 | step 1: restore `if (!Array.isArray(e.releases))` alone | index.test.ts's three rejections |
| M2 | 3g: remove the inner try/catch (let the throw out of the loop) | N1 (b not notified) |
| M3 | 3g: move `await runDuePluginSchedules(deps)` back after the loop, outside `finally` | N2 (no restart) |
| M4 | 4b: delete the `else` branch | N11 (second run does nothing) |
| M5 | 3h: delete the `compareSemver(to, cur.installedVersion) <= 0` drop | N3 (fires) |
| M6 | 3h: `<= 0` -> `< 0` | N3's equal case (fires) |
| M7 | 3b: `pinUpdateNow` keeps `scheduled` | N4 |
| M8 | 3h: delete the `NaN` drop | N5 (fires) |
| M9 | 3a: delete the past-time rejection | N5's `already passed` cases |
| M10 | 3g/notifyOne: `} else if (deps.adminUserIds.length > 0) {` -> `} else {` (count every miss) | N6 (third tick records notified; no DM for the later admin) |
| M11 | 3e: the warn without the cause | N7 |
| M12 | 3h: `channelId: undefined` again | N9 (report has no channel; the fallback is not posted) |
| M13 | 3h: delete `cur.scheduled.version !== to` | N10's version case (fires) |
| M14 | 3h: delete `else if (now.getTime() < atMs) return s;` | N10's later-time case (fires) |
| M15 | 3d: `remindLater` ignores `version` | N8 |
| M16 | 3h: the dropped-schedule DM deleted | N3 (no DM) |
| M17 | 3h: `dropped` set but the schedule not deleted from `s` | N3 (`scheduled` still there) |
| M18 | 4b: `if (!pluginStateReady) return;` dropped, the `else` branch kept (`if (pluginStateReady && shouldPoll...) {...} else { runDue... }`) | N11b (the schedule fires before the boot write) |
| M19 | 3h: the `continue` after a drop -> `return` | N3b (b never fires) |
| M20 | 3h: `isDiscordUserId(droppedFor)` -> `true` | N3c (a DM to an email identity) |
| M21 | 3h: the dropped DM's `.catch(() => {})` removed | N3d (`checkPluginUpdates` rejects; b never fires) |
| M22 | `:654`: the pre-filter deleted (every schedule reaches the arbiter) | N12 (`mutations` not empty) |
| M23 | 3d: `remindLater` ignores its `version` (passing none at `requests.ts:512` is a `tsc` error now, not a runtime mutant) | the new `requests.test.ts` case, and `:505` as flipped |
| M24 | 3h: `droppedFor = cur.scheduled.requestedBy` -> the pre-read `sched.requestedBy` | N10b (the DM goes to the old requester) |
| M25 | step 1: the `url`/`notes` "string when present" clauses -> `true` | index.test.ts's `url: 5` and `notes: null` rejections |

### Coverage table

| Bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| #440: a malformed release is refused at the index; one plugin's failed notice does not stop the others; a due schedule fires after a failed notice pass | 1, 3g | index.test.ts, N1, N2 | M1, M2, M3, M25 |
| #441: a fired schedule already installed is dropped (and the Discord requester the arbiter saw told, best-effort); the walk goes on; an update-now drops the schedule | 3b, 3h | N3, N3b, N3c, N3d, N4, N10b | M5, M6, M7, M16, M17, M19, M20, M21, M24 |
| #442: a schedule fires within a minute, only once the boot write has landed and only when due; README and CONTEXT say so; a non-date `at` is dropped; a past ISO time is refused | 3a, 3h, 4, 5 | N11, N11b, N12, N5 | M4, M8, M9, M18, M22 |
| #444: the no-admins exemption is pinned across the cap, and the later admin's DM asserted | 3f, N6 | N6 | M10 |
| #501-4: a remind acknowledges its version and clears a skip, on the command and the mailbox path | 3d | N8, the `requests.test.ts` case and the flipped `:505` | M15, M23 |
| #501-8: the DM failure's cause is logged | 3e | N7 | M11 |
| #502-12: a scheduled update's report-back can fall back to the channel | 2, 3c, 3h | N9 | M12 |
| #502-14: the arbiter's version and time re-checks are pinned | harness | N10 | M13, M14 |

### Verification

```bash
bun install --frozen-lockfile
cd ops/admin && bun install --frozen-lockfile && cd ../..
bun run check
bunx tsc --noEmit -p ops/tsconfig.json
cd ops/admin && bun run check && cd ../..
bun test src/plugins/updates.test.ts src/plugins/index.test.ts src/plugins/contract.test.ts src/plugins/requests.test.ts src/announce.test.ts src/commands.test.ts src/commandNaming.test.ts test/stateGuard.test.ts
bun test --randomize src/plugins/updates.test.ts src/announce.test.ts
bun test
```

`requests.test.ts` is in the list because `remindLater`/`scheduleUpdate` changed shape and one of its expectations
flips; `commands.test.ts` because `/plugins remind` goes through `planPluginAction`; `commandNaming.test.ts` must be
run too (the give-up text names the plugins command through `deps.pluginsCommand`). The `README.md:124` substring:
Grep before editing (one hit) and after (none; the sentence is replaced). The `CONTEXT.md:174` anchor
`execute a due scheduled update` stays after the edit (the new clause is appended after it): Grep before (one hit)
and after (still one, now followed by the new parenthesis). The full `bun test` is slow here (about 8 minutes); run it in the
background and paste its tail. Not verifiable here: a real Discord DM refusal's message text (the warn prints whatever
discord.js throws).

### Acceptance to paste per issue

- **#440:** index.test.ts's new cases, N1 and N2 pass lines; M1, M2, M3 failing output.
- **#441:** N3 and N4 pass lines; M5 and M7 failing output; the drop's log line and DM text.
- **#442:** N11 and N5 pass lines; M4, M8, M9 failing output; the new `README.md:124` sentence.
- **#444:** N6's pass line and M10's failing output.
- **#501 (items 4 and 8; 5 and 10 closed by reference to #562):** N8 and N7 pass lines; M15 and M11. Comment on
  #501 naming the PR, the two items, the two closed by reference, and that item 11 is U3's.
- **#502 (items 12 and 14):** N9 and N10 pass lines; M12, M13, M14. Comment on #502 that item 13 is U3's.

### PR

- Title: `fix(plugins): validate index releases, isolate one plugin's notice, run due schedules every minute and after a failed pass, drop a schedule already installed, pin the no-admins exemption, and name a DM failure (#440, #441, #442, #444, #501, #502)`.
- Body: one line per item, Decisions 1-8 (Decision 7 under its own "contract.ts" heading; Decision 1's blast radius
  and the live-index check; the two behaviour notes from 3h: a scheduled rollback asked for through the panel's API
  or `bot-ops.sh plugin-request` no longer fires, and a past-time mailbox schedule fires within a minute), the three
  existing expectations that change and why (`updates.test.ts:642` and `:808`, `requests.test.ts:505`), the typecheck
  + test output, the mutation table. End with
  `Closes #440. Closes #441. Closes #442. Closes #444.`; #501 and #502 "Part of".
- After merge: tick #440 #441 #442 #444 on #527; comments on #501/#502.

### Out of scope, on purpose

- #443, #501 item 11, #502 item 13, #563, #418: U3, same files, after this PR.
- #417, #419, #480, #481: the request-mailbox set (`requests.ts`), its own bundle; #480 item 7 after #449 (#526).
- Backing off instead of marking an undeliverable notice as notified (Decision 5).
