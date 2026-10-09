<!-- Plan for Rackbops/rackbops-discord-bot#430 (Epic #516), written by the orchestrating session on
2026-10-08 against `main` @ `ded55f5`. Every file:line below was read from that tree; the implementer
re-reads each one on the tree it works from and corrects any that moved. -->

## Implementation plan -- #430: a `PLUGINS` value `env-set` accepts must boot

A behaviour change (what `env-set` writes into `.env`): the **three-reviewer gate** on the PR (you
plus two read-only adversarial reviewers with different lenses, up to four rounds, then report),
every coverage row mutation-tested in a scratch copy, real output pasted.

### The defect, as probed on `ded55f5`

`env-set` validates a changed `PLUGINS` value with the whitelist row at `ops/bot-ops.sh:219`, whose
`@version` tail is `@[0-9][0-9A-Za-z.+-]*` (the comment at `:218` says it "allows any npm range
char"). The bot parses the same value in `resolveConfig` (`src/config.ts:105-124`): each token's
version must match `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` (`:114`), and one plugin named in two
different tokens throws `PLUGINS lists "<name>" more than once` (`:119-121`). `config` is resolved at
import (`:174`), so a throw kills the process at boot. `env-set` then recreates the container
(`recreate_bot`, `ops/bot-ops.sh:946-954`, called from `cmd_env_set`), and under
`restart: unless-stopped` (`docker-compose.yml:57`) the bot crash-loops until someone edits `.env`.

A probe that runs the row as a JS RegExp next to `resolveConfig` (scratch script, not committed)
printed, among others:

```
foo@1                    env-set=accept boot=refuse  <-- env-set accepts, boot rejects
foo@1.2                  env-set=accept boot=refuse  <-- env-set accepts, boot rejects
foo@1.x                  env-set=accept boot=refuse  <-- env-set accepts, boot rejects
foo@1.0.0+b              env-set=accept boot=refuse  <-- env-set accepts, boot rejects
foo@1.2.3+build.5        env-set=accept boot=refuse  <-- env-set accepts, boot rejects
foo@1.2.3-               env-set=accept boot=refuse  <-- env-set accepts, boot rejects
foo@1.2.3.4              env-set=accept boot=refuse  <-- env-set accepts, boot rejects
foo,foo@1.0.0            env-set=accept boot=refuse  <-- env-set accepts, boot rejects
foo@1.0.0,foo@2.0.0      env-set=accept boot=refuse  <-- env-set accepts, boot rejects
```

The last two are the same failure through a different rule (a repeated name), which the review did
not report; a regex cannot express "no name twice", so the row change alone would leave them open.

Reach: only `env-set` writes `PLUGINS` (no other `ops/` script touches it), from SSH or an
authenticated `POST /api/env`. The panel never authors a pin: `planPluginsSave`
(`ops/admin/public/index.html:3072-3092`) carries an existing token through verbatim and adds bare
names, and the Config editor skips the raw field (`:3628`).

### Decisions taken (defaults, named here so the gate can contest them)

1. **Tighten `bot-ops.sh` to the bot's exact rule; do not loosen `config.ts`.** The bot is the
   authority on what boots, a pin names one exact version to install (`sp.pinnedVersion` is the
   version tried, `src/plugins/install.ts:319-322`), and the issue's suggested fix says the same.
2. **The repeated-name case is in scope**, for the reason above: #430's failure is "env-set accepts
   a `PLUGINS` value the bot refuses at boot", and `foo,foo@1.0.0` is one.
3. **`env-set` stays stricter where that is safe.** `resolveConfig` trims tokens and drops empty ones
   (`list()`, `src/config.ts:70-77`), so it boots `" foo , bar "` and `foo,,bar`; the row refuses
   both today and keeps refusing them. The invariant is one-directional where it must be (env-set
   accepts => the bot boots) and exact on canonical values (no whitespace, no empty token).
4. **Bump `BOT_OPS_SCHEMA` 6 -> 7.** The rule is the comment at `ops/bot-ops.sh:70`: bumped in the
   same PR as any `ALLOWED_SPEC` row change. The cost is the rollout note at the end.
5. **Not generalized to every key.** The other static rows that `config.ts` also validates
   (`WATCHED_REPOS`, `COMMAND_PREFIX`, `PLUGIN_INDEX_URL`) were read against `src/config.ts:84-132`
   and are equal or stricter; `ANNOUNCE_CHANNEL_ID`'s boot check (`required()`, `:79`) is matched by
   `REQUIRED` (`ops/bot-ops.sh:251-253`). This is the class's first occurrence in the epic, so the
   drift test stays `PLUGINS`-specific.

### Step 1 -- `ops/bot-ops.sh`: the row, the comment, the repeated-name check

- Replace the row at `:219` with:

  ```
  'PLUGINS|^[a-z][a-z0-9-]*(@[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)?(,[a-z][a-z0-9-]*(@[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)?)*$'
  ```

  It is `config.ts:114`'s version rule in ERE (`\d` -> `[0-9]`) inside the same name/list shell.
  It contains no `|`, so the first-`|` split in `build_allowed_from_spec` (`:234-240`) is unaffected,
  and it compiles unchanged as a JS RegExp for the panel's client-side check (`compilePattern`,
  `ops/admin/public/index.html:3682-3694`).
