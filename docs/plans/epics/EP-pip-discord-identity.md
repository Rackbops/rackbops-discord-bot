# EP-Pip - Pip Discord identity and result DMs - implementation plan

Status: **PLANNED - implementation and operator changes not started (2026-10-06).**
Requested by Rod: give Pip its own identity on his Discord servers so it can DM him result
notifications. This document is the handoff for a future implementation session. No issue numbers
are assigned; the child IDs below are plan-local labels, not created GitHub issues.

Planning base: `rackbops-discord-bot` main at `8d039c91772a8ee4434e82890a3dbeb055e8d8d6`.
Re-check current source, deployments and operator decisions before executing. Do not interpret
approval to write this plan as permission to create applications, provision secrets, install bots,
change grants, pair clients, deploy, send a test message, or enable recurring notifications.

## 1. Objective and exit criterion

Deploy a distinct, owner-controlled **Pip** Discord application/bot, using a separate instance of
the existing Rackbops host and its MCP bridge plugin. Rod receives an explicitly authorized result
DM whose visible sender is Pip's own bot account and avatar. The initial installation is private
and limited to one owner-selected server and one recipient, Rod.

MVP delivery is **Melody-dependent**: hosted Pip delegates an authorized result to a connected
Melody task; that task launches the existing local Codex client through supported shell/approval
controls; a configured Pip integration invokes MCP; the Pip bridge delivers the DM. This is a
bounded delivery route, not a claim that hosted Pip acquires Melody's tool catalog.

The epic exits only when the identity, permissions, notification policy, failure handling and
rollback checks in section 7 have been executed with recorded, redacted evidence. A healthy
container, successful `whoami`, or app creation alone does not meet the exit criterion.

### Non-goals

- Rename, replace, share tokens with, or remove prod, debug, or Clerk; alter their registrations.
- Public app distribution, extra servers/recipients, channel posting, conversational DM handling,
  message-content ingestion, or an autonomous Discord persona.
- A new generic DM API, MCP tool group, or per-message sender override.
- Copying existing credentials, revealing tokens, broad `dm:registered` grants, or pairing every
  available client. An MCP agent label is not a substitute for a Discord bot account.
- Native hosted ChatGPT connector proof or automatic propagation of local MCP tools to the cloud.
- Background execution independent of Melody. An always-on bot does not create a source of future
  hosted Pip results. The optional later track in section 9 needs its own design and approval.

## 2. Verified architecture and evidence limits

