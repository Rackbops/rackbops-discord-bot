# rackbops-discord-bot -- Claude Instructions

A Discord bot (**Bun + TypeScript**, ESM, discord.js v14) with a plugin architecture: a small host
core plus feature plugins installed from a published Plugin Index. **Forked with full history from
[nazumods/wow](https://github.com/nazumods/wow)'s `apps/warbandeer-discord`, built there by
[Nazuraki](https://github.com/nazumods)** -- full credit for the original bot and its documented
gotchas. The direction here is a **generic, modular bot core** with the WoW-specific pieces as plugins
rather than the whole bot: character linking is already its own plugin (`@rackbops/plugin-warbandeer`,
#100), with DMF, realm status and transmog still in the core and headed the same way -- see
[`PURPOSE.md`](PURPOSE.md).

My personal `~/.claude/CLAUDE.md` governs *how I work* -- the review gate, escalation, git &
shipping, commit mechanics, search-tool routing, and shell choice. It is **not restated here**; this
file covers only what is specific to this repo.

**Commit convention (as the log shows):** Conventional Commits `type(scope): subject`, the subject
usually ending `(#N)`. Types include `feat`, `fix`, `ci`; scope names the subsystem touched --
`plugins`, `config`, `ops`, `admin`, ... Match what the log already shows.

---

## Ground truth & the doc-set

The **TypeScript source under `src/` is the source of truth**; cite `file:line`. Read the actual
function before calling or changing it, and mark every claim verified/inferred/unknown per personal's
Claims discipline -- discord.js and the plugin / self-update machinery are subtle, and
confident-sounding guesses are the default failure mode here. **Where a doc's *behaviour* description
and the code disagree, the code wins** -- verify at the point of use rather than trusting recalled prose.

This repo already carries a rich doc-set; use it rather than re-deriving:

| Doc | What it is |
|---|---|
| [`CONTEXT.md`](CONTEXT.md) | The code map + glossary + behaviour + gotchas -- a per-file responsibility table and the domain vocabulary (Link Code, Device Token, Plugin, Host API, ...). Start here to find code. |
| [`PURPOSE.md`](PURPOSE.md) | What the bot is for and the generic-core direction. |
| [`README.md`](README.md) | Features, setup, self-update, plugins, character linking, the Cloudflare tunnel. |
| [`docs/adr/`](docs/adr/) | The design decisions. Read the relevant ADR before changing what it settled -- `0004-plugins-fetched-from-a-published-manifest` governs the plugin boundary. |

---

## Irreversible: the host<->plugin contract

Plugins are installed from the **Plugin Index** and wired through the **Host API**, versioned by the
integer `HOST_API_VERSION` in [`src/plugins/contract.ts`](src/plugins/contract.ts) (ADR-0004). Changing
the contract's shape or bumping that version affects every published plugin (`@rackbops/plugin-*`) and
every operator's already-installed bundles -- treat it as a shipped-identifier change per personal's
**Escalation**: land it compatibly and never silently break an installed plugin. `contract.ts` is
pinned by `contract.test.ts` to hold *no runtime code* but that one constant, so it can be read before
the `Client` exists and vendored verbatim by the plugins repo -- don't add a value export to it.

Also operator-precious and never auto-migrated: the per-instance config dir (`.env` + `backups/`,
separate from the compose file) -- see the config-dir gotcha in `CONTEXT.md`.

---

## Testing & checks

Run before staging (they do not substitute for the **review gate**):

- **`bun run check`** -- `tsc --noEmit` typecheck (root). `ops/` and `ops/admin/` typecheck separately
  (`bunx tsc --noEmit -p ops/tsconfig.json`; `bun run check` inside `ops/admin/`).
- **`bun test`** -- one unscoped run from the repo root covers both the root and `ops/admin` suites
  (Bun resolves each test file relative to its own location). There is no `test` npm script -- Bun's
  runner discovers the `*.test.ts` files directly.

**CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs those typechecks + `bun test` on
`pull_request` (not on push to `main`). Some tests `skipIf(win32)`, or skip when `docker compose` / `jq`
is absent -- those run only on CI's Linux, so a green run on this Windows box is **not** proof they
pass; name that gap per personal's **Done means**.

---

## Code style

Follows personal's **Code style** baseline. This repo's individuality:

- **Bun + TypeScript, ESM** (`"type": "module"`), `bun@1.3.14` pinned in `package.json`. discord.js
  v14 is the bot's one runtime dependency (root `package.json`; `undici` pinned via `overrides`); the
  `ops/admin/` panel is a separate package with its own deps (e.g. `jose`).
- **Keep I/O at the edges.** The codebase is built around pure `decide*()` functions with injected
  deps (`fetch`, the Docker socket, deliverers) so behaviour unit-tests without a live
  Discord/Blizzard/GitHub/Docker -- match that shape for new logic, don't bolt I/O into it.

---

## Key gotchas

The paid-for-once traps live in [`CONTEXT.md`](CONTEXT.md)'s **Gotchas** -- the plugin `running`-gate,
`tar` in `oven/bun:1-slim`, the single-`discord.js`-copy rule, the two-source compose interpolation,
and the config-dir split. Read them before touching plugins, self-update / redeploy, or the ops layer.
