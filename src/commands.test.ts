import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DiscordAPIError, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { expectCleanedLog, printed, replyFailure } from "../test/restError";
import type { PluginCommand } from "./plugins/contract";
import type { PluginCommandTarget } from "./plugins/host";

// `commands.ts` pulls in the `config` singleton, which resolves process.env at import time --
// the required vars are primed once by test/setup.ts's bunfig preload (#136).
const { isAdmin, bareName, updateReply, commandData, handleCommand, CORE_COMMANDS, CORE_COMMAND_NAMES, refuseUnlessAdmin, PLUGIN_NOT_RUNNING_REPLY } =
  await import("./commands");
const { buildCommandBody } = await import("./plugins/host");
/** A plugin command as handleCommand's lookup returns it (#407): owned by plugin "demo", running unless `running` says otherwise. */
const target = (command: PluginCommand, running: () => boolean = () => true): PluginCommandTarget => ({ plugin: "demo", command, running });
const { config } = await import("./config");
const { shortSha, DATA_DIR } = await import("./storage");
const { markPluginStateReady, resetPollStateForTest } = await import("./announce");
const { setExitFn, resetForTest: resetRestartForTest, restartPending, stateForTest, RESTART_EXIT_CODE, beginHandoff } = await import("./restart");
const { state: botState } = await import("./state");
const { resetUpdateForTest } = await import("./update");
const { HOST_API_VERSION } = await import("./plugins/contract");
const coreBodyFixture = await Bun.file(new URL("./fixtures/command-body.main.json", import.meta.url)).json();

describe("isAdmin", () => {
  test("accepts a user on the allowlist", () => {
    expect(isAdmin("111", ["111", "222"])).toBe(true);
    expect(isAdmin("222", ["111", "222"])).toBe(true);
  });

  test("rejects a user not on the allowlist", () => {
    expect(isAdmin("333", ["111", "222"])).toBe(false);
  });

  test("fails closed when no admins are configured", () => {
    expect(isAdmin("111", [])).toBe(false);
  });

  test("matches the whole id, not a prefix or substring", () => {
    expect(isAdmin("11", ["111"])).toBe(false);
    expect(isAdmin("1111", ["111"])).toBe(false);
  });
});

/** A non-admin chat-input interaction under `commandName`, capturing the private reply. */
function nonAdminInteraction(commandName: string, extra: Record<string, unknown> = {}) {
  const seen: { replied?: { content?: string }; deferred: boolean } = { deferred: false };
  const interaction = {
    commandName,
    user: { id: "999" },
    reply: async (o: { content?: string }) => {
      seen.replied = o;
    },
    deferReply: async () => {
      seen.deferred = true;
    },
    ...extra,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, seen };
}

describe("refuseUnlessAdmin (#206)", () => {
  // config.adminUserIds is empty in this test process (ADMIN_USER_IDS unset — see the file's own
  // top comment), so this exercises the no-admins-configured branch directly. The
  // configured-but-not-this-user branch below mutates the array IN PLACE (never reassigns the
  // `config` binding itself) and restores it in a `finally`, so it can't leak into another test.
  test("refuses with the no-admins-configured message, naming the command, when none are set", async () => {
    const { interaction, seen } = nonAdminInteraction("update");
    const refused = await refuseUnlessAdmin(interaction);
    expect(refused).toBe(true);
    expect(seen.replied?.content).toBe("⛔ No admins are configured — set `ADMIN_USER_IDS` to enable `/update`.");
  });

  // Every command is registered under COMMAND_PREFIX (commandNaming.ts), so on a `pip` instance the
  // user typed `/pipupdate` — and `/update` does not exist there. The refusal must name what was
  // typed. Mutation: reverting the interpolation to a literal `/update` (or `/plugins`) fails these.
  test("names the prefixed command the user typed, never the bare core name", async () => {
    for (const [typed, bare] of [
      ["pipupdate", "update"],
      ["pipplugins", "plugins"],
      ["rupdate", "update"],
      ["rplugins", "plugins"],
    ] as const) {
      const { interaction, seen } = nonAdminInteraction(typed);
      expect(await refuseUnlessAdmin(interaction)).toBe(true);
      expect(seen.replied?.content).toBe(`⛔ No admins are configured — set \`ADMIN_USER_IDS\` to enable \`/${typed}\`.`);
      expect(seen.replied?.content).not.toContain(`\`/${bare}\``);
    }
  });

  test("refuses with the not-allowed message when admins ARE configured but this user isn't one", async () => {
    config.adminUserIds.push("111");
    try {
      const { interaction, seen } = nonAdminInteraction("pipplugins");
      const refused = await refuseUnlessAdmin(interaction);
      expect(refused).toBe(true);
      expect(seen.replied?.content).toBe("⛔ You're not allowed to run this.");
    } finally {
      config.adminUserIds.length = 0;
    }
  });

  test("returns false and does not reply for an admin", async () => {
    config.adminUserIds.push("111");
    try {
      let replyCalled = false;
      const interaction = {
        commandName: "update",
        user: { id: "111" },
        reply: async () => {
          replyCalled = true;
        },
      } as unknown as ChatInputCommandInteraction;
      const refused = await refuseUnlessAdmin(interaction);
      expect(refused).toBe(false);
      expect(replyCalled).toBe(false);
    } finally {
      config.adminUserIds.length = 0;
    }
  });
});

// The consumer boundary: each admin-gated row's own `handle`, driven directly with a PREFIXED
// interaction. `handleCommand` can't carry one here — COMMAND_PREFIX is empty in this test process,
// so `bareName("pipupdate")` finds no core row — but the rows' handlers are what a prefixed instance
// actually runs once dispatch has stripped the prefix, and the refusal text comes from inside them.
// A prefix-stripping slip (`bareName(interaction.commandName)`) is invisible here, where the module
// prefix is ""; src/commandPrefix.test.ts runs the same refusals under a real prefix and catches it.
describe("the admin-gated core rows under a COMMAND_PREFIX", () => {
  for (const [row, typed] of [
    ["update", "pipupdate"],
    ["plugins", "pipplugins"],
    ["update", "rupdate"],
    ["plugins", "rplugins"],
  ] as const) {
    test(`the ${row} row refuses /${typed} by that name, before any deferReply`, async () => {
      const handle = CORE_COMMANDS.find((c) => c.name === row)!.handle;
      const { interaction, seen } = nonAdminInteraction(typed, { options: { getSubcommand: () => "list" } });
      await handle(interaction);
      expect(seen.replied?.content).toBe(`⛔ No admins are configured — set \`ADMIN_USER_IDS\` to enable \`/${typed}\`.`);
      expect(seen.replied?.content).not.toContain(`\`/${row}\``);
      expect(seen.deferred).toBe(false);
    });
  }
});

describe("bareName", () => {
  test("strips the configured prefix", () => {
    expect(bareName("r_dmf", "r_")).toBe("dmf");
    expect(bareName("r_status", "r_")).toBe("status");
  });

  test("is a no-op when no prefix is configured", () => {
    expect(bareName("dmf", "")).toBe("dmf");
    expect(bareName("status", "")).toBe("status");
  });

  // The bug this guards: dispatch used to slice(prefix.length) unconditionally, so a command
  // registered without the prefix became "update" -> "date" and matched no case — it showed up
  // in Discord and silently did nothing.
  test("passes an unprefixed name through instead of mangling it", () => {
    expect(bareName("update", "r_")).toBe("update");
    expect(bareName("report", "r_")).toBe("report");
  });

  test("leaves a name that merely shares a leading letter alone", () => {
    expect(bareName("reset", "r_")).toBe("reset");
  });

  test("strips only the first occurrence", () => {
    expect(bareName("r_r_dmf", "r_")).toBe("r_dmf");
  });
});

