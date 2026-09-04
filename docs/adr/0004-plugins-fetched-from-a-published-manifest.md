# Plugins are bundles fetched from a published manifest

`PURPOSE.md` states the direction — "a generic bot core with the WoW-specific pieces ... as one
plugin among others" — but the first candidate shipped the other way. PR #92 (issue #3) hand-wired
the Warbandeer connector into `src/index.ts:10,76-92`, `src/commands.ts:23-24,82-94,200-207`,
`src/config.ts:27-29,100-108,129`, `ops/bot-ops.sh:127,157`, `docker-compose.yml`, the README and
`CONTEXT.md`. Every future plugin would repeat that wiring, and two latent defects rode along with
it: `src/warbandeer/links.ts:215` is an unconditional top-level `await` reached statically from
`src/commands.ts:23` and `src/index.ts:10`, so a bot with the connector *disabled* still reads
`data/links.json` at every boot; and a self-update replacement snapshots `links` at module load —
before `takeOver()` — while the original keeps serving `/link`, `/unlink` and the ingest endpoint
(`beginHandoff()`, `src/restart.ts:63-66`, only quiesces the scheduler via `restartPending()`,
`src/announce.ts:151`, and refuses a second `/update` via `handoffActive()`) for the length of the
handoff — bounded by `VERIFY_DEADLINE_MS` (`src/handoff.ts:22`) plus boot-mode resolution and the
retire step — so the replacement's first whole-file `saveLinks()` overwrites whatever the original
wrote in that window.

Two more constraints shape the answer. Gateway intents are frozen when the client is constructed
(`node_modules/discord.js/src/client/Client.js:544`: `new IntentsBitField(options.intents).freeze()`),
and `src/index.ts:12` constructs it before login — so whatever a plugin needs *before* login cannot
come from plugin code. And the bot repo must stay forkable without plugin baggage: a plugin's code,
tests, changelog and release cadence belong to the plugin, not to this repo.

Research: `docs/research/2026-09-04-plugin-architecture.md` (its §2 extension-point inventory, §4
isolation/versioning/DI findings, §5 discord-ai shape notes and §6 shipped-identifier constraints are
the reference; its in-repo-registry recommendation is what this ADR supersedes). Design epic: #95.

**Decision:** plugins are **single-file bundles published to npm from a separate repo**
(`Rackbops/bot-plugins`, packages `@rackbops/plugin-<name>`), described by a **Plugin Index** that
repo's CI generates — `plugins.json`, fetched from `PLUGIN_INDEX_URL` and cached at
`data/plugins/index.json`. The bot installs the plugins named in `PLUGINS=` at boot (resolve
`package@version` on the registry, download the tarball, verify the registry's `dist.integrity`,
extract `dist/plugin.js` into `data/plugins/<name>/<version>/`), unions their declared intents into
the `Client` **before** constructing it, and only inside `activate()` — after `takeOver()` —
`import()`s each bundle, calls `createPlugin(host)`, registers its commands alongside the core ones,
appends its ticks to the scheduler, runs its `activate()`, and writes `data/plugins/state.json`. The
contract (`src/plugins/contract.ts`: `HostApi`, `Plugin`, `PluginModule`, the index/state/request
shapes, `HOST_API_VERSION`) is owned by this repo; the plugins repo vendors the file with a drift
check. Everything the host needs pre-login — intents, command names, env keys — lives in the index
JSON, so no plugin code runs before login, ever.

A Plugin Index entry, for the connector:

```json
{ "name": "warbandeer", "package": "@rackbops/plugin-warbandeer", "version": "1.0.0",
  "description": "Warbandeer desktop-app character linking (/link, /unlink, ingest endpoint)",
  "hostApiVersion": 1, "intents": [], "commands": ["link", "unlink"],
  "env": [ { "key": "WARBANDEER_INGEST_PORT", "format": "^([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$",
             "required": false, "secret": false, "description": "Port the ingest server binds inside the container; unset = connector off" } ],
  "releases": [ { "version": "1.0.0", "publishedAt": "…", "url": "…/releases/tag/warbandeer-v1.0.0", "notes": "### Added\n- …" } ] }
```

The decisions that hang off this, settled in #95 and not reopened per issue:

1. **Bundles, not packages with dependencies.** `bun build --target bun --external discord.js`;
   `discord.js` resolves to the host's `/app/node_modules` copy by ordinary upward `node_modules`
   resolution from `data/plugins/…`, so host and plugin share one instance. Everything else a plugin
   needs is bundled or comes from the host (`HostApi.storage`, `HostApi.dataDir`).
2. **Enabled ≠ configured.** `PLUGINS=` says which plugins to install; whether a plugin's own env
   keys are set is its business. An enabled-but-unconfigured plugin still loads and registers commands
   that say what is missing — today's `/link` "isn't configured" reply, unchanged.
