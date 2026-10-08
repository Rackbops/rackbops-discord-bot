<!-- Plan for Rackbops/rackbops-discord-bot#342 (Epic #332), written by the orchestrating session on
2026-10-07 against `main` @ `ac570af`. Every file:line below was read from that tree; the implementer
re-reads each one on the tree it works from and corrects any that moved. -->

## Implementation plan -- #342: `WATCHED_REPOS=none` switches the release watcher off

A behaviour change: the **three-reviewer gate** on the PR (you plus two read-only adversarial
reviewers with different lenses, up to four rounds, then report), every coverage row
mutation-tested in a scratch copy, real output pasted.

### Why, and the design decision taken

Today the core's release watcher can be pointed somewhere but never disabled: an empty
`WATCHED_REPOS` falls back to `GITHUB_REPO` (`src/config.ts:82-83`, `:149`), and `checkReleases`
walks `config.watchedRepos` every 15 minutes (`src/announce.ts:27`, `:384-395`). A plugin-only
instance such as Pip (`PLUGINS=mcp`) therefore polls GitHub for releases it never wants, and the
Pip runbook's "nothing to announce" rests on the watched repository publishing no releases -- a
fact, not a switch (Pip's Q3 objection and Rod's decision on #332, 2026-10-07).

**Decision: a sentinel value, `WATCHED_REPOS=none`, not a new key.** `WATCHED_REPOS` is already a
whitelisted, panel-edited key (`ops/bot-ops.sh:208`; its `FIELD_META` entry at
`ops/admin/public/index.html:3336` renders it through the chip editor `buildTagControl`,
`:3409-3472`) and already documented in `.env.example:19-21`, `README.md:15`,
`:33`, `CONTEXT.md:158` and `ops/README.md:228-236`; a new key would need a whitelist row, a
`RESERVED_KEYS` audit and a panel control of its own for the same one bit. Rules: exactly the
literal `none` (after trimming) means "watch nothing"; `none` mixed into a list is a configuration
error, refused at load by name; blank keeps today's fallback, so no existing instance changes
behaviour. `ANNOUNCE_CHANNEL_ID` stays required -- plugins post through it (`src/index.ts:171-200`).

### Step 1 -- `src/config.ts`

- After `const watchedRepos = list("WATCHED_REPOS");` (`:83`): read the raw value once,
  `const watchedRaw = (optional("WATCHED_REPOS") ?? "").trim();` and set
  `const releaseWatchOff = watchedRaw === "none";`. If `!releaseWatchOff && watchedRepos.includes("none")`,
  throw `WATCHED_REPOS is either "none" (release watcher off) or a comma-separated list of owner/repo, not both (got "<value>")`
  -- the same named-throw shape the file uses for `COMMAND_PREFIX` (`:88-93`).
- In the returned object (`:149`): `watchedRepos: releaseWatchOff ? [] : watchedRepos.length ? watchedRepos : [githubRepo]`.
  The sentinel must bypass the fallback explicitly; an empty list is what "off" means downstream.
- Update the `Config.watchedRepos` doc comment (`:7-9`): `[]` means the watcher is off
  (`WATCHED_REPOS=none`); blank still defaults to `[githubRepo]`.

### Step 2 -- `src/announce.ts`: a test seam and a boot line

- `checkReleases` (`:384-395`) becomes exported with injected deps, the file's own idiom
  (`commitReleaseAnnouncements`, `:437-441`):
  `export async function checkReleases(client: Client, repos: readonly string[] = config.watchedRepos, checkRepo: (repo: string) => Promise<void> = (repo) => checkRepoReleases(client, repo)): Promise<void>`
  -- body unchanged otherwise (stamp `lastReleasePollAt`, loop `repos`, per-repo try/catch). The
  `releases` tick check (`:217-222`) keeps calling it with the defaults. With `repos` empty the loop
  body never runs, so `fetchReleases` is never called -- that is the switch. It switches off
  **release polling only**: the bot still fetches the Plugin Index at boot (`src/index.ts:68`) and
  on the 15-minute `pluginUpdates` tick (`src/announce.ts:248-250`, `:303-308`; the default index
  URL is on raw.githubusercontent.com, `src/config.ts:117`), and self-update / `/update` call
  `api.github.com` when enabled or invoked (`src/update.ts:117`, `:150`). Never write "no GitHub
  requests" anywhere; write "no release polling".
- Add a pure `export function describeReleaseWatch(repos: readonly string[]): string` returning
  `[release] watcher off (WATCHED_REPOS=none)` for an empty list, else
  `[release] watching <n> repo(s): a/b, c/d`.
- `src/index.ts`: one line immediately before `startScheduler(...)` (`:313`):
  `console.log(describeReleaseWatch(config.watchedRepos));` (add the import at `:12`). This is the
  operator-visible proof in `docker logs` on every boot.

### Step 3 -- `ops/bot-ops.sh`: the whitelist row and the schema ratchet

- `ops/bot-ops.sh:208`: `'WATCHED_REPOS|^(none|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)*)$'`.
  Nothing else in the row's handling changes: a changed value is validated against this when it
  changes (`ops/README.md:388-401`), `env-get` round-trips it, `env-schema` emits it verbatim.
- **Bump `BOT_OPS_SCHEMA`** (`ops/bot-ops.sh:82`, currently 5; the rule is the comment at `:70`:
  bumped in the same PR as any `ALLOWED_SPEC` row change) to 6, and the hand mirror
  `REQUIRED_BOT_OPS_SCHEMA` at `ops/admin/server.ts:769` to 6. Extend both numbered history
  comments the way the #277 bump did (`ops/bot-ops.sh:76-81`, `ops/admin/server.ts:765-768`;
  precedent `docs/plans/epics/E236/12-recreate.md:66`): `6: WATCHED_REPOS accepts none (#342)`.
  The drift pin (`ops/admin/server.test.ts:2563-2569`) reads the script, so it passes exactly when
  both moved.
