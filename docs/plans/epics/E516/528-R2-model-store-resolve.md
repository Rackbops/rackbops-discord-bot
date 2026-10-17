<!-- Plan for #528 bundle R2 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #528): the model/store/resolve half
of the routing core and the one `storage.ts` seam it rests on -- #415, #416, #477 (items 1, 2, 3, 4, 6), #478 (items
7, 9, 10, 11, 12), #479, and #484 item 6's remaining half (closed by the same fix as #477 item 1). Written by the
orchestrating session on 2026-10-16; every `src/routing/*` and `src/storage.ts` `file:line` below was read at main
`ea4fdda` (unchanged at `922b567`; `CONTEXT.md` sits a few lines lower after #586, so re-find by the quoted text).
Audited read-only before it was committed (a Sonnet agent, Steps 1-5 applied to a scratch copy, the tests authored,
2,246 pass / 0 fail, three randomized runs, 30-odd mutants); every finding was applied: Step 2 as first written
deleted `isRecord` (four uses in `validatePluginRouting`) and left an unused import, so the deletion range is now
exact; four existing tests the first draft never named break under Step 4a (`store.test.ts:61-78`, the two CI-only
secrets cases `:461-475`/`:477-491`, `model.test.ts:475-478`) and are rewritten in Step 7; the `keptCorrupt` guard
wiring is spelled out (`storageStateForTest`, `storageLeaks`, a `GUARDED` row, `live.test.ts`'s `afterEach`); S3
asserted something false (a bad server entry leaves `music: { servers: {} }`, it does not erase the plugin); T2 and T3
were vacuous (Bun quotes only the first bare identifier, so the unquoted-URL seed never leaked the token) and S2 failed
under no mutant, so T2/T3 are rebuilt on a bare-token seed and S2 is dropped; `keptCorrupt` is forgotten on a good
parse so a second corruption episode is said again; four mutation holes gained tests (the `kept` snapshot count, the
sweep's swallowed unlink failure, the destinations message branches, a `destinations: [..]` fixture); Decision 7 now
rests on the one fact that holds (the replacement writes nothing before `takeOver` returns); Decision 8's anchor,
Step 6's consumer list (`src/interactionLog.ts:17` imports `shown`; `model.ts` no longer does) and eight line anchors
were corrected. Round 2 (the same scope rebuilt on a fresh copy of `fe16563`, 28 mutants, all killed): no blocker;
the forget-on-success had to cover the move-aside branch too (corrupt, read, write, corrupt again was silent); the
#478-12 prose still claimed "one writer by construction"; `store.test.ts` needs the `resetKeptCorruptForTest()`
afterEach as well; S3b needs an increasing `Date.now` stub (a constant clock lets the guard-less mutant survive); two
mutant credits (M3c, M11) were wrong; the thenable attach needs its own guard to compile; six anchors moved at
`fe16563` -- all applied. Landing order: R3 depends on this bundle's `ReadJsonOptions`; R2 lands before R3. R1 (`528-R1-register-live.md`) adds an optional key to `DiscoveryFile` in `model.ts:109-119`; this
bundle edits `model.ts:17` (the import) and `:279-364` (`droppedByRepair`): different lines, merge main and keep both
whichever lands second. R3 edits `discovery.ts`'s `readDiscovery` and `src/routing/requests.ts`; this bundle touches
neither. Nothing in flight touches these files. -->

## Implementation plan -- #528 R2: a parse failure no longer renames the routing files on a plain read, a repair that drops something keeps a copy before the first write, the leak tests see what they claim to, `shown` and `clip` get one home, and the store docs say what the code does

Children: **#415** (closes), **#416** (closes), **#477** (closes: items 1, 3, 4 fixed; item 2 and item 6 fixed as
docs plus tests; item 2's fail-closed repair declined in writing), **#478** (closes: items 7, 9, 10 fixed; item 11 and
item 12 fixed as docs, their "decide whether"/"advisory lock" halves declined in writing), **#479** (closes: the sweep
fixed; the `fsync` declined in writing per #510), **#484** item 6's remaining half (closed by reference to item 1's
fix here; items 5 and 7 are R1's, 1 and 2 R3's). One PR, branch `fix/528-R2-model-store-resolve`, worktree
`S:\Repos\_wt\rdb-528-R2` cut from `origin/main` at or after `922b567`. Behaviour changes (what a corrupt file does on
read, a copy kept before a write, a thenable refused, a sweep at boot) -> the **three-reviewer gate** applies; every
changed production line mutation-tested in a scratch worktree. `ROUTING_VERSION` and the file shapes do not change.

### What is wrong, verified at `ea4fdda`

- **#477 item 1 / #484 item 6 (a plain read renames a routing file that will not parse).** `readRouting`
  (`store.ts:127-131`), `readSecrets` (`:169-171`) and `readDiscovery` (`discovery.ts:187-191`) go through
  `readJsonOrFresh` (`storage.ts:145-160`; docstring `:133-144`), which on a `SyntaxError` calls `moveCorruptAside` (`:110-119`): the file
  is renamed to `.corrupt-<ms>` and the read returns fresh. For `routing.json` that means a hand edit with a trailing
  comma, read next by `gateCommand`, an announcement or a join (`store.ts:47-50`), is moved away on that read:
  `hasPlacements` goes false, `commandAllowed` allows everything, every restriction is lifted, and the operator's
  file is a `.corrupt-` copy they have to find. #553 fixed the other half (EACCES/EIO/EMFILE no longer rename; they
  rethrow, `storage.ts:157-158`, classified at `:127-131`); a parse failure still does. #484 item 6's remainder: `moveCorruptAside` renames
  `path` unconditionally, so a `guildJoined` read of a corrupt `routing.json` can rename the valid file a panel
  `routing-set` wrote between the failed `json()` and the `renameSync` -- a window that exists only because a READ
  renames at all.
