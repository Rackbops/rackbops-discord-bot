<!-- Plan for #529 bundle A1 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #529): the admin panel's SERVER side --
#404, #514 items 3-6 (item 2 is #532 T1's CI guard, closed by reference there), #465 (items 7-11) and #466 (items
12-14). Written by the orchestrating session on 2026-10-16 against main `903fc69` (`ops/admin/` is unchanged at
`ea4fdda`); every `file:line` below was read at that sha. Audited read-only before it was committed (a Sonnet agent,
139 tool calls, with Step 1 and drafts of every test applied to a scratch copy, the mutants run, Bun's `serve` error
page measured, and the live Plugin Index and both admin bundles fetched); every finding was applied: the package-prefix
gate turned two existing tests red (their `entry()` helper had no `package`); the lifted-block cross-check could not
see most lifts (they are regex literals and `applyBlock("NAME")` calls), so the test keeps a hand list of all 27 names
and asserts set equality; the bot REJECTS a duplicate name at parse (`src/plugins/index.ts:105-115`), it is not
last-wins, so the panel's parse does the same and `entryFor` is for objects that never went through it; the route's
"Always 200" also needs status entries filtered; the A3 trigger, the 502 cite, the `server.ts:743` cite's real home
(`CONTEXT.md:1379`, `mergePluginsView`'s `envKeys`), the README wording, the header's route list, two ADR-0005
sentences, the A8 verifier spy, the A9 line format and a `package: ""` guard case were all corrected. The implementer
re-reads each anchor on the tree it works from. A2 (#464) and A3 (the page: #405, #406, #467, #468, #469) follow on the
same files. Nothing in flight touches `ops/admin/`. -->

## Implementation plan -- #529 A1: a malformed index never 500s the Plugins tab, duplicates are refused as the bot refuses them, a fetch that stops at the allowlisted host, headers and tests that say what they pin, and a header and three docs brought current

Children: **#404** (closes), **#514** items 3, 4, 5 and 6 (item 2 lands with #532 T1: the issue closes when both are
in; this PR says "Part of #514 (items 3-6)"), **#465** (closes: items 7-11), **#466** (closes: items 12-14). One PR,
branch `fix/529-A1-admin-server`, worktree `S:\Repos\_wt\rdb-529-A1` cut from `origin/main` at or after `903fc69`.
Behaviour changes (an index guard, a redirect policy, a URL gate, an error handler, response headers) -> the
**three-reviewer gate** applies; every changed production line mutation-tested in a scratch worktree (never the shared
tree). `ops/admin` has its own package: `bun install --frozen-lockfile` there; its typecheck is `bun run check` in
`ops/admin`; its tests run from the repo root (`bun test ops/admin/server.test.ts`). Before CI, the admin tests plus the
three typechecks are enough locally (a root `bun test` on this box spends about 400 s per `ops/bot-ops` file).

### What is wrong, verified at `903fc69`

- **#404.** `parsePluginIndex` (`ops/admin/server.ts:894-912`) checks `schemaVersion`, that `plugins` is an array,
  and a string `name`/`version` per entry; `mergePluginsView` (`:945-1022`) then calls `.filter` on `entry?.env ?? []`
  (`:994`, `:1001`) and `entry?.commands ?? []` (`:1014`) and `releasesNewerThan` calls `.findIndex` on
  `entry?.releases ?? []` (`:929`, `:984`). Measured on pristine code: `env: {}` and `commands: "x"` always throw;
  `releases: "x"` throws only when the plugin has an `installedVersion` (without one the string is emitted as
  `releases`); `releases: [null]` throws at `r.version`; `status.plugins: [null]` throws at `s.name`. Such an index
  passes the parse, is cached for five minutes (`createPluginIndexLister`, `:1467-1485`), and the `/api/plugins` route
  (`:1989-2007`) has no try/catch, `handleRequest` (`:1905-`) none, and `Bun.serve` (`:2295`) sets no `error` handler
  and no `development: false` -- measured under Bun 1.4.2 with `NODE_ENV` unset: a throw answers HTTP 500 `text/html`
  with Bun's roughly 50 KB development error page (the message, local paths, source lines); with `development: false`
  the plain `Something went wrong!`; with `error()` the handler's response. Neither `ops/admin/Dockerfile` nor
  `docker-compose.yml` sets `NODE_ENV` (the base image's own ENV is unverified). The route's comment says "Always
  200" (`:1986`). Tests cover malformed ELEMENTS (`server.test.ts:2961`, `:3011`), not containers.
- **#514 item 6.** `mergePluginsView` keys entries by name in a `Map` (`:952`: the LAST duplicate wins);
  `resolveAdminBundleUrl` (`:1079`) and `resolvePluginProxyUrl` (`:1131`) use `index?.plugins.find(...)` (the FIRST
  wins). The bot does NEITHER: `pluginIndexProblem` (`src/plugins/index.ts:105-115`) rejects the whole index on a
  duplicate name, so its registry's Map never sees one (the issue's "the bot is last-wins" is wrong). An index listing
  a plugin twice shows the second entry's version, env and `adminUrl` on the card and serves the first entry's bundle;
  the test at `:2886-2896` builds its index object directly and pins only that one row appears. The live index
  (`Rackbops/rackbops-bot-plugins`'s `plugins.json`, read in audit) has five plugins and no duplicate.
- **#514 item 3.** `server.test.ts:5925-5928`'s comment says the rb-theme test "fails when the pin moves without a
  rebuild (or the file is hand-edited)"; the test (`:5936-5939`) compares only line 1 with `composeThemeCss`'s
  banner. A hand edit below line 1 passes. The test name is accurate.
- **#514 item 4.** `server.test.ts:6534-6558` ("every lifted block is still present") hand-lists 24 names and asserts
  `names.length === 24` (`:6549`, a count of its own literal); the page carries 27 `// NAME:begin` markers
  (`grep -c ":begin$" ops/admin/public/index.html` = 27): `CONTROL_SNAPSHOT` (`index.html:613`), `DESCRIBED_BY` and
  `APPLY_INVALID_CARRY` are lifted by tests but not listed, so a rename of one of them shows up only as a
  `ReferenceError` in a harness. The lifts are written three ways -- a regex literal (`/\/\/ ENV_SAVE_PLAN:begin\n…/`,
  `:2172`), `applyBlock("CONTROL_SNAPSHOT")` (`:7909`, `:12352`) and `new RegExp(\`// ${name}:begin…\`)` (`:6714`) --
  so a scan of this file for `// NAME:begin` finds only four of them.
- **#514 item 5.** Stale cites: `server.test.ts:2174` "(index.html:226)" for the page's strict IIFE (it is near
  `:173-174` now); `:7593` "server.ts ~1683" for the 502 mapping (it is `handleRequest`'s generic route, `status: 502`
  at `:2116` and `:2118`; `buildInvocation`, `:543-577`, has no 502); `ci.yml:39-40`'s counts are #532 T1's;
  `src/restart.test.ts:204` no longer carries `announce.ts:225` (Grep finds none: already fixed, say so).
- **#465 item 7.** `makeAdminAssetFetcher` (`:1228-1250`) calls `fetchImpl(url, { headers, signal })` with no
  `redirect` option, so a 3xx from the allowlisted host would be followed to any origin and served same-origin
  (`ADR-0005:156-157` says the allowlist means a bundle can never make the panel reach an arbitrary origin). Both live
  admin bundles answer 200 with no redirect today. **Item 8.** The unpinned branch of `resolveAdminBundleUrl`
  (`:1110-1114`) checks only `https:` and the host (`:1090`) and returns `entry.adminUrl`, while the pinned branch
  (`:1093-1108`) enforces `https://cdn.jsdelivr.net/npm/<package>@<version>/`;
  `https://cdn.jsdelivr.net/gh/x/y@main/a.js` is accepted unpinned, contradicting the "plugin's own published npm
  package" comment (`:1026-1028`). Both live `adminUrl`s sit under `…/npm/@rackbops/plugin-<name>@<version>/dist/admin.js`.
  **Item 9.** No `error` handler and no `development: false` on `Bun.serve` (`:2295`); a `runBotOps` that rejects (a
  spawn failure) on `/api/plugins` or the generic route rejects out of `handleRequest` (see #404 for what the client
  then gets). **Item 10.** The "403 before auth" tests (`server.test.ts:2136`, `:3851`) send valid bearer
  credentials, so swapping the order of `isCrossSiteWrite` and `authorizeRequest` keeps them green; only an
  UNauthenticated cross-site POST tells 403 from 401, and `extractAccessJwt` (`:43-45`) reads only the
  `Cf-Access-Jwt-Assertion` header, so a request without that header never reaches `verifyAccessJwt` in either order
  -- the real ambient-session attack carries the header. **Item 11.** `logDynamicAdminsStartup`'s tests
  (`server.test.ts:455-485`) assert `toContain("0")`/`toContain("2")` on a line (`[admin] ${n} dynamic admin(s) loaded from ${adminsFile}`,
  `server.ts:350`) that also contains a random temp path.
- **#466 item 12.** `server.ts:1-2` says "a thin wrapper around ops/bot-ops.sh's five subcommands
  (status/logs/restart/env-get/env-set)"; `buildInvocation` (`:543-577`) maps status, logs, restart, recreate,
  env-get, env-set, env-schema and routing-get, `version` is a startup check (`:2214`), and the panel has server-native
  routes of its own. `:1253` cites "contract.ts:132" for `PluginRequest` (it is `src/plugins/contract.ts:248` now);
  `:967` cites "requests.ts:154" for the compat check (`src/plugins/requests.ts:481-487` now); `CONTEXT.md:1379`
  (a Gotchas bullet, not the `ops/admin/` row) cites `server.ts:743` for reading the manifest's `env` keys (it is
  `mergePluginsView`'s `envKeys`, `:994`). **Item 13.** `ops/README.md:1347` "structurally incapable of touching an
  instance other than its own": every instance shares one `/opt/rackbops-discord-bot/bin/bot-ops.sh`
  (`docker-compose.yml:127`), the admin mounts the Docker socket, and what scopes it is the four `BOT_OPS_*` values its
  container is started with (`docker-compose.yml:113-116`) plus the script's own checks of them; `:1389` "the
  `ADMIN_TOKEN` bearer token remains available to fix" a broken `admins.json` (every admin-list write reads the file
  first, `server.ts:156` area, so a broken file makes POST/DELETE 502: only host access repairs it). **Item 14.** No
  `X-Frame-Options`/`X-Content-Type-Options` on the page, the assets or the proxied responses (`:1911`, `:1922`,
  `:1184`, `:1209`); jsDelivr sends `nosniff` on the bundles itself, the panel does not.

