# Research: integrating `Lepid-Labs/discord-ai` (issue #12)

Date: 2026-09-01
Scope: research only, no code changes. Answers issue #12's four questions from primary
sources — the actual files in `Lepid-Labs/discord-ai` (read via `gh api`, since the GitHub
MCP connector has no App installation on the `Lepid-Labs` org and 404s there) and this
repo's own source.

## What discord-ai actually is (confirmed)

`Lepid-Labs/discord-ai` is a private pnpm monorepo with two packages:

- `@discord-ai/core` — "Command, watcher, and action model — content matchers, validation, no
  Discord dependency" (`Lepid-Labs/discord-ai` README.md, "Modules" table).
- `@discord-ai/bot` — "discord.js gateway client — slash-command registration, event routing,
  action dispatch" (same table).

Its own `docs/PURPOSE.md` states the deployment model plainly:

> "The deployment model is **embedded**: the host constructs the bot with its own token and
> application id, registers handlers that call whatever agent it embeds, and owns the process
> lifecycle. The library reads no configuration stores and holds no credentials of its own."

(`Lepid-Labs/discord-ai` `docs/PURPOSE.md`, "Problem being solved")

This matches how `rackbops-discord-bot` already runs — one process, `src/index.ts` owns
client login, command registration and interaction routing (confirmed by reading
`src/index.ts` directly, see Q4 below) — so adopting it would not require standing up a
sidecar or a separate service.

## 1. License / usage rights — the actual blocking question

Confirmed directly from the three primary sources named in the issue, quoting exact text:

- **`Lepid-Labs/discord-ai` `package.json`**: `"private": true` (root manifest, and also set
  independently on both `packages/core/package.json` and `packages/bot/package.json`).
- **`Lepid-Labs/discord-ai` README.md**, section "License" (last line of the file):

  > "## License
  >
  > Private — all rights reserved. Not licensed for distribution."

- **`Lepid-Labs/discord-ai` `docs/PURPOSE.md`**, section "Audience" (last sentence):

  > "Internal projects that put AI agents in front of people on Discord — assistants,
  > media-ingestion pipelines (watch for video links, hand them to a processing agent), and
  > notification-style agents that post or thread asynchronously. Private library, not for
  > distribution."

- There is **no `LICENSE` or `LICENSE.md` file in the repo at all** — both were probed via
  `gh api repos/Lepid-Labs/discord-ai/contents/LICENSE(.md)` and both 404. The GitHub repo
  API's own `license` field (`gh api repos/Lepid-Labs/discord-ai --jq '.license'`) is also
  empty/null, i.e. GitHub itself doesn't detect any license. The README/PURPOSE.md text above
  is the *only* stated license, and it says "not for distribution," full stop.

**Access actually granted to the user (roshne), confirmed via the GitHub API directly:**

```
gh api repos/Lepid-Labs/discord-ai --jq '.permissions'
→ {"admin": false, "maintain": false, "pull": true, "push": false, "triage": false}

gh api orgs/Lepid-Labs/memberships/roshne
→ {"role": "member", "state": "active", "direct_membership": true, ...}
```

So: read access to the repo (`pull: true`) via an **org membership with role `member`** (not
`admin`/owner), and explicitly **no push, no maintain, no admin** on the repo itself. Nothing
in the repo (no `CONTRIBUTING`, no note in README/PURPOSE.md, no repo topic/description) grants
or even discusses permission to *depend on* discord-ai's code from a separate, differently
licensed repository. The CI workflow (`.github/workflows/ci.yml`) only lints/typechecks/tests
on push/PR — there is no publish step to npm or GitHub Packages, consistent with "not licensed
for distribution."

**This repo's own license status**, checked directly in this working directory:

- No `LICENSE` or `LICENSE.md` file exists at the repo root (confirmed via `ls`).
- `package.json` has no `"license"` field at all (`Grep '"license"' package.json` → no
  matches).
