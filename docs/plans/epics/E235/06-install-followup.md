<!-- Plan for Rackbops/rackbops-discord-bot#295 (Epic #235). The issue body IS the plan (its Scope
and Acceptance sections, copied verbatim below under a header comment, same discipline as
03-install-shared-bin.md) -- both findings were raised by reviewer lens A on #291's review gate
(#230 + #231) and declined in writing there as out of that PR's scope, then filed here on roshne's
instruction (2026-09-21). Implementer's "Deviations from the plan" appended at the end. -->

## Implementation plan -- issue body executed as written

Covers **#295** as one PR (Epic #235's `install.sh` bundle, same lane as #230/#291 -- `ops/install.sh` only). Two small corrections to how `install.sh` fails, not what it installs.

**Files:** `ops/install.sh`, `ops/install.test.ts`. Nothing else -- `ops/bot-ops.sh`, `ops/admin/`, `src/` are other lanes' files.

### Scope (verbatim from the issue)

1. **`--force-bin` in the branch position is a usage error.** `install.sh debug --force-bin` (branch omitted) today reads `--force-bin` as the branch name: it passes the #232 branch regex, reaches the first fetch, 404s on `raw.githubusercontent.com/.../--force-bin/...` and dies with curl's error and nothing installed -- safe, but the operator is told nothing about what went wrong. A second argument that starts with `-` is not a branch: die with `usage: install.sh <instance> [branch] [--force-bin] ('--force-bin' needs a branch; from main it changes nothing)` before any fetch. `install.sh debug main --force-bin` stays accepted (it is what the usage line documents).

2. **`schema_of` and the compose-schema read are total.** `schema_of()` (`grep -m1 '^readonly BOT_OPS_SCHEMA=' "$1" | cut -d= -f2`) and the `compose_schema="$(grep -m1 '^x-rackbops-schema:' ... | cut ... | tr ...)"` line both sit under `set -euo pipefail`: a file without the line makes `grep` exit 1, and in an assignment or a `die`/`echo` argument that either aborts the script with no diagnostic or prints an empty schema where the code already meant `unknown` (`${compose_schema:-unknown}` never gets its chance). Make both reads return `unknown` on a missing line and continue: `{ grep -m1 ... "$1" || true; } | cut -d= -f2`, then `[ -n "$v" ] && printf '%s' "$v" || printf 'unknown'`. Theoretical for any real deploy of this repo (every branch since #173 carries the line), which is why it was declined from #291; still the script's own stated intent, and #291 fanned the pattern out from one call site to three.

**Out:** any change to the guard itself (#230's rule stands), any new argument.

### Can't be worked until these land (prerequisites)

None (#291 is merged).

### Acceptance (verbatim from the issue) -- execute these, paste the real output

- [ ] `install.sh debug --force-bin` dies with the usage message above and reaches no fetch (the `runBranchGate` probe in `ops/install.test.ts` records `fetches: []`); `install.sh debug main --force-bin` still reaches `install_shared_bin` with `FORCE_BIN=1`; `install.sh debug feature-x` still works as before. Paste the three runs.
- [ ] With a fetched `bot-ops.sh` that lacks its `BOT_OPS_SCHEMA` line, `install_shared_bin`'s summary says `(bot-ops schema unknown)` and the run continues; the refusal message names `unknown` for that side; the compose read likewise prints `compose schema unknown` for a compose file without `x-rackbops-schema:`. Paste the output.
- [ ] Mutation: drop the leading-`-` check -> the first bullet's probe reaches a fetch; restore the bare pipeline in `schema_of` -> the second bullet's run aborts instead of printing `unknown`; each fails the test named for it.
- [ ] `bash -n ops/install.sh`, `shellcheck ops/install.sh` (no new warning), `bun test ops/install.test.ts` green; the existing #230 and #232 describes unedited.

### Notes (verbatim from the issue)

Behaviour change (an argument that was accepted is refused; an abort becomes a message): the three-reviewer gate applies. Effort **XS**.

### Implementation shape (decided, not open for re-planning -- per the orchestrator's hand-off)

1. **`ops/install.sh` arg parsing (`main()`):** immediately after `BRANCH="${2:-main}"`, add `[[ "${2:-}" != -* ]] || die "usage: install.sh <instance> [branch] [--force-bin] ('--force-bin' needs a branch; from main it changes nothing)"`, checked against the raw `${2:-}` positional (not `$BRANCH`, already defaulted to `main`), before the existing `FORCE_BIN`/`case "${3:-}"` block. Nothing else in arg parsing changes.
2. **`schema_of()`:** rewritten to `{ grep -m1 '^readonly BOT_OPS_SCHEMA=' "$1" || true; } | cut -d= -f2`, captured into a local, printed as the value or `unknown` per the issue's exact shape.
3. **The `compose_schema=` line:** wrap its `grep` the same way (`{ grep -m1 '^x-rackbops-schema:' ... || true; } | cut -d: -f2 | tr -d '[:space:]'`); the existing `${compose_schema:-unknown}` fallback at its echo site is untouched and now actually reachable.
4. **Tests (`ops/install.test.ts`), extending the existing harnesses, not replacing them:**
   - `runBranchGate`-style: extend to accept an optional third argument and report `FORCE_BIN`, covering `probe --force-bin` (dies pre-fetch), `probe main --force-bin` (reaches `install_shared_bin` with `FORCE_BIN=1`), `probe feature-x` (unaffected).
   - `runSharedBin`-style: a `contentFor` returning content with no `BOT_OPS_SCHEMA` line, asserting the summary says `unknown` and, separately, the refusal message names `unknown` for the missing side.
   - A new harness for the `compose_schema=` + echo line pair, extracted as a contiguous slice (same discipline as `STACK_ENV_WRITE_SEQUENCE`/`BRANCH_GUARD_TO_FETCH`), run against a real compose file missing `x-rackbops-schema:`, asserting `compose schema unknown` and a zero exit.

### Coverage table

| Acceptance bullet | Plan step | Test | Mutation that must fail it |
|---|---|---|---|
| `--force-bin` in branch position is a usage error; `main --force-bin` and `feature-x` unaffected | 1 | `install.sh's second argument cannot start with '-' (issue #295)` (extends `runBranchGate`) | drop the leading-`-` check -> the probe reaches a fetch instead of dying |
| `schema_of` prints `unknown` on a missing `BOT_OPS_SCHEMA` line, run continues | 2 | `install_shared_bin` extension in the `issue #230` describe, `issue #295` sub-case | restore the bare `grep \| cut` pipeline -> the run aborts instead of printing `unknown` |
| compose read prints `compose schema unknown` on a missing `x-rackbops-schema:` line | 3 | new `install.sh's compose-schema read is total (issue #295)` describe | restore the bare `grep \| cut \| tr` pipeline -> the run aborts instead of printing `unknown` |
| existing #230/#232 describes stay green | 1-3 | full `ops/install.test.ts` run | any of the above, plus accidental edits to unrelated lines |

### PR

Branch `claude/install-force-bin-usage` from `origin/main`, isolated worktree. Title `fix(ops): install.sh refuses --force-bin in the branch position, and a missing schema line prints unknown (#295)`; body with `Closes #295`, this plan file's path, deviations, the acceptance output, the mutation table, the round list with dispositions. Behaviour change: the full gate -- two adversarial read-only reviewers, different lenses (A: correctness and failure modes -- the `-` check's position relative to the #232 branch guard, `{ ... \|\| true; } \| cut` under `set -euo pipefail`, an empty vs missing line; B: claims-vs-code and test quality -- every coverage-row mutant really fails only the test it names, the existing harnesses still pin what they pinned). Mutation-test every changed line in a detached scratch worktree, one mutant at a time. At most four rounds, then stop and report to the orchestrator. **Never merge.**

## Deviations from the plan (recorded at implementation)

- **Coverage table row 3 (compose-schema mutation), observed failure mode:** the plan step 3 test
  is a new `extractLine`-anchored slice (same discipline as `STACK_ENV_WRITE_SEQUENCE`/
  `BRANCH_GUARD_TO_FETCH`), and its regex requires the literal `{ grep ... || true; }` grouping the
  fix introduces. Restoring the bare `grep | cut | tr` pipeline (the named mutation) therefore
  doesn't fail one assertion in isolation — it makes `extractLine` itself throw at module load
  ("couldn't find the compose_schema read-and-summary lines"), which fails the *entire* test file's
  run, not just the two tests in that describe. This is the same fail-loud convention the file
  already uses elsewhere (`BRANCH_GUARD_LINES`'s own comment: "removing either fails the extract
  loudly") — not a design gap, just naming the actual failure shape observed instead of a narrower
  one.
- **`schema_of()`'s mutation didn't reproduce the "aborts the script" half of the issue's own
  description, only the "prints an empty schema" half — for the specific call sites tested.**
  Reverting to the bare `grep -m1 ... | cut` pipeline made all three `issue #295` schema_of tests
  fail, but by producing an *empty* schema value (`"...schema )"`, `"...schema  vs main's 5"`)
  rather than aborting the script outright. Traced to where `$(schema_of ...)` is actually used: at
  every call site in `install_shared_bin` it's embedded inside a larger string (an `echo`/`die`
  argument, or a `note="... $(...)"` assignment concatenated with literal text) rather than being
  the *entire* right-hand side of a bare `var=$(schema_of ...)` assignment — and bash's `errexit`
  only inspects the exit status of the command actually being run (`echo`, `die`, the assignment
  statement), not a command substitution's exit status when it's just one piece of a larger
  expansion. The abort path the issue describes is real (and is exactly what the *unfixed*
  `compose_schema="$(grep ... | cut ...)"` line does, confirmed separately: that one — a plain
  `var=$(cmd | cmd)` assignment with nothing else on the right-hand side — does abort the script
  under the old code, per #291's own review-gate note declining this exact finding). Either failure
  mode is a defect the fix corrects and the test still catches; not a change to which lines were
  fixed or which tests exist, just a correction to the mutation table's stated failure mode for this
  one row.
- **Manual acceptance runs (paste-the-real-output bullets) used the same stubs `runBranchGate`/
  `runSharedBin` use (`fetch`, `curl`, `chown`, `mkdir`, `sed` faked; `resolve_deploy_identity`
  faked to avoid a real `id`), not a live `curl | bash` against a real host** — `install.sh`
  hardcodes real `/opt/...` paths, needs real `sudo`/`docker`, and fetches over the network per its
  own header comment and `03-install-shared-bin.md`'s own acceptance section, which took the same
  approach ("no real `install.sh` run against nucbox here"). The extracted source slices are pulled
  from the real, committed `ops/install.sh` (not hand-copied), so the output below is the real
  script's real behaviour on that slice, just without a live host underneath it.
