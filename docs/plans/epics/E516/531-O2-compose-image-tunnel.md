<!-- Plan for #531 bundle O2 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #531): the compose file, the image
and the tunnel docs -- #422, #423, #426, #487 (ops-install-compose-images-11 to -15), and #486's item 8 (the stale
next-steps test comment, which sits beside #422's new test). Written by the orchestrating session on 2026-10-17;
every `file:line` below was read at main `4cfbebd`. Re-find each anchor by its quoted text on the tree you cut from.
Touches `docker-compose.yml` (comments only), `entrypoint.sh`, `.dockerignore`, `ops/install.sh` (the step-5 lines of
the printed next-steps heredoc only), `ops/install.test.ts` (the next-steps describe), `ops/docker-compose.test.ts`,
`README.md` (the Cloudflare Tunnel section), `ops/README.md` (the build-context paragraph), `CONTEXT.md` (two file-map
rows) and `CLAUDE.md` (one sentence). O1 (`install.sh`'s `.env`, chown, compose-write and validation regions) edits
other lines of `ops/install.sh` and `ops/install.test.ts`: cut O1 after this merges, or merge main into it. O3
(`bot-ops.sh`) shares no file except `ops/README.md`/`CONTEXT.md`, in other paragraphs. Also touched (round 1):
`docs/adr/0001-...` (one appended line), and comments in `src/redeploy.ts` / `src/redeploy.test.ts`.
Audited read-only in round 1 (a Sonnet agent; N1, N2, S1 drafted and run on a scratch copy; no `docker compose`
here, so C1/C2 reasoned): applied: N2 could never pass on MILE -- the splice the old NOTE blamed on bash's heredoc
is Bun's Windows argv halving `\\` under `-c` -- so `renderNextSteps` now feeds the script on stdin (R0) and N2
pins all four step-3 continuations (one changed survived the first draft); six more sites state the old tunnel
target (`ops/README.md:1662`, `CONTEXT.md:1275`, step 5's own prose, the README tunnel intro, two `redeploy` code
comments, ADR-0001) and are now in Step 1c; S4 guards the README command; C2 uses `COMPOSE_PROFILES` and drops the
admin build-context workaround (an active admin profile with no `ops/admin/` already renders on CI); S1 pins the
`getent` line; the compose `env_file:` comment says restart/recreate. -->

## Implementation plan -- #531 O2: the tunnel step can no longer touch the bot, the compose comments and tunnel docs say what install.sh and the bot do, the compose test pins the build context and the documented invariants, the image drops to `bun` with a usable HOME, and `.dockerignore` excludes what it means to

Children: **#422** (closes), **#423** (closes), **#426** (closes), **#487** (closes: items 11-15), and **#486 item 8**
(the rest of #486 is O1's; #486 closes with O1). One PR, branch `fix/531-O2-compose-image-tunnel`, worktree
`S:\Repos\_wt\rdb-531-O2` cut from `origin/main`. Behaviour changes (the printed step 5, the container's `HOME`, the
build context sent to the daemon): three-reviewer gate.

### What is wrong, verified at `4cfbebd`

- **#422.** The printed step 5 (`ops/install.sh:411-414`) ends `--profile tunnel up -d --build cloudflared`;
  `cloudflared` has `depends_on: - bot` (`docker-compose.yml:152-153`) and the bot has a `build:` section
  (`:13-27`), so the command can rebuild the bot from the branch tip and recreate it. `README.md:229-231` prints the
  same command. Step 4's "never rebuilds or recreates the running bot container" (`ops/install.sh:393-395`) holds
  only because `admin` has no `depends_on`. `--no-deps` appears nowhere in the repo.
- **#423.** `docker-compose.yml:14-20` says a deployed instance supplies `BOT_BUILD_CONTEXT` "as a shell var on the
  build invocation itself" and that it is "NOT persisted in .env: nothing rebuilds via `docker compose --build` after
  the initial bring-up"; `:42-45` says "ops/bot-ops.sh and ops/install.sh both export BOT_ENV_FILE". Since #169
  `install.sh` writes `BOT_ENV_FILE` and `BOT_BUILD_CONTEXT` into the stack `.env` (`ops/install.sh:340-345`), and the
  printed step 2 is a bare `up -d --build` that rebuilds from it. `ops/README.md`'s build-context paragraph (Grep
  `one-shot` in `ops/README.md`, near `:219-226`) calls the context "a one-shot shell variable on that single
  invocation" and then, two sentences later, says it is written into the stack `.env`.
- **#426.** `ops/docker-compose.test.ts:111` "a bootstrapped instance's stack .env overrides every monorepo-era
  fallback" writes `BOT_BUILD_CONTEXT=https://example.invalid/repo.git#main` and `GIT_SHA=deadbeef` (`:128-129`) but
  asserts only `container_name`, the env-file marker and `BOT_ENV_FILE` (`:135-151`); the absolute-path test
  (`:215-`) has the same gap.
- **#486 item 8.** The NOTE at `ops/install.test.ts:531-539` says bash's unquoted heredoc splices every
  `\<newline>`, so steps 3-5 "collapse onto one run-on line". The source writes `\\` before each newline
  (step 3 at `ops/install.sh:370-373`, steps 4/5 below it), which an unquoted heredoc prints as one backslash with the
  newline kept (round 1 ran it in Git Bash: `od` showed `\` then `\n`). The splice the NOTE saw is the TEST'S
  doing: `renderNextSteps` passes the script as `Bun.spawn([BASH, "-c", script])`, and on Windows Bun's argv
  quoting halves `\\` to `\` before bash sees it (the same script fed on stdin, `bash -s`, keeps `\\`). On Linux CI
  `-c` passes it intact.
- **#487 item 11.** `entrypoint.sh:15-19` drops to `bun` with `setpriv --reuid bun --regid bun ...`; `setpriv` changes
  ids only, and compose starts the container as `user: "0:0"` (`docker-compose.yml:66`), so `HOME` stays `/root`
  (mode 0700, unreadable to `bun`).
- **#487 item 12.** `README.md:236`: "Map a public hostname to `http://bot:<WARBANDEER_INGEST_PORT>`". `.env.example:57-59`
  says to target the container NAME, "not the `bot` alias, which a self-update's replacement also carries", and the
  bot's own router answers plugins under `/<plugin-name>/` on `HTTP_PORT` (ADR-0007). The compose comments at
  `:76-77` ("dedicated to WARBANDEER_INGEST_PORT") and `:132-138` (the "Warbandeer character-linking endpoint" and a
  "Start with: docker compose --profile tunnel up -d --build") say the same old thing.
- **#487 item 13.** `docker-compose.test.ts` exercises interpolation only; nothing pins "no published ports"
  (`.env.example:56-57`), the cloudflared pin (`docker-compose.yml:140-142`, `cloudflare/cloudflared:2026.9.3`), the
  `state:/app/data` volume (`:54`), or the bot's `restart: unless-stopped` / `init: true` (`:67-68`).
- **#487 item 14.** `.dockerignore` lists `node_modules/`, `data/`, `.env`, `.env.example`, `.gitignore`, `*.md`,
  `Dockerfile`, `docker-compose.yml`, `**/*.test.ts`: root-anchored, no `.git`, no nested `node_modules`
  (`ops/admin/node_modules`), no `.env.*` variants. The Dockerfile COPYs named paths only (`package.json bun.lock`,
  `src`, `entrypoint.sh`), so nothing leaks into the image today; a local `up --build` sends the history to the
  daemon.
- **#487 item 15.** `CLAUDE.md:66-67` says the secrets `.env` is "never touched again by anything but the
  operator"; `bot-ops.sh env-set` (the panel's saves) rewrites it, and `install.sh` writes the one generated
  `ADMIN_TOKEN` line when it creates the file. `CONTEXT.md:200` (the `docker-compose.yml` row) calls the cloudflared
  sidecar "for exposing a future local API"; `CONTEXT.md:201` (the `ops/docker-compose.test.ts` row) lists only the
  #41 tests.

### Decisions (defaults, named so the gate can contest them)

1. **#422: step 5 becomes `--profile tunnel up -d --no-deps cloudflared`**, `--build` dropped (cloudflared is a
   pinned image with no build section, so `--build` did nothing for it but build the bot). Same in `README.md`'s
   deployed-instance command. The local-dev command (`README.md:220`, `GIT_SHA=... docker compose --profile tunnel up
   -d --build`) stays: building the checkout's bot is the point there. Step 5 gains the sentence step 4 has: it
   names the cloudflared service and passes `--no-deps`, so it never builds, starts or recreates the bot.
2. **#423: comments and docs only; no compose schema bump.** `x-rackbops-schema` (`docker-compose.yml:1-9`) is bumped
   for a change "an instance must pick up"; a comment is not one, so it stays `1`.
3. **#487 item 11: `HOME` from the passwd entry.** In the root branch, before either `exec setpriv`:
   `HOME="$(getent passwd bun | cut -d: -f6)"; export HOME="${HOME:-/home/bun}"`. The `bun` user's home is read, not
   assumed; the fallback covers an image without `getent`. The non-root branch is unchanged (its HOME is already the
   user's).
4. **#487 item 12: the tunnel target is the container name and the port the endpoint listens on** -- both facts
   already in `.env.example` (`:57-59` for `HTTP_PORT`, `:82-86` for `WARBANDEER_INGEST_PORT`). Nothing here claims
   which port the warbandeer plugin uses today (plugin code is outside this repo); the README names both cases.
5. **#487 item 14: add, do not reshuffle.** Append `.git`, `**/node_modules`, `**/.env`, `.env.*`, with a header
   comment that the Dockerfile COPYs named paths only, so this file bounds what a local build SENDS, not what the
   image holds. The existing lines stay (removing `Dockerfile`/`docker-compose.yml` is churn with no effect).
6. **#487 item 15: `CLAUDE.md` says what writes the file.** "never touched again by anything but the operator"
   becomes "never overwritten by `ops/install.sh` (it writes the one generated `ADMIN_TOKEN` line when it creates the
   file); after that only the operator changes it, by hand or through the panel's saves (`bot-ops.sh env-set`, which
   backs it up first)". This is the repo's own instructions file; the edit is a factual correction.

