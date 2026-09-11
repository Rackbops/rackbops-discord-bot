# Warbandeer Discord Bot

> Forked with full history from [nazumods/wow](https://github.com/nazumods/wow)'s
> `apps/warbandeer-discord`, designed and built there by
> [Nazuraki](https://github.com/nazumods) — full credit for the original bot goes to them.
> This fork is the starting point for developing it into a generic, modular Discord bot,
> independent of the WoW addon suite it grew up alongside.

## Purpose

Originally: an integration point between the in-game addon suite, the desktop app, and discord. It serves to notify users of realm
status, facilitate cross-channel communication where possible, and provide cross-user querying.

That purpose stands as-is for now — the direction from here is toward a generic bot core
with the WoW-specific pieces (DMF, realm status, transmog) as one plugin among others,
not the whole bot.

## Non-goals

- **Not staying WoW-specific.** DMF, realm status, and transmog are headed toward
  becoming plugins (character linking already is, `@rackbops/plugin-warbandeer`), not
  permanent parts of the core.
- **Not a monolith.** New features beyond the small host core belong in plugins
  installed from the Plugin Index, not folded into `src/`.
- **Not free to break the plugin contract.** The Host API (`HOST_API_VERSION`,
  `src/plugins/contract.ts`) is versioned and must stay compatible with every
  published plugin and every operator's already-installed bundles (ADR-0004).

## Intended audience

Two groups: the Discord community members it serves day to day (realm-status
notifications, cross-channel/cross-user querying -- currently the WoW addon community
this bot grew up in), and the operator who deploys and configures it (`ops/`,
`docs/adr/`) -- currently roshne.