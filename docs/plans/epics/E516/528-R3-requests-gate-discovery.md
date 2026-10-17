<!-- Plan for #528 bundle R3 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #528): the request, gate, discovery-read
and post edges of the routing core -- #482 items 4, 6, 7; #483; #484 items 1, 2; #485 item 10 and item 9's
`requests.test.ts` half. Written by the orchestrating session on 2026-10-16; every `file:line` below was read at main
`ea4fdda` (unchanged at `922b567`; `CONTEXT.md` sits a few lines lower after #586: re-find by the quoted text).
Main has since moved to `239e389` (U4 #592, T1 #591, R2 #594 merged): the "Anchors at `239e389`" table right after
this header gives the current numbering for the anchors that moved; R1 will move `live.ts` again, so re-find by the
quoted text on the tree you cut from.
Round 2 (read-only Sonnet, at `239e389` with R2's real `onCorrupt: "keep"` API; Step 1 applied, V1/Q4b/M8 run): the
round-1 fixes hold against the merged code (the Decision-3 claims about `requests.ts` and `requestOutcome` are true,
`resetKeptCorruptForTest()` and the 4th-argument option match `storage.ts:145,170`, the guard does fail without the
`afterEach`, the four per-field cases kill their mutants, `tsc` shows exactly the five stubs, a file carrying R1's
`global` record passes). One major, applied: the first four V1 element cases had no `plugins` key, so they returned
`null` at the now-required `plugins` check and three element mutants survived; every V1 element case now carries
`"plugins":{}`. Also applied: the refusal text no longer claims "the bot's log says why" for the pre-`initRouting`
`false` (that branch logs nothing); Q2's harness option is named; Decision 3 says the drain's hold is bounded at 5 min;
`gateCommand`'s per-refusal read is stated; the `requests.ts` row text left over from the first draft ("resolves at the
write") is corrected to the declined design; anchors re-stamped.
Audited read-only before it was committed (a Sonnet agent, Steps 1-5 and the tests applied to a scratch copy with an
R2 stand-in for `onCorrupt: "keep"`; 974 pass on the verification set, M1-M7 and eight extra mutants killed); every
finding was applied: the one blocker was Decision 3 (recording a `routing-set` before its re-registration finished
made the panel's "applied" view wrong exactly when registration is slow -- `requestOutcome`, `index.html:4005-4029`,
reads `discovery.guilds[].commands` the moment the result appears, shows "Not registered yet." and offers "Check
again" only in the timeout phase), so #484 item 1 is now DECLINED in writing and the docstring is fixed instead;
`isDiscoveryShape` must require `plugins` to be an object (`requests.ts:162` does `Object.hasOwn(discovery.plugins,
plugin)` and threw on `{"guilds":[...]}` in a real `routing-set` probe); four per-field V1 cases were added because
dropping any one of the guild `id`/`name` or channel `id`/`name` checks survived all 631 tests; six existing tests and
five `refreshDiscovery` stubs the first draft never named are listed; the `expect().resolves` form of a never-settling
test hangs Bun 1.4.2 instead of failing (moot now that Q1 is gone, kept as a rule); the keep-mode reads need R2's
`resetKeptCorruptForTest()`; the `ops/README.md` mailbox edits were phantom (no such text) and are gone; a direct
`Object.hasOwn` pin is added; anchors in `host.ts`, `post.test.ts` and `src/plugins/requests.test.ts` corrected.
ORDER: cut this bundle AFTER R1 (`528-R1-register-live.md`, which restructures `live.ts`'s
`applyRouting` and adds `applyRoutingFor`) and R2 (`528-R2-model-store-resolve.md`, which gives `readJsonOrFresh` the
`onCorrupt: "keep"` option this bundle uses for `readDiscovery`) have merged; it edits `live.ts`'s `writeView` and
`refreshDiscovery` (lines R1 leaves alone, but the same file) and `discovery.ts`'s `readDiscovery` (which R1 reads and
does not edit). Nothing else in flight touches these files. -->

**Anchors at `239e389`** (only the ones that moved; every other anchor in this plan was confirmed in round 2):

| Anchor in this plan | What | At `239e389` |
|---|---|---|
| `src/plugins/requests.ts:389-408` | the drain records the result after `applyRoutingRequest` | `:428-455` (`applyRoutingRequest` `:428`, `mutateRouting(withResult)` `:450`) |
| `src/index.ts:305-340` | the two `gateCommand` calls | `:320-327` and `:348-355` (handler block `:314-357`) |
| `src/index.ts:257`, `:65` | host's `readDiscovery`, its import | `:260`, `:67` |
| `src/index.test.ts:398-400` | the `gateCommand(` regex | `:436-438` (the regex `:437`) |
| `src/plugins/requests.test.ts:623`, `:1734` | the two `refreshDiscovery` stubs | `:853`, `:1972` (`:853` is `async () => void calls.push(...)`: give it a body that pushes and returns `true`) |
| `src/routing/secrets-leak.test.ts:128`, `:307`, `:224` | two stubs, the old-reason pin | `:141`, `:321`, `:237` |
| `src/routing/live.test.ts:416` | `refreshDiscovery` describe | `:419` (cases `:420`, `:425`, `:445`, `:462`, `:482`) |
| `src/announce.ts:285`, `:368-396` | caller, live deps | `:291`, `:368-397` (`refreshDiscovery,` `:392`) |
| `CONTEXT.md:368`, `:1949` | gate gotcha ("fails open"), the awaited-order line | `:374`, `:1995` |

## Implementation plan -- #528 R3: `discovery.json` is validated element by element, a refusal never names a channel that is gone, a `discovery-refresh` says whether it refreshed, a `routing-set`'s timing is stated truthfully (and left as it is), and four texts say what the code does

Children: **#482** items 4, 6, 7 (items 3 and 5 are R1's; with both in, #482 closes), **#483** (closes), **#484** item 2
fixed and item 1 DECLINED in writing (items 5 and 7 are R1's, item 6 R2's; with all three in, #484 closes), **#485** item 10 and item 9's
`requests.test.ts` half (item 8 and item 9's other half are R1's; with both in, #485 closes). One PR, branch
`fix/528-R3-requests-gate-discovery`, worktree `S:\Repos\_wt\rdb-528-R3` cut from `origin/main` once R1 and R2 are on
it. Behaviour changes (a refusal's channel list, a request's result timing, a refusal for a failed refresh, a stricter
discovery read) -> the **three-reviewer gate** applies; every changed production line mutation-tested in a scratch
worktree. The routing file shapes and `ROUTING_VERSION` do not change; `discovery.json`'s shape does not change (its
READ gets stricter).

### What is wrong, verified at `ea4fdda`

- **#482 item 4 (`readDiscovery` lets a malformed guild element through, and `host.ts` throws on it).**
  `readDiscovery` (`discovery.ts:187-191`) checks only that the root is an object with an array `guilds`; its docstring
  (`:180-185`) says a hand-damaged file "reads as 'not published yet' instead of throwing inside validation".
  `{"guilds":[null]}` is returned as valid; `createHostApi`'s `destinations()` (`src/plugins/host.ts:213`, the
  `guilds.find((g) => g.id ...)` evaluated lazily inside the `.map` at `:216`) throws `TypeError: null is not an object
  (evaluating 'g.id')` to the plugin (executed in audit); `checkAgainstDiscovery` (`src/routing/requests.ts:178-195`)
  survives only through its `try/catch` at `:181-187`, whose comment names exactly this case ("a guild with no
  channels list, say") -- but `requests.ts:162` does `Object.hasOwn(discovery.plugins, plugin)` OUTSIDE that net, so a
  file with no `plugins` key (`{"guilds":[{...valid...}]}`) kills a real `routing-set` with `TypeError: undefined is
  not an object` (executed in audit). `discovery.test.ts:390-425` covers the top-level shapes only.
- **#482 item 6 (the channel restriction is advisory where the bot cannot look, and two docs say "enforced").**
  `gateCommand` (`gate.ts:98-123`) fails open when the channel cannot be looked at (`where.parentUnknown`, `:114-117`) or
  the gate itself throws (`:119-122`), with a `[gate]` line; `gate.ts:7-12` and `CONTEXT.md`'s gate row say so.
  `README.md:33` ("anywhere else the reply is private and names the right channels") and ADR-0006 decision 7
  (`docs/adr/0006-per-plugin-routing.md:60-62`, "enforced by the bot at dispatch") do not. A user in a channel the bot
  cannot view (`interaction.channel` null there, the fetch failing -- the discord.js behaviour for an unviewable
  channel is inferred, not executed) runs the command.
- **#482 item 7 (`post.ts`'s header and "bad moment" comment).** `post.ts:6-8`: "with no routing, the call is exactly
  today's -- one post, as the bot, to the default channel"; `postForPlugin` posts through the DEFAULT channel's
  webhook when one is registered (`:47-48` says every target follows the same rule, `post.test.ts:138` pins it).
  `:50-51` calls "a message that is too long" a bad moment: a message over Discord's cap fails through the webhook
  and through the bot alike (`announce.ts` does not split; that the webhook answers 400 is Discord behaviour NOT
  executed here), so the fallback costs a round trip and fails the same way, every attempt.
- **#483 (a refusal names channels that may no longer exist).** `commandAllowed` returns the scope's channel ids
  (`resolve.ts:140`) and `refusalMessage` (`gate.ts:76-87`) mentions them as `<#id>`; nothing checks that a listed
  channel still exists, and no `ChannelDelete` handler prunes routing. A plugin restricted to one channel that is then
  deleted is refused everywhere in that server, naming a channel Discord renders as `#deleted-channel`, until the
  operator edits the placement.
- **#484 item 1 (a `routing-set`'s result waits for the whole re-registration).** `applyRoutingRequest`'s
  `routing-set` (`requests.ts:207-228`) awaits `deps.applyRouting(...)` (`:223`) after the write, and the drain records
  the result only when `applyRoutingRequest` resolves (`src/plugins/requests.ts:389-408`). With R1 a join is one PUT,
  but a `routing-set` is still a full run: sequential per-server PUTs plus any 429 wait (`register.ts:135-142`), behind
  whatever is queued on the chain. Past the panel's 30 s answer window the panel reports a timeout for a change that
  landed; the drain holds its critical section meanwhile. The docstring (`:197-200`) says "for `routing-set` that is
  once `routing.json` is written", which the code does not do; `CONTEXT.md`'s requests row and `:1949` state the true
  order. What the current order BUYS: the panel's `requestOutcome` (`ops/admin/public/index.html:4005-4029`) reads
  `discovery.guilds[].commands` the instant `routing.results` holds the id, so a result recorded before the
  registration ran would show "Not registered yet." (`:1824`) for a server that is about to register, or `live` for
  one Discord will refuse, with no "Check again" button (offered only in the `timeout` phase, `:1806-1808`; the panel
  polls every 2 s, `:3842`); the drain's critical section covering the registration also keeps a restart from exiting
  mid-run. Read from the panel's source, not driven in a browser.
- **#484 item 2 (`discovery-refresh` records `ok` when nothing was refreshed).** `refreshDiscovery` (`live.ts:219-225`)
  returns `Promise<void>` and swallows a failed snapshot (`takeSnapshots`, `:80-87`) and a failed write (`writeView`,
  `:91-110`); the `discovery-refresh` case (`requests.ts:308-310`) returns `{}`, so the request is recorded `ok` and
  deleted. `checkAgainstDiscovery` then re-reads the stale file and refuses a just-joined server with "not one the bot
  is in". Narrow (a `discovery.json`-only write fault, or the cache read throwing), misleading when it happens.
- **#485 item 10 (`webhook-add` refuses a non-text channel as "cannot see").** `applyRoutingRequest` checks the
  webhook's channel against `discovery.guilds[].channels` (`requests.ts:240-245`), which `snapshotGuilds` fills with
  text and announcement channels only (`discovery.ts:38`); a webhook on a forum, stage, voice or media channel is
  refused with "that webhook posts to a channel the bot cannot see", which is not why; a listed channel with
  `canSend: false` is accepted, correctly: a webhook posts with its own token, so the bot's own send permission is
  not what gates it.
- **#485 item 9, the `requests.test.ts` half.** `src/routing/requests.test.ts:766-771` is titled "webhook-remove looks
  only at the channels it holds, not at inherited keys" and says the guard is `Object.hasOwn`; the parser refuses
  `constructor` first (`bad channel id`), and `12345` is a snowflake with no webhook -- neither case can tell
  `Object.hasOwn(routing.webhooks, channelId)` from `channelId in routing.webhooks` (a digit-only id never collides
  with an inherited key). The test pins what the parser and the apply refuse, not the `hasOwn`.

### Decisions (defaults, named so the gate can contest them)

1. **`readDiscovery` validates what its readers index into:** the root object, `guilds` an array whose every
   element is an object with a string `id`, a string `name` and an array `channels` whose elements are objects with
   a string `id` and a string `name`; and `plugins` an object, REQUIRED (the `DiscoveryFile` type has it required and
   `requests.ts:162` indexes into it unguarded). A file that fails is `null` ("not published yet"), as its docstring
   already promises; the bot rewrites it on the next registration or refresh. The file is the bot's own, so this is a
   floor against hand damage, not a schema. With R2 on main it also passes `{ onCorrupt: "keep" }`: a read never
   renames the file (the write path, `writeDiscovery`, replaces it whole). `host.ts:213-216` needs no guard then;
   `checkAgainstDiscovery`'s `try/catch` (`:181-187`) stays as a second net and its comment says the first is
   `readDiscovery`. R1 interaction, said in the docs: R1's `previousScopes` uses this read as its ownership record, so
   a file the stricter read rejects reads as `null` for that run -- R1 skips its empties once and the run then rewrites
   the file, after which the next run has a valid record again.
2. **A refusal names only channels the bot can still see.** `gateCommand` gains an optional dep
   `readDiscovery?: () => Promise<DiscoveryFile | null>` (the live one from `index.ts:305-340`'s two call sites, built
   as `index.ts:257` builds the host's); on a refusal, when the file lists this guild, the channels named are the
   scope's channels that are in the guild's `channels`; if NONE remain, the gate lets the command run and says
   `[gate] every channel listed for /<cmd> in server <id> is gone from what the bot can see; letting it run`
   (fail open, as the gate does when it cannot decide); when the file is `null`, lacks the guild, or the dep is
   absent, every listed channel is named (today). The file is at most fifteen minutes stale (the `discovery` tick),
   so the staleness cuts both ways and the docs say so: a channel deleted since can still be named once, and a
   channel hand-added to `routing.json` that is not yet in the file counts as gone -- if it is the ONLY listed
   channel, the restriction lifts until the next tick (the panel path refreshes discovery first, so only a hand edit
   meets this). Pruning `routing.json` on `ChannelDelete` is declined: the file is the operator's record, and the
   panel shows the placement for them to fix.
3. **#484 item 1 is DECLINED: a `routing-set` keeps resolving after its re-registration, and the docstring says so.**
   Recording the result at the write (the first draft's design) would make the panel's "applied" view wrong exactly
   when registration is slow (see "What is wrong": `requestOutcome` reads `discovery.json` the moment the result
   appears and has no "Check again" in that phase), and would take the registration out of the drain's critical
   section (a hold that is itself bounded: the drain lets go after `REQUEST_DRAIN_TIMEOUT_MS`, 5 min,
   `src/plugins/drain.ts:26`). The timeout the issue describes is a true report of a slow registration, and the per-server outcome is in
   `discovery.json` either way. The code at `requests.ts:220-227` does not change; the docstring (`:197-202`) becomes
   "Resolves once it is APPLIED -- for `routing-set` that is once `routing.json` is written AND the re-registration it
   starts has run (one PUT per server the bot is in, plus any rate-limit wait, behind whatever is queued on routing's
   chain; a slow one can outlast the panel's 30 s window, which then reports a timeout for a change that did land --
   the per-server outcome is in `discovery.json`)". The alternative not taken, `Promise.race` with a ~10 s timer, has
   the same false-view problem for the slow case and is named in the PR; showing an in-progress registration in the
   panel is a panel follow-up for #529's A3, noted on #484 when this closes.
4. **`refreshDiscovery` reports whether it wrote** (`Promise<boolean>`: `true` when `discovery.json` was written;
   `false` before `initRouting`, when the servers could not be read, or when the write failed -- `writeView` returns
   the boolean). `applyRoutingRequest`'s `discovery-refresh` throws `RoutingRefusal("discovery could not be refreshed
   (the bot has not finished starting, or its log says why)")` on `false` (the pre-`initRouting` branch,
   `live.ts:221`, returns without a log line; the other two log), so the request is recorded refused and moved to
   `rejected/`.
   `checkAgainstDiscovery` ignores the boolean (it re-reads either way); `guildJoined`/`guildLeft` and the tick ignore
   it too.
5. **The `webhook-add` reason says what is checked:** "that webhook posts to a channel the bot does not list (it
   lists the text and announcement channels it can see)". Widening the snapshot to forums, stages and voice is
   declined: they are not channels the bot posts to, and a webhook on one is not a routing target. `canSend: false`
   stays accepted (a webhook posts with its own token).
6. **Docs:** README:33 and ADR-0006 decision 7 gain one clause each ("...enforced at dispatch where the bot can see
   the channel; where it cannot -- a channel it has no view of, a thread whose parent is unknown -- the command runs
   and the log says so"); `post.ts:6-8` says the default channel's registered webhook is used when there is one and
   `:50-51` says an over-length message fails both ways and is the plugin's bug; `requests.ts:197-202` says the true
   order (Decision 3); `requests.test.ts:766`'s title says what it pins and the stale comment at `:511-514`
   ("`readDiscovery` only checks for a list") is reworded; `CONTEXT.md`'s `discovery.ts`, `gate.ts`, `live.ts`,
   `requests.ts` and `post.ts` rows and the gate gotcha (`CONTEXT.md:368`, "fails open") follow. `ops/README.md`'s
   mailbox section quotes NEITHER the `webhook-add` reason nor a `routing-set` timing sentence (the only `cannot see`
   hit is an unrelated comment at `:911`): nothing to edit there, and `CONTEXT.md:1949` ("applied once routing.json is
   written") already describes the order Decision 3 keeps.

### Step 1 -- `src/routing/discovery.ts`

`readDiscovery` (`:187-191`):
```ts
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** #482: the shape every reader indexes into -- a guild's `id`, `name` and `channels` (each with `id` and `name`) --
 *  so a hand-damaged element reads as "not published yet" here, not as a TypeError in a plugin's `destinations()`
 *  or the mailbox's check. The bot is the only writer; this is a floor, not a schema. */
function isDiscoveryShape(raw: unknown): raw is DiscoveryFile {
  // `plugins` is REQUIRED: the type says so and requests.ts:162 does Object.hasOwn(discovery.plugins, plugin).
  if (!isRecord(raw) || !Array.isArray(raw.guilds) || !isRecord(raw.plugins)) return false;
  return raw.guilds.every(
    (g) =>
      isRecord(g) && typeof g.id === "string" && typeof g.name === "string" && Array.isArray(g.channels) &&
      g.channels.every((c) => isRecord(c) && typeof c.id === "string" && typeof c.name === "string"),
  );
}
export async function readDiscovery(dataDir: string): Promise<DiscoveryFile | null> {
  // A read never renames the file (R2's `onCorrupt: "keep"`): `writeDiscovery` replaces it whole on the next run.
  const raw = await readJsonOrFresh<unknown>(discoveryPath(dataDir), () => null, "discovery", { onCorrupt: "keep" });
  return isDiscoveryShape(raw) ? raw : null;
}
```
The docstring (`:180-185`) says which fields are checked and that a `commands`/`canSend` of the wrong type is NOT
(nothing throws on those).

### Step 2 -- `src/routing/gate.ts` and `src/index.ts`

2a. `gateCommand` (`:98-123`) gains a last parameter `readDiscovery?: () => Promise<DiscoveryFile | null>`; after
`const verdict = ...` and the `parentUnknown` branch:
```ts
    // #483: a listed channel the operator has since deleted would be named as `#deleted-channel`. Keep the ones the
    // bot can still see (discovery.json, at most a tick old); with none left the restriction points nowhere, so the
    // command runs and the log says so. No file, or a file without this server, names them all, as before.
    const visible = await visibleChannels(verdict.channels, here.guildId, readDiscovery);
    if (visible !== undefined && visible.length === 0) {
      log.error(`[gate] every channel listed for /${commandName} in server ${here.guildId} is gone from what the bot can see; letting it run`);
      return undefined;
    }
    return refusalMessage(commandName, visible ?? verdict.channels);
```
with
```ts
/** The channels of `listed` that `discovery.json` shows in `guildId`; `undefined` when there is nothing to check
 *  against (no dep, no file, no such server, or a read that throws -- the caller then names them all). */
async function visibleChannels(listed: readonly string[], guildId: string, readDiscovery?: () => Promise<DiscoveryFile | null>): Promise<string[] | undefined> {
  if (readDiscovery === undefined) return undefined;
  try {
    const guild = (await readDiscovery())?.guilds.find((g) => g.id === guildId);
    if (guild === undefined) return undefined;
    const seen = new Set(guild.channels.map((c) => c.id));
    return listed.filter((id) => seen.has(id));
  } catch {
    return undefined;
  }
}
```
(`DiscoveryFile` as a type import from `./model`.) The header (`:1-18`) says a refusal names channels the bot can
still see.

2b. `index.ts:305-340`: both `gateCommand(` calls pass `() => readDiscovery(DATA_DIR)` as the new last argument
(`readDiscovery` is imported at `:65`). The read happens only on a REFUSAL (never on an allowed command), which for
the autocomplete call site means one small file read per refused keystroke; accepted (the dispatcher already bounds a
slow gate) and named in the PR. A source pin in `index.test.ts`: both `gateCommand(` call texts contain
`readDiscovery(DATA_DIR)`.

### Step 3 -- `src/routing/live.ts`

`writeView` (`:91-110`) returns `Promise<boolean>` (`true` after `writeDiscovery` resolves; `false` from the catch);
`refreshDiscovery` (`:219-225`) returns `Promise<boolean>`: `false` before `initRouting`, `false` when
`takeSnapshots` is `null`, else `writeView`'s value. `applyRouting`/`applyRoutingFor` (after R1) ignore `writeView`'s
value. The docstring says what the boolean means; `guildJoined`/`guildLeft` (`:280`, `:299`) and `announce.ts:285`
need no change (an ignored boolean).

### Step 4 -- `src/routing/requests.ts`

4a. `RoutingRequestDeps.refreshDiscovery` (`:154`): `() => Promise<boolean>` (`announce.ts:368-396`'s live deps --
`announce.ts` sits six lines lower than the first draft's anchors after line 261 -- already pass `refreshDiscovery`
from `live.ts`; the type follows). FIVE test stubs stop compiling and each must return `true`, NOT a cast (an
`undefined` return would turn every `discovery-refresh` test into a refusal under 4c): `src/plugins/requests.test.ts:623`
and `:1734` (the file shifted +34 since `ea4fdda`; `routingFake` is at `:602`), `src/routing/requests.test.ts:117`,
`src/routing/secrets-leak.test.ts:128` and `:307`.

4b. `routing-set` (`:220-227`): NO code change (Decision 3). The docstring (`:197-202`) is rewritten to the text in
Decision 3.

4c. `webhook-add` (`:243`): the reason per Decision 5. `discovery-refresh` (`:308-310`):
```ts
    case "discovery-refresh":
      if (!(await deps.refreshDiscovery())) throw new RoutingRefusal("discovery could not be refreshed (the bot has not finished starting, or its log says why)");
      return {};
```
`checkAgainstDiscovery` (`:189`): `await deps.refreshDiscovery();` stays (the boolean ignored; the comment at
`:184-187` names `readDiscovery` as the first net now).

### Step 5 -- `src/routing/post.ts` comments

`:6-8` -> "The governing rule: with no routing, one post to the default channel -- as the bot, or through the default
channel's webhook when one is registered (the one rule every target follows) -- and a failure there propagates (...)".
`:50-51` -> "A rate limit, a 5xx or a timeout is a bad moment, not a dead webhook. A message over Discord's cap is
neither: it fails through the webhook and as the bot alike (nothing here splits it), so the fallback costs one
round trip and fails the same way; a plugin that produces one is the thing to fix." No code change.

### Step 6 -- docs

- `README.md:33`: after `anywhere else the reply is private and names the right channels` append ` — where the bot
  can see the channel; where it cannot, the command runs and the log says so`.
- `docs/adr/0006-per-plugin-routing.md:60-62`: decision 7's first sentence gains ", where the bot can see the channel
  (where it cannot -- a channel it has no view of, a thread whose parent is unknown -- the command runs and the log
  says so, `gate.ts`); a refusal names only channels the bot can still see (#483)". One clause; the ADR is not
  rewritten.
- `CONTEXT.md` rows (Grep each `| \`src/routing/<file>.ts\` |`): `discovery.ts` (`readDiscovery` validates guild and
  channel elements; a corrupt file is kept in place); `gate.ts` (the refusal names only visible channels; the all-gone
  case lets the command run); `live.ts` (`refreshDiscovery(): Promise<boolean>`); `requests.ts` (`routing-set`
  resolves after its re-registration has run, as today, and the docstring now says so (Decision 3);
  `discovery-refresh` refused when nothing was written; the
  `webhook-add` reason); `post.ts` (the header's rule). The gate gotcha (`CONTEXT.md:368`, Grep `fails open`): the
  deleted-channel case and the both-ways staleness (Decision 2). The `requests.ts` row and `CONTEXT.md:1949` keep
  the awaited order (Decision 3) -- read them and change nothing that is still true.
- `ops/README.md`: nothing (verified: no quoted reason, no timing sentence). A panel gap to NAME in the PR and on
  #484, not fix: the per-plugin "Refresh from Discord" poll (`ops/admin/public/index.html:1719-1735`) treats any
  result as success, so a refused `discovery-refresh` would still toast "Read from Discord again." (the Servers tab
  handles `ok: false`, `:2455`); that is #529 A3's.

### Step 7 -- tests

**`src/routing/discovery.test.ts`** (`readDiscovery (#241)` at `:390`): **V1:** `{"guilds":[null],"plugins":{}}`,
`{"guilds":[{"id":1}],"plugins":{}}`, `{"guilds":[{"id":"1","name":"x","channels":"none"}],"plugins":{}}`,
`{"guilds":[{"id":"1","name":"x","channels":[null]}],"plugins":{}}`, `{"guilds":[],"plugins":[]}`, `{"guilds":[]}` (no
`plugins`) each -> `null`. Every ELEMENT case carries a valid `"plugins":{}`: without it the case stops at the
`plugins` check and never reaches the element check it pins (round 2: dropping `isRecord(g)`,
`Array.isArray(g.channels)` or `isRecord(c)` survived the list as first worded); only the two `plugins` cases omit or
break it; FOUR per-field cases, each -> `null` (without them, dropping any one check survives the whole suite:
the id and name cases mask each other): `{"guilds":[{"id":"1","channels":[]}],"plugins":{}}` (no guild name),
`{"guilds":[{"name":"x","channels":[]}],"plugins":{}}` (no guild id),
`{"guilds":[{"id":"1","name":"x","channels":[{"name":"c"}]}],"plugins":{}}` (no channel id),
`{"guilds":[{"id":"1","name":"x","channels":[{"id":"c"}]}],"plugins":{}}` (no channel name); a good file with
`commands: null` and with `commands: { registered: 0, at }` -> returned; a file with an extra unknown top-level key
-> returned (R1's `global` must pass); a corrupt file -> `null` AND the file still there (no `.corrupt-` sibling) --
and the EXISTING test at `:397-403`, which asserts a `.corrupt-` sibling exists, flips to "no sibling" (list it as
changed). Both keep-mode reads touch R2's `keptCorrupt` set, which the state guard watches: this file's `afterEach`
calls `resetKeptCorruptForTest()` (from `../storage`), or the guard fails them.

**`src/routing/gate.test.ts`** (`gateCommand` at `:42`; the helper that builds the deps, read it): **G1 (#483):** a
scope `[C1, C2]` with discovery listing only `C2` in the guild -> the refusal names `C2` alone; listing neither ->
no refusal, one `[gate] every channel listed ... gone` error line; no `readDiscovery` dep -> both named (today);
`readDiscovery` returning `null`, a file without the guild, or throwing -> both named, no error line; a thread under
a gone channel -> the same filtering on the parent's verdict.

**`src/routing/requests.test.ts`** (the harness and `events`; `applyRoutingRequest` describe): **Q1 is GONE with
Decision 3** (a rule for anyone tempted to write a never-settles test here: `await expect(neverSettling).resolves...`
never times out on Bun 1.4.2 -- it hung 100 s in audit -- so such a test is written as a plain `await` of the call, or
a `Promise.race` with a short timer); the existing awaited-order tests stay as they are. **Q2 (#484-2):**
`refreshDiscovery` resolving `false` -> `discovery-refresh` is refused with `discovery could not be refreshed`;
`true` -> `{}` (the `:773-777` test gains the value); `checkAgainstDiscovery` with a `false` refresh still re-reads (a
`routing-set` whose first check fails and whose refreshed file passes -> applied). The harness (`harness(` at `:65`,
its `refreshDiscovery` stub at `:117`) has no way to answer `false`: add an option `refreshOk?: boolean` (default
`true`), the stub swapping in `afterRefresh` as today and then returning `refreshOk`; **Q3 (#485-10):** the new reason
text for a channel not listed, AND `src/routing/secrets-leak.test.ts:224`, which pins the OLD text `that webhook posts
to a channel the bot cannot see`, is updated with it (the first draft listed only `requests.test.ts:649`); **Q4
(#485-9):** `:766-771` retitled "a channel id that is not a snowflake is refused by the parser; a snowflake with no
webhook by the apply" and its comment reworded (no `hasOwn` claim); **Q4b (the real `hasOwn` pin):** bypass the parser
and call `applyRoutingRequest({ action: "webhook-remove", channelId: "constructor", requestedBy }, deps)` directly
-> refused as "no webhook" (not applied); with `Object.hasOwn(routing.webhooks, channelId)` and its `secrets.webhooks`
twin mutated to `channelId in routing.webhooks` the call reaches the apply (verified in audit: this is the only test
that kills M8).

**`src/routing/live.test.ts`** (`refreshDiscovery` at `:416`): the five cases assert the boolean: pre-init `false`;
reuse `true`; queued-behind `true`; cache exploded `false`; write fails `false`.

**`src/plugins/requests.test.ts`:** no latch test (Decision 3). The two `refreshDiscovery` stubs (4a) return `true`.

**`src/index.test.ts`:** the `gateCommand(` source pin (2b) -- AND the existing regex at `:398-400`, which ends
`console,?\s*\)`, fails once `gateCommand(` has a seventh argument: edit that regex to accept the new last argument;
it is not enough to add the new pin beside it.

### Mutation table (scratch worktree; `bun test src/routing/ src/plugins/requests.test.ts src/index.test.ts` per mutant)

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | 1: the element checks dropped (`Array.isArray(guilds)` only) | V1 |
| M1b | 1: `channels` elements not checked (`isRecord(c)` dropped), or `Array.isArray(g.channels)` dropped, or `isRecord(g)` dropped -- one at a time | V1's `channels: [null]`, `channels: "none"` and `guilds: [null]` cases (each with `"plugins":{}`) |
| M1c | 1: `onCorrupt: "keep"` dropped | V1's corrupt case and the flipped `:397-403` test (a `.corrupt-` sibling) |
| M1d-M1g | 1: the guild `id` / guild `name` / channel `id` / channel `name` check dropped, one at a time | V1's matching per-field case (each survives every other test) |
| M1h | 1: the `plugins` check dropped | V1's `plugins: []` and no-`plugins` cases |
| M2 | 2a: `visibleChannels` returns `listed` unfiltered | G1 (both named) |
| M2b | 2a: the all-gone branch refuses with an empty list | G1 (a refusal text with no channel) |
| M2c | 2a: a `null` file treated as "all gone" (lets everything run) | G1's `null` case (no refusal) |
| M3 | 2b: one `gateCommand(` call without the dep | the index pin |
| M5 | 3: `writeView` returns `true` from its catch | the live refresh cases (`write fails` -> `true`) |
| M5b | 3: `refreshDiscovery` returns `true` on a null snapshot | `cache exploded` -> `true` |
| M6 | 4c: the `false` branch dropped | Q2 |
| M7 | 4c: the old `cannot see` reason | Q3, `secrets-leak.test.ts:224` |
| M8 | `Object.hasOwn(routing.webhooks, id)` and its secrets twin -> `id in ...` | Q4b only (every other test passes, verified) |

(M4/M4b of the first draft went with Decision 3.)

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #482-4: a malformed guild or channel element, or a missing `plugins`, reads as not published; the host's `destinations()` and `requests.ts:162` cannot throw on it | 1 | V1 | M1, M1b, M1c, M1d-M1g, M1h |
| #482-6: README and the ADR say where the restriction is advisory | 6 | lens-B audit | -- |
| #482-7: `post.ts`'s header and the over-length comment are true | 5 | lens-B audit | -- |
| #483: a refusal names only channels the bot can still see; all gone lets it run, said | 2 | G1 | M2, M2b, M2c, M3 |
| #484-1: DECLINED in writing; the docstring states the true order and the panel reason | 4b (docstring), 6 | lens-B audit | -- |
| #484-2: a refresh that wrote nothing is a refused request | 3, 4c | Q2, the live boolean cases | M5, M5b, M6 |
| #485-10: the `webhook-add` reason says what is checked, on both texts | 4c | Q3 | M7 |
| #485-9 (requests half): the test says what it pins, and `hasOwn` is really pinned | 7 | Q4 (title), Q4b | M8 |

### Verification

```bash
bun install --frozen-lockfile
bun run check
bun test src/routing/ src/plugins/requests.test.ts src/plugins/host.test.ts src/index.test.ts src/announce.test.ts test/stateGuard.test.ts
bun test
```

Keep the explicit file list (`bun test src test` filters by substring and drags in `ops/bot-ops.test.ts`). Not
verifiable here: discord.js's `interaction.channel` for a channel the bot cannot view (the #482-6 wording is "where it
cannot", which the gate's own code path covers); that a webhook answers 400 to an over-length message (the `post.ts`
comment no longer states the code); the panel's behaviour was read from its source, not driven.

### Acceptance to paste per issue

- **#482 (items 4, 6, 7):** V1's pass line, M1-M1c; the README/ADR/`post.ts` diffs; items 3 and 5 named as R1's.
- **#483:** G1's pass line, M2-M3; the `[gate]` line text; the prune-on-delete decline.
- **#484 (item 2 fixed; item 1 declined):** Q2 and the live boolean cases, M5-M6; the decline with Decision 3's
  reason, the `Promise.race` alternative named, the A3 panel follow-ups (in-progress registration; the "Refresh from
  Discord" poll's `ok: false`); items 5, 7 (R1) and 6 (R2) named.
- **#485 (item 10; item 9's requests half):** Q3 and M7; the retitled test, Q4b and M8; items 8 and 9's live half
  named as R1's.

### PR

- Title: `fix(routing): validate discovery.json's elements, name only channels that still exist in a refusal, refuse a discovery-refresh that wrote nothing, state a routing-set's true timing, and fix four texts (#482, #483, #484, #485)`.
- Body: the items, Decisions 1-6, the typecheck + test output, the mutation table, the declines (prune on delete;
  widening the snapshot; #484 item 1). End with `Closes #483.`; #482, #484, #485 "Part of" (each closes once its R1/R2
  items are in too; say which PR carried which).
- After merge: tick #483 on #528 and whichever of #482/#484/#485 is then complete; item comments on the rest.

### Out of scope, on purpose

- Pruning `routing.json` on `ChannelDelete` (Decision 2).
- Recording a `routing-set` before its registration has run (Decision 3; the panel work it needs is A3's).
- Snapshotting non-text channels (Decision 5).
- Skipping the webhook attempt for an over-length message (Decision 6: the plugin's bug).
- Everything in R1 and R2.