3. **A plugin never crashes the bot.** Index unreachable → the cached copy (warn); no cache → no
   plugins (warn). An unknown name, an incompatible `hostApiVersion`, a download or integrity
   failure, a throwing `createPlugin`/`activate` → that plugin is skipped with the reason recorded in
   `state.json`. An invalid plugin env value skips that plugin with the same error text in the log,
   where the baked-in connector refused to boot.
4. **Trust.** The host executes code the index names. Trust = whoever can publish
   `@rackbops/plugin-*` or edit `plugins.json` on the plugins repo's `main` — the same class as push
   access to `BOT_BRANCH` (`README.md`'s self-update warning). Integrity = HTTPS, an operator-pinned
   `PLUGIN_INDEX_URL`, the npm `dist.integrity` hash verified before anything is imported, and an
   operator-controlled `PLUGINS` list.
5. **Versions are pinned; the bot never upgrades a plugin on its own.** The installed version is
   recorded in `state.json` and a restart reinstalls exactly that. A 15-minute poll of the index
   detects newer versions and *notifies* the admins with what changed (every release between the
   installed and the available version, from each plugin's changelog via the index); the admin then
   chooses now, a scheduled time, remind me later, or skip this version — from Discord or the admin
   panel. There is no auto-update flag. `PLUGINS=name@version` is a hard pin. Compatibility is
   `hostApiVersion === HOST_API_VERSION`, integer equality.
6. **Storage.** `HostApi.storage` hands over the storage primitives (today
   `src/warbandeer/storage.ts`, promoted to `src/storage.ts` when the connector moves out) and
   `HostApi.dataDir` is the same `data/` directory, so `data/links.json` and `data/characters/` keep their paths — the
   desktop-app contract and the operator's data do not move.
7. **No `Client` in the Host API.** The host owns every gateway listener, which is what keeps the
   standby invariant (`CONTEXT.md`: "The standby attaches nothing") enforceable, and a fake host is all
   a plugin's tests need. It is a declared-dependency boundary, not a sandbox: a command handler's
   `interaction.client` still reaches the live `Client` (a handler only ever runs after the host
   attached the listener inside `activate()`). An HTTP plugin keeps its own `Bun.serve` on its own port env; a host-owned
   router and a stop/dispose hook are additive later.
8. **Commands register on every boot** from core + loaded plugins; a removed plugin's commands
   vanish through the existing bulk `rest.put` overwrite (`src/index.ts:34-41`).

## Considered Options

- **An in-repo static registry of lazily imported modules** (the research's recommendation) —
  rejected: the bot repo would carry every plugin's code, adding a plugin would be a bot commit plus
  a rebuild, and the admin panel could only *show* plugins, never add one.
- **Discovery from the bot's `package.json` dependencies** at image build time — rejected for the
  same reason: installing a plugin means editing this repo and rebuilding; the panel cannot do that.
- **Bun workspaces (`packages/plugin-*`)** — rejected: toolchain churn (`Dockerfile`, `tsconfig.json`,
  the install layer) for nothing the index doesn't already provide, and the plugins would still live
  in this repo.
- **GitHub release assets instead of npm** — kept as the fallback: identical index shape, only the
  `package`/`version` resolution changes. npm was chosen because the registry gives every version an
  immutable tarball URL and an integrity hash for free.
- **Worker or subprocess isolation per plugin** — rejected: the contract is built on discord.js
  objects that do not structured-clone, and the storage primitives serialise writers in one process
  by design (`src/warbandeer/storage.ts:10-16` is explicit that `writeJsonAtomic` is unsafe under a
  second concurrent writer).
- **Build-time inclusion through a Docker build arg** — rejected: self-update's rebuild passes
  exactly one build arg of its own (`src/redeploy.ts:210-214`, `GIT_SHA`), so a plugin-selecting arg
  would be silently lost on the first `/update`.

## Consequences

The trust statement above is the security boundary — worth stating plainly, since "installed from
the Plugin Index" can read as "sandboxed". A plugin's TypeScript is checked in the plugins repo, not by
this repo's `bun run check`; native dependencies are not supported (bundles); a boot with no network
runs whatever is cached. A disabled plugin's code never runs, and nothing plugin-side runs on a
standby. The image build needs no change and no credentials (`README.md:82` — the daemon fetches
the build context with none; the index and the tarballs are public for the same reason). Adding a
plugin to an instance is a `PLUGINS=` edit and a restart; adding one to the world is a tag in the
plugins repo. The shipped identifiers listed in #95 — the connector's env var, command names and
options, reply strings, data paths, HTTP routes — are preserved through the whole migration; only
startup log lines may be reworded.
