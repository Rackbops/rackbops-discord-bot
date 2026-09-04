# Link Code + Device Token as the connector's two-stage auth

This is the bot's first inbound HTTP surface and its first per-user auth of any kind —
`src/wow/blizzard.ts` states plainly of its existing client-credentials access: "Neither needs
per-user OAuth or a Battle.net account link." A single shared secret can't scope *who* owns
which characters; asking the user to hand-enter a fresh code on every sync is unusable; there's
no existing per-user credential issuance to build on.

**Decision:** two stages. `/link` mints a short single-use Link Code (~10 min TTL). The desktop
app redeems it once via `POST /link {code, accountLabel}` for a long-lived Device Token — the bot
stores only a hash of it, comparable with `timingSafeEqual` (mirroring `ops/admin/server.ts`'s
existing `tokensMatch`/`extractBearerToken` pattern), never the plaintext. Every later
`POST /characters` carries `Authorization: Bearer <token>`. `/unlink <accountLabel>` revokes a
Linked Account outright.

## Considered Options

- **A single static per-deployment API key.** Rejected — doesn't scope by Discord User, so it
  can't build the very association this feature exists to create.
- **Discord OAuth.** Rejected — no existing OAuth plumbing in this bot, and the desktop app has no
  clean way to complete a browser redirect flow.
- **The SSH-key model from `bot-ops.sh`, as the connector's real auth** (not just a dev fallback).
  Rejected for the same reason as ADR-0001: it doesn't reach arbitrary guild members.

## Consequences

A Link Code alone could never authenticate *repeat* pushes without re-entering one every sync; a
Device Token alone (skipping the code step) would mean trusting an unauthenticated first
contact — exactly what the issue calls out as unacceptable. The split gets a Discord-verified
first handshake (the code only reaches someone who ran `/link` as themselves) and an unattended
path for every push after.
