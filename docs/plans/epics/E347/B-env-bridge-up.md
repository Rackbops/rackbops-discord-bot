# Bundle B -- sections 2, 4 and 5 (#354, #356, #352, #362, #366, #368, #372, #374, #375, #376, #377, #390)

Part of [E347](README.md). Region: `ops/README.md` lines 780-846 (section 2) and 877-901 (sections 4 and 5)
on `4ff8eef`. Documentation-only, single-audit lane. Effort S: the section 2 block is rewritten as one piece,
so the twelve children are one edit, not twelve. Branch `docs/347-b-env-bridge-up`, worktree
`S:\Repos\_wt\rdb-347-b`.

Split children: #352's section 7 clause, #376's section 7 probe and #377's section 7 pointer are bundle C's;
#374's section 3 "admin" sentence is bundle D's. This plan owns their section 2, 4 and 5 sentences only;
the PR body says "part of #352/#374/#376/#377, the rest is bundle C/D" and does not close those four.

Read each child in full first (`gh issue view <N> --json title,body,comments`); #375's comment and #390's
body carry facts that post-date the review. Every `file:line` below was read at the commit the README says
or at `4ff8eef`; **re-read each on your tree** (this repo at your base; discord-mcp `deploy/add-bridge.md`
at `fe46591` or newer; `plugins/mcp` at `2820afe`) and write the line you actually read. #392 (`5de2280`)
added a `reset...ForTest` hook to most `src/` modules after the review, so expect small shifts; #390 lists
four that already moved.

`[NEEDS CLARIFICATION: #375 -- pin PLUGINS=mcp@0.3.1 or leave it unpinned? Rod's call; both texts are in
step 2 below. This plan is not handed over until the marker is resolved by the orchestrator.]`

## Steps

### 1. Section 2, the paragraph before the block (lines 787-789)

