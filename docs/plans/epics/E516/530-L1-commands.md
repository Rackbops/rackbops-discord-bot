<!-- Plan for #530 bundle L1 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #530): the Low items that live in
`src/commands.ts` and `/report`'s command path -- #504 (all three items) and #503's items 10 and 11 (the command half).
Written by the orchestrating session on 2026-10-16 against `main` @ `6ed0c4c` (R1, R2, #541 merged; the anchors below
still hold at `8b23559`, which touched none of these files); audited read-only before it was committed (round 1: three
blockers, all applied -- a reply that fails after the restart is requested never reaches the handler's catch in
production, because the critical section's close exits the process, so the failure is logged INSIDE the section and the
planned "pinned and restarting" wording is gone; `afterEach` was not imported; "a retry is refused as pending" was a
false claim copied from the issue. The guild-only registration was dropped: Discord documents `contexts` for globally
scoped commands only, and its effect on a guild-scoped PUT is unverifiable here. Round 2: the action-catch test's
premise was false -- an unparseable `state.json` is moved aside and read as fresh, not rethrown -- so T6 now drives a
rejected reply on `/plugins remind`; the spy destructures are typed for `tsc`; T3b records `restartPending()` at the
reply so the order has a behavioural pin). Every file:line below was read from
that tree; the implementer re-reads each one on the tree it works from and corrects any that moved. Nothing in flight
touches these files: L2 (Sub #3) edits `announce.ts`/`github.ts`; S4b (Sub #1) edits `redeploy.ts`/`index.ts`. -->

## Implementation plan -- #530 L1: answer an unclaimed command, refuse `/report` in a DM truthfully, request the restart before the reply, and log what `/update` and `/plugins` swallow

Children: **#504** (items 12, 13, 14 -- closes it) and **#503** items **10** and **11's command half** (#503 stays open:
its items 2 and 3 are the `/update` reply's token window and clamp, planned with #505 under #526 per #530's **Fix once**;
its item 7 and the `/report` half of 11 landed in PR #566). One PR, branch `fix/530-L1-commands`, worktree
`S:\Repos\_wt\rdb-530-L1` cut from `origin/main`. Behaviour changes in the command dispatcher and `/plugins update` ->
the **three-reviewer gate** applies; every changed line mutation-tested in a scratch worktree.

### What is wrong, verified at `6ed0c4c`

- **#504 item 12.** `handleCommand` (`src/commands.ts:313-356`) answers a command no core row and no plugin claims
  with one warning and `"unclaimed"` (`:326-330`): the user waits three seconds for Discord's "The application did
  not respond". A plugin command whose plugin is not running gets a private reply instead (`refuseNotRunning`,
  `:358-362`, text `PLUGIN_NOT_RUNNING_REPLY` `:302`), and an unclaimed component press gets one too
  (`answerUnclaimedPress`, `src/plugins/host.ts:905-914`, wired at `src/index.ts:291-292`). The unclaimed command
  case is the odd one out. When it happens: a client holding a registration from before this boot (a plugin
  uninstalled or failing to load, until `rest.put` lands), or a name typed against a stale list.
- **#504 item 13.** In a DM `interaction.member` is `null`, `hasReportRole` (`src/report.ts:50-59`) is false, and
  `/report` answers "You don't have the role required to file reports." (`:77-83`) -- wrong, the user may well have
  it. DMs are reachable only when the commands are registered globally (no `DISCORD_SERVER_ID` and no routed
  placement, `src/routing/register.ts:129,137`); `/update` and `/plugins` are gated by the id allowlist and behave
  the same anywhere. The issue's other suggestion -- `setContexts(InteractionContextType.Guild)` on the core builders
  -- is **not taken**: `discord-api-types` documents `contexts` as "only for globally-scoped commands"
  (`applicationCommands.d.ts:91-96`), the same JSON is PUT guild-scoped on most deployments, and whether Discord
  ignores or rejects the field there cannot be verified from this box; a 400 on that PUT would break every boot
  for a Low.
