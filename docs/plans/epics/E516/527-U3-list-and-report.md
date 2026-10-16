<!-- Plan for #527 bundle U3 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #527): the `/plugins list` and the
boot report-back rendering in `src/plugins/updates.ts` -- #443, #501 item 11, #502 item 13, #563 and #418. Written by
the orchestrating session on 2026-10-16 against main `903fc69` (unchanged in these regions at `ea4fdda`); every
`file:line` below was read at that sha. U2 (PR pending from Sub #1) edits the same file below `renderPluginsList` (the
notice loop, the arbiter) and renames `runDueSchedules`; the functions this bundle edits (`shortError` `:175-183`,
`renderPluginsList` `:188-233`, `reportPluginUpdateOutcome` `:716-746`) are untouched by U2 apart from line shifts, so
re-find each by name on the tree after U2 has merged. Audited read-only before it was committed in two rounds (a
Sonnet agent; steps 1-3 applied to a scratch copy, every mutant run, a 273,434-case exhaustive comparison of
`cutUtf16` against the old guard with 0 differences, a 40,000-list tier fuzz with 0 overflows, 0 lone surrogates and
0 partial lines, and a 5,000-list byte-identity check for short lists); every finding was applied -- round 2: the
per-note emoji case needed no prefix (an even-length one keeps the pairs aligned), five boundary operators and the
tier-2 note/tail order gained one pin each (L4h, L4g2), the README scoping and the "keeps every plugin's first line"
claim were narrowed to "while the first lines fit"; round 1: the emoji-boundary test has to put the emoji in a FIRST LINE (notes never reach the cut under the new
assembly) and `cutUtf16("ab🙂", 3)` never ran the back-off; the caller test must be end-to-end with two plugins or a
`0` survives it; the per-note `slice(0, 300)` was a second blind cut (2,528 lone surrogates in a 20,000-list fuzz, all
from it); the notes tier is now progressive, as the prose already said; the `plugin`/`requestedAt` guard gets one
mutant and one raced report per conjunct; two changed lines (the bare-heads return and the note/tail order) gained
tests; the race comment named the boot drain, which cannot race the report-back (it is awaited first); the README
sentence is scoped to a scheduled update; thirteen existing `renderPluginsList(` calls need the new argument. -->

## Implementation plan -- #527 U3: the report-back clears only the report it read and the test pins the order, the list names an incompatible version and the requester of a schedule, and its clamp never splits an emoji, keeps every plugin's first line, and cuts whole lines

Children: **#443** (closes), **#563** (closes), **#418** (closes), **#501** item 11 (with U2's items 4 and 8 and U1's
5 and 10, every item is done: closes #501), **#502** item 13 (with U2's 12 and 14: closes #502). One PR, branch
`fix/527-U3-list-and-report`, worktree `S:\Repos\_wt\rdb-527-U3` cut from `origin/main` AFTER U2 has merged (same
file). Behaviour changes in a reply and the report-back -> the **three-reviewer gate** applies; every changed production
line mutation-tested in a scratch worktree.

### What is wrong, verified at `903fc69`

- **#443.** `reportPluginUpdateOutcome` (`:716-746`) clears `pendingReport` through the shared mutator (`:720-724`)
  BEFORE delivering (`:733-745`); the test "clears pendingReport BEFORE delivering, then DMs the requester"
  (`src/plugins/updates.test.ts:851-856`) asserts `h.state.pendingReport` only after the call returns, and the
  harness's `dmUser`/`postChannel` (`:836-837`) record content only. Move the clear below the delivery (the panel path
  clears before its early return) and all four report tests stay green (measured); the no-refire guarantee
  (`CONTEXT.md:375`: "clearing `pendingReport` before delivery") is unguarded.
- **#501 item 11.** That mutate deletes ANY `pendingReport` (`:720-724`), not the one it read at `:717-718`: a report
  written between the read and the mutate by the 5 s `pluginRequests` tick (a panel `update-now`), the plugin-update
  check (a due schedule: on the 15-minute poll gate at `903fc69`, `announce.ts:264-266`; every 60 s tick once U2's
  #442 lands) or a `/plugins update` command is deleted unseen and that update's DM never goes out. (Not the boot
  mailbox drain: `index.ts:526-534` awaits it before `:542` calls the report-back.)