- `README.md` states the fork relationship: "This is a fork of
  [`apps/warbandeer-discord`](https://github.com/nazumods/wow/tree/main/apps/warbandeer-discord)
  from [nazumods/wow](https://github.com/nazumods/wow) ... The extraction preserved full
  commit history" (`README.md:5-10`), and `git remote -v` shows `origin` is
  `https://github.com/roshne/rackbops-discord-bot.git` — i.e. this is roshne's own fork/repo,
  not `nazumods/wow` itself.
- Net effect: `rackbops-discord-bot` currently has **no license of its own stated anywhere**
  (no file, no manifest field), and its upstream (`nazumods/wow`) wasn't checked for a license
  file as part of this task (out of scope — the question here is discord-ai's terms, which are
  unambiguous regardless of what license this repo ends up under).

**Conclusion, stated plainly:** This is a **permissions/legal question, not a technical one**.
discord-ai's own README and `docs/PURPOSE.md` both say, in their own words, "not for
distribution" / "not licensed for distribution," and the user's access is read-only via an org
membership with no admin rights and no push access — i.e. exactly the access level the issue
described, confirmed rather than assumed. **No code that imports `@discord-ai/core` or
`@discord-ai/bot` should be written until someone with admin/push rights on
`Lepid-Labs/discord-ai` (or its author) explicitly grants permission to depend on it from a
separate, differently-licensed repository** (whether that's a license change, a written
grant, or an internal decision that `rackbops-discord-bot` itself counts as one of discord-ai's
sanctioned "internal projects" — none of which is currently on record anywhere in either repo).

**Addendum — does Lepid-Labs org membership itself change this?** Raised and worked through in
discussion after the initial pass: no, and it's worth being precise about why, since "I'm a
member of the org" is an intuitive but incorrect basis for assuming permission.

- **GitHub access and copyright license are separate axes.** Org membership / repo `pull: true`
  governs what you can technically *do on GitHub* (clone, read, open issues). A license governs
  what you're allowed to do *with the code* (copy it, embed it elsewhere, modify and
  redistribute it). "All rights reserved. Not licensed for distribution" is a copyright
  statement — it means no license has been granted beyond what you're already doing (viewing
  it) — and it is unaffected by your access tier. GitHub's own Terms of Service state plainly
  that having access to a private repo does not by itself grant a license to its contents; it's
  routine for private repos to give contractors, employees, or org members read access for
  review/collaboration while explicitly reserving all reuse rights.
- **The one place membership creates a real, non-trivial argument**: `docs/PURPOSE.md`'s
  "Audience" line scopes the library to "**internal projects**... Private library, not for
  distribution." If Lepid-Labs' own working definition of "internal" is "anything a Lepid-Labs
  member builds," a member might already sit inside that intended scope. But this is an
  inference about intent, not a stated grant — nothing says "any org member may embed this in
  their own repos," and `rackbops-discord-bot` is not owned by Lepid-Labs, is not itself in the
  org, and is a public fork under the user's personal account, not a Lepid-Labs project.
- **Attempted to sharpen this further by checking *how* the access was granted** — a personal
  collaborator invite would read as a stronger signal of implied trust than a blanket org-wide
  default permission. Both `gh api repos/Lepid-Labs/discord-ai/collaborators/roshne/permission`
  and `gh api repos/Lepid-Labs/discord-ai/collaborators?affiliation=direct` 404 for this user
  (collaborator-listing endpoints require push/admin rights to query, which this user doesn't
  have), and `gh api orgs/Lepid-Labs --jq '.default_repository_permission'` returned empty for
  the same reason. So this couldn't be resolved either way from the API — but it doesn't change
  the conclusion, since neither answer would itself constitute a license grant.
- **Net effect on the recommendation: unchanged, but the ask gets easier.** Org membership
  doesn't make it safe to *assume* permission, but it does mean the user already has a direct
  relationship with whoever administers Lepid-Labs — so getting an explicit yes/no is a quick
  question to ask, not a cold outreach. The blocking step named in this doc's Recommendation
  section stands as written.