| Property | Evidence / implication |
|---|---|
| Visible sender is the logged-in bot | [`src/plugins/delivery.ts`](../../../src/plugins/delivery.ts) uses `client.users.fetch` and `user.send`; [`src/index.ts`](../../../src/index.ts) wires that client into `HostApi.dm` and logs in with the instance's `DISCORD_TOKEN`. A genuinely separate identity needs a separate Discord application/token and instance. |
| Existing host supports separate instances | [`ops/install.sh`](../../../ops/install.sh) accepts an instance name, separates operator configuration and stack artifacts, and does not perform initial startup. [`ops/README.md`](../../../ops/README.md#a-rackbops-clerk-instance-the-task-tracker) documents Clerk as a distinct application/instance. |
| MCP plugin already supports DMs | [plugin README, pinned source](https://github.com/Rackbops/rackbops-bot-plugins/blob/51a4b46ca82746fd2191777cabc277b73a5b03a2/plugins/mcp/README.md); `drain.ts` checks recipient registration before `host.dm`. Closed DMs map to `RECIPIENT_UNREACHABLE`. |
| Multiple bot bridges are implemented | [MCP config](https://github.com/Rackbops/discord-mcp/blob/315d47096d0473b35e360a2128cf1fe57eaeb7c7/src/service/config.ts): `MULTI_BRIDGE_ROUTING_READY = true`; schema permits at most four additional bridges. [Delivery](https://github.com/Rackbops/discord-mcp/blob/315d47096d0473b35e360a2128cf1fe57eaeb7c7/src/service/delivery.ts) resolves the principal's own bridge and fails closed on a missing bridge. |
| Principal is distinct from bot identity | The existing verified caller is Rod's user principal pinned to `prod`. `whoami` exposes caller identity/grants/capabilities, not the sending bot's application ID/name. A newly paired Pip-bridge user is still Rod, with a bridge-qualified principal such as `u-<owner-user-id>@pip`. |
| Registration and revocation are per bot | [MCP client guide](https://github.com/Rackbops/discord-mcp/blob/315d47096d0473b35e360a2128cf1fe57eaeb7c7/docs/clients.md): pairing and generations belong to the selected bridge; unregistering there must not revoke another bridge's credentials. |
| Least-privilege recipient scope exists | [grant policy](https://github.com/Rackbops/discord-mcp/blob/315d47096d0473b35e360a2128cf1fe57eaeb7c7/src/service/policy.ts) allows `dm:self` only when recipient ID equals the paired user's ID. `defaultUserGrants` permits only `dm:self`; do not add post grants for this MVP. |
| Local execution route is proven, with limits | [MCP issue #72](https://github.com/Rackbops/discord-mcp/issues/72), [merged guide / PR #77](https://github.com/Rackbops/discord-mcp/pull/77): fresh noninteractive Codex 0.160.0/0.160.1 HTTP-OAuth calls, and 0.160.1 shim calls, completed read-only `whoami`. A delegated Melody task also launched fresh 0.160.1 children through standard approval review and completed both checks. This is not proof of notification delivery, interactive tool calls, or native hosted connector access. |
| Tool discovery needs normalized names | Proven names are `tools.mcp__discord_mcp__whoami` and `tools.mcp__discord_shim__whoami`, reached through `functions.exec`. Discover `ALL_TOOLS` using normalized names; check callability. A prior empty child discovery was a false negative; its precise cause remains unknown. |
| Minimal plugin does not remove host core | [`src/config.ts`](../../../src/config.ts) still requires `ANNOUNCE_CHANNEL_ID`; empty `WATCHED_REPOS` falls back to `GITHUB_REPO`. [`ops/README.md`](../../../ops/README.md) records core admin/update commands beside plugin commands. `PLUGINS=mcp` alone does not mean only result notifications can occur. |
| No additional gateway intents for MCP | [`src/client.ts`](../../../src/client.ts) defaults to `Guilds`; the [MCP plugin manifest](https://github.com/Rackbops/rackbops-bot-plugins/blob/51a4b46ca82746fd2191777cabc277b73a5b03a2/plugins/mcp/package.json) declares `intents: []`. Check the selected published plugin version before deployment. |

No change to the delivery architecture is expected. A narrowly scoped host change may be needed
if the core-behavior review finds no supported way to meet Rod's notification-only policy. Do not
silently broaden the epic into a host refactor or weaken permissions to avoid that decision.

## 3. Owner/operator decisions and gates

| Gate | Required decision / authorization | Owner |
|---|---|---|
| G1 - identity | Private application named Pip, application ownership, initial server, recipient, and visible identity distinct from prod/debug/Clerk. Avatar asset is pending separate design-standard research and Rod's review; no style/colors or completed asset are assumed here. | Rod |
| G2 - Discord install | Current official Discord app visibility/install rules, `bot` + `applications.commands` scopes, least guild permissions, and no privileged intents unless a separately justified need is approved. Guild-admin install and DM privacy settings are owner actions. Record official sources/date. | Rod / operator |
| G3 - deployment | Host/location (existing nucbox is the reuse candidate), instance name `pip`, resource budget, admin exposure decision, internal HTTP/network attachment, change window and rollback | Rod / operator |
| G4 - secrets | Owner provisions Pip's new Discord token and operator provisions a unique MCP bridge secret through approved secret handling; neither is pasted into plans, issues, logs, prompts or command output. No reuse/copy of another bot/client's token. | Rod / operator |
| G5 - core behavior | Explicit treatment of announce/release watchers, required channel, admin IDs, auto-update, command visibility, and any admin panel. Decide whether supported configuration is sufficient or a small code child is needed. | Rod after C1 evidence |
| G6 - pairing | Approve register/pair on the Pip bot and creation of one separate Pip local integration; preserve existing connections. Approve any automatic grant-connection notice that pairing may produce. | Rod |
| G7 - live verification | Approve the exact test messages, destination, negative-path fixtures, timings and temporary blocks/revocation before running section 7 | Rod |
| G8 - notification scope | Approve the policy below before any routine result DM. A test-send approval is not standing notification consent. | Rod |

The implementing session must ask for a concrete, reviewable operator action at each unapproved
gate. Existing explicit authorization may cover a gate; record it rather than repeatedly asking.
Do not bypass denied approval, branch protection, secret boundaries, or permission constraints.

### Notification policy to settle at G8

Proposed MVP for approval: only terminal results of tasks Rod explicitly starts with hosted Pip;
one concise DM per task containing task label, success/failure/blocked status, and a result/PR
link where accessible. No progress stream, raw logs, credentials, account IDs, private machine
paths, or sensitive task content. Private links may be included only under Rod's chosen policy.

Record decisions on: which task categories qualify; failed/blocked/cancelled tasks; maximum
summary length; quiet hours/timezone; maximum daily volume; retry window; offline expiration;
whether deferred messages may be sent when Melody reconnects; revocation/disable control; and
whether any per-task opt-out is needed. Defaults until approval: **no sends and no replay queue**.
Do not send partial/reasoning/tool transcripts. Transport logs record status and opaque event IDs,
not message contents. Errors never reveal tokens or unnecessary recipient identifiers.

## 4. Children and dependency order

```text
C1 preflight + policy decisions -> C2 separate Pip application/instance
                                -> C3 internal bridge configuration
C2 + C3 + G6 -> C4 separate local client pairing -> C5 delivery verification
C1 policy + C5 -> C6 MVP result handoff -> C7 rollout and operator runbook
Optional C8 always-on execution design starts only after a new owner decision.
```

### C1 - Preflight and configuration design (S; read-only then owner decisions)

Re-read repo guidance, ADRs [0004](../../adr/0004-plugins-fetched-from-a-published-manifest.md),
[0006](../../adr/0006-per-plugin-routing.md), and [0007](../../adr/0007-host-owned-http-router.md).
Inventory non-secret deployment metadata: running versions, instance/network names, configured
bridge IDs, capacity within the additional-bridge limit, health and current source revisions.
Do not inspect token values or dump container environment/config files containing secrets.

Trace existing core commands/watchers and whether the proposed Pip configuration can suppress
unwanted output without broad permissions. Confirm `ANNOUNCE_CHANNEL_ID`, empty watcher fallback,
admin authorization checks, routing, and initial single-server command registration. Produce a
reviewable non-secret config diff and record G1-G5/G8 decisions. If code is needed, create a
bounded child plan with affected files, named tests, mutation guards, debug verification and
the repository's behavior-review gate before changing anything. No generic core refactor.

Acceptance: operator-reviewed configuration checklist; explicit handling of all core outputs;
current official Discord requirements cited; preserved existing bridge identities and pins.

### C2 - Separate application and Pip bot instance (M; operator-gated)

Rod creates Pip's application/bot, approves the separately designed avatar under his existing
design standards, and installs it in the one approved server. The avatar task is outside this
implementation session until an approved asset is handed over; do not generate a competing design.
Use the existing `ops/install.sh <instance>` and Compose workflow with `instance=pip`, not a
second login using an existing token. Provision separate config/state; load only the MCP plugin.
**Installer-output boundary:** the current installer generates an `ADMIN_TOKEN` and prints its
value to stdout (`ops/install.sh`, admin-profile instructions). Execute that step in an approved
secure operator context, not through a model/tool transcript with unfiltered output. Do not paste
the installer output into chat or an issue; arrange approved suppression/redaction before any
automation. Changing the installer is not authorized by this planning task. Securely retain the
generated admin token through operator-managed handling even if the admin profile is not enabled.
Keep all privileged intents off for the proposed plugin set. Owner securely supplies secrets.
Follow G5's core/admin configuration; do not expose an admin panel publicly without its own
approved access controls. Start/recreate only the intended Pip services; avoid operations that
recreate other stacks or overwrite the shared `bot-ops.sh` with a divergent branch version.

Acceptance: non-secret bot/application IDs prove identity differs from prod/debug/Clerk;
Pip startup reaches gateway-ready with expected plugin/version and HTTP router; the other
instances' health, identity, config and start times remain unchanged. Pip joins only the approved
server. Verify actual permissions/intents, not merely the invitation URL's requested values.

### C3 - Add the internal Pip bridge (S; MCP repository/operator boundary)

Add one new bridge ID `pip`, not a rename/repoint of the default or `prod`. Preserve existing
bridge ID/test pins and unrelated config. Attach the existing MCP service to Pip's dedicated
network using the bot's container name for resolution, following the [Compose example](https://github.com/Rackbops/discord-mcp/blob/315d47096d0473b35e360a2128cf1fe57eaeb7c7/deploy/compose.yaml.example).
No new public bridge route/tunnel is needed when the internal network is sufficient.
Use a distinct bridge secret and explicit production/test flag. Keep user defaults `dm:self`;
no user post grant or service principal is required for owner-only result DMs.

Acceptance: reviewed diff contains only the new bridge/network/secret reference; health and
existing read-only caller checks still pass; bogus bridge identity or mismatched pins fail closed.
Changes to `discord-mcp` code, if discovered necessary, require their own repository review/tests.

### C4 - One separate Pip local integration (S; pairing/operator-gated)

Rod runs the Pip bot's register and pair commands with the chosen prefix. Pair one local client
using the supported flow; the submitted code determines the bridge. Do not paste the code into
an issue, plan, or model transcript. Prefer a separately named stdio integration with a dedicated
client-managed credential location so existing prod OAuth/shim connections are not replaced.
The HTTP-OAuth alternative needs explicit verification of its client login isolation before use;
do not assume a second name at the same URL has independent OAuth storage.

Discover exposed normalized tool names from `ALL_TOOLS`, rather than assuming the server key.
For a key `pip-discord`, the anticipated normalized name is `mcp__pip_discord__whoami`; verify it
is actually present/callable. The known existing keys `discord-mcp`/`discord-shim` are evidence
examples, not names to repoint silently. Keep client authentication managed by the client.

Acceptance: fresh noninteractive child through normal approval returns owner user principal
pinned to `pip`, only `dm:self`, and DM capability; existing prod caller still returns `prod`.
Capture redacted metadata, never credential contents. `whoami` does not prove visible sender.

### C5 - End-to-end live acceptance and failure behavior (M; G7)

Run section 7's approved fixtures using the intended route. Resolve the owner through the
configured caller's allowed-recipient tool before sending; do not guess a recipient ID. Reuse
one stable idempotency key for retries of the same logical event. An ambiguous timeout is not
permission to submit a new key. Do not claim delivery from `queued`/`pending`/`unknown`.

Acceptance: one visible Pip-authored DM, correct returned delivery status, duplicate suppression,
recipient/grant isolation, blocked/revoked behavior, privacy checks and restoration demonstrated.

### C6 - MVP hosted-Pip result handoff (M; policy-gated)

Define a bounded handoff containing event ID, task label/status, approved summary/link and expiry.
Hosted Pip delegates only under G8 to an online connected Melody task. The local task launches the
installed Codex client with the approved integration and supported standard approvals, preserving
its read-only filesystem scope for delivery-only work. MCP send authorization is separate from
filesystem sandboxing; a read-only shell sandbox does not itself authorize a DM.

The delivery session resolves the allowed recipient, submits once and returns the exact terminal
or pending result. Use the same event/idempotency key across retries; define storage/lifetime for
that association before adding automatic retries. MVP has no offline replay unless G8 explicitly
approves and specifies it. Return a clear chat fallback when Melody/tool/approval is unavailable;
never silently route via prod. No approval-bypass flags, token extraction or install/login fallback.

Acceptance: an approved completed task yields one Pip DM and a delivery outcome in hosted chat;
an excluded task yields none; offline Melody yields a truthful fallback, not a claimed DM.

### C7 - Staged rollout, runbook and exit demo (S; operator-gated)

Record non-secret config/version provenance, owner scope, consent/disable controls, monitoring,
rollback and observed limitations in `ops/README.md` or a linked runbook. Keep this epic's running
log updated. Review documentation claims independently per repository guidance. Initial launch
stays one server/recipient and manual approved task notifications; expand only after a new decision.

## 5. Configuration shape (placeholders only; not executable provisioning)

Bot operator configuration design:

```dotenv
DISCORD_TOKEN=<securely-provisioned-new-Pip-token>
PLUGINS=mcp
COMMAND_PREFIX=<approved-unique-prefix>
DISCORD_SERVER_ID=<approved-initial-server>
ANNOUNCE_CHANNEL_ID=<approved-core-output-channel-or-gated-host-change>
ADMIN_USER_IDS=<approved-owner-only-admin-list>
AUTO_UPDATE=false
HTTP_PORT=<internal-router-port>
MCP_BRIDGE_TOKEN=<securely-provisioned-unique-bridge-secret>
```

Confirm core watch settings and release routing in C1; blank `WATCHED_REPOS` does not disable
the current watcher. Do not copy a complete existing instance env file or add unrelated plugins.
Select tested plugin versions and deployment revisions during preflight; this plan does not pin
an operator to an unverified future `latest`.

Additive MCP configuration concept (merge into existing `additionalBridges`, never replace it):

```json
{
  "id": "pip",
  "url": "http://rackbops-discord-bot-pip:<internal-router-port>/mcp",
  "tokenEnv": "DISCORD_MCP_BRIDGE_TOKEN_PIP",
  "allowInsecureHttp": true,
  "commandPrefix": "<same-approved-prefix>",
  "test": false
}
```

`allowInsecureHttp` is only for the approved private internal network; do not expose this bridge
plaintext on a public network. Preserve the existing service's secret injection and pins. The
bot's `MCP_BRIDGE_TOKEN` and service's referenced secret must agree; different bridges' secrets
must remain distinct. Client credentials are separate again and never receive a bridge secret.

## 6. Rollout and rollback

1. Approve C1 decisions and concrete diffs. Record non-secret baseline health/versions for prod,
   debug, Clerk and MCP; securely back up operator config/state without printing contents.
2. Verify any actual code change on debug first under existing test/review rules. Use a
   debug-pinned test caller; never point a prod caller at debug as a shortcut.
3. Bring up Pip in isolation. Verify gateway-ready and private HTTP, then add its bridge to MCP
   in the agreed change window. Preserve the shared MCP service's existing clients.
4. Pair the separate local integration, run approved acceptance fixtures, then restore the
   owner registration/DM settings to the agreed operational state after revocation/block tests.
5. Enable only approved MVP notifications, observe the first events, and document their outcomes.

Rollback starts by disabling new notification initiation/retries. Stop Pip or remove its local
integration from use; revoke only the Pip registration/grant if authorized. Restore the reviewed
MCP configuration/network attachment and verify prod/debug/Clerk remain healthy. Do not globally
restore shared MCP state from an old snapshot: that could undo unrelated grants/deliveries.
Retain Pip's state and deployment for diagnosis unless deletion is separately approved. Revoke
a new token or remove the application/server installation only on Rod's explicit instruction.
Pending/unknown delivery may already have reached Discord: record uncertainty and do not resend
under a fresh key. A later restart/redrive policy must be decided before attempting recovery.

## 7. Concrete acceptance matrix (execute in future session)

All Discord-affecting rows require G7 and exact approved fixtures. Use a controlled fixture or
existing non-owner test registration for negative cases; creation of any extra live account,
registration or grant is separately gated. If unavailable, run fake-boundary tests and explicitly
leave the corresponding live case unverified. Do not silently skip a feasible agreed check.

| ID | Exercise | Required observable result |
|---|---|---|
| A1 identity | One approved plain DM from Pip integration | Rod sees Pip's approved name/avatar; returned message link and bot author ID match the new application, not prod/debug/Clerk. Redact IDs in public evidence. |
| A2 caller/recipient isolation | `whoami`, allowed recipients, then approved negative recipient fixture | Owner user principal pinned to `pip`, only `dm:self`; recipient list contains only owner; another recipient is denied before delivery. No fallback to prod. |
| A3 duplicate | Retry identical logical event with the same idempotency key | One visible DM and stable delivery reference; no second message. Changed body under the same key is handled according to current contract and does not create a duplicate. |
| A4 blocked DMs | Owner temporarily blocks Pip or closes DMs, then approved test | `RECIPIENT_UNREACHABLE`/truthful failure; no repeated unsolicited retries, no fallback bot. Restore the agreed privacy setting after fixture. |
| A5 revocation | Unregister only with Pip, then use old Pip credential | Pip call refused; existing prod read-only credential still works. New pairing, if separately approved, restores only Pip. |
| A6 outage/ambiguity | Controlled bridge interruption or timeout around one fixture | Report pending/unknown/failure honestly; stable event key; no blind new-key resend. Check delivery state before restart/redrive. |
| A7 privacy | Inspect redacted event/status logs and delivered summary | No tokens, pairing codes, raw task logs, private paths or unapproved task data. Failure output names the stage without secret values. |
| A8 Melody unavailable | Disconnect/unavailable local route during an approved synthetic result | Hosted chat reports unavailable; no success claim, prod fallback, or unapproved deferred replay. Restore connectivity. |
| A9 policy | One included and one excluded task class | Included terminal result produces exactly one scoped DM; excluded/progress/cancelled case follows the approved policy and produces no extra messages. |
| A10 preserved instances | Compare baseline before/after deployment and rollback rehearsal | Prod/debug/Clerk identity, health and existing registration/grants unchanged; only intended services recreated. |
| A11 restart | Controlled Pip restart after a completed fixture | Completed message is not duplicated; independent state persists; core/admin behavior matches G5. Any pending-message redrive is explicitly observed and documented. |

For code changes: run `bun run check`, the `ops` typecheck, `ops/admin` typecheck and `bun test`
as required by `AGENTS.md`, plus named targeted and mutation checks for changed behavior. Docker
and Linux-only checks need their proper execution environment; report Windows skips. Required CI
and repository review gates precede merge. Documentation-only work needs link/format checks and
an independent claims-vs-source audit; no live acceptance is claimed by writing this plan.

## 8. Handoff checklist and exit demo

- [ ] Rebase/reconcile current main and verify related MCP/plugin versions and source claims.
- [ ] Record G1-G8 decisions/authorizations, owner and operator; create child issues only if asked.
- [ ] Complete C1 core-behavior review; bounded code child if needed, otherwise configuration-only.
- [ ] Review non-secret diffs and secret-provisioning method; preserve existing pins/config/state.
- [ ] Execute C2-C4 without credential copying or unapproved authentication changes.
- [ ] Execute A1-A11; record outcome, redacted evidence, limitations and restoration for each.
- [ ] Implement/verify C6 event identity, expiry, consent, fallback and bounded retry policy.
- [ ] Rehearse rollback, then publish the owner-approved runbook and notification disable control.
- [ ] Exit demo: approved task completes in hosted Pip; online Melody delivers exactly one DM
      visibly from Pip; hosted chat reports the truthful result; excluded task/offline case sends
      nothing; existing bots remain healthy. Rod confirms identity and scope before closing epic.

## 9. Optional later track - Melody-independent execution (not MVP)

First choose an authorized trigger/result source and durable execution host. A continuously
running Pip bot supplies only the Discord edge; it neither knows hosted task completion nor
grants hosted Pip a native connector. Options to investigate separately include an approved
always-on Codex executor, a supported hosted connector, or an owner-controlled result queue.
None is established by the current proof. This track needs an explicit design for authentication,
recipient resolution, consent, task provenance, queue retention, ordering/idempotency, expiration,
quiet hours, access isolation, outage recovery and revocation. Do not provision a service principal
as a shortcut: `dm:registered` has a broader recipient surface than the MVP owner's `dm:self`.

## 10. Running log

- 2026-10-06: plan drafted from read-only source inspection and earlier authorized identity tests.
  No Pip application, instance, token, registration, grant, integration or notification created.
  Implementation and live acceptance remain pending; planning permission is the only new scope.
