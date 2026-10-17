<!-- Plan for #531 bundle O1 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #531): `ops/install.sh`'s two
untested guarantees and four Lows -- #424, #425, and #486 items 2, 3, 9, 10 (#486's item 8 is O2's). Written by the
orchestrating session on 2026-10-17; every `file:line` below was read at main `4cfbebd`. Re-find each anchor by its
quoted text on the tree you cut from.
ORDER: cut this bundle AFTER #529's A2 (`529-A2-admin-server-lows.md`, in flight as `fix/529-A2-admin-server-lows`)
and O2 (`531-O2-compose-image-tunnel.md`) have merged. A2 writes the docs and remedy texts for the compose-file
staleness that item 3 here fixes at its root, and this bundle corrects those texts; O2 edits the next-steps heredoc
and its test in the same two files (`ops/install.sh`, `ops/install.test.ts`).
Audited read-only in round 1 (a Sonnet agent; steps 1a-1c applied and E1, E3, E4 drafted in a scratch tree, 66 pass
with the fixes below; M2, M2b, M4, M5 run and caught; M3-M3d not run; no conflict with A2's branch or O2's plan):
applied: `runNameGate` also runs the `.env` block and needs the `download`/`mv` stubs (its control test exited
127); E1's slice is anchored on the "already exists" echo, not the guard, so M1 fails E1 (a) alone instead of
erroring the file at import; `fetch_in_place` writes in place only to a file we own and then sets mode and owner on
it (a `cat >` keeps the old ones, and could not open a root-owned leftover that `mv` replaces today), with E4 (d),
M5c and M5d; E2 (a)'s "at least one chown" is limited to runs that get past curl; M5 runs here (inodes are stable on
this box); an empty value also reports "is missing". -->

## Implementation plan -- #531 O1: an existing operator `.env` and every chown are pinned by tests, the stack `.env` check names a missing key, the compose file is refreshed in place so the running admin sees it, the generated token never sits half-written at the final path, and the GIT_SHA comment says what it can promise

Children: **#424** (closes), **#425** (closes), **#486** (closes with this PR: items 2, 3, 9, 10 here; item 8 in O2).
One PR, branch `fix/531-O1-install`, worktree `S:\Repos\_wt\rdb-531-O1` cut from `origin/main` once A2 and O2 are
in. Behaviour changes (a refusal naming a missing key, the compose file written in place, the token patched before
the move, a new re-run line): three-reviewer gate.

### What is wrong, verified at `4cfbebd`

- **#424.** The `.env` guard is `if [ -f "$CONFIG_DIR/.env" ]; then ... leaving your config alone; else fetch
  ".env.example" 600 "$CONFIG_DIR/.env"; ... sed -i ...ADMIN_TOKEN...; fi` (`ops/install.sh:288-299`). The one
  harness that executes it, `runBranchGate` (`ops/install.test.ts:640-674`), runs with `CONFIG_DIR` set inside the
  slice to `/opt/rackbops-discord-bot/probe` (`ops/install.sh:274`) and stubs `mkdir`, `sed` and `fetch`; the file
  never exists, so only the `else` branch runs, and the only assertion is `fetches` containing `.env.example`
  (`:697`). Deleting the guard leaves the suite green.
- **#425.** Every chown site uses `$DEPLOY_UID:$DEPLOY_GID`: `bootstrap_dir`'s `sudo chown` (`:141`), `download`'s
  (`:158`), `main`'s `backups/` (`:286`) and the stack `.env` (`:350`, Grep `chown "$DEPLOY_UID:$DEPLOY_GID"
  "$STACK_DIR/.env"`). Every harness that reaches one defines `chown() { :; }` (`ops/install.test.ts:179`, `:452`,
  `:649`, `:858`), and `runBranchGate` stubs `bootstrap_dir` (`:647`); only `resolve_deploy_identity` is tested.
- **#486 item 2.** `validate_stack_env` (`:226-234`): `value="$(grep "^${key}=" "$file" | tail -n1 | cut -d= -f2-)"`
  under `set -euo pipefail`: a missing key line makes `grep` exit 1, the assignment fails, and the script ends with
  no message. The comment at the call site (`:351-353`) even says a bad render "dies here, silently".
- **#486 item 3.** `fetch "docker-compose.yml" 644 "$STACK_DIR/docker-compose.yml"` (`:307`) is `download` + `mv`
  (`:165-168`): a new inode. The admin service bind-mounts that ONE file (`docker-compose.yml:124`), so a running
  admin keeps reading the old one. A2 (#529) documents this and tells the operator to recreate the admin with step 4
  plus `--force-recreate`; the root cause stays.
- **#486 item 9.** `fetch ".env.example" 600 "$CONFIG_DIR/.env"` (`:291`) moves the file into place, THEN `sed -i`
  writes the token into it (`:295`): a kill or a `sed` failure between them leaves a real-looking `.env` with
  `ADMIN_TOKEN=` that every later run preserves. And on a new instance whose branch ships a different `bot-ops.sh`,
  the token is printed (`:297-298`) and `install_shared_bin` then refuses (`:205`); the `--force-bin` re-run finds
  `.env` and says only "already exists".
- **#486 item 10.** The stack-env comment (`:333-337`) says the install-time `GIT_SHA` means a bot brought up
  through the stack `.env` "still reports accurate self-update status"; the context is the moving `repo#branch`
  (`:345`), so a build hours later bakes a stale sha. `ops/README.md` (Grep `A manual \`up -d --build bot\``)
  already documents the workaround.