describe("updateReply", () => {
  const SHA = "b".repeat(40);

  test("names the build it is restarting to pick up", () => {
    expect(updateReply("restart", SHA)).toContain(shortSha(SHA));
  });

  // The bot now answers this itself, with a follow-up naming the build it landed on —
  // handing the verification back to the user was the whole complaint in nazumods/wow#681.
  test("no longer asks the user to check whether the build changed", () => {
    const reply = updateReply("restart", SHA);
    expect(reply).not.toContain("same build");
    expect(reply).toContain("report back");
  });

  test("reports disabled and current without promising a follow-up", () => {
    expect(updateReply("disabled", "")).toContain("GIT_SHA");
    expect(updateReply("current", SHA)).toContain("latest build");
  });

  // nazumods/wow#871: `disabled` has two causes now, and they ask different things of the operator.
  test("names the unpublished sha rather than blaming a missing GIT_SHA", () => {
    const running = "def4567890abcdef";
    const reply = updateReply("disabled", "", { runningSha: running, reason: "unpublished-sha" });
    expect(reply).toContain("def4567");
    expect(reply).not.toContain("no `GIT_SHA`");
  });

  test("still blames a missing GIT_SHA when that's the reason", () => {
    expect(updateReply("disabled", "", { reason: "no-sha" })).toContain("no `GIT_SHA`");
  });

  test("names the running build, not the target, when already current", () => {
    expect(updateReply("current", SHA, { runningSha: "abc1234567" })).toContain("abc1234");
  });

  // #449 (C1): the refused caller is never recorded (checkForUpdate answers `busy` before it reads the requester), so
  // nothing is promised to them, the wait is not called short (a build runs up to 15 minutes), and the command is
  // named as this instance registered it (`interaction.commandName`, prefix included), never a bare `/update`.
  // Mutations: the old text back (`I'll report`); "or restart" or the closing clause dropped; a literal `/update` for
  // the interpolation. (`in a minute` is the plan's guard against ever calling the wait short.)
  test("a second /update is refused without promising a report, naming the command as registered", () => {
    const reply = updateReply("busy", "", { commandName: "pipupdate" });
    expect(reply).toContain("An update or restart is already in progress");
    expect(reply).toContain("once it has finished");
    expect(reply).toContain("/pipupdate that started it reports back to whoever ran it");
    expect(reply).not.toContain("I'll report");
    expect(reply).not.toContain("in a minute");
    expect(reply).not.toContain("Restarting");
    expect(reply).not.toContain("/update ");
    expect(updateReply("busy", "")).toContain("a /update that started it");
  });

  // A redeploy result present at all is a failed swap — the successful path never returns.
  test("a failed swap reports the failure instead of promising a restart", () => {
    const reply = updateReply("restart", SHA, { redeploy: { outcome: "failed", error: "build failed" } });
    expect(reply).toContain("build failed");
    expect(reply).not.toContain("report back");
  });

  test("a stalled swap gets the stall wording, not the generic failure", () => {
    expect(updateReply("restart", SHA, { redeploy: { outcome: "stalled" } })).toContain("verified");
  });

  // #451: the reply says what became of the `-next` container, and a timeout names the daemon's last error.
  test("the /update failure reply says what became of the replacement", () => {
    expect(updateReply("restart", SHA, { redeploy: { outcome: "failed", replacement: "left" } })).toContain(
      "left it alone",
    );
    const timeout = updateReply("restart", SHA, {
      redeploy: { outcome: "timeout", replacement: "removed", error: "docker inspect x failed: 500" },
    });
    expect(timeout).toContain("removed it");
    expect(timeout).toContain("last daemon error: docker inspect x failed: 500");
    expect(updateReply("restart", SHA, { redeploy: { outcome: "failed", replacement: "none" } })).not.toContain(
      "removed it",
    );
    const refused = updateReply("restart", SHA, {
      redeploy: { outcome: "failed", replacement: "remove-failed", replacementError: "409" },
    });
    expect(refused).toContain("could not remove it");
    expect(refused).toContain("409");
  });

  // #505 item 7 (1c): a failed or timed-out swap's text puts the daemon's errors in front of the verdict and of the
  // operator instruction (a stalled one's puts the error last), so each is bounded to DAEMON_ERROR_MAX (600, plus
  // clampReply's one-character suffix) before it is interpolated: a 3000-character error and a 3000-character
  // `replacementError` still leave a reply Discord accepts. The C2 test drives the `error` clause through the handler;
  // this pins both clauses in every outcome, with different characters per field so a clamp reading the wrong field is
  // caught. Mutations: either clamp dropped (the reply is over 3000 units); one reading the other field's text;
  // DAEMON_ERROR_MAX raised or lowered.
  test("a long daemon error in any clause is bounded, so the verdict and the operator instruction survive", () => {
    const error = "e".repeat(3000);
    const replacementError = "r".repeat(3000);
    for (const outcome of ["failed", "timeout", "stalled"] as const) {
      const reply = updateReply("restart", SHA, {
        redeploy: { outcome, error, replacement: "remove-failed", replacementError },
      });
      expect(reply.length, outcome).toBeLessThan(1500);
      expect(reply, outcome).toContain(`${"e".repeat(600)}…`);
      expect(reply, outcome).toContain(`${"r".repeat(600)}…`);
      expect(reply, outcome).not.toContain("e".repeat(601));
      expect(reply, outcome).not.toContain("r".repeat(601));
      expect(reply, outcome).toContain("remove the `-next` container by hand. I stayed on the current build.");
    }
    // `failed` (and `timeout`) put the verdict last.
    const failed = updateReply("restart", SHA, {
      redeploy: { outcome: "failed", error, replacement: "remove-failed", replacementError },
    });
    expect(failed.endsWith("I stayed on the current build.")).toBe(true);
  });
});

describe("commandData", () => {
  // #100 removed the baked-in connector: /link and /unlink are now the warbandeer plugin's, not
  // core. Pin that they are gone from the core registration (the plugin adds them back when loaded).
  test("no longer contains the connector's /link or /unlink", () => {
    expect(commandData.map((c) => c.name)).not.toContain("link");
    expect(commandData.map((c) => c.name)).not.toContain("unlink");
  });

  // #107 moved the WoW features into @rackbops/plugin-wow: /dmf /reset /status /transmog are no longer
  // core (the plugin registers them when loaded). Pin the exact surviving core set so leaving any WoW
  // builder behind fails here (a leftover handler `case` would instead fail the typecheck — its WoW
  // imports are gone).
  test("is exactly the three core commands, with no WoW commands", () => {
    expect(commandData.map((c) => c.name)).toEqual(["report", "update", "plugins"]);
    for (const gone of ["dmf", "reset", "status", "transmog"]) {
      expect(commandData.map((c) => c.name)).not.toContain(gone);
    }
  });
});

