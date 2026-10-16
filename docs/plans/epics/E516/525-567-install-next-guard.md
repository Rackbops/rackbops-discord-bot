<!-- Plan for #567 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #525): the install-time guard for an instance
name ending in `-next`. Written by the orchestrating session on 2026-10-16 against `main` @ `8b23559` (S3b-2 merged,
which documented the limit this closes; the anchors are unchanged at `146fdc5`); audited read-only before it was
committed (round 1: two blockers applied -- the new call in `main()` sits inside the slice four existing branch-gate
tests run with every other function stubbed, so it needs a stub there too; and the `*-next` -> `*next` mutant was not
killed by the names listed -- plus the messages were false for the bare name `next`, the `${PROJECT%-next}` strip was
unguarded, four README line citations into `install.sh` shift, and seven doc sentences need rewording; a reverse check,
a new `X` beside a legacy `X-next`, was added as a warning; round 2: no blocker -- four wrapped doc sentences now carry
per-line anchors, the reverse warning made `redeploy.ts:1142-1143` false and is reworded, two replacements read wrongly
in place, the citation shift is +25). Every file:line below was read from that tree; the
implementer re-reads each one on the tree it works from and corrects any that moved. Its own PR, after S4b (same sub,
different files: this touches `ops/install.sh`, `ops/install.test.ts` and doc sentences). -->

## Implementation plan -- #567: `ops/install.sh` refuses a new instance named `next` or `*-next`, warns on a re-run, and warns when a new instance has a legacy `-next` sibling

Child: **#567** (XS; closes it). One PR, branch `fix/567-install-next-guard`, worktree `S:\Repos\_wt\rdb-567` cut from
`origin/main`. A behaviour change in the ops layer -> the **three-reviewer gate** applies.

### What is wrong, verified at `8b23559` / `146fdc5`

