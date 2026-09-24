# Plugins serve HTTP through one host-owned router

ADR-0004 left this open on purpose: "An HTTP plugin keeps its own `Bun.serve` on its own port env; a
host-owned router and a stop/dispose hook are additive later." The dispose hook shipped (#184). The
router did not (#220), and by 2026-09-24 two plugins each run their own server:

- **warbandeer:** `POST /link` and `POST /characters` at the root of `WARBANDEER_INGEST_PORT`.
  ADR-0001 covers the transport and ADR-0002 the auth. The Warbandeer desktop app posts there.
- **music:** `GET /spotify/callback` on `MUSIC_CALLBACK_PORT` (8790). That URL is registered as a
  Redirect URI on the Spotify app, once per instance (`music-dev.rackbops.com`, `music.rackbops.com`).

Each instance reaches the internet through one token-based `cloudflared` sidecar
(`rackbops-discord-bot-<instance>-tunnel`, on the instance's own compose network). Its public
hostnames are made by hand in the Cloudflare dashboard, not in any file here. So every new HTTP
plugin costs a port env key, **plus** a hand-made hostname, route and DNS record per plugin and per
instance. Going live with music on prod (#247) took exactly that.

**Decision (roshne, 2026-09-24, #220):** the host owns one HTTP listener per instance. A plugin
mounts a handler under its own name, and every plugin shares one public hostname and one tunnel
route.

1. **Routing is by path prefix, `/<plugin-name>/…`.** The first path segment names the plugin,
   matched exactly, just as a component `customId` is matched on the text before its first colon
   (`routeInteractionByPrefix`, `src/plugins/host.ts`). Plugin names are `^[a-z][a-z0-9-]*$`, so the
   match is exact and needs no longest-prefix rule. One hostname per instance (for example
   `api.rackbops.com` and `api-dev.rackbops.com`) and one tunnel route to
   `http://rackbops-discord-bot-<instance>:<HTTP_PORT>` serve every plugin. A new HTTP plugin needs
   no Cloudflare work.
2. **The handler sees its own path, with the prefix stripped.** The contract gains an optional
   `Plugin.http?(request, info)`:
   - `info.path` is the path after `/<name>`: `"/"` for a bare `/<name>` or `/<name>/`, and
     `"/callback"` for `/<name>/callback`.
   - `info.clientIp` is `CF-Connecting-IP`, falling back to the socket address, computed once by the
     host. The same trust caveat applies as in warbandeer's and music's own servers: Cloudflare sets
     that header for anything that really transits its network, but nothing re-verifies it.
   - `request` is the untouched `Request`, full URL included, for anything else (headers, query,
     body).
   - A plugin never needs to know where it is mounted.
   - Additive and optional, so `HOST_API_VERSION` stays 1.
3. **The listener is opt-in and belongs to the bot container.** It is controlled by a core
   `HTTP_PORT` env key.
   - Unset means no listener at all: ADR-0001's fail-closed rule.
   - It starts inside `activate()`, after `takeOver()`, so a standby never binds it (the standby
     invariant in `CONTEXT.md`). Shutdown stops it (`shutdown.ts`) before plugins are disposed.
   - `docker-compose.yml` publishes no host port for it; the only way in is the instance's tunnel.
   - The admin panel stays its own container, on its own hostname.
4. **The host bounds and isolates every request, as it does a tick or an interaction.**
   - A handler that throws is logged and answered with `500`.
   - One still running after `PLUGIN_HTTP_TIMEOUT_MS` (10 s) is answered with `504`. The host stops
     waiting, but the call is not cancelled.
   - A request body over `HTTP_MAX_BODY_BYTES` (1 MiB) is refused at the transport. A plugin keeps
     its own tighter limit, as warbandeer does.
   - An unknown first segment, or none, answers `404`. So does a plugin with no `http` handler. A
     plugin that has one but is not running answers `503`.
   - No response carries a plugin's error text.
5. **Existing servers coexist, and each migrates in its own release.** warbandeer and music keep
   their `Bun.serve` and their public URLs. Moving one under the router changes a URL someone
   outside holds: for music, a new Spotify Redirect URI per instance; for warbandeer, a desktop-app
   update. That is the plugin's own breaking change, made when its release is ready, never a side
   effect of the host. The host keeps no permanent aliases for their old root paths.
6. **A request is not a critical section.** A restart does not wait for an HTTP request, unlike a
   tick. A plugin's writes go through `HostStorage` (temp file, then rename), so a request cut off by
   a restart loses that request but cannot corrupt a file. The client, whether Spotify's redirect or
   the desktop app's retry, simply sees the connection drop. That is the same outcome as with the
   plugins' own servers today.

## Considered Options

- **A hostname per plugin, all on one port, routed by the `Host` header.** It saves ports but not the
  dashboard work, which is the real cost: every plugin would still need its own hostname, route and
  DNS record per instance. Rejected.
- **Migrate warbandeer and music in the same batch.** It forces two outside changes (the Spotify
  registrations and a desktop-app release) onto the host's schedule. Rejected in favour of decision 5.
- **Keep their old root paths as permanent aliases on the router.** No outside client would have to
  change, but the router would carry a special case forever, and two plugins' paths would collide
  at the root. Rejected.
- **Hand the plugin the raw `Request` only.** The host would be simpler, but every plugin would
  repeat the prefix-stripping and the `CF-Connecting-IP` rule. Rejected.
- **An always-on listener on a fixed port.** Nothing to configure, but a listener runs even where no
  plugin serves HTTP, which contradicts ADR-0001's fail-closed rule. Rejected.

## Consequences

- **`src/plugins/contract.ts` gains `Plugin.http?` and its info type**, a paired re-vendor in
  `rackbops-bot-plugins`. The plugin authoring guide gains an "HTTP routes" section.
- **A core `HTTP_PORT` key.** It is set by hand in `.env` at first. Making it editable in the panel
  means adding an `ALLOWED` row to `ops/bot-ops.sh`, which moves the bot-ops schema, so that is a
  separate follow-up.
- **The operator makes one hostname and one tunnel route per instance, once.** After that, adding an
  HTTP plugin is configuration only.
- **A self-update handoff hands the route over with the container name.** The replacement comes up
  as `<name>-next` and binds its own listener only after it takes over. It takes the canonical name
  as it retires the original (`replacementName`, `src/redeploy.ts`). The tunnel routes by that
  canonical name, so requests keep reaching the original until the swap, and the replacement from
  then on. That is the same as the plugins' own servers today.