describe("CORE_COMMANDS table (#206)", () => {
  test("registers exactly the three core commands, prefixed once", () => {
    expect(commandData.map((c) => c.name)).toEqual(["report", "update", "plugins"]);
    // COMMAND_PREFIX is empty in this test process, so bareName is a round-trip identity — proves
    // the prefix was applied exactly once (build(cmd(c.name))), not zero or twice.
    for (const c of commandData) expect(bareName(c.name)).toBe(c.name);
  });

  test("CORE_COMMAND_NAMES is derived from the table, not hand-listed", () => {
    expect(CORE_COMMAND_NAMES).toEqual(CORE_COMMANDS.map((c) => c.name));
  });

  // Found in review: COMMAND_PREFIX is empty in this test process (config resolves it once, at
  // import, from this process's actual env — see the file's own top comment), so nothing here can
  // exercise `commandData`'s own `cmd(c.name)` call site under a NON-empty prefix without a fresh
  // module import under different env, which this codebase's config-singleton architecture doesn't
  // support without a broader change out of scope for this issue. `bun run check`'s
  // `noUnusedLocals` is the real backstop for that specific call site today — `cmd` has exactly one
  // use (`commandData`'s own line), so bypassing it with a raw, unprefixed
  // `new SlashCommandBuilder()` leaves `cmd` unused and fails the typecheck (verified directly: TS6133
  // on `cmd`). This test covers the other, independently-testable half of the same property — that
  // each row's `build` genuinely HONORS whatever already-namespaced builder it's handed, rather than
  // hardcoding a bare one internally — using the real `commandNamer` with a non-empty prefix. (The
  // fresh-import route this comment calls out of scope exists now, as a child process:
  // src/commandPrefix.test.ts checks the real `commandData` names under `pip` and `r`.)
  test("each row's build() honors an externally-namespaced builder (non-empty prefix)", async () => {
    const { commandNamer } = await import("./commandNaming");
    const prefixed = commandNamer("r_");
    const built = CORE_COMMANDS.map((c) => c.build(prefixed(c.name)).toJSON());
    expect(built.map((c) => c.name)).toEqual(["r_report", "r_update", "r_plugins"]);
  });

  test("dispatch reaches the table row's handle for each core name", async () => {
    for (const row of CORE_COMMANDS) {
      const spy = spyOn(row, "handle").mockImplementation(async () => {});
      let lookupCalled = false;
      const interaction = { commandName: row.name, user: { id: "x" } } as unknown as ChatInputCommandInteraction;
      try {
        await handleCommand(interaction, () => {
          lookupCalled = true;
          return undefined;
        });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[0]).toBe(interaction);
        expect(lookupCalled).toBe(false); // a core row is found first — lookup is never consulted
      } finally {
        spy.mockRestore();
      }
    }
  });

  // Mirrors pluginCommandMap's own collision rule (host.ts): a core command wins over a
  // same-named plugin one, never the other way around.
  test("a core name shadows a plugin command of the same bare name", async () => {
    const reportRow = CORE_COMMANDS.find((c) => c.name === "report")!;
    const spy = spyOn(reportRow, "handle").mockImplementation(async () => {});
    let pluginHandleCalled = false;
    try {
      const pluginCommand = {
        name: "report",
        handle: async () => {
          pluginHandleCalled = true;
        },
      } as unknown as PluginCommand;
      const interaction = { commandName: "report" } as unknown as ChatInputCommandInteraction;
      await handleCommand(interaction, (bare) => (bare === "report" ? target(pluginCommand) : undefined));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(pluginHandleCalled).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("handleCommand — plugin dispatch (default case)", () => {
  test("dispatches a non-core command to the looked-up plugin handler", async () => {
    let handledName: string | undefined;
    const pluginCommand = { name: "hello", handle: async (i: ChatInputCommandInteraction) => { handledName = i.commandName; } } as unknown as PluginCommand;
    await handleCommand({ commandName: "hello" } as unknown as ChatInputCommandInteraction, (bare) => (bare === "hello" ? target(pluginCommand) : undefined));
    expect(handledName).toBe("hello");
  });

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
});

// #243: a plugin's commands run only in the channels its routing lists. The decision is the gate's
// (routing/gate.ts); what is pinned here is what handleCommand does with its answer.
describe("handleCommand — the channel gate (#243)", () => {
  const plugin = () => {
    const state = { handled: 0 };
    const command = { name: "hello", handle: async () => void (state.handled += 1) } as unknown as PluginCommand;
    return { state, lookup: (bare: string) => (bare === "hello" ? target(command) : undefined) };
  };
  const chatInput = () => {
    const replies: unknown[] = [];
    const interaction = {
      commandName: "hello",
      reply: async (options: unknown) => void replies.push(options),
    } as unknown as ChatInputCommandInteraction;
    return { interaction, replies };
  };

  test("a core command never consults the gate", async () => {
    const reportRow = CORE_COMMANDS.find((c) => c.name === "report")!;
    const handle = spyOn(reportRow, "handle").mockImplementation(async () => {});
    try {
      let consulted = 0;
      const gate = async () => {
        consulted += 1;
        return "refused";
      };
      const { interaction, replies } = chatInput();
      (interaction as unknown as { commandName: string }).commandName = "report";
      // Even a plugin that claims the same name (the core row wins) is never put to the gate.
      await handleCommand(interaction, () => target({ name: "report", handle: async () => {} } as unknown as PluginCommand), gate);
      expect(handle).toHaveBeenCalledTimes(1);
      expect(consulted).toBe(0);
      expect(replies).toEqual([]);
    } finally {
      handle.mockRestore();
    }
  });

  test("a refused plugin command gets a private reply and its handler is not called", async () => {
    const { state, lookup } = plugin();
    const { interaction, replies } = chatInput();
    expect(await handleCommand(interaction, lookup, async () => "`/hello` works in <#1> here.")).toBe("gated");
    expect(replies).toEqual([{ content: "`/hello` works in <#1> here.", flags: MessageFlags.Ephemeral }]);
    expect(state.handled).toBe(0);
  });

  test("an allowed plugin command runs, and the gate is asked with the bare name and the interaction", async () => {
    const { state, lookup } = plugin();
    const { interaction, replies } = chatInput();
    const asked: unknown[][] = [];
    await handleCommand(interaction, lookup, async (...args) => {
      asked.push(args);
      return undefined;
    });
    expect(state.handled).toBe(1);
    expect(replies).toEqual([]);
    expect(asked).toEqual([["hello", interaction]]);
  });

  test("with no gate argument a plugin command runs", async () => {
    const { state, lookup } = plugin();
    const { interaction, replies } = chatInput();
    expect(await handleCommand(interaction, lookup)).toBe("answered");
    expect(state.handled).toBe(1);
    expect(replies).toEqual([]);
  });

  test("a gate that throws lets the command run, and says so", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { state, lookup } = plugin();
      const { interaction, replies } = chatInput();
      await handleCommand(interaction, lookup, async () => Promise.reject(new Error("EIO")));
      expect(state.handled).toBe(1);
      expect(replies).toEqual([]);
      expect(String(error.mock.calls[0]?.[0])).toContain("[gate] could not decide whether /hello may run here");
    } finally {
      error.mockRestore();
    }
  });

  test("the gate is asked with the BARE name: the plugin is found by it, and a prefixed name would find none", async () => {
    // COMMAND_PREFIX is empty under test, so the two names are equal here and a behavioural test cannot
    // tell them apart; the source can. `index.ts` looks the owning plugin up by this name.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./commands.ts", import.meta.url), "utf8");
    expect(source).toContain("await gate(bare, interaction)");
    expect(source).not.toMatch(/gate\(interaction\.commandName/);
  });

  test("a command no plugin owns is not put to the gate", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let consulted = 0;
      const { interaction } = chatInput();
      await handleCommand(interaction, () => undefined, async () => {
        consulted += 1;
        return undefined;
      });
      expect(consulted).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

// #407: a plugin's slash commands get the same `running` gate as its ticks, HTTP routes and component,
// modal and autocomplete handlers, and a throw from the plugin's handler is isolated the same way a
// component's is (host.ts's dispatchPluginInteractionOutcome).
describe("handleCommand — the plugin's running gate and a throwing handler (#407)", () => {
  const chatInput = (over: Partial<{ replied: boolean; deferred: boolean; reply: (o: unknown) => Promise<unknown> }> = {}) => {
    const replies: unknown[] = [];
    const interaction = {
      commandName: "hello",
      replied: false,
      deferred: false,
      reply: async (options: unknown) => void replies.push(options),
      ...over,
    } as unknown as ChatInputCommandInteraction;
    return { interaction, replies };
  };
  const quiet = () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    return { warn, error, restore: () => (warn.mockRestore(), error.mockRestore()) };
  };

  test("a command whose plugin is not running is refused privately, before the gate, and its handler never runs", async () => {
    const logs = quiet();
    try {
      let handled = 0;
      let consulted = 0;
      const command = { name: "hello", handle: async () => void (handled += 1) } as unknown as PluginCommand;
      const { interaction, replies } = chatInput();
      const outcome = await handleCommand(interaction, () => target(command, () => false), async () => {
        consulted += 1;
        return undefined;
      });
      expect(outcome).toBe("unclaimed");
      expect(replies).toEqual([{ content: PLUGIN_NOT_RUNNING_REPLY, flags: MessageFlags.Ephemeral }]);
      expect(handled).toBe(0);
      expect(consulted).toBe(0); // no routing read or channel fetch for a plugin that can't run anyway
      expect(logs.warn.mock.calls.map((c) => String(c[0]))).toEqual(["[plugins] demo: /hello refused — the plugin is not running"]);
    } finally {
      logs.restore();
    }
  });

  test("running is read again after the gate: a plugin that stopped while the gate was awaited is refused", async () => {
    const logs = quiet();
    try {
      let running = true;
      let handled = 0;
      const command = { name: "hello", handle: async () => void (handled += 1) } as unknown as PluginCommand;
      const { interaction, replies } = chatInput();
      const outcome = await handleCommand(interaction, () => target(command, () => running), async () => {
        running = false; // e.g. disposePlugins began while the gate fetched the channel
        return undefined;
      });
      expect(outcome).toBe("unclaimed");
      expect(replies).toEqual([{ content: PLUGIN_NOT_RUNNING_REPLY, flags: MessageFlags.Ephemeral }]);
      expect(handled).toBe(0);
    } finally {
      logs.restore();
    }
  });

  test("the refusal says the command is unavailable, in words: never an empty reply Discord would reject", () => {
    expect(PLUGIN_NOT_RUNNING_REPLY).toBe("This command isn't available right now.");
  });

  test("a refusal Discord rejects is not swallowed: it reaches index.ts's catch, as the gate's own refusal does", async () => {
    const logs = quiet();
    try {
      const expired = new Error("Unknown interaction");
      const command = { name: "hello", handle: async () => {} } as unknown as PluginCommand;
      const { interaction } = chatInput({ reply: async () => Promise.reject(expired) });
      await expect(handleCommand(interaction, () => target(command, () => false))).rejects.toBe(expired);
    } finally {
      logs.restore();
    }
  });

  test("the handler is called on its command object, with the interaction", async () => {
    const calls: [unknown, unknown][] = [];
    const command = {
      name: "hello",
      async handle(this: unknown, i: unknown) {
        calls.push([this, i]);
      },
    } as unknown as PluginCommand;
    const { interaction } = chatInput();
    await handleCommand(interaction, () => target(command));
    expect(calls).toEqual([[command, interaction]]);
  });

  test("a running plugin's command still runs and is answered", async () => {
    let handled = 0;
    const command = { name: "hello", handle: async () => void (handled += 1) } as unknown as PluginCommand;
    const { interaction, replies } = chatInput();
    expect(await handleCommand(interaction, () => target(command))).toBe("answered");
    expect(handled).toBe(1);
    expect(replies).toEqual([]);
  });

  test("a handler that throws is isolated: logged by plugin and command, answered privately, reported as an error", async () => {
    const logs = quiet();
    try {
      const boom = new Error("state not initialised");
      const command = { name: "hello", handle: async () => Promise.reject(boom) } as unknown as PluginCommand;
      const { interaction, replies } = chatInput();
      expect(await handleCommand(interaction, () => target(command))).toBe("error");
      expect(replies).toEqual([{ content: "Something went wrong.", flags: MessageFlags.Ephemeral }]);
      expect(logs.error.mock.calls).toEqual([["[plugins] demo command /hello failed", boom]]);
    } finally {
      logs.restore();
    }
  });

  // #545: a command whose reply Discord refuses (10062, 40060) throws a REST error whose `url` is the
  // interaction's token and whose `requestBody` is the reply -- neither belongs in the log, in either format.
  test("a REST error from the reply is logged without the interaction token or the reply (#545)", async () => {
    const logs = quiet();
    try {
      const failure = replyFailure();
      expect(printed([failure.error]).join("\n")).toContain(failure.token); // the control: the uncleaned error prints the token
      const command = { name: "hello", handle: async () => Promise.reject(failure.error) } as unknown as PluginCommand;
      const { interaction, replies } = chatInput();
      expect(await handleCommand(interaction, () => target(command))).toBe("error");
      expect(replies).toEqual([{ content: "Something went wrong.", flags: MessageFlags.Ephemeral }]);
      expect(logs.error.mock.calls).toHaveLength(1);
      const call = logs.error.mock.calls[0]!;
      expect(call[0]).toBe("[plugins] demo command /hello failed");
      expectCleanedLog(call, failure);
    } finally {
      logs.restore();
    }
  });

  // The same on Bun when the reply never reached Discord: a bare TypeError whose `path` is the request URL.
  test("a network failure from the reply is logged without the interaction token either (#545)", async () => {
    const logs = quiet();
    try {
      const { token } = replyFailure();
      const failure = Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), {
        code: "ConnectionRefused",
        path: `https://discord.com/api/v10/interactions/1/${token}/callback`,
      });
      expect(printed([failure]).join("\n")).toContain(token); // the control
      const command = { name: "hello", handle: async () => Promise.reject(failure) } as unknown as PluginCommand;
      const { interaction } = chatInput();
      expect(await handleCommand(interaction, () => target(command))).toBe("error");
      const call = logs.error.mock.calls[0]!;
      expect(printed(call).join("\n")).not.toContain(token);
      expect((call[1] as { code?: string }).code).toBe("ConnectionRefused");
    } finally {
      logs.restore();
    }
  });

  // The cleaner runs inside this catch: an error it cannot even read must not cost the user's reply.
  test("a handler that throws an error with a throwing accessor is still isolated, logged and answered (#545)", async () => {
    const logs = quiet();
    try {
      const hostile = new Error("hostile");
      Object.defineProperty(hostile, "cause", { get: () => { throw new Error("accessor"); } });
      const command = { name: "hello", handle: async () => Promise.reject(hostile) } as unknown as PluginCommand;
      const { interaction, replies } = chatInput();
      expect(await handleCommand(interaction, () => target(command))).toBe("error");
      expect(replies).toEqual([{ content: "Something went wrong.", flags: MessageFlags.Ephemeral }]);
      expect(logs.error.mock.calls).toHaveLength(1);
      expect(String((logs.error.mock.calls[0]![1] as Error).message)).toContain("could not be inspected safely");
    } finally {
      logs.restore();
    }
  });

  test("a handler that throws synchronously is isolated the same way", async () => {
    const logs = quiet();
    try {
      const command = {
        name: "hello",
        handle: () => {
          throw new Error("sync");
        },
      } as unknown as PluginCommand;
      const { interaction, replies } = chatInput();
      expect(await handleCommand(interaction, () => target(command))).toBe("error");
      expect(replies).toEqual([{ content: "Something went wrong.", flags: MessageFlags.Ephemeral }]);
    } finally {
      logs.restore();
    }
  });

  test("a handler that replied or deferred before throwing keeps its reply flow: no second reply", async () => {
    const logs = quiet();
    try {
      const command = { name: "hello", handle: async () => Promise.reject(new Error("late")) } as unknown as PluginCommand;
      for (const over of [{ replied: true }, { deferred: true }]) {
        const { interaction, replies } = chatInput(over);
        expect(await handleCommand(interaction, () => target(command))).toBe("error");
        expect(replies).toEqual([]);
      }
    } finally {
      logs.restore();
    }
  });

  test("a failed \"Something went wrong.\" reply is swallowed: still an error, never a throw", async () => {
    const logs = quiet();
    try {
      const command = { name: "hello", handle: async () => Promise.reject(new Error("boom")) } as unknown as PluginCommand;
      const { interaction } = chatInput({ reply: async () => Promise.reject(new Error("Unknown interaction")) });
      expect(await handleCommand(interaction, () => target(command))).toBe("error");
    } finally {
      logs.restore();
    }
  });

  test("a core command's throw is not caught here: it still reaches index.ts's own catch", async () => {
    const reportRow = CORE_COMMANDS.find((c) => c.name === "report")!;
    const boom = new Error("core");
    const handle = spyOn(reportRow, "handle").mockImplementation(async () => Promise.reject(boom));
    try {
      const { interaction } = chatInput();
      (interaction as unknown as { commandName: string }).commandName = "report";
      await expect(handleCommand(interaction)).rejects.toBe(boom);
    } finally {
      handle.mockRestore();
    }
  });
});

// Found in review: nothing dispatched "/update" through the real handleCommand at all before this
// — only "/plugins" had a non-admin dispatch test. Since the refusal names the command from
// `interaction.commandName`, a non-admin refusal reads the same whichever row's body runs, so the
// row-swap guard lives in src/commandPrefix.test.ts instead: there each admin-gated row, run as an
// admin in a fresh process, does something only its own body does.
describe("handleCommand — /update", () => {
  /** A running sha past the "disabled" early return, so a check goes on to fetch. */
  const RUNNING_SHA = "0123456789abcdef0123456789abcdef01234567";

  /** Run `fn` as the admin `999` on a build baked with `gitSha`, restoring both (in place: `config` is a shared singleton). */
  async function asAdmin<T>(gitSha: string, fn: () => Promise<T>): Promise<T> {
    const realSha = config.gitSha;
    config.adminUserIds.push("999");
    config.gitSha = gitSha;
    try {
      return await fn();
    } finally {
      config.gitSha = realSha;
      config.adminUserIds.splice(config.adminUserIds.indexOf("999"), 1);
    }
  }

  /**
   * Admin `999`'s `/update` interaction, recording every edit and DM that LANDS and counting every attempt. The first
   * `editFails` edits reject with `failure.error` (a reply Discord refuses); the DM rejects with `dmError` (else the
   * same error) when `dmFails`.
   */
  function adminUpdate(
    o: {
      commandName?: string;
      failure?: { error: unknown };
      editFails?: number;
      dmFails?: boolean;
      dmError?: unknown;
      /** Make the DM take this long, and record the order of the refused edit and the DM into `events`. */
      sendDelayMs?: number;
      events?: string[];
    } = {},
  ) {
    const edits: string[] = [];
    const dms: string[] = [];
    const calls = { edit: 0, dm: 0 };
    const interaction = {
      commandName: o.commandName ?? "update",
      user: {
        id: "999",
        send: async (content: string) => {
          calls.dm += 1;
          o.events?.push("dm-start");
          if (o.sendDelayMs) await Bun.sleep(o.sendDelayMs);
          if (o.dmFails) throw o.dmError ?? o.failure!.error;
          dms.push(content);
          o.events?.push("dm-done");
        },
      },
      channelId: "c1",
      applicationId: "app",
      token: "tok",
      deferReply: async () => {},
      editReply: async (content: string) => {
        calls.edit += 1;
        if (calls.edit <= (o.editFails ?? 0)) {
          o.events?.push("edit-refused");
          throw o.failure!.error;
        }
        edits.push(content);
      },
    } as unknown as ChatInputCommandInteraction;
    return { interaction, edits, dms, calls };
  }

  test("refuses a non-admin before any deferReply / update check", async () => {
    const { interaction, seen } = nonAdminInteraction("update");
    await handleCommand(interaction);
    expect(seen.replied?.content).toBe("⛔ No admins are configured — set `ADMIN_USER_IDS` to enable `/update`.");
    expect(seen.deferred).toBe(false);
  });

  // T4
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

  // C5: the first catch's `withoutRequest` stays guarded. Before #503 item 2 the test below (C4) was the only one that
  // passed a token-carrying error through that catch; the check itself failing with a reply-shaped error is now its
  // own case. Mutation: logging the raw error in `[update] /update failed` leaks the interaction token.
  test("a failed check whose error carries the request is logged without the token (#545)", async () => {
    const failure = replyFailure("webhook");
    const { interaction, edits, dms } = adminUpdate();
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw failure.error;
    }) as unknown as typeof fetch);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await asAdmin(RUNNING_SHA, async () => {
        expect(await handleCommand(interaction)).toBe("answered");
      });
      expect(edits).toEqual(["⚠️ Update check failed: Unknown interaction"]);
      expect(dms).toEqual([]);
      const failed = warn.mock.calls.find(([m]: unknown[]) => String(m) === "[update] /update failed");
      expect(failed).toBeDefined();
      expectCleanedLog(failed!, failure);
    } finally {
      warn.mockRestore();
      fetchSpy.mockRestore();
      resetUpdateForTest();
    }
  });

  // C5: the failure text is clamped too (clampReply's 1900 plus its one-character suffix). Mutation: dropping that
  // clamp edits 3000+ characters, which Discord rejects.
  test("a failed check's text is clamped before it is edited in", async () => {
    const { interaction, edits } = adminUpdate();
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("y".repeat(3000));
    }) as unknown as typeof fetch);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await asAdmin(RUNNING_SHA, async () => {
        expect(await handleCommand(interaction)).toBe("answered");
      });
      expect(edits).toHaveLength(1);
      expect(edits[0]!.length).toBe(1901);
      expect(edits[0]!.endsWith("…")).toBe(true);
    } finally {
      warn.mockRestore();
      fetchSpy.mockRestore();
      resetUpdateForTest();
    }
  });

  // C4 (#503 item 2): a build can run 15 minutes (docker.ts's BUILD_TIMEOUT_MS) and Discord accepts the reply to the
  // command for 15, so the reply to a long failed swap can arrive after the token died. The reply is sent to the
  // requester by DM instead (the check did NOT fail, so `[update] /update failed` is not logged); a DM that fails too
  // rejects out, as the double failure always did, so index.ts's catch logs it. The log carries neither the token nor
  // the reply (#545). The DM's failure is a different error from the edit's, so which one rejects out is pinned too.
  // Mutations: no fallback (the handler rejects instead of answering, nothing is sent); a second `editReply` instead of
  // the DM; a swallowed DM failure (resolves instead of rejecting); the edit's error rethrown in place of the DM's; the
  // raw error in the warn.
  test("a /update whose reply Discord rejects is sent by DM, logged without the token; a DM that fails too rejects out (#503 item 2)", async () => {
    for (const dmFails of [false, true]) {
      const failure = replyFailure("webhook");
      const dmError = new Error("Cannot send messages to this user");
      const { interaction, edits, dms, calls } = adminUpdate({ failure, editFails: 1, dmFails, dmError });
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await asAdmin("", async () => {
          // config.gitSha = "": `disabled`, so no fetch and a reply to send.
          if (dmFails) await expect(handleCommand(interaction)).rejects.toBe(dmError);
          else expect(await handleCommand(interaction)).toBe("answered");
        });
        expect(edits).toEqual([]);
        expect(calls).toEqual({ edit: 1, dm: 1 });
        expect(dms).toEqual(dmFails ? [] : ["⚠️ Self-update is disabled — this build has no `GIT_SHA` baked in."]);
        const refused = warn.mock.calls.find(
          ([m]: unknown[]) => String(m) === "[update] /update: the reply was refused — sending it by DM",
        );
        expect(refused).toBeDefined();
        expectCleanedLog(refused!, failure);
        expect(warn.mock.calls.some(([m]: unknown[]) => String(m) === "[update] /update failed")).toBe(false);
      } finally {
        warn.mockRestore();
      }
    }
  });

  // Decision 4: the DM is the fallback for EVERY refused edit, not only Discord's "unknown interaction": a network
  // failure, a 5xx, a rate limit or another Discord code can leave the requester without a reply just the same.
  // Mutation: the fallback guarded on the error's Discord code (10062) or on its being a number.
  test("a reply that fails for any reason, not only an expired token, is sent by DM", async () => {
    const url = "https://discord.com/api/v10/webhooks/2/token-x";
    const reasons: unknown[] = [
      new Error("socket hang up"),
      Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" }),
      new DiscordAPIError({ message: "Invalid Webhook Token", code: 50027 }, 50027, 401, "PATCH", url, { body: {}, files: undefined }),
      new DiscordAPIError({ message: "Service Unavailable", code: 0 }, 0, 503, "PATCH", url, { body: {}, files: undefined }),
    ];
    for (const error of reasons) {
      const { interaction, edits, dms, calls } = adminUpdate({ failure: { error }, editFails: 1 });
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await asAdmin("", async () => {
          expect(await handleCommand(interaction)).toBe("answered");
        });
        expect(edits).toEqual([]);
        expect(calls).toEqual({ edit: 1, dm: 1 });
        expect(dms).toEqual(["⚠️ Self-update is disabled — this build has no `GIT_SHA` baked in."]);
      } finally {
        warn.mockRestore();
      }
    }
  });

  // The DM carries exactly what the edit would have, at its longest: the clamped failure text (1901 units, the longest
  // reply the handler can build). Mutation: a DM cut shorter than the clamped reply.
  test("a refused reply goes by DM whole, at its longest", async () => {
    const { interaction, edits, dms } = adminUpdate({ failure: replyFailure("webhook"), editFails: 1 });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("y".repeat(3000));
    }) as unknown as typeof fetch);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await asAdmin(RUNNING_SHA, async () => {
        expect(await handleCommand(interaction)).toBe("answered");
      });
      expect(edits).toEqual([]);
      expect(dms).toHaveLength(1);
      expect(dms[0]!.length).toBe(1901);
      expect(dms[0]!.startsWith("⚠️ Update check failed: yyy")).toBe(true);
    } finally {
      warn.mockRestore();
      fetchSpy.mockRestore();
      resetUpdateForTest();
    }
  });

  // Decision 2: with no daemon socket the restart is requested INSIDE the handler's critical section and its exit fires
  // when that section closes, so a DM sent because the edit was refused is awaited FIRST (a delayed DM makes the order
  // observable). Mutations: the section dropped (the exit fires at the request, before the edit); the DM not awaited.
  test("on the exit-75 path the DM is delivered before the restart exits the process", async () => {
    const events: string[] = [];
    const { interaction, dms } = adminUpdate({ failure: replyFailure("webhook"), editFails: 1, events, sendDelayMs: 30 });
    const restoreExit = setExitFn((code) => void events.push(`exit ${code}`));
    const realFetch = globalThis.fetch;
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/commits?")) return new Response(JSON.stringify([{ sha: "2".repeat(40) }]), { status: 200 });
      if (url.includes("/compare/")) return new Response(JSON.stringify({ status: "behind" }), { status: 200 });
      throw new Error(`no docker daemon in this test: ${url}`); // /_ping: daemonReachable() is false, so the exit-75 fallback
    }) as unknown as typeof fetch;
    try {
      await asAdmin(RUNNING_SHA, async () => {
        expect(await handleCommand(interaction)).toBe("answered");
      });
      expect(events).toEqual(["edit-refused", "dm-start", "dm-done", `exit ${RESTART_EXIT_CODE}`]);
      expect(dms).toHaveLength(1);
      expect(dms[0]).toContain("Restarting to pick up");
    } finally {
      globalThis.fetch = realFetch;
      restoreExit();
      log.mockRestore();
      warn.mockRestore();
      botState.attemptedUpdateToSha = undefined;
      botState.pendingUpdateReport = undefined;
      resetRestartForTest();
      resetUpdateForTest();
    }
  });

  // C2 (#505 item 7 / #503 item 3, end to end): the daemon calls are plain `fetch` and the self-inspect reads
  // process.env.HOSTNAME, so a failed build is driven through the real handler, `checkForUpdate` and `redeploy`.
  // `handoffFailureMessage` puts the daemon's error first and the verdict last, so an unbounded 3000-character build
  // error made one 3144-character reply Discord rejects (on main before this); bounded to DAEMON_ERROR_MAX the reply
  // is about 730 units and still ends on the verdict. Mutation: the error not clamped before `handoffFailureMessage`
  // (a reply cut at 1900 that loses the verdict); a DM after a landed edit.
  describe("a failed swap with a long build error, through the real handler (C2)", () => {
    const SELF_SHORT = "aaaaaaaaaaaa";
    const NEW_SHA = "2".repeat(40);
    const self = {
      Id: "a".repeat(64),
      Name: "/bot",
      Image: "sha256:deadbeef",
      State: { Running: true, Status: "running", ExitCode: 0 },
      Config: { Image: "bot:latest", Env: [], Labels: {} },
      HostConfig: { Binds: [], RestartPolicy: { Name: "unless-stopped" } },
      Mounts: [],
      NetworkSettings: { Networks: {} },
    };

    /** Run a `/update` against a stubbed GitHub and daemon whose build fails with a 3000-character error. */
    async function failedSwap(interaction: ChatInputCommandInteraction): Promise<void> {
      const realFetch = globalThis.fetch;
      const realHostname = process.env.HOSTNAME;
      const log = spyOn(console, "log").mockImplementation(() => {});
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      process.env.HOSTNAME = SELF_SHORT;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/commits?")) return new Response(JSON.stringify([{ sha: NEW_SHA }]), { status: 200 });
        if (url.includes("/compare/")) return new Response(JSON.stringify({ status: "behind" }), { status: 200 });
        if (url === "http://docker/_ping") return new Response("OK", { status: 200 });
        if (url === `http://docker/containers/${SELF_SHORT}/json`) return new Response(JSON.stringify(self), { status: 200 });
        if (url.startsWith("http://docker/build?")) {
          return new Response(`${JSON.stringify({ error: "x".repeat(3000) })}\n`, { status: 200 });
        }
        throw new Error(`unstubbed fetch in test: ${url}`);
      }) as unknown as typeof fetch;
      try {
        await asAdmin(RUNNING_SHA, async () => {
          expect(await handleCommand(interaction)).toBe("answered");
        });
      } finally {
        globalThis.fetch = realFetch;
        if (realHostname === undefined) delete process.env.HOSTNAME;
        else process.env.HOSTNAME = realHostname;
        log.mockRestore();
        warn.mockRestore();
        botState.attemptedUpdateToSha = undefined;
        botState.pendingUpdateReport = undefined;
        resetUpdateForTest();
      }
    }

    test("one reply of about 730 units, bounded daemon error first and the verdict last, and no DM", async () => {
      const { interaction, edits, dms } = adminUpdate();
      await failedSwap(interaction);
      expect(edits).toHaveLength(1);
      const reply = edits[0]!;
      expect(reply.length).toBeLessThan(900);
      expect(reply.length).toBeGreaterThan(700);
      expect(reply).toMatch(/build failed: x{586}… — /);
      expect(reply.endsWith("stayed on the current build.")).toBe(true);
      expect(dms).toEqual([]);
    });

    test("the same reply goes by DM, unchanged, when Discord refuses the edit", async () => {
      const failure = replyFailure("webhook");
      const { interaction, edits, dms, calls } = adminUpdate({ failure, editFails: 1 });
      await failedSwap(interaction);
      expect(edits).toEqual([]);
      expect(calls).toEqual({ edit: 1, dm: 1 });
      expect(dms).toHaveLength(1);
      expect(dms[0]!.endsWith("stayed on the current build.")).toBe(true);
      expect(dms[0]).toMatch(/build failed: x{586}… — /);
    });
  });

  // C6: the handler passes the command as registered. `handleCommand` cannot dispatch a prefixed name in this process
  // (COMMAND_PREFIX is empty), so the row's own `handle` is driven; `beginHandoff` makes `checkForUpdate` answer `busy`
  // before it reads anything. Every other handler test runs as `update`, which equals the `?? "update"` fallback, so
  // without this the argument could be dropped unnoticed. Mutation: dropping `commandName: interaction.commandName`.
  test("the busy reply names the command the interaction carries, through the handler (C6)", async () => {
    const { interaction, edits } = adminUpdate({ commandName: "pipupdate" });
    const log = spyOn(console, "log").mockImplementation(() => {});
    beginHandoff("c6");
    try {
      await asAdmin(RUNNING_SHA, async () => {
        await CORE_COMMANDS.find((c) => c.name === "update")!.handle(interaction);
      });
      expect(edits).toHaveLength(1);
      expect(edits[0]).toContain("/pipupdate");
      expect(edits[0]).not.toContain("/update ");
      expect(edits[0]).not.toContain("I'll report");
    } finally {
      log.mockRestore();
      resetRestartForTest();
    }
  });
});