- **The bump also turns nine literal pins red** in `ops/bot-ops.test.ts`, which the earlier bumps
  edited each time (`docs/plans/epics/E236/05-bot-ops.md:62`, `E236/12-recreate.md:100`): the
  `readonly BOT_OPS_SCHEMA=5` regexes at `:1625` and `:1633`, `.toBe(5)` at `:1640`, and the
  `{ schema: 5, ... }` expectations at `:1660`, `:1673`, `:1686`, `:1697`, `:1705`, `:1713`, plus the
  two test names that say "schema 5" (`:1629`, `:1636`). Move every one to 6. They skip on a box
  without `jq`, so a missed one first shows on CI -- the PR is not ready until CI is green.
- `ops/admin/public/index.html:3336`: extend the `WATCHED_REPOS` hint: "... Empty falls back to just
  GITHUB_REPO; the single value `none` turns the release watcher off." The chip editor itself
  (`buildTagControl`, `:3409-3472`) needs no change: it does not validate tokens (`:3404-3408`). The
  Apply bar does validate the whole value client-side against the pattern `env-schema` serves
  (`validateEnvChanges` `:3697-3709`, `compilePattern` `:3682-3694`), so the panel accepts `none`
  only once the **deployed** `bot-ops.sh` serves the new regex -- which is why the rollout below
  re-runs `install.sh` before the panel is used for this.

### Step 4 -- docs, in the same PR

- `.env.example:19-21`: add "Set to `none` to turn release polling off (the bot then never asks
  GitHub for releases; plugins still post through ANNOUNCE_CHANNEL_ID, and the Plugin Index and
  self-update checks are unaffected)."
- `README.md:15` and `:33`: one clause each for `none`.
- `CONTEXT.md`: row `:158` (`src/config.ts`): the sentinel and the `[]` meaning; row `:168`
  (`src/announce.ts`): `checkReleases` is exported and takes `repos`/`checkRepo` with defaults, plus
  `describeReleaseWatch`; row `:169` (`src/config.test.ts`): the sentinel cases; row `:170`
  (`src/announce.test.ts`) currently says `checkReleases` "isn't exported" and is tested only through
  `runTick` -- rewrite it. The matching comment in `src/announce.test.ts:357-359` says the same and
  is rewritten in Step 5.
