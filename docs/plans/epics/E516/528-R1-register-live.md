<!-- Plan for #528 bundle R1 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #528): the registration and live
half of the routing core -- `src/routing/register.ts`, `live.ts`, `discovery.ts` and the `DiscoveryFile` type in
`model.ts` -- for #420 (with the three findings folded into it), #421, #482 items 3 and 5, #484 items 5 and 7, and
#485 items 8 and 9's live-test half. Written by the orchestrating session on 2026-10-16; every `src/routing/*`
`file:line` below was read at main `ea4fdda` (the routing modules are unchanged at `922b567`; `CONTEXT.md`'s rows
and gotchas sit a few lines lower after #586, so re-find each by its quoted text). Audited read-only before it was
committed (a Sonnet agent, Steps 1-4 and the tests applied to a scratch copy of `922b567`: typecheck clean, 253 pass
on the four routing files over six randomized seeds, M1-M12 all killed); every finding was applied: `previousScopes`
read `g.commands` off a `{"guilds":[null]}` file and a non-parse read fault rethrew, both BEFORE single mode's one PUT
(it is now defensive and wrapped, falling back to `NO_PREVIOUS` with an error line); `takeSnapshots`'s and
`writeView`'s catches still called `c.log.error` unguarded, so the "never throws" claims stayed false (both go through
`tell` now, and `tell` passes `err` only when defined, since `log.error(msg, undefined)` printed a trailing
`undefined`); `registerPlan`'s shape contradicted itself (settled: `{ results, failure?: { error: unknown } }`, so a
rejection with `undefined` survives, and `attempt` resets the captured error before the primary call); a join no
longer retried servers that had failed and a join after a boot that registered nowhere rewrote the file with one
record (the join falls back to the full run until a full run has completed in this process, and the lost retry is
named in the docstring); L7 as worded reset `lastRegistrations` (rebuilt on one context); six existing live tests,
`register.test.ts:230` and fourteen `.results` sites were unlisted; eight stale doc sites were missing; four mutation
holes gained tests; five "What is wrong" claims were overstated and are reworded; the upgrade limit (a file written
before R1 has no `global` key) is stated. Round 2 (rebuilt on a fresh copy of `a322377`: typecheck clean, 2,403 pass
on `src/ test/` with the listed rewrites, every mutant run): no blocker; a directory `discovery.json` does not throw
(`Bun.file(dir).exists()` is false), so the read-fault test stubs `Bun.file`; the null-guild case produces ZERO error
lines; a boot whose PUTs all fail still completes a full run, so the join-fallback test is a boot that could not read
the servers; two more existing tests break (both made `refreshDiscovery` reject through a throwing logger; rewritten
on a throwing `log` GETTER) and `announce.test.ts` joins the verification list; the failed-clear snippet is written
out in the form that compiles; two equivalent mutants (the `caught` reset, the no-placements clause) are gone; both
join-reason sites go through `logName`; two more stale doc sites; the twelve-test L0 list; anchors at `a322377` --
all applied. Landing order: R1 and R2 are independent; R3 after both. The other
#528 bundles: R2 (model/store/resolve: #415, #416, #477, #478, #479) and R3 (requests/gate/discovery-read/post: #482
items 4, 6, 7; #483; #484 items 1, 2, 6; #485 items 9's requests half and 10). R1 and R2 share `model.ts` only on
different lines (R1 adds a field to `DiscoveryFile`; R2 edits `droppedByRepair` and the `shown` import); R3 edits
`discovery.ts`'s `readDiscovery`, which R1 does not touch. Nothing in flight touches `src/routing/`. -->

## Implementation plan -- #528 R1: leaving routed mode empties what earlier routed boots wrote, a join registers one server, routed mode really never throws, and the global scope's outcome reaches `discovery.json`