- **#502 item 13.** `renderPluginsList(state, index, _now)` (`:188-233`) prints `→ X available` (`:207`) for a newer
  index version whatever its `hostApiVersion`; the notice (`notificationMessage`, `:154-169`) and `/plugins update`
  (`planPluginAction`, `:440-444`) call the same version "needs a newer bot". Its one non-test caller is
  `src/commands.ts:191` (`renderPluginsList(state, index, new Date())`; `HOST_API_VERSION` is already imported at
  `commands.ts:26`); `updates.test.ts` calls it thirteen times.
- **#563.** The list's clamp (`:228-232`) is a blind `out.slice(0, MESSAGE_LIMIT - trunc.length) + trunc`: the cut
  can land inside a surrogate pair (`shortError` `:175-183` already guards its own cut), mid-line, and in list order,
  so a plugin that is down (the `— not running` marker, #562) can be the one cut off while running plugins with long
  release notes stay. A second blind cut sits at `:211`: `firstBlock.slice(0, 300)` on the release note -- a note
  that puts a pair across unit 300 renders a lone surrogate in a list that FITS (a 20,000-list fuzz: 0 from the clamp
  once fixed, 2,528 from this slice).
- **#418.** `ops/README.md:85-86`: "`requestedBy` is the panel identity (`email:<addr>` or `token`), recorded in
  `state.json` and shown by `/plugins list`"; `renderPluginsList` prints a schedule's `version` and `at` only
  (`:199`, `:223`), never `scheduled.requestedBy`; and an `update-now`'s requester lives only in the transient
  `pendingReport`, which the list never shows.

### Decisions (defaults, named so the gate can contest them)

1. **The report-back deletes only the report it read** (same `plugin` and `requestedAt`); a newer one written in
   between survives and goes out at the next boot's report-back (or, for a due-schedule one, after that restart).
2. **The clear-before-deliver order is pinned at the consumer:** the harness's `dmUser` and `postChannel` snapshot
   `current.pendingReport` at call time; the test asserts it was already `undefined`.
3. **The list says "(needs a newer bot)" after "available"** when the entry's `hostApiVersion` differs from the one
   passed in -- a fourth, REQUIRED parameter `hostApiVersion: number`, which the caller passes as `HOST_API_VERSION`
   (`updates.ts` keeps importing nothing but types from `./contract`; the caller already knows the constant).
4. **One surrogate-safe cut, three tiers, whole lines:** `sliceUtf16(s, n)` (a slice that backs off one unit when
   the last kept unit is a high surrogate) is used by the per-note cut (`:211`, no ellipsis, output unchanged except at
   the boundary) and by `cutUtf16(s, max)` (`shortError`'s guard, with the ellipsis), which the list's last tier
   uses. The assembly: (tier 1) everything fits -> as today; (tier 2) every plugin's first line (with its `— not
   running` marker and its schedule line) fits with the tail -> the first lines of ALL plugins, then each plugin's
   release note IN LIST ORDER when it still fits (a greedy fill, so a small overflow keeps most notes, as today),
   then the `… (list truncated)` tail; (tier 3) the first lines alone overflow -> WHOLE first lines from the top, cut
   at the last line break that fits, then the tail; a single first line longer than the cap (a hostile name) is cut
   with `cutUtf16`. When the first lines fit in 2,000 units but not with the tail, the first lines go out bare (no
   note, no tail: every plugin named beats the tail). A list with twelve plugins and one down keeps the down one's
   line. The tail is appended only when something was dropped.
5. **The schedule line names its requester:** `⏳ update to X scheduled <t:…:R> (requested by <@id>)` for a Discord
   snowflake (`isDiscordUserId`), `(requested by email:me@x.com)` for a panel identity, collapsed to one line, cut to
   80 units with `cutUtf16`, and `?` for a blank (a hand-edited `state.json` must not break the list). The README
   sentence is scoped to a SCHEDULED update (an `update-now`'s requester is not in the list).

### Step 1 -- `src/plugins/updates.ts`

1a. Above `shortError`'s #544 docstring (`:175`), so that docstring stays on `shortError`:

```ts
/** `s` cut to at most `n` UTF-16 units, never inside a surrogate pair: when the last kept unit would be a high
 *  surrogate the cut backs off one unit (#563). No ellipsis -- see `cutUtf16` for the one that marks the cut. */
export function sliceUtf16(s: string, n: number): string {
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return s.slice(0, n > 0 && last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

/** `s` cut to `max` units with an ellipsis when anything was cut, surrogate-safe (`sliceUtf16`): the `shortError`
 *  guard (#544), shared with the list's clamp (#563). Byte-identical to the old guard for every `max` >= 1. */
export function cutUtf16(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${sliceUtf16(s, Math.max(0, max - 1))}…`;
}
```

`shortError` becomes `return cutUtf16(oneLine, max);` after the collapse (keep its `undefined`/`""` contract and its
120 default; the existing #544 tests at `:254-320` pin the cut at 120, not 119 or 121, and the emoji case). The
per-note cut at `:211`: `firstBlock.slice(0, 300)` -> `sliceUtf16(firstBlock, 300)`.

1b. `renderPluginsList(state, index, _now, hostApiVersion: number)` (`:188-233`): per plugin, build `line` (the first
line: name, installed, `→ X available`, `(skipped)`/`(remind …)`, the #544 marker), `note` (the release-note block,
`""` when none) and `tail` (the schedule line, if any; it FOLLOWS the note, as today) separately; after
`→ ${entry.version} available` append `` ${entry.hostApiVersion !== hostApiVersion ? " (needs a newer bot)" : ""} ``
(#502 item 13); the schedule line (both the off branch `:199` and `:223`) becomes
`` `\n  ⏳ update to ${p.scheduled.version} scheduled ${discordTs(Date.parse(p.scheduled.at), "R")} (requested by ${requester(p.scheduled.requestedBy)})` ``
with

```ts
const requester = (by: unknown): string => {
  if (typeof by === "string" && isDiscordUserId(by)) return `<@${by}>`;
  const text = String(by ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? "?" : cutUtf16(text, 80);
};
```

(#418). The assembly (`:227-232`) becomes:

```ts
  // #563: Discord's cap, in three tiers. Everything fits: as is. Else every plugin's first line (its down marker and
  // schedule line included) comes before any release note: the notes follow in list order while they still fit, and
  // the tail says some were dropped. If even the first lines overflow with the tail, whole first lines from the top;
  // a single first line over the cap (a hostile name) is cut surrogate-safe.
  const trunc = "\n… (list truncated)";
  const full = rows.map((r) => r.line + r.note + r.tail).join("\n");
  if (full.length <= MESSAGE_LIMIT) return full;
  const headsOnly = rows.map((r) => r.line + r.tail).join("\n");
  const cap = MESSAGE_LIMIT - trunc.length;
  if (headsOnly.length > cap) {
    if (headsOnly.length <= MESSAGE_LIMIT) return headsOnly; // every plugin named, no room for the tail
    const lastBreak = headsOnly.lastIndexOf("\n", cap);
    return (lastBreak > 0 ? headsOnly.slice(0, lastBreak) : cutUtf16(headsOnly, cap)) + trunc;
  }
  let room = cap - headsOnly.length;
  const shown = rows.map((r) => {
    if (r.note === "" || r.note.length > room) return r.line + r.tail;
    room -= r.note.length;
    return r.line + r.note + r.tail;
  });
  return shown.join("\n") + trunc;
```

(`rows` is the per-plugin `{ line, note, tail }` the map now returns; the off-entry branch returns
`{ line: offLine, note: "", tail }`. A short list renders byte-identical to today's, schedule line after the note
included -- a 5,000-case fuzz in audit confirmed it, modulo the new requester text. The docstring (`:185-187`) gains
the tiers and the caveat.)

1c. `reportPluginUpdateOutcome` (`:720-724`):

```ts
  await deps.mutateState((s) => {
    // #501 item 11: only the report read above. One written since -- by the 5 s request drain (a panel update-now),
    // the 60 s tick (a due schedule) or a /plugins update -- is someone else's and must survive to be delivered.
    if (s.pendingReport?.plugin !== report.plugin || s.pendingReport.requestedAt !== report.requestedAt) return s;
    const next = { ...s };
    delete next.pendingReport;
    return next;
  });
```

### Step 2 -- callers and docs

- `src/commands.ts:191`: `renderPluginsList(state, index, new Date(), HOST_API_VERSION)` (already imported, `:26`).
- `src/plugins/updates.test.ts`: every existing `renderPluginsList(` call -- thirteen at `903fc69` -- gains `, 1` as
  its fourth argument (`bun run check` reports each as TS2554; two also fail at runtime without it: the `(skipped)`
  test and the marker test). After U2 merges, re-find the cited tests (`:229`, `:238`, `:313`, `:851`, `:857`) by
  title.
- `ops/README.md:86`: `recorded in \`state.json\` and shown by \`/plugins list\`` -> `recorded in \`state.json\` and, for a scheduled update, shown by \`/plugins list\` (an update-now's requester is kept only on the transient pending report)`.
- `README.md:121` (`/plugins list` "shows each installed plugin, any newer version, whether it's skipped or snoozed, and
  whether it was left not running") gains "whether a newer version needs a newer bot, and who requested a pending
  schedule".
- `CONTEXT.md:221` (the `updates.ts` row): append `` ; **#443/#501/#502/#563/#418:** `reportPluginUpdateOutcome` deletes only the report it read; `renderPluginsList(state, index, now, hostApiVersion)` says "(needs a newer bot)", names a schedule's requester, and when it must truncate puts every plugin's first line ahead of the release notes while the first lines fit (notes in list order while they fit; past that, whole first lines from the top, so a plugin after the cut is dropped with its schedule line), and never splits a surrogate pair (`sliceUtf16`/`cutUtf16`, shared with the per-note cut and `shortError`) ``; `:222` (the tests row): the new tests.
- `CONTEXT.md:375` (the clear-before-delivery sentence) is now pinned; no text change.

### Step 3 -- tests (`src/plugins/updates.test.ts` unless noted; each test title carries its `L<n>` tag so a pass line can be pasted with `-t`)

- **L1 (#443):** the report harness (`:828-841`) records `seenAtDm: (PluginStateFile["pendingReport"] | undefined)[]`
  and `seenAtChannel` from `current.pendingReport` inside `dmUser`/`postChannel`; the test at `:851` asserts
  `h.seenAtDm` equals `[undefined]` (one DM, cleared BEFORE it) beside the existing `h.dms[0]` assertion, and the
  fallback test at `:857` asserts `h.seenAtChannel` equals `[undefined]`.
- **L2 (#501 item 11):** harness option `raceReport?: PluginStateFile["pendingReport"]`: applied like U2's
  `rescheduleRace`, it swaps `current.pendingReport` for the given report before the first mutate runs. Two cases,
  one per conjunct of the guard: (a) the raced report has a DIFFERENT `plugin` and the SAME `requestedAt` as the
  original; (b) the SAME `plugin` and a DIFFERENT `requestedAt`. In both, after the call `h.state.pendingReport`
  equals the raced report (survived) and the DM is the ORIGINAL report's message (read before the race). Without a
  race the report is cleared as before.
- **L3 (#502 item 13):** `renderPluginsList(state, index, NOW, 1)` with an entry at `hostApiVersion: 2` -> the line
  contains `→ 2.0.0 available (needs a newer bot)`; with `hostApiVersion: 1` -> no caveat.
- **L4 (#563):**
  - **L4a (the boundary emoji, in a FIRST line):** one plugin, active, no index entry, named
    `"x".repeat(CAP - 2 - 4) + "🙂" + "y".repeat(50)` where `CAP = 2000 - "\n… (list truncated)".length` (computed
    in the test, not hard-coded: the first line is `• **${name}** — installed 1.0.0`, so the name starts at unit 4
    and the high surrogate lands at `CAP - 2`, the last unit `cutUtf16(headsOnly, CAP)` would keep) -> `out.length <= 2000`,
    no lone surrogate (`/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/` and `/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/` find
    nothing), ends with `… (list truncated)`. (Measured: 1,999 units with the back-off; 2,000 and a lone `\ud83d`
    without it. Notes never reach the cut under the new assembly, so an emoji note cannot drive this.)
  - **L4b (the down plugin survives):** twelve plugins, each with a 300-unit first note, the LAST one down
    (`active: false`, `error: "boom"`) -> the output contains that plugin's `— not running` line and is at most 2000
    units (measured: 1,798 under the progressive tier).
  - **L4c (`cutUtf16`/`sliceUtf16` units):** `cutUtf16("a🙂bc", 3)` -> `"a…"` (the cut index lands on the high
    surrogate and backs off; `"ab🙂"` would not exercise it), `cutUtf16("abc", 3)` -> `"abc"`, `cutUtf16("abcd", 3)`
    -> `"ab…"`; `sliceUtf16("a🙂", 2)` -> `"a"` (the back-off), `sliceUtf16("ab🙂", 2)` -> `"ab"` (a control: the
    cut index is before the pair).
  - **L4d (bare first lines when the tail has no room):** one plugin named `"n".repeat(1948)` with a 300-unit note
    (the first line is 1,990 units; `full` is over 2,000) -> `out === "• **" + name + "** — installed 1.0.0 → 2.0.0 available"`
    and `out.length === 1990` (no note, no tail).
  - **L4e (whole lines in tier 3):** two plugins whose first lines are each about 1,100 units (names padded) -> the
    output is the first plugin's complete first line followed by `\n… (list truncated)`, and contains no prefix of the
    second plugin's name (no partial line).
  - **L4f (the per-note cut):** a short list, one plugin whose first release note is `"🙂".repeat(200)` -- NO
    prefix: the rendered block starts with the 23-unit `**2.0.0** (2026-09-05)\n` header, so an even-length prefix
    keeps every pair aligned and the cut at 300 lands on a pair boundary (a leading `"a"` made the case pass on
    correct code AND under M9; measured) -> the output has no lone surrogate and the rendered note is 299 units (the
    pair across unit 300 is dropped whole).
  - **L4h (the boundaries, one case per operator; line lengths are `24 + name` for an active plugin with no index
    entry and `42 + name` with an index entry at 2.0.0; a 300-unit note renders as 301; `CAP = 1981`):**
    (1) `full` exactly 2000: one plugin named `"n".repeat(1657)` with a 300-unit `"y"` note -> length 2000, no tail,
    contains `"y".repeat(277)`; (2) first lines exactly `CAP`: name `"n".repeat(1939)` with a note -> the output is
    `` `• **${name}** — installed 1.0.0 → 2.0.0 available` + TRUNC ``, length 2000; (3) first lines exactly 2000:
    name `"n".repeat(1958)` with a note -> the bare first line, length 2000, no tail; (4) a note that fills the room
    exactly: names `"a".repeat(800)` and `"b".repeat(795)`, each with a 300-unit note (the first lines total
    `CAP - 301`) -> starts with line A and its note, ends with `\n${lineB}${TRUNC}`, length 2000; (5) first line
    exactly `CAP`, then another plugin: names `"a".repeat(1957)` and `"b"` -> `` `• **${a}** — installed 1.0.0` + TRUNC ``,
    length 2000.
  - **L4g (notes in list order while they fit):** three plugins named `"k"`, `"m"`, `"n"` × 356 (each first line
    398 units) with notes `"Q"`, `"R"`, `"S"` × 300 (`full` 2,099; `headsOnly` 1,196; room 785) -> the output contains
    `"Q".repeat(277)` and `"R".repeat(277)`, no `"S"`, is 1,817 units and ends with the tail; and **L4g2:** the same
    with a `scheduled` entry on the first plugin -> `out.indexOf("Q") < out.indexOf("⏳")` (the note before the
    schedule line in the progressive tier too). The existing "clamps a long list" (`:229`) and the #544 cap test
    (`:313`) still pass.
- **L5 (#418):** a schedule with a snowflake requester renders `(requested by <@200863115821318144>)`; with
  `email:me@x.com` renders `(requested by email:me@x.com)`; a 200-character requester is cut to 80 with `…`; a
  requester with a newline is one line; an empty string renders `(requested by ?)`; the off branch renders it too
  (`:238`'s test); and for a plugin with BOTH a note containing `shiny` and a schedule, `out.indexOf("shiny") < out.indexOf("⏳")`
  (the schedule line follows the note, as today).
- **L6 (the caller, end to end):** `src/commands.test.ts`'s success-path harness for `/plugins` (the describe at
  `:918-1006`: `statePath`, `indexBody`, `stateBody`, the `fetch` spy, `config.adminUserIds.push("999")`) with
  `getSubcommand: () => "list"` and `editReply` collecting the string, an index with TWO plugins -- `demo` at
  `HOST_API_VERSION + 1` and `ok` at `HOST_API_VERSION`, both installed at `1.0.0` with `1.1.0` available -> the edit
  contains `**demo** — installed 1.0.0 → 1.1.0 available (needs a newer bot)` AND `**ok** — installed 1.0.0 → 1.1.0 available\n`
  (a caller passing `0` prints the caveat for BOTH; one plugin alone cannot tell `0` from the constant). No source-pin
  fallback.

### Mutation table (scratch worktree; `bun test src/plugins/updates.test.ts src/commands.test.ts` per mutant)

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | 1c: the mutate moved below the delivery | L1 |
| M2a | 1c: the `plugin` clause of the guard dropped | L2 (a) |
| M2b | 1c: the `requestedAt` clause dropped | L2 (b) |
| M3 | 1b: the "(needs a newer bot)" clause dropped | L3, L6 |
| M4 | step 2: the caller passes `0` | L6 (`ok` gains the caveat) |
| M5 | 1a: `sliceUtf16` without the back-off (a plain `slice`) | L4a, L4c, L4f, and the #544 emoji case |
| M6 | 1b: the assembly joins `full` and cuts (today's shape) | L4b (the down plugin's line is cut off), L4e |
| M6b | 1b: tier 3 through `cutUtf16(headsOnly, cap)` only (no whole-line cut) | L4e (a partial second line) |
| M7 | 1b: the requester clause dropped | L5 |
| M8 | 1b: `requester()` without the 80 cut | L5's long case |
| M9 | 1a: the per-note cut back to `firstBlock.slice(0, 300)` | L4f |
| M10 | 1b: `trunc` appended on the bare-heads return too | L4d (2,009 units) |
| M11 | 1b: `r.line + r.tail + r.note` (tail before note) in the `full` join | L5's order assertion |
| M11b | 1b: the same swap in the tier-2 `shown` map | L4g2 |
| M12 | 1b: the notes tier all-or-nothing (every note dropped on any overflow) | L4g (the first note missing) |
| M13 | 1b: `full.length <= MESSAGE_LIMIT` -> `<` | L4h-1 |
| M14 | 1b: `headsOnly.length > cap` -> `>=` | L4h-2 |
| M15 | 1b: `headsOnly.length <= MESSAGE_LIMIT` -> `<` | L4h-3 |
| M16 | 1b: `r.note.length > room` -> `>=` | L4h-4 |
| M17 | 1b: `lastIndexOf("\n", cap)` -> `cap - 1` | L4h-5 |

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #443: the order is pinned at the consumer | L1 | L1 | M1 |
| #501-11: only the report read is deleted, on both keys | 1c | L2 | M2a, M2b |
| #502-13: the list says an update needs a newer bot, through the real caller | 1b, 2 | L3, L6 | M3, M4 |
| #563: no lone surrogate from either cut; a down plugin's line survives while the first lines fit; whole lines; notes in order while they fit; every boundary exact | 1a, 1b | L4a-L4h | M5, M6, M6b, M9, M10, M12-M17 |
| #418: the schedule line names its requester, after the note in every tier (the README sentence, scoped, is true) | 1b, 2 | L5, L4g2 | M7, M8, M11, M11b |

### Verification

```bash
bun install --frozen-lockfile
bun run check
bun test src/plugins/updates.test.ts src/commands.test.ts src/commandNaming.test.ts test/stateGuard.test.ts
bun test   # in the background; `ops/admin` needs its own `bun install --frozen-lockfile` first or its suite fails on a missing dependency
```

### Acceptance to paste per issue

- **#443:** L1's pass line and M1's failing output. **#501 (item 11; closes):** L2 (a) and (b), M2a and M2b; the
  closing comment lists items 4, 8 (U2), 5, 10 (U1) and 11 (this PR). **#502 (item 13; closes):** L3, L6, M3, M4;
  items 12 and 14 are U2's. **#563:** L4a-L4g pass lines (the acceptance's two tests are L4a and L4b), M5, M6, M6b,
  M9, M10, M12. **#418:** L5 and M7, M8, M11; the README sentence quoted as scoped.

### PR

- Title: `fix(plugins): the report-back clears only the report it read, the list names an incompatible version and a schedule's requester, and its clamp puts first lines before notes, cuts whole lines and never splits an emoji (#443, #501, #502, #563, #418)`.
- Body: the five items, Decisions 1-5, the output, the mutation table; name the two product calls (progressive notes;
  bare first lines when the tail has no room). End with `Closes #443. Closes #563. Closes #418. Closes #501. Closes #502.`
- After merge: tick #443 #418 #501 #502 #563 on #527.