`ops/install.sh`'s `main()` (`:213`) accepts any instance name matching `^[a-z0-9-]+$` (`:232`) except `bin`
(`:233`). It derives `CONFIG_DIR=/opt/rackbops-discord-bot/$INSTANCE`, `STACK_DIR=/opt/stacks/rackbops-discord-bot-$INSTANCE`
and `PROJECT=rackbops-discord-bot-$INSTANCE` (`:251-254`), creates the dirs (`:256-258`) and names the container after
the project (`BOT_OPS_CONTAINER=$PROJECT`, written to the stack `.env` later in the script). A self-update names its
replacement `<container>-next` (`src/redeploy.ts`, `replacementName`), and `ops/bot-ops.sh`'s swap guard keys on that
name (S3b-1). So instance `prod-next` owns the container name instance `prod`'s swap creates; the two cannot share a
daemon. The bare name `next` owns `rackbops-discord-bot-next`, the standby name of a container called
`rackbops-discord-bot`, which no `install.sh` instance can have (only a compose-only deployment could); it is refused
by the same rule, as the issue asks, and `src/redeploy.ts:78-81` says such a legacy instance still self-updates (into
`<name>-next-next`). S3b-2 documented the collision in `docker-compose.yml`, `ops/README.md`, `CONTEXT.md` and
`healOwnName`'s docstring, each naming this issue as the future guard. `die()` is `:78`: `echo "install: $*" >&2; exit 1`.
`ops/install.test.ts` tests functions extracted by name from the live script (`extractFunction`, `:18-24`: a
top-level `name() {` … `^}`), run in a bash subprocess with a hand-written `die()` (`:65-73`, `:81-95`), skipped
loudly without bash (`:37-54`, `:97`). Its branch-gate tests (#232, #295) run a SLICE of `main()`
(`BRANCH_GUARD_TO_FETCH`, `:617-620`: from `INSTANCE="${1:-}"` to `install_shared_bin`) through `runBranchGate`
(`:636-652`), which stubs every function that slice calls (`need`, `resolve_deploy_identity`, `bootstrap_dir`,
`fetch`, …); a new call inside the slice without a stub there exits 127 in four of them.

### Decisions

1. **A named function, `check_instance_name()`**, so the test can extract it; called in `main()` right after
   `PROJECT=` (`:254`) and before the first `bootstrap_dir` (`:256`): the paths it needs exist as variables, and
   nothing has been created when it refuses (`need` only checks `command -v`; `resolve_deploy_identity` only sets
   `DEPLOY_UID`/`DEPLOY_GID` or dies; the first write is `bootstrap_dir`).
2. **A NEW `next`/`*-next` install dies; a re-run warns.** "Existing" = `CONFIG_DIR` or `STACK_DIR` already present
   (a refused install creates nothing, so only a pre-guard instance can reach the warn path). The messages name the
   CONTAINER (`$PROJECT`), which is what ends in `-next`, and the warning names the container the name collides
   with (`${PROJECT%-next}`: `rackbops-discord-bot-prod` for `prod-next`, `rackbops-discord-bot` for `next`).
3. **The reverse case warns:** a new instance `X` whose sibling `X-next` already exists (`"${CONFIG_DIR}-next"` or
   `"${STACK_DIR}-next"` present) gets a warning naming the sibling and continues -- the legacy instance is the
   operator's, and `X`'s swaps will collide with it until one is renamed.
4. **Only the suffix** (`next` or `*-next`); `nextgen`, `prodnext` and `next-prod` are fine.

### Step 1 -- `ops/install.sh`

After `resolve_deploy_identity()`'s definition (Grep `^resolve_deploy_identity\(\) \{` and its closing `^}`), add:

```bash
# #567: `<container>-next` is the name a self-update gives its replacement (src/redeploy.ts, replacementName), and
# bot-ops.sh's swap guard keys on it. An instance called `prod-next` owns the very container name instance `prod`'s
# swap creates, so the two cannot share a daemon; the bare name `next` is refused by the same rule (its container,
# rackbops-discord-bot-next, could only collide with a compose-only deployment named rackbops-discord-bot). A NEW
# install refuses; a re-run on an instance that already exists only warns, because a re-run must never take a
# deployed instance down. The reverse -- a new `prod` beside a legacy `prod-next` -- warns too and continues.
check_instance_name() {
  case "$INSTANCE" in
    next|*-next)
      if [ -d "$CONFIG_DIR" ] || [ -d "$STACK_DIR" ]; then
        echo "install: WARNING: the container '$PROJECT' ends in -next, the suffix a self-update reserves for its replacement; this existing instance is not refused, but it cannot share a daemon with an instance whose container is '${PROJECT%-next}' (#567)" >&2
      else
        die "the container for instance '$INSTANCE' would be '$PROJECT', which ends in -next, the suffix the self-update reserves for its replacement (<container>-next); pick another name (#567)"
      fi
      ;;
    *)
      if [ -d "${CONFIG_DIR}-next" ] || [ -d "${STACK_DIR}-next" ]; then
        echo "install: WARNING: an instance '${INSTANCE}-next' already exists on this host; its container is the name the self-update of '$PROJECT' gives its replacement, so the two cannot share a daemon until one is renamed (#567)" >&2
      fi
      ;;
  esac
}
```

In `main()`, after `PROJECT="rackbops-discord-bot-$INSTANCE"` (`:254`) and before `bootstrap_dir "$CONFIG_DIR"`
(`:256`), on its own line with two-space indentation: `check_instance_name`.

### Step 2 -- docs

2a. The sentences S3b-2 wrote about the future guard, each reworded to the present (a legacy `*-next` instance keeps
working; `install.sh` refuses a new one, warns on a re-run, and warns a new `X` beside a legacy `X-next`):
- `docker-compose.yml:33` ("An ops/install.sh instance called `next` or `canary-next` is the exception") -> "An
  ops/install.sh instance installed before #567 with a name like `next` or `canary-next` is the exception"; and
  `:35-36` ("(instances `prod` and `prod-next` cannot share a daemon; an install-time guard is #567)") -> "(instances
  `prod` and `prod-next` cannot share a daemon; `ops/install.sh` refuses a new `*-next` instance and warns on a re-run
  or on a new sibling, #567)".
- `ops/README.md:454-455` -- the sentence WRAPS: `:454` ends `An install.sh instance whose` and `:455` begins
  `name ends in `-next` (`install.sh next`, `canary-next`) keeps it:` (then "the bot knows its own name…"). Edit both
  lines so the sentence reads "An install.sh instance installed before #567 with a name ending in `-next`
  (`canary-next`) keeps it (a new one is refused): the bot knows its own name…" -- keep the colon's original role.
  `:457-458` -- wraps after `cannot`: `:457` ends `instances `prod` and `prod-next` cannot` and `:458` begins
  `share a daemon, #567)`; make it "… cannot share a daemon; `install.sh` refuses a new `prod-next` and warns a new
  `prod` beside a legacy `prod-next`, #567)". `:459-460` -- wraps after `install-time`: `:459` ends `(an install-time`
  and `:460` begins `guard against `-next` instance names is #567)`; this sentence is about a compose-only deployment,
  which never runs `install.sh`, so make it "(`install.sh`'s guard, #567, does not reach a compose-only deployment)".
- `ops/README.md:140-141` ("`debug`, `prod`, or any other name") -> "`debug`, `prod`, or any other lowercase name
  that is not `bin`, `next` or `*-next`"; and after the usage paragraph ending at `:153` add one sentence: "`bin`, and
  any name that is `next` or ends in `-next`, is refused for a new instance (#567: `-next` is the suffix a
  self-update gives its replacement container); a re-run on an existing instance of that shape only warns, as does a
  new instance whose `-next` sibling already exists."
- `CONTEXT.md:192` (one long row; anchor on the exact substring) "(`healOwnName`'s docstring lists all three; the
  install-time guard against `-next` instance names is #567)" -> "(`healOwnName`'s docstring lists all three;
  `ops/install.sh`'s `check_instance_name` refuses a new `*-next` instance and warns on a re-run or a new sibling,
  #567)"; in the same row, "a `-next` one included" -> "a pre-#567 `-next` one included". `:873` WRAPS after `keeps
  its`: `:873` ends `so an install.sh instance called `next` or `canary-next` keeps its` and `:874` begins `own name`;
  make it "so an install.sh instance installed before #567 with a name like `canary-next` keeps its own name (a new
  one is refused)".
- `src/redeploy.ts:1140-1141` ("a `-next` one included") -> "a pre-#567 `-next` one included"; `:1142-1143` ("none
  reachable through a new install.sh instance") -> "the first two not reachable through a new install.sh instance,
  the third only beside a pre-#567 `X-next`, which install.sh warns about"; `:1148-1149` ("instances `X` and `X-next`
  on one daemon are not told apart … (#567 refuses to install the second)") -> "… are not told apart by the sweep or
  by `bot-ops.sh`'s guard (#567: `install.sh` refuses a new `X-next` and warns a new `X` beside a legacy `X-next`;
  two pre-#567 instances are not detected)".
  Grep each file for `#567` and for `-next` instance phrasing after editing: nothing may still call the guard future.
2b. Four `ops/README.md` citations into `install.sh` shift by the lines Step 1 inserts (the audit measured +25 with the
function as written above -- 22 lines with its comment, a blank, the call and its blank): `ops/README.md:215`
(`ops/install.sh:320`, the `BOT_BUILD_CONTEXT` line -> `:345`), `:835` (`:269-273`, the `ADMIN_TOKEN` block ->
`:294-298`), `:974` (`:269-270` -> `:294-295`) and `:989` (`:357-359`, the `docker inspect` lines -> `:382-384`).
After the edit, find each landmark's new line in the patched `install.sh` and re-point the citation to it; the
numbers above are what the audit measured, not a substitute for looking.

### Step 3 -- `ops/install.test.ts`

- Line `:10`: add `mkdirSync` to the `node:fs` import (the `ops/` typecheck, not the root one, catches its absence).
- Beside `RESOLVE_DEPLOY_IDENTITY` (`:35`): `const CHECK_INSTANCE_NAME = extractFunction("check_instance_name");`.
- In `runBranchGate` (`:636-652`), after the `resolve_deploy_identity() {...}` stub (`:641`), add the line
  `"check_instance_name() { :; }",` -- without it the four #232/#295 branch-gate tests ("a valid branch passes the
  guard and reaches the bot-ops.sh fetch", "a valid non-trivial branch (slashes, digits, hyphens) is accepted too",
  "main --force-bin (branch given) still reaches install_shared_bin, with FORCE_BIN=1", "a plain branch with no third
  argument is unaffected, FORCE_BIN stays 0") exit 127 on the new call. Say so in the PR: the break is outside the
  diff.
- A second script and runner, parameterised by env:

```ts
const NAME_SCRIPT = [
  "set -euo pipefail",
  'die() { echo "install: $*" >&2; exit 1; }',
  'INSTANCE="$PROBE_INSTANCE"',
  'CONFIG_DIR="$PROBE_CONFIG_DIR"',
  'STACK_DIR="$PROBE_STACK_DIR"',
  'PROJECT="rackbops-discord-bot-$INSTANCE"',
  CHECK_INSTANCE_NAME,
  "check_instance_name",
  'echo "ok $INSTANCE"',
].join("\n");
```

  and `runName(instance, { configDir, stackDir })` spawning `BASH -c NAME_SCRIPT` with `PROBE_*` in the env (copy
  `run()`'s shape, `:81-95`). Cases, in a `describe.skipIf(!runnable)("install.sh refuses a new instance named next or *-next (#567)")`,
  one `mkdtempSync` dir per test (`rmSync` after); "absent" dirs are paths under it that were never created; compare
  stdout with `.trim()` (it ends in a newline):

- **N1:** `prod-next`, both dirs absent -> exit 1, stdout empty, stderr contains `would be 'rackbops-discord-bot-prod-next', which ends in -next` and `(#567)`.
- **N2:** `prod-next`, `configDir` exists -> exit 0, stdout `ok prod-next`, stderr contains `WARNING: the container 'rackbops-discord-bot-prod-next' ends in -next` and the quoted form `container is 'rackbops-discord-bot-prod'` (quoted, so the unstripped name cannot satisfy it).
- **N3:** `prod-next`, only `stackDir` exists -> exit 0 with the same warning.
- **N4:** `next`, dirs absent -> exit 1 with stderr containing `would be 'rackbops-discord-bot-next'`; `next`, `configDir` exists -> exit 0 with a warning containing `container is 'rackbops-discord-bot'` (quoted).
- **N5:** `prod`, `nextgen`, `prodnext`, `next-prod`, dirs absent and no `-next` sibling -> exit 0, stderr empty
  (`prodnext` is the name that tells `*-next` from `*next`).
- **N7 (reverse):** `prod`, dirs absent, but `${configDir}-next` created -> exit 0, stdout `ok prod`, stderr contains
  `WARNING: an instance 'prod-next' already exists` and `(#567)`; the same with only `${stackDir}-next` created.
- **N6 (placement, a top-level `test`, no bash needed):**

```ts
test("install.sh calls check_instance_name after PROJECT is set and before anything is created (#567)", () => {
  const iProject = installShSource.indexOf('PROJECT="rackbops-discord-bot-$INSTANCE"');
  const iBoot = installShSource.indexOf('bootstrap_dir "$CONFIG_DIR"');
  const iCall = installShSource.search(/^ {2}check_instance_name$/m); // the call line itself, not the definition and not a comment
  for (const [name, i] of Object.entries({ iProject, iBoot, iCall })) expect(i, `${name} present`).toBeGreaterThan(-1);
  expect(iCall).toBeGreaterThan(iProject);
  expect(iCall).toBeLessThan(iBoot);
});
```

### Mutation table (scratch worktree; `bun test ops/install.test.ts` per mutant)

```bash
git -C /s/repos/rackbops-discord-bot worktree add --detach /s/Repos/_wt/rdb-567-mut fix/567-install-next-guard
cd /s/Repos/_wt/rdb-567-mut && bun install --frozen-lockfile
```

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | replace the `die …` line with `:` (deleting it outright is a bash syntax error that fails every case for the wrong reason) | N1, N4 |
| M2 | make the `-next` branch `die` unconditionally (drop its `if`) | N2, N3, N4's second case |
| M3 | `*-next` -> `*next` | N5 (`prodnext`) |
| M4 | drop the `next\|` alternative | N4 |
| M5 | `[ -d "$CONFIG_DIR" ] \|\| [ -d "$STACK_DIR" ]` -> `[ -d "$CONFIG_DIR" ]` only | N3 |
| M6 | move the `check_instance_name` call below `bootstrap_dir "$CONFIG_DIR"` | N6 |
| M6b | comment the call out (`  # check_instance_name`) | N6 (the `search` finds no call line) |
| M7 | `${PROJECT%-next}` -> `${PROJECT}` in the warning | N2, N4 (the quoted `container is '…'` forms) |
| M8 | drop the `>&2` on the `-next` warning | N2, N3 (stdout no longer `ok …`) |
| M8r | drop the `>&2` on the reverse warning | N7 |
| M9 | delete the `*)` reverse-check branch | N7 |

### Coverage table

| Bullet (from #567's Acceptance, plus this plan's) | Step | Test | Mutation |
|---|---|---|---|
| `bash -n` and `shellcheck` show no new finding | 1 | manual (commands below) | n/a |
| a new install with `prod-next` refuses with the message; a re-run warns and continues; `prod` is untouched | 1 | N1-N5 | M1-M5, M7, M8 |
| a new `X` beside a legacy `X-next` warns and continues | 1 | N7 | M9 |
| the check runs after the paths are known and before anything is created | 1 | N6 | M6, M6b |
| the branch-gate tests still run (`runBranchGate` stub) | 3 | the four #232/#295 tests | removing the stub |
| the docs no longer call the guard a future one; the README citations into `install.sh` point at the moved lines | 2 | lens-B audit | n/a |

### Verification (worktree root; paste real output in the PR)

```bash
bash -n ops/install.sh
shellcheck ops/install.sh
bun install --frozen-lockfile
bunx tsc --noEmit -p ops/tsconfig.json
bun test ops/install.test.ts
bun test ops/bot-ops.test.ts
bun run check
```

`shellcheck ops/install.sh` is clean before this change (0.11.0 on this box prints nothing) and must stay clean; CI
has no shellcheck or `bash -n` step (`.github/workflows/ci.yml` runs `bun test`, `bun test --randomize` and the
docker builds), so these two are local checks and the PR says so. `ops/bot-ops.test.ts` is slow (subprocess tests,
minutes); run it in the background. The `ops/` typecheck is the one that sees `install.test.ts`.

### PR

- Title: `fix(ops): refuse a new install.sh instance named next or *-next, warn on a re-run or a legacy -next sibling (#567)`.
- Body: the collision in two sentences, Decisions 1-4, the outputs above, the mutation table, the note that the
  branch-gate harness needed a stub (a break outside the diff). End with `Closes #567.`
- After merge: tick #567 on #525 (byte-exact; CRLF body). No operator step: a re-run of `ops/install.sh` on nucbox is
  already owed for S3b-1's guard and picks this up.
