# Research: a plugin architecture for `rackbops-discord-bot`

Date: 2026-09-04
Scope: research only, no code changes. Answers the six numbered questions from the task against
primary sources — this repo's own files (cited `file:line`, read directly from the main working
tree), Bun's own docs (`bun.com/docs`), discord.js's typings/source in `node_modules` and the
`discordjs/guide` repo, Discord's developer docs (`docs.discord.com`), the `sapphiredev/framework`
+ `sapphiredev/pieces` source, Fastify's docs + `lib/plugin-utils.js`, Probot/Vite/Hono docs, and
`Lepid-Labs/discord-ai` read via `gh api`. Builds on
`docs/research/2026-09-01-discord-ai-integration.md` (license, toolchain, what discord-ai is) and
does not repeat it. Ends with a recommended *direction* and the open decisions; does not decide the
final design.

> **Status (2026-09-04):** the in-repo static lazy registry this document recommends (§1a, the
> env-presence-only switch in §3, the carve-out steps in §6b, and the Recommendation) was **not
> adopted** — superseded by `docs/adr/0004-plugins-fetched-from-a-published-manifest.md` (plugins are
> published bundles fetched from a Plugin Index; epic #95). What the ADR kept: §1d's reference shapes,
> §2 (extension-point inventory), §4 (in-process isolation, an integer host API version, a DI'd host
> object), §5 (discord-ai as a reference shape) and §6's shipped-identifier constraints.

## Repo facts confirmed as part of this research (in addition to the ones already given)

- `discord.js` resolves to **14.27.0** (`bun.lock:50`: `"discord.js@14.27.0"`); `package.json:14`
  asks for `^14.27.0`, `package.json:6` pins `"packageManager": "bun@1.3.14"`.
- **The connector's storage is read at boot even when the connector is disabled.**
  `src/warbandeer/links.ts:215` is a top-level `await loadLinksFrom(LINKS_FILE)`, and that module
  is reached statically from two always-imported places: `src/commands.ts:23` →
  `src/warbandeer/link-command.ts:3` → `links.ts`, and `src/index.ts:10` →
  `src/warbandeer/server.ts:7-18` → `links.ts`. `warbandeerConnectorConfigured()` (`server.ts:21-23`)
  only gates `Bun.serve` (`index.ts:81-83`), not module load. Any "optional plugin" design has to
  decide whether a disabled plugin's module is even imported — today it is.
- **Data paths are `import.meta.dir`-relative with a hop count baked in.** `src/state.ts:35` uses
  `join(import.meta.dir, "..", "data")` (one hop); `src/warbandeer/links.ts:184` and
  `src/warbandeer/characters.ts:146` use `join(import.meta.dir, "..", "..", "data")` (two hops).
  Moving a warbandeer file one directory deeper (e.g. `src/plugins/warbandeer/`) silently changes
  where `data/links.json` and `data/characters/` resolve unless the hop count is edited — and those
  are shipped identifiers (`docs/adr/0003`, `README.md:134-151`).
- **Host state depends on a WoW type**: `src/state.ts:4` imports `RealmStatus` from `./wow/realm`
  for `BotState.realmStatus` (`state.ts:28`). The dedup keys `dmfAnnouncedFor`,
  `weeklyAnnouncedFor`, `realmStatus` (`state.ts:26-28`) are WoW-feature state inside the
  host-owned `data/state.json`.
- **Ops has its own dependency on that WoW state key**: `ops/bot-ops.sh:272-273` runs
  `cat /app/data/state.json | jq -r '.realmStatus // ""'` for `cmd_status`, and the admin panel
  renders it (`ops/admin/public/index.html:474-479`). `.realmStatus` in `state.json` is therefore a
  shipped identifier read by three things (bot, script, panel), not a private bot field.
- **Command dispatch is a closed `switch` with no `default`** (`src/commands.ts:98-208`): a command
  name that matches no case returns without replying. `commandData` is a module-level `const`
  (`commands.ts:55-95`) evaluated at import time from `config.commandPrefix` (`commands.ts:40`) —
  so "which commands exist" is fixed before anything about plugins could be decided at runtime.
- **Only two gateway events are subscribed anywhere in `src/`**: `Events.ClientReady`
  (`src/index.ts:17`) and `Events.InteractionCreate` (`src/index.ts:63`) — confirmed by a Grep for
  `Events\.\w+` over `src/` (non-test). There is no `SIGTERM`/`SIGINT` handler, no `process.on(`,
  and no `client.destroy()` in `src/` (Grep, non-test); the only `.stop()` is the connector's own
  `server.stop()` (`src/warbandeer/server.ts:336`), and `index.ts:83` discards the returned
  `{ stop, port }` handle, so nothing ever calls it.
- **The connector's env-key regex has no mirror test.** `WARBANDEER_INGEST_PORT`'s format regex
  lives only in `ops/bot-ops.sh:127`; the panel's `index.html` contains no `WARBANDEER` string at
  all (Grep). By contrast `WOW_REALM`'s regex, `DMF_TIMEZONE`'s regex and the `REQUIRED` list each
  have a "both source patterns are present and identical (mirror can't drift)" test in
  `ops/admin/server.test.ts:1523-1536`, `:1951-1967`, `:1990-2004`.
- `ops/bot-ops.sh` already requires `jq` on every subcommand that produces JSON (`need jq` at
  `:266`, `:302`, `:331`), and `cmd_env_get` (`:310-318`) asserts `ALLOWED_ORDER` and `ALLOWED`
  hold the same keys. The admin container gets the script via a bind mount of
  `/opt/rackbops-discord-bot/bin` (`docker-compose.yml:93-95`), not from the bot image — so a
  manifest file "read by both TS and bash" would have to be delivered to that `bin/` directory
  separately from `src/`.
- `Bun.serve` appears exactly once in `src/` (`src/warbandeer/server.ts:307`); `ops/admin/server.ts`
  has its own, but that runs in a separate container.
- `grep -i warbandeer` over the repo (excluding `node_modules`, `.claude`, `.git`) = **174
  occurrences across 26 files**; §6 classifies them. Several are the *word*, not the connector:
  the default container/project names `warbandeer-discord[-debug]` (`docker-compose.yml:21,55,83-84`,
  `src/redeploy.test.ts`, `ops/docker-compose.test.ts:128,142`), the desktop apps' Ops tab
  (`ops/README.md:6,12,141-164`), the monorepo-era path
  `apps/warbandeer-discord` in a build-context fixture (`src/docker.test.ts:98,104`),
  `Warbandeer_Collected/outfitcodec.lua` (`src/wow/transmog.ts:16`), a service-token name
  `warbandeer-ci` (`ops/admin/server.test.ts:756-757`), and the fork notices in `README.md`,
  `PURPOSE.md`, `CONTEXT.md`, `ops/bot-ops.sh:3-5`.
- Source-availability notes for this pass: `discordjs.guide/creating-your-bot/command-handling.html`
  and its `/legacy/` variant both returned HTTP 404 to WebFetch today, so the guide text below is
  quoted from the `discordjs/guide` repo (`guide/creating-your-bot/command-handling.md`,
  `command-deployment.md`, `event-handling.md`, default branch, via `gh api`). Likewise
  `sapphirejs.dev/docs/Guide/plugins/creating-plugins` 404s and the website repo's
  `docs/Guide/plugins/` directory holds only guides for the *official* plugins (API, Logger,
  Subcommands, i18next, editable-commands) — no plugin-authoring page — so Sapphire's plugin
  mechanism is quoted from `sapphiredev/framework` source. `discord.com/developers/docs/...` now
  301-redirects to `docs.discord.com/developers/...`; quotes below are from the redirected pages.

## 1. Loading/packaging options

Three framing facts apply to every option. Bun runs the source directly — "You can directly
execute `.jsx`, `.ts`, and `.tsx` files; Bun's transpiler converts these to vanilla JavaScript
before execution" (`bun.com/docs`) — and "Bun does not perform typechecking"
(`bun.com/docs/runtime/loaders`, TypeScript loader). The repo's only type gate is
`bun run check` = `bunx tsc --noEmit` (`package.json:11`) over `"include": ["src"]`
(`tsconfig.json:14`); `CONTEXT.md:429` says "No lint beyond tsc". And the image is built by
`COPY package.json bun.lock ./`, `bun install --frozen-lockfile --production`, `COPY src ./src`,
`CMD ["bun", "run", "src/index.ts"]` (`Dockerfile:4-7,24`), from a remote git context of the whole
repo when self-updating (`src/redeploy.ts:62-63`: `https://github.com/${repo}.git#${ref}`).

### 1a. In-repo modules under `src/plugins/<name>/`: static registry vs filesystem discovery

**Static registry (an explicit import list).** Every plugin object is type-checked against the
`Plugin` interface by `tsc`, the set of plugins is visible in one file, and tests can import the
registry and assert invariants (unique names, unique command names, disjoint `customId` prefixes)
without walking the filesystem. It works unchanged in the image (`COPY src ./src`). The one trap
is the fact above: a static `import` runs the module's top level, and today that means reading
`data/links.json` (`links.ts:215`) whether or not the plugin is enabled. So a static registry
should hold **lazy entries** — `() => import("./warbandeer")` or a factory that is only called
once the enable decision has been made — or plugin modules must be side-effect-free at import
(move the top-level `await` into `activate()`), or both.

**Filesystem discovery (`Bun.Glob` + dynamic `import()`).** Bun's own API is straightforward:
`new Glob("**/*.ts")`, then `scan(root)` / `scanSync(root)` with `ScanOptions` `cwd`, `absolute`,
`onlyFiles` (default on), `dot`, `followSymlinks` (`bun.com/docs/runtime/glob`), and "You can also
load ES modules on the fly with the asynchronous `import()` function, called a 'dynamic import'"
(`bun.com/docs/runtime/modules`). This is exactly what the discord.js guide recommends
(quoted in §1d) and what Sapphire's `Store` does. The costs, all from primary sources:

- A dynamic `import()` of a computed path is `Promise<any>` to `tsc`, so the module's shape is
  unchecked at compile time; the guide's own loader therefore validates at runtime —
  `if ('data' in command && 'execute' in command) { ... } else { console.log(\`[WARNING] The
  command at ${filePath} is missing a required "data" or "execute" property.\`); }`
  (`discordjs/guide`, `guide/creating-your-bot/command-handling.md`). A discovery-based host needs
  the same guard (and a test for it), where a static registry gets it from `tsc` for free.
- "Which plugins exist" becomes a property of the directory tree, so a test that wants to
  enumerate them has to walk the tree too, and a stray `*.ts` helper in the plugins directory is a
  plugin unless filtered. Sapphire's `LoaderStrategy.filter` shows the filtering a real loader ends
  up needing: it skips extensions it doesn't support, skips `.d.ts` (only when TypeScript loading
  is enabled — `CanLoadTypeScriptFiles`, true under Bun), and skips any file whose basename
  `startsWith('_')` (`sapphiredev/pieces`, `src/lib/strategies/LoaderStrategy.ts:29-47`).
