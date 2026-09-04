# Character-link storage lives outside state.json

`src/state.ts`'s `BotState` is small announcement-dedup state — dozens of bytes to a few KB,
loaded whole into memory at import and rewritten whole on every `saveState()`. A Character
Snapshot per Linked Account is orders of magnitude bigger, changes on an unrelated cadence (a
user-triggered push, not a scheduler tick), and a corrupt or oversized one must never risk
`state.json`'s own dedup history — which gates DMF, weekly-reset, realm, and release
announcements. `src/handoff.ts` already draws this exact line for its own marker file —
"exactly one process writes it (the replacement) and exactly one reads it (the original),"
never `state.json` — for the same reason.

**Decision:** two new, separately-loaded locations under `data/`: `data/links.json` (every
Linked Account — Device Token hashes + Account Labels, keyed by Discord User ID) and one
`data/characters/<discordUserId>.json` per Discord User (that user's latest Character
Snapshots). Reuse `state.ts`'s atomic-write pattern — temp-file-then-rename, generalized as
`src/warbandeer/storage.ts`'s `writeJsonAtomic`.

**Correction (post-implementation):** `links.json` (one file, one writer) reuses `state.ts`'s
`createStateWriter` shape directly (`storage.ts`'s `createJsonWriter`, which serializes only the
*write*). The per-user character files needed a second, genuinely new mechanism —
`createKeyedJsonMutator` — because there are MANY files, not one, and a naive read-modify-write
(read the current snapshot list, compute the next one, write it back) lets two concurrent pushes
for the *same* Discord User silently lose one's data: both read the same starting point before
either write lands. `createKeyedJsonMutator` closes that by serializing the read too, keyed per
file path. This is a real second storage mechanism, not just the first one reused — the
"rather than inventing a second" framing this ADR originally shipped with undersold what
`characters.ts` actually needed.

## Consequences

No bare `Record<string, T>` inside `state.json` grows unbounded with character payloads. A
malformed snapshot or an `/unlink` only ever risks that one Discord User's own file, never every
other user's data or the announcement dedup history that unrelated features depend on.

This splits `CONTEXT.md`'s single Linked Account concept — identity, Device Token hash, latest
Character Snapshot, and its timestamp — across two physical files. That's a storage detail, not
a change to the domain entity: `links.json` holds the identity/token/label half, the per-user
character file holds the snapshot half plus its own `updatedAt`, and the two are always read
together to answer "what does this Discord User have linked."
