# Research: adding CI (GitHub Actions) to this repo

Date: 2026-09-03
Scope: research only, no workflow files written. Primary sources only — the actions'
own READMEs/`action.yml`, Bun's own docs (`bun.com/docs`, `bun.sh/guides`), GitHub's
own docs, and this repo's/sibling repos' actual files (read directly, plus one
empirical `bun test` run in this working directory). Answers the seven numbered
questions from the task; does not recommend a single final CI design.

## Repo facts confirmed as part of this research (in addition to the ones already given)

- `bun.lock` (Bun's native text lockfile) exists at **both** `R:\repos\rackbops-discord-bot\bun.lock`
  and `R:\repos\rackbops-discord-bot\ops\admin\bun.lock` — two independent lockfiles, not one
  shared workspace lockfile. Neither `bun.lockb` (the old binary format) exists anywhere.
- Root `package.json` has **no `workspaces` field** (`Grep -n "workspaces" package.json` → no
  match) — confirmed directly, not inferred. Root's `bun.lock` also has no `"jose"` entry
  anywhere (`Grep '"jose"' bun.lock` → no match), and `ops/admin/node_modules/jose` exists while
  `node_modules/jose` at the repo root does not. So root and `ops/admin` are two genuinely
  independent Bun installs, not a workspace — root's `bun install` does not touch `ops/admin`.
- Root `tsconfig.json`: `"include": ["src"]` only — `bunx tsc --noEmit` run from the repo root
  cannot and does not typecheck anything under `ops/admin/`. `ops/admin` has no `tsconfig.json`
  of its own at all (confirmed: file absent), so its `tsc --noEmit` run (from that directory)
  falls back to TypeScript's implicit/default config over whatever `.ts` files it discovers
  there.
- **Empirically verified in this working directory**: running `bun test` from the repo root
  (no path argument) does not stop at `src/` — it recursed into `ops/admin/server.test.ts` and
  ran it too, in the same process, alongside every root test file:

  ```
  ops\admin\server.test.ts:
  [admin] couldn't read the dynamic admin list -- failing closed to bootstrap-only: ...
  ...
   491 pass
   0 fail
   883 expect() calls
  Ran 491 tests across 18 files. [19.33s]
  ```

  This works right now only because `ops/admin/node_modules` (containing `jose`) already exists
  in this checkout from a prior `bun install` run inside `ops/admin`. Bun/Node module resolution
  is resolved relative to the *importing file's* location, walking up from `ops/admin/server.test.ts`
  to find the nearest `node_modules` — not relative to the process's current working directory —
  so a root-level `bun test` finds `ops/admin`'s own `jose` install once it exists. On a fresh CI
  checkout, `node_modules` doesn't exist anywhere yet: a root-only `bun install` would leave
  `ops/admin/node_modules` absent (root's lockfile carries no `jose` entry, confirmed above), so
  `ops/admin/server.test.ts`'s `import ... from "jose"` would fail to resolve unless `bun install`
  is **also** run inside `ops/admin` first. This is inferred from the confirmed lockfile/resolution
  facts, not separately verified by deleting `node_modules` in the working tree.
  **Net effect: a single root `bun test` invocation can cover both projects' test suites, but only
  after both projects have had `bun install` run in them.** The typecheck has no equivalent
  shortcut — it genuinely needs two separate `tsc --noEmit` invocations (one per directory) because
  of the `tsconfig.json` `include` scoping above.
- `main` is **currently unprotected** on GitHub, confirmed via the API directly:
  `gh api repos/roshne/rackbops-discord-bot/branches/main/protection` → `404 Branch not protected`.
  The repo is public (`"private": false`) and the querying user has full admin/push rights
  (`gh api repos/roshne/rackbops-discord-bot --jq .permissions` → `admin: true, push: true`).
- No `.github/workflows/*.yml` in this repo currently runs `bun install`/`bun test`/`tsc` at all —
  `push-notify.yml` is the only workflow and it's a Discord-notification hook on `push: [main]`,
  unrelated to checks.

## 1. Installing Bun in Actions: `oven-sh/setup-bun` vs. `actions/setup-node`'s `cache:` option

**`oven-sh/setup-bun`** is the action Bun's own docs point to. Its current major version tag is
**`@v2`** (currently resolving to `v2.2.0`, released 2026-03-14 per
`gh api repos/oven-sh/setup-bun/releases/latest`). Confirmed inputs from the action's own
`action.yml` (fetched directly from `oven-sh/setup-bun`'s `main` branch):

```yaml
inputs:
  bun-version:        # "latest", "canary", "1.0.0", "1.0.x", <sha>
  bun-version-file:    # e.g. "package.json", ".bun-version", ".tool-versions"
  bun-download-url:
  registries: / registry-url: / scope:
  no-cache:            # default false — "Disable caching of bun executable."
  token:
outputs:
  bun-version: / bun-revision: / bun-path: / bun-download-url: / cache-hit:
runs:
  using: "node24"
  main: "dist/setup/index.js"
  post: "dist/cache-save/index.js"
```

**Important nuance on caching**: the action's `no-cache` input and its `post` step
(`dist/cache-save/index.js`) only cache **the downloaded Bun executable itself**, so a repeat
run doesn't re-download the Bun binary. It does **not** cache the project's installed
dependencies (Bun's package/install cache at `~/.bun/install/cache`, analogous to npm's
`~/.npm`). This was asked and answered directly by a Bun maintainer in
[oven-sh/setup-bun#14](https://github.com/oven-sh/setup-bun/issues/14) (open, no code change
landed):

> "We haven't implemented dependency caching yet, because early testing showed `bun install`
> was faster than using Github's caching mechanism." — Electroid (Bun maintainer)

The community workaround, documented in that same thread, is a manual `actions/cache` step
keyed on the lockfile hash:

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.bun/install/cache
    key: ${{ runner.os }}-bun-${{ hashFiles('**/bun.lockb') }}
    restore-keys: |
      ${{ runner.os }}-bun-
```

(Note the example keys on `bun.lockb`, the old binary lockfile; this repo's lockfiles are the
newer text `bun.lock`, so the `hashFiles` glob would need to target `**/bun.lock` instead.) A
companion thread, [oven-sh/setup-bun#48](https://github.com/oven-sh/setup-bun/issues/48)
("How to cache 'bun global cache' on pipeline?"), was closed `not_planned` with the same
pointer to `actions/cache` as the only current mechanism. Reported real-world savings in #14 are
mixed — several commenters measured the cache-restore step costing as much or more than a plain
`bun install` on a small dependency set (one measured install dropping from 21s to 8s but cache
restore itself costing 19s; another explicitly called the net effect "a bit of a wash").

**`actions/setup-node`'s `cache:` option does NOT support Bun**, confirmed directly from its
current `action.yml` (fetched from `actions/setup-node`'s `main` branch):

```yaml
cache:
  description: 'Used to specify a package manager for caching in the default directory. Supported values: npm, yarn, pnpm.'
```

The literal string is "npm, yarn, pnpm" — no `bun`. The feature request asking for this,
[actions/setup-node#1034](https://github.com/actions/setup-node/issues/1034) ("Add support for
cache type `bun`"), is closed with `state_reason: completed`, but reading the actual comments
(via `gh api repos/actions/setup-node/issues/1034/comments`) shows no bun support was added —
the resolution was a maintainer (`silverwind`) redirecting the request to `setup-bun`'s own
repo ("I think such a cache should likely be part of
https://github.com/oven-sh/setup-bun") and a `setup-node` maintainer (`ItsHarper`) pointing out
the request was filed against the wrong repo entirely. The "completed" label appears to be a
housekeeping closure, not a shipped feature — the live `action.yml` text above is the
authoritative, current answer either way.

**Comparison / which is more current:** `oven-sh/setup-bun@v2` is unambiguously the
recommended, Bun-specific installer — it's what Bun's own docs use in every example (see §2) and
what this repo's own upstream (`nazumods/wow`, see §7) already uses. `actions/setup-node` has no
role here at all for a pure-Bun repo; its `cache:` input is npm/yarn/pnpm-only by its own current
documentation, not a Bun alternative.

## 2. Bun's own official CI documentation

Bun's docs site (`bun.com`/`bun.sh`, same content, both domains resolve) has two short,
dedicated CI guide pages, both fetched directly:

**[Install dependencies with Bun in GitHub Actions](https://bun.sh/guides/install/cicd)**
(`bun.sh/guides/install/cicd`) gives this as its complete recommended workflow:

```yaml
name: my-workflow
jobs:
  my-job:
    name: my-job
    runs-on: ubuntu-latest
    steps:
      # ...
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2

      # run any `bun` or `bunx` command
      - run: bun install
```

Notably, this official guide does **not** mention `--frozen-lockfile` at all — the example is a
plain `bun install`. To pin a specific Bun version it shows `bun-version: "latest"` /
`bun-version: "canary"` as `setup-bun` inputs, not a `bun install` flag.

**[Install and run Bun in GitHub Actions](https://bun.sh/guides/runtime/cicd)**
(`bun.sh/guides/runtime/cicd`) is the "run" counterpart and is equally minimal:

```yaml
name: my-workflow
jobs:
  my-job:
    name: my-job
    runs-on: ubuntu-latest
    steps:
      # ...
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2

      # run any `bun` or `bunx` command
      - run: bun install
      - run: bun index.ts
      - run: bun run build
```

Neither guide mentions `bun test`, a `--ci` flag, or exit-code behavior directly — the CI-page
content is deliberately generic ("run any `bun` or `bunx` command"), not test-specific.

**Bun's dedicated test-runner docs** (`bun.com/docs/cli/test`, the "Test runner" reference page,
not the two CI guides above) cover the CI-specific behavior that actually matters for a workflow:

- **Non-zero exit on failure** — "If a test fails, the test runner exits with a non-zero exit
  code," which is exactly what a CI job step needs to fail the job; no extra flag required.
- **Automatic GitHub Actions annotations** — "`bun test` automatically detects when it's running
  inside GitHub Actions and emits GitHub Actions annotations to the console directly," i.e.
  failures show up as inline annotations on the diff/PR without any extra reporter
  configuration.
- **JUnit output available if wanted**: `--reporter=junit --reporter-outfile=./bun.xml`, "popular
  for reporting test results in CI/CD pipelines" — relevant only if something downstream
  consumes JUnit XML, which nothing in this repo currently does.
- The page also documents test **sharding** across multiple CI jobs for large suites, not
  relevant at this repo's current test count (491 across 18 files, ~19s locally per the
  empirical run above).
- No `--ci` flag is documented anywhere on this page, and no mention of watch mode needing to be
  disabled in CI (watch mode is opt-in via `--watch`, never implied by default).

## 3. Workflow structure for two sibling `package.json` projects (root + `ops/admin/`)

**They are not a Bun workspace** — confirmed in the repo-facts section above: no `workspaces`
field in root `package.json`, two separate `bun.lock` files, `ops/admin`'s dependency (`jose`)
absent from root's lockfile entirely. Bun's own workspace docs
([bun.com/docs/pm/workspaces](https://bun.com/docs/pm/workspaces), fetched via search summary of
the official docs) describe workspaces as requiring exactly that root `"workspaces": [...]` glob
field — its absence here is the deciding fact, not a matter of interpretation. So this is
structurally "two unrelated projects that happen to share a repo," exactly as the task
description anticipated, and each needs its own `bun install` (confirmed: root install does not
populate `ops/admin/node_modules`).

**What the empirical `bun test` run changes**: because Bun's default test discovery recurses
from the invocation's working directory and resolves each test file's imports relative to that
file's own location, a *single* `bun test` invoked from the repo root — once both `bun install`s
have been run — already executes both suites together (confirmed: the run above shows
`ops\admin\server.test.ts:` output interleaved with root's own test files, 491 passing across 18
files). This means the **test** step doesn't strictly need a matrix or a second job to get
coverage of both projects — only both `bun install`s need to happen first, e.g. `bun install &&
bun install --cwd ops/admin && bun test` (or two separate install steps with different
`working-directory:` values, then a single un-scoped `bun test` at the end).

The **typecheck** step has no such shortcut: root's `tsconfig.json` scopes to `"include": ["src"]`
and `ops/admin` has no `tsconfig.json` of its own, so `bunx tsc --noEmit` genuinely has to run
twice, once per directory, to cover both.

No primary source (Bun's own docs, `setup-bun`'s README, or the internal precedents found — see
§7) prescribes one specific shape (single job vs. matrix vs. two jobs) for this situation
specifically — Bun's workspace docs describe true workspaces (a shared lockfile, `bun install
--filter`), which doesn't apply here since these are independent projects. The internal
precedents in §7 show **both** shapes already in use across this user's own repos: `research-triage`
uses two separate jobs (`backend`/`frontend`, each `runs-on` its own runner, no shared setup
step) for its own two-sibling-project shape; `wow`'s `app-test.yml` uses a **single job** with
multiple `working-directory:`-scoped steps to cover two related-but-separate TypeScript projects
(`apps/warbandeer-desktop` + `apps/bot-ops`) in one runner. Neither precedent is a Bun+Bun pair
(both use npm), so neither directly demonstrates the "single un-scoped `bun test` covers both"
shortcut found above — that shortcut is specific to Bun's resolution behavior and was not
previously exercised in any sibling repo checked.

## 4. Validating the Docker build in CI without secrets

**`docker/build-push-action`** (GitHub's/Docker's own action, fetched from its README) builds
with Buildx and, per the `push` input's own description:

> "[Push](https://docs.docker.com/engine/reference/commandline/buildx_build/#push) is a
> shorthand for `--output=type=registry` (default `false`)"

So `push: false` (or simply omitting `push`, since it already defaults to `false`) is the
standard "build-only, no publish" mode — no separate flag needed beyond not setting `push: true`
and not configuring registry login. The README documents GitHub Actions cache integration via
`cache-from`/`cache-to` with `type=gha`, usable on a build-only job the same as a push job.

**Does `docker compose build` need real `.env` values?** Reading this repo's own
`docker-compose.yml` directly (already partly summarized in the task, re-confirmed here in full):
every variable the `admin` service needs (`ADMIN_TOKEN`, `CLOUDFLARE_ACCESS_TEAM_DOMAIN`,
`CLOUDFLARE_ACCESS_AUD`, `ADMIN_ALLOWED_EMAILS`, `BOT_OPS_CONFIG_DIR`, `BOT_OPS_COMPOSE_FILE`)
is interpolated with a `${VAR:-}` (empty-string) or `${VAR:-default}` fallback, e.g.:

```yaml
environment:
  - ADMIN_TOKEN=${ADMIN_TOKEN:-}
  - CLOUDFLARE_ACCESS_TEAM_DOMAIN=${CLOUDFLARE_ACCESS_TEAM_DOMAIN:-}
```

and the two bind-mount paths use the same pattern with a placeholder default:

```yaml
volumes:
  - ${BOT_OPS_CONFIG_DIR:-/nonexistent-set-BOT_OPS_CONFIG_DIR}:${BOT_OPS_CONFIG_DIR:-/nonexistent-set-BOT_OPS_CONFIG_DIR}
```

None of these are `${VAR:?required}` (hard-fail) interpolations — the compose file's own
in-repo comments state this was deliberate ("a `:?` on this service would break a plain `docker
compose up -d --build` for the *bot* service too ... verified: it does, immediately, with no
`--profile admin` in sight"). So `docker compose build` (or `--profile admin build`) for this
file needs **no real secret values at all** to succeed — every admin-service variable has a
falsy/placeholder default and none are required at parse time. A CI job could therefore run
`docker compose build` (default `bot` service only, since `admin`/`tunnel` are behind
`profiles:`) or `docker compose --profile admin build` (also builds `ops/admin`'s own
`Dockerfile`) with zero environment setup and it would build successfully — this is a direct
reading of the compose file's own `:-` defaults, not something requiring a live test in this
research pass. `docker build .` alone (bypassing compose) would also work identically for the
root `Dockerfile`, since it takes no build args beyond the already-defaulted `GIT_SHA`.

## 5a. Branch protection / required status checks for a solo-maintainer repo

GitHub's own docs on protected branches
([docs.github.com/.../about-protected-branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches))
describe required status checks with two modes:

> Strict mode (default): "The branch **must** be up to date with the base branch before
> merging."
> Loose mode: "The branch **does not** have to be up to date with the base branch before
> merging."

and:

> "Required status checks must have a `successful`, `skipped`, or `neutral` status before
> collaborators can make changes to a protected branch."

The page **has no guidance at all aimed at solo-maintainer/single-contributor repos** — every
example and framing assumes multiple collaborators, reviews, and team workflows. It doesn't
argue for or against protection in a one-person setting one way or the other.

The mechanism the task asked about, `gh api repos/{owner}/{repo}/branches/main/protection`,
is real and was exercised directly against this repo: currently `404 Branch not protected`.
Setting protection is a `PUT` to the same endpoint (per GitHub's REST API reference for branch
protection, linked from the 404 response's own `documentation_url`); the practical effect for a
repo where the owner is also the only person with push access would be that the owner's own
pushes/merges are still gated by whatever checks are marked required — i.e. it would block the
*owner's own* squash-merge until CI is green, not add a second reviewer (there is no one else).
The one-person tradeoff (worth protection just to stop a merge before green CI, vs. redundant
paperwork on a solo repo governed entirely by `/pr`'s own CI-wait step) is a judgment call, not a
documented GitHub recommendation — left open below.

## 5b. `pull_request` vs. `push` triggers with a squash-merge-only workflow

A squash-merge **does** trigger a `push` event on the target branch — confirmed by GitHub's own
community discussions (not a doc page, but direct statements from GitHub staff/maintainers in
the linked threads): merging any PR, squash included, creates a new commit on the base branch,
and any push to that branch fires `on: push`. One relevant caveat found in
[a GitHub community discussion](https://github.com/orgs/community/discussions/179965): **path
filters (`paths:`) on a `push` trigger can behave unreliably after a squash merge**, because the
squashed commit's file-change metadata doesn't always carry the same per-file diff information a
normal push would — a known rough edge if this repo ever added `paths:` scoping to a `push:
[main]` workflow.

Whether a **redundant** `push: [main]` re-run (on top of the `pull_request` run that already
validated the same tree) is wanted or not isn't answered by GitHub's docs — it's a maintainer
choice. This repo's own sibling repos have already made that choice explicitly and documented
their reasoning in-file: both `Tooling/.github/workflows/test.yml` and
`research-triage/.github/workflows/test.yml` trigger on `pull_request` only, with the identical
comment:

> "Squash-merge via /pr already validates the merge result, so a post-merge push:[main] re-run
> just re-tests the same tree -- CI runs on PRs only."

Both also add `concurrency: { group: tests-${{ github.ref }}, cancel-in-progress: true }` to
cancel a superseded run when a new commit lands on the same PR. This repo's existing
`push-notify.yml`, by contrast, deliberately **does** trigger on `push: [main]` — but for a
different purpose entirely (announcing a merged PR to Discord, which only makes sense once
something has actually landed on `main`), not for re-running checks.

## 6. Bun-specific gotchas

- **`bun test` exit code / CI flag**: covered in §2 — non-zero exit on failure is automatic, no
  `--ci` flag exists or is needed, and GitHub Actions annotations are auto-detected.
- **The `"overrides": { "undici": "^7.29.0" }` field**: Bun supports npm's `overrides` field
  (and Yarn's `resolutions` as an alias) — added in Bun v1.0.6, per Bun's own docs
  ([bun.com/docs/pm/overrides](https://bun.com/docs/pm/overrides)) — with one documented
  limitation: "Bun only reads overrides from the root `package.json`, not from workspace
  packages." Not relevant to this repo's own resolution (root isn't a workspace consumer of a
  nested override), but relevant context if `ops/admin` were ever folded into a real workspace
  later. **A separate, more concrete gotcha applies to Bun's runtime, not `bun install`**:
  `discord.js`'s own dependency tree pulls in `undici` transitively (confirmed in this repo's
  `bun.lock`, e.g. `@discordjs/rest` depends on `undici@^6.27.0`/`6.24.1`), and the root
  `package.json`'s override forces any package that does `require("undici")`/`import
  ... from "undici"` up to `^7.29.0`. But **Bun ships its own internal, bundled implementation
  of `fetch`/`Request`/etc. and does not route through the `undici` package in `node_modules` for
  its own built-in networking**, even when a project has `undici` installed —
  [oven-sh/bun#19748](https://github.com/oven-sh/bun/issues/19748) is an open bug report from a
  user hitting exactly this ("there is no way to have Bun use the undici version installed in
  `node_modules`, Bun auto-uses its own internal version"). This means the `undici` override in
  this repo's `package.json` affects what `discord.js`'s own explicit `undici` imports resolve
  to, but does **not** change what Bun's own global `fetch()` calls (e.g. anything in
  `src/github.ts`, `src/wow/*.ts` using plain `fetch`) actually run on the wire — a CI check
  can confirm the override resolves and installs cleanly, but it cannot verify the override
  achieves whatever its author intended for Bun-native `fetch` calls, since that codepath never
  touches the overridden package at all. Nothing in this repo currently documents *why* the
  override was added (`Grep`-ed `README.md`/`CONTEXT.md` for "undici"/"overrides" — no
  explanation found beyond the raw field), so this note can't say more than "the override and
  Bun's runtime fetch are two different code paths" as a factual CI-relevant caveat.
- **Runner hardware/timeouts** (GitHub's own docs,
  [github-hosted-runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)):
  a public repo's `ubuntu-latest` runner gets **4 vCPUs, 16 GB RAM, 14 GB SSD**. If no
  `timeout-minutes` is set on a job, GitHub's own workflow-syntax reference documents the default
  as **360 minutes (6 hours)** before the job is force-cancelled, and 360 minutes is also the
  hard ceiling for GitHub-hosted runners (a self-hosted runner can go higher; a hosted one
  cannot). At this repo's current scale (491 tests / ~19s locally, per the empirical run above),
  none of this is a binding constraint — noted only because the task asked about it explicitly.
- **`setup-bun`'s own default version-resolution behavior**: per its README (summarized via
  fetch, not directly quoted verbatim above) and `action.yml`, if no `bun-version` /
  `bun-version-file` input is given, the action checks `package.json`'s `packageManager` field
  first, then falls back to installing the latest release. This repo's `package.json` has no
  `packageManager` field (not checked as a separate grep in this pass, but not present in the
  file as read in full at the start of this research), so an unconfigured `setup-bun@v2` step
  would install **whatever the latest Bun release is at the time the job runs** — i.e. an
  unpinned, floating Bun version, matching the `Dockerfile`'s own `oven/bun:1-slim` tag (also
  floating). Consistent with the deploy image, but means a Bun release regression could
  independently break CI on an otherwise-unrelated PR with no local repro until `bun upgrade`.

## 7. Internal precedent across this machine's other repos

Searched every `.github/workflows/*.yml` under `R:\repos` (277 files matched broadly; narrowed
directly by grepping for `oven-sh/setup-bun|bun install|bun test`). Exactly **one** other
workflow in any repo on this machine uses Bun:

**`R:\repos\wow\.github\workflows\discord-bot-test.yml`** — this is CI for
`apps/warbandeer-discord` inside `nazumods/wow`, the very app this repo (`rackbops-discord-bot`)
was forked/extracted from. Read in full:

```yaml
name: discord-bot-test

# PR/push gate for the Discord bot -- the analogue of `app-test.yml`, but for
# `apps/warbandeer-discord`: TypeScript typecheck + bun unit tests. Path-scoped
# so it only runs when the bot (or this workflow) changes.

on:
  push:
    branches: [main]
    paths:
      - "apps/warbandeer-discord/**"
      - ".github/workflows/discord-bot-test.yml"
  pull_request:
    paths:
      - "apps/warbandeer-discord/**"
      - ".github/workflows/discord-bot-test.yml"

jobs:
  bot-test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/warbandeer-discord

    steps:
      - uses: actions/checkout@v7

      - uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Typecheck
        run: bun run check

      - name: Unit tests
        run: bun test
```

Notable points from reading its `git log` directly (`git -C R:/repos/wow log --oneline -- .github/workflows/discord-bot-test.yml`):

- It **does** use `bun install --frozen-lockfile` (unlike Bun's own generic CI guide in §2, which
  shows a bare `bun install`) — this is the maintainer's own added strictness, not something
  copied from Bun's docs.
- `oven-sh/setup-bun@v2` has been the pin since introduction; only `actions/checkout` has been
  bumped over time (`@v4` → `@v7`, commit `82bcdab`, "ci: bump actions to their Node 24
  releases").
- The job name was originally the generic `test`, later renamed to `bot-test` specifically
  because it collided in meaning with a sibling workflow's own `test` job name (commit
  `ad17d6e`, "ci: rename ambiguous app-test/discord-bot-test job names") — a real naming
  collision this repo's own future job names should avoid repeating if it ever adds more than
  one CI workflow file.
- It is **path-scoped** (`paths: apps/warbandeer-discord/**`) because it lives in a monorepo
  alongside unrelated apps — that scoping reason doesn't apply to `rackbops-discord-bot`, which
  is a single-purpose repo (though `ops/admin` is itself a distinct sub-project, so a similar
  `paths:` scoping *could* still be relevant for skipping `ops/admin`'s own steps on a
  root-only change, if the jobs are split rather than combined per §3).
- It has **no equivalent for `ops/bot-ops.test.ts`** (the test that spawns real
  `ops/bot-ops.sh` against a fake `docker` shim, needing bash+jq on the runner) or for
  `ops/admin` at all — both are new to this fork/extraction and postdate whatever this workflow
  file was scoped to cover in `nazumods/wow`. `bash` and `jq` are preinstalled on GitHub's
  standard `ubuntu-latest` runner image (not re-verified as part of this pass, since it's
  standard, well-documented `ubuntu-latest` image content), so no extra install step should be
  needed for that test to run in CI — but this specific test's needs were not exercised by the
  one internal precedent found.

**No other repo on this machine uses Bun in CI.** `wow-companion` (also a WoW-related desktop
app by the same maintainer, checked directly) uses npm/Vite/Vitest, not Bun — its own
`.github/workflows/ci.yml` runs `actions/setup-node@v7` with `cache: npm`. `Tooling` and
`research-triage` (both checked, both npm-based frontends/backends) show the **two-sibling-project
job pattern** referenced in §3 (`Tooling`'s reusable `frontend-app.yml`, and
`research-triage/test.yml`'s separate `backend`/`frontend` jobs), and both independently
document the same "PRs only, no redundant push:[main] re-run" reasoning quoted in §5b — but
neither is a Bun precedent, so neither demonstrates the root-`bun test`-covers-both-projects
shortcut found empirically in this pass (§3).

## Open questions for the plan

These are judgment calls this research deliberately leaves open, per the task's scope:

1. **Matrix vs. single job vs. two jobs** for root + `ops/admin`. The empirical finding in §3
   (a single un-scoped `bun test` from the root already covers both projects' tests, once both
   have had `bun install` run) makes a single-job design workable for the *test* step, but the
   *typecheck* step still needs two separate `tsc --noEmit` invocations regardless of job
   structure. Whether to combine everything into one job (mirroring `wow`'s `app-test.yml`
   pattern) or split into two jobs (mirroring `research-triage`'s `backend`/`frontend` pattern,
   which also parallelizes wall-clock time) is not settled here.
2. **Whether to cover `ops/bot-ops.test.ts`'s bash+jq requirement explicitly** — it needs
   bash and jq on the runner (both standard on `ubuntu-latest`, but not verified as part of this
   pass) and spawns a real subprocess against a fake `docker` shim; whether that warrants its own
   documented CI step/comment or just rides along inside a general `bun test` invocation is
   unresolved.
3. **Whether to add Docker build validation at all**, and if so, whether via plain `docker build
   .`, `docker compose build` (default `bot` service only), or `docker compose --profile admin
   build` (also builds `ops/admin`'s Dockerfile) — §4 established none of these need secrets to
   succeed, but the task itself (worth the CI minutes vs. not) isn't decided here.
4. **Whether to bother with `actions/cache` for Bun's install cache.** §1's primary-source
   finding (a Bun maintainer's own statement that `bun install` outperformed GitHub's cache
   mechanism in their testing, plus mixed community results) argues against bothering, but this
   repo's actual dependency count/install time was not benchmarked as part of this research.
5. **Whether to protect `main` / add required status checks**, given GitHub's own docs offer no
   solo-maintainer guidance one way or the other (§5a) and this repo's own `/pr` skill already
   waits for CI before squash-merging — i.e. whether branch protection would add a real safety
   net (blocking a merge before green CI even if `/pr` is bypassed) or just be paperwork on a
   repo only its owner can push to.
6. **`pull_request` only, or also `push: [main]`.** §5b shows squash-merges do trigger `push`,
   and this repo's own sibling repos (`Tooling`, `research-triage`) have already chosen
   `pull_request`-only with documented reasoning that would apply here unchanged — whether to
   follow that precedent or diverge is left for the plan.
7. **Whether to pin `bun-version` explicitly** (via `setup-bun`'s `bun-version` input or a
   `packageManager` field in `package.json`) rather than floating to whatever Bun release is
   current when the job runs — §6 notes this repo currently has no such pin anywhere (matching
   its own `Dockerfile`'s floating `oven/bun:1-slim` tag), so an unpinned `setup-bun@v2` step
   would be consistent with existing practice but not immune to a Bun release regression
   breaking CI with no code change.
