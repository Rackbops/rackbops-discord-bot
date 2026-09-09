# Plugins ship their own admin-panel tab

Epic #123 extends ADR-0004's Plugin Index to the admin panel. `ops/admin/` (README.md's "Admin
panel" section) already renders one generic view — a plugin's declared `env` keys as bare fields —
because that is all `HostApi.env`/the manifest's `env` array can express. A plugin that needs
something richer than a flat key list (warbandeer's ingest port plus a live connector-status
readout; the wow plugin's region-filtered realm chooser, hardcoded into the panel itself before
#107) had no way to ship that UI without the panel repo growing plugin-specific code — exactly the
coupling ADR-0004 rejected for the bot side.

Two more constraints, symmetric to ADR-0004's: the panel is a **separate container** from the bot
(`ops/admin/`, its own `Dockerfile`/`package.json`, no import of `src/`), so a plugin's admin code
cannot reuse `HostApi` or `src/plugins/contract.ts` directly — it needs its own delivery path and
its own contract. And `src/plugins/contract.ts` is pinned single-const and DOM-free
(`contract.test.ts`) so it can be read before the `Client` exists — an admin-UI contract cannot live
there without breaking that invariant.

**Decision:** a plugin may optionally ship a **browser entry** (`dist/admin.js`, exporting
`mountAdmin(root, api)` and `adminApiVersion`) alongside its bot bundle. The panel discovers it
through the same Plugin Index the bot reads, mounts it same-origin, and keeps every write behind the
panel's own guarded save path — the plugin owns presentation, the panel keeps authority.

1. **Delivery: manifest `adminUrl`, fetched server-side, served same-origin.** `generate-index`
   derives `adminUrl` (a jsDelivr-npm URL to `dist/admin.js`) from a plugin's declared
   `botPlugin.adminApiVersion` in `package.json` — never hand-authored (`rackbops-bot-plugins`
   README, "Admin tab (optional)"). The panel **server** fetches it — allowlisted to
   `ADMIN_ASSET_HOST` (`cdn.jsdelivr.net`) and https-only, size-capped at `ADMIN_ASSET_MAX_BYTES`
   (512 KiB) — and serves it same-origin at `GET /plugin-admin/<name>.js`, so the browser never
   makes a cross-origin request for plugin code and no CSP cross-origin grant is needed. A data
   asset a bundle needs (e.g. a realm list) is proxied the same way through
   `GET /api/plugin-proxy/<name>?path=`, scoped by `resolvePluginProxyUrl` to that plugin's own
   published package — never an arbitrary path or origin (`ops/admin/server.ts`).
2. **A separate, independent version: `ADMIN_API_VERSION`.** The admin-UI contract lives in its own
   module: `packages/api/admin.ts` in the plugins repo (`ADMIN_API_VERSION`, `AdminApi`,
   `SaveResult`, and — for a plugin's own admin bundle only — `MountAdmin`), with `ops/admin/`
   carrying its own copy, `admin-contract.ts` (`ADMIN_API_VERSION`/`AdminApi`/`SaveResult`; the
   panel never imports `MountAdmin`, which describes a plugin's bundle, not the panel). Neither
   lives inside `src/plugins/contract.ts`, which `contract.test.ts` pins to exactly
   `export const HOST_API_VERSION = 1;` with no other runtime export. Unlike that pin, the two
   admin-contract copies are **not** drift-tested against each other — a mismatch is safe-fail (the
   panel just refuses to mount, never a broken one), so `admin-contract.ts`'s own header says to
   bump it in lockstep by hand instead. A version mismatch between a bundle and the panel is a
   **skip**, not a hard failure: the tab renders a version-mismatch note instead of mounting,
   checked both on the manifest-declared value (a cheap server-side refusal, no fetch)
   and — since #165 — the bundle's own exported value, which is the authority once the tab is
   pinned to a version other than the manifest's current one.
3. **The admin tab follows the plugin's INSTALLED version, not the index's current one (#165).** A
   tab exists to configure the code that is actually running. `resolveAdminBundleUrl`/
   `resolvePluginProxyUrl` accept an optional `installedVersion` (an anchored-semver query param,
   `?v=`) and, when it differs from the manifest's current version, derive that version's own
   `.../npm/<package>@<installedVersion>/dist/admin.js` instead of serving the manifest's `adminUrl`
   — the client supplies it from `/api/plugins`' `installedVersion`, never a server-side
   `bot-ops status` lookup per fetch. A malformed `?v=` is a 400, never a silent fallback to the
   manifest's version. `getEnv`/`setEnv`/`HostApi.env`, by contrast, still follow the **index's
   current entry** — a documented limit (see `CONTEXT.md`'s gotcha), since per-version env-key
   scoping would need the bot to cache each installed version's own manifest entry, which is not
   built.
4. **Same-origin inline mount for v1; iframe + `postMessage` designed for, not built.** A
   first-party bundle runs inline in the panel's own document (`import()`ed from the same-origin
   route above), which is enough isolation for plugins the operator already chose to install and
   trust with the bot's own env — the trust boundary is unchanged from ADR-0004's: whoever can
   publish `@rackbops/plugin-*` or edit `plugins.json`. Iframe + `postMessage` isolation is a later
   option the contract shape (a bridge object, not direct DOM access to the panel) does not
   foreclose, but it is not built for v1.
5. **The rule that makes it safe: the plugin owns presentation, the panel keeps authority.** The
   `AdminApi` bridge handed to `mountAdmin` — `getEnv`/`setEnv`/`getState`/`proxyFetch` — is the
   *only* door a bundle has. `setEnv` is scoped client-side to the plugin's own declared non-secret
   keys (`scopeToPluginKeys`) and always goes through the existing guarded `POST /api/env`: the
   cross-site-write Origin gate (checked first — a forged request must not be actioned no matter
   whose ambient Access session it rides) → Access auth → `bot-ops.sh env-set`'s own
   whitelist/format validation → recreate. A bundle cannot reach another plugin's keys, a secret,
   or any route the ordinary
   config Save doesn't already use — same-origin inline mounting is a convenience, not an added
   privilege, since the server-side gate is unchanged from before this epic.

## Considered Options

- **A hardcoded per-plugin UI in the panel itself** (the wow plugin's realm chooser, before #107) —
  rejected for the same reason ADR-0004 rejected an in-repo plugin registry: every richer plugin UI
  becomes a panel-repo commit, and the panel can never "just render what's installed."
- **Iframe + `postMessage` from v1** — deferred, not rejected: real isolation against a malicious
  bundle, but more machinery (a message-passing bridge, a handshake protocol) than a first-party
  contract needs yet. The `AdminApi` bridge shape doesn't foreclose it later.
- **A generic schema-driven form** (richer than the flat env-key list, short of arbitrary code) —
  rejected for v1: it still couldn't express warbandeer's live ingest-status readout or a
  region-filtered realm dropdown, which need real logic, not just more field types.
- **One shared `ADMIN_API_VERSION` folded into `HOST_API_VERSION`** — rejected: the two evolve on
  different schedules (a panel-only UI change needs no bot compatibility bump, and vice versa), and
  folding them together would force `contract.ts` to carry DOM-adjacent types, breaking the
  single-const/DOM-free pin `contract.test.ts` enforces.
- **The panel caching each installed version's own manifest entry, so `getEnv`/`setEnv` could scope
  per-version too** — parked, not built: no plugin has yet needed a breaking env-key change between
  versions to justify the extra caching, and #165's `CONTEXT.md` gotcha names the current behaviour
  as a documented limit, not an oversight.

## Consequences

A plugin's admin UI is optional and additive — a plugin declaring no `botPlugin.adminApiVersion`
gets exactly today's flat env-key fields, unchanged. The panel gains one new trust statement,
narrower than ADR-0004's bot-side one: a mounted bundle runs inline same-origin, so an operator who
installs a plugin is trusting its admin code the same way they already trust its bot code — the
`AdminApi` scoping and the server-side `env-set` gate are the backstop, not a sandbox. Delivery adds
exactly two new panel routes (`GET /plugin-admin/<name>.js`, `GET /api/plugin-proxy/<name>`), both
allowlisted to `ADMIN_ASSET_HOST` and size-capped, so a bundle can never make the panel reach an
arbitrary origin. #165's installed-version pinning means a tab can legitimately show a
no-settings-tab-at-this-version note — an expected state (a plugin pinned below its first
admin-bundle release), not a regression. No change to `src/plugins/contract.ts` or `HOST_API_VERSION` — this ADR's
decisions are entirely on the panel side.

See [ADR-0004](0004-plugins-fetched-from-a-published-manifest.md) for the plugin-delivery contract
this extends. Design epic:
[#123](https://github.com/Rackbops/rackbops-discord-bot/issues/123). Installed-version pinning:
[#165](https://github.com/Rackbops/rackbops-discord-bot/issues/165).
