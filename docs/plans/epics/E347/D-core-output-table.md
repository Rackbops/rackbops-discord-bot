# Bundle D -- section 3, the core-output table and its conclusion (#349, #359, #369, #355, #371, #370, #374)

Part of [E347](README.md). Region: `ops/README.md` lines 848-875 (section 3) on `4ff8eef`. Documentation-only,
single-audit lane, plus one executed unit assertion that is **not committed**. Effort S. Branch
`docs/347-d-core-table`, worktree `S:\Repos\_wt\rdb-347-d`.

Split child: #374's section 4 "from step 2" is bundle B's; this plan owns its section 3 "admin" sentence.

Read each child in full first (`gh issue view <N> --json title,body,comments`). The table pins its line
numbers to `8d039c9`; this PR re-pins it to your branch's base (decision 4): **every cite in the table is
re-read on your tree**, the changed ones below and the unchanged rows alike, and the header names your base
commit. #392 (`5de2280`) added a `reset...ForTest` hook to most `src/` modules after the review, so expect
shifts in `updates.ts`, `requests.ts`, `updateReport.ts`, `update.ts`, `delivery.ts`, `host.ts`,
`register.ts`. Plugin cites are re-read at `2820afe` (0.3.1).

## Steps

### 1. The header paragraph (lines 850-852)

Replace with:

> The core still runs next to the plugin. This is every way the host sends something **on its own
> initiative** under the `.env` above, plus the three command paths a member can trigger, so that "Pip's
> host sends nothing unsolicited that reaches a DM" is a cited claim and not an assumption. Not listed, by
> design: the host's other interaction replies, which go only to the person who interacted and only after
> they did (`src/plugins/host.ts:657`, `:681`, `:755`; `src/commands.ts:200-203`, `:323`). Line numbers are
> on `<your base commit>` (this repository) and `2820afe` (`plugins/mcp` 0.3.1).

Carries #370 ("every way" no longer claims a completeness it lacks; the replies are listed in one clause).

### 2. The `/pipupdate`, `/pipplugins` row (line 860)

"Why it is bounded" becomes: `Both set `setDefaultMemberPermissions(0)`, hiding them from members without
Discord's Administrator permission (`src/commands.ts:106-107`); the handler then refuses anyone not in
`ADMIN_USER_IDS`, and with the list empty that is everyone, a server Administrator included.` Carries #374's
section 3 half.

### 3. The "Scheduled plugin update" row (line 858)

- Where it goes: `Nowhere under this `.env` unless someone writes the request mailbox on the host (see why).
  In general: the bot restarts onto the update and DMs a heads-up to the Discord user who scheduled it
  (`src/plugins/updates.ts:642-647`).`
- Why it is bounded: `A schedule comes only from a request: an admin's `/pipplugins` (none here) or the
  host-side mailbox. `bot-ops.sh plugin-request` is a `docker exec -u bun` write that validates `action`,
  `plugin`, `version`, `at` and `days` and never `requestedBy` (`ops/bot-ops.sh:1243-1317`); the bot's
  `validate` requires only a non-empty string there (`src/plugins/requests.ts:424`) and never consults
  `ADMIN_USER_IDS`; `schedule` and `update-now` carry it into the state (`:482-495`), and a snowflake is DMed
  (`updates.ts:642-647`; after the restart, `:686-691`). So anyone in the host's docker group can make Pip's
  core DM any user id, twice. That group is Pip's real admin set: it reads every secret with `docker
  inspect` (`docker-compose.yml:84-85`, `ops/install.sh:357-359`) and is root-equivalent through the mounted
  socket (`docker-compose.yml:45-49`); `ADMIN_USER_IDS=` governs Discord-side actors only. The panel's
  "logged, not sent" outcome is the panel's own choice of a non-snowflake `requestedBy`
  (`ops/admin/server.ts:2031`), enforced nowhere else. Section 2's `ADMIN_USER_IDS` comment carries the
  mailbox recipe.`
- Evidence: `src/plugins/updates.ts:604-655` (`runDueSchedules`, the DM at `:644`); `src/plugins/requests.ts:419-430`
  (`validate`), `:482-495`.

Carries #349 (the two rows and the trust model) and #359 (the column answers "under this `.env`" first).