- Rewrite the tail of the comment at `:218` (from "the `@version` tail allows any npm range char")
  to: "the `@version` tail is exactly what `resolveConfig` accepts (`src/config.ts:114`: x.y.z with
  an optional `-prerelease`, no `+build`), and one plugin may not appear in two different tokens
  (`plugins_name_repeated`, #430), since the bot refuses either at boot and `env-set` would
  otherwise recreate it into a crash loop."
- Add this function immediately above `cmd_env_set()` (`:956`, after `recreate_bot`):

  ```bash
  # #430: true when a PLUGINS value names one plugin in two different tokens ("foo,foo@1.0.0",
  # "foo@1.0.0,foo@2.0.0"). The bot refuses that at boot (src/config.ts:119-121) and no ERE can
  # say it. An exact repeat ("foo,foo") is not one: config.ts's list() drops repeated tokens first
  # (src/config.ts:70-77), so it boots, and env-set accepts it too. Only ever called on a value the
  # PLUGINS row already matched, so every token is non-empty and holds no glob character.
  plugins_name_repeated() {
    local -A seen_tok=() seen_name=()
    local -a toks
    local tok name
    IFS=, read -ra toks <<<"$1"
    for tok in "${toks[@]}"; do
      [[ -z "${seen_tok[$tok]+x}" ]] || continue
      seen_tok["$tok"]=1
      name="${tok%%@*}"
      [[ -z "${seen_name[$name]+x}" ]] || return 0
      seen_name["$name"]=1
    done
    return 1
  }
  ```

  Each test in the loop is written `[[ -z ... ]] || ...` so that a false test is never the last
  command of the body under `set -e` (`:68`). The orchestrator ran this function and the new row
  through `[[ =~ ]]` under `set -euo pipefail` (Git Bash 5.3.15 on MILE, scratch script) over the
  24-value corpus in step 3: it accepted the same 10 values `resolveConfig` boots and refused the
  other 14 (11 by the row, the 3 repeated-name values by the function). Linux bash on CI is the
  check that counts; T3 runs there.
- In `cmd_env_set`'s format check (`:1066-1070`), add one arm after the regex arm:

  ```bash
      elif [[ ! "$val" =~ $fmt ]]; then
        die "env-set: value for '$key' is invalid"
      elif [ "$key" = PLUGINS ] && plugins_name_repeated "$val"; then
        die "env-set: value for 'PLUGINS' names a plugin more than once"
      fi
  ```

  It sits inside the changed-only path, so #44's rule holds: a stored value echoed back unchanged
  is not re-validated (`:64-67`). The message names the key and not the value, the convention the
  CR check states (`:1038-1042`). `PLUGINS` always takes the static-`ALLOWED` branch (`:1056`
  is tested first; a plain manifest key named `PLUGINS` can still land in `PLUGIN_FORMAT`, since
  the plain pass `:598-605` has no `ALLOWED` check, but env-get `:713` and env-schema `:760` drop
  it and env-set never reaches its format). The `[ "$key" = PLUGINS ]` guard is what keeps the walk
  off every other key: `PLUGIN_INDEX_URL=/opt/p@1,/opt/p@2` matches its own row (`:222`) and would
  otherwise be refused as a repeated "name" (T4 pins this).
- **Schema:** `readonly BOT_OPS_SCHEMA=7` (`:83`), and a history line after `:82`:
  `# 7: PLUGINS accepts only what the bot boots: an exact x.y.z(-pre) pin, one name per plugin (#430).`

### Step 2 -- `ops/admin/server.ts`: the mirror

- `REQUIRED_BOT_OPS_SCHEMA` (`:770`) -> `7`, and extend the history in the doc comment (`:765-769`):
  ` *  7 = PLUGINS accepts only what the bot boots (#430). */`. The drift pin
  (`ops/admin/server.test.ts:2563-2570`) reads the script, so it passes exactly when both moved.

### Step 3 -- tests (`ops/bot-ops.test.ts`)

One shared corpus, declared once at module scope next to the #342 source pins (`:343-362`), with
`resolveConfig` imported from `../src/config` (the file already imports `../src/routing/model`,
`:14`; the bunfig preload primes `DISCORD_TOKEN`/`ANNOUNCE_CHANNEL_ID` for every test file,
`test/setup.ts:71-72`, so the import's own `resolveConfig(process.env)` does not throw):

```ts
// #430: canonical PLUGINS values (no whitespace, no empty token -- env-set refuses those on purpose,
// resolveConfig trims them) on which env-set and the bot must agree exactly.
const PLUGINS_CORPUS = [
  "foo", "foo,bar", "a-b,c@0.0.0-rc.1", "foo@1.2.3", "foo@1.2.3-beta.1", "foo@1.2.3-a-b", "foo@01.2.3",
  "foo,foo", "foo@1.0.0,foo@1.0.0", "warbandeer,wow,music",
  "foo@1", "foo@1.2", "foo@1.x", "foo@1.0.0+b", "foo@1.2.3+build.5", "foo@1.2.3-", "foo@1.2.3.4",
  "foo@v1.2.3", "foo@", "Foo", "1foo",
  "foo,foo@1.0.0", "foo@1.0.0,foo@2.0.0", "foo@1.0.0,bar,foo",
];
const bootAccepts = (plugins: string): boolean => {
  try {
    resolveConfig({ DISCORD_TOKEN: "x", ANNOUNCE_CHANNEL_ID: "11111", PLUGINS: plugins });
    return true;
  } catch {
    return false;
  }
};
/** Values naming one plugin in two different tokens: the PLUGINS row matches them, so only the bash
 *  check refuses them (T3/T4). The same walk as plugins_name_repeated: skip an exact repeat token. */
const repeatsAName = (v: string): boolean => {
  const tokens = new Set<string>();
  const names = new Set<string>();
  for (const tok of v.split(",")) {
    if (tokens.has(tok)) continue;
    tokens.add(tok);
    const name = tok.split("@")[0]!;
    if (names.has(name)) return true;
    names.add(name);
  }
  return false;
};
```

| # | Test (describe / name) | Runs where | Pins |
|---|---|---|---|
| T1 | new `describe("bot-ops.sh PLUGINS row agrees with what the bot boots (#430, source pins)")` / `"the PLUGINS row accepts a value with no repeated name exactly when resolveConfig does"` | everywhere (no bash/jq) | extract the row like `:347` (`/^\s*'PLUGINS\|(.*)'\s*$/m`); for every corpus value with `!repeatsAName(v)`: `expect(new RegExp(row).test(v), v).toBe(bootAccepts(v))`. Also assert the filtered corpus holds at least one accept and one refuse, so a `bootAccepts` that always throws cannot pass it vacuously |
| T2 | same describe / `"BOT_OPS_SCHEMA is 7 with its #430 history line"` | everywhere | `/^readonly BOT_OPS_SCHEMA=7$/m` and the exact `# 7: ...` line from step 1 |
| T3 | `describe.skipIf(!runnable)` block at `:1132` / new `"env-set accepts a PLUGINS value exactly when the bot boots it (#430)"` (use `LONG`, `:21`) | bash + jq (MILE and CI) | for every corpus value, a fresh `setup("PLUGINS=warbandeer\n")`, then `env-set` with `PLUGINS=<v>`. Boot accepts: exit 0, `changed: ["PLUGINS"]`. Boot refuses: ONE combined assertion, so a mutation that lets the value through shows all three facts at once instead of stopping at the exit code (Bun's `expect` throws on its first failure): `expect({ exit: run.exitCode, env: envText(fx), recreated: dockerCalls(fx).some((c) => c.includes("up -d --force-recreate")) }, v).toEqual({ exit: 1, env: "PLUGINS=warbandeer\n", recreated: false })` (the `dockerCalls` idiom is `:3625`'s) |
| T4 | same block / `"env-set refuses one plugin named in two tokens, naming PLUGINS, and only for PLUGINS (#430)"` | bash + jq | `foo,foo@1.0.0` -> stderr contains exactly `value for 'PLUGINS' names a plugin more than once`; `foo,foo` -> exit 0; and on a `setup("ANNOUNCE_CHANNEL_ID=11111\n")` fixture, `PLUGIN_INDEX_URL=/opt/p@1,/opt/p@2` -> exit 0 (it matches its own row, `ops/bot-ops.sh:222`; pins the `[ "$key" = PLUGINS ]` guard). Feed values on stdin as the other env-set tests do: MSYS bash reads an argv entry starting with `@` as a response file |
| T5 | existing `:1133` test: add `"foo@1.2"` and `"foo@1.0.0+b"` to its `bad` list (`:1140`) | bash + jq | the issue's own named cases, beside the shape cases already there |
| T6 | the #342 source pin `:358-361`: rename to `"the #342 history line stays"`, keep only the `# 6:` assertion (`:360`); T2 now owns the live number | everywhere | -- |
| T7 | the schema literals the bump turns red: `:1663`, `:1671`, `:1678`, `:1698`, `:1711`, `:1724`, `:1735`, `:1743`, `:1751` (`6` -> `7`), and the two names `:1667` -> `"(schema 7, #430)"`, `:1674` -> `"version reports schema 7 (#430: PLUGINS pins match the bot)"` | bash + jq | all of them sit in `describe.skipIf(!runnable)("bot-ops.sh version (issue #173)")` (`:1655`), so they skip on a box without jq; T2 makes the same `=7` assertion everywhere |

`src/config.test.ts` needs no change: its PLUGINS cases (`:271-306`) already pin `resolveConfig`'s
side, and T1 pairs the two.

### Step 4 -- docs, in the same PR

- `ops/README.md:230-235` (editable keys): after `PLUGINS` add, in the style of the `WATCHED_REPOS`
  parenthesis on `:231`: "(comma-separated plugin names with no spaces, each optionally pinned as
  `name@x.y.z` or `name@x.y.z-pre`; one plugin may not appear in two different tokens, though an
  exact repeat such as `foo,foo` is accepted because the bot drops it. Every value accepted here
  boots; the bot also tolerates spaces and empty tokens, which this check refuses)".
- `.env.example:47`: "optionally name@version to pin a version" -> "optionally name@x.y.z (or
  x.y.z-prerelease) to pin an exact version, each plugin at most once". A hand edit of `.env`
  bypasses `env-set`, so this is the only guard for that path.
