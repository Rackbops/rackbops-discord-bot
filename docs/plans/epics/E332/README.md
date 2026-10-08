# E332 -- Pip Discord identity and result DMs -- plans

Epic issue: [#332](https://github.com/Rackbops/rackbops-discord-bot/issues/332). Design document:
[`../EP-pip-discord-identity.md`](../EP-pip-discord-identity.md) (PR #331, drafted by Pip). Written
2026-10-06 against `main` @ `8d039c9` (this repo), `Rackbops/discord-mcp` @ `315d470`, and
`@rackbops/plugin-mcp` 0.3.0 in the published Plugin Index.

One file per PR bundle, plus one for the three operator children:

| Child | Who | Plan | PR lands in |
|---|---|---|---|
| #333 runbook draft | Sonnet | [01-runbook-draft.md](01-runbook-draft.md) | this repo |
| #334 add-a-bridge runbook | Sonnet | [02-mcp-add-bridge.md](02-mcp-add-bridge.md) | Rackbops/discord-mcp |
| #335 result-DM script | Sonnet | [03-result-dm-script.md](03-result-dm-script.md) | Rackbops/discord-mcp |
| #336, #337, #338 | operator (orchestrator + Rod) | [operator.md](operator.md) | no PR; evidence on the issues |
| #339 handoff and close-out | Sonnet | [04-handoff-and-closeout.md](04-handoff-and-closeout.md) | this repo |
| #342 release-watcher switch (added 2026-10-07 from Rod's Q3 decision) | Sonnet | [05-release-watcher-switch.md](05-release-watcher-switch.md) | this repo |

## Build order

```
#333 ─┬─► #336 bring-up (nucbox) ─► #337 pairing (Melody) ─┐
#334 ─┘                                                     ├─► #338 live acceptance ─► #339 close-out
#335 (merged) ──────────────────────────────────────────────┘
```

#336 needs the two runbooks (#333, #334) reviewed on their branches; #335 is needed only by #338
(#336 and #337 can use the shim or a one-line probe for `whoami`).

The three Sonnet children start at once, in parallel, each in its own worktree. The operator
children are one sitting each with Rod. #339 is the only child that waits on live evidence.

## Cross-cutting decisions

Recorded on the epic issue under **Decisions taken at pickup** (configuration-only core, a script
instead of a Codex hop, MILE vs Melody, instance/prefix names, where plans live) and refined by the
answers to the **Questions for Pip** comment there. A plan here never re-decides one of them; a
subordinate that finds a decision wrong reports it on its PR and continues under the decision.

## Exit demo

The epic's exit criterion, run as #338's last fixture with hosted Pip in the loop: one approved task
completes, Melody runs `scripts/result-dm.mjs` once, Rod receives exactly one DM from the Pip
application, hosted chat reports `sent`; an excluded task and an offline-Melody case produce no DM
and no claim; prod, debug and Clerk unchanged; rollback rehearsed.
