<!-- E516 / #533 bundle P1: README, CLAUDE.md/AGENTS.md/PURPOSE.md, ops/README.md and the ADRs.
Children: #427, #428, #488, #489. Files: README.md, CLAUDE.md, AGENTS.md, PURPOSE.md, ops/README.md,
docs/adr/0001-0004, docs/adr/0008. Doc and comment changes only: the single claims-vs-code audit lane, not the
two-reviewer gate. Disjoint from bundle P2 (CONTEXT.md only), so the two can run at once.
Audit: round 1 (S:/Repos/_wt/audits/533-docs-audit-round1.md, at ae0339a): 3 majors (a moved ops.json-gap
sentence, `\|` greps that matched nothing, more stale "tab" claims) + 3 minors, all applied; 2 declined in writing
(ADR-0004's cites kept as history, CLAUDE.md:76 "never auto-touched" kept). Round 2 (narrow, 533-docs-audit-round2.md):
1 major (the #428 check could not see PURPOSE.md's wrapped phrase -> `-U`) + 4 minors (ADR note "some of", 0004
names plugin-warbandeer, ADR-0008 wording, step 1 scope), all applied; wording only, no third round. -->


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
- None of #489 `docs-readme-adr-claude-12` is fixed. The :1098 sentence moved, it was not removed: it is now
  ops/README.md:1368-1369 (see item 10).
- CLAUDE.md:76 / AGENTS.md:74, "the one precious, operator-edited file is never auto-touched": kept, and the
  audit's note on it is declined in writing in the PR. `install.sh` writes `ADMIN_TOKEN` only while CREATING the
  file (ops/install.sh:317-336), and every later change is an operator's (by hand, or the panel's `env-set`, which
  backs up first, ops/bot-ops.sh:1150), so nothing touches the existing file on its own. CLAUDE.md:66-68, three
  lines above, already says the creation-time write.

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
   (#244; `server.test.ts` pins the Plugin Settings section gone: Grep `the Plugin Settings section is gone`).
   The rest of README's `## Plugin settings` section (:136-149) is written for the removed tabs too: :138 "No tab
   for a plugin that hasn't opted in", :141 "whose tab targets a different admin version", :145 "What a tab can
   and cannot do", :149 "It renders as its own tab, but it isn't a separate door". One string there is real UI
   text and stays: "has no settings tab" at :143 is `ops/admin/public/index.html:727`'s own message.
6. **#488 -9** docs/adr/0008-host-delivery-capabilities.md:50 points at `docs/host-extension.md`, which does
   not exist. `docs/` holds only `adr/`, `plans/` and `research/`.
7. **#489 -10** ADRs 0001-0004 cite files that moved to `@rackbops/plugin-warbandeer` or `@rackbops/plugin-wow`
   (`src/warbandeer/*`, `links.ts`, `characters.ts`, `src/wow/blizzard.ts`) and stale lines
   (`src/index.ts:10,76-92`, `:12`, `:34-41`, `src/commands.ts:23-24,...`, `src/redeploy.ts:208-212`). None of
   them carry a status note (no ADR in docs/adr/ has a Status line at all). README.md's character-linking wire
   contract (`### Wire contract`, about :183) is implemented by the plugin, not by anything in this repo;
   README.md:169 already says linking ships as the plugin, but nothing at the contract says who owns it.
8. **#489 -10, door numbering:** docs/adr/0001...md:35 calls the panel's door 2 a "bearer-token door 2". In the
   code, door 2 is a verified Access JWT primarily, with the `ADMIN_TOKEN` bearer token as the fallback
   (ops/admin/server.ts:7-9; Grep `Door 2, OR not AND`).
9. **#489 -11** The README.md `## Files` table has 15 rows against about 40 modules, and its
   `src/announce.ts` row omits the auto-update, request-mailbox, plugin-update and discovery checks the tick
   runs: `autoUpdate` (src/announce.ts:233-238), `pluginRequests` (:246), `pluginUpdates` (:267) and
   `discovery` (:288), verified at ae0339a.
10. **#489 -12** Two sentences point at an `ops.json` gap that nothing describes (the only `ops.json` text,
    ops/README.md:491-546, describes a working setup): ops/README.md:562, "give it an `ops.json` target once the
    panel gap above is closed", and ops/README.md:1368-1369, "Built primarily to sidestep the `ops.json` gap
    above rather than fix it" (the issue's :1098 cite, moved).

## Decisions

