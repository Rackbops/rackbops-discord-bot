<!-- Plan for Rackbops/rackbops-discord-bot#240 (Epic #236). Verbatim copy of the approved plan comment: https://github.com/Rackbops/rackbops-discord-bot/issues/240#issuecomment-5754929160 -->

## Implementation plan — written by the orchestrating session, to be executed as written

One PR, branch `claude/bot-ops-routing` cut from `origin/main`, in an isolated worktree. Commit this plan as `docs/plans/epics/E236/05-bot-ops.md`. Read ADR-0006 first (in #237's plan, or `docs/adr/0006-per-plugin-routing.md` once #237 has merged): the file and request shapes below are its contract, not this child's to change.

Everything here is in `ops/bot-ops.sh`, `ops/bot-ops.test.ts`, one constant in `ops/admin/server.ts`, and docs. Read CONTEXT.md's gotchas on `env-set` (no `--build`; diff-before-validate), `ALLOWED_SPEC`, and the `BOT_OPS_SCHEMA` drift pin before touching the script.

### Decided — not open for re-planning

- **Only plugin-declared secret keys become writable.** Core secrets stay absent from every list and refused by `env-set`, exactly as today.
- **Write-only means write-only:** a secret key's *value* never leaves the script — not in `env-get`, `env-schema`, `env-set`'s result, a `die` message, or stderr. `env-schema` says only that the key exists, that it is secret, and whether it is set.
- **Existing output stays byte-compatible.** `env-get`'s object and every existing `env-schema` entry (`{pattern, required, source}`) are unchanged; secret keys are *additional* `env-schema` entries.
- **No new subcommand for requests** — the four routing actions ride `plugin-request`, the one mailbox writer.
- **A webhook URL travels on stdin only** and is never echoed; `die` messages for it carry no part of it.

### Step 1 — secret plugin keys: load them, keep them apart

`load_plugin_keys` (`bot-ops.sh:359-414`) drops a `secret` key with `continue` at `:408`. Instead, record it in a **separate** set so nothing that lists keys can pick it up by accident:

- New globals beside `PLUGIN_KEY_ORDER` / `PLUGIN_FORMAT` / `PLUGIN_REQUIRED`: `PLUGIN_SECRET_ORDER=()`, `declare -A PLUGIN_SECRET_FORMAT=()`, `declare -A PLUGIN_SECRET_REQUIRED=()`; reset at the top of `load_plugin_keys` with the others.
- In the read loop: a `secret = true` row goes into the three secret structures (first declaration wins, same as the non-secret path) and then `continue`s. `PLUGIN_KEY_ORDER` / `PLUGIN_FORMAT` never see it — so `cmd_env_get` needs **no change** and cannot emit one.
- A secret key that collides with a static `ALLOWED` key is ignored (static wins), same rule as the non-secret path.
- Rewrite the comment block at `:340-344` and the one at `:587-591`: secret keys are now *never listed and never read back, but settable*.

### Step 2 — `cmd_env_set`: accept them

- Whitelist check (`:592`): editable if in `ALLOWED`, `PLUGIN_FORMAT`, **or** `PLUGIN_SECRET_FORMAT`.
- Format / required lookup (`:612-618`): add the secret branch (`PLUGIN_SECRET_FORMAT`, `PLUGIN_SECRET_REQUIRED`).
- Nothing else changes: it still diffs against the effective value before validating, still backs up to `backups/` at `0600`, still recreates **without** `--build`, and its result still names changed *keys* only. Confirm by reading, and pin by test, that no path prints a value: the two `die`s in the validation loop name the key only; `changed` is `${!DIFF[@]}` (keys).

### Step 3 — `cmd_env_schema`: say they exist, never what they hold

After the existing plugin rows, append one row per `PLUGIN_SECRET_ORDER` key (skipping a collision with `ALLOWED`). Widen the positional groups from four to **six** — `key, pattern, required, source, secret, isSet` — passing `false false` for every existing row, and have the jq program emit the two extra fields **only when `secret` is `"true"`**:
`{(.[0]): ({pattern: .[1], required: (.[2] == "true"), source: .[3]} + (if .[4] == "true" then {secret: true, isSet: (.[5] == "true")} else {} end))}`.
`isSet` is `[ -n "$(env_value "$key")" ]` — the value is tested, never passed to jq. Keep the index/slice grouping (the `_nwise` comment at `:537-541` explains why) — only the stride changes.

### Step 4 — `cmd_routing_get` (new)

```bash
ROUTING_PATH=/app/data/routing.json
DISCOVERY_PATH=/app/data/discovery.json
```
beside `PLUGIN_STATE_PATH` / `PLUGIN_INDEX_PATH`. `cmd_routing_get`: `need docker; need jq`; for each path, `docker exec "$CONTAINER" cat <path> 2>/dev/null | jq -c . 2>/dev/null || true`, empty → the literal `null`; then `jq -n --argjson routing … --argjson discovery … '{routing: $routing, discovery: $discovery}'`. A missing, empty or corrupt file is `null`, never an error (the posture `cmd_status` takes for `state.json`). **`routing.secrets.json` is never named anywhere in the script.** Add the `routing-get)` arm to `main` and to the usage string.

### Step 5 — `cmd_plugin_request`: four more actions

Restructure the validation into a `case "$action"` with the five existing actions keeping **exactly** their current checks and messages, plus:

- `routing-set` — `plugin` matches `^[a-z][a-z0-9-]*$`; one `jq -e` program checks that `.servers` is an object, every key matches `^[0-9]{5,25}$`, every value is an object whose `commands` is `"all"` or a **non-empty** array of snowflake strings, and whose `postTo`, when present, is a snowflake string. Failure → `die "plugin-request: bad servers"`.
- `webhook-add` — `.url` matches `^https://(canary\.|ptb\.)?discord(app)?\.com/api(/v[0-9]+)?/webhooks/[0-9]{5,25}/[A-Za-z0-9_-]{20,}$`. Failure → `die "plugin-request: bad webhook url"` — **the message carries no part of the URL**.
- `webhook-remove` — `.channelId` matches `^[0-9]{5,25}$`; else `die "plugin-request: bad channelId '…'"`.
- `discovery-refresh` — nothing further.
- Anything else → the existing `bad action` message.

Keep each regex in a `local …_re='…'` variable and match with `[[ "$x" =~ $re ]]`, the way `ver_re` / `iso_re` already do — an inline ERE with parentheses does not survive bash's quoting rules.

The write is unchanged: the payload goes to `docker exec -i -u bun … cat >` on stdin, the filename is `<epoch-ms>-<action>-<nonce>.json`. Note in the function's comment that the payload may now hold a secret, which is why it must stay on stdin.

### Step 6 — schema bump

`readonly BOT_OPS_SCHEMA=2` → `3` (`bot-ops.sh:56`); `REQUIRED_BOT_OPS_SCHEMA = 2` → `3` (`ops/admin/server.ts:664`), same PR. `ops/bot-ops.test.ts:1311` pins the literal `=2` — update it to `=3`; that one expectation changes because the number is the thing under test. `server.test.ts`'s drift pin reads both files and needs no edit.

### Step 7 — tests, `ops/bot-ops.test.ts`

Extend `setup()`'s fake `docker` with two options beside `pluginIndex` / `pluginState`: `routing?: string` and `discovery?: string`, served for `exec … cat` of `/app/data/routing.json` and `/app/data/discovery.json`. (The shim matches by substring; `/app/data/routing.secrets.json` does not contain `/app/data/routing.json`, so the two can never be confused — assert that in a test rather than trusting it.)

- `describe("bot-ops.sh env-set accepts a plugin's secret key, write-only (#240)")` —
  `a secret key is written to .env and named in changed` · `env-get emits neither its name nor its value, before or after` · `its format is enforced` · `a required secret cannot be blanked` · `a core secret is still refused` (`DISCORD_TOKEN`) · `a secret key of a plugin that is not enabled is refused` · `the value appears nowhere in stdout, stderr or docker.log` (search all three for the literal value; the backup file legitimately contains it and is `0600` — assert the mode where the platform supports it).
- `describe("bot-ops.sh env-schema lists secret keys without their values (#240)")` —
  `a secret key carries secret:true and isSet:false when unset` · `isSet turns true once it is set` · `a non-secret entry is exactly {pattern, required, source}` · `the value appears nowhere in the output`.
- `describe("bot-ops.sh routing-get (#240)")` —
  `returns both files` · `a missing file is null` · `a corrupt file is null, not an error` · `never reads the secrets file` (no `docker.log` line contains `routing.secrets`) · `the script never names the secrets file` (grep the script source).
- `describe("plugin-request routing actions (#240)")` —
  `routing-set round-trips to the mailbox` · one rejection test per malformed shape (`servers` not an object; a non-snowflake server id; an empty channel list; a non-snowflake `postTo`) · `webhook-add round-trips on stdin` · `a webhook url never appears in argv` (not in `docker.log`) · `a bad webhook url is rejected without echoing it` (stderr does not contain the URL's token) · `webhook-remove` accept + reject · `discovery-refresh round-trips` · `the five update actions still validate exactly as before` (re-assert two existing rejections).
- `version` — update the pinned number; `reports schema 3`.

### Step 8 — docs

`ops/README.md`: the subcommand list gains `routing-get` and the four actions; the env section says plugin secrets are settable, never readable. `CONTEXT.md`: amend the `ALLOWED_SPEC` gotcha and add one — *plugin-declared secret keys are write-only: tracked in `PLUGIN_SECRET_*`, deliberately separate from `PLUGIN_KEY_ORDER` so nothing that lists keys can emit one; decided in ADR-0006*. Verify each sentence against the merged script.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| a secret can be set | 1, 2 | `a secret key is written to .env…` | leave the `continue` at `:408` dropping secrets |
| never listed by `env-get` | 1 | `env-get emits neither its name nor its value…` | push secret keys into `PLUGIN_KEY_ORDER` |
| `env-schema`: `secret` + `isSet`, no value | 3 | the four `env-schema` tests | emit `env_value` instead of the boolean; add the fields to every row |
| core secrets still refused | 2 | `a core secret is still refused` | add `DISCORD_TOKEN` to the accepted set |
| the value leaks nowhere | 2, 3 | `the value appears nowhere in stdout, stderr or docker.log` | put `$val` into the `is invalid` message |
| `routing-get` is total | 4 | `a missing file is null`, `a corrupt file is null…` | drop the `|| true` / the `null` default |
| secrets file never read | 4 | `never reads the secrets file`, `the script never names…` | add a third `cat` of it |
| new actions validated | 5 | each accept / reject test | accept an empty channel list; drop the `postTo` check |
| URL on stdin only, never echoed | 5 | `a webhook url never appears in argv`, `…rejected without echoing it` | pass the payload as an argument; interpolate `$url` into the `die` |
| old actions unchanged | 5 | `the five update actions still validate exactly as before` | move the version check inside one arm only |
| schema lockstep | 6 | `reports schema 3` + `server.test.ts`'s drift pin | bump only one of the two constants |

### Verification — paste the real output in the PR

```
bash -n ops/bot-ops.sh
shellcheck ops/bot-ops.sh        # if installed; say so if not
bun run check
bunx tsc --noEmit -p ops/tsconfig.json
bun test
```

`ops/bot-ops.test.ts` runs wherever bash and jq exist (both do on this Windows box via Git Bash) — say in the PR which cases ran locally and which only in CI. Mutation checks in a scratch worktree, one at a time, `bun test ops/bot-ops.test.ts`.

## Deviations from the plan (recorded at implementation)

None widens or narrows ADR-0006 decision 8. Each closes a path on which a secret value, or a core secret's editability, could otherwise leak, or is a mechanical adaptation.

1. **`RESERVED_KEYS`** (15 keys: the core credentials, access control and every `${VAR}` `docker-compose.yml` interpolates) is dropped from a manifest on load whether or not it declares the key `secret`. Without it a manifest naming `DISCORD_TOKEN` would have made a core secret writable. Pinned against `.env.example` and the compose file, and disjoint from `ALLOWED_SPEC`. **Not** in it: the wow plugin's `BLIZZARD_CLIENT_ID` / `BLIZZARD_CLIENT_SECRET` — the first cut reserved them, the orchestrator corrected that (nothing in `src/` reads them, `.env.example` files them under "Used by the wow plugin", and the wow Plugin Index entry declares both `secret: true`, so ADR-0006 decision 8 makes them settable). The pin test carries an explicit exemption list for keys a first-party plugin owns (today exactly those two) and asserts each sits under `.env.example`'s "Used by the <plugin> plugin" block.
2. **Fail closed on the manifest** (added after round 1). A key that ANY plugin in the index declares secret — enabled or not — is secret for all (only an enabled plugin's secret key is editable); a secret declared twice is first-wins; a `secret` that is not exactly `false` / absent (`"yes"`, `1`, `[]`) counts as secret; and an entry whose `key`, `format` or `required` holds a CR or LF is dropped whole. The row reader takes five raw lines per key, so a stray newline used to re-frame every later row and let an entry listed first forge a plain row for another plugin's secret key, making `env-get` print its stored value (reproduced by reviewer A and again here on `7651ca6`; the row reader is unchanged from `main`, and the non-boolean-`secret` and secret-only-in-a-disabled-plugin cases were reproduced against `main`'s own script too, so this is a pre-existing exposure that write-only secrets make matter more). `load_plugin_keys`'s jq program now emits a fifth `enabled` column and does the filtering.
3. **A submitted secret is always written.** A "no changes" answer would tell a caller its guess equals the stored value, so `env-set`'s own decision reveals nothing about the stored secret. The one skip is a blank for an already-unset key (what `isSet` already reveals).
4. **Recreate output redaction.** `env-set` scrubs every plugin-secret value out of docker's recreate output before it becomes `log`. Best effort, not a proof (declined in round 1, reviewer A's F5/F6): redaction of a *stored* secret could act as a guess oracle only if a real `docker compose` echoed caller-controlled text into its output (not observed; no compose on the dev box to test), and a secret short enough to be a substring of compose's fixed status text is not one worth defending; withholding the log instead would remove the operator's only view of why a recreate failed (the panel shows it). Stated as best effort in `ops/README.md` and `CONTEXT.md`.
5. **CR guard.** A value holding a CR is refused (`value for '<KEY>' is invalid`) before its format regex, for every key.
6. **`routing-get` scrub.** Members named `url`/`token`/`secret`/`password` are dropped and webhook-URL-shaped strings become `[redacted]`, since both files are read back from disk a person may have edited. The plan only required that the secrets file is never opened. Best effort: reviewer A showed it misses a bare token under another member name, an id and token split across fields, and a percent-encoded URL. Declined: neither file is meant to hold a URL, and broadening the name match would delete legitimate members (`webhooks` in `routing.json`, `inviteUrl` in `discovery.json`); the URL store itself is never opened. Known limit of the same scrub: it drops a member named `url`/`token`/`secret`/`password` at any depth, so a plugin literally named one of those (valid under `PLUGIN_NAME_RE`) would be hidden from `routing-get`'s `plugins` map; no shipped plugin is named so, and exempting the `plugins` map's keys was judged more moving parts than the case is worth.
7. **`echo_safe` and field-only `die` messages.** Where an existing action echoed a request field (`bad plugin '…'`), only a short printable string is shown, else `(not shown)`; the new actions name the field and never the value.
8. **`webhook-add` file is written under `umask 077`** in the container shell that creates it.
9. **Payload must be a JSON object** (`payload is not a JSON object`) so no later jq indexing error can quote a value.
10. **`json_string_field` and `\A…\z`.** `$(…)` drops trailing newlines and jq's `$` matches before one, so `"12345\n"` would otherwise validate as a snowflake while the file kept the newline; fields are read as strings holding no control character, and jq snowflake checks are anchored `\A…\z`.
11. **An existing test was edited beyond the schema literal.** `env-get`'s "a secret plugin key is refused" pinned the pre-#240 behaviour; it is now "a secret plugin key is never listed by env-get" (the still-true half). Its writable half is covered by the new `env-set` describe.
12. **Schema literals.** Every `schema: 2` in the `version` tests became `3`, and the `=2` source regex became `=3`; `server.test.ts` needed no edit (its drift pin reads both files).
13. **Test timeout.** `bot-ops.test.ts` wraps `test` with a 60s timeout; the multi-spawn loops exceed Bun's 5s default on Windows.
14. **`routing-set` shape.** The bot's own validator for the four new actions (`src/plugins/requests.ts`) does not accept them on `main` yet, so the tests pin the accepted `servers` shape against `repairRouting` in `src/routing/model.ts` (what the bot already keeps of the record) instead of against that file. The bot side of these requests is a separate child of Epic #236; until it lands a bot moves such a request file to `requests/rejected/` (noted in `ops/README.md`). **Residual, for the bot-side child:** for a `webhook-add` that quarantined file still holds the URL (owner-only, `src/plugins/requests.ts` `reject`), so the bot side should delete rather than quarantine a rejected `webhook-add`.
15. **`echo_key`** (round 1, reviewer A's F3). A refusal names a submitted key only when it is upper-case and at most 40 characters (`^[A-Z][A-Z0-9_]{0,39}$`), else `(not shown)`. A multi-line value is read line by line, so a later line's text before its `=` reached the message and the panel server's log.
16. **Declined (round 1, reviewer A's F2 as a design point).** The panel can set `PLUGIN_INDEX_URL`, so an admin can point the bot at an index that marks a key non-secret and read it back. Not fixed here: that admin also chooses which plugin code the bot downloads and runs with the `.env` in its environment, so they can already read every secret. The property is against the panel, its logs and screens.
17. **Round 1, reviewer B (claims-vs-code).** Fixed here: the stale sentences that said secrets are always refused / the mailbox runs only five actions / no ALLOWED regex admits `#`, `$` (`ops/admin/public/index.html`, `docs/adr/0005-plugins-ship-their-own-admin-ui.md` with an amendment note pointing at ADR-0006 decision 8, `ops/README.md`, and the `load_env_values` comment in `ops/bot-ops.sh`); `routing-set`'s `plugin` is now read through `json_string_field` so `"music\n"` is refused instead of queued with the newline; `umask 077` is set after `mkdir -p` so a not-yet-existing `requests/` is not created `0700`; and each mutation reviewer B showed surviving (`{0,40}` boundary, webhook token `{20,}`, empty manifest key, glob characters in a redacted secret, member-name case, the version check on every update action) is now a failing test, the large-discovery fixture now exceeds Linux's 128 KB single-argument limit too. **Not fixed here, needs a cross-repo change:** `src/plugins/contract.ts:31-32` still says `secret` keys "are never listed or edited by ops tooling, exactly like the core secrets", and the vendored copy in `Rackbops/rackbops-bot-plugins` (`packages/api/contract.d.ts`, checked verbatim by its `check-contract`) and that repo's `README.md:81` repeat it. Editing the comment here alone would turn that repo's CI red until it is re-vendored, so it is a follow-up for the orchestrator to schedule as one paired change. **Acceptance bullet 3, last clause:** the four new actions cannot be checked against `src/plugins/requests.ts` yet, because its `ACTIONS` set does not contain them until the bot-side child lands; `routing-set` is cross-checked against `repairRouting` instead, and `webhook-add` / `webhook-remove` / `discovery-refresh` are pinned by their own validators only.
