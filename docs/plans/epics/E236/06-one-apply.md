<!-- Plan for Rackbops/rackbops-discord-bot#256 (Epic #236). Copy of the approved plan comment, https://github.com/Rackbops/rackbops-discord-bot/issues/256#issuecomment-5766334997, as of when it was approved, with the implementer's "Deviations from the plan" appended at the end. -->

## Implementation plan — written by the orchestrating session, to be executed as written

_Written 2026-09-21 against PR #269's branch (`claude/bot-ops-routing`), whose remaining changes do not touch `load_plugin_keys`. If the merged #240 differs from what a step describes, stop and tell the orchestrator rather than adapting the plan._

One PR, branch `claude/bot-ops-one-apply`, cut from `origin/main` **after #240 (PR #269) has merged**, in an isolated worktree. Commit this plan as `docs/plans/epics/E236/06-one-apply.md`. Files: `ops/bot-ops.sh`, `ops/bot-ops.test.ts`, one constant in `ops/admin/server.ts`, `CONTEXT.md`, `ops/README.md`. Cite tests by NAME when you search; line numbers moved with #240.

### What the premise rests on (verified on `main`, 2026-09-21)

- The bot fetches AND caches the Plugin Index unconditionally — at boot (`src/index.ts`, `loadPluginIndex(...)` runs before `config.plugins` is consulted) and on the ~15-minute `pluginUpdates` tick (`src/plugins/updates.ts` `checkPluginUpdates` → `loadIndex()` first) — so `/app/data/plugins/index.json` exists on an instance whose `PLUGINS` is empty, once the bot has booted with network. The first plugin on a fresh instance is therefore configurable from the cache; nothing in `src/` changes.
- The panel's tick boxes come from the PANEL's own fetch of `PLUGIN_INDEX_URL` (`/api/plugins`), while env keys come from this script reading the bot's cache. The two can disagree for up to ~15 minutes (a plugin the panel already lists whose keys the cache does not hold yet). Not fixed here; say it in the docs step, and #244's cards handle the "no settings known yet" state.

### Decided — not open for re-planning

- **`load_plugin_keys` stops looking at `PLUGINS` altogether.** Every plugin in the cached index contributes its keys. The early return for an empty `PLUGINS` goes, and with it the `none` status.
- **Everything else #240 built stays**: the separate secret set and its two passes ("secret anywhere is secret everywhere"), `RESERVED_KEYS`, static-wins, first-declaration-wins, the line-break and non-boolean-`secret` guards, "index unavailable" degrading to the static keys, the compose-syntax guard on every changed value.
- **The five-line row framing stays, and the fifth column changes meaning**: it no longer says "this plugin is in `PLUGINS`" but "this entry is usable" — `"true"` for a well-formed entry, `"false"` for the secret-only row that an unusable entry claiming `secret` emits (empty format; it marks its key secret and can never be edited or validated against). Rename the shell variable `enabled` → `usable` in both reader loops. Do NOT drop to four lines: an empty `format` is a legal well-formed value, so it cannot double as the marker.
- **Row shapes do not change.** `env-schema` rows stay `{pattern, required, source}` (+ `secret`, `isSet`); `env-get` stays a flat map. The panel learns which plugin owns a key from `/api/plugins`.
- **Cost, accepted and pinned by a test:** an instance with no plugins now makes one `docker exec … cat` of the cached index per `env-get` / `env-schema` / `env-set`, and the `plugins: index unavailable` stderr note now appears there too when the cache is missing. (The panel does not surface that note on a successful call today; a "Needs attention" entry for it belongs to #246, not here.)
- A key of a plugin that is off is inert until the plugin is on; it is still placed in the bot's environment by `env_file:`, exactly as any plugin key is today.

### Step 1 — `load_plugin_keys`

- Delete `plugins_val`, `[ -n "$plugins_val" ] || return 0`, `names_json`, the `--argjson names` argument and the `$on` line of the jq program. The program emits `"true"` as the fifth field of a well-formed entry and keeps `(.key, "", "false", "true", "false")` for the unusable secret claim.
- `PLUGIN_KEYS_STATUS` starts at `ok`; `index unavailable` is set exactly where it is today. Remove `none` from the variable's comment and from anything that tests for it (grep the script for `PLUGIN_KEYS_STATUS`).
- Pass 1 (secrets): `[ "$usable" = "true" ] || continue` replaces the `enabled` check, in the same position (after `PLUGIN_SECRET_ANY["$key"]=1`). Pass 2 (plain keys): DELETE the `enabled` check outright — an unusable row always carries `secret = "true"` and is skipped by the line below it, so a `usable` check there would be dead code.
- Rewrite every comment that now lies: the block above the arrays ("The env keys the INSTALLED plugins declare"), the `PLUGIN_KEYS_STATUS` comment, the function header ("restricted to the plugins named in this instance's own PLUGINS value", "No plugins enabled → returns immediately WITHOUT touching docker"), the `enabled` paragraph inside the function, `cmd_env_get`'s and `cmd_env_schema`'s "installed plugin" wording, and `cmd_env_set`'s paragraph ending "not in the same save that first adds the plugin" — it now says the opposite and why that is safe (the index, not `PLUGINS`, decides which keys are plugin keys; reserved keys stay reserved; an off plugin's key is inert).