- Bun-specific rough edge, from the same file: the Sapphire loader carries a "Bun workaround:
  Import a file path with search params instead of an file URL to force re-evaluation due to
  caching bug" for its reload path — relevant only if hot-reloading plugins is ever wanted; not
  relevant for load-once-at-boot.
- Both variants ship fine under `COPY src ./src`; only a future `bun build --compile` step (not
  used here) would care that a computed `import()` can't be statically bundled.

Neither variant needs new dependencies. The difference that matters for this repo is
*type-checked plugin shape + explicit list* vs *drop-a-folder-in convenience*; with `tsc` as the
only static gate, the static registry keeps more of the repo's existing safety net.

### 1b. Bun workspaces (`packages/plugin-*`)

Bun's workspace model, from `bun.com/docs/pm/workspaces`: workspaces are declared with a
`"workspaces": ["packages/*"]` field in the root `package.json` (Bun supports "full glob syntax in
`"workspaces"`, including negative patterns such as `!**/excluded/**`"); `bun install` "installs
your local `packages/a` directory into `node_modules`"; the stated benefits are "Split code into
logical parts. If one package relies on another, add it as a dependency in `package.json`", "Bun
can de-duplicate dependencies" (hoisted to the root `node_modules`), and "Run scripts in multiple
packages" via `--filter`/`--workspaces`. Cross-package references use `workspace:*`, which Bun
rewrites on publish (`"workspace:*" -> "1.0.1"`). `bun.com/docs/pm/filter`: "By default,
`bun install` installs dependencies for every package in the monorepo. To install dependencies for
specific packages, use `--filter`."

What the repo would have to change:

- **Root `package.json`** gains `workspaces`; today it has none (`docs/research/2026-09-03-ci-github-actions.md`,
  "Repo facts"), and `ops/admin` is a deliberately separate install with its own `bun.lock` — a
  workspace root would either absorb it or keep it excluded via a negative glob.
- **`Dockerfile:4-5`** copies only `package.json bun.lock` before `bun install --frozen-lockfile
  --production`. With workspaces, the lockfile records the workspace packages, so their
  `packages/*/package.json` files would need to be `COPY`'d in before the install layer as well
  (Bun's own Docker guide, `bun.com/guides/ecosystem/docker`, shows only the single-package shape:
  `COPY package.json bun.lock /temp/prod/` then `bun install --frozen-lockfile --production`).
  *Not verified by running an install in this pass* (installing is out of scope); treat "frozen
  install fails with workspace `package.json`s absent" as the expected behaviour to confirm, not a
  measured one. `--frozen-lockfile` itself: "Bun installs the exact versions specified in the
  lockfile and does not update it. If your package.json disagrees with bun.lock, Bun exits with an
  error"; and "`--production` implies `--frozen-lockfile`. It only controls what gets installed"
  (`bun.com/docs/pm/cli/install`).
- **`Dockerfile:7`** `COPY src ./src` would need `COPY packages ./packages` (or a build stage), and
  **`tsconfig.json:14`** `"include": ["src"]` would need `packages` added or per-package
  `tsconfig.json`s + a second `check` invocation, exactly the two-`tsc` situation the CI research
  found for `ops/admin`.
- `bun test` from the root already recurses everywhere (`bun.com/docs/test/discovery`: it
  "recursively searches the project directory" and "ignores: node_modules directories") — so tests
  under `packages/` run with no CI change, same as `ops/admin/server.test.ts` today
  (`.github/workflows/ci.yml:37-42`).
- Bun "only reads overrides from the root `package.json`, not from workspace packages"
  (`bun.com/docs/pm/overrides`, as quoted in the CI research) — the `undici` override
  (`package.json:20-22`) stays a root concern either way.
- Self-update is unaffected in principle: it builds from the whole repo at a branch
  (`src/redeploy.ts:62-63`), so a `packages/` tree is in the build context.

What it buys: a per-plugin `package.json` — its own dependencies (a future LLM SDK stays out of
the core's one-runtime-dep manifest, `package.json:13-15`), its own version, and a natural home for
manifest fields. What it costs: three toolchain files change for a single-process bot that today
has one runtime dependency, plus a Docker layer/`tsc` shape that the repo has already found awkward
for `ops/admin`.

### 1c. External npm/git dependencies

Bun accepts git dependencies in these forms (`bun.com/docs/pm/cli/install`, `bun.com/docs/pm/cli/add`):
`"git+https://github.com/iamkun/dayjs.git"`, `"git+ssh://github.com/lodash/lodash.git#4.17.21"`,
`"git@github.com:moment/moment.git"`, `"github:colinhacks/zod"`, plus tarball URLs. Two limits
bear on "a plugin as a git dep":

- **No sub-directory support.** The only mention of sub-directories in Bun's install docs is in the
  pnpm-migration "Requirements and limitations": "Relative `link:` dependencies and git
  dependencies with a sub-directory (`resolution.path`) are not supported"; `bun add`'s git
  section does not mention sub-directories at all. So a plugin living inside another repo's
  `packages/<x>` cannot be pointed at directly — it needs its own repo, a tarball, or vendoring.
- **`workspace:*` inside the dependency does not resolve outside its workspace** — the problem the
  prior research documented for `@discord-ai/bot` → `@discord-ai/core`
  (`docs/research/2026-09-01-discord-ai-integration.md`, §2). Any multi-package plugin repo has the
  same issue unless it publishes real versions.
- **Credentials.** The image build has none: `README.md:82` — "`GITHUB_REPO` must also be
  **publicly clonable** — the daemon fetches the build context itself, with no credentials." A
  private git dependency would break `bun install` inside the self-update build the same way.
  (discord-ai is private *and* unlicensed for this use; see §5.)
- `--frozen-lockfile` pins the resolved commit in `bun.lock`, so an external plugin is updated by a
  lockfile bump + rebuild — the same rebuild-and-redeploy a change under `src/` needs, so
  externalising a plugin does not by itself decouple its release cadence from the bot's.

### 1d. What the references actually do

| Reference | Registration unit | How the host hands over capabilities | Ordering / lifecycle | Metadata & validation |
|---|---|---|---|---|
| **discord.js guide** (`discordjs/guide`, `creating-your-bot/*.md`) | A file per command exporting `{ data: SlashCommandBuilder, execute(interaction) }`; a file per event exporting `{ name: Events.X, once?: boolean, execute(...) }` | `client.commands = new Collection()` — "We recommend attaching a `.commands` property to your client instance"; handler does `interaction.client.commands.get(interaction.commandName)` and logs "No command matching ${interaction.commandName} was found." | Files read with `fs.readdirSync(...).filter(file => file.endsWith('.js'))` + `require`; deploy is a *separate script* — "Slash commands only need to be registered once, and updated when the definition (description, options etc) is changed. As there is a daily limit on command creations, it's not necessary nor desirable to connect a whole client to the gateway or do this on every `ready` event." | Runtime shape check (`'data' in command && 'execute' in command`) with the `[WARNING]` message above |
| **Sapphire** (`sapphiredev/framework` `src/lib/plugins/*.ts`, `SapphireClient.ts`; `sapphiredev/pieces` `Store.ts`, `StoreRegistry.ts`) | *Plugin* = a class with static hook methods keyed by symbols `preGenericsInitialization`, `preInitialization`, `postInitialization`, `preLogin`, `postLogin` (`Plugin.ts`); *Piece* = a command/listener/precondition class file in a store directory | Hooks are called with `this` bound to the client: `plugin.hook.call(this, options)`; pieces reach the client through the shared container | Constructor calls `super(options)` **first** — discord.js's `Client` constructor, which is where intents get frozen (`Client.js:544`) — and only then runs `PluginHook.PreGenericsInitialization` → `PreInitialization` → `PostInitialization` in order; `login()` runs `this.stores.registerPath(this.options.baseUserDirectory)`, then the `PreLogin` hooks, then `Promise.all([...this.stores.values()].map((store) => store.loadAll()))`, then `super.login(token)`, then `PostLogin` (`SapphireClient.ts`, constructor and `login()`). `PluginManager.use(plugin)` reflects each symbol off the class and registers it; `registerHook` throws "The provided hook ... is not a function" | `Store.insert` honours a piece's `enabled` flag (a piece disabled after `onLoad` is unloaded rather than kept); `LoaderStrategy.filter` skips unsupported extensions, `.d.ts`, `_`-prefixed files. The guide's "cog" page groups a feature's commands+listeners under one folder registered with `this.stores.registerPath(join(this.rootData.root, 'audio'))` — "group commands, listeners and other pieces into a Cog ... which can then be loaded and unloaded as a whole" |
| **Fastify** (`fastify.dev/docs/latest/Guides/Plugins-Guide/`, `Reference/Encapsulation/`, `fastify-plugin` README + `index.js`, `fastify/lib/plugin-utils.js`) | `fastify.register(plugin, options)` with `module.exports = function (fastify, options, done) {}` (or async) | The plugin receives the instance and extends it via `fastify.decorate(name, value)`; "register creates a new Fastify context, which means that if you perform any changes on the Fastify instance, those changes will not be reflected in the context's ancestors. In other words, encapsulation!" — `fp(plugin)` (fastify-plugin) "breaks the encapsulation" so decorators reach the parent | Plugins load in registration order after `.listen()`/`.ready()`; `after()` for post-registration logic | `fastify-plugin` stores `{ name, fastify: '5.x', dependencies: [...], decorators: { fastify: [...], reply: [...], request: [...] }, encapsulate }` on `fn[Symbol.for('plugin-meta')]` (`index.js`). Fastify enforces it at register time (`plugin-utils.js`): `checkVersion` → `semver.satisfies(this.version, requiredVersion)` else `FST_ERR_PLUGIN_VERSION_MISMATCH` ("fastify-plugin: %s - expected '%s' fastify version, '%s' is installed"); `checkDependencies` → `FST_ERR_PLUGIN_DEPENDENCY_NOT_REGISTERED` ("The dependency '%s' of plugin '%s' is not registered"); `checkDecorators` → `FST_ERR_PLUGIN_NOT_PRESENT_IN_INSTANCE` ("The decorator '%s'%s is not present in %s"); `registerPluginName` records names in `kRegisteredPlugins` |
| **Probot** (`probot.github.io/docs/hello-world/`) | "A Probot app is just a Node.js module that exports a function: `export default (app) => { // your code here };`" | `app` is "an instance of `Probot`"; handlers get a `context` with `context.octokit` ("an authenticated GitHub client that can be used to make REST API and GraphQL calls"), `context.payload`, `context.log` — the app never constructs its own client | `app.on("issues.opened", async (context) => { ... })` | none beyond the function shape |
| **Vite** (`vite.dev/guide/api-plugin.html`) | "A Vite plugin is an object with a name property" | Hooks receive host objects — `config`, `configResolved`, `configureServer` (the dev `server`), `transformIndexHtml`, `handleHotUpdate`, plus Rollup's `options`/`buildStart`/`resolveId`/`load`/`transform`/`buildEnd`/`closeBundle` | `enforce: 'pre' | 'post'` orders relative to core plugins; `apply: 'build' | 'serve'` gates when a plugin is active | `name` required; `vite-plugin-` naming convention |
| **Hono** (`hono.dev/docs/guides/middleware`) | `app.use(async (c, next) => { ... })` / `createMiddleware` | Middleware receives the context `c` and `next` | "The order in which Middleware is executed is determined by the order in which it is registered." | none |

The common shape across all six: the **host constructs the client/instance and hands the plugin a
capabilities object**; the plugin is a **named unit with declared hooks**; **registration order is
execution order**; and the two most mature systems (Fastify, Sapphire) **validate declared metadata
at registration time** rather than discovering conflicts at first use. Sapphire is also the only
reference whose hook stages are keyed to the client lifecycle (`pre`/`postInitialization`,
`pre`/`postLogin`) — but its constructor calls `super(options)` *before* any of them, so even
`PreGenericsInitialization` runs after discord.js has already frozen the intents (`Client.js:544`);
none of the six references offers a hook that runs before the client exists. That pre-construction
stage — where intents can still be shaped — is exactly what this bot's standby invariant needs (§2,
"Gateway intents" and "Lifecycle"), and it has to be a static declaration, not a hook.

## 2. Extension-point inventory

Verified against the code in the main tree. "Today" = where the host surface lives; the three
right-hand columns say what each candidate plugin uses or would need from it.

| Host surface | Where it lives today (`file:line`) | What `src/warbandeer/` uses | What a WoW plugin would use | What a discord-ai-style plugin would need |
|---|---|---|---|---|
| **Slash commands** (builders + dispatch under `COMMAND_PREFIX`) | `commandData` const built at import via `cmd(name)` = `new SlashCommandBuilder().setName(\`${prefix}${name}\`)` (`src/commands.ts:40-44,55-95`); one bulk `rest.put` in `activate()` (`src/index.ts:34-41`); dispatch `switch (bareName(interaction.commandName))` (`commands.ts:98-208`), no `default` | `cmd("link")`/`cmd("unlink")` + the `account_label` option with `.setMaxLength(MAX_ACCOUNT_LABEL_LENGTH)` imported from `characters.ts` (`commands.ts:23-24,82-94`); `case "link"`/`"unlink"` delegate to `link-command.ts` (`:200-207`) | `/dmf` `/reset` `/status` `/transmog` builders (`:56-60,70-77`) and handlers (`:99-135,169-195`), which read `config.realmSlug` and call `realmWatchConfigured()`/`blizzardConfigured()` | `CommandDef { name, description, options?, handler }` → JSON via `toCommandBody` (`packages/bot/src/registration.ts`); host must apply the prefix, dispatch by bare name, and coerce options (`interaction.options.get(opt.name)?.value`, `packages/bot/src/client.ts`) |
| **Other interactions** (modal/button `customId` namespaces) | `interaction.isModalSubmit() && isReportModal(interaction.customId)` (`src/index.ts:67`); `MODAL_PREFIX = "report:"` (`src/report.ts:14,56-58`); no buttons/selects anywhere | none | none | none in discord-ai (`#handleInteraction` returns unless `isChatInputCommand()`); a host registry keyed on a `<plugin>:` `customId` prefix would generalise the `report:` precedent |
| **Gateway intents** | `CLIENT_OPTIONS = { intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } }` (`src/client.ts:8-11`), consumed by `new Client(...)` (`:13-15`) before `resolveBootMode` and `login` (`src/index.ts:12-15,115`). Fixed at construction — see the note below the table | Guilds only | Guilds only | `Guilds, GuildMessages, GuildMessageReactions, DirectMessages, MessageContent` + `partials: [Partials.Channel]` (`packages/bot/src/client.ts`) — `MessageContent` is privileged |
| **Gateway events** | `client.once(Events.ClientReady)` (`src/index.ts:17`), `client.on(Events.InteractionCreate)` (`:63`) — nothing else in `src/` | none | none | `client.on(Events.MessageCreate, ...)` (`packages/bot/src/client.ts` `start()`), skipping the bot's own messages and, per watcher, other bots (`runMatch`, `packages/core/src/watcher.ts`) |
| **Scheduler tick checks** | `startScheduler` 60 s `setInterval` (`src/announce.ts:11,31-35`); `onTick` = `restartPending()` gate → `guardedTick` (in-flight guard + 5 min watchdog, `:102-141`) → `withCritical` → `runTick([...5 fixed TickChecks])` (`:150-175`); `TickCheck { name, run }` (`:52-55`); per-check isolation with `[tick:${name}]` logging (`:63-71`); poll gaps via module-level timestamps (`:27-29`) | none | `dmf`, `weeklyReset`, `realm` checks (`:198-242`) and their gap constants (`:12-15`) | none (event-driven, not polling) |
| **Announcements / channel routing** | closed union `AnnounceKind = "dmf" \| "weeklyReset" \| "serverUp" \| "serverDown" \| "release"` (`:37`), `channelFor(kind)` (`:40-42`), `announce(client, kind, message)` = `channels.fetch` → `isSendable()` → `send` (`:44-50`); env `ANNOUNCE_CHANNEL_ID`/`RELEASE_ANNOUNCE_CHANNEL_ID` (`src/config.ts:72,113`) | none | the four WoW kinds | `post(channelId, content)` → `sendToChannel` (same fetch/`isSendable`/`send` shape, `packages/bot/src/targets.ts`), `reply`, `react`, `thread`, `defer`/`followUp` (`packages/core/src/actions.ts`) |
| **Config** (env declaration + validation + `.env.example` + bash whitelist + panel) | `resolveConfig(env)` + `config` singleton at import (`src/config.ts:46,133`); `.env.example`; `ALLOWED`/`REQUIRED`/`ALLOWED_ORDER` (`ops/bot-ops.sh:93-158`); panel form rendered from `GET /api/env` (`ops/admin/public/index.html:850-861`; route → `env-get`, `ops/admin/server.ts:268-272`); hand-listed in `ops/README.md:89-91` | `WARBANDEER_INGEST_PORT` parsed `:100-108` into `Config.warbandeerIngestPort` (`:27-29,129`); `.env.example:53-57`; `bot-ops.sh:127,157`; `README.md:120-123` | `WOW_REGION` (`:67-69`), `DMF_TIMEZONE` (`:92-98`), `WOW_REALM`/`BLIZZARD_CLIENT_ID`/`BLIZZARD_CLIENT_SECRET` (`:116-118`); bash rows `:109-110,119`; the panel's WoW-specific realm chooser (`index.html:858-860` `loadRealms()`) | nothing of its own ("The library reads no configuration stores", `docs/PURPOSE.md`, per the prior research); a plugin around it adds whatever its handler backend needs |
| **Persistent storage** | `data/` (gitignored `.gitignore:3`; volume `state:/app/data` `docker-compose.yml:28`; `VOLUME /app/data` `Dockerfile:18`); `data/state.json` via `state.ts:35-38` + `createStateWriter` (`:107-119`); generic primitives `writeJsonAtomic`/`readJsonOrFresh`/`createJsonWriter`/`createKeyedJsonMutator` (`src/warbandeer/storage.ts:18,33,65,87`) | `data/links.json` (`links.ts:184-185`, loaded at import `:215`, `createJsonWriter` `:217`), `data/characters/<id>.json` (`characters.ts:146-149`, `createKeyedJsonMutator` `:175`) | dedup keys *inside* `BotState` (`state.ts:26-28`) + the `RealmStatus` type import (`:4`) | none (stateless library) |
| **Inbound HTTP** | one `Bun.serve` (`src/warbandeer/server.ts:307-325`) started in `activate()` only when configured (`src/index.ts:81-83`); `cloudflared` sidecar maps one public hostname → `http://bot:<WARBANDEER_INGEST_PORT>` (`README.md:171-172`, `docker-compose.yml:100-115`); the process runs as the non-root `bun` user (`Dockerfile:17`, `entrypoint.sh:17-19`), so a privileged port (< 1024) can't be bound — `src/index.ts:78-80` names it as a bind-failure cause | `POST /link`, `POST /characters` (`server.ts:157,178`), two rate limiters, `{ stop, port }` (`:332-338`) | none | none |
| **Lifecycle** (attach after `activate()`; `restartPending`/`withCritical`; stop/dispose) | everything attaches inside `activate(c)` after `takeOver()` (`src/index.ts:17-26,33`) — the standby invariant (`CONTEXT.md:226-228`); `restartPending()` (`src/restart.ts:80-82`), `withCritical()` (`:46-53`), `beginHandoff()` (`:63-66`); **no** shutdown hook, no `client.destroy()`, the connector's `stop` never called (`index.ts:83`) | started from `activate()`; returns `stop` (unused) | ticks stop via `restartPending()`; nothing to dispose | `DiscordAgentBot.start()` registers commands, attaches listeners, logs in; `stop()` = `client.destroy()` (`packages/bot/src/client.ts`) |
| **Error isolation** | try/catch around registration (`src/index.ts:35-61`), the interaction listener (`:64-72`), the connector start (`:84-91`, with the "must not become an unhandled rejection that crashes the whole bot into a restart:unless-stopped loop" rationale `:76-80`); `runTick` per check (`announce.ts:63-71`); `reportUpdateOutcome(...).catch` (`index.ts:95`) | relies on `index.ts`'s catch + its own `serverRunning` flag (`server.ts:29-32`) so `/link` distinguishes "not configured" from "failed to start" (`link-command.ts:25-39`) | per-check isolation + swallowed Blizzard errors (`announce.ts:227-231`) | `onError?: (error, source)` with sources `command:<name>` / `watcher:<name>`, default `console.error(\`[discord-ai] ${src}:\`, err)` (`packages/bot/src/client.ts`) |
| **Logging prefixes** | plain `console.*` with bracket prefixes: `[startup]` (`index.ts:52,86`), `[interaction]` (`:71`), `[tick]`/`[tick:<name>]` (`announce.ts:32,68,111,121`), `[announce]` (`:49`), `[realm]`/`[release]` (`:229,252,266`), `[state]` (`state.ts:60`), `[handoff]`/`[restart]` (`restart.ts:65,72,93,97`); no logger object | `[warbandeer]` (`server.ts:242,258,268,331`), `[links]`/`[characters]` via `readJsonOrFresh`'s `label` (`links.ts:208`, `characters.ts:164`) | `[realm]` etc. | `[discord-ai]` |
| **Tests** | root `bun test` recurses (`.github/workflows/ci.yml:41-42`; discovery patterns `*.test.{js\|jsx\|ts\|tsx\|mjs\|cjs\|mts\|cts}` etc., `bun.com/docs/test/discovery`); config-singleton priming + `await import()` rule (`CONTEXT.md:436-448`) | 5 test files under `src/warbandeer/` (Glob); `server.test.ts:11,14` primes `DISCORD_TOKEN` and dynamic-imports `./server`; real listener on port 0 | 3 test files under `src/wow/` | its own vitest suite (not ours) |
| **Docs** | `CONTEXT.md` file-map row per module (`:50-97`), Language glossary (`:17-46`), Behavior (`:99-127`), gotchas; `README.md` feature bullets (`:12-22`) + Files table (`:183-209`); `.env.example`; `docs/adr/` | rows `CONTEXT.md:92-97`, glossary `:17-46`, behavior `:123-127`, gotchas `:430-444`; `README.md:21,112-172,205-209`; ADRs 0001-0003 | rows `CONTEXT.md:75-82`; `README.md:14-16,19,190-191,201-203` | n/a |

**Intents are fixed at construction: widening them after `new Client()` is not part of discord.js's
API, and after login it would take a reconnect.** discord.js's typings declare `intents` as the one required `ClientOptions` field
(`node_modules/discord.js/typings/index.d.ts:6227-6243`, `intents: BitFieldResolvable<GatewayIntentsString, number>` at `:6236`)
and expose the resolved value as `options: Omit<ClientOptions, 'intents'> & { intents: IntentsBitField }`
(`:1158`). The constructor calls `this._validateOptions()` (`node_modules/discord.js/src/client/Client.js:81`),
which does `options.intents = new IntentsBitField(options.intents).freeze()` (`:544`) — frozen at
construction. `login()` (`:216`) calls `this.ws.connect()` (`:229`), and `connect()` reads
`const { shards, shardCount, intents, ws } = this.client.options` and passes
`intents: intents.bitfield` into the `WSWebSocketManager` it builds
(`src/client/websocket/WebSocketManager.js:139-148,164`). Precisely: what is frozen is the
`IntentsBitField` instance — `client.options` itself is a fresh spread object (`BaseClient.js:27-29`)
that `connect()` reads lazily, so reassigning the property before `login()` is unsupported rather
than impossible; nothing in the API offers it. On the wire, "Intents are bitwise values
passed in the `intents` parameter when Identifying which correlate to a set of related events",
"If you do not specify an intent when identifying, you will not receive *any* of the Gateway
events associated with that intent", and passing an invalid intent closes the socket with `4013`
(`docs.discord.com/developers/events/gateway`, "Gateway Intents"). Consequence for a plugin
framework: **intent declarations must be collected before `createClient()` runs** (`src/index.ts:12`),
i.e. from static manifests, not from `activate()` — which also means enabled-plugin resolution
has to happen before the standby decision, not inside it.

**Privileged intents.** "Before you can specify any of these privileged intents in your `IDENTIFY`
payload, you must enable the specific privileged intents you need in the Developer Portal", and
otherwise "your Gateway connection will be closed with a (`4014` close code)"; the privileged set
is `GUILD_PRESENCES`, `GUILD_MEMBERS`, `MESSAGE_CONTENT`; verification-qualifying apps (100+
guilds) "**must** be approved for the privileged intent(s)". `MESSAGE_CONTENT` gates "the
`content`, `embeds`, `attachments`, `components`, and `poll` fields", except "Content in messages
that an app sends", "Content in DMs with the app", "Content in which the app is mentioned", and
"Content of messages where a message context menu command is used"
(same page, "Privileged Intents" / "Message Content Intent"). `README.md:33` currently promises
"No privileged intents are needed" — a watcher plugin changes that sentence and adds a Developer
Portal step to setup.

## 3. Enable/disable model

Three candidate mechanisms, against what the repo does today:

| Model | Evidence / how it would work here | Tradeoffs |
|---|---|---|
| **Per-plugin env presence** (today) | `warbandeerConnectorConfigured()` = `config.warbandeerIngestPort !== undefined` (`server.ts:21-23`); `/link` reports "not configured" vs "failed to start" (`link-command.ts:25-39`); ADR-0001's "fail closed when unconfigured". `/report` works the same way (`REPORT_ROLE_ID` + `GITHUB_TOKEN`, `report.ts:62-67`), as do `/status`/`/transmog` (`realmWatchConfigured`, `blizzardConfigured`) | Zero new keys; matches the operator model (one `.env`, edited via `env-set`). Cannot disable a plugin that needs no config; "enabled" is implicit and per-feature rather than per-plugin, and the commands of a *configured-but-broken* plugin still register (that's what the "configured vs running" split exists for) |
| **Explicit `PLUGINS=` allow-list (or `DISABLED_PLUGINS=`)** | A new key through `resolveConfig`'s `list()` helper (`config.ts:58-65`) and a new `ALLOWED`/`ALLOWED_ORDER` row; the host filters the registry before collecting intents/commands/env | One switch per plugin regardless of config; lets an operator turn off a plugin that has nothing to unset. Adds a key to every surface in the Config row of §2; unknown names need a loud boot failure (the `resolveConfig` throw pattern, `config.ts:49,68-70,83-86`) |
| **Build-time inclusion** (a build arg selects plugins, or the Dockerfile copies a subset) | The image already takes a `GIT_SHA` build arg (`Dockerfile:12-13`), but self-update's rebuild passes exactly one build arg of its own — `buildArgs: { GIT_SHA: latestSha }` (`src/redeploy.ts:210-214`) — and `buildCreateSpec` copies the *container's* runtime env while deliberately dropping `GIT_SHA=` (`:135-143`, `CONTEXT.md:72`); nothing carries an arbitrary build arg across a `/update` | Toggling a plugin means a rebuild + swap instead of an `env-set` recreate; the admin panel's whole config surface (`env-get`/`env-set`) can't express it; and the first `/update` would silently rebuild *without* the arg unless `redeploy.ts` learned to persist and re-pass it. Only worth it if a plugin's *dependencies* must not ship in some images |