## 2. Toolchain mismatch

**discord-ai's toolchain**, confirmed from its own files:

- `package.json`: `"engines": { "node": ">=22" }`, `"packageManager": "pnpm@9.15.0"`.
- `pnpm-workspace.yaml`: `packages: - "packages/*"` — a pnpm workspace.
- `biome.json` present at root (`@biomejs/biome ^1.9.4` in devDependencies) — Biome for
  lint/format, not ESLint/Prettier.
- No `.nvmrc` found (not probed as a separate file beyond the root listing, which doesn't show
  one — the `engines.node` field above is the authoritative source).
- `.github/workflows/ci.yml` runs `pnpm/action-setup`, Node 22 and 24 in a matrix, and
  `pnpm install --frozen-lockfile` — pnpm end to end, no Bun anywhere in CI.
- README.md "Prerequisites": "Node.js >= 22", "pnpm >= 9", "just" — no mention of Bun.

**rackbops-discord-bot's toolchain**, confirmed from this working directory:

- `bun.lock` present at root (Bun's native text lockfile, `"lockfileVersion": 1"`); no
  `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock` anywhere (all three checked, all
  absent).
- `package.json` scripts are all `bun`/`bunx` (`"start": "bun run src/index.ts"`,
  `"dev": "bun --watch run src/index.ts"`, `"check": "bunx tsc --noEmit"`).
- `Dockerfile` is `FROM oven/bun:1-slim` and runs `bun install --frozen-lockfile
  --production` and `CMD ["bun", "run", "src/index.ts"]`.
- No `.bun-version` file (checked, absent) — the Bun version is pinned only by the Docker
  base image tag (`oven/bun:1-slim`, i.e. latest Bun 1.x).
- README.md's own setup instructions: "Run (Bun required): `bun install` / `bun start`" —
  no Node/pnpm path is documented or supported anywhere in this repo.

**Can Bun consume discord-ai's built output as a dependency?**

Checked each package's `package.json` directly for the fields that matter:

- Both `@discord-ai/core` and `@discord-ai/bot` declare `"main": "./dist/index.js"`,
  `"types": "./dist/index.d.ts"`, an `"exports"` map pointing at the same `dist/` files, and
  `"files": ["dist"]`. Both have a `"build": "tsc -b"` script. So **yes, discord-ai does build
  to compiled JS + `.d.ts`** — it is not TypeScript-source-only, and a consumer that only needs
  the built output doesn't need Biome, vitest, or `just` at all; it needs the `dist/` folders
  to exist (i.e. `pnpm -r run build` to have been run at some point before the package is
  consumed).
- **It is not on npm, and there is no `publishConfig` or GitHub Packages registry config
  anywhere** — no `.npmrc` in the repo (probed, 404), no `publishConfig` key in either
  package.json, and `"private": true` on the root and both packages would block `npm
  publish`/`pnpm publish` outright even if someone tried. Combined with the CI workflow having
  no publish step, there is currently **no route to pull discord-ai in as a normal npm-style
  dependency** — not because of any Bun-specific limitation, but because discord-ai publishes
  nowhere. The only realistic ways to consume it (setting the license question aside
  entirely) would be a **git dependency URL** (Bun supports `"pkg": "github:Lepid-Labs/discord-ai#<path>"`-style
  git deps, but see the workspace-protocol problem below), a **git submodule** built locally
  before `bun install`, or a hand-built **tarball** copied in — none of which this repo has any
  existing pattern for (it has exactly one runtime dependency, `discord.js`, installed
  normally from the npm registry per `bun.lock`).
- **The workspace-protocol problem is real and would bite here.** `packages/bot/package.json`
  declares its dependency on the sibling package as:

  ```
  "dependencies": {
    "@discord-ai/core": "workspace:*",
    "discord.js": "^14.16.0"
  }
  ```

  `workspace:*` is pnpm's workspace-protocol specifier — it only resolves inside a pnpm
  workspace where `@discord-ai/core` is a sibling package pnpm can symlink in. It does **not**
  mean anything to Bun (or npm, or any resolver) outside that workspace. Concretely: even if
  `@discord-ai/bot`'s `dist/` output were vendored/tarballed and installed into this repo via
  Bun, its own `package.json` (which ships inside `dist`'s package metadata, since `files` is
  `["dist"]` but the published `package.json` itself still carries this `dependencies` block)
  would ask Bun to resolve `@discord-ai/core@workspace:*`, which Bun cannot do outside a
  workspace it doesn't have — `@discord-ai/core` isn't a real sibling package on npm or
  anywhere else. **This means discord-ai's built output is not self-contained as a
  standalone dependency** — `@discord-ai/bot` still expects `@discord-ai/core` to be resolved
  via workspace linking, so consuming it from Bun would require either (a) rewriting that
  specifier to a real version/git/file reference before install (a fork/patch step, not a
  clean "add the dependency" step), or (b) vendoring both packages' `dist/` output directly
  into this repo's tree rather than treating them as installable packages at all.

**Conclusion for Q2:** discord-ai's *build output* (compiled JS + `.d.ts`) is real and usable
in principle — this is not a TypeScript-source-vs-Bun incompatibility. But "install the built
output via Bun" is **not likely to be clean**: there is no publish target to install from in
the first place (private, no registry config), and the one existing internal cross-package
reference (`@discord-ai/core: "workspace:*"` in `@discord-ai/bot`'s manifest) would not resolve
outside a pnpm workspace, so a straight `bun add github:...` or tarball install would fail
resolution unless that specifier were patched or the packages were vendored in directly. This
is a solvable problem (patch the specifier, or vendor `dist/` output straight into the repo)
but it is a workaround, not a clean dependency install, and it's on top of the licensing
question in Q1, which blocks doing any of this at all right now.

## 3. It's not an agent (confirmed)

discord-ai's own `docs/PURPOSE.md`, "Non-goals" section, states this explicitly:

> "**Not an agent** — no LLM calls, no reasoning, no credentials. Handlers are supplied by the
> host; what they compute is their business."

(`Lepid-Labs/discord-ai` `docs/PURPOSE.md`, "Non-goals")

The root README.md's own description reinforces this: "This library ships no agent, no
credentials store, and no process of its own" (README.md, "Deployment model").

**Stated plainly:** using discord-ai for anything a user would notice requires
`rackbops-discord-bot` to separately stand up an actual LLM/agent backend behind whatever
handlers it registers — a model choice (which provider, which model), an API integration, a
cost model (who pays per call, at what volume), and prompt/behavior design for whatever the
command or watcher is supposed to do. **None of that is scoped by this research or by issue
#12, and it must not be assumed or pre-decided by any follow-up issue this research
recommends** — it is a distinct decision with its own tradeoffs (cost, privacy of guild
message content sent to a third-party model, latency budget against Discord's 3-second
interaction-acknowledge window) that deserves to be made on its own, not smuggled in as a
side effect of "let's add discord-ai."

## 4. Concrete feature, not just a library

**This bot's existing command/event architecture**, read directly from source:

- `src/index.ts` is a single process that logs in once, bulk-registers all slash commands via
  one `rest.put(...)` call (`src/index.ts:29-34`), and routes every interaction through one
  `Events.InteractionCreate` listener that dispatches on `isChatInputCommand()` (→
  `handleCommand`) or a modal submit whose `customId` starts with `report:` (→
  `handleReportModal`) (`src/index.ts:37-47`). There is **no `MessageCreate` listener anywhere
  in this codebase today** — the bot only reacts to slash commands and modal submits, never to
  ordinary message content. Confirmed by reading `src/index.ts` in full; nothing elsewhere
  registers a message-content handler.
- The gateway intents requested are `[GatewayIntentBits.Guilds]` only (`src/index.ts:10`), and
  the README is explicit that this is deliberate: "`2048` = Send Messages. No privileged
  intents are needed." (`README.md:32`). This matters directly for Q4's proposals below.
- `src/report.ts` is the closest existing analog to a discord-ai "command + modal + external
  action" flow: `/report` role-gates (`hasReportRole`), pops a `ModalBuilder` with Title +
  Description fields (`handleReportCommand`), and on submit calls out to GitHub
  (`ensureLabel`/`createIssue`) before posting a public channel confirmation built by the pure,
  unit-tested `reportAnnouncement()` (`src/report.ts:29-41, 113-135`). This is structurally
  similar to what a discord-ai `CommandDef` handler does (gate → collect input → call an
  external system → `dispatch` a reply/post), just hand-rolled rather than using discord-ai's
  action-dispatch surface.
- `src/announce.ts` is the bot's proactive/async posting pattern: a `setInterval` tick
  (`TICK_MS = 60_000`) drives independent checks (DMF, weekly reset, realm status, GitHub
  releases), each of which calls a shared `announce(client, kind, message)` helper that fetches
  a channel by ID and calls `channel.send(message)` (`src/announce.ts:31-50`). This is a
  polling scheduler, not an event-driven watcher — another point of contrast with discord-ai's
  watcher model, which reacts to incoming messages rather than polling external state.

**This repo's stated direction**, from `PURPOSE.md` (root, not discord-ai's):

> "That purpose stands as-is for now — the direction from here is toward a generic bot core
> with the WoW-specific pieces (DMF, realm status, transmog) as one plugin among others, not
> the whole bot."

(`PURPOSE.md:14-15`)

**discord-ai's actual API surface**, confirmed from `packages/core/README.md` and
`packages/bot/README.md` (both read directly, not paraphrased from the top-level README):

- `@discord-ai/core` exports `CommandDef`, `WatcherDef`, matchers (`youtubeLinks`,
  `tiktokLinks`, `urlMatcher(hosts)`, `contentMatcher(regex)`, `anyOf(...)`), and action
  constructors (`reply`, `react`, `defer` + `followUp`, `post`, `thread`).
- `@discord-ai/bot` exports a `DiscordAgentBot` class with `registerCommand(...)` and (by
  symmetry, referenced in `docs/PURPOSE.md`, though not shown in the bot README's short
  example) a watcher-registration entry point, plus `bot.start()` and `bot.client` (the
  underlying discord.js client "for anything beyond the command/watcher/action surface").
- **`packages/bot/README.md` states the watcher path needs a privileged intent this bot does
  not currently request**: "Required gateway intents (enable **Message Content** in the
  Discord developer portal for watchers to see message text): Guilds, Guild Messages, Message
  Content, Direct Messages, Guild Message Reactions." Message Content is a Discord privileged
  intent that must be explicitly toggled on in the Developer Portal (and, for a bot in 100+
  guilds, approved by Discord) — a real, if usually low-friction for a single-guild bot,
  additional setup step beyond what `rackbops-discord-bot` needs today.