### Step 2 — schema

`BOT_OPS_SCHEMA` 3 → 4 and `REQUIRED_BOT_OPS_SCHEMA` 3 → 4 in the same PR (`ops/admin/server.ts`); update the literal pins in `ops/bot-ops.test.ts` (`version` tests, the `=3` source regex). `server.test.ts`'s drift pin reads both files and needs no edit.

### Step 3 — tests (`ops/bot-ops.test.ts`)

New `describe("plugin settings do not wait for the plugin to be on (#256)")`, index offering `wow` and `music` (music: one plain key, one secret key):

- `with PLUGINS=wow, env-schema lists music's keys too, the secret one as secret + isSet`
- `with PLUGINS=wow, env-get lists music's plain key and never its secret one`
- `with PLUGINS empty, an index plugin's keys are still listed` (the first-plugin case)
- `one env-set call turns music on and sets its plain and its secret setting, with one recreate` — `.env` holds all three lines, `changed` names all three keys, `docker.log` has exactly one `up -d --force-recreate`
- `a key no index plugin declares is still refused`
- `a reserved key declared by a plugin that is off is never listed and still refused`
- `a bad value for an off plugin's key is refused naming the key, never the value`
- `an unusable entry that claims secret still marks its key secret and is still not editable` (the `usable` column's one job)
- `with no PLUGINS and no cached index, env-get is the static keys plus the index-unavailable note, after exactly one docker read`
- `version reports schema 4`

Existing tests whose pinned behaviour IS the thing under change — change exactly the named expectation in each, and list them in the PR:

| Test | What changes |
|---|---|
| `only the enabled plugin's non-secret keys appear, after the static ones, in manifest order` | rename; plugin `b`'s `B_ONE` is now listed: the tail is `["A_ONE", "A_TWO", "B_ONE"]` |
| `no PLUGINS set → no docker read at all, no note` | rename; now one `docker exec … cat` of the index and, with no cache, the note |
| `a key any plugin in the index declares secret is never listed as plain, but stays uneditable unless that plugin is enabled` | rename; the first half stands, the second half flips: it is editable (write-only) whichever plugin is on |
| `a secret key of a plugin that is not enabled is refused` | becomes "…is accepted, write-only"; add the refusal for a plugin ABSENT from the index |
| `the wow plugin's Blizzard client is not core: settable, write-only, listed nowhere but env-schema` | its last block ("with wow not enabled the same key is refused") now uses an index WITHOUT wow: the manifest is still the authority |
| every test that asserts `dockerCalls(...)` length or an empty stderr on an instance with no `PLUGINS` and no index fixture | +1 docker read and the note; find them by running the suite, change only that expectation |

Do not loosen anything else. `redaction also covers the stored secret of a plugin that is not enabled` must pass unchanged.

### Step 4 — docs

`ops/README.md` (the `env-get` / `env-set` / `env-schema` rows and the env section) and `CONTEXT.md` (the `load_plugin_keys` / `ALLOWED_SPEC` gotchas): a plugin's keys are listed and editable whether or not the plugin is on, and inert until it is; the cache-vs-panel-fetch gap above; the new docker read. **`CONTEXT.md`'s byte-compatibility sentence** (three outcomes since #240) loses its middle outcome: a plain key that another index plugin declares secret is now a secret row, write-only, whichever plugin is on. Verify every sentence against the merged script by running it.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| an off plugin's keys are in `env-schema` and `env-get`, reserved keys never | 1 | the first two new tests; `a reserved key declared by a plugin that is off…` | re-add a `PLUGINS` filter in the jq program; skip the `RESERVED_KEYS` check in one pass |
| the first plugin on a fresh instance | 1 | `with PLUGINS empty, an index plugin's keys are still listed` | restore the early return |
| turn on + settings + secret in one call, one recreate | 1 | `one env-set call turns music on…` | re-add the `PLUGINS` filter |
| still refuses what it should | 1 | `a key no index plugin declares…`; `a bad value for an off plugin's key…` | accept any key-shaped name; put `$val` in the `is invalid` message |
| an unusable secret claim stays uneditable | 1 | `an unusable entry that claims secret…` | drop the `usable` check in pass 1 |
| the new docker read is deliberate | 1 | `with no PLUGINS and no cached index…` | — (a pin of intended behaviour; its mutation is the early return above) |
| schema lockstep | 2 | `version reports schema 4` + `server.test.ts`'s drift pin | bump only one constant |

### Verification — paste the real output in the PR

```
bash -n ops/bot-ops.sh
shellcheck ops/bot-ops.sh        # if installed; say so if not
bun run check
bun run --cwd ops/admin check
bun test ops/bot-ops.test.ts --timeout 240000 -t "<the describes you touched>"
```

The full `ops/bot-ops.test.ts` is CI's on this box (say which cases ran locally and which only in CI). Mutation checks in a detached scratch worktree, one mutant at a time, each with the narrow `-t` filter of the tests meant to kill it. **Process guards (standing):** every command foreground with an explicit timeout; anything that reads stdin (`env-set`, `plugin-request`) gets a pipe or `</dev/null`; ONE `bot-ops.test.ts` run at a time, never parallel copies; a private temp dir per run (`TEMP`/`TMP` under `R:/repos/Scratch/tmp/bot-256`, create it first, #252); reviewers run nothing in the background, get a 45-minute budget and are stopped when their verdict is in; before reporting idle, list your processes by age and `taskkill /T /F` any leftover. Do not merge.

## Deviations from the plan

Recorded by the implementer. None widens or narrows what the plan decided; each is a wording, a test shape or a claim the plan could not know until the script was run.

1. **`CONTEXT.md`'s byte-compatibility sentence loses more than its middle outcome.** The plan said it "loses its middle outcome". Running it: the sentence's lead clause ("`env-get` output and every non-secret `env-schema` entry stay byte-identical") is itself no longer true once an off plugin's keys are listed. It now says the output keeps its shape, and its bytes for every key listed before, with three differences: `RESERVED_KEYS`; a plain key another index plugin declares secret (a secret row, editable, write-only, whichever plugin is on); and, new, the keys of a plugin that is not in `PLUGINS` are listed and editable.
2. **The `no PLUGINS set` test exists twice, by the plan's own list.** The plan renames the existing `no PLUGINS set → no docker read at all, no note` and also names a new `with no PLUGINS and no cached index, env-get is the static keys plus the index-unavailable note, after exactly one docker read`. Both are done (the first asserts the docker-call list and the note on `env-get`; the second, in the new describe, also asserts the static key count).
3. **`version reports schema 4` is the existing test, renamed** (`reports schema 4 (#256: …)`, with the two source and subprocess pins), not a second test in the new describe; every `{ schema: 3, composeSchema … }` literal became 4.
4. **The `usable` column is not CR-stripped in pass 2.** Both reader loops read five lines and both renamed `enabled` → `usable`, but pass 2 no longer tests the column (an unusable row always carries `secret = "true"` and is skipped by the line after it), so its CR-strip line would be dead code that no mutation could fail; the loop keeps a comment saying why the fifth line is read and not used. (A `usable` check re-added in pass 2 fails on this Windows box only because of that missing CR-strip: `jq.exe` emits CRLF. On Linux it is inert. It cannot be shown equivalent here.)
5. **The `changed` list of `env-set`, and the order in which new keys are appended to `.env`, are not in submission order.** Both come from iterating the `DIFF` associative array (`${!DIFF[@]}`), which is how `env-set` already worked (a submission in the order `PLUGINS`, `MUSIC_PORT`, `MUSIC_API_KEY` answered `["PLUGINS", "MUSIC_API_KEY", "MUSIC_PORT"]`). The one-call test asserts the set of three names and the set of appended lines, not their order.
6. **One test the plan did not list:** `the first declaration of a key in index order wins, whichever plugin is on`, because dropping the `enabled` filter changes which declaration is "first" when the first declarer is off.
7. **Existing tests changed, beyond the plan's table:** none. The plan's row "every test that asserts `dockerCalls(...)` length or an empty stderr on an instance with no `PLUGINS` and no index fixture" was five `env-set` tests whose expected docker-call list gains the index read (`a value that IS changing is still validated`, `a key outside the whitelist is refused up front`, `empty stdin`, `a chmod failure after .env is rewritten`, `the issue's literal case: blanking ANNOUNCE_CHANNEL_ID`).
8. **Docs beyond the plan's list:** the `ALLOWED_SPEC` `PLUGINS` comment, `BOT_OPS_SCHEMA`'s and `REQUIRED_BOT_OPS_SCHEMA`'s history comments, `env-get`'s and `env-set`'s "installed plugin" wording, and the `ops/README.md` panel paragraph ("each plugin's manifest keys") said "installed"/"enabled" and were corrected.
9. **Two files outside the plan's list were touched for wording only**, because each said "enabled" about the authority this change widens: the amendment to `docs/adr/0005-plugins-ship-their-own-admin-ui.md`, and one JS comment in `ops/admin/public/index.html` (the served page's bytes change by that comment; no code, and the panel is otherwise untouched, #244's).
10. **Review round 1 (two adversarial read-only reviewers on `60dd853`: A, hostile correctness and authority: SOUND; B, claims-vs-code and test quality: NOT SOUND, on false claims only; no behaviour defect found by either).** Reproduced, then: **(a)** a fourth difference the docs missed (both reviewers): the first declaration of a key in index order governs it whether its plugin is on or off, so an off plugin listed before an enabled one decides the enabled one's format and required-ness (old script: `^b+$` and accepted; new: `^a+$` and refused, for a fixture with `aaa` off before `bbb` on). It is the plan's "first declaration still wins" over a wider set, pinned by the extra test (deviation 6), and is now stated in `CONTEXT.md`, `ops/README.md` and the script header; the shipped index declares no key twice. **(b)** `RESERVED_KEYS` does not cover keys the bot core reads that are not credentials (`GITHUB_REPO`, `PLUGIN_REGISTRY_URL`, `BOT_DATA_DIR`, `NODE_ENV`; reviewer A, reproduced): an index entry naming one now makes it listable and editable with no plugin enabled, where before its plugin had to be in `PLUGINS`. **Declined in writing, and flagged to the orchestrator as its call:** it is #240's item 22 (declined there for the same reason: `RESERVED_KEYS` is a credential and interpolation denylist), the precondition is a hostile index entry, and whoever controls the index (a panel admin, via `PLUGIN_INDEX_URL`) can already make the bot run code (item 16). **Superseded by #278: the orchestrator reversed the call and these keys are now reserved** (with three more the core reads from its environment: `HANDOFF_FROM`, `HANDOFF_RESTART_POLICY`, `HOSTNAME`); `CONTEXT.md` and `ops/README.md` no longer say they are claimable. **(c)** stale "enabled" claims in the ADR-0005 amendment and the `index.html` comment: fixed (deviation 9). **(d)** the current panel renders a field for every key `env-get` returns, so once `install.sh` is re-run every indexed plugin's non-secret settings appear on the Settings tab until #244 lands; nothing blocks a save (only changed fields are sent and validated). Disclosed in the PR. **(e)** comments and two describe titles that still said "installed plugin" / "PLUGINS=wow" in `ops/bot-ops.test.ts`, and a dangling comment wrap in the script: fixed. **(f)** no test pinned `env-schema`'s extra read and note on an instance with no `PLUGINS`: added. **(g)** the PR's mutation table listed the early-return mutant twice; merged. Disclosed rather than changed: the new `docker exec … cat` has no timeout of its own (the panel bounds a `bot-ops` call at 90 s, `SUBPROCESS_TIMEOUT_MS`), and `env-schema` passes six arguments per key, which is irrelevant for the shipped three-plugin index (reviewer A measured 1800 keys: `env-get` about 22 s, `env-schema` "Argument list too long" on Windows Git Bash). The wording and test-name fixes need no further review round; there is no behaviour change.