- `ops/README.md:228-236` (editable keys): `none` for `WATCHED_REPOS`.
- `ops/README.md` Pip section, three places that become false together once Pip runs with `none`,
  rewritten as a unit: the `ANNOUNCE_CHANNEL_ID` comment in the `.env` block (`:790-792`, "the one
  unsolicited core output that can exist (a release post ...) lands here" -> it is now only the
  plugins' default post target); the `WATCHED_REPOS` lines (`:804-805`) -> `WATCHED_REPOS=none` with
  a comment; the core-output table's release-watcher row (`:841`) -> "Nothing: the watcher is off
  (`watchedRepos` is `[]`, `checkReleases` loops nothing, boot logs `[release] watcher off`)" with
  the new cites; and the paragraph `:855-860` (the conclusion's "cannot occur while the watched
  repository publishes no releases" clause and the closing "If that is not acceptable, the way to
  close it is a small host change ... not a configuration trick" sentence) -> the watcher is off and
  the switch is this change. Section 9 (what the live run showed) is history and stays as written;
  add one line there that the switch landed afterwards (#342) and Pip now runs with it.

### Step 5 -- tests

| # | File / test name | Pins |
|---|---|---|
| 1 | `src/config.test.ts`: `WATCHED_REPOS=none turns the release watcher off: watchedRepos is empty` | `"none"` and `" none "` -> `[]`; `"NONE"` is not the sentinel (case-sensitive) and today's parser keeps it as a list entry `["NONE"]` -- pin that, so the switch is exactly the lowercase word |
| 2 | `src/config.test.ts`: `none mixed into a WATCHED_REPOS list is refused by name` | `"none,acme/thing"` and `"acme/thing, none"` throw, message names `WATCHED_REPOS` |
| 3 | `src/config.test.ts`: the existing default/parse/empty tests (`:61-84`) stay untouched and green | blank still `[githubRepo]` |
| 4 | `src/announce.test.ts`: `checkReleases with no repos makes no per-repo call` | `checkReleases(client, [], spy)`: spy never called, resolves without throwing. (`lastReleasePollAt` is module-private, `src/announce.ts:36`, with no getter; do not try to assert it -- `shouldPollReleases` takes both values as parameters, `:364-370`.) Also rewrite the comment at `src/announce.test.ts:357-359`, which says `checkReleases` is not exported |
| 5 | `src/announce.test.ts`: `checkReleases calls checkRepo once per repo and isolates a throwing one` | `["a/b","c/d"]`, first throws -> second still called; two calls total |
| 6 | `src/announce.test.ts`: `describeReleaseWatch: off line for [], watching line otherwise` | exact strings |
| 7 | `ops/bot-ops.test.ts`: `env-set accepts WATCHED_REPOS=none and env-get round-trips it` | mirror the shape of the existing changed-value validation test (`:1168`) for a core key |
| 8 | `ops/bot-ops.test.ts`: `env-set refuses none mixed with repos, naming WATCHED_REPOS` | `none,acme/thing` |
| 9 | `ops/bot-ops.test.ts` `:1242-1262` (scrapes `ALLOWED_SPEC`) and `ops/admin/server.test.ts:2563` (schema mirror) | pass without edits once step 3's two numbers moved; the nine literal `schema 5` pins step 3 lists are edited by hand; if anything else is red, a step was missed |

### Coverage table

| Acceptance bullet (#342) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| With the switch on, the release tick issues no fetch | 1, 2 | 1, 4 | keep the `[githubRepo]` fallback for `none`; or loop `config.watchedRepos` instead of `repos` |
| Default behaviour byte-identical | 1 | 3 | treat blank as off |
| `none` cannot be mixed into a list | 1 | 2 | drop the mixed-list throw |
| `env-set` accepts `none`, `env-get` round-trips | 3 | 7 | revert the regex |
| `env-set` refuses `none,owner/repo` | 3 | 8 | make the alternation `(none|...)` unanchored |
| Boot says which it is | 2 | 6 (+ the live log, manual) | return the "watching" line for `[]` |
| Schema ratchet moved together | 3 | 9 | bump only one of the two numbers; or leave one of the nine `schema 5` pins at 5 |
| Docs say how to turn it on | 4 | manual: the gate's claims reviewer reads each edited line | -- |

Run each mutation in a scratch copy (`git worktree add --detach`), never in the tree the tests or a
reviewer are reading; paste the red test's name per row in the PR.

### Checks, gate, PR

- `bun run check`, `bunx tsc --noEmit -p ops/tsconfig.json`, `bun run check` inside `ops/admin/`,
  `bun test` from the repo root. The `bot-ops.sh` tests need `bash` and `jq` (`ops/bot-ops.test.ts:43`;
  docker is a fake shim there) and skip on this Windows box because `jq` is not on its PATH; the
  three `flock` tests are CI-only (`:50`). Say so; CI's Linux runs them -- the PR is not ready until
  CI is green, and the nine schema pins in step 3 are exactly the kind of thing only CI will catch.
- Review gate: reviewer A on correctness and failure modes (the sentinel vs. the fallback; the
  mixed-list refusal; `checkReleases` defaults still wired by the tick; the schema ratchet);
  reviewer B on claims-vs-code, walking #342's acceptance bullets and every edited doc line against
  the merged tree. Both read-only. Fix or decline every evidenced finding in writing; re-run the
  gate on the whole merged state after a behaviour fix.
- PR title `feat(config): WATCHED_REPOS=none switches the release watcher off (#342)`; body with
  the pasted checks, the mutation rows, the gate's rounds, and the rollout note below. Do not merge.

### Rollout (operator, after the merge -- not the implementer's)

`bin/bot-ops.sh` is shared by every instance on nucbox, so re-running `install.sh` for any
instance moves the host to schema 6 and the prod and debug **admin panels** (built for 5; the
comparison is strict, `ops/admin/server.ts:386`) show the OUT OF DATE banner until their admin
images are rebuilt (`ops/README.md:105-136`; the rebuild is install.sh's printed step 4, as in
`docs/plans/epics/E236/13-deploy-and-prove.md` stage 2 -- that runbook's stage 1 still expects
"schema 5" at its `:63` and `:68`; the number it prints is whatever `main` carries). Order, on
nucbox:

```bash
curl -fsSL https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot/main/ops/install.sh | bash -s -- pip
```

```bash
echo 'WATCHED_REPOS=none' | BOT_OPS_CONFIG_DIR=/opt/rackbops-discord-bot/pip BOT_OPS_COMPOSE_FILE=/opt/stacks/rackbops-discord-bot-pip/docker-compose.yml BOT_OPS_PROJECT=rackbops-discord-bot-pip BOT_OPS_CONTAINER=rackbops-discord-bot-pip bash /opt/rackbops-discord-bot/bin/bot-ops.sh env-set
```

(one recreate; the `BOT_OPS_*` form is `ops/README.md:913-917`), then expect the boot line --
Pip logs JSON, so match the substring:

```bash
docker logs --since 2m rackbops-discord-bot-pip 2>&1 | grep -F '[release] watcher off (WATCHED_REPOS=none)'
```

Rebuild prod's and debug's panels in a window of Rod's choosing. The bots themselves are
unaffected by the schema number.

### Hand-off brief (spawn text)

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot (worktree from origin/main, branch feat/342-release-watcher-switch). Issue: Rackbops/rackbops-discord-bot#342.
Plan: docs/plans/epics/E332/05-release-watcher-switch.md (on main once its PR merges; until then on branch claude/342-watcher-switch-plan: git -C S:\Repos\rackbops-discord-bot show origin/claude/342-watcher-switch-plan:docs/plans/epics/E332/05-release-watcher-switch.md).
Behaviour change: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Mutation checks in a scratch worktree. Scratch files: task-unique names (pr-body-342.md, commit-msg-342.txt). Report the PR link, the pasted checks, the gate's rounds and any deviation.
```
