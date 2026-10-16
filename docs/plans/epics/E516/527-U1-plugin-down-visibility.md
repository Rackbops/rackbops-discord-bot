<!-- Plan for sub-epic #527 of Epic #516 (Rackbops/rackbops-discord-bot), bundle U1: a plugin that is down says so.
Written by the orchestrating session on 2026-10-16 against `main` @ `691de28`; audited read-only against that tree
before it was committed (8 findings, all applied: the reverted branch's `entry` narrowing, the fact that `error` names
the TARGET's failure, the docs the first draft missed). Every file:line below was read from that tree; the implementer
re-reads each one on the tree it works from and corrects any that moved. -->

## Implementation plan -- #527 bundle U1: `/plugins list` and the update report-back say when a plugin is down

Children: **#543** and **#544**, both pure functions in `src/plugins/updates.ts` with unit tests in
`src/plugins/updates.test.ts`. One PR. A behaviour change (what admins are told), so the **three-reviewer
gate** applies, in its lightest form: you plus two read-only adversarial reviewers, up to four rounds;
every changed line mutation-tested in a scratch worktree. Independent of every bundle in flight (none
touches `updates.ts`; S3a's PR #557 edits `CONTEXT.md`, so expect a trivial rebase there); branch from
`origin/main` now.

### What is wrong, verified at `691de28`

- **`/plugins list` reads the same for a plugin that is down** (#544). `renderPluginsList`
  (`src/plugins/updates.ts:173-210`) prints, per enabled entry, the installed version, a newer version
  with its first release note, the skip/remind markers and a pending schedule; it never reads the entry's
  `active` or `error` (`contract.ts:209-213`: `active` is "loaded and `activate()` succeeded this boot",
  `error` why not). `active` is derived as `loaded?.running === true` (`host.ts:1158`), written after
  activation, so an enabled plugin that is fine is never `active: false` — including one with
  `configured: false`. A plugin that failed to install, load or activate this boot reads exactly like one
  that is running; the admin finds out from the panel (which says "Not running") or `bot-ops.sh status`.
  The only consumer of the text is `commands.ts:187`; nothing parses it.
- **The report-back's "still on X" never checks that X runs** (#543). `decidePluginReportOutcome`
  (`:447-469`): the reverted branch (`:463-466`, `installed !== undefined && installed !== to`) reports
  "could not be updated to `to` (…) — still on `installed`" without reading `entry.active`; only the success
  branch (`:459`) does. If the previous version was reused but then also failed to load or activate — or
  if the last-good install itself failed too (`install.ts:471-481`: `skips[name]` is set and nothing is
  reused, while `host.ts:1143` still records `installedVersion = prev.installedVersion`) — admins are told
  the plugin is still on it when it is down. #536 (#410) made one more path reach this.
- **What `entry.error` holds in that case:** the FIRST failure. `host.ts:1151-1152` builds it as
  `sp.skipped ?? installSkips[…] ?? fallbacks[…]?.reason ?? loadErrors[…] ?? loaded?.error`, and
  `CONTEXT.md:219` says so ("`error` names the failed target"). So in the reverted-and-down case the
  error describes why the TARGET could not be installed; the reuse's own load or activate error is
  masked. The new message must not attribute it to the previous version.

### Decisions (defaults, named so the gate can contest them)

1. **The list marks a down plugin on its first line, after the version information and before the
   notes:** `• **a** — installed 1.0.0 → 1.1.0 available — not running (activate threw)`; the error is
   collapsed to one line and cut to 120 characters (with `…`, never splitting a surrogate pair), so a
   stack never lands in the reply; an absent, non-string or whitespace-only `error` gives just
   `— not running`. The whole reply keeps its `MESSAGE_LIMIT` clamp (`:207-209`). Off entries are unchanged
   (they already say `off`).
2. **The report-back keeps the target's error where it is and adds a neutral tail:** when the reverted
   branch's `entry.active` is false the message is
   `⚠️ **a** could not be updated to 1.1.0 (integrity mismatch for 1.1.0) — and 1.0.0 is not running either.`
   (the parenthesis is the entry's `error`, which names the target's failure; "was reused" is not claimed,
   because on the `install.ts:471-481` path nothing was). When active, the wording stays exactly as today.
   The other three branches are unchanged. The error in `why` is passed through `shortError` too (a DM
   should not carry a stack either).
3. **Nothing changes in `state.json`, the panel or `bot-ops.sh`:** both functions read fields the state
   already carries; #542 (recording a `lastActiveVersion`) is roshne's a/b decision and stays out.
4. **Known and named, not fixed:** `/plugins list` runs before the `isPluginStateReady` gate
   (`commands.ts:173-194` versus `:199`), so during the startup window it shows the PREVIOUS boot's
   `active`. Say so in the PR.

### Step 1 -- `src/plugins/updates.ts`

- Add, above `renderPluginsList`:

  ```ts
  /** #544: an entry's `error`, fit for one reply line: whitespace collapsed, cut to `max` characters with an
   *  ellipsis (never inside a surrogate pair). `undefined` for anything that is not a non-blank string, so a
   *  hand-edited state.json cannot break the list. */
  function shortError(error: unknown, max = 120): string | undefined {
    if (typeof error !== "string") return undefined;
    const oneLine = error.replace(/\s+/g, " ").trim();
    if (oneLine === "") return undefined;
    if (oneLine.length <= max) return oneLine;
    const cutAt = max - 1;
    const code = oneLine.charCodeAt(cutAt - 1);
    const end = code >= 0xd800 && code <= 0xdbff ? cutAt - 1 : cutAt; // do not split a surrogate pair
    return `${oneLine.slice(0, end)}…`;
  }
  ```

- `renderPluginsList`, the enabled branch (`:188-202`): build the first line, then the marker, then the
  notes, then the schedule (keep every existing line that is not shown here):

  ```ts
      let line = `• **${p.name}** — installed ${p.installedVersion ?? "(not installed)"}`;
      let notes = "";
      const entry = entryByName.get(p.name);
      if (p.installedVersion && entry && compareSemver(entry.version, p.installedVersion) > 0) {
        line += ` → ${entry.version} available`;
        if (p.skippedVersion === entry.version) line += " (skipped)";
        else if (p.remindAt !== undefined) line += ` (remind ${discordTs(Date.parse(p.remindAt), "R")})`;
        const firstBlock = releaseNotesBetween(entry, p.installedVersion, entry.version).split("\n\n")[0] ?? "";
        if (firstBlock) notes = `\n${firstBlock.slice(0, 300)}`;
      }
      // #544: a plugin that failed to install, load or activate this boot says so here, not only in the
      // panel and `bot-ops.sh status`. Off entries never reach this branch.
      if (!p.active) {
        const why = shortError(p.error);
        line += ` — not running${why ? ` (${why})` : ""}`;
      }
      line += notes;
      if (p.scheduled) { /* the existing two lines, unchanged */ }
      return line;
  ```

  Update the docstring (`:171-172`): "and, for a plugin that is not running this boot, says so with its
  error (#544)".
- `decidePluginReportOutcome` (`:458-466`):

  ```ts
    const installed = entry?.installedVersion;
    if (entry && installed === to && entry.active) {
      return { ok: true, message: `✅ **${name}** is now ${to}.` };
    }
    const short = shortError(entry?.error);
    const why = short ? ` (${short})` : "";
    if (entry && installed !== undefined && installed !== to) {
      // Reverted: the target failed to install, so the previous version was reused (from cache) — or, on
      // install.ts's last-good-failed path, nothing was. `error` names the TARGET's failure (host.ts builds
      // it first-failure-wins), so the tail only says whether the previous version runs (#543): "still on"
      // implies it does.
      return entry.active
        ? { ok: false, message: `⚠️ **${name}** could not be updated to ${to}${why} — still on ${installed}.` }
        : { ok: false, message: `⚠️ **${name}** could not be updated to ${to}${why} — and ${installed} is not running either.` };
    }
  ```

  (`entry &&` is required: `installed` is an optional-chain alias and TypeScript does not narrow `entry`
  through it — `tsc` 7 reports TS18048 without it.) Update the docstring (`:445-446`): "else one of four
  failures" (off, still on the previous, previous not running either, installed but failed to start).

### Step 2 -- docs, in the same PR

- `CONTEXT.md:358-359` (the `/plugins list` description: "shows installed vs available + the first release
  note per plugin (and a pending schedule, if any)"): add "and marks a plugin that is not running this
  boot, with its error (#544)". `CONTEXT.md:221` (the `updates.ts` row's outcome list "success /
  reverted-still-on-previous / installed-but-failed-to-start"): add the off outcome and
  "reverted-and-not-running-either (#543)"; `:222` ("`decidePluginReportOutcome` (3 branches)") → the real
  count after the change. `CONTEXT.md:219` ("`error` names the failed target") stays true; cite it in the
  code comment. The `Limits` paragraph at `:1168-1172` (the #536 residual): add one clause that the list
  and the report-back now say the plugin is down.
- `README.md:122` ("the bot comes back on your **previous** version and tells you so — it never strands the
  plugin"): qualify — "comes back on your previous version when that still starts, and tells you either
  way". `README.md:250` and `ops/README.md:86` do not describe the list's contents; leave them.

### Step 3 -- tests (`src/plugins/updates.test.ts`)

The `stateEntry` helper (`:56-58`) defaults `active: true`, so the existing list and report tests describe
running plugins and keep passing unchanged (the restructure preserves every assertion at `:198-251`).

| # | Test | Pins |
|---|---|---|
| T1 | `renderPluginsList`: "a plugin that is not running says so, with its error cut to one short line" | `stateEntry("a", "1.0.0", { active: false, error: "activate threw\n  at x.js:1\n" + "y".repeat(300) })` → the first line (`out.split("\n")[0]`) is `• **a** — installed 1.0.0 — not running (activate threw at x.js:1 ` + `y`×N + `…)` with the parenthesised text exactly 120 characters; no newline inside it |
| T1b | "the cut is at 120 characters, not 119 or 121" | an error of exactly 120 characters is shown whole with no `…`; one of 121 ends in `…` and is 120 long |
| T2 | "a plugin that is not running, with no usable error, says just that" | `{ active: false }`, `{ active: false, error: "   " }` and `{ active: false, error: 5 as unknown as string }` → each line ends `— not running` with no `(` |
| T3 | "a running plugin carries no marker" | `stateEntry("a", "1.0.0")` → the output does not contain `not running` |
| T4 | "the marker sits before the release note and after the available version" | `active: false, error: "e"`, index offers `1.1.0` with notes "shiny" → `out.split("\n")[0]` is exactly (`toBe`) `• **a** — installed 1.0.0 → 1.1.0 available — not running (e)`; `shiny` appears on a later line (`renderNotes` puts a version header line first, `:139`) |
| T5 | "an off plugin that is not running still reads only off" | `{ enabled: false, active: false, error: "e" }` → the line matches `/^• \*\*p\*\* — off \(installed 1\.0\.0\)$/` and the output does not contain `not running` |
| T6 | `decidePluginReportOutcome`: "reverted to a previous version that is not running either → says so, not still on" (#543) | `stateEntry("a", "1.0.0", { active: false, error: "integrity mismatch for 1.1.0" })` → `ok: false`, message exactly `⚠️ **a** could not be updated to 1.1.0 (integrity mismatch for 1.1.0) — and 1.0.0 is not running either.`; not `still on`; not `reused` |
| T7 | the existing `:657-663` reverted test (active, with an error) is unchanged | `still on 1.0.0` and the error |
| T8 | "reverted and down, with no error" | `{ active: false }` → message exactly `⚠️ **a** could not be updated to 1.1.0 — and 1.0.0 is not running either.` |
| T9 | "a long error in the report-back is cut like the list's" | `error` of 300 characters → the parenthesis is 120 long and ends `…` |

### Coverage table

| Outcome (bullet) | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| #544: a down plugin is marked, with its error on one short line | 1 | T1, T1b, T2 | M1: delete the `if (!p.active)` block (T1, T2); M2: drop the `replace(/\s+/g, " ")` (T1: a newline inside the parenthesis); M3: `<=` → `<` in `shortError` (T1b's 120 case gains `…`) |
| #544: a bad `error` value cannot break the list | 1 | T2 | M4: drop the `typeof error !== "string"` guard (T2's `5` case throws) |
| #544: a running plugin is not marked | 1 | T3 | M5: `if (p.active)` (T3 red; T1 red too) |
| #544: the marker's place on the line | 1 | T4 | M6: append the marker after `notes` (T4's `toBe` on the first line) |
| #544: off entries unchanged | 1 | T5 | M7: add the marker to the off branch too |
| #543: a previous version that is not running is named, with the target's error kept | 1 | T6, T8 | M8: drop the `entry.active` ternary (T6: `still on`); M9: drop `${why}` from the new message (T6's exact text) |
| #543: a previous version that runs reads as before | 1 | T7 | M10: invert the ternary (T7 red) |
| the report-back's error is cut | 1 | T9 | M11: use `entry?.error` raw in `why` (T9) |
| the docs say what the code does | 2 | manual: reviewer B reads the edited sentences against the code, `CONTEXT.md:219` included | -- |

Run every mutation in a scratch copy (`git worktree add --detach <path> <sha>`), never in the tree the tests
or a reviewer are reading. Paste the red test's name per row in the PR.

### Checks, gate, PR

- `bun run check`; `bunx tsc --noEmit -p ops/tsconfig.json`; `bun run check` inside `ops/admin/`;
  `bun test` from the root, then `bun test --randomize` once. CI's Linux run is the evidence for the
  `ops/*` suites that skip here.
- Gate: reviewer A on correctness (every branch of both functions with `active`/`error`/`enabled`
  combinations; the clamp with the longest line; `shortError` on an emoji at the cut; the
  `install.ts:471-481` path end to end through `buildPluginStateFile` to the message); reviewer B on
  claims-vs-code (the coverage table, the docstrings, the `CONTEXT.md`/README sentences, the exact message
  texts, the claim that `error` names the target's failure). Both read-only, both handed the merged tree,
  #543 and #544.
- Branch `fix/527-U1-plugin-down-visibility`; title
  `fix(plugins): say in /plugins list and the update report-back when a plugin is down (#543, #544)`.
  Body: `Closes #543`, `Closes #544`, `Part of #527`; the pasted checks; the mutation rows; the gate's
  rounds; decisions 1-4 as assumptions taken (decision 2's wording, which differs from #543's suggested
  text because `error` names the target, in its own paragraph). Do not merge.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot. Work in a NEW worktree, never the shared checkout:
  git -C S:\Repos\rackbops-discord-bot fetch origin && git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-527-U1 origin/main -b fix/527-U1-plugin-down-visibility
Issues: Rackbops/rackbops-discord-bot #543 #544 (sub-epic #527 of Epic #516). Read both bodies and comments first.
Plan: docs/plans/epics/E516/527-U1-plugin-down-visibility.md on branch claude/530-plans:
  git -C S:\Repos\rackbops-discord-bot show origin/claude/530-plans:docs/plans/epics/E516/527-U1-plugin-down-visibility.md
A behaviour change in what admins are told: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Every mutation in a scratch worktree. Scratch files: task-unique names (pr-body-527U1.md, commit-msg-527U1.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds and any deviation. Do not merge.
```
