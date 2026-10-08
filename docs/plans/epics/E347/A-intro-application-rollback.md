# Bundle A -- intro, section 1, section 8, section 10 (#363, #378, #361, #379, #380, #353)

Part of [E347](README.md). Region: `ops/README.md` lines 732-778 (intro and section 1), 936-950 (section 8)
and 1082-1092 (section 10's *Stopping it* and *Rollback* paragraphs), on `4ff8eef`. Documentation-only,
single-audit lane. Effort S. Branch `docs/347-a-intro-rollback`, worktree `S:\Repos\_wt\rdb-347-a`.

Read each child in full first (`gh issue view <N> --json title,body,comments`): #363, #378, #361 (its comment
says half landed in #346; only the intro sentence remains), #379, #380, #353. Every `file:line` below was
read at the commit the README says; **re-read each on your tree** (this repo at your branch's base,
discord-mcp at `fe46591` or newer, `plugins/mcp` at `2820afe`) and write the line you actually read. #392
(`5de2280`) added a `reset...ForTest` hook to most `src/` modules after the review, so expect small shifts.

## Steps

### 1. Intro (lines 734-749)

**#363.** Line 734-735 reads `plan of record `docs/plans/epics/EP-pip-discord-identity.md` on the epic's
plan branch, PR #331`. Replace with `design document `docs/plans/epics/EP-pip-discord-identity.md`, on
`main` via #340`. Execute and paste: `git ls-tree origin/main -- docs/plans/epics/EP-pip-discord-identity.md`
(one line, the file exists on `main`).

**Version and cites (decision 5).** Line 737 `0.3.0 in the published index` becomes `a fresh install takes the
version the published index holds that day, 0.3.1 as of 2026-10-08`. Lines 740-741 (`The cites below were
read from this repository at `8d039c9` (`main`), and the plugin's from `Rackbops/rackbops-bot-plugins` at
`477770d`.`) become: `A `file:line` in this section is as read on `main` by the change that last touched
the sentence; section 3's table names its own commit. Plugin cites are `plugins/mcp` at 0.3.1
(`Rackbops/rackbops-bot-plugins` `2820afe`).`

**#378.** Line 745 `It is what Rod sees as the DM's author.` becomes `It is what Rod (roshne, the owner) sees
as the DM's author.` After the two identity bullets (after line 749) add one paragraph:

> Two machines are involved as well. **nucbox** is the bot host, where this instance and the discord-mcp
> service run. **Melody** is Rod's Windows workstation, where the discord-mcp shim and the Pip credentials
> live (section 6); it is never the bot host, which matters in section 8.

Confirm "nucbox" is the name the file already uses for the host (lines 424 and 944 on `4ff8eef`).

**#361.** After that paragraph add:

> Any member of the approved server can run `/pipagent register` and then `pair`, and becomes a principal of
> their own with the same `dm:self` grant: the plugin's `agent` command sets no default member permission
> (`plugins/mcp/src/commands.ts:48-56`), the host adds none (`src/plugins/host.ts:299-329`), an unplaced
> plugin's command is allowed everywhere in the server (`src/routing/resolve.ts:130-134`), and the service
> hands every `u-<id>@pip` its service-wide `defaultUserGrants` with no per-bridge allowlist (discord-mcp
> `src/service/principals.ts:35-41`, `contracts/config.schema.json:108-116`). Server membership is the
> control, not this runbook's "Rod": such a principal can DM only itself, on its own rate budget. Rod
> accepted that boundary on #332.

### 2. Section 1 (lines 757-778)

**#380.** In the Installation bullet (lines 765-768), after `with the scopes `bot` and `applications.commands``,
insert: `Selecting `bot` reveals a **Permissions** menu: leave it empty (permissions integer `0`). Nothing
Pip does needs a server-wide permission: a DM is `client.users.fetch` + `user.send`
(`src/plugins/delivery.ts:36-38`), and the one channel send the core could make, a release post, is off
under section 2 and would need View Channel and Send Messages on the announce channel alone, which a channel
overwrite grants.` Keep `leave **User Install** off` and the invite sentence as they are. The live instance
was installed with View Channels + Send Messages server-wide (#336), which `@everyone` already holds; that is
harmless and is not changed -- say so in the PR body, not in the runbook.

**#379.** Replace lines 776-777 (`Keeping the application private ... was **not** read from a documentation
page.`) with: `Keep the application private: on the **Bot** page turn **Public Bot** off. Discord's
[OAuth2](https://docs.discord.com/developers/topics/oauth2) topic, "Bot Authorization Flow", read
<YYYY-MM-DD>, documents the toggle: with it unchecked only the application's owner can add the bot to a
server (the Application resource exposes it as `bot_public`).` Fetch the page the day you write this
(WebFetch), confirm both facts, write that date, and quote at most one phrase of under 15 words if you quote
at all. Keep `On **Bot**, copy the token into the next step.` and the avatar sentence.

### 3. Section 8, step 1 (line 940)

**#353.** Replace `1. **Stop sending:** remove the Pip credentials directory on Melody, or run `/pipagent
unregister`.` with:

> 1. **Stop sending.** First `/pipagent unregister` in Discord: that is the revocation. The bridge refuses a
>    delivery to an unregistered user at drain time (`plugins/mcp/src/drain.ts:128-131`,
>    `registry.ts:120-125`) and the service stops accepting every token paired through that bot within about
>    60 seconds (discord-mcp `src/service/registration.ts:204-207`, `store.ts:1012-1029`; its README,
>    "Revocation": there is no separate revoke call). Then delete the Pip credentials directory on Melody:
>    housekeeping that stops the one-shot `scripts/result-dm.mjs` sender, which reads only
>    `credentials.json`, but revokes nothing. A deleted file leaves the token valid server-side until the
>    inactivity prune, a running shim keeps its bearer in memory (`src/shim/cli.ts:190-204`), a backup copy
>    or a `DISCORD_MCP_TOKEN` environment variable still authenticates, and a delivery the bridge already
>    accepted (`plugins/mcp/src/http.ts:54-57`) is still re-driven by the plugin's tick
>    (`plugins/mcp/src/index.ts:65-80`) with nothing on Melody consulted.

Verify on discord-mcp's tree that the shim honours a `DISCORD_MCP_TOKEN` variable (grep `src/shim/cli.ts`);
if it does not, drop that clause and say so in the PR.

### 4. Section 10 (lines 1082-1092)

**#353.** Replace the *Stopping it* paragraph with:

> *Stopping it.* `/pipagent unregister` in Discord is the revocation: within about a minute every call with
> the Pip credential is refused (`ACCESS_DENIED`; proven on the debug bridge, not re-run on pip). Renaming or
> deleting `%APPDATA%\discord-mcp-pip` on Melody stops this script instantly and reversibly (it refuses with
> `invalid`, credentials missing, and sends nothing) but revokes nothing: the credential stays valid until
> Rod unregisters.

In the *Rollback* paragraph, `Stop sending (the directory above, or `/pipagent unregister`)` becomes `Stop
sending (`/pipagent unregister`, then the directory above)`.

Section 10 is pasted into hosted Pip's instructions (its first paragraph says so): the PR body carries the
line "Rod re-pastes section 10 into hosted Pip after this merges".

### 5. Checks, audit, PR

- Re-read every cite you wrote, on your tree; paste the `git rev-parse --short HEAD` of each tree used.
- Spawn one read-only claims-vs-code audit subagent (lens: every sentence in the diff against the line it
  cites and against the child issue's evidence; the two "within about 60 seconds" and "inactivity prune"
  claims included). Fix or decline each finding in writing on the PR.
- PR title: `docs(ops): Pip runbook intro, application page and revocation order (#347)`. Body: `Closes #363,
  #378, #361, #379, #380, #353`, the pasted checks, the audit findings, the two operator notes (permissions
  left as installed; re-paste section 10). Do not merge.

## Coverage

| Acceptance bullet | Step | Check | What it catches |
|---|---|---|---|
| #363: `git ls-tree` lists the file; sentence names no closed PR | 1 | the pasted `git ls-tree` line; grep the section for `#331` -> none | a pointer to a closed PR left in |
| #378: both names introduced on first use | 1 | audit: first "Rod" and first "Melody" in the section are the definitions | a later first use |
| #361: intro states the membership boundary with the cites | 1 | audit re-reads the four cites | a claim of exclusivity surviving |
| #379: the OAuth2 cite with the date read; the disclaimer gone | 2 | WebFetch of the page on the day; grep for `not** read` -> none | a dateless or wrong cite |
| #380: section 1 states the permissions integer and why | 2 | audit re-reads `src/plugins/delivery.ts` | a permission recommended that nothing needs |
| #353: step 1 names `unregister` as the revocation, the directory as housekeeping, with discord-mcp cites | 3 | audit re-reads `drain.ts`, `registry.ts`, `registration.ts`, `store.ts`, `cli.ts` | the two options presented as equivalent |
| #353: section 10's *Stopping it* agrees | 4 | audit: both paragraphs put `unregister` first | the section 10 copy drifting |
| Every bundle: independent audit, nothing outstanding | 5 | the audit's findings on the PR | a false claim shipping |

## Hand-off brief

```
EXECUTE AS WRITTEN
Repo: Rackbops/rackbops-discord-bot. Plan: docs/plans/epics/E347/A-intro-application-rollback.md on main (also the ## Plan comment on #347 for bundle A). Children: #363, #378, #361, #379, #380, #353 -- read each in full, comments included.
Worktree: git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-347-a origin/main -b docs/347-a-intro-rollback (fetch first). Sibling trees: discord-mcp at S:\Repos\discord-mcp (fetch; read with git show origin/main:<path>), plugins/mcp 0.3.1 via gh api or a fetch of Rackbops/rackbops-bot-plugins at 2820afe.
Documentation-only, single-audit lane: verify every cite on your tree while writing, execute the "executed" bullets and paste real output, then one read-only claims-vs-code audit subagent; fix or decline each finding in writing. Scratch files use task-unique names (pr-body-347a.md, commit-msg-347a.txt) and are read back before use. Rebase on origin/main before marking ready; never resolve a conflict in another bundle's region -- report it. Report the PR link, the pasted checks, the audit's findings and any deviation. Do not merge.
```
