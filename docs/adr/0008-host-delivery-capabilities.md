# `post`, `dm` and `edit`: explicit delivery, sent as the bot, contract unchanged

S1's MCP bridge (#735, the discord-mcp service) needs three things `HostApi.announce` cannot give it:
a post to one specific, operator-mapped channel rather than wherever a plugin's own routing already
resolves to; a DM to an arbitrary user; and a way to edit a message it already sent, so a delivery can
report an updated status instead of posting a new line every time. Two more requirements shape the
answer past that gap. A card's link buttons are message *components* — Discord's webhook API can carry
them, but `announce`'s webhook path exists for a plugin's own branding, and reusing it here would tie
a capability meant for any caller to whichever channel happens to have a webhook registered. And
nothing in the host today records *which bot sent which message*, which an edit needs to check before
it touches something it did not send — a plugin already reaches the live `Client` through
`interaction.client` (see `contract.ts`'s own doc comment on `HostApi`), so per-plugin ownership is
not a boundary the host can honestly police; only "did THIS BOT send it" is checkable at all.

**Decision:** four new, all-optional `HostApi` members — `post`, `dm`, `edit`, `destinations` — sent
as the bot, contract version unchanged.

1. **Optional members, no `HOST_API_VERSION` bump.** `dispose` (#184) and `http` (#220) already added
   capabilities this way; `contract.test.ts` continues to pin `contract.ts` to one runtime export, so
   these are types only. An unmodified older plugin loads exactly as before.
2. **`post`, `dm` and `edit` send as the bot, never through a channel's webhook.** A link button is a
   component, which a plain incoming webhook cannot carry, and `edit` needs a message the bot itself
   authored. `announce` is untouched (ADR-0006 decision 6) and keeps its own webhook path.
3. **`post` targets exactly the one channel mapped for `destination` in `guildId`** — never `postTo`
   or the default channel the way `announce` falls back. An undeclared destination, one unmapped in
   that server, or a guild the plugin is not placed in is a rejection with a fixed reason.
4. **`edit` checks authorship, not per-plugin ownership.** A plugin already reaches the live `Client`
   through `interaction.client`, so the host cannot honestly enforce which PLUGIN owns a message; it
   can only check that THIS BOT sent it. A caller that needs per-plugin ownership enforces it itself
   (the S1 bridge does, by principal).
5. **A bare URL in content is wrapped in `<...>` rather than suppressed.** `MessageFlags.SuppressEmbeds`
   would hide the card along with the link preview; wrapping only the URL leaves the card alone.
6. **Validation is the host's, before any Discord call, with fixed reasons that never echo caller
   text** — length and shape limits checked by hand (`hostMessage.ts`'s `LIMITS`), then built through
   discord.js's own `EmbedBuilder`/`ActionRowBuilder`/`ButtonBuilder` so their validators run too, on
   top of the hand-checked ones.

## Considered Options

- **Reuse `announce`'s webhook path for `post`/`dm`.** Rejected: a webhook cannot carry a component (a
  link button), and a DM has no webhook at all. Keeping `announce` on its own path also means this
  change touches nothing about it.
- **Let `edit` accept any message id and trust the caller.** Rejected: a host that will edit whatever
  id it is handed is a host that will edit another bot's — or another caller's — message on request.
  Checking authorship is nearly free (one fetch, one id comparison) and closes that off.
- **Per-plugin message ownership, recorded by the host.** Considered and rejected: it would need a new
  durable record (which plugin sent which message id) that the host must keep consistent forever, for
  a boundary that `interaction.client` already lets any plugin route around. Authorship is the
  boundary the host can actually keep.
- **Interactive buttons (`customId`) in this child.** Deferred, not rejected: `docs/host-extension.md`
  designs them, but nothing consumes them yet (S1's bridge is link-only). `HostMessage.buttons` is
  reserved and refused — including `buttons: []` — so the shape exists without shipping the feature
  early.

## Consequences

- `contract.ts` grows four optional members and six supporting types; every published plugin keeps
  loading unmodified, and a plugin that wants the new members feature-detects with `typeof host.post
  === "function"`.
- `rackbops-bot-plugins`' vendored `packages/api/contract.d.ts` must be re-synced to match (#736,
  second PR) — that repo's `check-contract` fails until it is.
- A plugin's `destinations()` call now depends on `routing.json` and `discovery.json` being readable;
  like every other routing read in this codebase, a failure degrades to "report nothing" rather than
  throwing.
- Live delivery (a real channel post, a real DM, the closed-DMs path, and the rendered card/buttons)
  has no unit-test substitute — it needs a running bot in a test server, named as unverified in the PR
  and checked on the next live self-update with S1's bridge as the first real caller.