**Two concrete, plausible proposals for this specific guild bot** (assuming Q1's licensing
question and Q3's LLM-backend decision were both separately resolved — neither is implemented
or assumed working here):

1. **A watcher for WoW armory/logs links, replying with a summary scaffold.** This bot's guild
   already shares Warcraft Logs and Raider.io/Armory links routinely in the same channels this
   bot posts realm-status and DMF announcements to (per README's stated purpose: "notify users
   of realm status, facilitate cross-channel communication"). A `WatcherDef` using
   `urlMatcher(["warcraftlogs.com", "raider.io"])` (the same `urlMatcher(hosts)` primitive the
   core README documents for YouTube/TikTok) could match those links and `dispatch(thread(...))`
   a scaffold reply — e.g. "Summarizing this log/character..." — which an actual LLM backend
   (Q3, unresolved) would need to fill in with a real summary. This directly mirrors the
   library's own worked example (`videoWatcher` in `packages/core/README.md`, matching
   YouTube/TikTok links and threading a summary) swapped to a domain this guild's channels
   actually see.
2. **An `/ask`-style assistant command scoped to this bot's own domain data.** discord-ai's own
   `packages/bot/README.md` worked example is literally a `/ask` command that defers, calls
   `myAgent.ask(...)`, and follows up — the same `defer()`/`followUp()` pattern `/update`'s
   admin-only flow and `/report`'s modal-submit flow in this repo already use for
   longer-than-3-second work (`handleReportModal` calls `interaction.deferReply()` before the
   GitHub round-trip, `src/report.ts:124`). A guild-scoped `/ask` command wired to a real LLM
   backend, given this bot's own realm-status/DMF/transmog data as context, is a plausible
   "generic bot core, WoW as a plugin" feature per `PURPOSE.md`'s stated direction — e.g.
   answering "when's the next DMF" or "is the realm up" in natural language rather than only
   via the fixed `/dmf`/`/status` commands. This is explicitly the shape of feature the
   `PURPOSE.md` direction (generic core, WoW-specific pieces as a plugin) points toward, more
   than proposal 1 does.