- **ADRs are records, so they are not rewritten.** Under each moved ADR's title, add a note that asserts no
  status the ADRs never carried: `> **Note (2026-10):** some of the code this ADR cites has since moved to
  <plugins>. File and line references below are as of the decision.` ("some": ADR-0001 also cites
  `docker-compose.yml`, ADR-0003 `src/state.ts` and `src/handoff.ts`, which stayed in the core.) `<plugins>` names
  exactly the packages that ADR's own cites reach, found by Grep-ing the ADR for `src/warbandeer`, `links.ts`,
  `characters.ts` and `src/wow/`: `@rackbops/plugin-warbandeer` (#100) for warbandeer files,
  `@rackbops/plugin-wow` (#107) for `src/wow/`, joined with "and" when it cites both. At ae0339a that is
  plugin-wow alone for ADR-0002 (`src/wow/blizzard.ts`), and plugin-warbandeer for 0001, 0003 and 0004 (0004 cites
  `src/warbandeer/*` at :8, :92 and :120). ADR-0004's note adds that its `src/index.ts`/`src/commands.ts`/
  `src/config.ts`/`src/redeploy.ts` line numbers describe PR #92's pre-plugin state. Refreshing ADR-0004's cites (#489 -10 asks for it) is DECLINED in writing in the PR:
  they record what PR #92 hand-wired, and renumbering them would rewrite history, not fix a claim.
- **README Files table:** keep the table, fix the announce row, and add one sentence under the heading. The
  sentence says the table lists the main modules, and that `CONTEXT.md`'s **File Map** is the complete,
  per-file map. Do not try to list all ~40 modules, because it would rot again.
- **Wire contract:** add one sentence directly under the `### Wire contract` heading (not at the top of the
  section, where README.md:169 already says linking ships as the plugin) saying the endpoint is served by
  `@rackbops/plugin-warbandeer`, and that its status codes and limits are that plugin's to change. Do not move the
  section.
- **The two `ops.json` gap sentences:** ops/README.md:491-546 describes `ops.json` targets as working today, so
  neither sentence has a gap to point at. :562 becomes "Once bootstrapped, give it an `ops.json` target, or manage
  it directly (...)", keeping the parenthetical. :1368-1369 drops "Built primarily to sidestep the `ops.json` gap
  above rather than fix it:" and keeps what follows as the reason the panel exists: "Built so it is reachable from
  anywhere, not just wherever the desktop app is installed, and scoped ...".
- **AGENTS.md is regenerated, never hand-edited line by line.** Copy CLAUDE.md, then re-apply exactly the three
  differences the current mirror has: line 1 `-- Codex Instructions`, line 12 `~/.codex/AGENTS.md`, and
  `Personal \`AGENTS.md\`'s`. Done means `diff CLAUDE.md AGENTS.md` shows exactly those three lines.

## Steps

1. README.md:102 (#427): replace the parenthetical with: "(a plugin tick still running at the stop, including one
   past its 30-second bound, is aborted and waited on for at most 5 s, `PLUGIN_TICK_ABORT_GRACE_MS`, #248, then no
   longer waited on)". The
   source is src/plugins/host.ts:445-451 and src/shutdown.ts's 8 s `SHUTDOWN_GRACE_MS`. Check that the 8 s total in
   the same sentence still reads right.
2. CLAUDE.md:7-10 (#428): replace "with DMF, realm status and transmog still in the core and headed the same way"
   with "and the WoW commands (DMF, realm status, transmog) already moved to `@rackbops/plugin-wow` (#107); the
   core holds no WoW code". Keep the `see PURPOSE.md` pointer.
3. PURPOSE.md (#428): in Purpose (:14-16, "the direction from here is toward a generic bot core with the
   WoW-specific pieces ... as one plugin among others"), say the WoW pieces are now the `wow` plugin (#107), one
   plugin among others.
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
   in". Then README.md:136-149 (`## Plugin settings`) in the card's terms: :138 "No settings for a plugin that
   hasn't opted in"; :141 "A plugin whose bundle targets a different admin version ..."; :145 "What a plugin's
   settings can and cannot do"; :149 "It renders inside the plugin's card, but it isn't a separate door". Keep
   :143's quoted `has no settings tab` message as it is (it is index.html:727's text). Grep README.md for
   `Modify Plugins|Plugin Settings|own tab|No tab|whose tab|a tab can` afterwards and expect no hits.
7. docs/adr/0008...md:50-51 (#488 -9): "Deferred, not rejected: `docs/host-extension.md` designs them, but
   nothing consumes them yet (S1's bridge is link-only)" becomes "Deferred, not rejected: nothing consumes them
   yet (S1's bridge is link-only; see the **Update (#323)** below)". The rest of the bullet stays as the record of
   what was true then. The `**Update (#323):**` paragraph follows at :54 (confirmed at ae0339a).
8. ADRs 0001, 0002, 0003, 0004 (#489 -10): add the note from Decisions under each title.
9. docs/adr/0001...md:35 (#489 -10): "its own bearer-token door 2" becomes "its own door 2 (a verified Access
   JWT, with the `ADMIN_TOKEN` bearer token as the fallback)".
10. README.md `### Wire contract` (#489 -10): add the plugin-owned sentence from Decisions.
11. README.md `## Files` (#489 -11): add the File Map sentence and fix the `src/announce.ts` row: it names the
    automatic self-update check, the request-mailbox drain, the plugin-update check and the discovery refresh
    (item 9's cites; re-read them at the branch's base).
12. ops/README.md:562 and :1368-1369 (#489 -12): per Decisions.

## Tests

Doc-only, so there is no unit test. The guards are the greps in Verification, plus `bun run check` and `bun test`
staying green (nothing here is read by a test, but run them anyway: contract.ts is not touched, and no test reads
the README).

## Mutation table

N/A, because no code changes. The equivalent check is that each search in the Coverage table finds hits on the
pre-change tree and none on the new one. Run each one on `origin/main` first and paste both results: a "before"
run that already shows 0 hits proves nothing and means the search is wrong.

## Coverage table

Every search is written in `rg` notation for the Grep tool (ripgrep; MILE's Git Bash has no `rg`, so run them
through the Grep tool, `-U` meaning `multiline: true` and `-g` its `glob`): alternation is a bare `|`, never `\|`
(in ripgrep `\|` is a literal pipe and matches nothing). Searches that span a line break use `-U` with `\s+`
between words. Repo-wide searches exclude the plans with `-g '!docs/plans/**'`, since this plan quotes them.

| Finding | Step | Check (`rg` form; before: hits, after: 0 unless stated) |
|---|---|---|
| #427 | 1 | `rg -n 'stopped waiting on it' README.md` |
| #428 | 2, 3, 4 | `rg -nU 'still in the core|headed\s+toward\s+becoming|direction\s+from\s+here\s+is\s+toward' CLAUDE.md AGENTS.md PURPOSE.md`: before, hits in all three files (PURPOSE.md's wrap at :20-21, so `-U` is required) |
| #488 -3 | 6 | `rg -n 'Modify Plugins|Plugin Settings|own tab|No tab|whose tab|a tab can' README.md` |
| #488 -5 | 4, 5 | `rg -nU 'never touched again|never\s+touched\s+by\s+anything\s+but' AGENTS.md ops/README.md` |
| #488 -6, -8 | none | closed by reference (#601, #240) |
| #488 -9 | 7 | `rg -n 'host-extension' -g '!docs/plans/**'` |
| #489 -10 | 8, 9, 10 | `rg -c '^> \*\*Note \(2026-10\)' docs/adr/000[1-4]*.md`: before 0 each, after 1 each; `rg -nU 'bearer-token\s+door 2' -g '!docs/plans/**'`: after 0; `rg -n 'plugin-warbandeer' README.md` gains a hit within 3 lines after `### Wire contract` |
| #489 -11 | 11 | `rg -n 'File Map' README.md`: before 0, after at least 1; quote the `src/announce.ts` row before and after: after, it names the self-update check, the request-mailbox drain, the plugin-update check and the discovery refresh |
| #489 -12 | 12 | `rg -nU 'gap\s+above' ops/README.md` (multiline: the :1368 sentence breaks between "gap" and "above") |
| mirror | 4 | `diff CLAUDE.md AGENTS.md` shows exactly three one-line hunks (lines 1, 12, 58); before it shows a fourth (67-69) |

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
-5 by #601), the two declines with their reasons (ADR-0004's cites kept as history; CLAUDE.md:76's "never
auto-touched" kept, see What is wrong), and the audit result.

## Out of scope

- CONTEXT.md (bundle P2).
- "settings tab" as a glossary term (ops/README.md:1651, CONTEXT.md): the panel's own text says "has no settings
  tab", so the term stays.
- Rewriting the ADRs' reasoning, or renumbering their cites.
- Completing the README Files table row by row.
