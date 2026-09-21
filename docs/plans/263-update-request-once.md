<!-- Plan for Rackbops/rackbops-discord-bot#263. Verbatim copy of the approved plan comment: https://github.com/Rackbops/rackbops-discord-bot/issues/263#issuecomment-5764003971 -->

## Implementation plan — written by the orchestrating session, to be executed as written

One small PR, branch `claude/update-request-once` cut from `origin/main`, in an isolated worktree. Commit this plan as `docs/plans/263-update-request-once.md`. Everything is in `src/plugins/requests.ts`, `src/plugins/requests.test.ts` and `CONTEXT.md`. Not part of Epic #236.

Read first: `drainOnce` in `src/plugins/requests.ts` as it stands after #241 — in particular the `undeletable` map and its comment, `removeFile`, `unlinkTolerant`, and how `handleRoutingRequest` ends (that is the shape to copy).

### Decided — not open for re-planning

- **Both halves of the issue's fix, and nothing durable.** (1) An applied *update* request whose file cannot be removed is remembered exactly like a routing request is (`undeletable`), so it is not applied again within the process and its delete is retried on each drain. (2) An `update-now` or `schedule` for the version that is **already installed** is refused (`<plugin> is already on <version>`). Together they end the restart loop for the case that matters: after the restart has installed the target, the replayed file is refused instead of re-pinning and restarting.
- **No persisted list of handled requests.** `PluginStateFile` is part of `src/plugins/contract.ts`, which rackbops-bot-plugins vendors verbatim — it is not to be touched — and a second bookkeeping file is more machinery than the residual case deserves. The residual is: the file cannot be deleted **and** the install keeps failing, so the installed version never becomes the requested one; that loop is one restart per boot, as today, and is written down rather than fixed.
- **`skip`, `remind` and `cancel` for the installed version still apply** — they are harmless and the panel offers them only when there is something to act on.
- `unlinkTolerant` goes away if nothing else uses it.
- Everything else about the five update actions is unchanged, and no routing behaviour changes at all.

### Step 1 — `validate`

Right after the "is not an installed plugin" check (which guarantees `stateEntry.installedVersion`): for `update-now` and `schedule`, once `r.version` has passed `VERSION_RE`, `r.version === stateEntry.installedVersion` → `{ ok: false, reason: \`${plugin} is already on ${r.version}\` }`. Both values are validated text by then, so the reason needs no `shown()`. Place it **after** the version-shape check (a malformed version is still "bad version"), and before the host-API compatibility check.

### Step 2 — `drainOnce`, the update path

Replace
```ts
await unlinkTolerant(deps, path);
```
with the routing path's shape:
```ts
if (!(await removeFile(deps, path))) {
  deps.log.error(`[plugins] couldn't delete applied request ${file}; it will not be applied again`);
  undeletable.set(file, text);
}
```
`restartReason` is still set before the delete, exactly as now, so an `update-now` still restarts once. Update the comment block above `undeletable` (it says an applied UPDATE request "is not among them … as it always was") and the comment in the update path.

### Step 3 — tests (`src/plugins/requests.test.ts`)

- `an applied update request whose file cannot be deleted is applied once: one state write, one restart, and later drains only retry the delete` (three drains; `mutations` has length 1, `restarts` length 1, one error line)
- `… and it goes once it can be deleted` (the retry succeeds; the entry is forgotten; a new request under that name is handled)
- `a different update request under a stuck one's name is applied, not mistaken for it`
- `update-now for the version already installed is refused naming it, writes no state and requests no restart`
- `schedule for the version already installed is refused the same way`
- `skip, remind and cancel for the installed version still apply`
- `a malformed version is still "bad version", not "already on"` (order of the two checks)
- in `validate`'s own describe: the two new refusals, and that an `update-now` for any *other* version is accepted as before
- the existing `unlink fails after apply` expectations, if any test pins "applied again on the next drain", change to the new behaviour — say which test and why in the PR.

### Step 4 — docs

`CONTEXT.md`, the mailbox paragraph: the sentence *"An applied update request whose delete fails is not remembered, as before (`unlinkTolerant`), and is applied again on the next drain (#263)"* becomes what is now true, including the residual (undeletable file **and** a failing install → one restart per boot). The `src/plugins/requests.ts` File-Map row likewise. Do not edit the `src/index.ts` row. Verify each sentence against the merged code.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| undeletable applied `update-now`: one restart, a second drain requests none | 2 | `an applied update request whose file cannot be deleted is applied once…` | restore `unlinkTolerant`; remember the file but still apply it |
| the same across a simulated restart | 1 | `update-now for the version already installed is refused…` — a fresh module state (`resetPluginRequestsForTest`), the same mailbox, and a state whose `installedVersion` is now the requested one | drop the new refusal |
| `update-now` for the installed version is refused, no restart | 1 | same + the `validate` tests | compare against `latestVersion` instead; refuse `skip` too |
| the other update actions and every routing action unchanged | 1, 2 | `skip, remind and cancel for the installed version still apply`; the existing suite, unedited apart from the one expectation named above | refuse for every action |
| the delete is retried and the entry forgotten | 2 | `… and it goes once it can be deleted` | never retry; never forget |

### Verification — paste the real output in the PR

```
bun run check
bun test
```
Mutation checks in a detached scratch worktree, one at a time, `bun test src/plugins/requests.test.ts`. **Every `bun test` with a private temp dir** (`TEMP=R:/repos/Scratch/tmp/bot-263 TMP=… bun test`, created first; #252). Your own gate: two read-only adversarial reviewers — one re-running a differential of the five update actions against `origin/main` (the only differences may be the two this plan makes), one on claims-vs-code and the acceptance bullets. This is an S; expect one round.