- **#504 item 14.** Three drifts, each verified:
  - `CONTEXT.md:165` (the `src/commands.ts` row) says "`isAdmin()` allowlist gate for `/update`" (it gates `/plugins`
    too, `:172`), "`CORE_COMMAND_NAMES` (bare `commandData` names, via `bareName()`)" (it is
    `CORE_COMMANDS.map((c) => c.name)`, `:290`, no `bareName()`), and "Discord `<t:…>` timestamp helpers" (none in
    `commands.ts`; `discordTs` lives at `src/plugins/updates.ts:240-242`). The same row says an unmatched command
    "warns if nothing matches" and states the `update`-now order this plan changes ("pin write + reply inside
    `withCritical`, then `requestRestart`").
  - `src/commandNaming.ts:3-7`: the header's second sentence is garbled ("host.ts imports commands.ts's commandNamer
    was the one host→commands edge, and it made commands.ts unable to import host.ts back").
  - `report.test.ts:132`'s stale `report.ts:130` cite is **already gone**: PR #566 rewrote that file and no
    `report.ts:<line>` cite remains (Grep `report\.ts:\d+` over `src/report.test.ts` finds nothing). No change.
- **#503 item 10.** `/plugins update <name>` with no `at` (`src/commands.ts:265-274`) runs, inside `withCritical`,
  `mutatePluginState` (the pin + `pendingReport`, `planPluginAction`'s `pinUpdateNow`, `src/plugins/updates.ts:451-463`),
  then `editReply`, then `requestRestart`. `requestRestart` inside a critical section only defers (`src/restart.ts:359-371`),
  so the order buys nothing -- and it costs: an `editReply` Discord rejects (an expired token) throws past the
  `requestRestart`, the pin and the report are on disk, no restart is requested, and the catch (`:278-280`) tells the
  admin "Couldn't act on the plugin" (a retry is NOT refused -- `hasPending` gates only `cancel`,
  `src/plugins/updates.ts:407`; the issue's claim to the contrary is wrong). The source guard at
  `src/commands.test.ts:721-736` pins exactly this order (`mutate < reply < restart`); no test drives the path.
  **What follows the fix:** once `requestRestart` has been called inside the section, `withCritical`'s `finally` ->
  `endCritical` (`src/restart.ts:240`) -> `doExit` -> `process.exit(75)` fires the moment the section closes, so a
  reply that rejects AFTER the restart request does not reach the handler's outer `catch` in production (the
  process is gone) unless another critical section happens to be open; it must be logged inside the section.
- **#503 item 11 (command half).** The `/update` catch (`:128-130`), the `/plugins list` catch (`:189-193`) and the
  `/plugins <action>` catch (`:278-280`) reply and swallow: nothing is logged, and the interaction line
  (`src/interactionLog.ts:22-27`) says `outcome=answered`. A GitHub 403 on `/update`, a `state.json` read that
  fails with EACCES or EIO (which `readJsonOrFresh` rethrows, `src/storage.ts:157-158`, #509) or a reply Discord
  rejects leaves no trace. (`loadPluginIndex` never
  throws -- `src/plugins/index.ts:140-175` -- so an index outage is not among them.) `withoutRequest`
  (`src/plugins/delivery.ts`, R1) is already imported (`:17`) and is what `handleCommand`'s own catch uses
  (`:348-350`). The `/report` half of this item landed in PR #566.

### Decisions (defaults, named so the gate can contest them)

1. **The unclaimed command gets `PLUGIN_NOT_RUNNING_REPLY`, through a `refuseUnclaimed` sibling of `refuseNotRunning`:**
   same warning as today, the reply awaited (a rejected reply propagates to `index.ts`'s catch, as `refuseNotRunning`'s
   does, pinned at `src/commands.test.ts:527-537`), `"unclaimed"` returned. One text for both: "This command isn't
   available right now." is true of a command nothing handles.
2. **`/report` refuses a DM in words** (`REPORT_DM_REFUSAL`), before the role check, keyed on `!interaction.member`
   (null in a DM). No registration change (above). `/update` and `/plugins` need no DM branch. The modal path (R2's
   gate, `src/report.ts:161-179`) is unchanged: it refuses a no-member submit with the role text, as its test pins.
3. **`requestRestart` moves to right after the pin write, before the reply**, still inside `withCritical`; the exit
   is deferred to the section's end either way, so the write and the reply still land first. The reply gets its own
   `try`/`catch` inside the section: a rejection is logged through `withoutRequest` and swallowed (the process exits
   with the restart when the section closes; a "Couldn't act" edit would be false and could not be sent anyway).
   No flag, no extra wording. A real end-to-end test drives the path (T3b) with the exit stubbed.
4. **One `console.warn` per swallowed catch, through `withoutRequest`**, naming the command the user typed: a failed
   reply carries the token in `url`/`path` and the reply in `requestBody` (#545).
5. **Docs follow the code in the same PR** (the `CONTEXT.md:165` row, the `:173` report row, the `:221` updates row,
   the `commandNaming.ts` header, the two stale code comments named in Step 4).

### Step 1 -- `src/commands.ts`

1a. `/update`'s catch (`:128-130`) becomes:

```ts
        } catch (err) {
          // #503 item 11: the failure used to be swallowed into the reply alone, leaving `outcome=answered` and no
          // trace. withoutRequest: a failed reply carries the interaction token and the reply text (#545).
          console.warn(`[update] /${interaction.commandName} failed`, withoutRequest(err));
          await interaction.editReply(clampReply(`⚠️ Update check failed: ${(err as Error).message}`));
        }
```

1b. `/plugins list`'s catch (`:189-193`) becomes:

```ts
        } catch (err) {
          // Match the /update deferred convention: a failure edits the deferred reply with an
          // error rather than leaving the admin's "thinking…" hanging. Logged first (#503 item 11).
          console.warn(`[plugins] /${interaction.commandName} list failed`, withoutRequest(err));
          await interaction.editReply(clampReply(`⚠️ Couldn't list plugins: ${(err as Error).message}`));
        }
```

1c. The `update`-now block: replace `:265-274` (from `if (result.restart) {` through the line `} else {`) with:

```ts
        if (result.restart) {
          // `update` NOW: pin write, then requestRestart, then the reply, all inside withCritical: the exit is
          // deferred to the section's end, so the write and the reply still land before it. The restart is requested
          // BEFORE the reply (#503 item 10): a reply Discord rejects (an expired token) used to throw past the
          // requestRestart, leaving the pin and the report on disk with no restart requested and the admin told
          // "Couldn't act". Inside the section the order costs nothing -- it only defers. A reply that fails AFTER the
          // request is logged here and swallowed: the process exits for the restart when this section closes, so the
          // outer catch below usually cannot run (only another open critical section would still defer the exit) and
          // could not send anything true.
          const { from, to } = result.restart;
          await withCritical(async () => {
            if (result.mutate) await mutatePluginState(DATA_DIR, result.mutate);
            requestRestart(`plugin update: ${name} ${from} → ${to}`);
            try {
              await interaction.editReply(result.reply);
            } catch (err) {
              console.warn(`[plugins] /${interaction.commandName} ${sub}: the update is pinned and the bot is restarting, but the reply failed`, withoutRequest(err));
            }
          });
        } else {
```

(the `else` body `:275-277` is unchanged). The action catch (`:278-280`) becomes:

```ts
      } catch (err) {
        console.warn(`[plugins] /${interaction.commandName} ${sub} failed`, withoutRequest(err)); // #503 item 11
        await interaction.editReply(clampReply(`⚠️ Couldn't act on the plugin: ${(err as Error).message}`));
      }
```

1d. `PLUGIN_NOT_RUNNING_REPLY`'s comment (`:300-301`) becomes:

```ts
/** What a plugin command is told when its plugin is not running (#407): activate() has not finished, it
 *  failed, or the plugin is being disposed -- and, since #504, what a command nothing handles at all is told. */
```

In `handleCommand`, replace `:325-330` (the comment line and the `if (!target)` block) with:

```ts
  // The lookup is keyed by bare name; a name that matches neither is answered privately (#504), never dropped.
  const target = lookup(bare);
  if (!target) return refuseUnclaimed(interaction);
```

and add, right after `refuseNotRunning` (`:358-362`):

```ts
/** #504 item 12: a command Discord still lists but nothing here handles -- its plugin is gone or did not load
 *  this boot (until `rest.put` lands), or the name is stale -- is answered privately, like one whose plugin is not
 *  running, instead of Discord's "The application did not respond" three seconds later. Awaited like
 *  `refuseNotRunning`'s reply: one Discord rejects reaches index.ts's catch. */
async function refuseUnclaimed(interaction: ChatInputCommandInteraction): Promise<"unclaimed"> {
  console.warn(`[interaction] no handler for /${interaction.commandName}`);
  await interaction.reply({ content: PLUGIN_NOT_RUNNING_REPLY, flags: MessageFlags.Ephemeral });
  return "unclaimed";
}
```

In `handleCommand`'s docstring (`:304-312`) change "A refusal is a private reply." to "A refusal -- the plugin not
running, or no handler at all (#504) -- is a private reply."

### Step 2 -- `src/report.ts`

Beside `REPORT_LABEL` (`:14`):

```ts
/** #504 item 13: what `/report` says in a DM (reachable only under a global registration). Without a `member` there
 *  is no role to read, and "you lack the role" would be the wrong answer. */
export const REPORT_DM_REFUSAL = "This command works only in a server channel.";
```

In `handleReportCommand`, between the not-configured refusal (`:70-76`) and the role check (`:77-83`):

```ts
  if (!interaction.member) {
    await interaction.reply({ content: REPORT_DM_REFUSAL, flags: MessageFlags.Ephemeral });
    return;
  }
```

`hasReportRole` (`:50-59`) and the modal gate are unchanged.

### Step 3 -- `src/commandNaming.ts` (`:3-7`)

```ts
// Extracted from commands.ts so the plugin loader (src/plugins/host.ts) can name plugin commands
// through the same namer WITHOUT importing commands.ts. host.ts importing commands.ts's commandNamer
// was the one host -> commands edge, and it kept commands.ts from importing host.ts back (the shared
// state.json mutator). With the namer here that cycle is gone, and #104's /plugins handlers can use
// host.ts's mutatePluginState.
```

### Step 4 -- docs and stale comments

`CONTEXT.md` rows are single long lines; anchor an Edit on the exact substring (plain text, no padding; the
backticks are the file's own).

`:165` (the `src/commands.ts` row), six substrings:

1. Old: `` `isAdmin()` allowlist gate for `/update`; `refuseUnlessAdmin(interaction)` ``
   New: `` `isAdmin()` allowlist gate for `/update` and `/plugins`; `refuseUnlessAdmin(interaction)` ``
2. Old: `` `CORE_COMMAND_NAMES` (bare `commandData` names, via `bareName()`) ``
   New: `` `CORE_COMMAND_NAMES` (the table rows' own bare `name`s, `CORE_COMMANDS.map((c) => c.name)`; no prefix, no `bareName()`) ``
3. Old: ``; Discord `<t:…>` timestamp helpers. Also the admin-gated `/plugins` command``
   New: ``. **#504:** `/report` in a DM says `REPORT_DM_REFUSAL` (there is no `member` to read a role from). Also the admin-gated `/plugins` command``
4. Old: ``or warns if nothing matches; **#407:**``
   New: ``or, if nothing matches, warns and refuses it privately with `PLUGIN_NOT_RUNNING_REPLY` (`refuseUnclaimed`, #504) instead of Discord's three-second failure; **#407:**``
5. Old: ``pin write + reply inside `withCritical`, then `requestRestart` (the exit deferred to the critical-section end, so the write and reply land first)``
   New: ``pin write, then `requestRestart`, then the reply, all inside `withCritical` (the exit is deferred to the section's end, so the write and the reply still land first; requesting before the reply means a reply Discord rejects no longer leaves the pin written with no restart, #503 item 10 -- such a reply is logged through `withoutRequest` inside the section and swallowed, since the restart exits the process when the section closes; every other swallowed `/update`/`/plugins` failure is logged the same way, item 11)``
6. The sentence `` `update` NOW mirrors `/update` `` stays: after edit 5 it is true (`/update`'s no-socket fallback
   requests the restart in `applyUpdate`, `src/update.ts:337`, before the handler replies at `src/commands.ts:125`).

`:173` (the `src/report.ts` row). Old: ``role gate (reads roles from the interaction — no Members intent; re-checked on the modal submit too, #448)``
New: ``role gate (reads roles from the interaction — no Members intent; re-checked on the modal submit too, #448; a DM, which has no `member`, is refused with `REPORT_DM_REFUSAL` instead of the role text, #504)``

`:221` (the `src/plugins/updates.ts` row). Old: ``pure `parseScheduleTime` (`HH:MM` ``
New: `` `discordTs` (the Discord `<t:…>` timestamp markup the replies carry), pure `parseScheduleTime` (`HH:MM` ``

Two code comments that state the old order or the old behaviour:
- `src/plugins/updates.ts:314` says "the handler restarts (inside withCritical) after the reply lands" -> "the
  handler requests the restart (inside withCritical) right after the pin write, then replies (#503 item 10)".
- `src/commands.ts:325` is replaced by Step 1d's comment.

Optionally extend the `CONTEXT.md:179` test-file row with the new tests' names.

### Step 5 -- tests

**`src/commands.test.ts`.** Line `:1` becomes `import { afterEach, describe, expect, spyOn, test } from "bun:test";`.
After `:16` add:

```ts
const { markPluginStateReady, resetPollStateForTest } = await import("./announce");
const { setExitFn, resetForTest: resetRestartForTest, restartPending, RESTART_EXIT_CODE } = await import("./restart");
const { HOST_API_VERSION } = await import("./plugins/contract");
const { DATA_DIR } = await import("./storage");
```

- **T1 and T1b (#504-12)** replace `:344-353`:

```ts
  test("a command neither a core row nor a plugin claims is answered privately, and warned once (#504)", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const replies: unknown[] = [];
    const interaction = { commandName: "nope", reply: async (o: unknown) => void replies.push(o) } as unknown as ChatInputCommandInteraction;
    try {
      expect(await handleCommand(interaction, () => undefined)).toBe("unclaimed");
      expect(replies).toEqual([{ content: PLUGIN_NOT_RUNNING_REPLY, flags: MessageFlags.Ephemeral }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("no handler for /nope");
    } finally {
      warn.mockRestore();
    }
  });

  // T1b
  test("an unclaimed command's refusal Discord rejects is not swallowed, like refuseNotRunning's (#504)", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const expired = new Error("Unknown interaction");
    const interaction = { commandName: "nope", reply: async () => Promise.reject(expired) } as unknown as ChatInputCommandInteraction;
    try {
      await expect(handleCommand(interaction, () => undefined)).rejects.toBe(expired);
    } finally {
      warn.mockRestore();
    }
  });
```

- **T3 (#503-10, source guard)** replaces `:717-736`:

```ts
  // #104/#503 item 10 update-now ordering, pinned by source-scan beside the end-to-end test below: the pin write,
  // the restart request and the reply must all sit INSIDE withCritical, in that order -- the write awaited before
  // the restart is requested, the restart requested before the reply goes out.
  test("update-now writes the pin, then requests the restart, then replies, inside withCritical (source guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./commands.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("if (result.restart)"));
    const wc = block.indexOf("withCritical(");
    const mutate = block.indexOf("await mutatePluginState(DATA_DIR, result.mutate)");
    const restart = block.indexOf("requestRestart(");
    const reply = block.indexOf("await interaction.editReply(result.reply)");
    for (const [label, pos] of Object.entries({ wc, mutate, restart, reply })) {
      expect(pos, `${label} present`).toBeGreaterThan(-1);
    }
    expect(wc).toBeLessThan(mutate); // wrapped in the critical section
    expect(mutate).toBeLessThan(restart); // pin written (awaited) before the restart is requested
    expect(restart).toBeLessThan(reply); // …and the reply goes out after it (a rejected reply cannot skip it)
  });
```

- **T3b (#503-10 and 11, end to end)** -- a new describe after `:762`. It drives `/plugins update demo` for real:
  the admin allowlist, the ready flag, a state file in the test data dir, the index through a stubbed fetch, the
  exit through `setExitFn`, and an `editReply` that Discord rejects.

```ts
// #503 item 10: the one path that pins a version and restarts, driven for real. State and index are the shapes
// plugins/updates.test.ts's helpers build; the data dir is test/setup.ts's per-run BOT_DATA_DIR. The exit is stubbed:
// in production the process is gone the moment the critical section closes, which is why the failed reply must be
// logged inside it (and why no "Couldn't act" edit follows).
describe("handleCommand — /plugins update now (#503 item 10)", () => {
  const { mkdirSync, rmSync, readFileSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const statePath = `${DATA_DIR}/plugins/state.json`;
  const indexCache = `${DATA_DIR}/plugins/index.json`;
  const indexBody = {
    schemaVersion: 1,
    generatedAt: "2026-10-16T00:00:00.000Z",
    plugins: [{ name: "demo", package: "@rackbops/plugin-demo", version: "1.1.0", description: "demo", hostApiVersion: HOST_API_VERSION, commands: [], env: [], releases: [] }],
  };
  const stateBody = {
    hostApiVersion: HOST_API_VERSION,
    writtenAt: "",
    plugins: [{ name: "demo", enabled: true, installedVersion: "1.0.0", configured: true, missingEnv: [], active: true }],
  };

  afterEach(() => {
    resetRestartForTest();
    resetPollStateForTest();
    rmSync(statePath, { force: true });
    rmSync(indexCache, { force: true });
  });

  test("a reply Discord rejects after the pin is written still restarts the bot, is logged without the token, and gets no second edit", async () => {
    const exits: number[] = [];
    const edits: string[] = [];
    let editCalls = 0;
    let pendingAtReply: boolean | undefined;
    const failure = replyFailure("webhook"); // editReply PATCHes the interaction's webhook
    let restoreExit = () => {};
    let fetchSpy: ReturnType<typeof spyOn> | undefined;
    let warn: ReturnType<typeof spyOn> | undefined;
    let log: ReturnType<typeof spyOn> | undefined;
    let pushedAdmin = false;
    try {
      mkdirSync(`${DATA_DIR}/plugins`, { recursive: true });
      writeFileSync(statePath, JSON.stringify(stateBody));
      markPluginStateReady();
      config.adminUserIds.push("999");
      pushedAdmin = true;
      restoreExit = setExitFn((code) => void exits.push(code));
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
        new Response(JSON.stringify(indexBody), { status: 200 })) as unknown as typeof fetch);
      warn = spyOn(console, "warn").mockImplementation(() => {});
      log = spyOn(console, "log").mockImplementation(() => {});
      const interaction = {
        commandName: "plugins",
        user: { id: "999" },
        channelId: "c1",
        options: {
          getSubcommand: () => "update",
          getString: (name: string) => (name === "name" ? "demo" : null),
          getInteger: () => null,
        },
        deferReply: async () => {},
        editReply: async (content: string) => {
          editCalls += 1;
          if (editCalls === 1) {
            pendingAtReply = restartPending(); // #503 item 10: the restart must already be requested here
            throw failure.error; // the "Updating … now" reply: token expired
          }
          edits.push(content);
        },
      } as unknown as ChatInputCommandInteraction;

      expect(await handleCommand(interaction)).toBe("answered");
      // The restart was requested BEFORE the reply went out, inside the critical section, and landed when it closed
      // -- although the reply failed.
      expect(pendingAtReply).toBe(true);
      expect(exits).toEqual([RESTART_EXIT_CODE]);
      // No second edit was attempted (a "Couldn't act" edit would be false; in production the process is gone).
      expect(edits).toEqual([]);
      // The pin and the report are on disk.
      const written = JSON.parse(readFileSync(statePath, "utf8"));
      expect(written.plugins[0]).toMatchObject({ name: "demo", targetVersion: "1.1.0" });
      expect(written.pendingReport).toMatchObject({ plugin: "demo", toVersion: "1.1.0", userId: "999" });
      // Logged inside the section, without the token or the reply (#503 item 11, #545).
      const failed = warn.mock.calls.find(([m]: unknown[]) => String(m).startsWith("[plugins] /plugins update: the update is pinned and the bot is restarting, but the reply failed"));
      expect(failed).toBeDefined();
      expectCleanedLog(failed!, failure);
    } finally {
      warn?.mockRestore();
      log?.mockRestore();
      fetchSpy?.mockRestore();
      restoreExit();
      if (pushedAdmin) config.adminUserIds.splice(config.adminUserIds.indexOf("999"), 1);
    }
  });
});
```

  Notes for the implementer: `expectCleanedLog` and `replyFailure` are already imported (`:3`). `mutatePluginState`
  writes through the plugin host's keyed mutator and is awaited by the handler, so the host's `writes` queue is idle
  when the test ends (the state guard reads it). `loadPluginIndex` caches the fetched index at `indexCache`; the
  `afterEach` removes both files. `requestRestart` arms the 30-minute deferral; `doExit` (run by `endCritical` when
  the section closes) clears it and calls the stubbed exit, and `resetRestartForTest` clears `pending`.

- **T4 (#503-11, `/update`)** in `describe("handleCommand — /update", …)` (`:694-701`):

```ts
  test("a failed update check is logged, not only replied (#503 item 11)", async () => {
    const realSha = config.gitSha;
    const edits: string[] = [];
    let fetchSpy: ReturnType<typeof spyOn> | undefined;
    let warn: ReturnType<typeof spyOn> | undefined;
    let pushedAdmin = false;
    try {
      config.adminUserIds.push("999");
      pushedAdmin = true;
      config.gitSha = "0123456789abcdef0123456789abcdef01234567"; // past the "disabled" early return, to the fetch
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch);
      warn = spyOn(console, "warn").mockImplementation(() => {});
      const interaction = {
        commandName: "update",
        user: { id: "999" },
        channelId: "c1",
        applicationId: "app",
        token: "tok",
        deferReply: async () => {},
        editReply: async (content: string) => void edits.push(content),
      } as unknown as ChatInputCommandInteraction;
      await handleCommand(interaction);
      expect(edits).toEqual(["⚠️ Update check failed: offline"]);
      const failed = warn.mock.calls.find(([m]: unknown[]) => String(m) === "[update] /update failed"); // typed: `warn` is a possibly-undefined spy
      expect(failed).toBeDefined();
      expect((failed![1] as Error).message).toBe("offline");
    } finally {
      warn?.mockRestore();
      fetchSpy?.mockRestore();
      config.gitSha = realSha;
      if (pushedAdmin) config.adminUserIds.splice(config.adminUserIds.indexOf("999"), 1);
    }
  });
```

  (`checkForUpdate`, `src/update.ts:250-318`, returns `busy`/`disabled` before `:262` only when a handoff is active,
  a check is in flight, or `gitSha` is unset; with a sha it reaches `fetchLatestBotSha`'s fetch at `:114-116`, the
  stub throws, the `finally` at `:315-317` clears the in-flight latch, and the throw reaches the `/update` catch.)

- **T5 (#503-11, `/plugins list`)** in `describe("handleCommand — /plugins", …)` (`:703-762`): same shape as T4
  (set-up inside the `try`), `options: { getSubcommand: () => "list" }`, fetch stub throwing (`loadPluginIndex` falls
  back to an empty index and warns itself), `editReply` rejecting once with `replyFailure("webhook").error` then
  recording; assert `edits` equals `["⚠️ Couldn't list plugins: Unknown interaction"]`, the warn call whose first
  argument is `"[plugins] /plugins list failed"` exists (`find(([m]: unknown[]) => …)`, typed as in T4), and
  `expectCleanedLog(thatCall, failure)`.
- **T6 (#503-11, `/plugins remind`)** in the T3b describe (it reuses its state file and `afterEach`): as the "Note
  on M7 / T6" under the mutation table specifies -- a valid state file, `markPluginStateReady()`, the admin pushed,
  the fetch stub answering `indexBody`, `options.getSubcommand` -> `"remind"`, `getString("name")` -> `"demo"`,
  `getInteger("days")` -> `null`, the first `editReply` rejecting with `replyFailure("webhook").error`; assert the
  edit, the warn and `expectCleanedLog`. Set-up inside the `try`, restores in the `finally`, as T3b.

- The three source-scan tests at `:771-809` still pass (each looks for `await interaction.editReply(clampReply(`
  after its catch, which the warn line does not displace). Leave them.

**`src/report.test.ts`.** Import `REPORT_DM_REFUSAL` beside the file's other `./report` imports, and `MessageFlags`
from `discord.js` if not already imported. **T7 (#504-13)** replaces `:210-216` (the whole test, through its `});`):

```ts
  test("a DM (no member) is refused in words, not with the role message (#504)", async () => {
    const dm = fakeCommand({ member: null });
    await handleReportCommand(dm.interaction);
    expect(dm.calls.modals).toHaveLength(0);
    expect(dm.calls.replied?.content).toBe(REPORT_DM_REFUSAL);
    expect(dm.calls.replied?.flags).toBe(MessageFlags.Ephemeral);
  });

  test("the DM refusal says what to do, in words: never an empty reply Discord would reject (#504)", () => {
    expect(REPORT_DM_REFUSAL).toBe("This command works only in a server channel.");
  });
```

The modal-path DM test (`:376-381`) is unchanged.

### Mutation table (run in a scratch worktree, never in the shared tree)

Commit the work in progress first, then:

```bash
git -C /s/repos/rackbops-discord-bot worktree add --detach /s/Repos/_wt/rdb-530-L1-mut fix/530-L1-commands
cd /s/Repos/_wt/rdb-530-L1-mut && bun install --frozen-lockfile
```

Apply one mutation at a time there, run `bun test src/commands.test.ts src/report.test.ts`, record the failing test,
revert (`git -C /s/Repos/_wt/rdb-530-L1-mut checkout -- .`), next; remove the worktree at the end
(`git -C /s/repos/rackbops-discord-bot worktree remove /s/Repos/_wt/rdb-530-L1-mut`).

| # | Mutation (production line, after the steps) | Test that must fail |
|---|---|---|
| M1 | `refuseUnclaimed`: delete the `await interaction.reply(...)` line | T1 (`replies` empty) and T1b |
| M2 | `refuseUnclaimed`: `await interaction.reply(...)` -> `await interaction.reply(...).catch(() => {})` | T1b |
| M3 | update-now block: move `requestRestart(...)` back below the reply's `try`/`catch` | T3 (order) and T3b (`pendingAtReply` is `false`: the restart was not yet requested when the reply went out) |
| M4 | update-now block: delete the inner `console.warn(...)` | T3b (`failed` undefined) |
| M5 | update-now block: inner `withoutRequest(err)` -> `err` | T3b (`expectCleanedLog`) |
| M6 | update-now block: remove the inner `try`/`catch` (let the rejection propagate) | T3b (`edits` non-empty: the outer catch's "Couldn't act" edit ran under the stubbed exit) |
| M7 | action catch: delete the `console.warn(...)` line | T6 |
| M8 | `/update` catch: delete the `console.warn(...)` line | T4 |
| M9 | `/plugins list` catch: delete the `console.warn(...)` line | T5 |
| M10 | `/plugins list` catch: `withoutRequest(err)` -> `err` | T5 (`expectCleanedLog`) |
| M11 | `handleReportCommand`: delete the `if (!interaction.member) { ... }` block | T7 (gets the role text) |
| M12 | `handleReportCommand`: move the DM block below the role check | T7 |
| M13 | `REPORT_DM_REFUSAL = ""` | T7's literal pin |

Note on M7 / **T6**: the action catch is reached when `mutatePluginState` or a reply throws, or on the non-restart
actions (`remind`/`skip`/`cancel`). An unparseable `state.json` does NOT reach it: `readJsonOrFresh` classifies a
parse failure as corrupt, moves the file aside and returns fresh (`src/storage.ts:127-128`, `:153-156`); only
EACCES/EIO/EMFILE/EISDIR on an existing file are rethrown (`:157-158`), none of them triggerable portably on this
box. So T6 drives `/plugins remind demo` through T3b's harness with the VALID state file and the first `editReply`
rejecting with `replyFailure("webhook").error` (the second recording): `edits` equals
`["⚠️ Couldn't act on the plugin: Unknown interaction"]`, a warn whose first argument is
`"[plugins] /plugins remind failed"` exists, and `expectCleanedLog(thatCall, failure)` holds. No restart is involved
(`remind` only mutates), so no `setExitFn`; the `afterEach` cleanup is T3b's. M7 fails it.

### Coverage table

| Bullet (the observable outcome each item demands) | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| #504-12: an unclaimed slash command gets an ephemeral reply, warned once; a rejected refusal propagates | 1d | T1, T1b | M1, M2 |
| #504-13: `/report` in a DM says so instead of the role text; registration unchanged (and why) | 2 | T7 (+ literal pin) | M11, M12, M13 |
| #504-14: the commands row, the updates row, the report row, the `commandNaming.ts` header and the two stale comments say what the code does | 3, 4 | manual: the single claims-vs-code pass the gate's lens-B reviewer runs on the texts | n/a |
| #503-10: the restart is requested once the pin is written, before the reply; a rejected reply no longer strands the pin; that reply is logged inside the section and no false edit follows | 1c | T3, T3b | M3, M4, M5, M6 |
| #503-11 (command half): the three swallowed catches log through `withoutRequest` | 1a, 1b, 1c | T4, T5, T6 | M7, M8, M9, M10 |

### Verification (run from the worktree root; paste real output in the PR)

```bash
bun install --frozen-lockfile
cd ops/admin && bun install --frozen-lockfile && cd ../..
bun run check
bunx tsc --noEmit -p ops/tsconfig.json
cd ops/admin && bun run check && cd ../..
bun test src/commands.test.ts src/report.test.ts src/commandPrefix.test.ts src/index.test.ts src/plugins/host.test.ts test/stateGuard.test.ts
bun test --randomize src/commands.test.ts
bun test
```

- The full `bun test` is slow on this box (the `ops/` subprocess tests take minutes per file): run it in the
  background and paste its tail. (`bun test src test` is NOT a substitute: Bun's filter matches `ops/` too and the
  admin package's tests need their own `node_modules`.)
- T3b, T4, T5 and T6 touch guarded state (restart, announce's ready flag, the plugin host's write queue, `config`);
  every `finally`/`afterEach` above restores it, and the test-state guard fails the test that does not. A guard
  failure naming `src/restart.ts`, `src/announce.ts`, `src/plugins/host.ts` or `src/config.ts` after one of them is
  a cleanup bug in that test, not a flake.
- Paste the mutation table with the failing test name per row.

### Acceptance to paste per issue (the items have no `## Acceptance`; these are the outcomes they demand)

- **#504:** T1, T1b, T7 (+ the literal pin) pass lines; M1, M11, M13 failing output; the rewritten texts (quote the
  new `CONTEXT.md:165` fragments and the `commandNaming.ts` header); the note that `report.test.ts` has no
  `report.ts:<line>` cite left (the Grep result); the decision not to set `contexts`, with its reason.
- **#503 (items 10 and 11, command half):** T3, T3b, T4, T5, T6 pass lines; M3, M4, M6, M7, M8, M9 failing output.
  Say in the PR, and in a comment on #503, that items 2 and 3 remain for #505 (#526), that the issue's "a retry is
  refused as pending" was not true (`hasPending` gates `cancel` only), and that the issue stays open.

### PR

- Title: `fix(commands): answer an unclaimed command, refuse /report in a DM truthfully, request the restart before the reply, and log what /update and /plugins swallow (#504, #503)`.
- Body: one line per item, the decisions above (including the registration one), the typecheck + test output, the
  mutation table. End with `Closes #504.` on its own line; name #503 as "Part of #503 (items 10 and 11's command
  half)" -- no closing keyword.
- After merge: tick #504 on #530 (byte-exact; the body is CRLF); comment on #503 as above.
- No operator-visible change: nothing is re-registered differently; a user only sees the new refusals.

### Out of scope, on purpose

- #503 items 2 and 3 (the `/update` reply's 15-minute token window and clamp): with #505 under #526.
- Guild-only `contexts` on the core builders (above); a DM branch for `/update` and `/plugins`.
