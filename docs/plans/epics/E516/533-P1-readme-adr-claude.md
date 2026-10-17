<!-- E516 / #533 bundle P1: README, CLAUDE.md/AGENTS.md/PURPOSE.md, ops/README.md and the ADRs.
Children: #427, #428, #488, #489. Files: README.md, CLAUDE.md, AGENTS.md, PURPOSE.md, ops/README.md,
docs/adr/0001-0004, docs/adr/0008. Doc and comment changes only: the single claims-vs-code audit lane, not the
two-reviewer gate. Disjoint from bundle P2 (CONTEXT.md only), so the two can run at once.
Audit: (filled in when the read-only audit has run). -->

# #533 P1 -- README, ADRs, CLAUDE/AGENTS/PURPOSE, ops/README

## What is wrong, verified at ae0339a

Every finding was re-read at `main` @ ae0339a. Already fixed, so closed by reference with no edit:

- #488 `docs-readme-adr-claude-5`, the CLAUDE.md half: CLAUDE.md:66-68 now says `install.sh` writes the
  generated `ADMIN_TOKEN` line once and the panel's saves go through `bot-ops.sh env-set`, which backs up first.
  It was fixed by #601. AGENTS.md and ops/README.md still say the old thing (steps 3 and 4).
- #488 `docs-readme-adr-claude-6`: README.md:240-244 maps the tunnel to the container NAME, never the `bot`
  alias, and names both `HTTP_PORT` and `WARBANDEER_INGEST_PORT`. It was fixed by #601 (#487).