- **#477 item 3 (every write writes the repaired model back, with no copy).** `mutateRouting` (`store.ts:160-167`)
  repairs in and out and writes, for every caller -- the panel's requests and the bot's own `markWebhookBroken`
  (`post.ts:185-189`, on a webhook 404) alike -- so a hand-seeded entry the repair drops (a server entry with `commands: "All"`) is
  dropped from the file by the next write of any kind -- the plugin is left as `{ servers: {} }`, placed nowhere -- with only the once-per-process warn `readRouting` said
  (`:96-112`) as a trace; only an UNPARSEABLE file gets a `.corrupt-` copy. The gotcha (`CONTEXT.md:1653-1655`) says
  "anything a panel write (`mutateRouting`) repairs — that path is silent and writes the repaired file back", which
  names one caller of several.
- **#477 item 4 (a damaged secrets file's parse error is logged raw).** `moveCorruptAside` logs `${reason}` =
  `String(err)` (`storage.ts:111`); `mutateSecrets`'s read (`store.ts:231`) and `readSecrets` reach it with the
  `routing-secrets` label; Bun's `SyntaxError` quotes the first bare identifier it meets (`Unexpected identifier
  "https"`, probed on Bun 1.4.2 -- an unquoted URL leaks only `https`), so a hand-edited `routing.secrets.json` holding
  a bare token value (`{ "a": SECRETTOKEN123 }`) puts that token in `console.error`. The mailbox path is redacted
  (`src/plugins/requests.ts:196`, `withoutQuotedText`, used at `:288`); this path is not.
- **#415 (`droppedByRepair` quotes a destination value; the docs say only `postTo`; the leak fixture has no
  destinations).** `model.ts:338` emits `destination ${shown(name)} -> ${shown(channel)}` -- a VALUE -- while the
  docstring (`:284-290`: "with one exception, never a value", the exception being `postTo`), `CONTEXT.md`'s `model.ts`
  row (`:225`, "the one value shown is a bad `postTo`") and the gotcha (`:1646`, "nothing else a person typed is
  quoted") say otherwise; the "URL everywhere" fixture (`model.test.ts:557-572`) carries no `destinations`, so
  replacing `shown(channel)` with `${channel}` at `:338` leaves every test green (today `shown`'s 37-character clip
  ends before a webhook token starts, so nothing leaks; unpinned).
- **#477 item 6 (the report-vs-repair table does not cover destinations).** `leftOut` (`model.test.ts:616-`) has no
  destinations branch and none of the fixtures (`:608-`) has destinations; `CONTEXT.md:1657-1658` ("so the report
  and the repair cannot drift") and `model.ts:294-295` overclaim for that branch; the only pins are the three
  hand-written asserts at `:781-788`. Also not in the docstring's "NOT reported" list (`:297-299`): a non-string
  `broken`, `updatedAt` or `updatedBy` is dropped silently.
- **#477 item 2 (a bad plugin-level entry makes the plugin UNPLACED, not "nowhere").** `repairPlugin` returns
  `undefined` for a plugin whose entry is not an object with a `servers` object (`model.ts:176`), so `repairRouting`
  stores nothing for it (`:258-259`), `isPlaced` is false, and the plugin lives in the home server with no channel
  restriction (`resolve.ts:47`); if it was the only entry, `hasPlacements` flips false and the bot registers in single
  mode. The warn says "plugin X is not an object with a servers object; it is ignored" and the gotcha
  (`CONTEXT.md:1640-1643`) covers only a bad SERVER entry ("lives nowhere").
- **#416 (`CONTEXT.md` says nothing reads a stored webhook URL to post with).** The `store.ts` row (`:227`) ends
  "and nothing yet reads a URL back to post with"; `postForPlugin` reads `deps.readSecrets()` and hands the URL to
  `executeWebhook` (`post.ts:80`, `:94`), wired live at `index.ts:244` (at `fe16563`). False since #243.
- **#478 item 7 (the leak test's capture cannot see a URL in an object or an `Error` property).**
  `secrets-leak.test.ts:85`: `a instanceof Error ? \`${a.name}: ${a.message}\` : String(a)` -- an object argument is
  `[object Object]`, an `Error`'s `path` is never searched; a future `console.error("x", { url })` passes the test.
  No production line in `src/routing` does that today (`store.ts:106`, `:245` are template strings), so it is
  test strength, not a leak.
- **#478 item 9 (a thenable passes `requireFile` and empties the file).** `requireFile` (`store.ts:143-149`)
  refuses non-objects; a `Promise` is `typeof "object"`, so an `async` mutate callback (a cast or an untyped caller)
  returns one, `repairRouting(promise)` is a fresh file, and that is written: every placement (or every webhook URL,
  `mutateSecrets`) erased. The comment (`:138-141`) admits it and relies on the type checker.
- **#478 item 10 (`model.ts` and `resolve.ts` import each other; stale lists).** `model.ts:17` imports the VALUE
  `shown` from `./resolve`; `resolve.ts:19` imports `DESTINATION_NAME_RE` and types from `./model`. It works because
  `shown` is a hoisted function declaration and neither module runs the other's export at load; a top-level use on
  either side would be a TDZ error that depends on load order. `model.ts:1-4` calls itself "types and pure repair
  functions only"; `resolve.ts:5-7` lists four consumers while `host.ts:14`, `live.ts:29`, `store.ts:27`,
  `model.ts:17` and `src/plugins/requests.ts:33` import from it too; `CONTEXT.md`'s `resolve.ts` row (`:226`) omits
  `destinationChannel` and `mappedDestinations`.
