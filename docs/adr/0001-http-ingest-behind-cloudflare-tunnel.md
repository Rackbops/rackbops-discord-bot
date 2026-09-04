# HTTP ingest for the Warbandeer connector, behind the existing Cloudflare Tunnel

The bot has zero inbound network surface today, deliberately — but `docker-compose.yml`'s
`cloudflared` sidecar (`profiles: [tunnel]`) was already staged for exactly this, per its own
comment and `CONTEXT.md`'s gotcha ("pure plumbing for now... once a future local server exists").
The Warbandeer desktop app needs to push a Character Snapshot from *any* guild member's own
machine, not just the box operator's, which rules out anything operator-scoped.

**Decision:** add a `Bun.serve` HTTP server to the main bot process. It binds every interface
inside the container (`Bun.serve`'s default — not restricted to loopback, and deliberately not:
`cloudflared` reaches it as a *separate container* over the compose network, at
`http://bot:<port>`, which a loopback-only bind would refuse). Containment comes from
`docker-compose.yml` publishing no host port for it, not from the bind address — the only route
in from outside the compose network is the opt-in `cloudflared` tunnel sidecar (still profile-
gated, `profiles: [tunnel]`).

## Considered Options

- **Shared file/DB the bot reads.** Only works when the desktop app and the bot share a
  filesystem — true for exactly one operator's own box, never a guild member's PC.
- **Reuse the SSH ops channel** (`ops/bot-ops.sh`, already proven and already authenticated).
  Needs an SSH key on the bot host — fine for the existing operator-only Ops tab, not something to
  hand to arbitrary guild members. Kept as a dev/testing path, not the shipped transport.
- **A second ingress mechanism** instead of the existing tunnel plumbing. Rejected — the repo
  already committed to Cloudflare Tunnel for exactly this desktop-app API; adding a second would
  duplicate infrastructure that's already there and paid for.

## Consequences

Fail closed when unconfigured: no ingest env var set → the server doesn't start, and `/link`
reports the feature disabled rather than minting a Link Code redeemable nowhere.

**Enabling the tunnel profile makes this endpoint genuinely public**, unlike the admin panel's
own tunnel use. `ops/admin/`'s panel sits behind Cloudflare Access — a login wall — in front of
its own bearer-token door 2. This connector has no Access gate at all: an arbitrary guild member
has no Access identity to check, which is exactly why ADR-0002 exists as its own auth layer
rather than reusing Access. Once a public hostname is mapped to it, `POST /link` is reachable by
anyone on the internet, gated only by an 8-hex-character Link Code (a 32-bit space, and
`links.ts`'s `mintLinkCode` now regenerates on collision so it stays that wide) plus a per-IP
rate limit. That's the accepted security boundary here, not an oversight — worth stating plainly
since it's easy to read "behind a tunnel" as "still contained" the way the admin panel is.