**Unregistering a disabled plugin's commands is already handled by the existing bulk overwrite.**
Discord's docs for `PUT /applications/{application.id}/commands`: "Takes a list of application
commands, overwriting the existing global command list for this application" — and for the guild
route, "overwriting the existing command list for this application for the targeted guild"; both
add "This will overwrite **all** types of application commands: slash commands, user commands, and
message commands" (`docs.discord.com/developers/interactions/application-commands`, "Bulk Overwrite
Global/Guild Application Commands"). The discord.js guide's deploy script says the same: "The put
method is used to fully refresh all commands in the guild with the current set"
(`discordjs/guide`, `command-deployment.md`). The repo already relies on it: `CONTEXT.md:380-382`
— "since `index.ts`'s `rest.put` fully replaces an application's command set, switching the prefix
and restarting removes the old names automatically." So a disabled plugin's commands disappear on
the next boot with no extra API call, *provided* the host builds the body from enabled plugins only
— which `commandData` can't do today, being a module-level const (`commands.ts:55`). Two caveats
from the same Discord page: "200 application command creates per day, per guild", and "Commands
that do not already exist will count toward daily application command create limits" — irrelevant
at this bot's scale, but it is why the discord.js guide runs deployment as a
separate script rather than on every `ready`; this bot deliberately registers on every boot
(`src/index.ts:36-41`) and lives with the (tiny) quota cost.

