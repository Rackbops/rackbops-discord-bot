<!-- Plan for Rackbops/rackbops-discord-bot#230 + #231 (Epic #235). Copy of the orchestrating
session's implementation-plan comment posted 2026-09-21 on #230
(https://github.com/Rackbops/rackbops-discord-bot/issues/230#issuecomment-5769118445), which also
covers #231 (its own comment: https://github.com/Rackbops/rackbops-discord-bot/issues/231#issuecomment-5769118768,
which just points back to #230's plan for its half), with the implementer's "Deviations from the
plan" appended at the end. -->

## Implementation plan — written by the orchestrating session, to be executed as written

Covers **#230 + #231** as one PR (Epic #235's declared `install.sh` / `docker-compose.yml` bundle). Written 2026-09-21 against `origin/main` @ `c1e5f42`; every cite read from source that day (line numbers as of that sha; cite by construct when you search). roshne lifted the hold on this bundle on 2026-09-21: no remaining #236 child edits either file. Neither issue has an `## Acceptance` section, so this plan defines the observable outcome each demands; execute those and paste the real output.

**Files:** `ops/install.sh`, `ops/install.test.ts`, `docker-compose.yml` (one comment block), `ops/README.md`, `CONTEXT.md`. Nothing else. `ops/bot-ops.sh` is another lane's file (#277 in flight) — do not touch it.

### Decided — not open for re-planning

1. **#230: a per-instance branch may refresh the host-shared `bin/bot-ops.sh` only with `main`'s content.** `install.sh <instance> <branch>` today fetches `ops/bot-ops.sh` from `<branch>` and overwrites `/opt/rackbops-discord-bot/bin/bot-ops.sh` unconditionally (`install.sh:204`), the one file every instance's admin container mounts (`docker-compose.yml:114`). The rule: when `BRANCH` is `main`, refresh as today. Otherwise fetch the branch's copy AND `main`'s copy; if they are byte-identical, install it (it is what `main` would install) and say so; if they differ, **refuse** with a message naming the shared path, both copies' `BOT_OPS_SCHEMA`, and the two ways out (`main`, or `--force-bin`), leaving the installed file untouched and stranding no temp file. `--force-bin` (a third positional argument, the only one accepted) installs the branch's copy and says it differs from `main`'s. Comparing against `main` rather than against the installed file is deliberate: it permits exactly the writes `main` would make (a stale install still gets refreshed by a branch that carries `main`'s script) and refuses exactly the case the issue describes.
2. **The issue's alternative — a live schema check instead of the startup-only one — is not taken.** It would leave the overwrite in place and only report it sooner. Say so in the PR.
3. **`fetch()` is split, not duplicated.** `download src mode dest [branch]` does the curl-to-registered-temp, chmod and chown and leaves the temp path in `DOWNLOADED` (the script's `REPLY` idiom); `fetch` = `download` + `mv`. The three existing `fetch` callers keep their one-line calls. The new `install_shared_bin` uses `download` twice and `mv` once. `schema_of <file>` (the `grep -m1 '^readonly BOT_OPS_SCHEMA=' | cut -d= -f2` already inline at `:209`) becomes a function used by both the existing "wrote … schema" line and the refusal message.
4. **Byte identity is `sha256sum`** (coreutils, present wherever `od`/`tr`/`cut` are — the script's own baseline), not `cmp`/`diff` (diffutils, not in the script's stated dependencies).
5. **#231: say the true thing.** Step 4's text (`install.sh:279-282`) claims the four admin vars "aren't baked into the image or shown in docker inspect". They are not baked into the image; they ARE in the container's environment and `docker inspect` prints them (`docker-compose.yml:95-99` passes them as `environment:`). The real benefit is scope: only these four reach the container, not the whole `.env`. Reword step 4 to that, and add one sentence to the `docker-compose.yml:74-82` comment block saying the same (scope, not secrecy). Step 5's tunnel sentence ("never gets the rest of your secrets") is true and stays.
6. **The `x-rackbops-schema` does not move** (a comment-only compose change), and `BOT_OPS_SCHEMA` is not this lane's to touch.

### Step 1 — `install.sh`: arguments

`main()` (`:154-168`): after `BRANCH="${2:-main}"`, `FORCE_BIN=0` and `case "${3:-}" in "") ;; --force-bin) FORCE_BIN=1 ;; *) die "usage: install.sh <instance> [branch] [--force-bin] (unknown argument '${3}')" ;; esac`. The instance-name `die` at `:157` and the header's `Usage:` (`:14-16`) both gain `[--force-bin]`, with one line under it: "install `<branch>`'s bot-ops.sh into the host-shared bin/ even though it differs from main's — it is then what EVERY instance on this host runs". The header's "Always refreshes" paragraph (`:21-28`) says the shared script is refreshed from `main`, or from another branch only when that branch's copy is `main`'s.

### Step 2 — `install.sh`: `download` / `fetch` / `schema_of`

Replace `fetch()` (`:116-128`) with `download()` (same body minus the `mv`, plus `local branch="${4:-$BRANCH}"` used in the URL, ending `DOWNLOADED="$tmp"`) and `fetch() { download "$@"; mv "$DOWNLOADED" "$3"; }`. Move the atomic-write comment onto `download`. Add `schema_of() { grep -m1 '^readonly BOT_OPS_SCHEMA=' "$1" | cut -d= -f2; }` and use it at the existing `:209` line.

### Step 3 — `install.sh`: `install_shared_bin`

Replaces the `fetch "ops/bot-ops.sh" 755 "$BIN_DIR/bot-ops.sh"` line (`:204`) and the echo after it (`:209-210`):

```bash
install_shared_bin() {
  local dest="$BIN_DIR/bot-ops.sh" fetched main_copy note=""
  download "ops/bot-ops.sh" 755 "$dest"; fetched="$DOWNLOADED"
  if [ "$BRANCH" != "main" ]; then
    download "ops/bot-ops.sh" 755 "$dest" main; main_copy="$DOWNLOADED"
    if [ "$(sha256sum < "$fetched")" = "$(sha256sum < "$main_copy")" ]; then
      note=" (identical to main's)"
    elif [ "$FORCE_BIN" -eq 1 ]; then
      note=" (--force-bin: differs from main's, schema $(schema_of "$main_copy"))"
    else
      die "$dest is shared by every instance on this host, and '$BRANCH' ships a different bot-ops.sh from main (schema $(schema_of "$fetched") vs main's $(schema_of "$main_copy")) — a per-instance branch must not replace it silently. Re-run with main, or add --force-bin to install '$BRANCH''s copy for every instance."
    fi
  fi
  mv "$fetched" "$dest"
  echo "install: wrote $dest from $BRANCH (bot-ops schema $(schema_of "$dest"))$note"
}
```

The temps are registered by `download`, so the `die` path strands nothing (the EXIT trap sweeps them; on the success path `main_copy` is swept at exit too). The comment above the call (`:201-203`) is rewritten: the split is still "scripts are deployment artifacts", with the one exception that a non-`main` branch cannot put non-`main` content into the shared directory without saying so.

### Step 4 — `install.sh` step 4 and `docker-compose.yml`: #231

Step 4's sentence becomes: "ADMIN_TOKEN and the CLOUDFLARE_ACCESS_*/ADMIN_ALLOWED_EMAILS vars are read out of .env just for this one command, so only those four reach the admin container rather than every secret in the file, and nothing is baked into the image. They are still in the container's environment — `docker inspect` on this host shows them — which is acceptable only because anyone who can run that is already root-equivalent here. This is not a secrets boundary either way: …" (the existing bind-mount sentence follows unchanged). In `docker-compose.yml`'s admin comment block (`:74-82`), after "not the rest of the file": "Scope, not secrecy: those four still land in the container's `Config.Env` and `docker inspect` prints them; the point is that the rest of .env never does."

### Step 5 — tests (`ops/install.test.ts`, all `describe.skipIf(!runnable)`, the file's extraction idiom; these run on this Windows box through Git's bash)

Two existing harnesses must follow the refactor, and the plan names them so nobody "fixes" the script to keep them green: `runSweep` (`:155`) extracts `fetch` and now also needs `extractFunction("download")` in its script; `BRANCH_GUARD_TO_FETCH` (`:607-610`) anchors its slice on `fetch "ops/bot-ops.sh" 755 "$BIN_DIR/bot-ops.sh"`, which no longer exists — re-anchor it on the `install_shared_bin` call line and give `runBranchGate` a fake `install_shared_bin() { echo "FETCH:ops/bot-ops.sh"; }` beside its fake `fetch`, so its four tests keep asserting exactly what they assert today.

New harness `runSharedBin(o: { branch, forceBin, installed?: string, contentFor: (branch) => string })`: a temp dir as `BIN_DIR`, the extracted `TMP_FILES`/`cleanup_tmp_files`/trap/`die`/`download`/`schema_of`/`install_shared_bin`, `chown` stubbed, and a fake `curl() { local url="$2" out="$4"; case "$url" in */main/*) …;; *) …;; esac > "$out"; }` that writes `readonly BOT_OPS_SCHEMA=<n>` content chosen per branch by `contentFor`, recording each URL to a log file; returns exit code, stdout, stderr, the dest's content, the leftover `tmp.*` count and the curl log.

| # | Test name | Pins |
|---|---|---|
| 1 | `a third argument is --force-bin or a usage error; --force-bin sets FORCE_BIN` | extract the arg-parse lines; `probe main` → ok, `FORCE_BIN=0`; `probe main --force-bin` → `FORCE_BIN=1`; `probe main --frobnicate` → dies, stderr names `--force-bin` |
| 2 | `main refreshes the shared script with one download and no comparison` | `branch: "main"`, `installed: "OLD"` → dest is main's content; exactly one curl call; stdout `wrote … from main (bot-ops schema 5)` without "identical" |
| 3 | `a branch whose bot-ops.sh is byte-identical to main's refreshes it and says so` | `contentFor` returns the same text for both → dest written, two curl calls, stdout ends `(identical to main's)` |
| 4 | `a branch whose bot-ops.sh differs from main's is refused: both schemas named, the installed file untouched, no temp file stranded` | `installed: "OLD"`, main → schema 5, branch → schema 9 → exit 1; stderr contains `schema 9`, `main's 5`, `--force-bin`, the dest path; dest still `OLD`; `tmp.*` count 0 |
| 5 | `--force-bin installs the differing copy and says it differs from main` | as 4 with `forceBin` → dest is the branch's content; stdout contains `--force-bin: differs from main's, schema 5` |
| 6 | `without the trap, the refusal WOULD strand the two temps (so test 4 is not vacuous)` | the `runSweep` control idiom: omit the trap → `tmp.*` count 2 |
| 7 | `step 4 says docker inspect shows the four vars, and no longer says they are hidden from it` | `renderNextSteps()`; the step-4 slice contains `docker inspect on this host shows them` and does not contain `or shown in docker`; the step-5 slice still contains `never gets the rest of your secrets` |
| 8 | `the compose file's admin comment says scope, not secrecy` | source pin on `docker-compose.yml`: the admin service's comment block contains `Scope, not secrecy` before `environment:` |

### Coverage table

| Outcome demanded | Step | Test | Mutation that must fail it |
|---|---|---|---|
| #230: a differing per-instance branch never replaces the shared script silently | 3 | 4 | drop the comparison (always `mv`); compare against the installed file instead of main's (test 4 with `installed` = branch content must still refuse) |
| #230: `main` and an identical branch still refresh | 3 | 2, 3 | refuse every non-main branch; skip the `mv` |
| #230: `--force-bin` is the only override, and only as the third argument | 1, 3 | 1, 5 | drop the `*)` usage arm; ignore `FORCE_BIN` |
| #230: the refusal strands nothing | 2, 3 | 4, 6 | register only one of the two temps |
| #230: the split changed nothing for the other fetches | 2 | the existing sweep and write-sequence tests, unedited except the harness additions named above | drop the `mv` from `fetch` |
| #231: the printed claim is true | 4 | 7 | restore the old sentence |
| #231: the compose comment matches | 4 | 8 | drop the sentence |
| docs | 6 | — single read against the merged code | — |

### Step 6 — docs

- `ops/README.md` "Keeping `bot-ops.sh` and `docker-compose.yml` current" (`:102-113`): "(it always refreshes both files)" becomes: `main` always refreshes both; from another branch the compose file is refreshed but the host-shared `bin/bot-ops.sh` only when that branch's copy is `main`'s, else install refuses and names `--force-bin` (#230). Wherever the README's install section (`:133-175`) shows the command line, the usage gains `[--force-bin]`.
- `CONTEXT.md`: the `ops/install.sh` row (Grep the row on `install.sh` — it is long; anchor an Edit on a short unique substring) gains the rule; a new gotcha beside the ops ones: **`bin/bot-ops.sh` is per host, so `install.sh <instance> <branch>` guards it (#230)** — the rule, why the comparison is against `main`, and that the schema check is still startup-only (#230's other suggestion, not taken). The `docker inspect` claim (#231) gets one sentence wherever CONTEXT.md repeats it (Grep `docker inspect`; expect the compose/admin gotcha).

### Acceptance — execute these, paste the real output

```
bash -n ops/install.sh
shellcheck ops/install.sh                  # no warning that main does not already have
bun test ops/install.test.ts --timeout 60000
bun test ops/docker-compose.test.ts --timeout 60000   # skips without docker compose on this box; CI's
```

Plus, pasted verbatim from test 4's harness run (or a one-off run of the same script), the refusal message as a host would print it. Name what is host-only: no real `install.sh` run against nucbox here (#247's deploy re-runs it with `main`, which is the unchanged path).

### PR

Branch `claude/install-shared-bin-guard` from `origin/main` (`c1e5f42` or later), isolated worktree. Title `fix(ops): install.sh refuses to replace the host-shared bot-ops.sh from a per-instance branch, and says what docker inspect shows (#230, #231)`; body with `Closes #230` and `Closes #231`, the plan committed as `docs/plans/epics/E235/03-install-shared-bin.md` (with a "Deviations from the plan" section in the shape of `01-install-extract.md`), deviations, the acceptance output, the mutation table, the round list with dispositions. Behaviour change: the full gate — two adversarial read-only reviewers with different lenses (A: correctness and failure modes — the `die` inside a function under `set -e`, the temp sweep, the two-branch download, what `curl | bash -s -- debug feature --force-bin` does with the third argument; B: claims-vs-code and test quality — every coverage-row mutant really fails only the test it names, and the two re-anchored harnesses still pin what they pinned). Mutation-test every changed line in a detached scratch worktree, one mutant at a time. At most four rounds, then stop and tell the orchestrator. **Never merge.**

## Deviations from the plan (recorded at implementation)

- **Step 6, CONTEXT.md / #231:** the plan says the `docker inspect` claim "gets one sentence
  wherever CONTEXT.md repeats it." Grepping `docker inspect` across CONTEXT.md turned up exactly
  one hit, in an unrelated redeploy-status bullet (`docker inspect still returns 200, State.Running:
  false`) — nothing repeats install.sh step 4's admin-vars claim. So no sentence was added to
  CONTEXT.md for #231 specifically; the correction lives in `install.sh`'s own printed text and
  `docker-compose.yml`'s admin comment (both per Step 4), which is where the claim actually lived.
  Not a design change, just recording that the conditional in Step 6 had nothing to fire on.
- **Test 7's "never gets the rest of your secrets" assertion:** rendered through the real
  `cat <<EOF` heredoc, that unchanged sentence spans a genuine line break (`...never gets the rest`
  / `of your secrets:` on the next source line, joined only by a plain newline, not a `\`-continued
  one — confirmed empirically before writing the test). Asserted with
  `/never gets the rest\s+of your secrets/` instead of a plain `.toContain(...)` so the test matches
  what the script actually prints rather than the plan's inline single-line rendering of the phrase.
  Same underlying claim, no behaviour difference.
- **Setup, not a plan deviation:** `ops/admin/` is a separate package with its own lockfile: `bun
  run check` there needed its own `bun install --frozen-lockfile` (the harness's checked-out
  worktree had no `ops/admin/node_modules`) before `bun run check` — the repo's own
  three-typecheck convention (root, `ops/tsconfig.json`, `ops/admin`) — would pass. All three are
  green; see the acceptance output below.
- **Review gate round 1 (both reviewers verdict SOUND) — one blocker, fixed:** lens A found
  `ops/README.md`'s "Bootstrapping a fresh instance" section still said install.sh "always
  refreshes three things ... bin/bot-ops.sh (shared across every instance on the host)" — a false
  claim about the exact behaviour this PR changes, left uncorrected 45 lines below the already-fixed
  paragraph. Fixed in the same commit as the round's other change (`9de7511`); no separate re-review
  round needed (docs-only, matching already-correct code elsewhere in the same file — a wording fix
  per the personal CLAUDE.md's re-review threshold, not new logic).
- **Round 1, declined in writing (both minor, non-blocking, explicitly named that way by lens A):**
  (1) `install.sh debug --force-bin` (branch omitted) silently treats `--force-bin` as the branch
  name rather than a usage error — fails cleanly downstream (a 404 on the first fetch, nothing
  installed) rather than bypassing the #230 guard, so not a correctness or security defect, just a
  confusing error message for an implausible operator typo; flagged as a follow-up rather than fixed
  in this PR, which the plan scoped `--force-bin` as "third positional argument only." (2)
  `schema_of()`'s `grep -m1 | cut` pipeline can abort the script with no diagnostic under `pipefail`
  if a fetched `bot-ops.sh` ever lacked its `BOT_OPS_SCHEMA` line — a pre-existing pattern in this
  script (the same shape already exists at the `compose_schema=` line), fanned out from one call
  site to three by this PR but not a new risk shape; theoretical, not reachable by any real deploy
  of this repo.
- **Round 1, PR-body documentation fix (not a code fix):** lens B found the mutation table's row 1
  ("disable the branch-vs-main comparison entirely") under-reported which tests it fails — the PR
  body originally said "tests 4, 5, 6" but a full untruncated re-run (in a fresh detached worktree)
  confirmed it also fails test 3 (the byte-identical case, since skipping the comparison block means
  `note` never gets set to "(identical to main's)" and only one curl call happens instead of two).
  The mutation was and is still correctly killed either way — this was a transcription gap in the
  PR body from an earlier truncated `tail` of the test output, not a test-coverage gap. Corrected in
  the PR body.

