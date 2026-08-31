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