### 4. The "Report-backs after an update" row (line 863)

- Where it goes: `Nowhere under this `.env` unless a mailbox request moved the plugin (see why). In general:
  an ephemeral follow-up where the command was typed, within 15 minutes of it, else a DM, else a channel post
  (`src/updateReport.ts:101-104`, the window `:13-14`; the follow-up is a raw REST webhook POST, `:128-133`,
  the one send path outside the Client, `src/client.ts:6-7`).`
- Why it is bounded: `Delivered only when an owed marker exists: `state.pendingUpdateReport`, set only with a
  `requester` (the guard `src/update.ts:103-111`, applied at `:293-298`; the one call site constructing a
  requester is `src/commands.ts:117`), or `state.pendingReport`, set by `/plugins update`, `runDueSchedules`
  and a mailbox `update-now` (`src/plugins/requests.ts:482-495`). `/pipupdate` and `/pipplugins` refuse here,
  so the mailbox is the only writer left; a snowflake `requestedBy` is DMed and any other value is logged
  (`src/plugins/updates.ts:686-691`, `:692-693`).`
- Evidence: unchanged (`src/index.ts:440` ... `src/plugins/updates.ts:673-703`), re-read.

Carries #349, #359 and #369 (the token route listed first).

### 5. The "Plugin `post` / `dm` / `edit` / `announce`" row (line 864)

- Where it goes: `A DM or an edit, **sent by core code on the plugin's request**: this is the path owner
  result DMs take. A channel delivery is refused here: `host.post` is wired (`src/index.ts:191-200`), every
  channel delivery takes that branch (`plugins/mcp/src/drain.ts:177-190`), and with no `routing.json` it
  throws "destination is not mapped in that server" before any Discord call (`src/plugins/host.ts:148-150`,
  `src/routing/resolve.ts:95-99`), recorded `failed` / `UPSTREAM_UNAVAILABLE`; Pip runs no panel, so no
  `routing.json` can be written. The `announce` fallback to `ANNOUNCE_CHANNEL_ID` (`drain.ts:192-202`) runs
  only when `host.post` is not a function, so never here.`
- Why it is bounded: keep the sentence, with the cites corrected: `(or the plugin's own tick re-drives an
  unfinished one, `plugins/mcp/src/index.ts:65-80`; the `edit` call `drain.ts:105`, `:133`, `:177-197`)`.
- Evidence: `src/index.ts:171-200` (the host wiring); `src/plugins/delivery.ts:16-46` (`sendPayloadToChannel`,
  `sendPayloadDm`), `:56-62` (`editOwnMessage`); `src/routing/post.ts:60` (`postForPlugin`, the `announce`
  path).

Carries #355 and three of #371's four cites.

### 6. The "Boot, handoff, ticks" row (line 866)

Evidence becomes: `` `src/bootLog.ts`; `src/index.ts:130`, `:458-472`; the 5-second mailbox drain
`src/plugins/drain.ts:11`, `:26`, started at `src/index.ts:353-358`; the 60-second backstop
`src/announce.ts:235-270` (`pluginRequests`, `discovery`) ``. Carries #371's fourth cite.

### 7. The conclusion (lines 868-875)

Replace `and no core-initiated path produces a DM; the only DMs are the ones the plugin sends through the host
API on the bridge's request.` with: `and no core-initiated path produces a DM without a host-side mailbox
write: the two rows above that can DM, a scheduled update's heads-up and the report-back, need a request in
the mailbox, which only the host's docker group can write, and that group is Pip's real admin set; the only
other DMs are the ones the plugin sends through the host API on the bridge's request.` Keep the rest.

### 8. Executed, not read (#349)

In your worktree create `src/plugins/requests.347.scratch.test.ts` (never staged; delete it before the
commit), copying the `entry` and `installedMap` helpers from `src/plugins/requests.test.ts`:

```ts
import { expect, test } from "bun:test";
import { validate } from "./requests";
// copy entry() and installedMap() from requests.test.ts here
test("#349: a mailbox schedule with a snowflake requestedBy needs no admin", () => {
  const installed = installedMap(["mcp", "0.3.0"]);
  const entries = new Map([["mcp", entry("mcp", "0.3.1")]]);
  const r = validate(
    { action: "schedule", plugin: "mcp", version: "0.3.1", at: "2026-10-10T18:30-04:00", requestedBy: "123456789012345678" },
    installed, entries, 1,
  );
  expect(r.ok).toBe(true);
});
```

