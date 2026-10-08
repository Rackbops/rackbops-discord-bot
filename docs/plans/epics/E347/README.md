# E347 -- Pip runbook review follow-ups -- plans

Epic issue: [#347](https://github.com/Rackbops/rackbops-discord-bot/issues/347). Written 2026-10-08 against
`main` @ `4ff8eef` (this repository), `Rackbops/discord-mcp` `main` @ `fe46591`, and `@rackbops/plugin-mcp`
0.3.1 (`Rackbops/rackbops-bot-plugins` @ `2820afe`, the version live on the Pip instance). Every README line
number in these plans is `ops/README.md` on `4ff8eef`; the Pip section is lines 732-1093, its sections 1-8
are 757-950 and its section 10 is 1018-1092.

Thirty children were open at pickup (#348, #350, #358, #381 and #382 had already landed). All thirty are
documentation changes to the one section, so they ship as **four PRs, one per region of the section**, and
the four run in parallel because their regions do not touch:

| Bundle | Children | Region owned (lines on `4ff8eef`) | Plan | Effort |
|---|---|---|---|---|
| A | #363, #378, #361, #379, #380, #353 | intro and section 1 (732-778); section 8 (936-950); section 10's *Stopping it* and *Rollback* paragraphs (1082-1092) | [A-intro-application-rollback.md](A-intro-application-rollback.md) | S |
| B | #354, #356, #352 (section 2 half), #362, #366, #368, #372, #374 (section 4 half), #375, #376 (sections 2 and 4), #377 (sections 2 and 5), #390 | sections 2, 4 and 5 (780-846, 877-901) | [B-env-bridge-up.md](B-env-bridge-up.md) | S (one block rewrite) |
| C | #357, #360, #351, #352 (section 7 half), #364, #365, #373, #376 (section 7 half), #377 (section 7 half) | sections 6 and 7 (903-934) | [C-pairing-health.md](C-pairing-health.md) | S |
| D | #349, #359, #369, #355, #371, #370, #374 (section 3 half) | section 3, table and conclusion (848-875) | [D-core-output-table.md](D-core-output-table.md) | S, the one with an executed test |

**A bundle edits only its region.** Five children span two regions; each plan names the sentence it owns and
the sibling bundle that owns the rest, and the child closes when the second PR merges: #352 (B and C),
#374 (B and D), #376 (B and C), #377 (B and C). #356 and #362 touch sections 2, 4 and 5, all B's. Nothing
outside the Pip section changes except section 10's two paragraphs (A), and no plan touches section 9.

## Build order

```
A ──┐
B ──┼──► all four merged ──► fresh-read audit of sections 1-8 (orchestrator) ──► close #347
C ──┤
D ──┘
```

No bundle waits on another. Each sub works in its own worktree on its own branch from `origin/main`, and
runs `git fetch origin && git rebase origin/main` before marking the PR ready and again before merging if
`main` moved; the regions are separated by unchanged lines, so a rebase applies cleanly. **A rebase conflict
inside another bundle's region is never resolved by the sub**: stop and report it on the PR.

Branches: `docs/347-a-intro-rollback`, `docs/347-b-env-bridge-up`, `docs/347-c-pairing-health`,
`docs/347-d-core-table`. Worktrees under `S:\Repos\_wt\rdb-347-<a|b|c|d>`.

## Cross-cutting decisions

Taken by the orchestrator at pickup; a plan never re-decides one, and a sub that finds one wrong reports it
on its PR and continues under it.

1. **`HTTP_PORT` gets the concrete value `8794`** (what the live instance runs), instead of `<free internal
   port>` (#376). The port is internal to the container and unpublished, so the only constraint is that the
   service's bridge `url` names the same number. The probe in section 7 and the URL in section 4 then carry
   no placeholder.
2. **Sections keep their numbers.** #362's "swap sections 4 and 5" is done as ordering sentences instead
   (section 4 says "after section 5's first `up`", section 5 says "before the service side"), because every
   cross-reference in the file, in section 9 and 10, in `E332/*` and in the issues says "section N".
3. **`MCP_BRIDGE_TOKEN` leaves the section 2 block.** discord-mcp's `deploy/add-bridge.md` section 3 generates
   the secret and **appends** the `MCP_BRIDGE_TOKEN=` line to this instance's `.env` (`fe46591`, lines 48-53),
   so the runbook names that runbook as the one writer, tells the operator not to pre-fill the line, and
   says why a blank `MCP_BRIDGE_TOKEN=` is worse than none (#352). The recreate that follows is stated in
   sections 4 and 5.
4. **The section 3 table re-pins to the PR's base commit.** Its header says "Line numbers are on `8d039c9`";
   bundle D re-reads every cite in the table on its own tree and replaces that commit. The section 2 block
   pins no commit; bundle B re-reads its cites on its tree the same way (#390). Plugin cites everywhere are
   re-read at `2820afe` (0.3.1): between `477770d` (the review's 0.3.0) and `2820afe` the only source changes
   under `plugins/mcp/src` are `commands.ts` and `commands.test.ts`
   (`gh api repos/Rackbops/rackbops-bot-plugins/compare/477770d...2820afe`), so the `http.ts`, `auth.ts`,
   `drain.ts`, `index.ts` and `registry.ts` cites did not move; every `commands.ts` cite did, and is re-read.
5. **The intro stops pinning the whole section to one commit.** After four PRs land at four commits, "the
   cites below were read at `8d039c9`" cannot stay true. Bundle A rewrites it as a rule: a `file:line` is as
   read on `main` by the PR that last changed the sentence, and section 3's table names its own commit.
6. **Explanations live in the table; recipes live in the `.env` comments** (#372). "Why it is bounded" is
   said once, in section 3; a section 2 comment keeps at most one clause and points at the row. The
   exception is the plugin-move recipe (the `printf ... | bot-ops.sh plugin-request` lines #391 added):
   a multi-line command does not belong in a table cell, so the `ADMIN_USER_IDS` comment keeps the recipe
   and the table's plugin-update row points at the comment for it, as it already does.
7. **#375 (pin `PLUGINS=mcp@<version>`) is declined, by Rod on 2026-10-08.** An operator pin wins over
   every other version source at every boot, the mailbox's `update-now` target included
   (`src/plugins/install.ts:289-293`, `:318-320` on `4ff8eef`), so a pin would make the mailbox route
   inert until the pin is edited. The block stays unpinned and says why (the installed version is
   recorded in `plugins/state.json` and moves only on request, never on its own); bundle B closes #375 as
   declined in writing.
8. **Section 10 is pasted into hosted Pip.** Bundle A changes its *Stopping it* paragraph (#353). After A
   merges, Rod re-pastes the text between the two rules into hosted Pip's instructions; the PR body says so.
9. **The exit criterion's "run as written" clause.** The health steps were run on the live Pip on 2026-10-08
   (bundle C carries the output); the pairing step was run on Melody on 2026-10-07 (#337) in the PowerShell
   form bundle C adopts; the disable control was rehearsed (#338). The `docker compose ... stop` of section
   8 was never run and stays unrun unless Rod asks; the close-out says so.

## The lane, and what "done" is for a bundle

Every bundle is documentation-only in the **single-audit lane**: the sub verifies each rewritten claim
against source *while writing* (real `file:line` on its tree, never recalled), executes the acceptance
bullets that say "executed, not read" and pastes the real output, then spawns **one** independent, read-only
claims-vs-code audit subagent over the finished diff before opening the PR, and fixes or declines every
finding in writing on the PR. No adversarial correctness round, no mutation table: nothing here changes
behaviour. The orchestrator does not re-run the audit; it checks the pasted evidence and merges.

Each plan carries a coverage table in the docs shape: acceptance bullet -> plan step -> the check that
proves it (an executed command, or the audit) -> what the check catches if the sentence were wrong or
reverted. A rewritten sentence with no row is scope creep; a bullet with no step is a gap.

PR mechanics for every bundle: branch from `origin/main` in an isolated worktree; one commit (or a few,
squashed at merge) with a Conventional Commits subject `docs(ops): ...` ending `(#347)`; PR body with the
children it closes (`Closes #N` per child, or "part of #N, the rest is bundle X" for a split child), the
pasted checks, the audit's findings and their resolution, and the `🤖 Generated with [Claude Code]` line.
`bun run check` and `bun test` are not affected by a docs change but CI runs them; wait for green. **Do not
merge**: report the PR link and the pasted evidence to the orchestrator, which merges.

## Exit demo

When the four PRs are merged: the orchestrator runs one fresh-read audit of sections 1-8 (the epic's exit
criterion: "a fresh read of sections 1-8 by someone who was not in the review finds no sentence that its
cited line or command does not support"), files any finding as a new child or fixes it in one closing PR,
ticks the epic's boxes and closes #347 with the evidence links.
