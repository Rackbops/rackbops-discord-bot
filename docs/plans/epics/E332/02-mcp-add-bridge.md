<!-- Plan for Rackbops/rackbops-discord-bot#334 (Epic #332), written by the orchestrating session on
2026-10-06 against Rackbops/discord-mcp `main` @ `315d470` and corrected the same day by an
independent claims-vs-code audit. Every file:line below was read from that tree; the implementer
re-reads each one and corrects any that moved. -->

## Implementation plan -- #334: `deploy/add-bridge.md` and a `pip` bridge example (Rackbops/discord-mcp)

Documentation and example files only -- the **single-audit lane**. Nothing under `src/` changes.

### Why

The service supports up to four `additionalBridges` (`contracts/config.schema.json:46-49`,
`src/service/config.ts:262-361`), and the two-bridge deployment on nucbox already uses one. The
operator material today is `README.md:95-120` and `:147-194` (the multi-bridge overview and the
"adding a bridge" outline, which already prescribes reseeding the config volume and
`up -d --force-recreate discord-mcp`), `deploy/config.multi-bridge.example.json` (two bridges), one
commented line in `deploy/app.env.example:25-27`, one commented network in
`deploy/compose.yaml.example:74` and `:118-123`, and `deploy/pins.md` for the refusal case. None of
it is a step-by-step runbook with the secret handling, the bot-side order and the verification.
Adding bridge number three to a **live** service is the step Epic #332's #336 has to do, so it
gets a runbook of the same quality as `deploy/pins.md` and `deploy/dev-instance.md`, consistent
with `README.md:147-194` (read it first; the runbook expands it, never contradicts it).

### Step 1 -- worktree and reading

`git -C S:\Repos\discord-mcp worktree add <path> origin/main -b docs/add-bridge-runbook`. Read,
whole: `deploy/compose.yaml.example` (its header is the authority on how `config.json` reaches the
`config` volume and why there are two env files), `deploy/app.env.example`,
`deploy/config.multi-bridge.example.json`, `deploy/pins.md`, `src/service/config.ts:239-361` (what
the loader refuses), and the startup-pin code the loader hands off to -- find it from
`test/startup-pins.test.mjs` -- so the runbook can state **what happens to the pin of a bridge
that is new** (recorded on first confirmation, or something else) and **what happens to the pin of
a bridge that has been removed from config** (ignored, or a refusal). Both are stated from the
code you read, with cites; if the code does not settle one, the runbook says "unverified".

### Step 2 -- `deploy/add-bridge.md`

Sections, in this order. Every command is derived from a cited file, and every placeholder is in
`<angle brackets>`.

1. **When you need this**: a new bot instance (a new Discord application, its own
   `rackbops-discord-bot-<instance>` container with `HTTP_PORT` set and `PLUGINS` including `mcp`)
   must become reachable through the shared service as its own bridge. Not for renaming or
   repointing the default bridge.