**Getting plugin-declared env keys into `bot-ops.sh`'s whitelist.** The whitelist is three bash
literals — `declare -A ALLOWED=(...)` (`ops/bot-ops.sh:93-128`), `declare -A REQUIRED=(...)`
(`:137-139`), `ALLOWED_ORDER=(...)` (`:144-158`) — consumed by `cmd_env_get` (`:301-328`, with the
same-keys assertion at `:310-318`) and `cmd_env_set` (`:357` membership, `:378` format regex).
`WARBANDEER_INGEST_PORT` was added by hand at `:127` with the full 1-65535 regex and a comment
explaining why the shape must be strict (env-set's `--force-recreate` runs before `config.ts` can
reject a bad value). Options, in increasing order of machinery:

1. **Hand-duplication guarded by a drift test** — the existing pattern. `ops/admin/server.test.ts:1523-1536`
   lifts `ALLOWED[WOW_REALM]` out of `ops/bot-ops.sh` and `REALM_SLUG_RE` out of `index.html` and
   asserts "both source patterns are present and identical (mirror can't drift)"; the same file does
   it for `DMF_TIMEZONE` (`:1951-1967`) and `REQUIRED` (`:1990-2004`). A plugin-manifest analogue
   reads each plugin's declared `{ key, regex, required, order }` and the bash arrays, and asserts
   set equality + regex equality + order. Note the dialect gap the existing test already names:
   bash `[[ =~ ]]` is POSIX ERE evaluated possibly in a C locale (`bot-ops.sh:99-108`'s enumerated
   accented letters exist for exactly that reason), JS `RegExp` is not — the mirror test "mirrors
   bash ERE for this simple pattern rather than proving" equivalence (`server.test.ts:1528`). A
   manifest regex therefore has to stay in the ERE-safe subset, and the test should say so.