- `CONTEXT.md`: the `ops/bot-ops.sh` row (`:197`, "`PLUGINS`/`PLUGIN_INDEX_URL` are whitelisted
  too") gains: "`PLUGINS` accepts a subset of what `resolveConfig` boots: `x.y.z(-pre)` pins, no
  spaces or empty tokens, and no plugin in two different tokens (`plugins_name_repeated`; an exact
  repeat such as `foo,foo` is accepted, since the bot drops it; #430)". The `ops/bot-ops.test.ts` row (`:198`, which
  lists the `PLUGINS`/`PLUGIN_INDEX_URL` whitelist forms) gains the #430 pairing tests. Grep the row
  on a short unique substring and anchor the Edit on it; do not Read the long row by line range.

### Coverage table

#430 has no `## Acceptance` section; these are the observable outcomes it demands.

| Outcome | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| env-set refuses each version shape the bot refuses (`1`, `1.2`, `1.x`, `+build`, trailing `-`, four parts) | 1 | T1; T3, T5 | M1: revert the row to `@[0-9][0-9A-Za-z.+-]*`. M2: loosen the core to `[0-9]+(\.[0-9]+){0,2}` |
| env-set still accepts every canonical value the bot boots (prerelease, leading zero, exact repeat) | 1 | T1; T3 | M3: drop the `(-[0-9A-Za-z.-]+)?` group from both halves of the row |
| env-set refuses one plugin named in two tokens, and accepts an exact repeat | 1 | T3, T4 | M4: delete the `elif ... plugins_name_repeated` arm. M5: delete the `seen_tok` skip, so `foo,foo` is refused |
| a refusal leaves `.env` untouched and recreates nothing | 1 | T3 | M4 again: with the arm gone, `foo,foo@1.0.0` is written and recreated, and T3's combined assertion reports `exit`, `env` and `recreated` all wrong in one diff (paste it) |
| the repeated-name check runs for `PLUGINS` only | 1 | T4 | M6: delete `[ "$key" = PLUGINS ] && ` from the new arm, so `PLUGIN_INDEX_URL=/opt/p@1,/opt/p@2` is refused |
| the two validators cannot drift apart unnoticed | 1, 3 | T1 | M7: change `src/config.ts:114` to accept `\d+\.\d+` (config side moved alone) |
| schema ratchet moved together | 1, 2 | T2, T7, `server.test.ts:2563` | M8: bump only `BOT_OPS_SCHEMA`. M9: leave `:1663` at 6 |
| the docs say what is accepted | 4 | manual: the claims reviewer reads each edited line against the code | -- |

**Where the mutations can run.** T1, T2 and `server.test.ts:2563` run on any box. T3, T4, T5 and
T7 need `bash` and `jq` (`ops/bot-ops.test.ts:41-46`). Rod installed `jq` 1.8.2 on MILE on
2026-10-08 (`winget install jqlang.jq`; `C:\Users\Rod\AppData\Local\Microsoft\WinGet\Links\jq.exe`,
visible from both Git Bash and PowerShell), so they run locally and every mutation, M4, M5, M6 and
M9 included, runs in the scratch worktree like the rest. First confirm the suite does not print
`[bot-ops.test] SKIPPING` (`:44-46`): if it does, `jq` is not on that session's PATH, and that is a
setup problem to report, not a reason to skip the jq-only mutations. The three `flock` tests stay
CI-only (`:47-53`). Baseline on `main` @ ded55f5 with that `jq` (orchestrator, 2026-10-08):
`bun test ops/bot-ops.test.ts` -> `213 pass, 3 skip, 0 fail ... [398.05s]`, no SKIPPING line. At
~400 s a file, filter each mutation run to the test(s) its row names with `bun test
ops/bot-ops.test.ts -t "<name>"`, and run the whole file once on the final tree. Linux bash on CI remains the check that counts for glibc ERE: the PR is not
ready until CI is green.

Run every local mutation in a scratch copy (`git worktree add --detach <path> <sha>`), never in the
tree the tests or a reviewer are reading; paste the red test's name per row in the PR.

### Checks, gate, PR

- `bun run check`; `bunx tsc --noEmit -p ops/tsconfig.json` (the new `../src/config` import is
  type-checked there); `bun run check` inside `ops/admin/`; `bun test` from the repo root. With
  `jq` now on MILE the bot-ops subprocess tests run there; only the three `flock` tests are
  CI-only (`:47-53`). Say so in the PR. The PR is not ready until CI is green.
- Review gate: reviewer A on correctness and failure modes (the ERE in bash vs the JS regex in T1;
  `set -euo pipefail` inside `plugins_name_repeated`; the changed-only rule of #44; the exact-repeat
  case; the panel's client-side check compiling the new pattern); reviewer B on claims-vs-code,
  walking the coverage table's outcomes and every edited comment and doc line against the merged
  tree. Both read-only, both handed the merged tree and #430. Fix or decline every evidenced finding
  in writing; re-run the gate on the whole merged state after a behaviour fix.
- Branch `fix/430-plugins-pin-semver`; commit and PR title
  `fix(ops): env-set refuses PLUGINS values the bot refuses at boot (#430)`. Body: `Closes #430` on
  its own line, the pasted checks, the mutation rows (local and CI), the gate's rounds, decisions 2
  and 3 above named as assumptions taken, and the rollout note below. Do not merge.

### Rollout (operator, after the merge -- not the implementer's)

Nothing in the bot's image changes (`src/` is untouched), so no bot rebuild. `bin/bot-ops.sh` is
shared by every instance on nucbox; re-running `install.sh` for any one instance moves the host to
schema 7. The panel compares strictly (`got !== required`, `ops/admin/server.ts:386`) but only at
its own startup (`:2213`), so a panel built for 6 that is already running shows nothing until it
restarts, and then shows the OUT OF DATE banner (`ops/README.md:105-129`; it keeps serving,
`:126-128`). In this direction the banner's advice, "re-run ops/install.sh"
(`ops/admin/public/index.html:3172`), is wrong: the fix is rebuilding that panel's admin image from
the same merge. Until the shared script is refreshed, the deployed `env-set` keeps accepting the
loose pins.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot (new worktree from origin/main, branch fix/430-plugins-pin-semver). Issue: Rackbops/rackbops-discord-bot#430 (Epic #516).
Plan: docs/plans/epics/E516/430-plugins-pin.md on branch claude/430-plan: git -C S:\Repos\rackbops-discord-bot show origin/claude/430-plan:docs/plans/epics/E516/430-plugins-pin.md
Behaviour change: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Mutation checks in a scratch worktree, all nine locally (jq is installed on MILE; if bot-ops.test.ts prints SKIPPING, stop and report the PATH problem). Scratch files: task-unique names (pr-body-430.md, commit-msg-430.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds and any deviation. Do not merge.
```