Both are honest about the same caveat: **neither can be implemented today.** Both need Q1's
licensing question resolved before any discord-ai import is legally clean, and both need Q3's
LLM/agent backend decision made (model, API, cost, prompt design) before either handler could
do anything beyond the scaffold reply described above — discord-ai supplies the Discord-side
plumbing only, never the intelligence.

## Recommendation

**Do not open a follow-up design/implementation issue yet.** The blocking question is Q1 —
licensing/permission — and it is not something a design issue can route around: discord-ai's
own README and `docs/PURPOSE.md` say "not licensed for distribution" / "not for distribution,"
in their own words, and the user's access to the repo is `pull`-only via an org membership
with no push/admin/maintain rights. Nothing in either repo grants permission to depend on
discord-ai's code from a separately-licensed repository. Opening an implementation issue now
would produce a plan for code that legally cannot be written yet.

**What must happen first, before any follow-up issue moves to implementation:** someone with
admin/push rights on `Lepid-Labs/discord-ai` (or its author) needs to explicitly say whether
`rackbops-discord-bot` — a separate, publicly-forked repo under a different GitHub account —
counts as one of the "internal projects" discord-ai's `docs/PURPOSE.md` scopes itself to, and
if so, under what terms (a license grant, a written internal-use exception, or a license
change on discord-ai itself). This is a one-message question to whoever owns
`Lepid-Labs/discord-ai`, not a research task — but it has to be asked and answered before any
code, or even a detailed implementation plan, is worth writing.

**If and when that answer is yes**, a follow-up issue would be worth opening, and should scope
narrowly:

- Pick **one** of the two proposals in Q4 (not both) as the first concrete feature — the
  armory/logs watcher or the `/ask`-style command — rather than "integrate discord-ai"
  in the abstract.
- Treat the LLM/agent backend (Q3) as an explicitly separate, prerequisite decision with its
  own issue/discussion (model choice, API, cost, data-privacy stance on sending guild message
  content to a third-party model) — the discord-ai follow-up issue should assume that decision
  is already made, not fold it in.
- Scope the toolchain question (Q2) concretely: whether to patch the `workspace:*` specifier
  and vendor built `dist/` output directly into this repo's tree (the only route identified
  here that doesn't require discord-ai to start publishing anywhere), or ask discord-ai's
  maintainer to cut the `workspace:*` reference for a real version/file specifier if this
  becomes a recurring consumption pattern for other host projects too.
- If proposal 1 (the watcher) is chosen, explicitly call out the new privileged **Message
  Content** intent it requires — a Developer Portal toggle this bot doesn't need today per its
  own README ("No privileged intents are needed").
