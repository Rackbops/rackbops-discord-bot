<!-- Plan for Rackbops/rackbops-discord-bot#335 (Epic #332), written by the orchestrating session on
2026-10-06 against Rackbops/discord-mcp `main` @ `315d470`, reconciled with Pip's answers on #332 and
corrected the same day by an independent claims-vs-code audit (the bridge pin, the per-stage
classification and the narrowed credential source come from its findings). Every file:line below was
read from that tree; the implementer re-reads each one and corrects any that moved. -->

## Implementation plan -- #335: `scripts/result-dm.mjs` (Rackbops/discord-mcp)

A behaviour change: the **three-reviewer gate** on the PR (you plus two adversarial reviewers with
different lenses, up to four rounds, then report), mutation checks in a scratch copy, real output
pasted.

### What it does, in one paragraph

Send exactly one owner result DM through the service and say truthfully what happened. It is what
the Melody-delegated task runs (Epic #332 decision 2); it never retries, never queues, never
prints a credential, and classifies every outcome into a fixed vocabulary with a fixed exit code,
so the caller can repeat the **same** event safely and never has to parse prose.

### Contract

```
node scripts/result-dm.mjs --bridge <id> --event <id> --label <text> --status <done|failed|blocked|cancelled>
                           --expires <ISO-8601 with offset or Z> [--link <https url>] [--dry-run]
node scripts/result-dm.mjs --help
```

`--bridge` is required and is the pin that makes a mis-set environment fail instead of sending
through another integration: after `whoami`, the principal must be `u-<id>@<bridge>` (the
bridge-qualified user principal, `src/domain/bridge.ts:25-28`; a principal with no `@` suffix is
on the default bridge and matches only `--bridge default`). Anything else is `denied`,
`code: wrong-bridge`, before any recipient lookup or send. Without this, the shim's own
resolution rules would let a shell with the wrong `DISCORD_MCP_CONFIG_DIR` send as the prod
integration with no error (audit finding on this plan, 2026-10-06).

Two points reconciled with Pip's answers on #332 (2026-10-06): the status vocabulary is **one**
set of words, used both on the command line and in the rendered body (`done`, `failed`,
`blocked`, `cancelled` -- not `success`/`failure`); and `--expires` is **required**, fail-closed: a
missing or unparseable expiry is refused before any network call, so an event can never be sent
without a bound on its age. The caller (hosted Pip's handoff, #339) sets it to the handoff time
plus 24 hours.

Environment, deliberately **narrower** than the shim's (`src/shim/cli.ts:32-102`): the one
credential source is `credentials.json` in `DISCORD_MCP_CONFIG_DIR`, which must be **set and
absolute** -- no platform-default directory (the shim's fallback at `cli.ts:47-52` is exactly what
could pick up another integration's file) -- and `DISCORD_MCP_TOKEN` is **not read** (the shim's
override at `cli.ts:99`). The URL is `DISCORD_MCP_URL` if set, else the credentials file's `url`
(`cli.ts:94-96`), else refused; no loopback default. A missing or unreadable file, a relative or
unset directory, or no URL is `invalid` (exit 2) with the reason named and no network. Do **not**
import `src/shim/cli.ts` -- it calls `main()` at import (`cli.ts:259`); reimplement the small read
in the script and cite the shim as the source of the file's shape (`cli.ts:32`, `:61-78`).

Validation (`parseArgs`, pure): `--event` matches `^[A-Za-z0-9._:-]{1,120}$` (the key is
`pip:<event>` and `send_dm.idempotency_key` allows `^[A-Za-z0-9._:-]{1,128}$`,
`contracts/tools.json`); `--label` is 1-200 characters after trimming, no line breaks; `--status`
is one of the four; `--link` is `https://` only, at most 512 characters (the `links[].url` rule;
here it is appended to the content, so the content cap is what binds); `--expires` is required and
parses with an explicit offset or `Z`, otherwise refused (`invalid`, exit 2, no network).

Steps, in order, stopping at the first that fails:

1. `expired` if `--expires` is at or before `now` -- no network at all (exit 4).
2. Connect (`Client` + `StreamableHTTPClientTransport` with
   `authProvider: { token: async () => token }`, the shim's own shape, `cli.ts:200-201`).
3. `whoami`. **Every tool call's result goes through `classifyResult` first** (step 8): the
   service runs its registration gate before any user-principal tool, `whoami` included
   (`src/service/tools.ts:145-157`), so a superseded registration is an `isError` `ACCESS_DENIED`
   from `whoami` (`src/service/registration.ts:246-248`) and an unreachable bot is an `isError`
   `UPSTREAM_UNAVAILABLE` (`:238-240`) -- neither is a thrown transport failure. On a successful
   answer, check in this order and stop at the first failure, `denied` (exit 2) with `code`:
   `capabilities.dm === true` (`no-dm-capability`); `grants` includes `dm:self` (`no-dm-self`);
   `kind === "user"` and `discord_user_id` non-null (`not-a-user`); `assertBridge(principal_id,
   bridge)` (`wrong-bridge`). A service principal therefore reads `no-dm-self`.
4. `list_recipients` (classified the same way): `resolveRecipient(whoami, items)` (pure) returns
   the one item whose `user_id` equals `whoami.discord_user_id`, else `unresolved` (exit 2). Never
   any other recipient.
5. `renderContent({ label, status, link })` (pure): `**<label>** -- <status>` with the status
   word exactly as given (`done` / `failed` / `blocked` / `cancelled`), then `\n<link>` when
   given; hard-capped at 1500 characters by truncating the label, never the status or link.
   Nothing else ever enters the body.
6. `--dry-run`: `dry_run` (exit 0), no send; the output line carries what was resolved
   (`principal_id`, `bridge`, `recipient_id`, `content`) so an operator can prove A2 from it.
7. `send_dm { recipient_id, content, idempotency_key: "pip:<event>" }`.
8. `classifyResult(result, stage)` (pure) maps a tool result at `stage` in `whoami |
   recipients | send`: not `isError` and `status: "sent"` -> `sent` (0); `status: "duplicate"` ->
   `duplicate` (0); `isError` with `code` `UPSTREAM_UNAVAILABLE` -> `pending` (3) at `send` (the
   service accepted the send and it is unresolved, `docs/tool-contracts.md`), `unavailable` (3) at
   any earlier stage (the bot was unreachable; nothing was sent); `RECIPIENT_UNREACHABLE` ->
   `unreachable` (2); `ACCESS_DENIED` -> `denied` (2, `code: ACCESS_DENIED`); `INVALID_INPUT` ->
   `invalid` (2, the same-key-different-body case included); `RATE_LIMITED` -> `rate_limited` (3,
   carrying `retry_after_seconds`); `CAPABILITY_UNAVAILABLE` -> `denied` (2); anything else ->
   `error` (1). A **thrown** transport failure (connect or a call throws) -> `unavailable` (3)
   before the `send` stage, `unknown` (3) at it: the send may or may not have reached the service,
   so the caller repeats the same event, never a new one.

Output: exactly one JSON line on **stdout**:
`{"outcome","stage","event","idempotency_key","bridge","principal_id","recipient_id","content","message_ref","url","code","retry_after_seconds"}`
with `null` for absent fields (`principal_id`/`bridge` once `whoami` answered; `recipient_id` once
resolved; `content` only for `dry_run`); one human line on **stderr** (`result-dm: <outcome>
(<reason>)`). Neither stream ever contains the token, the credentials path's contents, or the raw
error object -- an error's `message` is passed through only for the `error`, `unknown` and
`unavailable` outcomes and only after the token, if it appears in it, is replaced by `<token>`.

### Files

- `scripts/result-dm.mjs` (new). Export `parseArgs`, `isExpired`, `renderContent`,
  `assertBridge`, `resolveRecipient`, `classifyResult`, `idempotencyKeyFor`, and `run(argv, env, deps)` where
  `deps = { connect(url, token) -> Client, now() -> Date, stdout(line), stderr(line) }` so the test
  injects an in-process transport and captures both streams. The CLI entry is guarded the way
  `scripts/concurrency-check.mjs` guards its own (read its bottom for the exact
  `import.meta.url`/`pathToFileURL` check and copy that shape), with the real deps.
- `test/result-dm.test.mjs` (new).
- `README.md`: a short entry beside where `scripts/oauth-login.mjs` is documented (grep it), with
  the command line, the outcome vocabulary and the exit codes, and the sentence "retry only by
  re-running the same event".

### Tests (`test/result-dm.test.mjs`)

Build the in-process app the way `test/concurrency-check.test.mjs:21-50` does (`createApp` +
`createFakeBridge` + a `StreamableHTTPClientTransport` whose `fetch` is `app.fetchHandler`), and
obtain a **paired user principal holding `dm:self`** the way `test/service.test.mjs` does -- read
`:607-634` (a paired user token authenticating as `u-<id>`) and `:949-951`
(`buildApp({ defaultUserGrants: ["dm:self"] })`) and reuse that fixture rather than inventing one.
The fake bridge simulates a closed DM with `{ state: "failed", code: "RECIPIENT_UNREACHABLE" }`
(`test/support/fakeBridge.mjs:9`) and scripts registration answers (`:182-202`); `bridge.calls.dm`
is the record of DMs it was asked for (`service.test.mjs:1192-1194`).

| # | Test name | Pins |
|---|---|---|
| 1 | `parseArgs: accepts the full set and refuses each bad input by name` | missing `--event`; a `/` in `--event`; a 201-character label; a label with a newline; `--status success` (the old vocabulary); an `http://` link; a missing `--expires`; `--expires 2026-10-06T10:00` (no offset) -> each refused with the field named |
| 2 | `isExpired: before, equal and after the instant` | equal counts as expired |
| 3 | `renderContent: label, status word, optional link, and the 1500-character cap that keeps the link` | a 1400-character label plus a 200-character link -> the label is cut, the link is intact, length 1500 |
| 4 | `resolveRecipient: only the caller's own user, never another` | `[]` -> undefined; `[other]` -> undefined; `[other, self]` -> self |
| 5 | `classifyResult: every code maps to its outcome and exit code, per stage` | a table over `sent`, `duplicate`, and all eight error codes at `send`; `UPSTREAM_UNAVAILABLE` and `ACCESS_DENIED` at `whoami` -> `unavailable` (3) and `denied` (2); a thrown error at `whoami` -> `unavailable`, at `send` -> `unknown` |
| 6 | `end to end: a paired user sends once, repeats as duplicate, and a changed label is invalid` | `--bridge default` against the single-bridge fixture: `run` twice with the same event -> `sent` then `duplicate`, `bridge.calls.dm.length === 1`, the printed `idempotency_key` is `pip:<event>`; a third run with another label -> `invalid`, still one DM |
| 7 | `end to end: a closed DM is unreachable and is not retried` | the fake bridge's failed DM -> `unreachable`, exit 2, exactly one bridge call |
| 8 | `end to end: a principal without dm:self is denied before any recipient lookup or send` | a service principal with a `post:` grant -> `denied`, `code: no-dm-self`, `bridge.calls.dm.length === 0` and no recipients call |
| 9 | `end to end: --dry-run reports what it resolved and sends nothing` | outcome `dry_run`; the line carries `principal_id`, `bridge`, `recipient_id` and the exact `content`; `bridge.calls.dm.length === 0` |
| 10 | `expired: an --expires in the past short-circuits before connecting; a missing one is invalid before connecting` | `connect` dep is never called in either case; outcomes `expired` (4) and `invalid` (2) |
| 11 | `secrecy: the token never reaches stdout or stderr, including on a transport failure` | token `SENTINEL-TOKEN-7f3a`, a `connect` that throws an error whose message contains the token -> outcome `unknown`, exit 3, neither captured stream contains the sentinel |
| 12 | `credentials: only credentials.json under an absolute DISCORD_MCP_CONFIG_DIR; unset, relative, missing file and a set DISCORD_MCP_TOKEN with no file are each refused by name; no URL anywhere is refused` | each case -> `invalid`, exit 2, `connect` never called; `DISCORD_MCP_TOKEN` set beside a valid file is ignored (the file's token is what `connect` receives) |
| 13 | `wrong bridge: a principal on another bridge is denied before any recipient lookup or send` | `--bridge pip` against the single-bridge fixture (principal `u-<id>`, no suffix) -> `denied`, `code: wrong-bridge`, no recipients call, `bridge.calls.dm.length === 0` |
| 14 | `assertBridge: suffix must equal --bridge; no suffix matches only default` | `u-1@pip`/`pip` ok; `u-1`/`default` ok; `u-1@prod`/`pip` wrong; `u-1`/`pip` wrong; `u-1@pip`/`default` wrong |

### Coverage table

| Outcome demanded | Step | Test | Mutation that must fail it |
|---|---|---|---|
| Only the caller's own user is ever a recipient | 3-4 | 4, 8 | `resolveRecipient` returns `items[0]` |
| A principal without `dm:self` never sends | 3 | 8 | drop the `dm:self` check |
| A credential on another bridge never sends | 3 | 13, 14 | drop the suffix check in `assertBridge` |
| A gate refusal or unreachable bot before the send is reported as such, never as `sent` or `error` | 3, 8 | 5 | classify only the `send` stage |
| No credential source but the named file | validation | 12 | fall back to the platform default directory, or read `DISCORD_MCP_TOKEN` |
| One DM per event; repeats are `duplicate`, not resends | 7-8 | 6 | derive the key from `event + now()` |
| The body is bounded and contains only label, word, link | 5 | 3 | remove the 1500 cap |
| An ambiguous failure is `pending`/`unknown`, never `sent` or `error` | 8 | 5, 11 | map `UPSTREAM_UNAVAILABLE` to `error` |
| Expired events are refused without a send; no event is sent without an expiry | 1, validation | 10, 1 | remove the expiry check; make `--expires` optional |
| The token never appears in output | all | 11 | print the raw error on the `unknown` path |
| `--dry-run` sends nothing | 6 | 9 | fall through to `send_dm` |

Run each mutation in a scratch copy (`git worktree add --detach`), never in the tree the tests or
a reviewer are reading; paste the red test's name per row in the PR.

### Checks, gate, PR

- `npm run check` (paste the `# tests N` line); `npm run test:mutations` unchanged (it mutates
  contracts, not scripts -- say so rather than implying it covers this).
- Review gate: reviewer A on correctness and failure modes (a transport throw after the service
  accepted the send; `unavailable` vs `pending` vs `unknown` for the caller; the bridge pin; the
  cap); reviewer B on
  claims-vs-code, walking the acceptance bullets of #335 and this table against the merged tree.
  Both read-only. Fix or decline every evidenced finding in writing; re-run the gate on the whole
  merged state after a behaviour fix.
- PR in `Rackbops/discord-mcp`, title `feat(scripts): result-dm.mjs sends one owner result DM with an honest outcome`,
  body naming `Rackbops/rackbops-discord-bot#335`, the pasted checks, the mutation rows, the gate's
  rounds. Do not merge; report the link.

### Hand-off brief (spawn text)

```
EXECUTE AS WRITTEN
Repo: S:\Repos\discord-mcp (worktree from origin/main, branch feat/result-dm-script). Issue: Rackbops/rackbops-discord-bot#335 (the PR lands in Rackbops/discord-mcp).
Plan: docs/plans/epics/E332/03-result-dm-script.md in Rackbops/rackbops-discord-bot, branch claude/epic-pip-plans (git -C S:\Repos\rackbops-discord-bot show origin/claude/epic-pip-plans:docs/plans/epics/E332/03-result-dm-script.md).
Behaviour change: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Mutation checks in a scratch worktree. Scratch files: task-unique names (pr-body-335.md). Report the PR link, the pasted checks, the gate's rounds and any deviation.
```