Run `bun test src/plugins/requests.347.scratch.test.ts`, paste the assertion and the `1 pass` line, delete
the file, and confirm with `git status --short` that only `ops/README.md` is modified. The point is that
`validate` has no admin parameter at all (its signature is `validate(raw, installed, entries, hostApiVersion)`),
so a Discord snowflake from the host side is accepted as-is.

### 9. Re-pin, audit, PR

- Re-read every cite in the table on your tree (grep the section for `` `src/`` and `` `plugins/`` and
  `` `ops/`` cites; there are about forty), fix each that moved, and set the header's commit to your base.
  Paste `git rev-parse --short HEAD`.
- Spawn one read-only claims-vs-code audit subagent over the diff (lens: every cell in "Where it goes"
  answers under the Pip `.env` first; every cite names the line that establishes its claim; the trust-model
  sentences against `bot-ops.sh`, `requests.ts`, `updates.ts`, `docker-compose.yml`, `install.sh`,
  `ops/admin/server.ts`). Fix or decline each finding in writing.
- PR title: `docs(ops): Pip runbook core-output table, mailbox trust model and cites (#347)`. Body: `Closes
  #349, #359, #369, #355, #371, #370`; `Part of #374 (the rest is bundle B)`; the pasted test run; the audit
  findings. Do not merge.

## Coverage

| Acceptance bullet | Step | Check | What it catches |
|---|---|---|---|
| #349: rows no longer say nobody can; both name `bot-ops.sh plugin-request` with `requests.ts`/`updates.ts` cites | 3, 4 | audit re-reads the cites | "nobody can" back |
| #349: conclusion scoped; one sentence states the docker-group trust model | 7, 3 | grep the section for `docker group` -> present in row and conclusion | the unscoped conclusion back |
| #349: executed assertion pasted | 8 | the pasted `1 pass` | a claim about `validate` that the code does not make |
| #359: every "Where it goes" cell answers under the Pip `.env` first | 3, 4 | audit reads the column top to bottom | a generic answer first |
| #369: the token route first with the `updateReport.ts` cites | 4 | audit re-reads `:101-104`, `:13-14`, `:128-133` | the route missing |
| #355: the row describes only paths reachable under the Pip `.env` | 5 | audit re-reads `host.ts:148-150`, `resolve.ts:95-99`, `drain.ts:177-202` | the `announce` path presented as live |
| #371: each of the four cites names the establishing line | 5, 6 | audit re-reads the four | a cite one hop off |
| #370: the sentence no longer claims completeness, or lists the replies | 1 | audit re-reads the five reply sites | "every way" back |
| #374 (section 3 half): "admin" disambiguated | 2 | audit reads the row | the two senses back |
| Table re-pinned | 9 | the header names your base; spot-check ten cites | a line number from `8d039c9` surviving |
| Every bundle: independent audit, nothing outstanding | 9 | the findings on the PR | a false claim shipping |

## Hand-off brief

```
EXECUTE AS WRITTEN
Repo: Rackbops/rackbops-discord-bot. Plan: docs/plans/epics/E347/D-core-output-table.md on main (also the ## Plan comment on #347 for bundle D). Children: #349, #359, #369, #355, #371, #370, #374 -- read each in full, comments included; you own only the section 3 sentence of #374.
Worktree: git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-347-d origin/main -b docs/347-d-core-table (fetch first). Plugin cites at Rackbops/rackbops-bot-plugins 2820afe (gh api or a fetch); discord-mcp is not needed for this bundle.
Documentation-only, single-audit lane, plus the one scratch assertion in step 8 (run, paste, delete, never commit). Verify every cite on your tree while writing and re-pin the table's header to your base; then one read-only claims-vs-code audit subagent; fix or decline each finding in writing. Scratch files use task-unique names (pr-body-347d.md, commit-msg-347d.txt) and are read back before use. Rebase on origin/main before marking ready; never resolve a conflict in another bundle's region -- report it. Report the PR link, the pasted checks, the audit's findings and any deviation. Do not merge.
```
