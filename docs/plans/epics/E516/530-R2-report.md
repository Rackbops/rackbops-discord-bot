<!-- Plan for sub-epic #530 of Epic #516 (Rackbops/rackbops-discord-bot), bundle R2: /report's modal path. Written by
the orchestrating session on 2026-10-16 against `main` @ `bde64e2` and audited read-only against it (11 findings, all
applied: the fallback-edit test records every edit, the existing tests get the role they now need, the 422 claim is
softened). `index.ts`'s dispatcher lines moved to `:271-272` at `cc7fd02`; `report.ts`, `github.ts` and their tests are
unchanged between the two. Every other file:line below was read from `bde64e2`; the implementer re-reads each one on the
tree it works from and corrects any that moved. -->

## Implementation plan -- #530 bundle R2: `/report` files once, tells the truth about it, and re-checks the role on submit

Children: **#445**, **#447**, **#448**, plus the `/report` halves of two Low groups the epic marks "fix once"
with #445: **#503 item 7** (`commands-report-interaction-7`, same root cause as the closed #500's item 9:
`ensureLabel` is documented best-effort but a network failure aborts the report) and **#503 item 11**
(handled command failures are never logged — the `/report` catch only; the `/update` and `/plugins`
catches are #503's own). One PR. Behaviour changes in a user-facing command, so the **three-reviewer
gate** applies; every changed line mutation-tested in a scratch worktree. Independent of every bundle in
flight: R1 edits `index.ts`'s interaction handler and `commands.ts:347`, not `report.ts`; nothing else
touches `report.ts` or `github.ts`'s issue helpers. Branch from `origin/main` now.

### What is wrong, verified at `bde64e2`

- **One `try` for three calls** (#445). `handleReportModal` (`src/report.ts:126-152`) wraps `ensureLabel`
  (`:139`), `createIssue` (`:141`) and the success `editReply` (`:142-145`) in one `try`; the catch
  (`:146-151`) edits the public reply to "Couldn't file the issue: …" for any throw. When GitHub has created
  the issue and the announcement edit then rejects (a Discord 5xx, a rate limit, a content refusal), the
  channel is told filing failed; the reporter retries and files a duplicate. `reportAnnouncement` (`:31-43`)
  cuts the description with a plain `slice` (`:42`), which can split a surrogate pair at the boundary;
  `github.ts:133-137` has `sliceUtf16` for exactly this, unexported, used only by `clampReply` (`:157-159`).
- **`ensureLabel` is not best-effort** (#503 item 7). `github.ts:206-217`: its docstring says "Best-effort;
  other errors warn", but only a non-OK status warns; a fetch rejection or the 10 s `AbortSignal.timeout`
  propagates through the unguarded `await` at `report.ts:139` into the catch, and the user sees "Couldn't
  file the issue" although `createIssue` would likely have succeeded. `CONTEXT.md:1030-1031` ("never fails on
  a missing `automated` label") is literally true; the docstring is not.
- **The modal submit path has no gate** (#448). `index.ts:261-262` routes any modal whose `customId` starts
  with `report:` straight to `handleReportModal`, which checks neither the role nor the configuration before
  `deferReply`, `createIssue` with the bot's token, and the public edit. `report.ts:117-121` justifies that
  with "Discord scopes a modal submission to the interaction that showed it"; `CONTEXT.md:1024-1025` says "a
  forged `modal_submit` interaction can carry any `customId`". At least one is a false behaviour claim, and
  whether a roleless account can forge the submit is unproven (it needs a live Discord test). The gate that
  exists, `hasReportRole` (`:48-55`), is reached only from `handleReportCommand` (`:73`).
- **The role gate and the public outcome have no failing test** (#447). `report.test.ts:24-40` calls
  `handleReportCommand` only with `reportRoleId` unset; `:98-161` cover the failure paths and the unknown
  project. Inverting `hasReportRole`, dropping its `Array.isArray` branch, adding an `Ephemeral` flag to
  `deferReply` (the fake at `:74` ignores its arguments) or removing `allowedMentions` from the success edit
  all leave the suite green.
- **A handled `/report` failure is silent in the log** (#503 item 11, the `/report` half): the catch at
  `:146-151` replies and swallows; a revoked `GITHUB_TOKEN` shows only `outcome=answered` in the interaction
  line (`interactionLog.ts`).

### Decisions (defaults, named so the gate can contest them)

1. **Three steps, three outcomes.** `ensureLabel` first and best-effort for real (it returns whether the
   label exists, never throws); then `createIssue` in its own `try` — a failure there is the only thing
   that says "Couldn't file the issue"; then the announcement edit in its own `try` — a failure there logs
   and falls back to a minimal public edit naming the issue (`📋 **<user>** filed **<repo>#<n>** — <url>`),
   and if that edit fails too it is logged at error level and nothing else is attempted (the interaction's
   deferred reply expires; the issue exists; the log says so). The issue is filed WITHOUT the label when
   `ensureLabel` could not confirm it (labels: `[]`), so a label the API cannot create or check never costs
   the report; the log names it. The trade-off, stated: in steady state the label POST answers 422 every
   time (the label exists; with a constant name and colour that is the only 422 this call can get, which is
   why 422 reads as "already there" — GitHub documents 422 only as "validation failed", and a duplicate
   shows up as `errors[0].code === "already_exists"`), so a blip on that one call files an issue unlabelled
   that would otherwise have been labelled. What GitHub's create-issue does with a label name that does not
   exist (auto-create for a pusher, most likely) is not relied on.
2. **The modal submit re-checks configuration and role, as defence in depth** (#448), before
   `deferReply` and before any network call: `!config.reportRoleId || !config.githubToken` → the same
   ephemeral "isn't configured" refusal the command gives (naming `/<prefix>report` via `prefixedName`,
   since a submit carries no `commandName`); `!hasReportRole(interaction)` → the same ephemeral role
   refusal. `hasReportRole` is widened to any interaction with a `member` (a `ModalSubmitInteraction` has
   one in a guild; in a DM it is null, which is a refusal). The `:117-121` paragraph is rewritten: the
   command's gate is the user-facing one; the submit's gate exists because the code cannot verify Discord's
   scoping and `CONTEXT.md` already says a forged submit can carry any `customId`; whether a forgery is
   possible is left unverified and no longer matters. The accepted race (a role revoked between showing
   and submitting) is now closed too; say so.
3. **Every refusal and failure on the modal path writes one `[report]` log line** (#503 item 11's
   `/report` half): the role or config refusal (with the user id and project — the project only AFTER
   `repoForProject` has accepted it, see below), the `createIssue` failure (the clamped error message), the
   announcement-edit failure, the fallback-edit failure, and `ensureLabel`'s shortfall. The one refusal
   that is NOT logged is the unknown-project one (`:129-132`): its string is attacker-controlled before the
   `repoForProject` fence, and a log line built from it would be log injection; the gate below sits after
   that fence, so the project it logs is a known key. The description, title and username never reach the
   log.
4. **`sliceUtf16` is exported from `github.ts` and used by `reportAnnouncement`** so a truncated
   description cannot end in a lone surrogate (Discord's handling of one is unconfirmed; a correct cut
   costs nothing).
5. **Out of scope, named:** the `/update` and `/plugins` catches (#503 items 2, 3, 10, 11's other half);
   `/report`'s DM fallback when the interaction token has expired (the GitHub calls are bounded at 10 s
   each, well inside the 15-minute token window, so no such path is needed here).

### Step 1 -- `src/github.ts`

- Export `sliceUtf16` (`:133`), docstring: a UTF-16 slice that never ends in a high surrogate.
- `ensureLabel` (`:206-217`) returns `Promise<boolean>` and never throws:

  ```ts
  /** Idempotently ensure a label exists: `true` when it does afterwards (201 created; 422, which with a constant
   *  name and colour is GitHub's "already exists" answer here), `false` when it could not be confirmed (another
   *  status, a network error, the timeout) — logged, never thrown, so a caller can file without the label rather
   *  than fail the report over it (#445, #503). `true` without a token too: create-issue cannot run without one
   *  either, and the caller refuses earlier. */
  export async function ensureLabel(repo: string, name: string, timeoutMs = GITHUB_TIMEOUT_MS): Promise<boolean> {
    if (!config.githubToken) return true;
    try {
      const res = await fetch(…unchanged…);
      if (res.ok || res.status === 422) return true;
      console.warn(`ensureLabel "${name}" on ${repo}: ${res.status}`);
      return false;
    } catch (err) {
      console.warn(`ensureLabel "${name}" on ${repo}: ${(err as Error).message}`);
      return false;
    }
  }
  ```

  Grep `ensureLabel(` under `src/` for other callers (expected: `report.ts` only). Its existing tests are in
  `src/fetchTimeouts.test.ts` (`:93-101` checks only that a timeout settles, with a comment that it "warns
  rather than throwing"; `:179` its bound) — not in `github.test.ts`, which does not import it; extend per
  step 4.

### Step 2 -- `src/report.ts`

- `reportAnnouncement` (`:42`): `sliceUtf16(o.description, Math.max(0, room - TRUNCATED.length))`; import it.
- `hasReportRole` (`:45-55`): parameter type `{ member: ChatInputCommandInteraction["member"] | ModalSubmitInteraction["member"] }`
  (both are `GuildMember | APIInteractionGuildMember | null`); body unchanged. Docstring: reached from the
  command and, since #448, from the submit.
- `handleReportModal` (`:105-152`):

  ```ts
  export async function handleReportModal(interaction: ModalSubmitInteraction): Promise<void> {
    const project = interaction.customId.slice(MODAL_PREFIX.length);
    const repo = repoForProject(project);
    if (!repo) { …unchanged… }
    // #448: the same gate as the command, as defence in depth — this code cannot verify that Discord scopes a
    // submit to the interaction that showed it, and CONTEXT.md already says a forged modal_submit can carry any
    // customId. Before deferReply and before any network call; ephemeral, like the command's refusals.
    const command = prefixedName(config.commandPrefix, "report");
    if (!config.reportRoleId || !config.githubToken) {
      console.warn(`[report] refused a modal submit for ${project} from ${interaction.user.id}: not configured`);
      await interaction.reply({ content: `\`/${command}\` isn't configured — an admin must set \`REPORT_ROLE_ID\` and \`GITHUB_TOKEN\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!hasReportRole(interaction)) {
      console.warn(`[report] refused a modal submit for ${project} from ${interaction.user.id}: no report role`);
      await interaction.reply({ content: "You don't have the role required to file reports.", flags: MessageFlags.Ephemeral });
      return;
    }
    const title = interaction.fields.getTextInputValue("title");
    const description = interaction.fields.getTextInputValue("description");
    const username = interaction.user.username;
    await interaction.deferReply();
    // Step 1 of 3 (#445, #503): the label is best-effort; without it the issue is filed unlabelled.
    const labelled = await ensureLabel(repo, REPORT_LABEL);
    if (!labelled) console.warn(`[report] filing in ${repo} without the ${REPORT_LABEL} label (could not be confirmed)`);
    // Step 2: the issue. Only a failure HERE means the report was not filed.
    let issue: { number: number; url: string };
    try {
      const body = reportBody(description, username, command);
      issue = await createIssue(repo, title, body, labelled ? [REPORT_LABEL] : []);
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[report] could not file an issue in ${repo}: ${clampReply(message, 300)}`);
      await interaction.editReply({ content: clampReply(`⚠️ Couldn't file the issue: ${message}`), allowedMentions: { parse: [] } });
      return;
    }
    // Step 3: the announcement. The issue exists whatever happens here, so a failure must never say it does not.
    try {
      await interaction.editReply({
        content: reportAnnouncement({ repo, number: issue.number, url: issue.url, title, description, username }),
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.warn(`[report] filed ${repo}#${issue.number} but the announcement edit failed: ${(err as Error).message}`);
      await interaction
        .editReply({ content: clampReply(`📋 **${username}** filed **${repo}#${issue.number}** — ${issue.url}`), allowedMentions: { parse: [] } })
        .catch((again: unknown) => console.error(`[report] the fallback edit for ${repo}#${issue.number} failed too: ${(again as Error).message}`));
    }
  }
  ```

  Rewrite the docstring (`:105-125`): the three steps and their outcomes; the re-check and why; the log
  lines; `clampReply(message, 300)` for the log (the public reply keeps `clampReply`'s default).
- `handleReportCommand` is unchanged apart from `hasReportRole`'s wider type.

### Step 3 -- docs, in the same PR

- `CONTEXT.md`: the `/report` gotcha (`:1021-1032+`, grep `**`/report`**`): the submit path re-checks
  configuration and role (#448); the three-step filing and the fallback edit (#445); `ensureLabel` returns
  whether the label exists and never throws (#503-7), so "`/report` never fails on a missing `automated`
  label" now holds for a label the API cannot create either; the `[report]` log lines. The bullet after it
  (`:1034-1047`, "the filed-issue confirmation (and the failure that replaces it) lands in the channel …
  either outcome the edit can carry"): the fallback edit is a third public outcome, with the same
  `allowedMentions` and clamp. The `src/report.ts` row (`:173`): the same, briefly, and the new tests (there
  is no `report.test.ts` row; do not invent one). The `src/github.ts` row (grep `ensureLabel`): the boolean.
- `ops/README.md:905` and `:973` (at `cc7fd02`; `:888`/`:956` at `bde64e2`) cite `src/report.ts:66-72` for
  the not-configured refusal: re-point them by symbol (`handleReportCommand`'s not-configured refusal),
  since the docstring above grows and the lines move. `docs/plans/epics/E347/B-env-bridge-up.md:73` cites
  `report.ts:66` too; a plan is a dated record — leave it.
- `README.md:18`, `:242` and `:251` stay true (grep `/report`; the role gate wording covers the submit too).
  `.env.example:25-31` unchanged.

### Step 4 -- tests

`src/report.test.ts` — the gate changes what the EXISTING tests need: `test/setup.ts:71-76` sets no
`REPORT_ROLE_ID`, so `config.reportRoleId` is undefined (or ambient) at import, the first describe's
`afterEach` (`:16-21`) restores that undefined after every test, and the second describe's `afterEach`
(`:90-93`) restores neither the role nor the prefix; every test file shares one process and module registry,
so a leaked role reaches other files. So: a `beforeEach` in BOTH describes that sets `config.reportRoleId =
"role-1"` and `config.githubToken = "test-token"`, and both `afterEach` blocks restore `reportRoleId`,
`githubToken` and `commandPrefix` to the values captured at the top of the file. Extend the fakes:
`fakeModalSubmit` gains `member` (default: the literal `{ roles: ["role-1"] }`), `user.id`, a `deferReply`
that records its argument (`calls.deferArgs`), and records EVERY `editReply` in `calls.edits: unknown[]`
with a per-call `editOutcome` seam (resolve, or reject the n-th call) — `calls.edited` stays as the last
one for the existing assertions; add `fakeCommand({ member, commandName, project })` whose `reply`,
`showModal` (recording the builder's `toJSON()`; the real shape is `components[i].components[0]` with
`type: 4`, `custom_id`, `style`, `max_length` on the title only, `required: true`) and
`options.getString` are captured. The fake's default `title`/`description` become random markers
(`crypto.randomUUID()`), so a "never in the log" assertion can mean something.

| # | Test | Pins |
|---|---|---|
| T1 | `handleReportCommand`: "a member holding the role, as a raw string array, gets the modal; without it, the ephemeral role refusal" (#447) | `member: { roles: ["role-1"] }` → `showModal` called once, `reply` not; `member: { roles: ["other"] }` → `reply` with `You don't have the role` and `flags: Ephemeral`, no `showModal` |
| T2 | "a cached role manager is read the same way" | `member: { roles: { cache: new Map([["role-1", {}]]) } }` → modal; an empty map → refusal |
| T3 | "no member (a DM) is a refusal" | `member: null` → the role refusal |
| T4 | "the modal is report:<project> with the Title and Description fields" | `toJSON().custom_id === "report:wow"`; two rows; the first text input `custom_id: "title"`, `max_length: 120`, required; the second `custom_id: "description"`, paragraph style, required |
| T5 | `handleReportModal`: "the public outcome: a plain deferReply (no Ephemeral flag) and the success edit with allowedMentions parse []" (#447) | `calls.deferArgs` is `undefined` or has no `flags`; `calls.edited` equals `{ content: reportAnnouncement({...}), allowedMentions: { parse: [] } }` |
| T6 | "a submit without the role is refused before deferReply and before any fetch, ephemerally" (#448) | `member: { roles: [] }` → `calls.replied.content` contains `You don't have the role`, `flags: Ephemeral`; `calls.deferred === false`; `fetchCalled === false`; one `console.warn` containing `no report role`, the user id and `wow` |
| T7 | "a submit while the role is not configured is refused, naming the prefixed command" (#448) | `config.reportRoleId = undefined`, `config.commandPrefix = "pip"` → `calls.replied.content` contains `` `/pipreport` isn't configured `` and `flags: Ephemeral`; no defer, no fetch; one `console.warn` containing `not configured` |
| T7b | "a submit while the token is not configured is refused the same way" | role set, `config.githubToken = undefined` → the same refusal, no defer, no fetch |
| T8 | "the issue is created and the announcement edit then rejects: the channel is told it was filed, not that it failed" (#445) | the `/labels` POST answers 422 and the `/issues` POST 201 `{ number: 7, html_url: "https://github.com/nazumods/wow/issues/7" }` (the repo is `repoForProject("wow")`, `nazumods/wow`, `config.ts:45-48`); the fake's FIRST `editReply` rejects, the second resolves; `calls.edits` has length 2, the second's `content` is exactly `📋 **alice** filed **nazumods/wow#7** — https://github.com/nazumods/wow/issues/7` with `allowedMentions: { parse: [] }`; no edit's content contains `Couldn't file`; one `console.warn` containing `announcement edit failed`; exactly one `/issues` POST |
| T9 | "both edits rejecting is logged at error level and does not throw" | both `editReply` calls reject → resolves; `calls.edits` has length 2; `console.error` once containing `fallback edit` |
| T10 | "a create-issue failure still says Couldn't file, and is now logged" (#503-11) — the existing `:98-130` tests (their fetch stubs fail the `/labels` POST too, so `ensureLabel`'s own warn and the `without the … label` warn fire as well) gain: exactly one `console.warn` call whose first argument contains `could not file an issue` | the existing assertions unchanged |
| T11 | "ensureLabel failing on the network files the issue without the label" (#503-7) | the labels POST rejects (`TypeError: fetch failed`) and the issues POST answers 201 → the issues body's `labels` is `[]`; the announcement edit happens; `console.warn` contains `without the automated label` |
| T12 | "ensureLabel 201 or 422 files with the label" | `labels: ["automated"]` in the issues body for both statuses |
| T13 | "the description is cut without splitting a surrogate pair" (`reportAnnouncement`) | a description whose cut point falls inside an emoji → the output has no lone high surrogate (`/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/` finds nothing) and ends with `TRUNCATED`; length ≤ 2000 |
| T14 | "the log never carries the report's text" | in T6, T8, T10 and T11 (with the random-marker title/description and a random username), no `warn`/`error` argument contains the title, the description or the username |

`src/fetchTimeouts.test.ts` (where `ensureLabel`'s tests live, `:93-101` and `:179`): tighten `:93-101` to
assert `{ ok: true, v: false }` (it settles AND reports the label unconfirmed), and add beside it: "201 and
422 are true; another status is false with a warn; a rejected fetch is false with a warn and never throws;
no token is true with no fetch" — with the `console` spies restored in an `afterEach` (the process is
shared).

### Coverage table

| Outcome (bullet) | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| #445: an announcement-edit failure never says the issue was not filed | 2 | T8 | M1: put the announcement edit back inside the `createIssue` `try` (T8: an edit contains `Couldn't file`) |
| #445: the fallback edit names the issue | 2 | T8 | M2: drop the fallback edit (T8: `calls.edits` has length 1, so the exact second-content assertion fails) |
| #445: a double failure is logged, not thrown | 2 | T9 | M3: drop the fallback's `.catch` |
| #445: the description cut is surrogate-safe | 2 | T13 | M4: `slice` instead of `sliceUtf16` |
| #448: a submit without the role is refused before any effect | 2 | T6 | M5: delete the role check (T6: defer and fetch happen); M6: move it after `deferReply` (T6: `deferred` true) |
| #448: a submit while not configured is refused, either half | 2 | T7, T7b | M7: delete the config check (T7, T7b); M7b: drop `|| !config.githubToken` (T7b); M7c: drop the config refusal's `flags` (T7) |
| #447: the role gate reads both member shapes, and no member refuses | 2 | T1, T2, T3 | M8: drop the `Array.isArray` branch (T1); M9: invert `hasReportRole` (T1-T3) |
| #447: the modal's shape | 2 | T4 | M10: `setMaxLength(1200)` |
| #447: the public outcome | 2 | T5 | M11: `deferReply({ flags: MessageFlags.Ephemeral })` (T5); M12: drop `allowedMentions` from the success edit (T5) |
| #503-7: `ensureLabel` never throws and the issue is filed without the label | 1, 2 | T11, T12, the `fetchTimeouts.test.ts` tests | M13: remove `ensureLabel`'s `try`/`catch` (T11 and the fetchTimeouts test); M14: always pass `[REPORT_LABEL]` (T11's `labels: []`) |
| #503-11: every refusal and failure logs a `[report]` line | 2 | T6, T7, T8, T10, T11 | M15: delete the `createIssue` catch's `console.warn` (T10); M15b: delete the role refusal's `console.warn` (T6); M15c: delete the config refusal's (T7) |
| the log never carries the report's text | 2 | T14 | M16: log the title in the create-issue warn |
| the docs say what the code does | 3 | manual: reviewer B reads the gotcha and the rows against the code | -- |

Run every mutation in a scratch copy (`git worktree add --detach <path> <sha>`), never in the tree the tests
or a reviewer are reading. Paste the red test's name per row in the PR.

### Checks, gate, PR

- `bun run check`; `bunx tsc --noEmit -p ops/tsconfig.json`; `bun run check` inside `ops/admin/`;
  `bun test` from the root, then `bun test --randomize` once. CI's Linux run is the evidence for the
  `ops/*` suites that skip here.
- Gate: reviewer A on correctness (every combination of config/role/member shape on both paths; the
  three-step outcomes with each call failing; a submit from a DM; `prefixedName` with an empty prefix;
  `clampReply(message, 300)`'s signature — read `github.ts:157`; the `labels: []` POST against GitHub's
  API shape); reviewer B on claims-vs-code (the coverage table, the rewritten docstrings, the `CONTEXT.md`
  gotcha, and whether any remaining sentence still claims Discord scopes a submit). Both read-only, both
  handed the merged tree, #445, #447, #448 and #503.
- Branch `fix/530-R2-report`; title
  `fix(report): file once and say so, re-check the role on submit, and log what /report refuses or fails (#445, #447, #448)`.
  Body: `Closes #445`, `Closes #447`, `Closes #448`, `Part of #503 (items 7 and the /report half of 11 land
  here; the rest stays)`, `Part of #530`; the pasted checks; the mutation rows; the gate's rounds; decisions
  1-5 as assumptions taken (decision 2 — the re-check closes a question the issue said needed a live
  Discord test — in its own paragraph; decision 1's label trade-off in another). After the merge, comment
  on #503 naming the PR and the two items, and on the closed #500 that its item 9 (the same `ensureLabel`
  root cause, `github.ts:208` had no catch) is closed by this PR per #530's "fix once" rule. Do not merge.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot. Work in a NEW worktree, never the shared checkout:
  git -C S:\Repos\rackbops-discord-bot fetch origin && git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-530-R2 origin/main -b fix/530-R2-report
Issues: Rackbops/rackbops-discord-bot #445 #447 #448 and #503 items 7 and 11 (sub-epic #530 of Epic #516). Read their bodies and comments first.
Plan: docs/plans/epics/E516/530-R2-report.md — read it from main once the plans PR has merged, else from the plans branch:
  git -C S:\Repos\rackbops-discord-bot show origin/main:docs/plans/epics/E516/530-R2-report.md || git -C S:\Repos\rackbops-discord-bot show origin/claude/530-R2-plans:docs/plans/epics/E516/530-R2-report.md
Behaviour changes in a user-facing command: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Every mutation in a scratch worktree. Scratch files: task-unique names (pr-body-530R2.md, commit-msg-530R2.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds and any deviation. Do not merge.
```