Replace `Then, in the instance's config-dir `.env` ... (Compose strips an inline ` # comment`; `bot-ops.sh` and
the panel do not).` with:

> Then edit the instance's config-dir `.env`: the hand-edited file `install.sh` seeds from `.env.example`
> and never touches again. The rules are the Clerk runbook's step 3 (two `.env` files with different jobs;
> comments on their own lines). **Complete the file before the first `up`** (section 5). The seeded
> placeholders pass the core's `required()` check (`src/config.ts:58-62`), so a token-only edit boots; with
> `DISCORD_SERVER_ID` blank that boot registers `/update`, `/plugins` and `/report` **globally and
> unprefixed**, and once the server is set single-server mode issues its one guild-scoped PUT and never
> clears the global list (`src/routing/register.ts:43`, `:72`, `:143`: `clearGlobal` exists only in routed
> mode). The recovery is one authenticated `PUT []` to `/applications/<app>/commands`, which section 9
> records having to do. `MCP_BRIDGE_TOKEN` is the one key missing from the block on purpose: section 4's
> runbook writes it.

This carries #356 (the ordering sentence and the recovery), #377's section 2 pointer (the copied comment-rule
sentences become the pointer the file already uses at line 788) and decision 3.

### 2. Section 2, the block (lines 791-841)

Replace the whole fenced block with the one below, then fix every cite on your tree (#390's four are already
corrected here from `fe51058`; check them again, and all the others, at your base).

```sh
DISCORD_TOKEN=<Pip's bot token>
# Required by the core (src/config.ts:79) but idle under this file: the release watcher is off
# (WATCHED_REPOS=none) and a plugin channel delivery is refused on Pip (section 3), so nothing posts
# here. Use a private channel in the approved server. If the watcher is ever turned on, give the Pip
# bot View Channel and Send Messages there by channel overwrite: a post to a channel it cannot see
# throws before the release is marked seen, and the next 15-minute poll fails the same way, forever
# (src/announce.ts:95, :478-485; the poll src/announce.ts:27).
ANNOUNCE_CHANNEL_ID=<channel id>
RELEASE_ANNOUNCE_CHANNEL_ID=
# The one approved server: registration is one guild-scoped PUT there and nowhere else
# (src/routing/register.ts:56-59, :128-131, reached from src/index.ts:367-382). Set it before the
# first up (see above): single-server mode never clears a global list an earlier boot left behind.
DISCORD_SERVER_ID=<server id>
# Every command is prefixed, core ones included (src/commandNaming.ts:15-16, used at :22-23;
# src/commands.ts:61-67): /pipagent register|pair|unregister, /pipupdate, /pipplugins, /pipreport.
# 1-20 chars of [a-z0-9_-] (src/config.ts:97-103). The service's bridge entry must carry the same
# value as its commandPrefix (section 4). The debug bot's prefix `r` (/ragent) is the precedent:
# Rackbops/discord-mcp deploy/config.multi-bridge.example.json:8.
COMMAND_PREFIX=pip
GITHUB_REPO=Rackbops/rackbops-discord-bot
# `none` turns release polling off (section 3, release-watcher row); blank would fall back to
# GITHUB_REPO.
WATCHED_REPOS=none
GITHUB_TOKEN=
# Blank: /pipreport answers that it is not configured (src/report.ts:66-72).
REPORT_ROLE_ID=
# Empty on purpose: a plugin-update notice is then a log line, never a DM or a post, and section 3's
# plugin-update row says when the warning stops. This list governs Discord-side actors only: whoever
# can write the request mailbox on the host needs no entry here and can schedule an update or move
# the plugin regardless (section 3, scheduled-update row). Moving the plugin with no admin: a
# mailbox request, which the bot applies and then restarts onto (ops/bot-ops.sh:1244-1278;
# src/plugins/requests.ts:482-491, :335), run with section 7's BOT_OPS_* variables:
#   printf '%s' '{"action":"update-now","plugin":"mcp","version":"<x.y.z>","requestedBy":"operator"}' |
#     bash /opt/rackbops-discord-bot/bin/bot-ops.sh plugin-request
# A non-numeric requestedBy keeps the outcome in the log (src/plugins/updates.ts:692-693). The same
# request with "action":"skip" and the index's newest version silences the warning without moving
# the plugin (src/plugins/requests.ts:499-501).
ADMIN_USER_IDS=
AUTO_UPDATE=false
BOT_BRANCH=main
<<PLUGINS LINE AND ITS COMMENT: see the two variants below>>
PLUGIN_INDEX_URL=
# The host router (ADR-0007): the bridge answers under /mcp/ on this port, inside the compose network
# only. Any port 1-65535 (src/config.ts:128-131): nothing else listens inside Pip's container and no
# host port is published (docker-compose.yml:12-58 has no ports:), so "free" constrains nothing; it
# must equal the port in the service's bridge url (section 4). 8794 is what the live instance uses.
HTTP_PORT=8794
TRUSTED_PROXY_HOST=
LOG_FORMAT=json
```

**Variant "unpinned" (recommended; use if Rod declines #375):**

```sh
# Unpinned: a fresh install takes the index's version that day and records it in plugins/state.json
# on the state volume (docker-compose.yml:44); from then on it moves only on a request (the mailbox
# above, or an explicit pin here followed by bot-ops.sh recreate), never on its own
# (src/plugins/install.ts:289-293, :318-320). This section's plugin cites are 0.3.1's.
PLUGINS=mcp
```

**Variant "pinned" (use if Rod accepts #375):**

```sh
# Pinned to the version this section's plugin cites were read from. An operator pin wins over every
# other version source at every boot, the mailbox's update-now target included
# (src/plugins/install.ts:289-293, :318-320), so while it is set the mailbox request above does not
# move the plugin: each bump is this line plus bot-ops.sh recreate (.env.example:49, ops/bot-ops.sh
# recreate).
PLUGINS=mcp@0.3.1
```

In the pinned variant also change the `ADMIN_USER_IDS` comment's "Moving the plugin with no admin" sentence
to say the mailbox route applies only while `PLUGINS` is unpinned.

This block carries #354 (the channel comment, rewritten for the watcher-off world the block itself
prescribes: the channel is idle, and the failure mode is stated for the day the watcher is turned on), #356
(the `DISCORD_SERVER_ID` qualification), #372 (the plugin-update and release-watcher explanations now point
at section 3's rows; the recipe stays, decision 6), #374's section 2 half (none: "printed step 2" was
already gone from this block on `4ff8eef`), #375 (one variant), #376 (the port), #390 (the four cites), and
the line `MCP_BRIDGE_TOKEN=` is gone (decision 3).

### 3. Section 2, the paragraph after the block (lines 843-846)

Replace `` `MCP_BRIDGE_TOKEN` is the plugin's own secret key ... Everything else (the warbandeer and wow keys) stays blank. `` with:

> `MCP_BRIDGE_TOKEN` is the bridge's shared secret and the plugin's own key (`format` `^\S{43,}$`,
> `secret: true` in its manifest, declared `required: false` because its behaviour when unset is a runtime
> one: the bridge answers `503` to everything, `plugins/mcp/src/http.ts:186-187`). **Do not add it here.**
> discord-mcp's add-a-bridge runbook, section 3, generates it and appends the `MCP_BRIDGE_TOKEN=` line to
> this file, and the service's `DISCORD_MCP_BRIDGE_TOKEN_PIP` to its own `app.env`; Pip is then recreated
> so the new key is read (section 4). Never leave a blank `MCP_BRIDGE_TOKEN=` line as a placeholder: Compose
> makes it the empty string, not unset, the host copies plugin keys raw (`src/plugins/host.ts:85`, unlike
> the core's `optional()` at `src/config.ts:64-67`, which is what makes `KEY=` mean "off" for core keys),
> the plugin treats only `undefined` as unconfigured (`plugins/mcp/src/http.ts:187`), and it then answers
> `401` to every bearer, the service's correct one included (`plugins/mcp/src/auth.ts:66-69`) -- which
> section 7's unauthenticated probe cannot tell from healthy; the authenticated one can. The append would
> still work after such a line (the last value wins in Compose and in `bot-ops.sh`), but check with
> `grep -c '^MCP_BRIDGE_TOKEN=' /opt/rackbops-discord-bot/pip/.env` (a count, never the value) before and
> after. Every other key in `.env.example` stays blank except `ADMIN_TOKEN`, which `install.sh` already
> filled (`ops/install.sh:269-270`); leave it.

Carries #352's section 2 half, #362's "who writes the token", #366, and #377's second copied sentence.
Execute and paste for #352: `FOO= bun -e 'console.log(JSON.stringify(process.env.FOO))'` -> `""`.

### 4. Section 4 (lines 877-896)

Replace the section body with:

> The service side (the `pip` bridge entry, the network attachment, the shared secret and the default
> `dm:self` grant) is `Rackbops/discord-mcp`'s
> [`deploy/add-bridge.md`](https://github.com/Rackbops/discord-mcp/blob/main/deploy/add-bridge.md)
> (Rackbops/discord-mcp#78, for this repo's #334). **Run it after section 5's first `up`**: its section 5
> attaches the service to this project's network as `external: true`, and that network exists only once
> the bot's own compose project has been up at least once (`add-bridge.md` section 5; `docker-compose.yml`
> declares no `networks:` key, so the network is the project default, `rackbops-discord-bot-pip_default`).
> This side supplies three values and two facts:
>
> - the container name, `rackbops-discord-bot-pip` (the compose project's `container_name`, from
>   `BOT_OPS_CONTAINER`, `docker-compose.yml:31`);
> - `HTTP_PORT`, `8794` from section 2: the bridge URL is `http://rackbops-discord-bot-pip:8794/mcp`;
> - `MCP_BRIDGE_TOKEN`: `add-bridge.md` section 3 generates it and appends it to this instance's `.env` and,
>   as `DISCORD_MCP_BRIDGE_TOKEN_PIP`, to the service's `app.env`. Recreate Pip afterwards
>   (`bot-ops.sh recreate`, section 7; a restart does not reload env) and before the service's own recreate,
>   so the service's startup probe finds the bridge answering and pins it (`add-bridge.md` sections 3 and 6);
> - the entry's `commandPrefix` must equal `COMMAND_PREFIX=pip`: the host prefixes every plugin command, and
>   the service shows users that name when it asks for a pairing code (`add-bridge.md` section 2);
> - Pip is a production bridge, `test: false`: production bridges are tried first when a code is redeemed,
>   and a pinned flag refuses start if it changes later (`add-bridge.md` sections 2 and 6).
>
> `GET /mcp/capabilities` answers `401` without the bearer (and `503` if `MCP_BRIDGE_TOKEN` is unset in the
> container: `plugins/mcp/src/http.ts:186-191`, `plugins/mcp/src/auth.ts:63-71`), so a `401` from inside
> the network is the "listener is up" check, not a failure; a blank value is not unset (section 2), and
> section 7's authenticated probe is the check that tells them apart.