- #488 `docs-readme-adr-claude-8`: src/plugins/contract.ts:44-49 now says a `secret` key is write-only:
  env-set accepts it, env-get never lists it, and env-schema never reports its value (#240, ADR-0006 decision 8).
  No edit.
- #489 `docs-readme-adr-claude-12`, the ops/README:1098 half: that sentence is gone. Only the :562 one is left.

Still wrong:

1. **#427** README.md:102: "a plugin tick that has already overrun its 30-second bound is the exception: the bot
   stopped waiting on it, so its still-running call is not awaited". This is false since #248. The host keeps a
   plugin call's critical-section hold past its timeout, and stop aborts it and waits up to
   `PLUGIN_TICK_ABORT_GRACE_MS` (5 s). README.md:269 already says so. Grep `PLUGIN_TICK_ABORT_GRACE_MS` in
   `src/plugins/host.ts` to cite the constant by name.
2. **#428** CLAUDE.md:9 and AGENTS.md:9 say "DMF, realm status and transmog still in the core and headed the
   same way". PURPOSE.md:15-17 says the WoW pieces will become "one plugin among others", and PURPOSE.md:21-23
   says they are "headed toward becoming plugins". Commit 00ee725 (#107) moved them into `@rackbops/plugin-wow`.
   There is no `src/wow/`, and README.md:14 and :250 already credit the wow plugin.
3. **#488 -5 / AGENTS.md mirror drift.** AGENTS.md:55 still says "never touched again by anything but the
   operator". AGENTS.md is the Codex mirror of CLAUDE.md. Outside its first 12 lines, the only difference that
   should exist is `Personal \`AGENTS.md\`'s` for `Personal \`CLAUDE.md\`'s`, and #601 changed CLAUDE.md alone.
4. **#488 -5** ops/README.md:222-223: "the one precious, operator-edited file is never touched by anything but
   the operator (`$CONFIG_DIR/.env`, created once from `.env.example` and left alone on every later run)". In
   fact `install.sh` writes `ADMIN_TOKEN` into it when it creates the file, and `bot-ops.sh env-set` (the
   panel's Apply) backs it up and rewrites it.
5. **#488 -3** README.md:129 says "The panel's Modify Plugins section", and README.md:134 says "its own tab in
   the panel's **Plugin Settings** section". Neither exists. The panel has Overview/Plugins/Servers/Settings tabs,
   update buttons sit on the plugin's card in the Plugins tab, and a plugin's own bundle mounts inside that card
   (#244; `server.test.ts` pins the Plugin Settings section gone).
6. **#488 -9** docs/adr/0008-host-delivery-capabilities.md:50 points at `docs/host-extension.md`, which does
   not exist. `docs/` holds only `adr/`, `plans/` and `research/`.
7. **#489 -10** ADRs 0001-0004 cite files that moved to `@rackbops/plugin-warbandeer` or `@rackbops/plugin-wow`
   (`src/warbandeer/*`, `links.ts`, `characters.ts`, `src/wow/blizzard.ts`) and stale lines
   (`src/index.ts:10,76-92`, `:12`, `:34-41`, `src/commands.ts:23-24,...`, `src/redeploy.ts:208-212`). None of
   them carry a status note. README.md's character-linking wire contract (Grep `## Character linking`) is
   implemented by the plugin, not by anything in this repo.
8. **#489 -10, door numbering:** docs/adr/0001...md:35 calls the panel's door 2 a "bearer-token door 2". In the
   code, door 2 is a verified Access JWT primarily, with the `ADMIN_TOKEN` bearer token as the fallback
   (ops/admin/server.ts:7-9; Grep `Door 2, OR not AND`).
9. **#489 -11** The README.md `## Files` table has 15 rows against about 40 modules, and its
   `src/announce.ts` row omits the auto-update, request-mailbox, plugin-update and discovery checks the tick
   runs. Grep `checkForUpdate\|drain\|checkPluginUpdates\|discovery` in `src/announce.ts` to list them.
10. **#489 -12** ops/README.md:562: "give it an `ops.json` target once the panel gap above is closed". No gap is
    described above it.

## Decisions

- **ADRs are records, so they are not rewritten.** Under each moved ADR's title, add a status line:
  `> **Status (2026-10): accepted; the code it cites moved to \`@rackbops/plugin-warbandeer\` (#100)` (or
  `plugin-wow` (#107) for 0002's `src/wow/blizzard.ts`) `. File and line references below are as of the decision.`
  Do not renumber or rewrite the cites themselves. ADR-0004 is about the host, so it gets the same line, but naming
  that its `src/index.ts`/`src/commands.ts`/`src/redeploy.ts` line numbers are as of the decision.
- **README Files table:** keep the table, fix the announce row, and add one sentence under the heading. The
  sentence says the table lists the main modules, and that `CONTEXT.md`'s **File Map** is the complete,
  per-file map. Do not try to list all ~40 modules, because it would rot again.
- **Wire contract:** add one sentence at the top of README's character-linking section saying the endpoint is
  served by `@rackbops/plugin-warbandeer`, and that its status codes and limits are that plugin's to change.
  Do not move the section.
- **ops/README.md:562:** delete "once the panel gap above is closed", so the sentence reads: give it an
  `ops.json` target (or manage it directly over SSH ...). Verify `ops.json` targets work today by Grep-ing
  `ops.json` in ops/README.md. If a target can already be added, say so plainly. If one cannot, say "until it has
  one, manage it directly".
- **AGENTS.md is regenerated, never hand-edited line by line.** Copy CLAUDE.md, then re-apply exactly the three
  differences the current mirror has: line 1 `-- Codex Instructions`, line 12 `~/.codex/AGENTS.md`, and
  `Personal \`AGENTS.md\`'s`. Done means `diff CLAUDE.md AGENTS.md` shows exactly those three lines.

## Steps

1. README.md:102 (#427): replace the parenthetical with: "(a plugin tick that has overrun its 30-second bound is
   aborted, and waited on for at most 5 s, `PLUGIN_TICK_ABORT_GRACE_MS`, #248, then left running)". Check that the
   8 s total in the same sentence still reads right.
2. CLAUDE.md:7-10 (#428): replace "with DMF, realm status and transmog still in the core and headed the same way"
   with "and the WoW commands (DMF, realm status, transmog) already moved to `@rackbops/plugin-wow` (#107); the
   core holds no WoW code". Keep the `see PURPOSE.md` pointer.
3. PURPOSE.md (#428): in Purpose, say the WoW pieces are now the `wow` plugin (#107), one plugin among others.
   In Non-goals, change "headed toward becoming plugins" to the done state: they are plugins
   (`@rackbops/plugin-wow`, `@rackbops/plugin-warbandeer`), and the core stays WoW-free. Intended audience
   stays as it is, apart from tense where it implies the core does WoW.
4. AGENTS.md: regenerate per Decisions after steps 2 and the CLAUDE.md state are final (#428, #488 -5).
5. ops/README.md:220-223 (#488 -5): reword to match CLAUDE.md:66-68. `install.sh` writes only the one
   `ADMIN_TOKEN` line when it creates the file, and leaves it alone on every later run. After that, only the
   operator changes it, by hand or through the panel's saves (`bot-ops.sh env-set`, which backs it up first).
   Nothing changes it on its own.
6. README.md:129 and :134 (#488 -3): "The panel's Modify Plugins section" becomes "Each plugin's card on the
   panel's **Plugins** tab". "its own tab in the panel's **Plugin Settings** section, one per installed plugin
   that opted in" becomes "inside that plugin's card on the **Plugins** tab, for each installed plugin that opted
   in". Grep README.md for `Modify Plugins\|Plugin Settings` afterwards and expect no hits.
7. docs/adr/0008...md:50 (#488 -9): replace the `docs/host-extension.md` reference with a pointer to this ADR's
   own `Update (#323)` paragraph (Grep `#323` in the file to confirm it exists). If there is none, drop the
   pointer and leave "Deferred, not rejected".
8. ADRs 0001, 0002, 0003, 0004 (#489 -10): add the status line from Decisions under each title.
9. docs/adr/0001...md:35 (#489 -10): "its own bearer-token door 2" becomes "its own door 2 (a verified Access
   JWT, with the `ADMIN_TOKEN` bearer token as the fallback)".
10. README.md character-linking section (#489 -10): add the plugin-owned sentence from Decisions.
11. README.md `## Files` (#489 -11): add the File Map sentence and fix the `src/announce.ts` row from what Grep
    finds in `src/announce.ts`.
12. ops/README.md:562 (#489 -12): per Decisions.

## Tests

Doc-only, so there is no unit test. The guards are the greps in Verification, plus `bun run check` and `bun test`
staying green (nothing here is read by a test, but run them anyway: contract.ts is not touched, and no test reads
the README).

## Mutation table

N/A, because no code changes. The equivalent check is that each grep in Verification fails on the pre-change tree
and passes on the new one. Run each one on `origin/main` first and paste both results.

## Coverage table

| Finding | Step | Check |
|---|---|---|
| #427 | 1 | Grep `stopped waiting on it` in README.md: 0 hits |
| #428 | 2, 3, 4 | Grep `still in the core\|headed toward becoming` in CLAUDE.md, AGENTS.md, PURPOSE.md: 0 hits |
| #488 -3 | 6 | Grep `Modify Plugins\|Plugin Settings` in README.md: 0 hits |
| #488 -5 | 4, 5 | Grep `never touched again\|never touched by anything but` in AGENTS.md, ops/README.md: 0 hits |
| #488 -6, -8 | none | closed by reference (#601, #240) |
| #488 -9 | 7 | Grep `host-extension` across the repo: 0 hits |
| #489 -10 | 8, 9, 10 | each of ADR 0001-0004 has a `Status (2026-10)` line; Grep `bearer-token door 2`: 0 hits |
| #489 -11 | 11 | README `## Files` names `CONTEXT.md`'s File Map |
| #489 -12 | 12 | Grep `gap above` in ops/README.md: 0 hits |
| mirror | 4 | `diff CLAUDE.md AGENTS.md` shows exactly the three expected lines |

## Verification

Paste the output of every grep in the Coverage table, run on the branch (and on `origin/main` for the before
state), plus `diff CLAUDE.md AGENTS.md`. Then run one independent claims-vs-code audit: spawn a read-only Sonnet
agent on the branch's merged state. It checks every sentence this PR adds or changes against the code it
describes (host.ts for #427, announce.ts for the Files row, server.ts for door 2, install.sh/bot-ops.sh for the
`.env` wording) and reports anything false. Fix what it finds. Rewording needs no second audit.

## Acceptance

- [ ] Every Coverage-table check passes, with before/after output pasted in the PR.
- [ ] The audit agent's report is pasted (or summarised with each finding and its fix).
- [ ] `bun run check` and `bun test` green.

## PR

Title: `docs: correct the shutdown, WoW-plugin, panel, .env and tunnel claims in README, ADRs and CLAUDE/AGENTS/PURPOSE (#427, #428, #488, #489)`.
The body lists what was already fixed and closed by reference (#488 -6 by #601, -8 by #240, the CLAUDE.md half of
-5 by #601), and gives the audit result.

## Out of scope

- CONTEXT.md (bundle P2).
- Rewriting the ADRs' reasoning, or renumbering their cites.
- Completing the README Files table row by row.