### Step 1 -- `ops/install.sh` (step 5 only) and `README.md`

1a. The printed step 5 (`ops/install.sh:407-416` at main; re-find by `5. Optional`): the command's last line
becomes `     docker compose -f $STACK_DIR/docker-compose.yml -p $PROJECT --profile tunnel up -d --no-deps cloudflared`.
The prose is rewritten to the same facts as Step 1b: "Optional: expose the bot's own HTTP endpoints (HTTP_PORT,
docs/adr/0007, or the warbandeer plugin's WARBANDEER_INGEST_PORT) through a Cloudflare tunnel, without opening any
inbound firewall ports. Point the tunnel's public hostname at this bot's container name, $PROJECT, not the `bot`
alias (see README.md's Cloudflare Tunnel section)." Keep, verbatim, the sentence ending "never gets the rest of
your secrets" (`ops/install.test.ts:1055` pins it), and add: "The command names the cloudflared service and passes
--no-deps, so it never builds, starts or recreates the running bot container (cloudflared's depends_on would
otherwise pull the bot in)." Keep the `\\` continuation on the token line.

1b. `README.md:229-231`: the deployed-instance command's last line becomes `-p rackbops-discord-bot-<instance>
--profile tunnel up -d --no-deps cloudflared`, with one sentence after the block on `--no-deps` (Decision 1).
`README.md:236-237` becomes: "Map a public hostname, in the tunnel's **Public Hostname** settings, to the bot's
container NAME -- `http://rackbops-discord-bot-<instance>:<port>` on a deployed instance (`warbandeer-discord` in a
local checkout), never the `bot` alias, which a self-update's replacement also carries for a while -- and the port
the endpoint listens on: `HTTP_PORT` for a plugin served by the bot's own HTTP router (under `/<plugin-name>/`,
ADR-0007), or `WARBANDEER_INGEST_PORT` for the warbandeer plugin's own ingest server." Step 2 of that list
(`README.md:213`) gains `HTTP_PORT` as the alternative. The section's intro (`README.md:208-210`, "the bot's local
API (currently: the character-linking endpoint above)") becomes "the bot's own HTTP endpoints (the plugin router on
`HTTP_PORT`, ADR-0007, or the character-linking endpoint above)"; `README.md:171-172` ("only reachable through the
Cloudflare Tunnel below") stays true and is left alone.