2. **A JSON manifest read by both TS and bash via `jq`.** `bot-ops.sh` already `need`s `jq`
   (`:266,302,331`). The obstacle is delivery, not parsing: the admin container sees the script via
   the `/opt/rackbops-discord-bot/bin` bind mount (`docker-compose.yml:93-95`) and never sees
   `src/`; `ops/install.sh` writes "the shared `bin/bot-ops.sh`" (`CONTEXT.md:90`). A manifest would
   have to become a second file `install.sh` ships into `bin/`, kept in lockstep with the bot image
   the box is actually running — a new place for skew, since `env-set` deliberately never rebuilds
   (`CONTEXT.md:233-235`).
3. **A generator that rewrites the bash arrays** between marker comments from the TS manifests,
   with a CI check that regenerating produces no diff. Keeps `bot-ops.sh` self-contained (option 2's
   delivery problem disappears) and keeps the arrays reviewable in the diff; costs a script, a
   `bun run` entry, and a CI step. Same ERE-subset constraint as option 1.

Either 1 or 3 preserves the property the panel depends on — that `GET /api/env` is the single
source of the form (`index.html:850-854`: "Rendered from whatever GET /api/env returns, rather
than a hardcoded field list — stays in sync with ops/bot-ops.sh's own ALLOWED whitelist
automatically"). `ops/README.md:89-91`'s hand-written key list and `.env.example` remain
hand-maintained under every option unless the same generator emits them.

## 4. Isolation & versioning

**In-process vs worker/subprocess.** Bun's Worker lets you "start and communicate with a new
JavaScript instance running on a separate thread while sharing I/O resources with the main
thread"; "The Worker API is still experimental (particularly for terminating workers)";
messages cross via `postMessage` and "the HTML Structured Clone Algorithm"; a worker's
`process.exit()` doesn't affect the main process, and a script that fails to resolve emits an
`"error"` event on the `Worker` rather than crashing the main thread (`bun.com/docs/runtime/workers`).
Against this repo's actual shape, a worker per plugin costs more than it isolates:

- The plugin contract is built around discord.js objects — a `ChatInputCommandInteraction`
  (`commands.ts:97`), a `Client` (`announce.ts:44`) — none of which structured-clone. A worker
  needs a serialisable protocol in between; discord-ai's `Action`/`Dispatch` (`packages/core/src/actions.ts`)
  is one, but adopting that shape is a much bigger change than adding a registry.
- Every persistence primitive is single-process by design: `createStateWriter`, `createJsonWriter`
  and `createKeyedJsonMutator` serialise writers with an in-memory promise chain
  (`state.ts:107-119`, `storage.ts:65-100`), and `storage.ts:10-16` is explicit that
  `writeJsonAtomic` is "**Not safe to call directly from two places that might race on the same
  `path`**". A second process (or thread) touching `data/` reintroduces exactly the torn-write /
  lost-update classes those wrappers were written to close.
- The lifecycle invariants (`restartPending`, `withCritical`, `beginHandoff`, `restart.ts:46-82`)
  are module-level counters in one process; a worker can't participate in them without a second
  protocol.
- Scale doesn't justify it: the connector is sized for "a handful of guild members' own desktop
  apps, not a public API" (`server.ts:41-42`), and the scheduler ticks once a minute
  (`announce.ts:11`).

The evidence points to **in-process, with the isolation the code already practises**: a try/catch
around each plugin's `activate()` (the shape of `index.ts:84-91`), per-plugin isolation inside the
tick (already what `runTick` gives each `TickCheck`, `announce.ts:63-71`), the existing
interaction-listener catch (`:70-72`), and a *running* flag per plugin so a command can report
"configured but failed to start" (`server.ts:29-32`, `link-command.ts:32-37`) — the bot's own
"init failure must not crash the bot" posture, generalised.

**Contract versioning.** Fastify's model is the worked reference: a plugin declares
`{ name, fastify: '5.x', dependencies, decorators }`; the host checks `semver.satisfies(this.version,
requiredVersion)` and throws `FST_ERR_PLUGIN_VERSION_MISMATCH` before the plugin runs
(`fastify/lib/plugin-utils.js`, `checkVersion`). The equivalent here is a `hostApiVersion` (or a
semver range) in each plugin manifest checked at registry-load time, with a loud, named failure
(`config.ts`'s `throw new Error(\`...\`)` style) — cheap, and it makes "which plugins are compatible
with this host" a build-time fact rather than a runtime surprise. Whether to check with a real
semver-range comparison (Bun ships a `Bun.semver` namespace; its docs were not fetched in this pass
— verify before relying on it) or a plain integer `hostApiVersion === N` is a design-phase choice;
with every plugin in-repo, an integer is enough until something lives out of tree.

**DI for unit tests.** The repo's convention is already the right one for plugins: `handleRequest(req,
clientIp, deps)` is pure over a `WarbandeerDeps` interface (`server.ts:78-98,154`), and
`createProductionDeps(overrides?)` binds the real singletons while letting a test swap
`linksState`/`persistLinks`/`charactersBaseDir` (`:222-278`); `linkAvailability(configured,
running)` is a pure decision function (`link-command.ts:25-39`); `commitReleaseAnnouncements(releases,
seen, deps)` injects `announce`/`persist` (`announce.ts:297-315`); `ops/admin/server.ts`'s
`HandlerConfig` injects `runBotOps` (`CONTEXT.md:91`). A plugin's `activate(host)` should take a
`HostApi` object of the same kind — `registerCommand`, `registerTick`, `announce`, `log`,
`dataDir`, the plugin's resolved config slice — so a test calls `activate(fakeHost)` and asserts
what was registered, without a `Client`. Passing config through the host object rather than
importing the `config` singleton also sidesteps the standing gotcha that every test reaching
`config` must prime env vars and use `await import()` (`CONTEXT.md:445-448`; `server.test.ts:11,14`).

## 5. discord-ai as a reference shape

Read directly from `Lepid-Labs/discord-ai` (`gh api .../contents/<path>`, base64-decoded; 4
commits, HEAD 2026-09-02). The exact API:

- **`packages/core/src/command.ts`** — `type OptionType = "string" | "integer" | "number" | "boolean" | "user" | "channel"`;
  `interface CommandOption { name; description; type: OptionType; required? }`;
  `interface CommandContext { command: string; options: Readonly<Record<string, string | number | boolean>>; userId; channelId; guildId: string | null; dispatch: Dispatch }`;
  `interface CommandDef { name; description; options?: CommandOption[]; handler: (ctx: CommandContext) => void | Promise<void> }`;
  `validateCommand(def)` throws on `NAME_RE = /^[a-z0-9_-]{1,32}$/` misses, description
  length (1-100), more than 25 options, duplicate option names, and "required options must
  precede optional ones". (Narrower than Discord's own name rule, which is a Unicode class regex
  with "If there is a lowercase variant of any letters used, you must use those" — and the same
  charset as this repo's `COMMAND_PREFIX` check `/^[a-z0-9_-]{1,20}$/`, `config.ts:82`.)
- **`packages/core/src/watcher.ts`** — `interface MessageEvent { messageId; channelId; guildId: string | null; authorId; authorIsBot: boolean; content }`
  ("transport-agnostic, no discord.js types"); `type Matcher = (content: string) => string[] | null`
  ("An empty array is still a match"); `interface WatchContext extends MessageEvent { matches: string[]; dispatch }`;
  `interface WatcherDef { name; match: Matcher; includeBots?: boolean; handler: (ctx: WatchContext) => void | Promise<void> }`;
  `runMatch(watcher, event)` returns `null` for bot authors unless `includeBots`.
- **`packages/core/src/matchers.ts`** — `extractUrls`, `urlMatcher(hosts)` (hostname equals or
  ends with `.${host}`), `youtubeLinks`, `tiktokLinks`, `anyLink`, `contentMatcher(pattern)`,
  `anyOf(...matchers)`.
- **`packages/core/src/actions.ts`** — a tagged union `Action = { kind: "reply", content, ephemeral? } | { kind: "react", emoji } | { kind: "defer", ephemeral? } | { kind: "followUp", content, ephemeral? } | { kind: "post", channelId, content } | { kind: "thread", name, content }`,
  `type Dispatch = (action: Action) => Promise<void>`, and constructors `reply/react/defer/followUp/post/thread`.
- **`packages/bot/src/client.ts`** — `interface BotConfig { token; applicationId; guildIds?: string[]; onError?: (error: unknown, source: string) => void }`;
  `class DiscordAgentBot` with `registerCommand(def)` (validates, throws `Command "${def.name}" is already registered` on duplicates),
  `registerWatcher(def)`, `start()` (bulk `rest.put` per guild or global → attach `InteractionCreate` + `MessageCreate` → `login`),
  `stop()` (`client.destroy()`), and the intents it constructs the client with:
  `[GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent]`
  with `partials: [Partials.Channel]` — matching `packages/bot/README.md`'s "Required gateway
  intents (enable **Message Content** in the Discord developer portal for watchers to see message
  text): Guilds, Guild Messages, Message Content, Direct Messages, Guild Message Reactions".
- **`packages/bot/src/dispatcher.ts`** — `interface DispatchTarget { reply(content, ephemeral); react(emoji); defer(ephemeral); followUp(content, ephemeral); startThread(name, content); postTo(channelId, content) }`,
  `execute(target, action)`, `boundDispatch(target)`. **`targets.ts`** adapts a `Message`
  (`message.reply`, `message.react`, `message.startThread({ name })` then `thread.send`, `defer`
  a no-op) and a `ChatInputCommandInteraction` (`reply` falls back to `followUp` once
  `deferred || replied`; `react` throws "react is not supported for command interactions — reply
  instead"; `startThread` via `fetchReply()`); both share `sendToChannel` = `channels.fetch` →
  `isSendable()` → `send`, i.e. the same three calls as this repo's `announce()` (`announce.ts:46-48`).
- **`packages/bot/src/registration.ts`** — `toCommandBody(def)` maps `OptionType` onto
  `ApplicationCommandOptionType` and emits `RESTPostAPIChatInputApplicationCommandsJSONBody`.

**What a watcher-style plugin would need from this host**, in order of how much it changes:

1. **Two more intents at client construction** — `GuildMessages` + the privileged `MessageContent`
   (and `GuildMessageReactions`/`DirectMessages` + `Partials.Channel` if reactions/DMs are wanted).
   Per §2 that must come from a static manifest before `createClient()` (`src/index.ts:12`), a
   Developer Portal toggle, and an edit to `README.md:33`.
2. **A `MessageCreate` subscription** owned by the host (none exists; `src/index.ts:63` is the only
   `client.on`), attached *inside* `activate()` like the interaction listener — a standby that
   listened to messages would double every watcher reply, the same invariant as `CONTEXT.md:226-228`.
   The host would fan each message out to enabled watchers with per-watcher try/catch (discord-ai's
   `#handleMessage` loop) and skip its own messages (`message.author.id === client.user?.id`).
3. **Actions**: reply/react/thread on the triggering message and `post` to a channel — a small
   `DispatchTarget`-like surface the host can implement over discord.js directly, with this
   client's `allowedMentions: { parse: [] }` default (`client.ts:8-11`) applying automatically to
   every send that goes through the `Client` (discord-ai sets no such default). `client.ts:6-7`
   names the one send path that bypasses it — `updateReport.ts`'s raw `REST().post()` sets the same
   default on its own body — so a dispatch surface built on raw REST would have to do likewise.
4. **Bot-author filtering** (`includeBots`) and **error routing** into the host's logging prefix
   scheme rather than `[discord-ai]`.

**License, re-stated.** Re-verified today (2026-09-04): `Lepid-Labs/discord-ai`'s README still
ends with `## License` / "Private — all rights reserved. Not licensed for distribution."; there is
still no `LICENSE` file (`contents/LICENSE` 404) and GitHub's `license` field is null; the repo has
4 commits, the latest (2026-09-02) CI-only ("ci: run Justfile recipes as lint and per-package test
jobs (#3)"). The conclusion of `docs/research/2026-09-01-discord-ai-integration.md` §1 stands
unchanged: **do not import `@discord-ai/core` or `@discord-ai/bot`**. This section uses it only as a
reference for the *shape* of a command/watcher/action contract — types and field names that any
host can define for itself — not as code to depend on.

## 6. Migration path

### 6a. Every file that references the connector today, and what changes

| Area | File(s) and lines | Role today | Change for a zero-behaviour-change carve-out |
|---|---|---|---|
| Host wiring | `src/index.ts:10` (import), `:76-92` (guarded `startWarbandeerServer` after `startScheduler`) | starts the server inside `activate()` | replaced by `plugin.activate(host)` in the same position, same try/catch, same `[startup] Warbandeer connector failed to start on :${port} — the bot keeps running without it; /link will report the feature disabled. ...` message (`:85-89`) |
| Commands | `src/commands.ts:23-24` (imports), `:82-94` (`link`/`unlink` builders), `:200-207` (cases) | builders + dispatch inline | builders move behind the plugin's `commands` contribution and the two `case`s behind a name→plugin lookup; `cmd()` prefixing stays in the host so `/link`, `/unlink`, `account_label` and `.setMaxLength(64)` register byte-identically |
| Config | `src/config.ts:27-29,100-108,129`; `.env.example:53-57` | `WARBANDEER_INGEST_PORT` parsed/validated in `resolveConfig` | unchanged in step 1 (same key, same error text `WARBANDEER_INGEST_PORT must be a valid port number, got "..."`); a plugin-declared env schema is a later, separate change |
| Ops | `ops/bot-ops.sh:127,157` (+ header comments `:3-7`); `ops/README.md:91` | whitelist row + display order | unchanged; §3's drift test is what eventually ties the row to the plugin manifest |
| Compose | `docker-compose.yml:100-104` (cloudflared comment), `:107` (`-tunnel` name) | routes the tunnel to the port | unchanged |
| Plugin code | `src/warbandeer/{server,link-command,links,characters,storage}.ts` | the connector | gains an `index.ts` (the plugin object); `storage.ts` is *shared* infrastructure (`state.ts` mirrors it, `CONTEXT.md:97`) and should move to the host, not stay plugin-private |
| Plugin tests | `src/warbandeer/{server,link-command,links,characters,storage}.test.ts`; `src/commands.test.ts:2` (imports `MAX_ACCOUNT_LABEL_LENGTH`) | pin the connector | unchanged in content; `commands.test.ts` may need the import path updated if files move |
| Docs | `CONTEXT.md:52,54` (the `src/index.ts`/`src/commands.ts` rows describe the wiring being replaced), `:17-46,92-97,123-127,430-444`; `README.md:21,112-172,205-209`; `docs/adr/0001-0003` | glossary, file map, behavior, gotchas, feature docs | file-map rows updated for the new module (`index.ts`), the host registry, and the rewired `src/index.ts`/`src/commands.ts` rows; README feature bullet unchanged; ADRs unchanged (they describe the connector, not its packaging) |
| Word-only matches | `docker-compose.yml:21,55,83-84`, `ops/README.md:6,12,141-164`, `src/redeploy.test.ts`, `ops/docker-compose.test.ts:128,142`, `src/docker.test.ts:98,104`, `src/wow/transmog.ts:16`, `ops/admin/server.test.ts:756-757`, fork notices | container/project names, the desktop apps' Ops tab, fixture path, a Lua filename, a token name | none — not the connector |

### 6b. Steps that keep every shipped identifier identical

1. **Define the contract in the host first, with the connector as the only entry.** A `Plugin`
   interface + a static registry of lazy entries, and a `HostApi` object with exactly what the
   connector needs today: the resolved port, `dataDir`, and a `log` — nothing speculative. Add the
   registry-invariant tests (unique plugin names, unique command names, `activate` is called after
   `startScheduler`, never on a standby).
2. **Make the connector module side-effect-free at import**, so a disabled plugin no longer reads
   `data/links.json` at boot: move `links.ts:215`'s top-level `await loadLinksFrom(LINKS_FILE)`
   into the plugin's `activate()` (or a lazy accessor), keeping `LINKS_FILE`'s resolved path
   identical. This is the one place behaviour *observably* changes for a disabled bot (one fewer
   file read, no `[links]` corrupt-file log line at boot); call it out in the PR and pin it with a
   test rather than letting it ride along silently.
3. **Do not move directories in the same change.** If the files stay at `src/warbandeer/`, the
   `import.meta.dir` paths (`links.ts:184`, `characters.ts:146`) resolve exactly as before. If they
   are moved under `src/plugins/`, replace the hop-counted `DATA_DIR`s with `host.dataDir` in the
   same commit and add a test asserting the resolved paths are `<repo>/data/links.json` and
   `<repo>/data/characters` — the volume is `/app/data` (`Dockerfile:18`, `docker-compose.yml:28`)
   and a wrong hop count would land the files outside it, i.e. lose them on the next recreate.
4. **Commands**: the plugin exports its two `SlashCommandBuilder`s (built through the host's
   `cmd()`) and a `handle(bareName, interaction)`; the host concatenates and dispatches. Add a
   snapshot test that the registered JSON body equals the pre-migration `commandData` for `link`
   and `unlink` (the `MAX_ACCOUNT_LABEL_LENGTH` max-length included) — this is the mutation test
   for "same names + options".
5. **Lifecycle**: keep the enable check as `WARBANDEER_INGEST_PORT` presence, keep
   `warbandeerServerRunning()` as the plugin's running flag, keep both `/link` messages verbatim
   (`link-command.ts:29,35`); optionally start honouring the discarded `stop` handle on
   `beginHandoff()` — a behaviour change, so a separate PR.
6. **Docs**: `CONTEXT.md` rows for the registry and the plugin's `index.ts`; a one-paragraph
   "Plugins" section in `CONTEXT.md`'s Behavior; README unchanged except its Files table.
7. **Acceptance to execute, not read**: `bun run check`; `bun test`; boot once with and once
   without `WARBANDEER_INGEST_PORT` and diff the startup log lines and the `/link` replies against
   a pre-migration run; `docker compose config` unchanged.

### 6c. What the WoW extraction additionally needs from the contract

The connector exercises only commands + HTTP + private storage. `src/wow/*` touches every other
surface in §2, so its extraction is where the contract earns its generality:

- **Tick checks as a plugin contribution.** `TickCheck { name, run }` (`announce.ts:52-55`) is
  already the right unit; the host keeps `restartPending`, `guardedTick`, `withCritical` and
  `runTick` (`:150-175`) and concatenates plugin-supplied checks. The per-check poll gaps
  (`lastRealmPollAt` etc., `:27-29`) move into the plugin.
- **Announcement kinds → channel routing.** `AnnounceKind` is a closed union (`:37`) and
  `channelFor` a two-way switch (`:40-42`). Either the plugin declares its kinds with a default
  channel key, or the host exposes `announce(channelId, message)` and the plugin owns the routing;
  `RELEASE_ANNOUNCE_CHANNEL_ID`'s fallback-to-`ANNOUNCE_CHANNEL_ID` behaviour (`config.ts:113`)
  must survive either way.
- **State dedup keys are shipped identifiers with an ops consumer.** `dmfAnnouncedFor`,
  `weeklyAnnouncedFor`, `realmStatus` live in `data/state.json` (`state.ts:26-28`), and
  `.realmStatus` is read by `ops/bot-ops.sh:272-273` and shown by the panel
  (`index.html:474-479`). Moving them into a namespaced sub-object or a plugin-owned file (the
  ADR-0003 precedent, via `storage.ts`) is a **data migration** — per the standing rule it has to be
  additive (read both locations, write the new), and the `.realmStatus` path either stays where it
  is or `bot-ops.sh` + the panel change in the same PR. Also `state.ts:4`'s `RealmStatus` type
  import has to be cut (`realmStatus?: string`, or the field moves).
- **Commands**: `/dmf` `/reset` `/status` `/transmog` (`commands.ts:56-60,70-77,99-135,169-195`) — same
  mechanism as the connector, four cases instead of two.
- **Config**: `WOW_REGION`, `WOW_REALM`, `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`,
  `DMF_TIMEZONE` (`config.ts:67-69,92-98,116-118,122`; note `dmfTimezone`'s default depends on
  `region`) plus the bash rows `bot-ops.sh:109-110,119` and the admin panel's WoW-specific realm
  chooser (`index.html:682,858-860`) — the panel has feature-specific UI, which the extraction has to
  either leave in place or make plugin-driven.
- **Shared clients**: `src/wow/blizzard.ts`'s cached client-credentials token is WoW-only and moves
  with the plugin; `src/github.ts` (releases, `/report`) is core and stays.

## Recommendation

**Direction (with the evidence):**

1. **In-repo plugins with a static, lazy registry** (§1a) — `tsc` keeps checking plugin shape
   (`tsconfig.json:14`, the repo's only static gate, `CONTEXT.md:429`), the image needs no change
   (`Dockerfile:7`), and "which plugins exist" stays a reviewable list. Lazy entries fix the
   real defect found here — a disabled connector still reads `data/links.json` at boot
   (`links.ts:215`). Filesystem discovery (`Bun.Glob` + `import()`) buys drop-in convenience the repo
   doesn't need at 2-3 plugins and costs runtime shape validation (the discord.js guide's own
   `[WARNING]` check). Workspaces (§1b) touch `Dockerfile`, `tsconfig.json` and the install layer for
   a bot with one runtime dependency — defer until a plugin genuinely needs its own dependencies.
   External git deps (§1c) are ruled out for now by Bun's no-sub-directory limit, the
   credential-less build (`README.md:82`), and discord-ai's license (§5).
2. **A host API object handed to `activate(host)`** (the Probot/Fastify/Vite shape, §1d), matching
   the repo's own `WarbandeerDeps`/`createProductionDeps` DI convention (§4), so plugins unit-test
   against a fake host and stop importing the `config` singleton.
3. **Static manifests for anything needed before login** — intents (frozen at `new Client()`,
   `Client.js:544`), env keys, command names — and `activate()` only for what must attach after
   `takeOver()` (`index.ts:17-26`), preserving the standby invariant.
4. **In-process**, with a per-plugin try/catch and running flag (§4) — the existing
   `index.ts:84-91` posture generalised; workers add a serialisation protocol and break the
   single-process assumptions of `storage.ts:10-16` for no benefit at this scale.
5. **Enable = per-plugin env presence for the connector (unchanged), plus room for an explicit list
   later** (§3); command removal already works through the bulk `rest.put` overwrite
   (`CONTEXT.md:380-382`, Discord docs).
6. **Whitelist sync via a drift test first** (§3 option 1, mirroring `server.test.ts:1523-1536`),
   upgrading to a generator (option 3) only if a third plugin makes hand-mirroring tedious; avoid
   the shipped-manifest option (2) because of the `bin/` delivery path.
7. **Carve the connector out first with the seven steps in §6b**, keeping `src/warbandeer/` in
   place for the first PR so no `import.meta.dir` path moves; extract WoW second, because it is
   the change that needs announcement kinds, tick checks and a state migration (§6c).

**Open decisions for the design phase** (deliberately not settled here):

1. Registry shape: one `Plugin` object per feature, or Sapphire-style separate stores per piece
   kind (commands / ticks / listeners) grouped under a plugin folder?
2. Whether disabled plugins are *imported* (cheap, but their top-level code runs) or *not imported*
   (lazy `import()` in the registry — the `links.ts:215` finding argues for this).
3. `hostApiVersion` as an integer vs a semver range, and whether a mismatch refuses boot or just
   disables that plugin with a log line.
4. Whether the enable switch stays purely env-presence, or a `PLUGINS=`/`DISABLED_PLUGINS=` key is
   added now (it costs a `resolveConfig` rule, an `ALLOWED` row, and panel/README lines).
5. Announcement routing: plugin-declared kinds mapped to channel keys, or a channel-id `announce`
   with routing inside the plugin?
6. Where WoW dedup keys go — stay in `state.json` at their current paths (keeping `bot-ops.sh:272-273`
   and the panel untouched) or move under a namespace/file with an additive migration.
7. Whether the host owns the one `Bun.serve` and mounts plugin routes (Bun `routes`, v1.2.3+;
   the pinned Bun is 1.3.14) behind the single tunnel hostname, or each HTTP-needing plugin binds its
   own port with its own env key (today's shape; a second plugin would need a second public
   hostname, `README.md:171-172`).
8. Whether a shutdown/dispose hook is added at the same time (nothing calls the connector's `stop`
   today, `index.ts:83`) or left as a separate behaviour change.
9. Whether `src/warbandeer/storage.ts` is promoted to a host module (it is shared infrastructure;
   `CONTEXT.md:97`) as part of the first carve-out or after.
10. Whether to keep registering commands on every boot (`index.ts:36-41`) once the command set
    becomes plugin-dependent, or to register only when the computed body differs from the last
    registered one (the discord.js guide's "not on every `ready`" advice vs. this bot's existing
    accepted quota cost).