### Decisions (defaults, named so the gate can contest them)

1. **Three nets for #404, outermost last:** `parsePluginIndex` rejects an entry whose `env`, `commands` or `releases`
   is present and not an array -- `null` included, a behaviour change: `env: null` merged fine before and is now a
   rejected index, as the bot rejects it (the whole index is then `null` -> `indexError`, the panel's existing degraded
   view); `mergePluginsView` reads those three through `Array.isArray(...) ? ... : []` anyway (an object that never
   went through the parse: the lister cache is in-process, so this is reachable only from direct calls, and it is the
   cheap net); the route filters the status entries to objects with a string `name` and wraps the merge in a
   try/catch that answers 200 with the `null`-index view and a distinct `indexError` ("the Plugin Index could not be
   merged"), logged. `releasesNewerThan` is NOT hardened field by field: the route net is the catch-all, and A3 drives
   it with `releases: [null]`, which the first two nets let through on purpose. The fallback merge (a `null` index,
   the filtered status entries) cannot throw: every status field is passed through, never iterated (fuzzed in audit:
   576 field/value combinations, 0 throws); `serve`'s net (Decision 5) is the backstop behind it all the same. The
   route's "Always 200" becomes true for every malformed index and for a malformed status entry.
2. **Duplicates: the panel refuses the index at parse, as the bot does** (`pluginIndexProblem`'s `seenNames`,
   `src/plugins/index.ts:108-115`): a `seenNames` check in `parsePluginIndex`, so a duplicate becomes `indexError`
   rather than two different entries on two routes. For an index object that never went through the parse (the
   `:2886` test's), `entryFor(index, name)` (`findLast`) makes the card, the bundle and the proxy agree on the LAST
   entry; it is not "the bot's rule", and no text says it is.
3. **The asset fetch does not follow redirects** (`redirect: "error"`): a 3xx from the CDN is a fetch error -> 502.
   Verified against a real local `Bun.serve` answering 302 (A5), so nothing here is "not verifiable".
4. **The unpinned bundle URL must sit under the plugin's own package on the CDN**: `https://cdn.jsdelivr.net/npm/<entry.package>@`
   as a prefix (version-agnostic, since the manifest's `adminUrl` names its own version), plus the existing `https:`
   and host checks; a manifest without a non-empty string `package` resolves null (an empty `package` would make the
   prefix `…/npm/@`, which every scoped URL matches; an absent one `…/npm/undefined@`). The live index's two
   `adminUrl`s satisfy this (read in audit; re-check and paste in the PR).
5. **One request wrapper owns the error net and the headers:** `serve(req, config)` = `handleRequest` in a try/catch
   (a rejection -> `console.error` + a plain-text 500 "internal error", never a stack) with `X-Frame-Options: SAMEORIGIN`
   and `X-Content-Type-Options: nosniff` set on every response; `Bun.serve` gets `fetch: (req) => serve(req, config)`,
   `development: false` and an `error` handler of the same shape with the same headers (the last resort). `SAMEORIGIN`,
   not `DENY`: nothing frames the panel today (no iframe in the repo), it blocks cross-site framing equally, and
   ADR-0005's decision 4 keeps a same-origin iframe + `postMessage` shape open for plugin UIs; the PR names it as a
   behaviour change for anyone embedding the panel in a dashboard. The bundle route keeps forcing `text/javascript`;
   the proxy route's forwarded `Content-Type` plus `nosniff` is what the bridge's `proxyFetch` expects (it reads bytes,
   `index.html:792-798`, never a script tag). No `Response` in Bun is immutable (measured: not `Response.error()`,
   `Response.redirect()` or a `fetch()` result), so `headers.set` is safe everywhere.
6. **Tests say what they pin:** the rb-theme comment becomes banner-only (the test name is right; a body hash is
   declined as a build-pipeline change for a test comment); the lifted-block test keeps ONE hand list of every marker
   name and asserts set equality with the page's markers (no count literal, so a rename fails by name here and an
   added marker must be listed); the "before auth" tests send NO credentials, and a variant carries an Access header
   with a verifier that would authorize; the startup-log tests assert exact lines.
7. **Docs:** the header names the real surface; cites go by symbol; the two README sentences say what is true
   (scoped by the four `BOT_OPS_*` values and the script's checks of them, not structurally; a broken `admins.json`
   needs host access). `CONTEXT.md`'s `ops/admin/` row and the Gotchas cite follow; ADR-0005 gets two one-clause
   edits.

### Step 1 -- `ops/admin/server.ts`

1a. `parsePluginIndex` (`:904-910`): the `every` gains, per entry `e`,
`(e.env === undefined || Array.isArray(e.env)) && (e.commands === undefined || Array.isArray(e.commands)) && (e.releases === undefined || Array.isArray(e.releases))`
(typed through the same `as { ... }` casts), with the comment "#404: the three containers the merge iterates; a
non-array one (`null` included) used to throw inside `mergePluginsView` and 500 the tab for the cache's lifetime"; and
a duplicate-name check (#514 item 6): collect `name`s in a `Set` while validating and return `null` on a repeat, with
the comment "as the bot refuses it (`src/plugins/index.ts`'s `pluginIndexProblem`): two entries under one name would
otherwise feed different routes".

1b. A helper above `mergePluginsView`:
```ts
/** The index entry for `name`: the LAST one when an index object built outside `parsePluginIndex` lists it twice
 *  (#514 item 6; the parse itself refuses a duplicate, as the bot does), so the card, the bundle and the proxied
 *  assets all come from the same entry. */
function entryFor(index: PluginIndex | null, name: string): PluginIndex["plugins"][number] | undefined {
  return index?.plugins.findLast((e) => e.name === name);
}
```
(`findLast` is available: `lib: ["ESNext"]`, Bun 1.4.2.) `mergePluginsView`: `const entryByName = new Map(...)` stays
(a Map keyed by name is last-wins already), and the merge reads `entry?.env`, `entry?.commands`, `entry?.releases`
through `const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])` at `:984`, `:994`, `:1001`,
`:1014` (#404's second net). `resolveAdminBundleUrl` (`:1079`) and `resolvePluginProxyUrl` (`:1131`):
`const entry = entryFor(index, name);`.

1c. `resolveAdminBundleUrl`'s unpinned tail (`:1110-1114`): before the `adminApiVersion` gate,
```ts
  // #465 item 8: the unpinned branch is now held to the same source as the pinned one — this plugin's own published
  // package on the CDN — not merely the host (a `/gh/...` or another package's URL on cdn.jsdelivr.net was accepted).
  // A missing or empty `package` resolves nothing: an empty one would make the prefix `/npm/@`, which every scoped URL matches.
  if (typeof entry.package !== "string" || entry.package === "") return null;
  if (!manifestUrl.href.startsWith(`https://${ADMIN_ASSET_HOST}/npm/${entry.package}@`)) return null;
```
and the docstring and the `ADMIN_ASSET_HOST` comment (`:1026-1028`) say "the plugin's own package on this CDN, both
branches". **`server.test.ts:3061-3064`'s `entry()` helper gets `package: "@rackbops/plugin-warbandeer"` in its
default entry** -- without it the two existing tests at `:3067` and `:3081` go red (measured: 907 pass / 2 fail; with
it 909 pass).

1d. `makeAdminAssetFetcher` (`:1228-1250`): the `fetchImpl` type's `init` gains `redirect: "error"` and the call passes
`redirect: "error"` (#465 item 7), with the comment "a 3xx from the allowlisted host would otherwise be followed
anywhere and served same-origin; `fetch` rejects on it with `redirect: "error"`, which the catch turns into a 502".
(Existing fakes `async () => …` and `makeAdminAssetFetcher(fetch)` both still typecheck.)

1e. The `/api/plugins` route (`:1994-1999`):
```ts
    const rawPlugins = safeJsonField(statusRes.stdout, "plugins");
    // #404: a status entry that is not an object with a name cannot be merged (or shown); drop it rather than throw.
    const statusPlugins = Array.isArray(rawPlugins)
      ? rawPlugins.filter((s): s is PluginStatusEntry => !!s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string")
      : [];
    ...
    const index = config.listPluginIndex ? await config.listPluginIndex() : null;
    let view: PluginsView;
    try {
      view = mergePluginsView(index, statusPlugins, pluginsValue);
    } catch (err) {
      // #404: the merge reads untrusted manifest JSON; a shape the parse let through must degrade like an unreachable
      // index, not 500 the tab for the cache's lifetime. (The fallback below reads no index and iterates no status
      // field, so it cannot throw; serve()'s net is the backstop behind it.)
      console.error("[admin] couldn't merge the Plugin Index (Modify Plugins shows installed only)", err);
      view = { ...mergePluginsView(null, statusPlugins, pluginsValue), indexError: "the Plugin Index could not be merged" };
    }
```

1f. Below `handleRequest` (or above `import.meta.main`):
```ts
/** The two response headers every answer carries (#466 item 14): the panel is framed only by its own origin (nothing
 *  does today; ADR-0005 keeps a same-origin iframe open for plugin UIs), and nothing it serves — the page, the assets,
 *  a proxied data asset with its upstream Content-Type — is sniffed into another type. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = { "X-Frame-Options": "SAMEORIGIN", "X-Content-Type-Options": "nosniff" };

/** What `Bun.serve` runs (#465 item 9): `handleRequest` behind an error net (a rejection — a spawn failure, a throw a
 *  route did not expect — is logged and answered with a plain 500, never Bun's development error page) and with the
 *  security headers on every response. Exported so both are pinned by tests; `handleRequest` itself stays the DI'd core. */
export async function serve(req: Request, config: HandlerConfig): Promise<Response> {
  let res: Response;
  try {
    res = await handleRequest(req, config);
  } catch (err) {
    console.error(`[admin] ${req.method} ${safePathname(req.url)} failed`, err);
    res = new Response("internal error", { status: 500 });
  }
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}
```
with `safePathname(url)` = `new URL(url).pathname` in a try/catch returning `"?"` (the catch must not throw itself).
`Bun.serve` (`:2295`) becomes
`Bun.serve({ port: PORT, fetch: (req) => serve(req, config), idleTimeout: IDLE_TIMEOUT_SECONDS, development: false, error(err) { console.error("[admin] unhandled", err); return new Response("internal error", { status: 500, headers: SECURITY_HEADERS }); } })`.

1g. The header (`:1-6`): "A small per-instance admin panel: an authenticated, thin wrapper around `ops/bot-ops.sh`
(status, logs, restart, recreate, env-get, env-set, env-schema, routing-get and the plugin request mailbox;
`version` once at startup) plus server-native routes of its own (`/api/whoami`, `/api/branches`, `/api/plugins`,
`/api/plugins/request`, `/api/admins`, the routing writes, the admin-bundle and data-asset delivery, and the static
assets). ..." (keep the rest). `:967` "requests.ts:154" -> "`validate`'s compat check in `src/plugins/requests.ts`";
`:1253` "contract.ts:132" -> "`PluginRequest` in `src/plugins/contract.ts`".

### Step 2 -- docs

- `ops/README.md:1347`: old `structurally incapable of touching an instance other than its own (it only ever` -> new
  `scoped to its own instance by the four \`BOT_OPS_*\` values its container is started with (not structurally: the container mounts the Docker socket and the host-shared \`bin/\`, so it is those values and \`bot-ops.sh\`'s checks of them that keep it to one instance; it only ever` (read the rest of the sentence and keep it grammatical).
- `ops/README.md:1389-1390`: the end of `:1389` `— the \`ADMIN_TOKEN\` bearer token remains available to fix` and the
  start of `:1390` `the file. You can't lock everyone out:` become `— a broken \`admins.json\` is repaired from the host (\`/api/admins\` reads the file first on GET, POST and DELETE, so it answers 502 until it is), while the \`ADMIN_TOKEN\` bearer token still reaches every other route. You can't lock everyone out:` (two lines, rewrapped).
- `CONTEXT.md:1379` (the Gotchas bullet "read the manifest's `env` keys (`host.ts:57`, `bot-ops.sh load_plugin_keys`,
  `server.ts:743`)"): `` `server.ts:743` `` (with its backticks) -> `` `mergePluginsView`'s `envKeys` in `ops/admin/server.ts` ``;
  in the same edit `` `host.ts:57` `` (now `PluginCommandTarget`'s doc comment, also stale) -> the symbol that reads
  the manifest's `env` keys in `src/plugins/host.ts` (Grep `missingEnv` or `env` there and name the function).
- `CONTEXT.md:204` (the `ops/admin/` row): the span `` `TIMEOUT_SIGNAL`, `PLUGIN_ADMIN_HELPERS`, … `TOAST` (24 total; `PLUGIN_BADGES` is gone, replaced by `PLUGIN_CARD_STATE`) `` (it follows "(a test pins each is present exactly once):") becomes the whole clause "27 of them today, every name listed once in `server.test.ts`'s lifted-block test, which fails on a rename or an unlisted addition (`PLUGIN_BADGES` is gone, replaced by `PLUGIN_CARD_STATE`)" -- read the sentence it sits in and keep it grammatical; and append, BEFORE the row's trailing ` |`: `` ; **#404/#465/#466/#514:** a malformed index container or a duplicate name degrades to `indexError` (parse, merge and route nets; a nameless status entry is dropped), `entryFor` makes an unparsed duplicate last-wins (reachable from direct calls only: a parsed index has none), the asset fetch does not follow redirects and an unpinned `adminUrl` must sit under the plugin's own package, `serve()` wraps `handleRequest` with a 500 net and `SECURITY_HEADERS`, `Bun.serve` runs with `development: false` ``.
- `docs/adr/0005-plugins-ship-their-own-admin-ui.md:94-95`: `(\`handleRequest\` sets only \`Content-Type\` on the page, and the page carries no \`http-equiv\` policy)` -> `(\`handleRequest\` sets \`Content-Type\` on the page and \`serve\` adds \`X-Frame-Options\` and \`X-Content-Type-Options\` to every response, #466 — neither is a CSP — and the page carries no \`http-equiv\` policy)`;
  `:156-157` (the old text wraps across the two lines: "reach an" / "arbitrary origin."): anchor on
  `so a bundle can never make the panel reach an` and make the sentence read `and never followed through a redirect (#465), so a bundle can never make the panel reach an arbitrary origin.` (rewrap as needed).
- `ops/README.md:1344` says the server-native routes are "a few read-only / self-contained" -- false (`POST /api/admins`,
  `/api/plugins/request` and the routing writes mutate): drop "read-only / self-contained" for "a few server-native
  routes of its own (some of which write)". It sits beside the `:1347` edit.

### Step 3 -- tests (`ops/admin/server.test.ts` unless noted; restore every `console.error`/`console.log` spy in a `finally`)

- **A1 (#404, parse):** in `describe("parsePluginIndex (#102)")` (`:2515`): `env: {}`, `commands: "x"`,
  `releases: "x"`, `env: null` each -> `null`; two entries named `warbandeer` -> `null`; an entry with none of the
  three present -> parses (today's minimal entry still works).
- **A2 (#404, merge):** in `describe("mergePluginsView (#102)")` (`:2840`): an index object built in the test (not
  parsed) with `env: {}`, `commands: "x"` and `releases: "x"` on an entry that has an `installedVersion` in status ->
  no throw; `envKeys` and `env` `[]`, `commands` `[]`, `releases` `[]`.
- **A3 (#404, route):** `/api/plugins` through `handleRequest` with a `listPluginIndex` returning an object whose
  entry has `releases: [null]` and a status `installedVersion` for it (throws at `releasesNewerThan` today; passes the
  first two nets by design) -> `200`, `indexError` is `the Plugin Index could not be merged`, the status-only names
  present; `console.error` called once. A second case: status `plugins: [null, { name: "warbandeer", ... }]` with a
  good index -> `200`, one row, no `indexError`.
- **A4 (#514 item 6):** the dup-index test (`:2886`, a hand-built object) also asserts the row's `latestVersion` is
  `9.9.9`; and with `adminUrl`/`package` on both entries, `resolveAdminBundleUrl(dupIndex, "warbandeer")` returns the
  SECOND entry's URL and `resolvePluginProxyUrl(dupIndex, "warbandeer", "x.json")` the second entry's package prefix.
  (The parse-level duplicate case is A1's.)
- **A5 (#465 item 7):** `makeAdminAssetFetcher`'s tests: the recorded `init.redirect === "error"`; and a REAL
  `Bun.serve` on port 0 driven through `makeAdminAssetFetcher(fetch)`, in this shape (a weaker one survives M5: a
  followed redirect to a closed port also ends in a 502 from the catch, and one to a 404 ends in `status: 404`):

  ```ts
  const hits: string[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      hits.push(p);
      return p === "/redir" ? new Response(null, { status: 302, headers: { Location: "/ok" } }) : new Response("ok");
    },
  });
  try {
    const r = await makeAdminAssetFetcher(fetch)(`http://127.0.0.1:${srv.port}/redir`);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(hits).toEqual(["/redir"]); // the redirect's target was never requested
  } finally {
    srv.stop(true);
  }
  ```

  (A relative `Location`: referencing `srv.port` inside its own initializer is TS7022. `127.0.0.1`, the repo's
  precedent at `src/plugins/delivery.test.ts:211-214`.) The fake `TypeError("redirect")` case is not needed (it
  passes today and pins nothing).
- **A6 (#465 item 8):** `resolveAdminBundleUrl` unpinned (the helper now defaults `package`): `adminUrl: "https://cdn.jsdelivr.net/gh/x/y@main/a.js"`
  -> null; another package's `npm/@rackbops/plugin-other@1.0.0/dist/admin.js` -> null; the own package's -> returned;
  `package: undefined` (explicit) with `npm/undefined@1.0.0/dist/admin.js` -> null; `package: ""` with
  `npm/@rackbops/plugin-other@1.0.0/dist/admin.js` -> null (the two guard cases: without them dropping the
  `typeof`/empty check survives).
- **A7 (#465 item 9):** `serve(req, cfg)` with a `runBotOps` that rejects on `/api/plugins` -> `500`, body
  `internal error`, no stack text, `console.error` called; a normal request through `serve` -> the same body as
  `handleRequest` plus both headers. A source pin that the `import.meta.main` block's `Bun.serve({` literal contains
  `development: false`, `error(`, `headers: SECURITY_HEADERS` (the last-resort handler's response carries them too)
  and `fetch: (req) => serve(req, config)` (the block does not run under test).
- **A8 (#465 item 10):** beside `:2136` and `:3851`: a cross-site POST (foreign `Origin`) with NO `Authorization`, no
  cookie and no `Cf-Access-Jwt-Assertion` -> `403` (not `401`); `adminStore.readDynamic` and `runBotOps` not called.
  And the live variant: the same cross-site POST WITH a `Cf-Access-Jwt-Assertion` header and a `verifyAccessJwt` stub
  that would authorize an admin -> `403`, the verifier NOT called (the gate runs before any identity is read).
- **A9 (#465 item 11):** `:455-485`: `toBe` on the whole line, `` `[admin] ${n} dynamic admin(s) loaded from ${adminsFile}` ``
  (`server.ts:350`), with the test's own path interpolated.
- **A10 (#466 item 14):** every route family through `serve`: `/`, `/admin.css`, `/plugin-admin/<a real index
  entry's name>.js` (with a fake fetcher; also assert `Content-Type` is still `text/javascript`),
  `/api/status`, `/api/plugin-proxy/<that name>?path=a.json`, a 404 -> each response has `X-Frame-Options: SAMEORIGIN`
  and `X-Content-Type-Options: nosniff`.
- **A11 (#514 item 4):** `:6534-6558` becomes: `const LIFTED = [ ...all 27 names... ] as const;` (no count literal),
  `const markers = [...indexSrc.matchAll(/^\s*\/\/ ([A-Z_][A-Z0-9_]*):begin$/gm)].map((m) => m[1])`;
  `expect([...markers].sort()).toEqual([...LIFTED].sort())`; for each name exactly one `:begin` and one `:end` line;
  the two deleted names still have zero `:begin`. (A scan of this file for the lifted names was tried and found 4 of
  27; the hand list is the guard, and set equality is what makes a rename AND an unlisted addition fail by name.)
- **A12 (#514 item 3):** the comment at `:5925-5928` becomes "Its first line names the version it came from; this
  fails when the pin moves without a rebuild (the banner alone: a hand edit below line 1 is not caught here)".
- **A13 (#514 item 5):** `:2174` -> "matching the page's own strict IIFE (the `"use strict"` at the top of its main
  script)"; `:7593` -> "(`handleRequest`'s generic-route failure mapping, `status: 502`)"; `src/restart.test.ts:204`:
  already symbol-cited (confirm; nothing to do).

### Mutation table (scratch worktree; `bun test ops/admin/server.test.ts` per mutant; typecheck with `cd ops/admin && bun run check`)

```bash
git -C /s/repos/rackbops-discord-bot worktree add --detach /s/Repos/_wt/rdb-529-A1-mut fix/529-A1-admin-server
cd /s/Repos/_wt/rdb-529-A1-mut && bun install --frozen-lockfile && (cd ops/admin && bun install --frozen-lockfile)
```

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | 1a: drop the three container checks | A1 |
| M1b | 1a: drop the duplicate-name check | A1's duplicate case |
| M2 | 1b: `list(...)` -> `(... ?? [])` for `env` | A2 (throws) |
| M3 | 1e: the try/catch removed | A3's first case (500) |
| M3b | 1e: the status filter removed | A3's second case (500) |
| M4 | 1b: `findLast` -> `find` in `entryFor` | A4 (the first entry's URL) |
| M5 | 1d: `redirect: "error"` dropped | A5 (the recorded init; the real 302 is followed to a 404 or served) |
| M6 | 1c: the package-prefix check dropped | A6 (`/gh/` accepted) |
| M6b | 1c: the `typeof`/empty guard dropped | A6's `""` and `undefined` cases |
| M7 | 1f: `serve` rethrows | A7 (rejects) |
| M8 | 1f: one header dropped | A10 |
| M9 | CSRF gate moved below `authorizeRequest` | A8 (401 instead of 403; the verifier called in the live variant) |
| M10 | A11: rename `CONTROL_SNAPSHOT`, then `DESCRIBED_BY`, then `APPLY_INVALID_CARRY`, then `TOAST`, then `APPLY` in the scratch `index.html` (five runs) | A11 (set inequality, by name) |
| M11 | 1f: `development: false` dropped from the `Bun.serve` literal | A7's source pin |
| M11b | 1f: `headers: SECURITY_HEADERS` dropped from the `error()` handler's response | A7's source pin |

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #404: a malformed container, a nameless status entry, never 500s `/api/plugins` (parse, merge, route) | 1a, 1b, 1e | A1, A2, A3 | M1, M2, M3, M3b |
| #514-6: a duplicate is refused at parse as the bot refuses it; an unparsed one is last-wins across card, bundle and proxy | 1a, 1b | A1, A4 | M1b, M4 |
| #514-3/-4/-5: the comments and the lifted-block test pin what they claim; cites by symbol | 3 | A11, A12, A13 | M10 |
| #465-7/-8: no redirect; the unpinned URL under the plugin's own, non-empty package | 1c, 1d | A5, A6 | M5, M6, M6b |
| #465-9: a rejecting route is a plain 500, never a stack page; the last resort carries the headers | 1f | A7 | M7, M11, M11b |
| #465-10/-11: the gate's order (with and without an Access header) and the startup lines are pinned | 3 | A8, A9 | M9 |
| #466-12/-13: the header, the cites, the two README sentences and the ADR clauses are true | 1g, 2 | lens-B audit | -- |
| #466-14: every response carries the two headers | 1f | A10 | M8 |

### Verification

```bash
bun install --frozen-lockfile
cd ops/admin && bun install --frozen-lockfile && bun run check && cd ../..
bunx tsc --noEmit -p ops/tsconfig.json
bun run check
bun test ops/admin/server.test.ts
bun test   # in the background; about ten minutes here, mostly ops/bot-ops
```

Named in the PR: the live index's `adminUrl` shape (re-read `plugins.json` before committing Decision 4; pasted);
`SAMEORIGIN` as a behaviour change for an embedding dashboard; `nosniff` does not cover a direct navigation to a
proxied `image/svg+xml` (what the headers do and do not cover goes in #466's closing comment); `entryFor`, the Map's
last-wins and A4 are reachable from direct calls only, since a parsed index now has no duplicate.

### Acceptance to paste per issue

- **#404:** A1-A3 pass lines; M1-M3b failing output; the route's new `indexError` text.
- **#514 (items 3-6):** A1's duplicate case, A4, A11-A13 pass lines; M1b, M4 and M10 (five names); note item 2 is
  T1's (#532).
- **#465:** A5-A9 pass lines; M5-M7, M9, M11; the live `adminUrl` check.
- **#466:** A10's pass line, M8; the three doc diffs and the two ADR clauses.

### PR

- Title: `fix(admin): degrade a malformed Plugin Index instead of 500ing, refuse duplicate names at parse, refuse redirects and off-package bundles, add a 500 net and security headers, and pin what the tests claim (#404, #465, #466, #514)`.
- Body: one line per item, Decisions 1-7, the typecheck + test output, the mutation table, the named notes above.
  End with `Closes #404. Closes #465. Closes #466.`; `Part of #514 (items 3-6)`.
- After merge: tick #404 #465 #466 on #529; comment on #514.

### Out of scope, on purpose

- #464 (A2) and the page's items (A3).
- A body hash in the rb-theme banner (Decision 6).
- A bearer-only recovery path for `admins.json` (the README now says host access).
- Hardening `releasesNewerThan` and the other per-field reads (Decision 1: the route net is the catch-all).
- A Content-Security-Policy (ADR-0005 decision 4 declines one on purpose; the two headers are not one).