describe("handleCommand — /plugins", () => {
  // config.adminUserIds is empty in this test process (ADMIN_USER_IDS unset), so this exercises the
  // no-admins-configured refusal — which is exactly the isAdmin gate: drop it and the handler would
  // deferReply and hit the index/state I/O instead of refusing. The rendered list body is covered by
  // renderPluginsList's own tests (plugins/updates.test.ts) and the fixture E2E in the deploy check.
  test("refuses a non-admin before any deferReply / index fetch", async () => {
    const { interaction, seen } = nonAdminInteraction("plugins", { options: { getSubcommand: () => "list" } });
    await handleCommand(interaction);
    // Full equality, not a substring: the message names the command the user typed
    // (interaction.commandName), which a looser check (just "set `ADMIN_USER_IDS`") wouldn't pin.
    expect(seen.replied?.content).toBe("⛔ No admins are configured — set `ADMIN_USER_IDS` to enable `/plugins`.");
    expect(seen.deferred).toBe(false); // gated before any I/O — the gate covers update/remind/skip/cancel too
  });

  // T5: /plugins list's catch logs too. The index fetch fails (loadPluginIndex falls back and warns itself); the
  // state read is real; the deferred reply's edit is rejected once, or twice, as an expired token would be.
  // The log comes BEFORE the failure reply: when that reply is rejected too (`rejections` 2), the line is the only
  // record of the original failure. Mutation: moving the warn below the reply loses it.
  test("a failed /plugins list is logged without the token, even when the failure reply is rejected too (#503 item 11)", async () => {
    for (const rejections of [1, 2]) {
      const edits: string[] = [];
      const failure = replyFailure("webhook");
      let editCalls = 0;
      let fetchSpy: ReturnType<typeof spyOn> | undefined;
      let warn: ReturnType<typeof spyOn> | undefined;
      let pushedAdmin = false;
      try {
        config.adminUserIds.push("999");
        pushedAdmin = true;
        fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
          throw new Error("offline");
        }) as unknown as typeof fetch);
        warn = spyOn(console, "warn").mockImplementation(() => {});
        const interaction = {
          commandName: "plugins",
          user: { id: "999" },
          channelId: "c1",
          options: { getSubcommand: () => "list" },
          deferReply: async () => {},
          editReply: async (content: string) => {
            editCalls += 1;
            if (editCalls <= rejections) throw failure.error; // the list reply: token expired
            edits.push(content);
          },
        } as unknown as ChatInputCommandInteraction;
        if (rejections === 1) {
          await handleCommand(interaction);
          expect(edits).toEqual(["⚠️ Couldn't list plugins: Unknown interaction"]);
        } else {
          await expect(handleCommand(interaction)).rejects.toBe(failure.error);
          expect(edits).toEqual([]);
        }
        const failed = warn.mock.calls.find(([m]: unknown[]) => String(m) === "[plugins] /plugins list failed");
        expect(failed).toBeDefined();
        expectCleanedLog(failed!, failure);
      } finally {
        warn?.mockRestore();
        fetchSpy?.mockRestore();
        if (pushedAdmin) config.adminUserIds.splice(config.adminUserIds.indexOf("999"), 1);
      }
    }
  });

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

  // The write subcommands must refuse until the boot state.json write has landed (isPluginStateReady),
  // so a command in the startup window can't race that write. Behaviorally awkward to exercise (the
  // config.adminUserIds singleton is empty in-process), so source-scan it like the ordering guard: the
  // readiness check must sit before the deferReply/mutate of the write path.
  test("write subcommands are gated behind isPluginStateReady, before the mutate (source guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./commands.ts", import.meta.url), "utf8");
    const listBranch = src.indexOf('if (sub === "list")');
    const gate = src.indexOf("if (!isPluginStateReady())", listBranch);
    const defer = src.indexOf("await interaction.deferReply", gate);
    const mutate = src.indexOf("mutatePluginState(DATA_DIR, result.mutate)", gate);
    expect(gate).toBeGreaterThan(listBranch); // the gate is on the write path, after the list branch
    expect(gate).toBeLessThan(defer); // …and refuses before deferring / doing I/O
    expect(gate).toBeLessThan(mutate);
  });

  // #225: planPluginAction's off-plugin refusal needs the state entry's enabled flag — a source guard
  // since (like the two above) this handler does real I/O the test harness doesn't drive.
  test("/plugins passes the state entry's enabled flag into planPluginAction (source guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./commands.ts", import.meta.url), "utf8");
    const call = src.slice(src.indexOf("planPluginAction(action, {"));
    expect(call).toContain("enabled: stateEntry.enabled,");
  });
});

