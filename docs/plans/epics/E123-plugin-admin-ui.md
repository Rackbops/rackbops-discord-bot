# E123 — Plugin admin-UI contract — implementation plan

Status: **CLOSED — epic complete 2026-09-08** (live proof on `debug`, evidence on #125; closing
comment on #123). R1/R2 executed with the Claude-in-Chrome extension driving roshne's signed-in
Chrome: admin redeployed from `main`, the no-bundle note seen live for warbandeer 1.0.0, the panel's
*Update now* ran the update success path for the first time (1.0.0 → 1.1.0), the port edit went
through the guarded save and was reverted. One operational finding filed as #173 (the instance's
`bot-ops.sh` had silently fallen behind `main`). Epic issue:
[#123](https://github.com/Rackbops/rackbops-discord-bot/issues/123). Children (in the epic's order):
[rackbops-bot-plugins#9](https://github.com/Rackbops/rackbops-bot-plugins/issues/9),
[#124](https://github.com/Rackbops/rackbops-discord-bot/issues/124),
[rackbops-bot-plugins#10](https://github.com/Rackbops/rackbops-bot-plugins/issues/10),
[#125](https://github.com/Rackbops/rackbops-discord-bot/issues/125). Predecessor epic:
[#95](https://github.com/Rackbops/rackbops-discord-bot/issues/95) (closed). Design of record: the #123
body (decisions 1–4 are locked; this plan does not reopen them).

This plan was written when the epic was *picked up for closing*, not when it was filed: three of the
four children and the downstream #107 payoff are already merged and live. So the plan is mostly a
**verified ledger of what shipped**, the **reconciliation with #95**, and the **short list of what is
still open** before the epic can honestly close. Every claim below was checked against `main`, the
published index/npm/jsDelivr, and the live `debug` instance on 2026-09-08.

---

## 1. What the epic delivers (exit criterion)

A plugin can ship its own admin UI as a versioned browser bundle, and the admin panel mounts it as a
per-plugin tab through the `AdminApi` bridge while keeping authority over every config write. The
exit criterion, restated as one demonstrable sentence:

> On `bot-dev.rackbops.com`, a plugin's published admin bundle renders as its own tab, a config edit
> made in that tab goes through Access auth → the cross-site-write gate → `bot-ops.sh env-set`
> validation → recreate, an `adminApiVersion` mismatch shows a note instead of mounting, and a plugin
> without `adminUrl` shows no tab.

## 2. Where the epic sits

- **Follows #95** (plugin framework, closed 2026-09-06). This epic is the second half of the same
  symmetry: `HostApi` on the bot side, `AdminApi` on the panel side.
- **Preceded and reshaped #107** (the WoW extraction). #107 is now **closed and deployed**
  (PR #129, squash `00ee725`; the wow plugin's realm-chooser tab is live). The epic's "payoff"
  section is therefore already realised, not pending.
- No further consumer is waiting on this epic. What remains is proof, hygiene and closure.

## 3. Verified state — what has shipped

### 3.1 Children

| # | Child | Where | State | Landed as |
|---|---|---|---|---|
| 1 | Contract module + manifest `adminUrl`/`adminApiVersion` | plugins repo + bot | **closed** | plugins PR #11 (`15fac34`), bot PR #126 (`ee1774d`) |
| 2 | Panel: tab host + delivery proxy + `AdminApi` bridge (#124) | bot `ops/admin` | **merged, issue still OPEN** | PR #127 (`890b90c`) + Dockerfile fix PR #128 (`999818b`) |
| 3 | First consumer: warbandeer admin tab (plugins#10) | plugins repo | **closed** | plugins PR #13 (`476dbc4`); `@rackbops/plugin-warbandeer@1.1.0` published |
| 4 | Deploy + prove on `debug` (#125) | ops | **OPEN — partially executed** | admin rebuilt + tab rendered live 2026-09-06; see §5 |

Downstream, not a child: plugins#14 (wow plugin + realm-chooser tab, PR #15 `6e51950`,
`@rackbops/plugin-wow@1.0.0` published) and bot #107 (PR #129 `00ee725`) — both closed.

### 3.2 Published artefacts (checked 2026-09-08)

| Artefact | Result |
|---|---|
| `plugins.json` on `main` | warbandeer `1.1.0` and wow `1.0.0`, both `adminApiVersion: 1` with a derived jsDelivr `adminUrl` |
| npm `@rackbops/plugin-warbandeer` | versions `0.0.0, 1.0.0, 1.1.0`; `latest` = `1.1.0` |
| npm `@rackbops/plugin-wow` | 200 |
| `https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.1.0/dist/admin.js` | 200 |

### 3.3 Code anchors on `main` (`33644e9`)

- Contract fields: [`src/plugins/contract.ts:63-73`](../../../src/plugins/contract.ts) — two optional
  type fields only; the single-const pin in `contract.test.ts` still holds.
- Vendored panel contract: [`ops/admin/admin-contract.ts`](../../../ops/admin/admin-contract.ts)
  (`ADMIN_API_VERSION = 1`, `AdminApi`, `SaveResult`). Deliberately **not** drift-pinned across repos
  (its header explains why: a mismatch fails safe into the version-skip note).
- Delivery: [`ops/admin/server.ts:757-794`](../../../ops/admin/server.ts) — `ADMIN_ASSET_HOST`
  (`cdn.jsdelivr.net`), `ADMIN_ASSET_MAX_BYTES` (512 KB), `resolveAdminBundleUrl` (https +
  allowlisted host + `adminApiVersion === ADMIN_API_VERSION`); `resolvePluginProxyUrl` from `:800`
  (rejects scheme, leading slash, backslash, `.`/`..`, and `%`-encoding, then re-asserts the package
  prefix — the `%2e%2e` lesson).
- View merge: `server.ts:746-747` carries `adminUrl`/`adminApiVersion` **from the index entry**;
  `:751-752` publishes the panel's `adminApiVersion` top-level.
- Client: [`ops/admin/public/index.html:561-562`](../../../ops/admin/public/index.html) mismatch →
  `{kind:"mismatch"}`; `:595` `meta.version` = **installed** version; `:650` mount root
  `plugin-admin-root-<name>`; `:665-666` import + `mountAdmin(root, makeAdminApi(plugin))`.
- Tests: `ops/admin/server.test.ts:2374-2417+` (`mergePluginsView` admin fields, no-bundle omission,
  `resolveAdminBundleUrl` allowlist/https/version gate) plus the traversal pins.
- Image: [`ops/admin/Dockerfile:17-20`](../../../ops/admin/Dockerfile) COPYs `admin-contract.ts`
  explicitly (the #128 fix), with a comment that nothing but the image build catches a missing one.

### 3.4 The live `debug` instance (nucbox, read 2026-09-08)

| Item | Value |
|---|---|
| bot container | `Up 2 days`, image built at `GIT_SHA=00ee725` (the #107 merge) |
| admin container | `Up 2 days`, created 2026-09-06 20:47 UTC, contains `admin-contract.ts`; **behind `main` by 5 commits touching `ops/admin`** (#141, #144, #146, #157, #162 — `server.ts` +99, tests +149) |
| `.env` | `PLUGINS=warbandeer,wow`, `WARBANDEER_INGEST_PORT=8082`, `WOW_REGION=us`, `WOW_REALM=eitrigg`, `PLUGIN_INDEX_URL=` (default) |
| `state.json` | warbandeer `installedVersion 1.0.0`, `availableVersion 1.1.0`, `notifiedVersion 1.1.0`; wow `1.0.0` — both `active` |
| bot logs | `index: fresh, 2 selected`, `wow@1.0.0 downloaded, integrity ok`, `Registered 9 slash commands`, ingest on `:8082` |

Note the warbandeer row: the bot runs **1.0.0** while the panel serves the **1.1.0** admin bundle
(the manifest's `adminUrl`). See decision 1 in §6.

## 4. Reconciliation with #95 (the chain step)

#95's closing comment left these open. Disposition for this epic:

| #95 residual | Disposition |
|---|---|
| #107 WoW extraction | **Done** (closed 2026-09-06, deployed). Nothing to fold. |
| Deferred live E2E: a plugin update's **success path** (needed "a newer published version than installed" + real Chrome) | **Fold into #125** as a step: warbandeer `1.0.0 → 1.1.0` is exactly that case now, and running it through the panel's *Update now* also proves the #105 panel producer live and aligns the installed version with the served admin bundle (§6 decision 1). |
| In-Discord `/link` → token → `/unlink` confirmation | Human step, unrelated to this epic — stays on #106's record. |
| `prod` rollout (#9 *Stand up prod*, #11 *Access for prod's panel*) | Out of scope here; both issues stay open on their own. |
| Parked design items (stop/dispose hook, host-owned HTTP router, `customId` routing, watcher plugin, manifest signing) | Untouched; not admin-UI work. |
| Third-party isolation (iframe + `postMessage`) | Already listed as this epic's own out-of-scope "designed-for, not built". Stays so. |

## 5. Remaining work — build order

Nothing here is a large change; the point is to finish what "done" means rather than to build more.

```
R0 housekeeping ─► R1 #125 finish (redeploy admin, live checks) ─► R2 warbandeer 1.1.0 via panel
                                                                 └► R3 Dockerfile ratchet ─► R4 docs/ADR ─► R5 close
```

1. **R0 — housekeeping (XS, no behaviour surface) — DONE 2026-09-08** (#124 closed with a
   merged-as summary; the #123 body gained Exit criterion / Issues (in order) / Working this epic /
   Done means, design sections untouched).
   - Close **#124** with a summary comment (merged as #127 + #128; it never auto-closed, same as the
     three plugins-repo children roshne closed by hand on 2026-09-07).
   - Reshape the **#123 body** into the standard epic shape: add `## Exit criterion` (§1 above),
     `## Issues (in order)` as a checkbox list (children 1–3 ticked, #125 plus the R3/R4 children
     below), `## Working this epic`, `## Done means`. Keep the existing design sections verbatim.

2. **R1 — finish #125 (S, escalation-gated: mutates the live instance).**
   - **Redeploy the admin from current `main`** with the scoped `admin`-only rebuild (the deploy
     runbook in the `admin-panel-deploy` memory). The deployed panel is 5 `ops/admin` commits behind;
     proving the epic on a stale image would not be proof of `main`. Confirm the bot container's
     `StartedAt` is unchanged afterwards (the "bot untouched" bullet).
   - **Port save through the tab** (roshne drives, Access-gated Chrome): change
     `WARBANDEER_INGEST_PORT` in the warbandeer tab, then paste the
     `[admin] env-set (changed: WARBANDEER_INGEST_PORT)` log line and the recreate evidence. Set it
     back afterwards (or pick a harmless value and leave it — say which).
   - **Version-skip**: no published plugin declares a mismatched `adminApiVersion`, and publishing one
     just for this is a new npm version. Recommendation: **accept the unit + local render proof**
     (`server.test.ts` gate tests; the fixture-bundle render check recorded on #124) and record on
     #125 that the live variant was declined and why. If a live proof is wanted anyway, the cheapest
     honest route is to temporarily point `PLUGIN_INDEX_URL` at a hand-edited copy of `plugins.json`
     with `adminApiVersion: 2` on warbandeer, observe the note, then clear the override — say so on
     the issue if done.
   - **No-bundle case**: both live plugins now carry `adminUrl`, so there is no live plugin without a
     tab. Same disposition: unit-proven (`server.test.ts:2401`, "a plugin with no admin bundle omits
     adminUrl/adminApiVersion") + the #124 render check; declined live, in writing.
   - Paste every executed output on #125, then close it.

3. **R2 — update warbandeer 1.0.0 → 1.1.0 through the panel (XS, live mutation, folded from #95).**
   Click *Update now* on the warbandeer card (the #105 producer) → request file → bot consumes →
   exit 75 → respawn → `warbandeer@1.1.0 downloaded, integrity ok` → report-back DM. Paste the log
   sequence and the resulting `state.json` row (`installedVersion 1.1.0`, no `targetVersion`). This
   is the first live run of the **success** path (only the failure/revert path has been seen, on a
   seeded 404). It also removes the installed-vs-bundle version split on debug.

4. **R3 — Dockerfile COPY ↔ local-import ratchet (XS, test-only) — DONE 2026-09-08:**
   [#163](https://github.com/Rackbops/rackbops-discord-bot/issues/163) via PR #164 (squash
   `b966a90`), built by subordinate #2, mutation 1 reproduced by the orchestrator before merge.
   The #128 class ("a new `./x` import in `server.ts` that the Dockerfile doesn't COPY crash-loops
   the image, invisible to every test") has no guard today — `grep Dockerfile ops/admin/*.test.ts`
   finds nothing; the only defence is a Dockerfile comment. Add a test in `ops/admin/server.test.ts`
   that parses `server.ts`'s relative `from "./…"` specifiers and asserts each file appears on a
   `COPY` line in `ops/admin/Dockerfile`. *Mutation:* remove `admin-contract.ts` from the COPY line →
   red. Gate-exempt in practice (no behaviour surface), but it must actually bite.

4b. **R3b — the admin tab follows the installed version — DONE 2026-09-08:**
   [#165](https://github.com/Rackbops/rackbops-discord-bot/issues/165) via PR #167 (squash
   `ace5aec`), subordinate #1, two review rounds (round 1 caught a pre-existing #124 defect: both
   delivery routes collapsed an upstream 404 to 502, so the "no settings tab at this version" note
   could never fire live — fixed + pinned; round 2 SOUND ×2). Orchestrator reproduced three
   mutations before merge. R1's admin redeploy now proves it; R4 documents it.

5. **R4 — docs + ADR — DONE 2026-09-08:**
   [#166](https://github.com/Rackbops/rackbops-discord-bot/issues/166) via bot PR #171 (squash
   `eb22945`: ADR-0005, README "Plugin settings", ops/README routes, CONTEXT rows/glossary/gotchas)
   and plugins PR #25 (`adc8f05`, authoring-guide paragraph). Subordinate #2, single-audit lane; the
   audit caught two false claims (guard order Origin→auth, not auth→Origin; the `%`-reject is the
   proxy's mechanism only) — both fixed before merge; orchestrator re-verified the guard order.
   The bot repo's user-facing docs do not describe the feature: `README.md`, `ops/README.md` and
   ADR-0004 have **zero** mentions of the admin tab / `adminUrl`; `CONTEXT.md` has one line (`:63`).
   The plugins repo's authoring guide does cover it (README "Admin tab (optional)"). Deliver:
   - **`docs/adr/0005-plugins-ship-their-own-admin-ui.md`** — the four locked decisions and the
     "plugin owns presentation, panel keeps authority" rule, cross-linked from ADR-0004 (which governs
     the plugin boundary this extends).
   - **README** "Plugins" section: a plugin may ship an admin tab; how it is delivered (same-origin
     proxy from the allowlisted CDN, 512 KB cap); what the tab can and cannot do.
   - **CONTEXT.md**: file-map rows for `ops/admin/admin-contract.ts` and the two delivery routes;
     gotchas for (a) the Dockerfile COPY sync (pointing at the R3 ratchet), (b) the **bundle version
     follows the index, not the installed pin** (decision 1 below), (c) the `%`-encoded traversal rule.
   - Every claim verified against source while writing, then one independent claims-vs-code audit.

6. **R5 — close the epic.** Tick every child; post the closing comment with the §7 evidence table.

Sequencing: R0 now; R1 → R2 in one nucbox session (R2 needs the freshly deployed panel); R3 and R4
are independent of the live work and can land in parallel as two small PRs. R1/R2 are roshne's to
drive (live mutation + the Access-gated browser); R3/R4 are well-scoped for a Sonnet-class subagent
once their issues exist.

## 6. Cross-cutting decisions to lock

| # | Decision | Recommendation | Where |
|---|---|---|---|
| 1 | **Which version of the admin bundle does the panel serve?** Today: the manifest entry's `adminUrl`, i.e. the index's *current* version (`server.ts:746`, `:781`), while `meta.version` reports the *installed* version (`index.html:595`). On debug that is a 1.1.0 tab over a 1.0.0 plugin. Harmless now (the 1.1.0 tab only touches a key 1.0.0 also declares), but a future bundle could edit keys the pinned plugin does not read yet. | **Keep for v1, document it** (R4 gotcha + a sentence in the plugins authoring guide: "your admin bundle may be mounted over an older installed version; only rely on keys every supported version declares"). Resolving the URL at the installed version instead would 404 for any plugin whose pinned version predates its first admin bundle (warbandeer 1.0.0 has none) — a worse default. File a follow-up if a real multi-version plugin ever needs the strict form. | R4 |
| 2 | Live proof of version-skip and no-bundle vs fixture proof | Accept fixture + unit proof, declined-live in writing (§5 R1). | #125 |
| 3 | The `debug` **bot** image is also behind `main` (`00ee725` vs `33644e9`; #153/#156/#158/#159 are bot fixes) | Out of this epic's scope; R2 restarts the bot but does not rebuild it. Note it on #125 so nobody reads the R1 admin rebuild as a full redeploy. | note only |
| 4 | Cross-repo drift pin for `ADMIN_API_VERSION` | Stays **declined** (recorded on #124's gate; the header of `admin-contract.ts` carries the reasoning). Not reopened here. | — |

### 6.1 Decision 1 in full — which version of a plugin does the panel "see"?

**What is pinned and what is not.** The only thing the bot pins is the plugin's *code*:
`installedVersion` in `state.json` decides which `dist/plugin.js` is downloaded and loaded
(ADR-0004 D5). Every other layer already keys off the **Plugin Index's current entry**, not the pin
(all verified on `main`):

| Layer | Reads | Anchor |
|---|---|---|
| Bot: which env keys the running plugin is handed | `entry.env` of the index entry at boot | `src/plugins/host.ts:56-57` |
| Bot: `configured` / `missingEnv` | `entry.env` (`required`) | `host.ts:211` |
| `bot-ops.sh env-get` / `env-set` allow-list + `format` validation | `.index.plugins` of the cached index | `ops/bot-ops.sh:297-328` |
| Panel: `getEnv` scope (`envKeys`) | `entry.env` | `ops/admin/server.ts:743` |
| Panel: admin bundle URL | `entry.adminUrl` (= `…@<entry.version>/dist/admin.js`) | `server.ts:781` |
| Panel: `proxyFetch` data assets | `…@${entry.version}/` | `server.ts:810` |
| Panel: `meta.version` handed to the bundle | `installedVersion` | `index.html:595` |

So the admin bundle is **consistent with the rest of the system**: the manifest describes "the
plugin as currently published", the pin only says which code runs. The epic's design (#123 decision
1) derived `adminUrl` from `package@version` exactly like the release `url`, which makes this the
natural outcome rather than an oversight — but nobody wrote the consequence down.

**What can actually go wrong (concrete, not hypothetical).** Let warbandeer `1.2.0` add a key
`WARBANDEER_FOO` and expose it in its tab; an instance is pinned at `1.1.0`.

1. *Phantom setting.* The panel serves the 1.2.0 tab, the operator fills `WARBANDEER_FOO`,
   `env-set` accepts it (the cached index declares it), the bot recreates, and the running 1.1.0
   code never reads it. The operator believes a feature is configured. Nothing breaks; nothing
   happens until they update. **The generic Config section has the same behaviour today** — a
   1.2.0 key would appear there too — so this is not introduced by the admin tab.
2. *Vanished setting.* 1.2.0 *removes* a key the pinned 1.1.0 still reads: the tab stops showing
   it, `env-get` stops listing it, but the value is still in `.env` and still in effect. Invisible
   in the panel; still editable by hand.
3. *Status text lies by omission.* The bundle prints `meta.version` (installed, `1.1.0`) while its
   own fields are 1.2.0's. Neither current bundle prints its own build version (warbandeer
   `statusLine` at `plugins/warbandeer/src/admin/index.ts:27`, wow at `:67`), so an operator has no
   way to notice the split from the tab itself.
4. *Adversarial:* none new. `setEnv` is still scoped to declared keys, the server still validates,
   the bundle is still fetched from the allowlisted host at a size cap. A newer bundle cannot do
   anything a newer *Config section* couldn't.

**Cases that are fine.** Today's live case (a 1.1.0 tab over 1.0.0, same single key) is scenario 1
with an empty diff. Update flow: the operator sees the new tab *before* choosing to update; slightly
odd, arguably useful (a preview of what the update configures).

**Options.**

| | Option | Cost | Failure it introduces |
|---|---|---|---|
| A | **Keep: bundle follows the index; document it** (README + CONTEXT gotcha + a sentence in the plugins authoring guide: "your admin bundle can be mounted over an older installed version — only depend on keys every supported version declares, and print your own build version next to `meta.version`"). | Docs only (R4). Optionally a plugin-side convention, no contract change. | Scenarios 1–3 remain, documented. Same class as the generic Config section. |
| B | **Resolve at the installed version**: the panel rewrites the version segment of `adminUrl` (and the proxy prefix) to `installedVersion` when one exists. | Small server change + tests; a proper behaviour change → full gate. | (i) A pin that predates the plugin's first admin bundle 404s — warbandeer 1.0.0 has none, so today's debug tab would *disappear* until R2 updates it. (ii) The index carries `adminApiVersion` for the **current** version only, so the panel can't version-gate an older bundle correctly; doing it right needs per-release `adminApiVersion` in the manifest — a compatible-but-real contract extension (`PluginRelease` gains a field, `generate-index` must know each past release's value it no longer has). (iii) `getEnv`/`env-set` still follow the index, so the tab and the validator would now disagree instead of agreeing. B fixes the visible half and leaves the invisible half. |
| C | **Make the whole system follow the pin**: cache each installed version's manifest entry in `state.json` and have host/bot-ops/panel read that. | Touches the bot boot path, `state.json` shape (a live data-path change → escalation), `bot-ops.sh`, and the panel. Effectively a new epic. | The right long-term shape if plugins ever have long-lived pins with divergent env; overkill while every instance tracks `latest` within days. |

**DECIDED (roshne, 2026-09-08): B — the admin tab follows the installed version.** "Everything is
brand new and all the plugins are first-party: if we need to pin versions, do it; if we need
version-based dependency, implement it." Resolution of B's three costs: (i) a pinned version with no
admin bundle renders an honest "v<installed> has no settings tab; v<latest> does" note (a preflight
fetch distinguishes the 404) — on debug that is warbandeer 1.0.0 until R2 updates it, which is a
live proof of the case, not a regression; (ii) the version gate for a pinned bundle is the **module's
own `adminApiVersion` export**, checked before `mountAdmin` — no per-release manifest metadata
needed; the manifest gate stays only for the installed==latest case; (iii) `getEnv` scope and
`env-set` validation keep following the index — documented as a deliberate limit in CONTEXT, not
built (that would be C). The client passes `?v=<installedVersion>` (from `/api/plugins`) to the
bundle and proxy routes; the server accepts only a strict semver and re-asserts the package prefix.
No `AdminApi`/contract/manifest change. Filed as a child (see §5 R3b) and handed to subordinate #1.

## 7. Mutation guards (already landed, to be re-cited when closing)

| Property | Guard | Mutation that must fail |
|---|---|---|
| `setEnv` scoped to the plugin's declared keys | `index.html` `buildSetEnvBody` lift tests | drop the filter → red |
| version-skip: mismatch is not mounted | `server.test.ts` "resolveAdminBundleUrl … version gate" + client mismatch test | serve/mount anyway → red |
| bundle only from the allowlisted https host | `resolveAdminBundleUrl` tests | drop the host check → red |
| size cap enforced at the I/O edge | `makeAdminAssetFetcher` tests | drop the cap → red |
| proxy rejects `..`, absolute, `%`-encoded, off-package paths | `resolvePluginProxyUrl` tests incl. the `%2e%2e` pin | drop the sanitizer → red |
| no-bundle plugin has no `adminUrl` in the view | `server.test.ts:2401` | emit always → red |
| (new, R3) every `server.ts` local import is COPYed | the Dockerfile ratchet | remove a COPY entry → red |

## 8. Exit demo

The epic closes when #125's acceptance is **executed with output pasted**, on the panel rebuilt from
current `main`:

1. Warbandeer tab renders; the bundle is fetched from `/plugin-admin/warbandeer.js` (same-origin,
   network tab or server log).
2. A port edit in the tab produces the `[admin] env-set (changed: WARBANDEER_INGEST_PORT)` line and a
   recreate.
3. Version-skip and no-bundle: unit + fixture proof cited, live variant declined in writing (or run
   via the index-override route if chosen).
4. Bot container untouched by the admin rebuild.
5. (R2) warbandeer updated to 1.1.0 through the panel; success-path logs pasted.

## 9. Escalations and open decisions for roshne

1. ~~§6 decision 1~~ — **decided 2026-09-08: the tab follows the installed version** (#165).
2. **§5 R1** — accept fixture proof for version-skip / no-bundle, or run the temporary
   `PLUGIN_INDEX_URL` override to see the note live. Note that #165 gives one of these a live form
   for free: after its deploy, warbandeer 1.0.0 shows the "no settings tab in this version" note
   until R2 updates it.
3. **R1/R2 are live mutations on `debug`** (env-set + recreate; a plugin update restart). Both need
   your go and your browser; I can drive the SSH side and read the logs.
4. **R0's epic-body reshape** edits an issue you authored — a prose-only change, but say if you'd
   rather leave the original body as filed and put the checklist in a comment instead.
5. ~~File R4~~ — **done 2026-09-08**: #163 merged (R3), #165 filed (R3b, subordinate #1), #166
   filed (R4, subordinate #2, blocked on #165).

---

*Once the decisions are settled: R0, then R1/R2 together on nucbox, R3/R4 as two small PRs, then
close. This doc is the plan of record for E123; update it if the sequence changes.*