Carries #362 (the order and the writer), #368 (`commandPrefix` and `test`), #374's section 4 half ("from
step 2" is gone), #376's section 4 half (the port).

### 5. Section 5 (lines 898-901)

Replace with:

> Bring the bot up with `install.sh`'s printed step 2, with the `.env` completed (section 2) and **before**
> the service side of section 4: the compose network the service attaches to exists only after this first
> `up`. No admin profile and no tunnel: the printed steps 4 and 5 are not run for Pip. After
> `add-bridge.md` has appended `MCP_BRIDGE_TOKEN`, recreate Pip (`bot-ops.sh recreate`, section 7) so the
> key is read; a restart does not reload env.

Carries #356's section 5 sentence, #362's recreate step, and #377's section 5 item ("printed step 2" is the
file's own convention for `install.sh`'s steps and stays).

### 6. Checks, audit, PR

- Re-read every cite in the new text on your tree and paste `git rev-parse --short HEAD` for each tree used.
  For #390 paste the four lines you read.
- Paste the `FOO=` command and its output (#352).
- Spawn one read-only claims-vs-code audit subagent over the diff (lens: every cite, every "section N"
  pointer resolves to a sentence that says what is claimed, the three ordering sentences -- complete before
  first `up`; bring up before the bridge; recreate after the append -- do not contradict each other, and
  the pinned/unpinned comment matches `src/plugins/install.ts`). Fix or decline each finding in writing.
- PR title: `docs(ops): Pip runbook .env block, bridge hand-off and bring-up order (#347)`. Body: `Closes
  #354, #356, #362, #366, #368, #372, #375, #390`; `Part of #352, #374, #376, #377 (the rest is bundle C or D)`;
  the pasted checks; the audit findings. Do not merge.

## Coverage

| Acceptance bullet | Step | Check | What it catches |
|---|---|---|---|
| #354: the comment names the bot's channel permissions and cites `src/announce.ts` | 2 | audit re-reads the throw and the persist order | a channel the bot cannot see presented as safe |
| #356: sections 2/5 carry the ordering sentence and the recovery, citing `register.ts` | 1, 5 | audit re-reads `clearGlobal` | an early `up` left unwarned |
| #352 (section 2 half): the blank-value behaviour with the three cites; `FOO=` output pasted | 3 | the pasted `""` | `KEY=` presented as "off" |
| #362: step order matches add-bridge.md; one writer of the token; recreate stated | 3, 4, 5 | audit reads `add-bridge.md` sections 3, 5, 6 | two writers, or no recreate |
| #366: `ADMIN_TOKEN` named as the populated exception | 3 | grep the block's paragraph for `ADMIN_TOKEN` | "everything else blank" restored |
| #368: section 4 names `commandPrefix` and `test` with the add-bridge cite | 4 | audit reads `add-bridge.md` section 2 | the two facts dropped |
| #372: each explanation lives once; the comments point at the table | 2 | grep the block for `updates.ts:` -> only the two recipe cites | a duplicated explanation re-growing |
| #374 (section 4 half): "from step 2" gone | 4 | grep sections 2-5 for `step 2` -> only "printed step 2" | the ambiguity back |
| #375: the block pins or says why not, per Rod | 2 | the variant matches the marker's resolution | the wrong variant |
| #376 (sections 2, 4): the constraint stated; the port concrete | 2, 4 | grep for `<free internal port>` -> none | the placeholder back |
| #377 (sections 2, 5): no copied factual sentence | 1, 3 | grep Clerk step 3's sentences in the Pip section -> none verbatim | a copy back |
| #390: the four cites land; the four lines pasted | 2 | the pasted lines | a cite one line off |
| Every bundle: independent audit, nothing outstanding | 6 | the findings on the PR | a false claim shipping |

## Hand-off brief

```
EXECUTE AS WRITTEN
Repo: Rackbops/rackbops-discord-bot. Plan: docs/plans/epics/E347/B-env-bridge-up.md on main (also the ## Plan comment on #347 for bundle B); the #375 marker is resolved as: <UNPINNED|PINNED>. Children: #354, #356, #352, #362, #366, #368, #372, #374, #375, #376, #377, #390 -- read each in full, comments included; you own only the section 2, 4 and 5 sentences of #352, #374, #376 and #377.
Worktree: git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-347-b origin/main -b docs/347-b-env-bridge-up (fetch first). Sibling trees: discord-mcp at S:\Repos\discord-mcp (fetch; git show origin/main:deploy/add-bridge.md), plugins/mcp 0.3.1 at Rackbops/rackbops-bot-plugins 2820afe.
Documentation-only, single-audit lane: verify every cite on your tree while writing, execute the "executed" bullet and paste real output, then one read-only claims-vs-code audit subagent; fix or decline each finding in writing. Scratch files use task-unique names (pr-body-347b.md, commit-msg-347b.txt) and are read back before use. Rebase on origin/main before marking ready; never resolve a conflict in another bundle's region -- report it. Report the PR link, the pasted checks, the audit's findings and any deviation. Do not merge.
```