// #503 item 10: the one path that pins a version and restarts, driven for real. State and index are the shapes
// plugins/updates.test.ts's helpers build; the data dir is test/setup.ts's per-run BOT_DATA_DIR. The exit is stubbed:
// in production the process is gone the moment the critical section closes, which is why the failed reply must be
// logged inside it (and why no "Couldn't act" edit follows).
describe("handleCommand — /plugins driven end to end: update now (#503 item 10) and an action's failure (#503 item 11)", () => {
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
    let reasonAtReply: string | undefined;
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
            reasonAtReply = stateForTest().pending;
            throw failure.error; // the "Updating … now" reply: token expired
          }
          edits.push(content);
        },
      } as unknown as ChatInputCommandInteraction;

      expect(await handleCommand(interaction)).toBe("answered");
      // The restart was requested BEFORE the reply went out, inside the critical section, and landed when it closed
      // -- although the reply failed.
      expect(pendingAtReply).toBe(true);
      expect(reasonAtReply).toBe("plugin update: demo 1.0.0 → 1.1.0"); // names the plugin and the pinned versions
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

  // T6: the action catch (#503 item 11). An unparseable state.json does not reach it (readJsonOrFresh moves a corrupt
  // file aside and reads it as fresh), so the failure driven here is the reply: /plugins remind mutates, no restart.
  // The log comes BEFORE the failure reply: when that reply is rejected too (`rejections` 2), the line is the only
  // record of the original failure. Mutation: moving the warn below the reply loses it.
  test("a /plugins action whose reply Discord rejects is logged without the token, whether or not the failure reply is rejected too", async () => {
    for (const rejections of [1, 2]) {
      const edits: string[] = [];
      const failure = replyFailure("webhook");
      let editCalls = 0;
      let fetchSpy: ReturnType<typeof spyOn> | undefined;
      let warn: ReturnType<typeof spyOn> | undefined;
      let pushedAdmin = false;
      try {
        mkdirSync(`${DATA_DIR}/plugins`, { recursive: true });
        writeFileSync(statePath, JSON.stringify(stateBody));
        markPluginStateReady();
        config.adminUserIds.push("999");
        pushedAdmin = true;
        fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
          new Response(JSON.stringify(indexBody), { status: 200 })) as unknown as typeof fetch);
        warn = spyOn(console, "warn").mockImplementation(() => {});
        const interaction = {
          commandName: "plugins",
          user: { id: "999" },
          channelId: "c1",
          options: {
            getSubcommand: () => "remind",
            getString: (name: string) => (name === "name" ? "demo" : null),
            getInteger: () => null,
          },
          deferReply: async () => {},
          editReply: async (content: string) => {
            editCalls += 1;
            if (editCalls <= rejections) throw failure.error;
            edits.push(content);
          },
        } as unknown as ChatInputCommandInteraction;

        if (rejections === 1) {
          expect(await handleCommand(interaction)).toBe("answered");
          expect(edits).toEqual(["⚠️ Couldn't act on the plugin: Unknown interaction"]);
        } else {
          await expect(handleCommand(interaction)).rejects.toBe(failure.error);
          expect(edits).toEqual([]);
        }
        const failed = warn.mock.calls.find(([m]: unknown[]) => String(m) === "[plugins] /plugins remind failed");
        expect(failed).toBeDefined();
        expectCleanedLog(failed!, failure);
      } finally {
        warn?.mockRestore();
        fetchSpy?.mockRestore();
        if (pushedAdmin) config.adminUserIds.splice(config.adminUserIds.indexOf("999"), 1);
        resetRestartForTest();
        resetPollStateForTest();
        rmSync(statePath, { force: true });
        rmSync(indexCache, { force: true });
      }
    }
  });
});