### Decisions (defaults, named so the gate can contest them)

1. **#424/#425 are test-only, through slices with their side effects redirected, never a test knob in
   `install.sh`.** The `.env` block is sliced on its own (`if [ -f "$CONFIG_DIR/.env" ]` ... its `fi`) and run with
   `CONFIG_DIR` pointed at a temp dir; a production variable that only tests set is not added.
2. **#486 item 3: refresh the compose file in place when it already exists.** A new helper, `fetch_in_place`:
   `download` as today (temp file in the destination's directory, mode and owner set on the TEMP file), then, when
   the destination is an existing regular file, not a symlink, and owned by us (`[ -f "$3" ] && [ ! -L "$3" ] &&
   [ -O "$3" ]`), `cat "$DOWNLOADED" > "$3"` -- same inode, so a running admin's single-file bind mount sees the new
   content at once -- followed by `chmod "$2" "$3"` and `chown "$DEPLOY_UID:$DEPLOY_GID" "$3"` (a `cat >` keeps the
   old file's mode and owner, so they are set on the destination itself; the chown succeeds wherever `download`'s
   own chown of the temp file did); else `mv` as `fetch` does (a first install, or a file we do not own -- e.g. a
   root-owned leftover, which `mv` in our own directory replaces today and `cat >` could not open). The temp file
   is swept by the existing EXIT trap. The trade, written down in the helper's comment: an in-place write is not
   atomic; a `docker compose -f` that reads the file in that instant sees it truncated and FAILS (loudly, a parse
   error), and a kill mid-write leaves a truncated file the next run rewrites. Chosen over mounting the stack
   DIRECTORY (`docker-compose.yml` shape change, a schema bump, and every instance re-running install.sh AND
   recreating its admin) because this needs neither. Only the compose file changes; `bot-ops.sh` sits in a mounted
   directory and stays `mv`, and the stack `.env` is not mounted and stays `mv`.
3. **The transition is named, not hidden.** An admin container started BEFORE this lands still holds the old inode
   until it is recreated once; after that, a re-run's compose changes reach it in place. A2's remedy text ("re-run
   ops/install.sh, then its printed step 4 with --force-recreate") stays in the log line and banner -- it is still a
   correct and harmless remedy, and the only one for the transition -- and the docs (A2's `ops/README.md` paragraph,
   the `CONTEXT.md` rows) are corrected to say step 4 is needed once, for an admin that predates #486.
4. **#486 item 9: patch the token in the temp file, then move; a re-run says where the token is.** The `else`
   branch becomes `download ".env.example" 600 "$CONFIG_DIR/.env"`, the `sed -i` on `"$DOWNLOADED"`, then
   `mv "$DOWNLOADED" "$CONFIG_DIR/.env"`. The `then` branch keeps its line and, when the file has a non-empty
   `ADMIN_TOKEN=` line, adds `install: ADMIN_TOKEN is already set in $CONFIG_DIR/.env (read it there for the panel's
   unlock prompt)` -- never the value. `main`'s order is NOT changed (moving `install_shared_bin` earlier would also
   move the end of the `runBranchGate` slice, `ops/install.test.ts:621-624`, and its four tests).
5. **#486 item 10: reword, do not pin the context to the sha.** Whether a Docker git context accepts a bare commit
   sha after `#` is not verified here; the comment becomes "GIT_SHA is the sha the branch pointed at when install.sh
   ran: a build from this file reports accurate self-update status only if the branch has not moved since (see
   ops/README.md's note on a manual `up -d --build bot`)".
6. **#486 item 2: name the missing key.** `value="$({ grep "^${key}=" "$file" || true; } | tail -n1 | cut -d= -f2-)"`
   in both reads, then `[ -n "$value" ] || die "$key is missing from $file"` before the absolute-path check; the call
   site comment says "dies here, naming the field". An empty value (`KEY=`) also reports "is missing"; for a
   generated file both mean the render failed, so one message covers both. Round 1 found the second read's
   `|| true` dead (the loop has already checked that key); keep it for symmetry with a comment saying so.

### Step 1 -- `ops/install.sh`

1a. `validate_stack_env`: Decision 6 (both `grep` reads, the loop's and the `BOT_OPS_CONFIG_DIR` one). The comment
at `:351-353` becomes "a bad render dies here, naming the field".

1b. After `fetch()` (`:165-168`), add `fetch_in_place()` per Decision 2 with a comment (the inode, the non-atomic
trade, which files use it and why); `:307` becomes `fetch_in_place "docker-compose.yml" 644
"$STACK_DIR/docker-compose.yml"`. The comment at `:300-305` ("always refresh them ... same as .env is never
touched") gains: "the compose file is rewritten in place (#486) so a running admin, which mounts that one file,
sees it".

1c. The `.env` block (`:288-299`): Decision 4.

1d. The stack-env comment (`:333-337`): Decision 5's sentence replaces "still reports accurate self-update status".
Its last sentence ("temp file first, atomic move") stays true for the stack `.env`.

### Step 2 -- `ops/install.test.ts`

- **E1 (#424 and item 9):** a new harness `runEnvBlock({ existing?: string })`: slice `ENV_BLOCK =
  extractLine(/^ {2}mkdir -p "\$CONFIG_DIR\/backups"[\s\S]*?already exists[\s\S]*?^ {2}fi$/m, ...)` -- from the
  `backups/` mkdir (so E2 (c) records that chown, `mkdir` real against the temp `CONFIG_DIR`) through the `.env`
  block's `fi`, anchored on the "already exists" echo and NOT on the guard's `if` line (round 1: a regex anchored on
  the guard throws at import under M1, erroring every test in the file instead of failing E1 (a)); script = `set -euo pipefail`,
  `die`, `TMP_FILES=()`, `DEPLOY_UID=4242; DEPLOY_GID=4343`, `CONFIG_DIR=<temp>`, a `download` stub that writes a
  fixture `.env.example` (`DISCORD_TOKEN=\nADMIN_TOKEN=\n`) to a `mktemp -p "$(dirname "$3")"` file, chmods it `$2`
  and sets `DOWNLOADED` (and logs `DOWNLOAD:$1` to stdout), `chown() { echo "CHOWN:$*"; }`, an `mv` wrapper that
  prints `MV_SRC_TOKEN:` plus the source's `ADMIN_TOKEN=` line before calling `command mv "$@"`, then the slice.
  Cases: (a) `existing: "DISCORD_TOKEN=keep\nADMIN_TOKEN=abc\n"` -> the file is byte-identical afterwards, no
  `DOWNLOAD:` line, stdout contains `already exists` and `ADMIN_TOKEN is already set`, and does NOT contain `abc`;
  (b) `existing` with `ADMIN_TOKEN=` empty -> the "already set" line is absent; (c) no file -> the file exists,
  its `ADMIN_TOKEN=` value is 64 hex chars, the printed token equals it, and the `MV_SRC_TOKEN:` line already
  carries that same token (patched BEFORE the move); mode 0600 asserted under `skipIf(win32)`.
- **E2 (#425):** every chown is `4242:4343`. (a) `runSweep` (`:165-`), `runWriteSequence` (`:438-`) and
  `runSharedBin` (`:815-`): replace `chown() { :; }` with a recorder appending `$*` to a log file in the harness's
  temp dir; set `DEPLOY_UID=4242; DEPLOY_GID=4343` in each script (or have the existing `resolve_deploy_identity`
  stub do so); assert every recorded call starts with `4242:4343 `, and assert at least one call was recorded only
  in the runs that get past `download`'s curl (`runSweep`'s `curlExit: 0` cases; its `curlExit: 22` runs die in
  `download` before any chown, so they assert the log is empty or only well-formed).
  (b) `bootstrap_dir` (sliced with `extractFunction("bootstrap_dir")`) against a path that does not exist, with
  `sudo() { echo "SUDO:$*"; }`: stdout contains `SUDO:mkdir -p <dir>` and `SUDO:chown 4242:4343 <dir>`; against an
  existing dir it owns, no `SUDO:` line. (c) E1's chown recorder: the new `.env`'s download chowned `4242:4343`.
  `runBranchGate` keeps its stubs (its job is the branch guard), and the comment at its `chown`/`bootstrap_dir`
  stubs points at E2.
- **E3 (item 2):** in the `validate_stack_env` describe (`:359-`, `runValidate` at `:323-`): a file missing each of
  `BOT_ENV_FILE`, `BOT_OPS_CONFIG_DIR`, `BOT_OPS_COMPOSE_FILE` in turn -> non-zero exit and stderr naming that key
  (`<KEY> is missing from`), not a silent exit.
- **E4 (item 3):** a harness slicing `download`, `fetch` and `fetch_in_place` with a `curl` stub that writes given
  content to `-o`'s path, `chown` recorded: (a) an existing destination file -> content replaced, and under
  `skipIf(win32)` `statSync(dest).ino` unchanged; (b) no destination -> created with the content; (c) a destination
  that is a symlink (skipIf win32) -> replaced by a regular file (the `mv` branch), the link's target untouched;
  (d) an existing destination at mode 0600 (skipIf win32) -> mode 0644 afterwards, inode unchanged, and the chown
  recorder shows `4242:4343 <dest>`; and a source pin that `fetch_in_place`'s in-place branch is guarded by `-O` and
  that the compose line in `main` calls `fetch_in_place` while the `.env.example` and `bot-ops.sh` paths do not.
- **Existing tests to update:** `runBranchGate`'s `fetch` probe (`:652`) also needs a `download` probe, because the
  `.env` branch now calls `download` + `mv`: add `download() { echo "FETCH:$1"; DOWNLOADED=/dev/null; }` and
  `mv() { :; }` to its stubs so `:697`'s `toContain(".env.example")` still holds. `runNameGate` (the #567 harness,
  Grep `runNameGate`; `ops/install.test.ts:1211` at main) also runs the `.env` block and has no `download`/`mv`
  stub: round 1 saw its control test exit 127 after 1c. Give it the same two stubs. Then Grep the file for any other
  slice that includes the `.env` block or the compose `fetch` line.

### Step 3 -- docs

- A2's `ops/README.md` paragraph (Grep `mounted into the admin container as a single file`): "`docker-compose.yml`
  is mounted into the admin container as a single file; since #486 `install.sh` rewrites it in place, so a re-run
  reaches a running admin without a recreate. An admin container started before that change still holds the old
  file until it is recreated once -- re-run `install.sh`'s printed step 4 with `--force-recreate` added before
  `admin` -- and the banner names that remedy for exactly this case." Keep the "never a bare `--force-recreate
  admin`" clause.
- `CONTEXT.md`: the `#230` / A2 bullet that says the compose half needs the admin recreated (Grep `force-recreate`
  in `CONTEXT.md`): "once, for an admin started before #486; after that a re-run is enough". The
  `ops/install.sh` file-map row: `fetch_in_place` for the compose file (#486), the token patched before the move,
  `validate_stack_env` naming a missing key. The config-dir gotcha's sentence on what writes the secrets `.env`
  (if O2's `CLAUDE.md` wording landed, mirror it here once).
- `ops/README.md`'s install paragraph that says "re-running install.sh picks up compose changes" (Grep `picks up` in
  `ops/README.md`, near `:105-120`): true for the bot always; for a running admin since #486.

### Mutation table (detached scratch worktree; `bun test ops/install.test.ts` per mutant)

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | the guard's condition replaced by `false` (`if false; then`: always the `else` branch) | E1 (a), alone |
| M2 | `sed -i` moved back after the `mv` (patching the final path) | E1 (c) `MV_SRC_TOKEN` |
| M2b | the "already set" line prints the value | E1 (a) (`abc` absent) |
| M3 | `download`'s chown -> `chown "$(id -u):$(id -g)"` | E2 (a) |
| M3b | the stack `.env` chown -> `$(id -u):$(id -g)` | E2 (a) write-sequence case |
| M3c | `bootstrap_dir`'s `sudo chown` -> `$(id -u):$(id -g)` | E2 (b) |
| M3d | the `backups/` chown -> `$(id -u):$(id -g)` | E2 (c) if the harness reaches `:286`; else name it unpinned in the PR |
| M4 | `|| true` dropped from `validate_stack_env`'s reads | E3 |
| M5 | `fetch_in_place`'s `cat >` branch replaced by `mv` | E4 (a) inode |
| M5b | the compose line back to `fetch` | E4 source pin |
| M5c | the `chmod "$2" "$3"` after the `cat >` dropped | E4 (d) mode (skipIf win32: CI) |
| M5d | the `-O "$3"` condition dropped | E4 `-O` source pin |

M5: round 1 found inodes stable on this Windows box and the mutant failed the inode assertion here, so the inode
check need not be `skipIf(win32)`; keep it unskipped if it passes on the fixed code here, else skip and name it
CI-only. M3d: E1's slice starts at `mkdir -p "$CONFIG_DIR/backups"`, so E2 (c) records the `backups/` chown; assert it.

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #424: an existing operator `.env` survives a re-run | (test) + 1c | E1 | M1 |
| #425: every chown uses `DEPLOY_UID:DEPLOY_GID` | (test) | E2 | M3, M3b, M3c, M3d |
| #486-2: a missing stack `.env` key is named | 1a | E3 | M4 |
| #486-3: a running admin sees a re-run's compose file, with its mode and owner set | 1b, 3 | E4 | M5, M5b, M5c, M5d |
| #486-9: the token is never half-written at the final path; a re-run says where it is | 1c | E1 | M2, M2b |
| #486-10: the GIT_SHA comment promises only what holds | 1d | lens-B audit | -- (comment) |

### Verification

```bash
bun install --frozen-lockfile
bunx tsc --noEmit -p ops/tsconfig.json
bun run check
bun test ops/install.test.ts
bun test        # background, alone
```

Not verifiable on MILE: E4's inode assertion and E1's mode assertion (`skipIf(win32)`, CI's Linux runs them); a real
admin container seeing the in-place write (an operator check after deploy: re-run `install.sh`, then
`docker exec rackbops-discord-bot-debug-admin sh -c 'grep -m1 x-rackbops-schema "$BOT_OPS_COMPOSE_FILE"'` shows the
new stamp without a recreate -- on an admin recreated once after this lands).

### Acceptance to paste per issue

- **#424:** E1's pass lines; M1 failing output.
- **#425:** E2's pass lines; M3-M3d failing output.
- **#486:** E3/E4 pass lines; M2, M4, M5b failing output (M5 from CI); the new comment text for item 10; a pointer
  to O2's PR for item 8.

### PR

- Title: `fix(ops): pin the operator .env and every chown, name a missing stack .env key, refresh the compose file in place, patch the admin token before it lands, and keep the GIT_SHA comment honest (#424, #425, #486)`.
- Body: per child, Decisions 1-6 (Decision 3's transition prominently), the output, the mutation table with the
  CI-only rows named. End with `Closes #424. Closes #425. Closes #486.`
- After merge: tick #424, #425, #486 on #531; comment on #464 that its item 5's root cause is fixed here (A2 closed it
  by reference); if every #531 child is closed, post the sub-epic's closing comment (declines: #474 item 7) and tick
  #531 on #516.

### Out of scope, on purpose

- Mounting the stack directory instead of the file (Decision 2).
- Changing A2's log-line and banner strings (Decision 3: still correct).
- Pinning `BOT_BUILD_CONTEXT` to the sha (Decision 5).