1c. The other sites that state the old `http://bot:` mapping or call the tunnel dedicated to
`WARBANDEER_INGEST_PORT` (round 1 found them; each gets the container-name / both-ports fact in its own words, or
a sentence that it was superseded):
- `ops/README.md:1662-1663` ("a separate tunnel dedicated to `WARBANDEER_INGEST_PORT`").
- `CONTEXT.md:1275-1279` ("reachable at `http://bot:<WARBANDEER_INGEST_PORT>`").
- `src/redeploy.ts:212` and `src/redeploy.test.ts:441`: comments that cite "`http://bot:<port>` (README's
  documented tunnel mapping)". Read each: if the comment's point is that the `bot` alias is carried by both
  containers during an overlap, keep that point and drop the claim that the README documents `http://bot:` (it now
  says not to use it). Comment-only edits; no code change.
- `docs/adr/0001-http-ingest-behind-cloudflare-tunnel.md:12` (`http://bot:<port>`): the ADR body is a record and
  is not rewritten; append one line at the end of the ADR: "Amended (#487): the tunnel targets the bot's container
  name, not the `bot` alias, which a self-update's replacement also carries during the overlap."

### Step 2 -- `docker-compose.yml` comments (no schema bump)

- `:14-20` (bot `build:`): "Defaults to the local checkout (`.`) for `docker compose up -d --build` there. A
  deployed instance's stack `.env`, written by `ops/install.sh` (#169), sets `BOT_BUILD_CONTEXT` to
  `<repo-url>#<branch>`, so the printed `up -d --build` (and Dockge's buttons) rebuild from the branch with no
  checkout on the host. Self-update's own rebuilds go through the Docker Engine API (`src/redeploy.ts`), not this
  file."
- `:42-45` (`env_file:`): "A deployed instance's stack `.env` sets `BOT_ENV_FILE` to the config dir's `.env`
  (`ops/install.sh`, #169); `ops/bot-ops.sh` also passes it on its restart and recreate calls."
- `:76-77` (admin): "NOT via the `cloudflared` sidecar below, which is a separate, opt-in tunnel for the bot's own
  endpoints (see its comment)".
- `:132-138` (cloudflared): "Opt-in: exposes the bot's own HTTP endpoints (`HTTP_PORT`, ADR-0007; or the warbandeer
  plugin's `WARBANDEER_INGEST_PORT`) through a Cloudflare tunnel, without opening inbound firewall ports. Point the
  tunnel at the bot's container name, not the `bot` alias (README's Cloudflare Tunnel section). TUNNEL_TOKEN below
  is ... (keep the existing interpolation sentences). On a deployed instance start it with ops/install.sh's printed
  step 5 (`--no-deps`, so the bot is never touched); in a local checkout `docker compose --profile tunnel up -d
  --build`."

### Step 3 -- `entrypoint.sh`, `.dockerignore`

3a. `entrypoint.sh`: inside `if [ "$(id -u)" = "0" ]; then`, before the socket check, add Decision 3's two lines with
a comment: "#487: setpriv changes ids only; without this the bot runs as bun with HOME=/root (0700)". The header
comment's last sentence gains "and a HOME that is bun's own".

3b. `.dockerignore`: Decision 5.

### Step 4 -- docs

- `ops/README.md`'s build-context paragraph (Grep `one-shot`): "The compose file's `build.context` defaults to `.`
  (a local checkout). A deployed instance's stack `.env` sets `BOT_BUILD_CONTEXT=<repo>#<branch>` (written by
  `install.sh`), next to `GIT_SHA`, so the printed `up -d --build` and Dockge rebuild from the branch with no clone."
  Keep the rest of the paragraph (the `GIT_SHA` / self-update sentences) as it is. Replace the hard line cite
  `ops/install.sh:345` in that paragraph with the symbol (`the stack .env heredoc, STACKENV`).