Children: **#420** (closes; its three folded findings `routing-requests-live-3`, `routing-register-discovery-gate-post-1`
and `commands-report-interaction-15` with it, the last by a docs edit and a declined half), **#421** (closes), **#482**
items 3 and 5 (items 4, 6, 7 are R3's; the issue stays open), **#484** items 5 and 7 (items 1, 2, 6 are R3's; item 6's
first half landed in #553), **#485** item 8 and item 9's `live.test.ts` half (item 10 and item 9's `requests.test.ts`
half are R3's). One PR, branch `fix/528-R1-register-live`, worktree `S:\Repos\_wt\rdb-528-R1` cut from `origin/main`
at or after `922b567`. Behaviour changes (extra registration calls on a mode transition, a join's narrower
registration, a new key in `discovery.json`) -> the **three-reviewer gate** applies; every changed production line
mutation-tested in a scratch worktree. `ROUTING_VERSION` and the routing file shapes are a contract (`ops/bot-ops.sh`
and the panel build against them): the one shape change here is an OPTIONAL key added to `discovery.json`, read by
nothing that refuses unknown keys (checked below).

### What is wrong, verified at `ea4fdda`

- **#420 (a routed-to-single transition leaves the other servers' lists in place).** `planRegistration`
  (`register.ts:46-73`): with no placement the plan is `single` -- one PUT to the home guild or to the global scope
  (`:56-59`) -- and `registerPlan` (`:128-131`) issues exactly that one call. Nothing in single mode touches a server an
  earlier ROUTED run gave a list of its own (`:62-71`), so after `routing.json` is deleted, restored from an old
  backup, or repaired to nothing (the panel cannot unplace: `requests.ts:214-219` only merges `plugins[plugin] =
  clean`, and `servers: {}` still counts as a placement, `resolve.ts:32-34`), the other servers keep their stale
  lists for good -- and after one such single-mode boot the file FORGETS them: OTHER's discovery record goes to
  `null` while Discord keeps its list (reproduced) -- and with no home server the global PUT (`:129`) sits beside
  them: a guild command and a global command of the same name would BOTH show in that guild (INFERRED from how the
  two scopes work; no verbatim statement in Discord's documentation was found and no live server was driven). The reverse
  direction IS handled (`clearGlobal`, `:72`, `:143-158`), only for the no-home-server case. `CONTEXT.md:1603-1605`
  says a `routing.json` that places nobody "changes nothing ... and touches no other server", which hides it.
  **Folded `routing-register-discovery-gate-post-1`:** `clearGlobal: homeGuildId === undefined` (`:72`) means a bot
  that first ran GLOBAL (no `DISCORD_SERVER_ID`), then had one set and a plugin placed, never empties the global list:
  it keeps showing every command everywhere, and `commandAllowed` (`resolve.ts:134`) allows a plugin in a server with
  no entry, so the command runs there. **Folded `commands-report-interaction-15`:** `CONTEXT.md:1167` says `rest.put`
  "fully replaces the application's command set"; a PUT replaces ONE scope (one guild, or global), so old names in a
  scope this run does not write remain. **Folded `routing-requests-live-3`:** the same mechanism from the live side.
- **#421 ("routed mode never throws" is false).** `logRouted` (`live.ts:114-131`) calls `c.log.log`/`c.log.error`
  unguarded inside the queued job (`:209`), after the PUTs and the discovery write; a logger that throws rejects
  `applyRouting` for a registration that succeeded -- `live.test.ts:705-723` pins exactly that rejection, and the
  comment at `:156-157` concedes it. The claims: `live.ts:18` ("in `routed` mode nothing here throws once routing has
  been read"), `:168` ("`routed` mode throws only if reading routing does"), and `CONTEXT.md`'s `live.ts` row (`:230`
  at `ea4fdda`; Grep `throws` in it). At boot, `index.ts:474-494` would print "slash-command registration failed"
  for a registration that succeeded. Production passes `console` (`index.ts:486` at `a322377`), which does not
  throw; the claim is still false. (Other anchors at `a322377`: `index.ts` "makes EXACTLY" `:467-468`, `initRouting({`
  `:474`, `applyRouting("boot")` `:489`, the "slash-command registration failed" catch `:491-500`;
  `ops/admin/server.ts` `GET /api/routing` `:576`; `src/commands.ts` "never gated" `:359`.)
- **#482 item 3 (the global scope's outcome: misleading text, absent from `discovery.json`).** `registerPlan`
  records against `"global"` a failed empty (`:150`) and a skipped one (`:154`, `NOT_EMPTIED`); `logRouted` prints
  both as "the global command list was not emptied (<error>), so commands may show twice" (`:128`), which for the
  skip is wrong (no server took a list, so the global one is the only one and nothing shows twice); and
  `buildDiscovery` (`discovery.ts:140-155`) matches registrations to guild snapshots by id, so a `"global"` record
  never reaches the file -- `DiscoveryFile` (`model.ts:109-119`) has no slot for it (the `live.ts:19-22` header says
  so). A single-GLOBAL registration's outcome (`:131`) reaches nothing at all: `logRouted` does not run in single
  mode, every guild entry is `null`, and `index.ts` prints a count only (probed).
- **#482 item 5 / #484 item 7 (a join registers every server, and N joins run N full registrations).**
  `guildJoined` (`live.ts:273-284`) runs the whole `applyRouting` in routed mode (`:279`): one new server costs one PUT
  per server the bot is in, sequential (`register.ts:135-142`, deliberately, against 429s), on the one chain that the
  panel's `routing-set` and `refreshDiscovery` also queue on (`:69-74`), and a burst of N joins queues N such runs.
- **#484 item 5 (a routed run that cannot read the server list blanks `lastRegistrations`).** `takeSnapshots` returns
  `null` (`live.ts:80-87`) -> `guildIds: []` (`:181`) -> a routed plan with no bodies -> `results` is `[]` (with no
  servers nothing is recorded, pinned by `register.test.ts:400-409`) -> `lastRegistrations = results` (`:205`)
  unconditionally. The next `refreshDiscovery` (`:219-225`,
  the 15-minute tick or a leave) with a good snapshot writes `commands: null` for every server (`discovery.ts:146-148`),
  so the panel shows them all unregistered while Discord still holds their lists. The comment at `:76-79` promises
  only that the failed run writes no file, which is true; the blanking shows up one refresh later.
- **#485 item 8 (server names raw in log lines).** `label` (`live.ts:228`), `logRouted`'s `nameOf` (`:116`) and the
  `applyRouting(\`joined ${guild.name}\`)` reason (`:279`, which `writeView` prints on a discovery failure, `:108`)
  write a Discord server name as it is: a server named with a newline and a forged `[routing]` line puts that line
  in the bot's stdout. **#485 item 9, the `live.test.ts` half:** "a join before initRouting does nothing" (`:637-645`)
  and "a leave before initRouting does nothing" (`:809-`) assert `h.puts` and `h.logs.log` on a harness that was never
  passed to `initRouting` -- vacuous; and the comment at `:684` ("`await sleep(20)`") orders two joins by a delay in
  `onPut`, not a race guard (read it: the delay is what makes the discovery-write ordering observable; it is kept,
  and said to be that).

### Decisions (defaults, named so the gate can contest them)

1. **A registration run reconciles the scopes it does not write against what the previous `discovery.json` says the
   bot owned.** `applyRouting` reads the last published file (`readDiscovery(dataDir)`, `discovery.ts:187-191`; `null`
   when none) before planning, and `planRegistration` takes `previous: PreviousScopes` -- the guild ids whose
   `commands` record shows a list may be there (`commands !== null && (registered > 0 || error !== undefined)`: a
   successful empty leaves `registered: 0` and no error, so it is not a candidate again), and whether the global scope
   does (the new `global` slot, same rule). A `single`-guild plan CLEARS (PUT `[]`) every candidate guild except the
   home guild, and the global scope when it is a candidate; a `single`-global plan clears every candidate guild; a
   `routed` plan clears the global scope when there is no home server (as today) OR when it is a candidate. Clears
   run FIRST, each guarded and recorded against its scope with `registered: 0` (a failure keeps the error, so the
   scope stays a candidate for the next run, AND is said: in single mode nothing logs today, so the same doomed
   50001 clear went out silently on each of three boots in the audit's probe while the panel showed "Discord refused
   the commands here" for good -- each failed clear gets one `tell(c, "error", ...)` line in both modes); the primary
   PUT(s) follow. A guild the bot is no longer in cannot be cleared and is not (whether Discord drops a departed
   server's commands is NOT verified against a live server, `live.ts:255-257` says as much; out of reach either way).
   The clears are broader than "the other servers": moving `DISCORD_SERVER_ID` from one server to another empties the
   OLD home server too (probed: HOME 0, then OTHER full), which the docs say. **The previous file is read
   defensively:** `previousScopes` guards a `null` or non-object guild entry and a non-object `commands`
   (`readDiscovery` lets `{"guilds":[null]}` through until R3's #482 item 4, and R1 cannot rely on R3), and the whole
   read-and-compute is wrapped: any throw (a non-parse read fault rethrows from `storage.ts:157-158`) falls back to
   `NO_PREVIOUS` with one `tell(c, "error", ...)` line -- a damaged VIEW file must never stop the one registration
   call. The file is the record across boots; `lastRegistrations` is the same information within a process and is
   NOT used for this (it starts empty at boot, where the transition usually happens). No previous file -> no clears
   -> a first boot makes exactly today's call. **Upgrade limit, stated in the PR and the README:** a file written
   before R1 has no `global` key, so a deployment that already went global and then set a home server keeps its
   stale global list until a global-mode run or a hand clear -- exactly `ops/README.md`'s runbook case, and the one
   case that runbook's hand clear still covers. The GUILD records' shape is unchanged, so a pre-R1 file's per-server
   lists ARE emptied by the first R1 boot (L1's second run uses a file with no `global` key); only the global scope
   has no pre-R1 record. #239's "EXACTLY the registration call it made
   before routing existed" becomes "...plus, once, the empties a routed past requires", in the header, the
   docstring, `CONTEXT.md` and the README.
2. **`registerPlan` never throws; `applyRouting` keeps single mode's rethrow.** Today single mode lets the one PUT
   throw out of `registerPlan` (`:105-107`, `:130`), which would skip the clears' bookkeeping. Now every call is
   guarded and recorded, and `registerPlan` returns `{ results: GuildRegistration[]; failure?: { error: unknown } }`
   -- `failure` is set only for single mode's PRIMARY call, wrapped in an object so a rejection with `undefined` is
   kept (today `base` rejects with `undefined`; a bare `failure?: unknown` would lose it). `applyRouting` writes
   discovery from the full results and then rethrows `failure.error` (`:187-200` and `:212`, restructured), so
   `index.ts`'s catch prints the original error and its message is untouched. `GuildRegistration` is unchanged (it
   is what `buildDiscovery` copies into the file).
3. **A join in routed mode registers the joined server only** -- a new `applyRoutingFor(guildId, reason)` on the same
   chain: read routing, snapshot, plan the full routed map (no `previous`, so no clears), PUT that one guild's body,
   merge the one result into `lastRegistrations` (replace its entry or add it), write discovery. It FALLS BACK to the
   full run in the same job when the process has not yet completed a full `applyRouting` (a boot that registered
   nowhere followed by a join would otherwise rewrite the file with the one record and erase the memory
   `previousScopes` depends on; probed), when routing has no placements, when the snapshot failed, or when the guild
   is not in the snapshot. A join of the home server in single mode still runs the full `applyRouting` (single mode's
   one call IS that registration, `live.ts:252-258`). **What changes besides the count:** today a join re-registers
   every server, so a server whose earlier PUT failed got retried at the next join; after this it is retried at the
   next full run only (the 15-minute `refreshDiscovery` does not register; a boot or a panel `routing-set` does).
   `register.ts:116-120` ("or a server the bot joins"), `CONTEXT.md:268-269` (the same retry claim) and the docs name
   that. A second named limit: if the last full run was single mode and `routing.json` is then hand-edited (or a
   backup restored) to place a plugin, the next join takes the narrow path and the other servers wait for the next
   full run (the panel path calls `applyRouting`, so only a hand edit meets this); said in the gotcha. Coalescing N joins (#484 item 7's
   suggested fix) is declined as moot: N joins are now N single PUTs plus N discovery writes, O(N), on the chain they
   were always on.
4. **A routed run that could not read the servers leaves `lastRegistrations` alone** (`snapshots === null`): it
   registered nowhere, so it learned nothing about any server. Single mode still assigns (its one call needs no server
   list and did happen).
5. **`logRouted`, `takeSnapshots`'s catch (`live.ts:84`) and `writeView`'s catch (`:108`) all go through `tell`**
   (`live.ts:236-244`) -- the two catches call `c.log.error` unguarded today, so with `logRouted` alone a throwing
   logger still rejected a routed run on a failed discovery write or an unreadable server cache (probed, both). With
   all three guarded the "never throws" claims become true; `warnHomeServerMissing`'s comment (`:155-157`) loses its
   concession. `tell` itself passes `err` to the logger ONLY when it is defined (`log.error(message, undefined)`
   prints a trailing ` undefined` and broke `live.test.ts:246`'s exact-line assertion in the audit's first apply).
   The test at `:705-723` flips: a throwing logger does NOT reject `applyRouting`, the PUTs and the discovery write
   stand.
6. **`DiscoveryFile` gains `global?: { registered: number; error?: string; at: string }`** -- the global scope's last
   recorded outcome: `registered: N` after a single-global registration, `0` after a routed empty, with `error` after
   a failed or skipped one. Optional and additive: a file written before this has none; `readDiscovery` reads it as
   today; `bot-ops.sh routing-get` passes the file through `jq` whole (`ops/bot-ops.sh:1208-1246`) and the panel's
   `/api/routing` hands it on 1:1 (`ops/admin/server.ts:571`) -- confirm with a Grep that no consumer enumerates the
   keys (the page reads `guilds` and `plugins`; an extra key is ignored). `logRouted` tells a skip from a failure:
   "the global command list was left as it is: no server accepted its commands" (one list, nothing doubled) versus
   today's failure line, which reads "was not emptied (<error>), so commands may show twice" (`live.ts:128`, asserted
   at `live.test.ts:257` -- KEPT word for word, so `:257` does not change).
7. **A server name in a log line is one line and bounded:** `logName(value: unknown)` in `live.ts` = `clip(String(value), 80)`
   (`model.ts:135-140`, surrogate-safe) with every control character replaced by U+FFFD: the regex is `/\p{Cc}/gu`
   (it covers C0, DEL and the C1 range; do NOT type a `[\x00-\x1f\x7f]` class -- the audit's first apply put raw NUL,
   `\037` and `\177` BYTES into `live.ts` through the editing tools, confirmed with `od -c`), the replacement
   `String.fromCharCode(0xfffd)` (the form `resolve.ts:144` uses), applied in `label`, `nameOf` and the join reason.
   Names stay readable; a forged line cannot start.
8. **Docs follow:** `CONTEXT.md:1599-1612` (the "owns the command list" gotcha) describes the transition and the
   join's narrower registration; `:1167`'s "fully replaces the application's command set" becomes "replaces that
   SCOPE's command set (one guild's, or the global one); a scope this run does not write keeps what it had, which is
   why a registration run empties the scopes an earlier routed run owned (#420)"; the `commands-report-interaction-15`
   half "optionally make `bareName` strict" is DECLINED: a core row is never gated by the routing gate
   (`commands.ts:335`), so the protection a stale unprefixed name meets is Discord's `default_member_permissions` plus
   the handler's own check, and the empties above remove the stale list itself. README:33's "nothing changes: every
   command is registered to `DISCORD_SERVER_ID` (or globally when it is unset)" gains "and a server an earlier routed
   boot gave its own list is emptied once, as `discovery.json` records it" plus the upgrade limit from Decision 1.
   The `live.ts` header (`:15-22`) and `register.ts`'s (`:1-6`, `:105-120`) say the new rules; `CONTEXT.md`'s rows
   for `register.ts`, `discovery.ts`, `live.ts` (`:228-230`) follow (each source row ends with a "Tests: `x.test.ts`"
   reference -- there are no separate test rows). **Eight more sites say the old rule and are edited in Step 5:**
   `ops/README.md:899-903` (single-server mode "never clears the global list", with `register.ts:43,:72,:143` cites),
   `ops/README.md:921` (the same rule as advice inside the env block, cites `register.ts:56-59, :128-131`),
   `ops/README.md:1203` (a first-person deployment record: the sentence stays, its `register.ts:43-44` cite is
   refreshed), `CONTEXT.md:113-114`, `CONTEXT.md:268-269` (the join-retry claim), `src/index.ts:466-468` ("makes
   EXACTLY the one PUT"), `live.ts:166` ("registers exactly as before routing existed"),
   `docs/adr/0006-per-plugin-routing.md:37-39` (decision 3's "exactly as before" / "byte-for-byte": an "*Amended by
   #420:*" note in the form `:52` already has for #219), `register.ts:116-120` (the join retry, Decision 3),
   `README.md:33` and `CONTEXT.md:1180`'s "fully replaces an application's command set" (that is the quote; the gotcha
   is around `:1630-1648` at `a322377`: "touches no other server" `:1637`, "Registration re-runs, in full" `:1639-1642`).
   All line numbers are at `a322377`; re-find by the quoted text.

### Step 1 -- `src/routing/model.ts`

`DiscoveryFile` (`:109-119`): after `guilds`,
```ts
  /** #482: the global scope's last recorded outcome -- `registered: N` after a single-mode global registration, `0`
   *  after a routed run emptied it, with `error` when the empty failed or was skipped. Absent in a file written
   *  before this, and when the global scope was never touched. */
  global?: { registered: number; error?: string; at: string };
```

### Step 2 -- `src/routing/register.ts`

2a. Types:
```ts
/** What the previous `discovery.json` says the bot still owns (#420): guild ids whose record shows a list may be
 *  there, and whether the global scope does. From `previousScopes(file)`; `NO_PREVIOUS` when there is no file. */
export interface PreviousScopes {
  guilds: readonly string[];
  global: boolean;
}
export const NO_PREVIOUS: PreviousScopes = { guilds: [], global: false };

/** A record shows a list may be there when it was ever registered (`registered > 0`) or the last call failed
 *  (`error`: whatever was there before stayed). A successful empty (`registered: 0`, no error) shows nothing is. */
export function previousScopes(file: DiscoveryFile | null): PreviousScopes {
  if (file === null) return NO_PREVIOUS;
  // Defensive on purpose: until R3 validates the elements, readDiscovery lets `{"guilds":[null]}` and a non-object
  // `commands` through, and this runs BEFORE single mode's one PUT -- a damaged view must never stop it.
  const owned = (r: unknown): boolean =>
    typeof r === "object" && r !== null &&
    ((typeof (r as { registered?: unknown }).registered === "number" && (r as { registered: number }).registered > 0) ||
      (r as { error?: unknown }).error !== undefined);
  const guilds = Array.isArray(file.guilds) ? file.guilds : [];
  return {
    guilds: guilds
      .filter((g): g is DiscoveryFile["guilds"][number] => typeof g === "object" && g !== null && typeof g.id === "string" && owned(g.commands))
      .map((g) => g.id),
    global: owned(file.global),
  };
}
```
(`DiscoveryFile` is imported as a type from `./model`, already the source of `RoutingFile`. The caller in 4b wraps
the read AND this call in a try/catch as well, for the read faults that rethrow.)

2b. `RegistrationPlan` (`:31-34`): every variant gains `clears: string[]` (guild ids to empty, in `previous.guilds`'
order) and `clearGlobal: boolean`:
```ts
export type RegistrationPlan =
  | { mode: "single"; scope: "guild"; guildId: string; body: CommandJson[]; clears: string[]; clearGlobal: boolean }
  | { mode: "single"; scope: "global"; body: CommandJson[]; clears: string[]; clearGlobal: false }
  | { mode: "routed"; bodies: Map<string, CommandJson[]>; clears: []; clearGlobal: boolean };
```
`planRegistration`'s `opts` gains `previous: PreviousScopes` (required: the one production caller passes it; the
tests' `plan()` helper defaults it to `NO_PREVIOUS`); its body:
```ts
  const inSnapshot = new Set(guildIds);
  // #420: a scope this run does not write keeps whatever it had. The guilds an earlier routed run gave a list of
  // their own, and a global list an earlier run registered, are emptied -- once; the next discovery.json records
  // the empty and they are not candidates again. A guild the bot has left cannot be reached and is not tried.
  const staleGuilds = (except?: string) => previous.guilds.filter((id) => id !== except && inSnapshot.has(id));
  if (!hasPlacements(routing)) {
    return homeGuildId !== undefined
      ? { mode: "single", scope: "guild", guildId: homeGuildId, body: [...fullBody], clears: staleGuilds(homeGuildId), clearGlobal: previous.global }
      : { mode: "single", scope: "global", body: [...fullBody], clears: staleGuilds(), clearGlobal: false };
  }
  ... (bodies as today) ...
  // No home server: the global list is what served every server until now (as today). With one: only a global list
  // an earlier global-mode run left behind (routing-register-discovery-gate-post-1).
  return { mode: "routed", bodies, clears: [], clearGlobal: homeGuildId === undefined || previous.global };
```
The docstring (`:36-45`) says all three rules.

2c. `registerPlan` (`:122-160`) never throws. Its return type CHANGES to
`{ results: GuildRegistration[]; failure?: { error: unknown } }` (`GuildRegistration` unchanged; `"global"` stays the
global scope's id); every caller reads `.results` (the two in `live.ts` and the fourteen in `register.test.ts`, listed
in Step 6). Shape, written out:
```ts
export interface RegistrationOutcome {
  results: GuildRegistration[];
  /** Single mode's PRIMARY call failed: the thrown value, as thrown (`undefined` included, hence the wrapper).
   *  `applyRouting` rethrows it once discovery is written. Never set for a clear, never set in routed mode. */
  failure?: { error: unknown };
}
...
  const results: GuildRegistration[] = [];
  let caught: { error: unknown } | undefined;
  // `caught` is read only when the PRIMARY call failed, and `attempt` has just overwritten it then, so a clear's
  // failure can never be reported as the primary's; a reset at the top of `attempt` would be dead code (an
  // equivalent mutant), so there is none.
  const attempt = async (guildId: string | "global", route: `/${string}`, body: CommandJson[]): Promise<boolean> => {
    try {
      await put(route, body);
      results.push({ guildId, registered: body.length, at: now().toISOString() });
      return true;
    } catch (err) {
      caught = { error: err };
      results.push({ guildId, registered: 0, error: describeError(err), at: now().toISOString() });
      return false;
    }
  };
  // #420: the empties first -- a scope that keeps a stale list while the new one lands would show both.
  for (const guildId of plan.clears) await attempt(guildId, Routes.applicationGuildCommands(appId, guildId), []);
  if (plan.mode === "single") {
    if (plan.clearGlobal) await attempt("global", Routes.applicationCommands(appId), []);
    const ok = await attempt(plan.scope === "guild" ? plan.guildId : "global", plan.scope === "guild" ? Routes.applicationGuildCommands(appId, plan.guildId) : Routes.applicationCommands(appId), plan.body);
    return ok ? { results } : { results, failure: caught };
  }
  for (const [guildId, body] of plan.bodies) await attempt(guildId, Routes.applicationGuildCommands(appId, guildId), body);
  if (plan.clearGlobal) {
    const servers = results.filter((r) => r.guildId !== "global");
    if (servers.some((r) => r.error === undefined)) await attempt("global", Routes.applicationCommands(appId), []);
    else if (servers.length > 0) results.push({ guildId: "global", registered: 0, error: NOT_EMPTIED, at: now().toISOString() });
  }
  return { results };
```
A successful routed empty now RECORDS `{ guildId: "global", registered: 0 }` (today it records nothing, `:148-149`):
that record is what tells the next run the scope is clean (Decision 1), and what `buildDiscovery` puts in the new
slot. The "at least one server took its commands" rule (`:112-120`) is unchanged. The docstring (`:105-120`) is
rewritten: never throws; the order (clears, then the primary call(s)); what each record means; and `:116-120`'s "or
a server the bot joins" names that a routed join now registers the joined server alone (Decision 3), so a server
whose PUT failed is retried at the next full run, not at the next join.

2d. The single-guild clear of the global scope (a bot that ran global, then set `DISCORD_SERVER_ID` with nothing
placed) is the `single`-guild `clearGlobal: previous.global` above: `routing-register-discovery-gate-post-1`'s
scenario in single mode, which the verifier noted "exists in single mode" too.

### Step 3 -- `src/routing/discovery.ts`

`buildDiscovery` (`:125-169`): the `"global"` registration, when present in `registrations`, becomes the file's
`global` slot (`{ registered, ...(error ? { error } : {}), at }`); absent otherwise. The docstring (`:120-124`) says a
global registration belongs to no one server AND is recorded in `global`. `readDiscovery` is unchanged (R3 edits it).

### Step 4 -- `src/routing/live.ts`

4a. Imports: `previousScopes`, `NO_PREVIOUS`, `NOT_EMPTIED` from `./register`; `readDiscovery` from `./discovery`;
`clip` from `./model`. `describeError` (`live.ts:28`) becomes UNUSED once both catches go through `tell` and
`registerPlan` describes its own errors: drop it from the import (`noUnusedLocals` is on).

4b. `applyRouting` (`:170-215`):
```ts
    const c = required();
    const routing = await readRouting(c.dataDir);
    const snapshots = takeSnapshots(c);
    // #420: what the last published file says the bot still owns; nothing when there is none (a first boot). The
    // file is a VIEW: a damaged or unreadable one is said and treated as none, never allowed to stop the PUT below.
    let previous = NO_PREVIOUS;
    try {
      previous = previousScopes(await readDiscovery(c.dataDir));
    } catch (err) {
      tell(c, "error", "[routing] could not read the previous discovery.json; registering as if there were none (a server an earlier routed run owned keeps its list until the next run that can read it)", err);
    }
    const plan = planRegistration({ ..., guildIds: (snapshots ?? []).map((s) => s.id), homeGuildId: c.homeGuildId, previous });
    const { results, failure } = await registerPlan(c.put, c.appId, plan, c.now);
    // Decision 1: a failed EMPTY is said, in both modes (nothing logged it in single mode; in routed mode logRouted
    // names the global one itself, so isClear excludes routed's global). The primary call is never a clear.
    for (const r of results) {
      if (r.error !== undefined && isClear(plan, r.guildId)) {
        const who = r.guildId === "global" ? "the global scope" : label(snapshots?.find((s) => s.id === r.guildId) ?? { id: r.guildId, name: r.guildId });
        tell(c, "error", `[routing] could not empty the stale command list of ${who}: ${r.error} (it is tried again at the next registration run)`);
      }
    }
    // #484 item 5: a routed run that could not read the servers registered nowhere and learned nothing; keep what
    // the last run that did knew. Single mode's one call needs no server list and did happen.
    if (plan.mode === "single" || snapshots !== null) { lastRegistrations = results; fullRunDone = true; }
    if (snapshots !== null) await writeView(c, snapshots, results, reason);
    if (plan.mode === "routed") { logRouted(c, snapshots ?? [], results); warnHomeServerMissing(c, routing, snapshots); }
    if (failure !== undefined) throw failure.error;
    return { mode: plan.mode, results };
```
with, beside `logRouted`:
```ts
/** A record that was one of the plan's EMPTIES (never the primary call; routed mode's global empty is logRouted's). */
function isClear(plan: RegistrationPlan, id: string): boolean {
  return (plan.clears as readonly string[]).includes(id) || (id === "global" && plan.mode === "single" && plan.clearGlobal);
}
```
(The cast is needed: 2b types the routed variant's `clears` as `[]`, and `[].includes(id)` is `TS2345`. `label`
takes ONE argument, the guild snapshot, on the current tree; pass a snapshot or a stand-in as above. There is no
`r.registered === 0` clause: `attempt` records 0 on every failure, so it would be dead. The audit built exactly this
form: one line per failed clear in single mode, guild or global, and in routed mode NO second line beside
`logRouted`'s own. The other form considered -- running `logRouted`'s guild loop in both modes -- would print
"Registered commands in N servers" and double the primary's error in single mode: do not.) `fullRunDone` is a
module `let`, `false` at load, reset by `initRouting` (`:60`) with `lastRegistrations` AND by `resetRoutingForTest`
(the audit's order-dependent mutant: a test file that never calls `initRouting` must not inherit another's
`fullRunDone`).

4c. `applyRoutingFor(guildId: string, reason: string): Promise<ApplyResult>` (#482 item 5): enqueue; `readRouting`;
`takeSnapshots`; plan the full map; then if `!fullRunDone` (no full run has completed in this process: a join right
after a boot that could not READ the servers must not rewrite the file with one record -- probed, the file went
`[[HOME,null],[OTHER,null],[THIRD,3]]`), or the plan is not `routed` (no placements: the type narrowing
`if (full.mode !== "routed")` IS this fallback, `bodies` exists only on the routed variant -- there is no separate
`hasPlacements` clause, it would be an equivalent mutant), or `snapshots === null`, or the guild is not in the
snapshot (without that guard the plan-literal shape passes an `undefined` body to `put`), fall back to the full run
IN THE SAME JOB. Structure: factor the body of `applyRouting` into an inner `fullRun(c, reason, routing, snapshots)`
that both the exported `applyRouting` and `applyRoutingFor` call from inside their queued job -- NEVER call the
exported `applyRouting` from within a job (it enqueues behind itself: deadlock). On the narrow path: call
`registerPlan` with a plan whose `bodies` holds the one guild and `clearGlobal: false`; merge:
`lastRegistrations = [...lastRegistrations.filter((r) => r.guildId !== guildId), ...results]`;
`writeView(c, snapshots, lastRegistrations, reason)`; `logRouted` for the one result (the line reads "Registered
commands in 1 server (Other: N)"); return `{ mode: "routed", results }`. `guildJoined` (`:279`): routed ->
`applyRoutingFor(guild.id, \`joined ${logName(guild.name)}\`)`; home-server join in single mode ->
`applyRouting(\`joined ${logName(guild.name)}\`)` -- BOTH reason sites go through `logName` (the single-mode one is
the second site; L9b covers both). The docstring (`:246-272`) says a routed join registers the joined server alone
and names the lost join-time retry (Decision 3).

4d. `logRouted` (`:114-131`), `takeSnapshots`'s catch (`:84`) and `writeView`'s catch (`:108`) through `tell`: every
`c.log.log(...)` -> `tell(c, "log", ...)`, every `c.log.error(...)` -> `tell(c, "error", ...)` (move `tell` above
them, or forward-reference: function declarations hoist). `tell` (`:236-244`) passes `err` ONLY when defined:
`err === undefined ? c.log[level](message) : c.log[level](message, err)`. The global line splits: `r.error ===
NOT_EMPTIED` -> "the global command list was left as it is: no server accepted its commands"; any other error ->
today's line UNCHANGED, "was not emptied (<error>), so commands may show twice" (`:128`; `live.test.ts:257` asserts
it and stays). `nameOf` and `label` go through `logName`.

4e. `logName(value: unknown): string` beside `label`: `clip(String(value), 80).replace(/\p{Cc}/gu, REPLACEMENT)`
with `const REPLACEMENT = String.fromCharCode(0xfffd);` (never a typed `\x00` class: see Decision 7).

4f. The header (`:15-22`): "in `routed` mode nothing here throws once routing and the previous discovery have been
read (a read that fails for a reason other than a parse error rejects, #509); a logger that throws is swallowed
(`tell`)"; the `:19-22` sentence about the global scope having no slot goes (it has one now). `warnHomeServerMissing`'s
comment (`:155-157`) -> "a logger that throws must not turn a finished registration into a failure (`logRouted` goes
through `tell` for the same reason)".

### Step 5 -- docs

- `CONTEXT.md:1599-1612` (Grep `touches no other server`): the sentence "A `routing.json` that places nobody changes
  nothing: ... and touches no other server." -> "A `routing.json` that places nobody registers as before routing
  existed -- to `DISCORD_SERVER_ID`, or globally when that is unset -- and, once, EMPTIES the scopes an earlier routed
  run owned: the servers whose `discovery.json` record shows a list of their own, and a global list a global-mode run
  left behind (#420; the empties run first, each recorded, so a failed one is tried again next run). Routed mode
  likewise empties a leftover global list even with a home server." And after "a server the bot joins (#259) both call
  `applyRouting`": "(a join in routed mode registers the joined server alone, `applyRoutingFor`, and merges that one
  outcome into what the last full run recorded, #482)".
- `CONTEXT.md:1172` ("fully replaces an application's command set") per Decision 8; `CONTEXT.md:113-114` (the
  single-mode sentence) likewise.
- `CONTEXT.md`'s rows (`:228` register, `:229` discovery, `:230` live; Grep each `| \`src/routing/<file>.ts\` |`):
  `register.ts`: `previousScopes`/`PreviousScopes`, the `clears`/`clearGlobal` on every plan, `registerPlan` never
  throws and returns `{ results, failure?: { error } }`; `discovery.ts`: the `global` slot; `live.ts`: `applyRoutingFor`
  (and its fallbacks), `lastRegistrations` kept on a failed snapshot, `logRouted` and both catches through `tell` (the
  "never throws" claim now true), `logName`. Each row's trailing "Tests:" reference stays as it is.
- `README.md:33` per Decision 8 (one clause plus the upgrade limit; Grep `places no plugin, nothing changes`).
- `ops/README.md:895-898`: "never clears the global list" with its `register.ts:43,:72,:143` cites -> says single
  mode empties a global list an R1 build recorded, and that a global list recorded before R1 (no `global` key) is
  the one case the runbook's hand clear still covers.
- `src/index.ts:451-453` ("makes EXACTLY the one PUT") and `live.ts:166` ("registers exactly as before routing
  existed"): "...plus, once, the empties a routed past requires (#420)".
- `docs/adr/0006-per-plugin-routing.md:37-39` (decision 3, "byte-for-byte"): an "Amended by #420 (R1): ..." note in
  the form decision 6 already carries; the decision text itself is not rewritten.
- `register.ts:116-120`: the join sentence per Decision 3.
- `#485`'s and `#484`'s closing comments name which items this PR did; `#420`'s names the declined `bareName` half.

### Step 6 -- tests

**`src/routing/register.test.ts`** (`plan()` at `:35-46` gains `previous: NO_PREVIOUS` in its defaults; `:230` calls
`planRegistration` DIRECTLY and needs `previous: NO_PREVIOUS` too; the fourteen `registerPlan` result sites at `:270`,
`:280`, `:311`, `:339`, `:350`, `:365`, `:371`, `:385`, `:390-391`, `:404`, `:407`, `:418`, `:432` read `.results`;
`fakePut` exists, Grep it; the single-mode "throws" test is `:295-300`, not `:273` -- `:273` is the global-route
one-put test):
- **P1 (`previousScopes`):** `null` -> `NO_PREVIOUS`; a file with HOME `registered: 5`, OTHER `registered: 0` (no
  error), THIRD `registered: 0, error: "x"`, `global: { registered: 3 }` -> `{ guilds: [HOME, THIRD], global: true }`;
  `global: { registered: 0 }` -> `global: false`; no `global` key -> `false`; a guild with `commands: null` -> not
  listed; **P1b (defensive):** `{ guilds: [null, { id: HOME, commands: "x" }, { id: OTHER, commands: { registered: 2 } }] } as unknown as DiscoveryFile`
  -> `{ guilds: [OTHER], global: false }`, no throw; `guilds` not an array -> `NO_PREVIOUS`-shaped.
- **P2 (the plan matrix):** no placement + home + previous `{ guilds: [HOME, OTHER, THIRD], global: true }` with
  `guildIds: [HOME, OTHER]` -> `single`/`guild` with `clears: [OTHER]` (not HOME: it is the target; not THIRD: not in
  the snapshot) and `clearGlobal: true`; the same with no home -> `single`/`global`, `clears: [HOME, OTHER]`,
  `clearGlobal: false`; placed + home + previous `global: true` -> `routed`, `clearGlobal: true`; placed + home +
  `global: false` -> `false` (the `:213-220` test, extended); placed + no home -> `true` whatever `previous`;
  `NO_PREVIOUS` everywhere -> today's plans byte for byte (`clears: []`).
- **P3 (`registerPlan` order and records):** single-guild with `clears: [OTHER]` and `clearGlobal: true` -> calls
  `[OTHER: [], global: [], HOME: body]` in that order, results `[{OTHER,0},{global,0},{HOME,N}]`, no `failure`; a clear
  that fails and the primary succeeds -> the clear's record carries the error, the primary call still happens, and
  `failure` is UNDEFINED (a clear's error must not be reported as the primary's: the reset in `attempt`); the primary
  call failing -> results carry it AND `failure.error` is the thrown value, `toBe` the same object (the single-mode
  "throws" test at `:295-300` becomes "returns the failure"); **P3b:** a primary that rejects with `undefined` ->
  `failure` equals `{ error: undefined }` (present, not dropped); routed with a successful global empty -> results END
  with `{ global, registered: 0 }` (the `:377-392` and `:425-433` expectations gain that record); the skip (`:411-423`)
  unchanged.

**`src/routing/discovery.test.ts`** (`buildDiscovery` describe at `:279`): a `"global"` registration -> `file.global`
equals it (with and without `error`); none -> no `global` key; `:298`'s "belongs to no one server" keeps `null` for
every guild AND now asserts the slot; `:315` "exactly the documented top-level shape" gains the optional key; `readDiscovery`
reads a file with `global` back unchanged (`:414`).

**`src/routing/live.test.ts`** (harness `:88-122`; `guildJoined / guildLeft` describe `:493`). **L0, the TWELVE
existing tests the change breaks on `a322377`, rewritten rather than discovered red** (the audit ran them; no other
existing test's put count changes): `live.test.ts:260-271` (the skip wording: "left as it is"), `:345-356`
(`JSON.stringify(file)` now contains "boom" because `global.error` is in the file: assert on the guild entries, not
the whole file), `:531-552`, `:735-756` (they assert `[HOME, OTHER]` puts after a join: a join after a boot is now ONE
put, L6), `:647-675` and `:677-691` (L6: put counts), `:705-723` (L5 flips it), `:820-857` ("a leave whose refresh
fails is logged, not thrown": it made `refreshDiscovery` reject through a THROWING LOGGER, which Decision 5 ends --
rewrite its failure source as a context whose `log` is a GETTER that throws, with `client.guilds` throwing so the
`takeSnapshots` catch is reached: `tell` reads `c.log` outside its try on purpose, so that still rejects, probed);
`register.test.ts:295-300` (P3: "returns the failure"), `:377-392` and `:425-433` (the global record); and
`src/announce.test.ts:291-325` ("a discovery refresh that rejects is logged, not left unhandled", the same
throwing-logger source: the same getter rewrite; `src/announce.test.ts` is in the Verification list for this reason).
NOT broken, so not touched: `:249-258` (the failure line is unchanged) and `:767-776` (a join with no earlier boot
falls back to the full run and still makes 2 puts). New and changed:
- **L1 (#420 routed -> single-guild):** `placeMusicInOther()`, boot (two puts), then `mutateRouting` to no plugins,
  `applyRouting("boot")` -> puts `[OTHER: []]` then `[HOME: full]`; discovery: OTHER `commands.registered === 0`,
  HOME `N`, no `global`; a third `applyRouting` -> ONE put (HOME): OTHER is no longer a candidate.
- **L2 (#420 routed -> single-global):** `homeGuildId: undefined`: routed boot (HOME, OTHER, global `[]`), unplace,
  `applyRouting` -> `[HOME: [], OTHER: [], global: full]`; discovery `global.registered === N`, both guilds `0`.
- **L3 (global-mode past, then a home server and a placement):** write a discovery file whose `global.registered`
  is 3 (through `writeDiscovery`, or a single-global boot with `homeGuildId: undefined` first), then a harness with
  `homeGuildId: HOME` and music placed in OTHER -> the routed run's calls are `[HOME, OTHER, global: []]`; discovery
  `global.registered === 0`; the next routed run makes no global call.
- **L4 (no previous file; a failed clear; a failed primary):** a first boot with no `discovery.json` -> exactly one
  put (today's contract); a clear failing (`failures: { [guildRoute(OTHER)]: err }`) -> its error in discovery
  under OTHER, the HOME put made, `applyRouting` resolves, AND one `error` log line names OTHER and "could not empty"
  (Decision 1: today's silence); **L4b:** the clear failing and the primary succeeding -> `applyRouting` RESOLVES (a
  clear's error is not rethrown as the primary's); the primary HOME put failing in single mode -> discovery written
  with the error under HOME AND `applyRouting` rejects with that error, `rejects.toBe` the same object (the existing
  single-failure test, extended); **L4c (E5):** a `discovery.json` holding `{"guilds":[null],"plugins":[],"generatedAt":"x"}`
  (written with `Bun.write`, which `readDiscovery` lets through until R3) -> single mode still makes its ONE put,
  `applyRouting` resolves, and ZERO error lines (the defensive `previousScopes` does not throw, so nothing is said;
  the plan as first written rejected here with `TypeError: null is not an object` and made 0 puts); **L4c-fault
  (the read fault):** a directory named `discovery.json` does NOT work as the fault (`Bun.file(dir).exists()` is
  false, so the read returns fresh and the only line is the discovery WRITE failure) -- instead `spyOn(Bun, "file")`
  returning `{ exists: async () => true, json: async () => { throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); } }`
  for a path ending `discovery.json` (pass everything else through; restore in `finally`) -> ONE put, resolves,
  exactly one line `[routing] could not read the previous discovery.json; ... EIO`. This is the only test that kills
  M13b; M13 is killed by P1b (with the try/catch present, a throwing `previousScopes` is caught and L4c's put count
  does not change).
- **L5 (#421):** `:705-723` rewritten: a logger that throws on "Registered commands" -> `applyRouting` RESOLVES in
  routed mode, both puts made, discovery written; `handleJoin` resolves with no `handling the join ... failed` line;
  **L5b:** a logger whose `error` throws, with the discovery WRITE failing (make `dataDir` unwritable or stub the
  writer) -> `applyRouting` still RESOLVES (the `writeView` catch); **L5c:** the same logger with `client.guilds`
  throwing -> RESOLVES (the `takeSnapshots` catch). Both rejected with `Error: logger broke` before Decision 5 covered
  the catches.
- **L6 (#482 item 5):** routed, music in OTHER, boot; `leaveOther`/`joinOther`-style (the helpers in `:493-`'s
  describe): a join of a THIRD server (add it to the fake world with `h.world.guilds.set(...)`, the way `joinOther`
  does -- `addGuild` is a local const inside `fakeWorld`, `:63`, not returned) -> exactly ONE put, to THIRD, with the
  core commands (and music's if placed there); discovery lists all three with HOME's and OTHER's earlier
  registrations intact and THIRD's new one; `:677-691` ("two joins", which never boots) -> the first join is the
  fallback full run and the second is narrow: puts `[HOME, OTHER, HOME]`, 3 in all, `sawDiscovery [false, false, true]`
  (or boot first, then 2 puts `[THIRD, HOME]`: pick one and say which); `:647-675` (queued behind the boot) -> the
  join's ONE put after the boot's discovery write (puts `[HOME, OTHER, OTHER]`, `sawDiscovery [false, false, true]`);
  **L6b (E2):** a join while routing has NO placements -> the full single-mode run (one put to HOME, none to THIRD
  unless THIRD is HOME); **L6c (E3):** a join of a guild NOT in the snapshot (fake world not updated) -> the full run,
  no `undefined` body ever passed to `put` (assert every body is an array); **L6d (E7):** a boot whose SERVER CACHE
  could not be read (`client.guilds` throwing during the boot, restored after), then a join of THIRD -> the FULL run
  (puts to HOME, OTHER and THIRD), and the file holds all three, not `[null, null, THIRD]`; a second join of THIRD
  after that -> one put. (NOT "a boot whose PUTs all fail": that boot has a snapshot, completes a full run and
  records two errors, so the join is the narrow one and the failed servers wait for the next full run -- Decision 3's
  stated behaviour; probed.)
- **L7 (#484 item 5):** ONE context (do not re-run `initRouting` with a throwing client: `:60` resets
  `lastRegistrations` and the assertion gets `undefined, undefined`): routed; boot; then swap `client.guilds` for a
  throwing getter IN PLACE, the way `live.test.ts:459-477` does -> `applyRouting` resolves with no puts and no
  discovery write; restore the getter; `refreshDiscovery()` -> discovery shows HOME's and OTHER's registrations from
  the boot, not `null`; **L7b (E1, Decision 4's second half):** SINGLE mode with `client.guilds` throwing -> the one
  put is made and `lastRegistrations` IS assigned (a following `refreshDiscovery` with a good snapshot shows HOME
  registered).
- **L8 (#482 item 3):** `logRouted`'s two global lines: a skip (`failures` on both guilds, no home) -> the log says
  "left as it is: no server accepted its commands" and NOT "show twice"; a failed empty -> "was not emptied" and
  "show twice"; discovery `global.error` set in both cases.
- **L9 (#485 item 8):** a guild named `"Evil\nforged [routing] line\x1b"` joining and leaving -> every log line that
  names it is one line (no `\n`), contains U+FFFD and not `\x1b`; a 300-character name is clipped to 80 (plus the id);
  **L9b (E4):** the join REASON reaches a log line only when the discovery write fails (`writeView`'s catch prints
  it), so force that failure (a directory where the file goes) and assert the printed `joined ...` reason is one line
  with U+FFFD -- in THREE cases: a routed join on the narrow path, a routed join on the fallback path, and a
  SINGLE-mode home-server join (the second reason site, in `guildJoined`'s single branch; mutating only that site
  survived every other test).
- **L10 (#485 item 9):** `:637-645` and `:809-` lose the `h.puts`/`h.logs.log` assertions (the harness is not wired)
  and keep "resolves" and "no discovery written", with a comment saying why; the `await sleep(20)` at `:683` has NO
  comment today: add one saying the delay orders the two discovery writes so the test can observe them, and is not a
  race guard.

**`src/index.test.ts`:** nothing new (the `applyRouting("boot")` call is unchanged).

### Mutation table (scratch worktree; `bun test src/routing/register.test.ts src/routing/live.test.ts src/routing/discovery.test.ts src/routing/model.test.ts` per mutant)

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | 2a: `previousScopes` ignores `error` (`registered > 0` only) | P1 (THIRD missing) |
| M1b | 2a: `registered >= 0` (a successful empty is a candidate again) | P1 (OTHER listed), L1's third run (a second empty) |
| M2 | 2b: `staleGuilds` without the `except` (the home guild emptied too) | P2, L1 (HOME emptied before its own put) |
| M2b | 2b: `staleGuilds` without the `inSnapshot` filter | P2 (THIRD cleared) |
| M3 | 2b: routed `clearGlobal` back to `homeGuildId === undefined` | P2, L3 |
| M4 | 2c: the clears run AFTER the primary call | P3 (order) |
| M4b | 2c: a failed clear aborts the run (`attempt` rethrows) | P3, L4 |
| M4d | 4b: the failed-clear error line dropped (`isClear` -> `false`) | L4 (guild clear), L4 (global clear) |
| M4e | 4b: `isClear`'s global clause dropped / `isClear` matching in routed mode | L4's global-clear case / L4's routed global failure (a second line) |
| M5 | 2c: a successful routed empty records nothing (today) | P3, L3 (NOT L2 or the discovery slot test: probed, they pass under M5) |
| M6 | 2c/4b: single mode's failure not returned (swallowed) | L4 (resolves instead of rejecting), the existing single-failure tests |
| M6b | 2c: `failure?: unknown` (the wrapper dropped: `undefined` lost) | P3b |
| M7 | 3: `buildDiscovery` drops the `global` slot | discovery tests, L2, L3 |
| M8 | 4b: `lastRegistrations = results` unconditional | L7 |
| M8b | 4b: single mode no longer assigns on a null snapshot | L7b |
| M9 | 4c: a join runs the full `applyRouting` | L6 (put count) |
| M9b | 4c: the join's result replaces `lastRegistrations` instead of merging | L6 (HOME/OTHER `null` in discovery) |
| M9c | 4c: the guild-not-in-snapshot fallback dropped | L6c (an `undefined` body) |
| M9e | 4c: the `fullRunDone` fallback dropped | L6d (the file holds one record), the existing `:767` test |
| M9f | 4c/`resetRoutingForTest`: `fullRunDone` not reset | L6d (order-dependent otherwise) |
| M10 | 4d: `logRouted` back to direct `c.log` calls | L5 |
| M10c | 4d: `takeSnapshots`'s / `writeView`'s catch back to direct `c.log.error` | L5c / L5b |
| M10d | 4d: `tell` passes `err` when undefined | `live.test.ts:246`'s exact line (trailing ` undefined`) |
| M10b | 4d: the skip wording dropped (one line for both) | L8 |
| M11 | 4e: `logName` without the control-character replace | L9 |
| M11b | 4e: `logName` without the clip | L9's 300-character case |
| M11c | 4c: EITHER join reason site left raw (routed, or the single-mode home join) | L9b's matching case |
| M12 | 4b: `readDiscovery` not read (`NO_PREVIOUS` always) | L1, L2, L3 |
| M13 | 2a: `previousScopes` not defensive (`g.commands` read bare) | P1b ONLY (L4c's put count is unchanged under the try/catch) |
| M13b | 4b: the try/catch around the previous read dropped (`throw err`) | L4c-fault ONLY (the `spyOn(Bun, "file")` form; a directory does not throw) |

### Coverage table

| Bullet (the issues' observable outcomes) | Step(s) | Test | Mutation |
|---|---|---|---|
| #420: after a routed past, a single-mode run empties the other servers' lists and a leftover global list, once, says a failed empty, and `discovery.json` records it; a damaged previous file never stops the PUT | 1, 2, 3, 4b | L1, L2, L4, L4b, L4c, L4c-fault, P1-P3 | M1, M1b, M2, M2b, M4, M4b, M4d, M4e, M5, M12, M13, M13b |
| #420 (`gate-post-1`): routed mode with a home server empties a global list an earlier global run left | 2b | L3, P2 | M3 |
| #420 (`interaction-15`): the "fully replaces" sentence is per scope; `bareName` strictness declined; the eight stale sites | 5 | lens-B audit | -- |
| #421: a throwing logger does not reject a routed registration (log lines, a failed write, a failed snapshot); the three claims are true | 4d, 4f | L5, L5b, L5c, `:246` | M10, M10c, M10d |
| #482-3: the global outcome reaches `discovery.json`; skip and failure read differently | 2c, 3, 4d | L8, discovery tests | M5, M7, M10b |
| #482-5 / #484-7: a join registers the joined server alone, merged into the last full run's record; falls back to the full run when it must | 4c | L6, L6b, L6c, L6d | M9, M9b, M9c, M9e, M9f |
| #484-5: a failed server read does not blank `lastRegistrations`; single mode still records | 4b | L7, L7b | M8, M8b |
| #485-8: server names are one line and bounded in the log, the join reason included | 4e, 4c | L9, L9b | M11, M11b, M11c |
| #485-9 (live half): the pre-init tests assert what they can | 6 | L10 | -- |
| single mode's rethrow and `index.ts`'s message unchanged; a rejection with `undefined` survives | 2c, 4b | L4, P3b, the existing single-failure tests | M6, M6b |

### Verification

```bash
bun install --frozen-lockfile
bun run check
bunx tsc --noEmit -p ops/tsconfig.json
bun test src/routing/register.test.ts src/routing/live.test.ts src/routing/discovery.test.ts src/routing/model.test.ts src/routing/requests.test.ts src/routing/secrets-leak.test.ts src/announce.test.ts src/index.test.ts test/stateGuard.test.ts
bun test
```

(`src/announce.test.ts` is in the list because `:291-325` breaks under Decision 5; the first draft omitted it and only
the full suite would have found it.) Keep the explicit file list (`bun test src test` filters by substring and drags in `ops/bot-ops.test.ts`, about ten
minutes). Not verifiable here, named in the PR: Discord's guild-plus-global duplication (the reason the empties exist;
INFERRED from the two scopes' semantics, no verbatim documentation quote and no live server driven), whether Discord
drops a departed server's commands (the reason a left guild is not cleared), and a live transition on a real bot
(Rod's debug instance can show it: place a plugin, boot, delete `routing.json`, boot, `discovery.json` shows the other
server at `registered: 0`). The upgrade limit (Decision 1) goes in the PR body under its own heading.

### Acceptance to paste per issue

- **#420:** L1-L4 and P1-P3 pass lines; M1-M5, M12 failing output; the `discovery.json` from L1 after the second
  boot; the three folded findings named (the `bareName` half declined with the reason).
- **#421:** L5's pass line, M10; the three reworded claims quoted.
- **#482 (items 3 and 5):** L6 and L8 pass lines, M7, M9, M10b; items 4, 6, 7 named as R3's.
- **#484 (items 5 and 7):** L7's pass line, M8; item 7 declined as moot with the reason; items 1, 2, 6 named as R3's.
- **#485 (item 8, item 9's live half):** L9 and L10 pass lines, M11; item 10 and the `requests.test.ts` half named as R3's.

### PR

- Title: `fix(routing): empty the scopes an earlier routed run owned, register a joined server alone, keep the last registrations on a failed server read, guard the routed log lines, and record the global scope in discovery.json (#420, #421, #482, #484, #485)`.
- Body: the items, Decisions 1-8, the typecheck + test output, the mutation table, the two unverified notes, the
  `discovery.json` shape change under its own heading. End with `Closes #420. Closes #421.`; #482, #484, #485 "Part of".
- After merge: tick #420 and #421 on #528; item comments on #482/#484/#485.

### Out of scope, on purpose

- Coalescing joins (Decision 3: moot once a join is one PUT).
- A `GET` of the global scope to detect a list the file does not know about (a bot whose `discovery.json` was deleted
  keeps a stale global list until a global-mode run or a hand clear; Decision 1's record is the file).
- The panel showing the new `global` slot (A3, #529).
- Everything in R2 and R3.