// The editReply paths below share the same shape as the ordering guards above (real network/state
// I/O behind them, impractical to drive a genuine upstream failure through in a unit test), so
// they're pinned the same way: source-scan for the guard rather than exercise it end-to-end.
// The `/update` row builds ONE `content` through `clampReply` (both the check's result and its
// failure text) and edits with it (#503 item 3); the two `/plugins` rows keep their catch-block
// clamps. `clampReply`'s own behaviour (truncation, boundary, custom max) is unit-tested directly
// in github.test.ts; report.test.ts drives the equivalent /report failure path end-to-end since
// createIssue's fetch is easy to stub. Mutation: removing `clampReply(` from any of these must
// fail its test.
describe("commands.ts — clampReply guards every editReply (#55, #186, #503)", () => {
  // #206: anchors moved from the old switch's `case "update"`/`case "report"` labels to
  // CORE_COMMANDS' own row markers — the table's order is report/update/plugins (matching
  // commandData's own pinned order), so the update row runs from its own `name:` to the next
  // row's (`plugins`), not to `name: "report"`, which now comes BEFORE it.
  //
  // C3: the source is transpiled whole first (as commandNaming.test.ts does): comments are gone, and a slice of the
  // file alone is not parseable, so `transformSync` would throw on it. `updateReply`'s own clamps (the daemon error)
  // sit outside the slice. Mutations: either `content = clampReply(` assignment dropped (the success path or the
  // failure text); the edit not using `content`; a second `editReply(`.
  test("/update builds one clamped reply and edits with it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./commands.ts", import.meta.url), "utf8");
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(src);
    expect(js.split('name: "update"')).toHaveLength(2);
    expect(js.split('name: "plugins"')).toHaveLength(2);
    const block = js.slice(js.indexOf('name: "update"'), js.indexOf('name: "plugins"'));
    expect(block.split("content = clampReply(")).toHaveLength(3);
    expect(block.split("clampReply(")).toHaveLength(3);
    expect(block.split("await interaction.editReply(content)")).toHaveLength(2);
    expect(block.split("editReply(")).toHaveLength(2);
    // Both clamps keep the default max (1900, under Discord's 2000): a tighter one would cut a real 1000-1400 unit
    // failed-swap reply, a looser one is no clamp. Each call has ONE argument -- counted at the call's own nesting
    // depth, so `Number(1000)` or a named constant cannot slip past a pattern for numeric literals.
    const args = [...block.matchAll(/clampReply\(/g)].map((m) => {
      const segments = [""];
      let depth = 1;
      for (let i = m.index! + "clampReply(".length; i < block.length; i++) {
        const c = block[i]!;
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c) && --depth === 0) break;
        if (c === "," && depth === 1) segments.push("");
        else segments[segments.length - 1] += c;
      }
      return segments.filter((s) => s.trim() !== "").length;
    });
    expect(args).toEqual([1, 1]);
  });

  test("/plugins list's failure edit is wrapped in clampReply", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./commands.ts", import.meta.url), "utf8");
    const listIdx = src.indexOf('if (sub === "list")');
    const block = src.slice(listIdx, src.indexOf('if (!isPluginStateReady())'));
    const catchIdx = block.indexOf("} catch (err) {");
    expect(catchIdx).toBeGreaterThan(-1);
    const editIdx = block.indexOf("await interaction.editReply(clampReply(", catchIdx);
    expect(editIdx).toBeGreaterThan(catchIdx);
  });

  test("/plugins <action>'s failure edit is wrapped in clampReply", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./commands.ts", import.meta.url), "utf8");
    // The action (update/remind/skip/cancel) catch is the last one in the plugins row, which is the
    // table's last row: it ends where `commandData` begins. (handleCommand, further down, has a catch
    // of its own since #407, for a plugin handler's throw; it is not a /plugins failure path.)
    const block = src.slice(src.indexOf('name: "plugins"'), src.indexOf("export const commandData"));
    const actionCatchIdx = block.lastIndexOf("} catch (err) {");
    expect(actionCatchIdx).toBeGreaterThan(-1);
    const editIdx = block.indexOf("await interaction.editReply(clampReply(", actionCatchIdx);
    expect(editIdx).toBeGreaterThan(actionCatchIdx);
  });
});

describe("buildCommandBody — core-only identity", () => {
  // The framework must not change the core registration body, AND the plugin-migration removals are
  // pinned here: with no plugins the built body must equal the captured full JSON MINUS every command
  // that is now plugin-provided — the connector's /link + /unlink (#100) and the WoW plugin's
  // /dmf /reset /status /transmog (#107). fixtures/command-body.main.json is a hand-maintained snapshot of
  // the full pre-migration body, kept current when a core command changes (#110, #117, #120 edited it);
  // its names are unprefixed, so it relies on test/setup.ts clearing COMMAND_PREFIX (#472).
  const NOW_PLUGIN_PROVIDED = ["link", "unlink", "dmf", "reset", "status", "transmog"];
  test("with no plugins, the body equals the fixture minus the now-plugin-provided commands", () => {
    const body = buildCommandBody(config.commandPrefix, commandData, new Map(), { info() {}, warn() {}, error() {} });
    const expected = coreBodyFixture.filter((c: { name: string }) => !NOW_PLUGIN_PROVIDED.includes(c.name));
    expect(body).toEqual(expected);
  });
});