- `CONTEXT.md:200` (`docker-compose.yml` row): "for exposing a future local API" -> "for exposing the bot's own
  HTTP endpoints (`HTTP_PORT`, or the warbandeer plugin's ingest port); start it with `--no-deps` on a deployed
  instance (#422)".
- `CONTEXT.md:201` (`ops/docker-compose.test.ts` row): append the later classes the file holds (Grep its describe
  names: #178 schema stamp, #135 admin's empty forwarded env, #169 absolute `-f`, #54 the tunnel token) and this
  bundle's (#426 the build context and `GIT_SHA`; #487 no published ports, the pinned cloudflared tag, the state
  volume, the bot's restart/init).
- `CLAUDE.md:66-67`: Decision 6.

### Step 5 -- tests

**`ops/install.test.ts`** (the next-steps describe at `:522-543`; `renderNextSteps` at `:503-520`):
- **R0 (the harness, needed by N2):** `renderNextSteps` feeds the script on stdin instead of `-c`:
  `Bun.spawn([BASH!, "-s"], { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" })`. Its comment says why:
  on Windows Bun's argv quoting halves `\\` in a `-c` argument, which spliced the continuations and misled the old
  NOTE; stdin carries the script byte for byte on both platforms. Every caller of `renderNextSteps` (`:523`,
  `:1049`) must stay green; run both describes.
- **N1 (#422):** a new test: the rendered step 5 (slice from `5. Optional` to the end) contains `--profile tunnel up
  -d --no-deps cloudflared` and does NOT contain `--build`; step 4's rendered command still ends `up -d --build admin`
  (unchanged; the guard against an over-eager edit).
- **N2 (#486 item 8):** the NOTE at `:531-539` is replaced by a correct comment (the source's `\\` prints a
  backslash and keeps the newline; the old splice was Windows argv halving under `-c`, fixed by R0), and the test
  asserts EVERY continuation: in the rendered step 3 slice, each of the four lines that start (after indentation)
  with `BOT_OPS_CONFIG_DIR=`, `BOT_OPS_COMPOSE_FILE=`, `BOT_OPS_PROJECT=`, `BOT_OPS_CONTAINER=` ends with ` \`
  (split the slice on `\n`, find each line, `expect(line.endsWith(" \\")).toBe(true)` naming the key); and the
  rendered steps 4 and 5 each contain at least one line ending in ` \` followed by an indented line (their token
  lines).

**`ops/docker-compose.test.ts`** (CI-only: skips without `docker compose`; on CI the module throws instead, #591):
- **C1 (#426):** in `:111`'s test add `expect(json!.services.bot!.build!.context).toBe("https://example.invalid/repo.git#main")`
  and `expect(json!.services.bot!.build!.args!.GIT_SHA).toBe("deadbeef")` (widen the local `ComposeConfig` type for
  `build`); the same two in the absolute-path test (`:215-`) with that test's own fixture values (add them to its
  stack `.env` if absent). This also settles whether `#main` survives Compose's dotenv parsing.
- **C2 (#487 item 13):** a new describe "the documented compose invariants hold (#487)": `composeConfig(dir,
  { COMPOSE_PROFILES: "admin,tunnel" })` (the helper already takes `extraEnv`; the existing #135 test at `:188-201`
  runs `config` with the admin profile active and no `ops/admin/` directory, green on CI, so no build-context
  workaround is needed), a stack `.env` as in `:111`'s test -> for each of `bot`, `admin`, `cloudflared`: no `ports` key (or an empty one);
  `cloudflared.image` matches `/^cloudflare\/cloudflared:\d{4}\.\d+\.\d+$/` (not `latest`); `bot.volumes` has an
  entry with `target: "/app/data"` and `source: "state"`; `bot.restart === "unless-stopped"` and `bot.init === true`;
  `admin.restart` and `cloudflared.restart` are `unless-stopped`.

**Source pins** (a new describe in `ops/docker-compose.test.ts`, NOT under `skipIf(!runnable)`: it only reads files,
so it runs on MILE too. On MILE the module-level `if (!runnable && process.env.CI) throw` (`:51`) does not fire, so
the file loads, the compose blocks skip and these run; on CI compose is present. Do not move the throw.):
- **S1 (#487 item 11):** `entrypoint.sh`'s root branch exports `HOME` before its first `exec setpriv` (index of
  `export HOME` < index of the first `exec setpriv`, both inside the `if [ "$(id -u)" = "0" ]` block), and the
  block contains `getent passwd bun` and the `/home/bun` fallback.
- **S2 (#487 item 14):** `.dockerignore` holds the lines `.git`, `**/node_modules`, `**/.env` and `.env.*`.
- **S3 (#423):** `docker-compose.yml` contains neither `NOT persisted in .env` nor `both export BOT_ENV_FILE`, and
  its bot `build:` comment names the stack `.env` (`stack .env` appears between `build:` and `context:`). A
  deleted-phrase pin plus one presence check; the rest of the wording is the lens-B audit's.
- **S4 (#422):** `README.md` contains `--profile tunnel up -d --no-deps cloudflared` and no line matching
  `/up -d --build cloudflared/` (the README command has no other guard).


### Mutation table (detached scratch worktree)

| # | Mutation | Test that must fail | Where it runs |
|---|---|---|---|
| M1 | step 5 back to `up -d --build cloudflared` | N1 | MILE |
| M1b | `--no-deps` dropped, `--build` kept out | N1 | MILE |
| M2b | ONE of step 3's four `\\` continuations changed to `\` (a splice), each tried | N2 (names the key) | MILE |
| M2c | `renderNextSteps` back to `-c` | N2 on MILE (Windows halves `\\`); passes on Linux -- name it | MILE |
| M8 | `README.md`'s command back to `up -d --build cloudflared` | S4 | MILE |
| M3 | `context: ${BOT_BUILD_CONTEXT:-.}` -> `context: .` | C1 | CI |
| M3b | the `GIT_SHA` build arg deleted | C1 | CI |
| M4 | `ports: ["8080:8080"]` added to bot | C2 | CI |
| M4b | cloudflared image -> `:latest` | C2 | CI |
| M4c | `- state:/app/data` deleted | C2 | CI |
| M4d | bot's `init: true` deleted | C2 | CI |
| M5 | the `export HOME` line deleted | S1 | MILE |
| M6 | `.git` removed from `.dockerignore` | S2 | MILE |
| M7 | the old `NOT persisted in .env` sentence restored | S3 | MILE |

The CI-only rows (M3-M4d) need `docker compose`, which MILE lacks. Do NOT push mutants to a branch to make CI run
them (CI on an unreviewed branch, and runner time for nothing). The evidence is CI's run of the unmutated branch
(C1/C2 pass) plus each mutant reasoned from the assertion it breaks; the PR names that gap.

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #422: the printed tunnel step never builds or recreates the bot | 1a, 1b | N1, S4 | M1, M1b, M8 |
| #423: compose comments and ops/README say the stack `.env` carries both values | 2, 4 | S3, lens-B audit | M7 |
| #426: the stack-.env test pins the build context and `GIT_SHA` | 5 | C1 | M3, M3b |
| #486-8: the next-steps comment is true (and names the real cause), and every continuation is pinned | 5 | R0, N2 | M2b, M2c |
| #487-11: the bot runs with bun's HOME | 3a | S1 (+ Rod's container check) | M5 |
| #487-12: every site that states the tunnel target says the container name and the real port | 1a, 1b, 1c, 2 | lens-B audit | -- (docs) |
| #487-13: the documented invariants are tested | 5 | C2 | M4, M4b, M4c, M4d |
| #487-14: `.dockerignore` excludes `.git`, nested `node_modules`, `.env` variants | 3b | S2 | M6 |
| #487-15: CLAUDE.md and the two CONTEXT rows are true | 4 | lens-B audit | -- (docs) |

### Verification

```bash
bun install --frozen-lockfile
bunx tsc --noEmit -p ops/tsconfig.json
bun run check
bun test ops/install.test.ts ops/docker-compose.test.ts
bun test        # background, alone
```

Not verifiable on MILE: every `docker compose config` test (C1, C2) -- CI's Linux runs them; the real container's
`HOME` (an operator check on the debug instance after this deploys:
`docker exec rackbops-discord-bot-debug sh -c 'id; echo $HOME'` should print `uid=` for bun and `/home/bun`); the
build context a local `up --build` sends (no daemon here).

### Acceptance to paste per issue

- **#422:** N1's pass line; the rendered step 5 text; M1/M1b failing output.
- **#423:** the new comment text; S3's pass line.
- **#426:** C1's pass line from CI's log.
- **#487:** S1/S2 pass lines; C2's pass line from CI's log; the README tunnel paragraph; the CLAUDE.md sentence.
- **#486 item 8:** N2's pass line.

### PR

- Title: `fix(ops): keep the tunnel step off the bot, correct the compose and tunnel docs, pin the build context and the compose invariants, give the bot bun's HOME, and widen .dockerignore (#422, #423, #426, #486, #487)`.
- Body: per child, Decisions 1-6, the output, the mutation table with the CI-only rows named. End with
  `Closes #422. Closes #423. Closes #426. Closes #487. Part of #486 (item 8).`
- After merge: tick #422, #423, #426, #487 on #531; comment on #486 that item 8 landed here; comment on #488 (docs
  sub-epic #533) that `docs-readme-adr-claude-5`, `-6`, `-8` share this root cause and can be re-checked against it.

### Out of scope, on purpose

- `install.sh`'s other items (#424, #425, #486 items 2, 3, 9, 10): O1.
- Which port the warbandeer plugin really listens on (plugin repo).
- Any compose change an instance must pick up (none here; no schema bump).
