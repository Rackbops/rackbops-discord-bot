<!-- Plan for Rackbops/rackbops-discord-bot#339 (Epic #332), written by the orchestrating session on
2026-10-06. It runs only after #338 has its evidence; the implementer reads that evidence first. -->

## Implementation plan -- #339: the hosted-Pip handoff and the Pip section's close-out

Documentation only -- the **single-audit lane**.

### Inputs

The evidence comments on #336, #337 and #338 (redacted boot lines, `pins.js show`, each A-row's
outcome and date); Pip's and Rod's answers to **Questions for Pip** on #332 (Q4 the policy, Q6 the
delegation shape); the merged `scripts/result-dm.mjs` README entry (#335) for the exact contract.
Nothing in this plan is written from memory of those: quote them.

### Step 1 -- `ops/README.md`, two new subsections in the Pip section

**"8. What the live run showed"** -- the observed `Logged in as` line, the `Registered N slash
commands` line, the service's `pins.js show` line for `pip`, and a table of A1-A11 with the outcome
word, the date, and the issue comment it came from. Ids redacted exactly as they were on the
issue. Anything #338 could not run is listed as **unverified** with the reason it gave.

**"9. Hosted-Pip handoff"** -- the part Rod pastes into hosted Pip's instructions:

- the event contract, from Pip's Q6 answer on #332: **one opaque event id per logical task,
  minted by hosted Pip at handoff and persisted in the task so every retry reuses it** -- never a
  new id per execution attempt, and never a bare conversation id (one conversation can hold
  several tasks); the label's source (the task's own title, trimmed to 200); the status mapping
  from the task's terminal state to `done|failed|blocked|cancelled` (one vocabulary, the same
  words the script renders); when a link is included (Q4); and the expiry, which is **required**
  (`--expires` = handoff time + 24 h, ISO-8601 with offset);
- the one command the delegated Melody task runs, in the PowerShell form Rod used on Melody for
  #337/#338: `$env:DISCORD_MCP_CONFIG_DIR` set to the Pip-only directory #337 created, then
  `node '<checkout>\scripts\result-dm.mjs' --bridge pip --event <id> --label <text> --status <word> --expires <iso> [--link <url>]`;
  state that the directory variable is always passed explicitly (the script refuses to run
  without it) and that `--bridge pip` is what refuses any other credential;
- the outcome -> chat mapping: `sent` "DM sent"; `duplicate` "already sent earlier"; `pending`,
  `unknown`, `rate_limited` "delivery pending -- retry the same event later, do not start a new
  one"; `expired` "not sent: the result is older than its expiry"; `unreachable`, `denied`,
  `unresolved`, `invalid`, `error` a truthful failure naming the outcome word. Hosted Pip never
  reports a DM as sent on any outcome but `sent`/`duplicate`;
- the inclusion rule from Q4 (which tasks notify) as a sentence hosted Pip can apply -- the
  per-task phrase Pip proposed is "notify me on Discord"; quote whatever Rod approved on #332;
- the disable control: delete the Pip credentials directory on Melody (the script then refuses with
  a named credentials error), or `/pipagent unregister` (the next call is `ACCESS_DENIED`); and the
  rollback as rehearsed in #338, in the order the runbook's section 7 gives.

### Step 2 -- the design document's running log

Append to `docs/plans/epics/EP-pip-discord-identity.md` section 10 one entry per operator child
with its date and outcome, and one closing entry stating what the epic delivered and what it
deliberately did not (the section 9 track untouched; the avatar's state).

### Step 3 -- checks, audit, PR

- `bun run check` and `bun test` (Markdown only; say so).
- **One independent audit**: a read-only reviewer with the three issues' evidence and the diff,
  instructed to find any quoted line or number that does not appear on the issues, any outcome word
  not in the script's README vocabulary, and any instruction hosted Pip could not follow as written.
  Fix or decline each finding on the PR.
- PR title `docs(ops): Pip live evidence and the hosted-Pip handoff (#339)`. Do not merge; report.

### Coverage table

| Acceptance bullet | Step(s) | Verification | What would make it fail |
|---|---|---|---|
| Section and running log reflect the live evidence; every quote appears on #336-#338 | 1, 2 | manual: the audit cross-checks each quote | a line quoted from memory |
| The handoff text is complete enough to paste | 1 | manual: the audit follows it as hosted Pip would | a step that needs this epic open to understand |
| One independent audit, findings fixed or declined | 3 | the reviewer's report | none |

### Hand-off brief (spawn text)

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot (worktree from origin/main). Issue: Rackbops/rackbops-discord-bot#339.
Plan: docs/plans/epics/E332/04-handoff-and-closeout.md (on main by then). Read the evidence on #336, #337, #338 and the Q4/Q6 answers on #332 before writing anything.
Documentation only; single-audit lane. Scratch files: task-unique names (pr-body-339.md). Report the PR link, the audit result and any deviation.
```