2. **What you need**: the bot's container name and `HTTP_PORT`; the bot's compose network name
   (`rackbops-discord-bot-<instance>_default`, confirmed with `docker network ls`); the bridge id
   (the schema's pattern for `additionalBridges[].id`, cite it) and the `commandPrefix` the bot
   runs with (it must equal the bot's `COMMAND_PREFIX`, since every user-facing command string
   comes from it -- cite `docs/plans/41-command-names.md` or the code that renders it).
3. **The shared secret, without printing it.** Generate 32 random bytes as base64url (43
   characters, which satisfies the plugin's `^\S{43,}$`), hold it in a shell variable, append it
   to **both** files, then unset it:
   `T=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")`;
   `printf 'MCP_BRIDGE_TOKEN=%s\n' "$T" >> /opt/rackbops-discord-bot/<instance>/.env`;
   `printf 'DISCORD_MCP_BRIDGE_TOKEN_<ID>=%s\n' "$T" >> <stack>/app.env`; `unset T`. State that
   the bot must be **recreated** to read its new key (`bot-ops.sh recreate` with that instance's
   identity is `up -d --force-recreate`, `ops/README.md:30` in the bot repo; a plain restart does
   not reload env), and that this happens **before** the service is recreated so the bridge answers
   when the service pins it. Say that a token shared with any other bridge is refused at load
   (`config.ts:350-361`), as is a reused `tokenEnv` name (`:338-348`).
4. **`config.json`.** Copy it out of the volume with a one-off container (the inverse of the
   header's seeding command: `docker run --rm -v <project>_config:/config alpine:3 cat /config/config.json > config.json`),
   add the entry (`id`, `url` = `http://<container>:<HTTP_PORT>/mcp`, `tokenEnv`,
   `allowInsecureHttp: true`, `commandPrefix`, `test`), and write it back with the header's own
   seeding command. Spell out the loader's explicitness rule: once `additionalBridges` is non-empty,
   `bridge.id`, `bridge.test`, every additional bridge's `test` and every service principal's
   `bridge` must be set (`config.ts:274-295`); a first-ever additional bridge therefore also edits
   those. Unique ids (`:297-303`); `allowInsecureHttp` required for `http://` (`:305-325`).
5. **`compose.yaml`.** Add the bot's network under the service's `networks:` and as an external
   entry under the top-level `networks:` (the `bot_prod` example at `compose.yaml.example:74`,
   `:118-123`). Nothing else in the file changes.
6. **Recreate, in a change window.** Stop the deploy timer and recreate only the service --
   `docker compose -f <stack>/compose.yaml up -d --force-recreate discord-mcp`, the form
   `README.md:171-176` prescribes because `env_file` is read only when a container is created
   (`deploy/pins.md` section 2 names the timer and the `stop`) -- then start the timer. The
   public hostname is unavailable for as long as the origin is down; `cloudflared`'s
   `depends_on: condition: service_healthy` (`compose.yaml.example:104-108`) only orders its own
   start and is not touched by this command. Every bridge's clients share this one outage.
7. **Verify.** The log's `loaded config from` line; `pins.js show` listing the new bridge (and what
   it says for a new one, from step 1's reading); `/healthz` 200 through the public hostname; an
   existing caller's `whoami` still naming its own bridge; on the new bot `/<prefix>agent register`
   then `/<prefix>agent pair`, the shim's `pair` into a **dedicated** `DISCORD_MCP_CONFIG_DIR`, and
   a `whoami` returning `u-<id>@<bridge id>` -- the lowercase bridge id, e.g. `@pip`, not the env
   suffix (`src/domain/bridge.ts:25-28`, `README.md:108-110`) -- with only `dm:self`.
8. **Rollback.** Remove the entry, the network lines and the `tokenEnv` line;
   `up -d --force-recreate discord-mcp` the same way; the stale pin's fate from step 1's reading.
   Never restore the state volume from a snapshot (it holds every bridge's grants and deliveries).
   Removing the bot's `MCP_BRIDGE_TOKEN` is the bot's own operator step.
9. **Not verified by this runbook**: say explicitly that no live host was touched while writing it
   and which commands were therefore derived rather than executed.

### Step 3 -- example files

- `deploy/config.multi-bridge.example.json`: a third entry
  `{ "id": "pip", "url": "http://rackbops-discord-bot-pip:<HTTP_PORT>/mcp", "tokenEnv": "DISCORD_MCP_BRIDGE_TOKEN_PIP", "allowInsecureHttp": true, "commandPrefix": "pip", "test": false }`.
  `test/config.test.mjs:372-409` loads this file through the real `loadConfig` with env for only
  the debug/prod/example tokens, replaces `<HTTP_PORT>` only in `additionalBridges[0]`, and pins
  `config.bridges.map(b => b.key)` to `["", "prod"]` -- so the entry alone turns that test red
  (`missing value for bridge token env var DISCORD_MCP_BRIDGE_TOKEN_PIP`, `config.ts:333-334`).
  In the same PR: add `DISCORD_MCP_BRIDGE_TOKEN_PIP: "pip-secret"` to that test's env, replace the
  placeholder for **every** additional bridge, pin the keys to `["", "prod", "pip"]`, and add a
  `bridges[2]` `deepEqual` mirroring the prod one (`commandPrefix: "pip"`, `test: false`). This is
  a test-expectation change for an example file, no behaviour change; say so in the PR.
- `deploy/app.env.example`: a second commented line `# DISCORD_MCP_BRIDGE_TOKEN_PIP=<BRIDGE_SHARED_SECRET>` under the existing `_PROD` one.
- `deploy/compose.yaml.example`: reword the `bot_prod` comments (`:74`, `:118-123`) to "one external
  network per additional bridge, e.g. `bot_prod`, `bot_pip`"; keep the YAML itself unchanged so
  `test/assert-compose.test.mjs` and `test/deploy/` stay green.
- Link `deploy/add-bridge.md` from `README.md`, next to its existing `deploy/pins.md` links
  (`README.md:119`, `:144`, `:176`, `:182`; the "adding a bridge" outline at `:147-194` is the
  natural place) -- same sentence shape. `docs/architecture.md` and
  `docs/plans/multi-bridge-design.md` do not link `pins.md` and need no change.

### Step 4 -- checks, audit, PR

- `npm run check` (lint + build + every test, including the updated `config.test.mjs` case); paste
  the summary line.
- A link check over the new file (every relative path exists).
- **One independent audit**: a read-only reviewer verifies every `file:line` and every command
  against the tree and reports any step a reader could not execute as written. Fix or decline each
  finding in writing on the PR.
- PR in `Rackbops/discord-mcp`, title `docs(deploy): add-a-bridge runbook and a pip bridge example`,
  body naming `Rackbops/rackbops-discord-bot#334`. Do not merge; report the link.

### Coverage table

| Acceptance bullet | Step(s) | Verification | What would make it fail |
|---|---|---|---|
| `npm run check` passes with the example changes | 3, 4 | `test/config.test.mjs:372-409` (updated to three bridges) and the compose tests, pasted | an example entry the schema or loader rejects, or the test left pinned to two bridges |
| Every command derived from a cited file; unverified steps named | 2 | manual: the audit re-derives each command | a command with no source, or a derived one presented as executed |
| One independent audit, findings fixed or declined | 4 | the reviewer's report on the PR | none |

### Hand-off brief (spawn text)

```
EXECUTE AS WRITTEN
Repo: S:\Repos\discord-mcp (worktree from origin/main). Issue: Rackbops/rackbops-discord-bot#334 (the PR lands in Rackbops/discord-mcp).
Plan: docs/plans/epics/E332/02-mcp-add-bridge.md in Rackbops/rackbops-discord-bot, branch claude/epic-pip-plans (git -C S:\Repos\rackbops-discord-bot show origin/claude/epic-pip-plans:docs/plans/epics/E332/02-mcp-add-bridge.md).
Documentation and examples only; single-audit lane. Scratch files: task-unique names (pr-body-334.md). Report the PR link, the audit result and any deviation.
```