- **#478 item 11 (placement is registration-level; dispatch and announcements do not enforce it).**
  `commandAllowed` (`resolve.ts:123-141`) allows a plugin in a server with NO entry for it (`:134`), so a command still
  registered in a server the plugin is not placed in (a stale list, which R1's #420 empties) runs; `announceTargets`
  (`:72-89`) returns the default channel for a plugin placed nowhere (`servers: {}`). Both are tested as intended;
  `resolve.ts:9-13` and `CONTEXT.md:1592-1598` say "lives nowhere"/"take this plugin out of every server" without
  saying what that does and does not cover.
- **#478 item 12 (two containers share the volume during a handoff; the queues serialize one process).**
  `store.ts:37-44`'s mutator and `mutateSecrets`'s per-path chain (`:185-187`, `:249-253`) serialize within one
  process. What keeps the two containers apart is ONE fact: the replacement writes nothing until `takeOver` has
  stopped the original (Decision 7 has the anchors). The original's side is weaker than it looks -- `beginHandoff`
  does not await in-flight work, so a `markWebhookBroken` can still write from the original during the overlap and
  a SIGKILL at `graceMs` can cut it mid-write -- and no comment says either thing.
- **#479 (no `fsync`; orphan `.tmp`/`.corrupt-` copies of URLs are never swept).** `mutateSecrets` writes a temp
  file and renames (`store.ts:234-241`) with no `fsync`; a kill between write and rename leaves
  `routing.secrets.json.<uuid>.tmp` holding a live URL (the catch unlinks it only when the write itself threw,
  `:238-240`), which a later `webhook-remove` does not touch; `secrets-leak.test.ts:265`'s "nothing else remembers
  it" holds on the success path only. The repo's stance on `fsync` is written down: `storage.ts:135-138` and
  `state.ts:112` (#510) accept power loss as outside the temp+rename contract (`CONTEXT.md` has no `fsync` text;
  `storage.ts:57-61` says only that there is one implementation of temp+rename).

### Decisions (defaults, named so the gate can contest them)

1. **A plain read never renames.** `readJsonOrFresh` gains an options argument `{ onCorrupt?: "move-aside" | "keep"; redactReason?: boolean }`
   (default `"move-aside"`, `false`: every existing caller unchanged). With `"keep"` a parse failure logs ONCE per
   path per process -- "`<path>` will not parse (<reason>); acting on a fresh <label> until it is fixed or the next
   write replaces it" -- and returns `fresh()` with the file left in place; the path is forgotten again on a
   successful parse, on an absent file, AND when the write path moves it aside, so a SECOND corruption episode
   after a fix or after a repairing write is said once more (today every
   episode is said, because the file is moved each time; the once-guard must not regress that). `readRouting` and `readSecrets` pass
   `"keep"` (and R3 does the same for `readDiscovery`); the WRITE paths (`createKeyedJsonMutator.update`'s read,
   `storage.ts:211`, and `mutateSecrets`'s, `store.ts:231`) keep `"move-aside"`: they run inside the serialized
   write, the rename there is ordered with every other write to that path (which closes #484 item 6's window: no
   read outside the queue renames any more), and the write that follows is what replaces the file -- so the evidence
   is kept exactly when it would otherwise be overwritten. The degradation on a corrupt `routing.json` is unchanged
   (fresh in memory: no placements, everything allowed, said in the log); what changes is that the operator's file
   stays where they put it until a write, and a read can no longer rename a file a write just produced.
2. **The first write that repairs something away keeps a copy.** Inside `mutateRouting`'s callback (the only place
   that sees the raw read, `store.ts:164`): if `droppedByRepair(current).length > 0` and no copy has been kept for
   this path in this process, copy the file as it is to `routing.json.before-repair-<ms>` (`copyFileSync`; a
   failure to copy is logged and the write goes ahead -- a copy is a courtesy, the write is the request) and log
   "`routing.json` held entries the repair drops; the file as it was is kept at <copy>". Once per path per process
   (a set, reset by `resetRoutingWarningsForTest`), so a file with a permanent bad entry does not grow a copy per
   write. "Refuse to write while `droppedByRepair` is non-empty" (the issue's other option) is declined: it would
   make one hand-typo block every panel change and every `markWebhookBroken`.
3. **The secrets file's parse error is never quoted:** `readSecrets` and `mutateSecrets` pass `redactReason: true`,
   under which both the keep-log and `moveCorruptAside`'s line print `err.name` ("SyntaxError") and nothing of the
   message. The routing file keeps the full reason (its contents are not secret, and the position helps).
4. **A thenable is refused by `requireFile`** ("mutate must return the whole file, not a Promise (an `async` callback?);
   nothing was written"), beside the existing non-object refusal.
5. **`shown` and `clip` move to `src/routing/text.ts`** (with `REPLACEMENT_CHARACTER`); `resolve.ts` and `model.ts`
   re-export them (`export { shown } from "./text"`, `export { clip } from "./text"`), so all 23 uses (11 outside
   `model.ts`/`resolve.ts`/`text.ts`, 7 in `model.ts` -- 6 `shown`, 1 `clip` -- and 5 in `resolve.ts`) compile unchanged, and `model.ts` no longer imports from `resolve.ts` (the cycle is gone;
   `resolve.ts` -> `model.ts` for types and the constant remains, one direction). A source test pins that `model.ts`
   has no import from `./resolve` and that `text.ts` imports nothing. Headers and the consumer lists say what is
   true (`resolve.ts:5-7` names every importer; `CONTEXT.md`'s `resolve.ts` row names `destinationChannel` and
   `mappedDestinations` and `text.ts` gets a row).
6. **Placement is registration-level, and the docs say so:** `resolve.ts:9-13`, the `CONTEXT.md:1592-1598` gotcha
   and the README's routing sentence gain: placement decides where a plugin's commands are REGISTERED (and
   `announceTargets` where it posts when its servers name a `postTo`); dispatch checks a channel list, not placement,
   so a command still registered in a server the plugin is not placed in runs there (R1's #420 removes such stale
   lists); and a plugin placed nowhere still posts to the default channel. Refusing unplaced servers at dispatch is
   declined: the registration is the mechanism, and R1 makes it complete.
7. **The handoff's single-writer argument is written down** in `store.ts:37-44`'s comment and `CONTEXT.md`'s
   `store.ts` row, resting on the ONE fact that holds: the replacement writes nothing before `takeOver` has stopped
   the original (`ready.ts:28-29` runs `takeOver` before `activate`; every production caller of `mutateRouting` and
   `mutateSecrets` -- the mailbox and `markWebhookBroken` -- is wired inside `activate`, and the mailbox drain is gated
   on `markPluginStateReady`, `index.ts:548` at `fe16563`, after `initRouting`). The original's side is NOT a guarantee and the
   comment must not claim one: `beginHandoff` does not await in-flight work (`restart.ts:263-264`), a plugin's
   `announce` -> `markWebhookBroken` can still write `routing.json` from the original during the handoff, and the stop
   awaits criticals only up to `graceMs` before the daemon's SIGKILL (`shutdown.ts:25`) -- a write cut there is exactly
   the `.tmp` Decision 8's sweep removes. (`README.md:101` is about `state.json`, not this.) An advisory lock is declined.
8. **No `fsync`, per #510** (`storage.ts:135-138`, `state.ts:112`): temp+rename covers a crash, an OOM kill and a
   SIGKILL; a host power loss is outside the contract for every data file, and the secrets file is not special.
   Named in #479's close. **Stale temp files are swept at boot:** `sweepSecretsTemp(dataDir)` in `store.ts` unlinks
   every `routing.secrets.json.*.tmp` beside the file (a leftover is dead at a NORMAL boot and after `takeOver`; in
   the overlap window `README.md:99` documents -- `docker start <name>` with the replacement still alive -- the
   sweep can unlink the other instance's in-flight temp file, whose rename then fails with ENOENT: one failed webhook
   request, no data loss, said in the docstring), logs how many, never throws; `index.ts` calls it right before `initRouting` (a source pin, as
   `index.ts` does not run under test). A `.corrupt-` copy is left alone: it is the evidence Decision 1 keeps, and it
   is owner-only when the bot wrote it (`store.ts:189-200`).
9. **The plugin-level drop says what it means:** `droppedByRepair`'s message becomes "plugin X is not an object with
   a servers object, so it is unplaced (it lives in the home server)"; the gotcha covers both kinds of bad entry.
   Repairing a bad plugin entry to `{ servers: {} }` (fail closed) is declined: "no entry = home server" is the
   documented rule and a typo would silently take a plugin out of every server.
10. **The leak test captures with `util.inspect`** (`depth: 5`, own properties and `cause` included) and proves it
    can see an object argument and an `Error`'s own property (a probe line inside the test), so a future
    `console.error("x", { url })` fails it; and the "URL everywhere" fixture gains destinations (a URL as a name and
    as a value), so `model.ts:338`'s `shown(channel)` is pinned.

### Step 1 -- `src/storage.ts`

1a. `readJsonOrFresh` (`:145-160`):
```ts
export interface ReadJsonOptions {
  /** What a file that will not parse does: moved aside and read as fresh (the default, right for a serialized
   *  write that then replaces it), or kept in place and read as fresh, said once per path per process (right for a
   *  plain read, which must not rename a file a write may be producing, #477/#484). */
  onCorrupt?: "move-aside" | "keep";
  /** Print only the error's name, never its message (a secrets file's parser error can quote its contents, #477). */
  redactReason?: boolean;
}
const keptCorrupt = new Set<string>();
export function resetKeptCorruptForTest(): void { keptCorrupt.clear(); }
/** The guard's view of this module's state (`test/stateGuard.ts`). */
export function storageStateForTest(): { kept: number } { return { kept: keptCorrupt.size }; }

export async function readJsonOrFresh<T>(path: string, fresh: () => T, label: string, options: ReadJsonOptions = {}): Promise<T> {
  ...
    // a good parse, or no file: this path is healthy again, so a later corruption is said once more. THREE places:
    // the success return, the `!(await file.exists())` -> fresh() return (the common absent case) AND the
    // `kind === "absent"` race return in the catch.
    keptCorrupt.delete(path);
  ...
    if (kind === "corrupt") {
      const reason = options.redactReason ? (err instanceof Error ? err.name : "parse error") : String(err);
      if (options.onCorrupt === "keep") {
        if (!keptCorrupt.has(path)) {
          keptCorrupt.add(path);
          console.error(`[${label}] ${path} will not parse (${reason}); acting on a fresh ${label} until it is fixed or the next write replaces it`);
        }
        return fresh();
      }
      // The write path moved the file aside: the path is clean again, so a later corruption is said once more
      // (without this: corrupt, read, mutateRouting, corrupt again, read -> 0 lines; probed).
      keptCorrupt.delete(path);
      moveCorruptAside(path, label, reason);
      return fresh();
    }
```
(`keptCorrupt` is module state and NOTHING guards `storage.ts` today: there is no `StateForTest` in it and no
`storage.ts` row in `GUARDED`. Wire it: `storageStateForTest()` above; a `storageLeaks(s: ReturnType<typeof
storageStateForTest>)` in `test/stateLeaks.ts` returning `["N kept-corrupt path(s) remembered"]` when `s.kept > 0`
(NO module prefix in the string: the guard prepends `src/storage.ts: ` itself), following the file's existing functions; a `GUARDED` row for `src/storage.ts` in the MIDDLE of the table
(the restart row stays first and the updates row last -- the order is load-bearing); the pinned `toEqual` of the table
at `test/stateGuard.test.ts:300-313` gains the row; and `live.test.ts:38-41`'s `afterEach` calls
`resetKeptCorruptForTest()`, and so does `store.test.ts`'s `afterEach` (its rewritten S0 tests and S1 read corrupt
files in keep mode) -- without them the guard fails `live.test.ts:166` ("a routing file that places nobody, or is
corrupt…") and the store tests with `src/storage.ts: 1 kept-corrupt path(s) remembered`. `CONTEXT.md:438` ("ten
modules") becomes eleven, the list gains a `storage.ts` entry, and the `routing/store.ts` entry (`:456`: "the
`routing.json` warnings said, the routing and secrets write queues") gains the before-repair copies. The
`CONTEXT.md` and `test/stateGuard.test.ts` line anchors in this plan are off by up to 32 lines at `fe16563`: re-find
each by its quoted text.) The docstring (`:133-144`) says both
modes and the forget-on-success.

1b. `moveCorruptAside` (`:110-119`) is unchanged; it receives the (possibly redacted) reason.

### Step 2 -- `src/routing/text.ts` (new) and the two re-exports

`text.ts`: `REPLACEMENT_CHARACTER`, `shown` (moved verbatim from `resolve.ts:143-179`) and `clip` (moved verbatim from
`model.ts:129-140`), with a header: "text helpers for the routing files and their messages; imports nothing, so
`model.ts` and `resolve.ts` can both use them without importing each other". `resolve.ts`: delete `:143-144` and
`:150-179` ONLY -- `:146-148` is `isRecord`, which `validatePluginRouting` uses four times and which STAYS -- and add
`import { shown } from "./text"; export { shown };` (NOT `REPLACEMENT_CHARACTER`: unused in `resolve.ts` after the
move, and `noUnusedLocals` makes it `TS6133`). `model.ts`: delete `:17` and `:129-140`, add
`import { clip, shown } from "./text"; export { clip };` (`droppedByRepair` uses `shown`). Both forms are legal under
`verbatimModuleSyntax`; `Dockerfile` copies `src` wholesale, so `text.ts` ships. Every other importer is untouched.
`bun run check` AND `bunx tsc --noEmit -p ops/tsconfig.json` (`ops/bot-ops.test.ts:15` imports `model.ts`) must be
clean after this step alone.

### Step 3 -- `src/routing/model.ts`

3a. `droppedByRepair` (`:301-364`): the plugin-level message (`:318`) per Decision 9; the docstring (`:284-290`): "A
message names a key ... and, with two exceptions, never a value: a bad `postTo` and a bad destination's channel are
shown (through `shown`) so the operator can see what was wrong with them."; the "NOT reported" list (`:297-299`)
gains "a non-string `broken`, `updatedAt` or `updatedBy` (dropped silently: bookkeeping, not configuration)".

### Step 4 -- `src/routing/store.ts`

4a. `readRouting` (`:127-131`): `readJsonOrFresh<unknown>(routingPath(dataDir), freshRouting, "routing", { onCorrupt: "keep" })`;
its docstring (`:114-125`): "an unparseable one is left in place and read as fresh, said once (the next write moves
it aside first, `mutateRouting`)". `readSecrets` (`:169-171`): `{ onCorrupt: "keep", redactReason: true }`.
`mutateSecrets`'s read (`:231`): `{ redactReason: true }`. The header (`:1-3`) and the comment at
`store.test.ts:89-92` follow. FOUR existing tests assert the old behaviour and are rewritten in Step 7 (S0): a plain
read no longer moves the file aside, the following write does.

4b. `mutateRouting` (`:160-167`):
```ts
const copiedBeforeRepair = new Set<string>();
export async function mutateRouting(dataDir: string, mutate: (current: RoutingFile) => RoutingFile): Promise<void> {
  const path = routingPath(dataDir);
  await routingMutator.update(
    path,
    freshRouting,
    (current) => {
      // #477: the first write that would drop something the operator typed keeps the file as it was. Once per path
      // per process; a copy that fails is said and the write goes ahead (the write is the request, the copy a courtesy).
      if (!copiedBeforeRepair.has(path)) {
        try {
          // droppedByRepair is inside the try for the same reason sayWhatWasIgnored guards it: a throw here must
          // not block the write.
          if (droppedByRepair(current).length > 0) {
            copiedBeforeRepair.add(path);
            const copy = `${path}.before-repair-${Date.now()}`;
            copyFileSync(path, copy);
            console.warn(`[routing] routing.json held entries the repair drops; the file as it was is kept at ${copy}`);
          }
        } catch (err) {
          console.warn(`[routing] routing.json held entries the repair drops, and a copy could not be kept (${describeFailure(err)})`);
        }
      }
      return repairRouting(requireFile(mutate(repairRouting(current)), "mutateRouting"));
    },
    "routing",
  );
}
```
(`copyFileSync` from `node:fs`; the callback runs inside the mutator's serialized read-modify-write, after the read
and before the write, so the copy is of the file the write replaces. `resetRoutingWarningsForTest` clears the set;
`routingStoreStateForTest` reports `copied: copiedBeforeRepair.size`, `test/stateLeaks.ts`'s `routingStoreLeaks`
gains the line, and its fixtures at `test/stateGuard.test.ts:168-180` gain `copied: 0` -- a `tsc` error otherwise. The
docs say what the copy predicate does NOT cover: `droppedByRepair` reports placements, not bookkeeping, so a stray
key, a `v: 2` file, `results` entries, or a non-string `broken`/`updatedAt`/`updatedBy` are dropped on write with no
copy.) `requireFile` (`:143-149`): `|| typeof (value as { then?: unknown }).then === "function"` ->
`not a Promise (an async callback?)`; BEFORE throwing, inside the refusal block and under its own guard --
`if (typeof (value as { then?: unknown } | null)?.then === "function") { void (value as PromiseLike<unknown>).then(undefined, () => {}); }`
(an unguarded attach throws on `null`/`undefined` and changes the refusal messages `store.test.ts:363-367` pins; a
cast under a `typeof value === "object"` narrowing is `TS2352`) -- so a rejecting promise from the callback does not
surface as an `unhandledRejection` after the refusal (probed: it does without this; S4's rejecting case fails when the
attach is removed, M14); the comment (`:134-141`) says a thenable is refused too and the rest still relies on the type
checker.

4c. `sweepSecretsTemp(dataDir: string): number` (exported; after `mutateSecrets`): `readdirSync(dirname(path))`
filtered to `name.startsWith("routing.secrets.json.") && name.endsWith(".tmp")`, each `unlinkSync`'d; returns the
count; a missing directory or a failed unlink is logged (`[routing] could not remove a stale secrets temp file
<name>: <code>`) and swallowed -- the call sits inside `activate`'s `try` before `initRouting`, so a throw here would skip
`initRouting`, which is why S5b pins the swallow; logs `[routing] removed N stale routing.secrets.json temp file(s)` when N > 0. The
docstring says why a leftover is always dead at boot (one writer at a time) and why the `.corrupt-` copies are left.

4d. The single-writer paragraph (Decision 7) in the mutator comment (`:37-44`).

### Step 5 -- `src/index.ts`

Right before `initRouting({` (`:473` at `fe16563`): `sweepSecretsTemp(DATA_DIR);` with the comment "#479: a temp file a secrets
write left behind holds a webhook URL; at boot there is no writer it could belong to". Import from `./routing/store`
(`:69` already imports `readRouting, readSecrets`).

### Step 6 -- `src/routing/resolve.ts` and docs

- `resolve.ts:5-7`: the consumer list names `register.ts`, `requests.ts`, `post.ts`, `gate.ts`, `live.ts`, `store.ts`,
  `plugins/host.ts`, `plugins/requests.ts` and `src/interactionLog.ts` (`:17` imports `shown` from `./routing/resolve`
  and keeps working through the re-export); NOT `model.ts`, which no longer imports from `resolve.ts` after Step 2.
  Grep `routing/resolve"` and `from "./resolve"` under `src/` and `ops/` once on the tree you work from (the first
  pattern catches both `./routing/resolve` and `../routing/resolve`: `src/plugins/host.ts:14` and
  `src/plugins/requests.ts:33` use the latter) -- the list must match what Grep finds. `:9-13` gains Decision 6's paragraph.
- `CONTEXT.md:209` (the `storage.ts` row): `readJsonOrFresh` takes `ReadJsonOptions` (`onCorrupt`, `redactReason`)
  and remembers kept-corrupt paths until a good parse; `:438` ("ten modules") and `:446` per Step 1a.
- `CONTEXT.md:225` (the `model.ts` row): "the one value shown is a bad `postTo`" -> "the values shown are a bad
  `postTo` and a bad destination's channel, both through `shown`"; `:226` (`resolve.ts` row): `destinationChannel`,
  `mappedDestinations`, and that `shown` lives in `text.ts`; `:227` (`store.ts` row): delete "and nothing yet reads a
  URL back to post with", say "`post.ts` (#243) reads a URL back to post with"; append `readRouting`/`readSecrets`
  keep a corrupt file in place (`onCorrupt: "keep"`), `mutateRouting`'s before-repair copy, `requireFile` refuses a
  thenable, `sweepSecretsTemp`, the single-writer-during-a-handoff argument; a new row for `src/routing/text.ts`
  (after `resolve.ts`'s, alphabetical within the routing block is not kept today -- put it after `store.ts`'s).
- `CONTEXT.md:1640-1660` (the "damaged `routing.json`" gotcha): "repaired silently in memory" stays; add that an
  UNPARSEABLE file is now kept in place by a read and moved aside by the next write, that the first write that
  drops something keeps `routing.json.before-repair-<ms>`, that a bad plugin-level entry makes the plugin UNPLACED
  (home server) while a bad server entry makes it live nowhere, that the values quoted are a bad `postTo` and a bad
  destination's channel, that the table covers destinations, and the three silent fields. `:1592-1598`: Decision 6.
- `README.md:33` (the routing sentence): one clause from Decision 6 ("routing decides where a plugin's commands are
  registered and which channels they work in; a plugin placed nowhere still posts to `ANNOUNCE_CHANNEL_ID`" -- read
  the sentence; it may already say the last part).
- `src/storage.ts:135-138` (the no-`fsync` sentence in `readJsonOrFresh`/`writeJsonAtomic`'s docblock) and
  `state.ts:112`: cite #479 as the decided no-`fsync` for the secrets file too. (`:57-61` is not the place: it says only
  that there is one implementation of temp+rename; `CONTEXT.md` has no `fsync` text to edit.)

### Step 7 -- tests

**`src/storage.test.ts`** (`readJsonOrFresh / writeJsonAtomic / createJsonWriter` describe at `:191`; `moveCorruptAside`
at `:453`): **T1:** a file holding `{ not json` read with `onCorrupt: "keep"` -> `fresh()`, the file still there
byte-identical, one `console.error` containing `will not parse` and the path; a second read -> no second line; after
`resetKeptCorruptForTest()` -> said again; **T1b (the forget):** corrupt -> one line; write valid JSON and read ->
no line; corrupt again and read -> a SECOND line (and the same through an absent file: corrupt, unlink, read ->
fresh, corrupt again -> said; AND through the write path, in `store.test.ts`: corrupt `routing.json`, `readRouting`
-> one line, `mutateRouting` (moves it aside), corrupt again, `readRouting` -> a second line); `storageStateForTest().kept`
is 1 after the first read and 0 after the good one (these `kept` reads are what kill M11; the pure `storageLeaks`
case does not);
**T2:** the same with `redactReason: true` on the seed `{ "a": SECRETTOKEN123 }` -- a BARE identifier, because Bun's
message quotes only the first bare identifier it meets (`Unexpected identifier "https"` for an unquoted URL, which is
why a URL seed proves nothing) -> the line contains `SyntaxError` and contains neither `SECRETTOKEN123` nor
`JSON Parse error`; the default options -> moved aside as today (the existing cases); **T3 (the move-aside half of
T2):** the same seed through `readJsonOrFresh` with `{ redactReason: true }` and the default `onCorrupt` -> the file
is moved aside AND `moveCorruptAside`'s line contains `SyntaxError` and not `SECRETTOKEN123` (`moveCorruptAside`
itself is unchanged, so a test that hands it a string proves nothing).

**`src/routing/store.test.ts`** (`readRouting` `:51`, `mutateRouting` `:123`, `secrets` `:242`, the #260 describe `:536`):
**S0 (the four existing tests that assert the old behaviour):** `store.test.ts:61-78` (a plain `readRouting` moves
the file aside -- fails locally under 4a), `:461-475` and `:477-491` (`skipIf(win32)`, so CI-only: `readSecrets` then
a `.corrupt-` sibling -- both got 0 siblings with the skip removed; CI would go red where a Windows run shows
nothing) and `model.test.ts:475-478` (the old plugin-level message, D3). Rewrite the first three as "the read keeps
the file, then `mutateRouting`/`mutateSecrets` moves it aside", keeping the file-mode assertions in the two CI-only
ones; D3 updates the fourth. **S1 (#477-1):** write `{ not json` as `routing.json`; `readRouting` -> fresh, the file
UNCHANGED (no `.corrupt-` sibling), one error line; then `mutateRouting(dir, withPlugin("music"))` -> the corrupt
file is now `.corrupt-<ms>` and `routing.json` holds music (the write path still moves aside); the same for
`readSecrets`/`mutateSecrets` with the seed `{ "a": SECRETTOKEN123 }` in BOTH halves, asserting `SyntaxError` present
and `SECRETTOKEN123` absent from the keep line and from the move-aside line (else M3b/M3c survive); **S3 (#477-3):**
seed `{ plugins: { music: { servers: { [GUILD]: { commands: "All" } } } } }` (the server entry is dropped by repair);
`mutateRouting(dir, withPlugin("wow"))` -> `routing.json.before-repair-*` exists holding the seeded bytes, one warn
naming it, and `routing.json`'s `plugins` has exactly the keys `music` and `wow` with `plugins.music` equal to
`{ servers: {} }` (a bad SERVER entry leaves the plugin placed nowhere; it does NOT erase the plugin -- asserting
"not music" is false); a second `mutateRouting` on the now-clean file -> no second copy; **S3b (the once-guard):**
re-seed the bad file BETWEEN two writes (write the bad bytes again after the first `mutateRouting`) -> still ONE
copy (the only test that kills M4b: on a clean file a second write never copies with or without the set). Stub
`Date.now` to INCREASING values here (`1000`, `1001`, ...): the copy name carries `Date.now()` and `copyFileSync`
overwrites, so two writes in one millisecond -- or a `Date.now` pinned to a constant -- make the guard-less mutant
produce one file and SURVIVE (probed: with a constant, 646 pass / 0 fail under the mutant); a clean
file from the start -> no copy; a `copyFileSync` that fails (pre-create the copy's path as a DIRECTORY -- the name
carries `Date.now()`, so `spyOn(Date, "now")` for the call, which reaches the module; `EPERM` on Windows/Bun 1.4.2,
`EISDIR` expected on Linux) -> the warn says a copy could not be kept and the write still lands;
`routingStoreStateForTest().copied` and the reset; **S4 (#478-9):** `mutateRouting(dir, () => Promise.resolve(file) as unknown as RoutingFile)`
and the `mutateSecrets` twin -> reject with `not a Promise`, files unchanged (extend `:357-376`); plus a REJECTING
promise from the callback -> refused the same way and no `unhandledRejection` (a `process.on("unhandledRejection")`
probe for the test's duration); **S5 (#479):** plant `routing.secrets.json.aaaa.tmp` and
`routing.secrets.json.bbbb.tmp` (and a `routing.secrets.json.corrupt-1` and `routing.json.x.tmp` that must survive)
-> `sweepSecretsTemp(dir)` returns 2, the two are gone, the other two remain, one log line; a missing dir -> 0, no
throw; **S5b (the swallow):** plant a DIRECTORY named `routing.secrets.json.x.tmp` (with a file inside, so `unlinkSync`
throws on every OS) -> the sweep returns the count of the ones it did remove, logs the `could not remove` line, and
does NOT throw (a rethrowing mutant survives everything else: 97 pass in the audit). (S2 from the first draft, "a
good file written after a corrupt one is read and renamed nothing", failed under no mutant and is dropped; S1 pins
the read side.)

**`src/routing/model.test.ts`** (`droppedByRepair (#260)` `:460`; the table `:608-`; destinations `:758`): **D1
(#415):** the `everywhere` fixture (`:557-572`) gains, on the kept server `333…`, `destinations: { [URL_WITH_TOKEN]: CHAN_1, news: URL_WITH_TOKEN }`;
the messages include a destination-name line and a destination-channel line, and the `for` loop's two `not.toContain`
hold for them (so `:338`'s `shown(channel)` is pinned: replace it with `${channel}` and the test fails); **D2
(#477-6):** `leftOut` gains a destinations branch (a destination pair in `raw` that is not in the repaired server's
`destinations`), and FOUR fixtures with destinations join the table (a good pair; a bad name; a bad channel; and
`destinations: [..]`, an array -- without the fourth, deleting the "destinations is not an object" message survives
the table); the table is a guard only if mutants fail it, so M13/M13b below are run against it;
**D3 (#477-2):** the plugin-level message now ends `so it is unplaced (it lives in the home server)`, and
`model.test.ts:475-478`, which pins the old text, is updated to the new one; **D4 (#478-10):**
a source pin: `src/routing/model.ts` contains no `from "./resolve"`; `src/routing/text.ts` contains no `import `
line at all; `resolve.ts` and `model.ts` each export `shown`/`clip` respectively (the existing imports elsewhere are
the proof they compile).

**`src/routing/resolve.test.ts`:** the `shown` cases (`:409`-area) keep passing through the re-export (no change);
one import of `shown` from `./text` in a new `text.test.ts` with the moved cases duplicated? No: move nothing; the
re-export keeps `resolve.test.ts` as the home of `shown`'s tests, and `text.test.ts` is not created.

**`src/routing/secrets-leak.test.ts`** (`:85`): capture via `inspect(a, { depth: 5 })` from `node:util`; a probe
before the scenarios, with TWO DISTINCT tokens (`TOKENS.probeObject`, `TOKENS.probeError`, so a capture that handles
only one shape cannot pass): `console.error("probe", { url: urlFor(ID(9), TOKENS.probeObject) })` and
`console.error(Object.assign(new Error("probe"), { path: urlFor(ID(9), TOKENS.probeError) }))`, assert both tokens
are in `lines` (`inspect(.., { depth: 5 })` sees both on Bun 1.4.2, probed), then `lines.length = 0` and the existing
assertions run. (The first draft's extra `.tmp` assertion on the `:265` test is dropped: `secrets-leak.test.ts:246`
already asserts it.)

**`src/index.test.ts`:** a source pin that `sweepSecretsTemp(DATA_DIR);` precedes `initRouting({` inside `activate(`.

**`test/stateGuard.test.ts`:** the `GUARDED` table pin (`:300-313`) gains the `src/storage.ts` row; the
`routingStoreLeaks` fixtures (`:168-180`) gain `copied`; a `storageLeaks` case: `{ kept: 0 }` -> `[]`, `{ kept: 1 }` ->
one line naming `src/storage.ts` (it pins the leak TEXT; a snapshot stuck at 0, M11, is killed by T1b's `kept` reads
and by a store-level test in the shape of `store.test.ts:606`, not by this case). **`src/routing/live.test.ts:38-41`:** `afterEach` gains `resetKeptCorruptForTest()` (Step 1a).

### Mutation table (scratch worktree; `bun test src/storage.test.ts src/routing/store.test.ts src/routing/model.test.ts src/routing/resolve.test.ts src/routing/secrets-leak.test.ts src/index.test.ts test/stateGuard.test.ts` per mutant)

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | 1a: `"keep"` ignored (always move aside) | T1, S1 |
| M1b | 1a: the once-per-path guard dropped | T1 (two lines) |
| M1c | 1a: any ONE of the three `keptCorrupt.delete` calls dropped (success / absent / move-aside) | T1b's matching sequence (no second line) |
| M2 | 1a: `redactReason` ignored | T2 (`SECRETTOKEN123` in the line), S1's secrets case |
| M3 | 4a: `readRouting` back to the default options | S1 (`.corrupt-` after the read), S0's rewrites |
| M3b | 4a: `readSecrets` without `redactReason` | S1's secrets keep half |
| M3c | 4a: `mutateSecrets`'s read without `redactReason` | S1's secrets move-aside half ONLY (T3 calls `readJsonOrFresh` directly and cannot see `store.ts`) |
| M4 | 4b: the before-repair copy dropped | S3 |
| M4b | 4b: the once-per-path guard made unconditional (`if (!copiedBeforeRepair.has(path))` -> `if (true)`) | S3b ONLY (two copies after the re-seed, with the increasing clock); the other reading, `.add(path)` removed, is also killed by the failed-copy case's `copied === 1` |
| M4c | 4b: a failed copy aborts the write | S3's failed-copy case |
| M5 | 4b: the thenable check dropped | S4 |
| M6 | 4c: `sweepSecretsTemp` matches `*.tmp` of any file | S5 (`routing.json.x.tmp` removed) |
| M6b | 4c: the sweep also removes `.corrupt-` copies | S5 |
| M7 | 5: the call before `initRouting` removed | the index.test.ts pin |
| M8 | 3a: `shown(channel)` -> `${channel}` at `:338` | D1 |
| M8b | 3a: the plugin-level message without the unplaced clause | D3 |
| M9 | 2: `model.ts` imports `shown` from `./resolve` again | D4 |
| M10 | 7: the leak capture back to `String(a)` | the probe assertions (both tokens) |
| M11 | 1a: `storageStateForTest().kept` stuck at 0 | T1b's `kept` reads (the `storageLeaks` case alone does NOT: probed, 70 pass under the mutant) |
| M14 | 4b: the rejection-swallowing `.then(undefined, () => {})` removed | S4's rejecting-promise case (an `unhandledRejection`) |
| M12 | 4c: a failed unlink rethrows instead of logging | S5b |
| M13 | 3a: the "destinations is not an object" message deleted | D2 (the `destinations: [..]` fixture) |
| M13b | `repairDestinations` keeps a bad pair (name or channel) | D2 (the bad-name / bad-channel fixtures; `leftOut` disagrees with the repair) |

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #477-1 / #484-6: a plain read keeps a corrupt routing/secrets file (and says a repeat episode); the serialized write moves it aside | 1a, 4a | T1, T1b, S0, S1, the `storageLeaks` case | M1, M1b, M1c, M3, M11 |
| #477-3: the first repairing write keeps a copy, once; a failed copy does not block the write | 4b | S3, S3b | M4, M4b, M4c |
| #477-4: a secrets parse error is never quoted | 1a, 4a | T2, T3, S1 | M2, M3b, M3c |
| #415: the destination value is pinned; the three texts say two values | 3a, 6, 7 | D1 | M8 |
| #477-6: the table covers destinations; the silent fields are listed | 3a, 7 | D2 | M13, M13b |
| #477-2: the plugin-level drop says "unplaced"; the gotcha covers both | 3a, 6 | D3 | M8b |
| #416: the store row is true | 6 | lens-B audit | -- |
| #478-7: the leak capture sees objects and Error properties | 7 | the probe | M10 |
| #478-9: a thenable is refused | 4b | S4 | M5 |
| #478-10: no model<->resolve cycle; the lists are current | 2, 6 | D4 | M9 |
| #478-11 / #478-12: placement is registration-level; one writer during a handoff | 6, 4d | lens-B audit | -- |
| #479: stale secrets temp files are swept at boot and a failed removal never throws; no `fsync`, in writing | 4c, 5 | S5, S5b, the index pin | M6, M6b, M7, M12 |

### Verification

```bash
bun install --frozen-lockfile
bun run check
bunx tsc --noEmit -p ops/tsconfig.json
bun test src/storage.test.ts src/routing/ src/plugins/host.test.ts src/plugins/requests.test.ts src/index.test.ts src/interactionLog.test.ts test/stateGuard.test.ts
bun test
```

Keep the explicit file list: `bun test src test` treats its arguments as substring filters and drags in
`ops/bot-ops.test.ts` (about ten minutes on this box). Not verifiable here: the two CI-only secrets tests in S0
(`skipIf(win32)`); `copyFileSync` onto a directory on Linux (`EISDIR` expected; `EPERM` on Windows/Bun 1.4.2, probed;
the test asserts the warn, not the code).

### Acceptance to paste per issue

- **#477:** S1-S3 and T1-T3 pass lines; M1-M4c; the `before-repair` copy's name from S3; D2 and D3; the fail-closed
  repair declined with Decision 9's reason. **#484 (item 6 remainder):** S1 (the read side renames nothing; S2 was
  dropped as vacuous); closed by reference to item 1's fix.
  **#415:** D1 and M8; the three reworded texts. **#416:** the row diff. **#478:** the probe and M10; S4 and M5; D4
  and M9; the docs diffs for items 11 and 12 with the two declines. **#479:** S5, the index pin, M6/M7; the `fsync`
  decline citing #510.

### PR

- Title: `fix(routing): keep a corrupt routing file in place on a read, copy the file before the first repairing write, refuse a thenable mutate, sweep stale secrets temp files, give shown/clip one home, and pin the destination value (#415, #416, #477, #478, #479, #484)`.
- Body: the items, Decisions 1-10, the typecheck + test output, the mutation table, the declines. End with
  `Closes #415. Closes #416. Closes #477. Closes #478. Closes #479.`; #484 "Part of (item 6)".
- After merge: tick #415 #416 #477 #478 #479 on #528; an item comment on #484.

### Out of scope, on purpose

- `fsync` anywhere (Decision 8, #510).
- Refusing unplaced servers at dispatch (Decision 6).
- An advisory lock across containers (Decision 7).
- `readDiscovery`'s `"keep"` and element validation (R3), the mailbox's reasons and results (R3), everything in R1.
