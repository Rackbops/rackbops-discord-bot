import { describe, expect, spyOn, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import type { PluginCommand } from "./plugins/contract";

// `commands.ts` pulls in the `config` singleton, which resolves process.env at import
// time — satisfy the required vars before importing so this file runs standalone.
process.env.DISCORD_TOKEN ??= "test-token";
process.env.ANNOUNCE_CHANNEL_ID ??= "100";
const { isAdmin, bareName, updateReply, commandData, handleCommand } = await import("./commands");
const { buildCommandBody } = await import("./plugins/host");
const { config } = await import("./config");
const coreBodyFixture = await Bun.file(new URL("./plugins/fixtures/command-body.main.json", import.meta.url)).json();

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
    expect(updateReply("restart", SHA)).toContain(SHA.slice(0, 7));
  });

  // The bot now answers this itself, with a follow-up naming the build it landed on —
  // handing the verification back to the user was the whole complaint in #681.
  test("no longer asks the user to check whether the build changed", () => {
    const reply = updateReply("restart", SHA);
    expect(reply).not.toContain("same build");
    expect(reply).toContain("report back");
  });

  test("reports disabled and current without promising a follow-up", () => {
    expect(updateReply("disabled", "")).toContain("GIT_SHA");
    expect(updateReply("current", SHA)).toContain("latest build");
  });

  // #871: `disabled` has two causes now, and they ask different things of the operator.
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

  test("a second /update mid-swap is refused, not promised", () => {
    const reply = updateReply("busy", "");
    expect(reply).toContain("already in progress");
    expect(reply).not.toContain("Restarting");
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
});

describe("commandData", () => {
  // #100 removed the baked-in connector: /link and /unlink are now the warbandeer plugin's, not
  // core. Pin that they are gone from the core registration (the plugin adds them back when loaded).
  test("no longer contains the connector's /link or /unlink", () => {
    expect(commandData.map((c) => c.name)).not.toContain("link");
    expect(commandData.map((c) => c.name)).not.toContain("unlink");
  });
});

describe("handleCommand — plugin dispatch (default case)", () => {
  test("dispatches a non-core command to the looked-up plugin handler", async () => {
    let handledName: string | undefined;
    const pluginCommand = { name: "hello", handle: async (i: ChatInputCommandInteraction) => { handledName = i.commandName; } } as unknown as PluginCommand;
    await handleCommand({ commandName: "hello" } as unknown as ChatInputCommandInteraction, (bare) => (bare === "hello" ? pluginCommand : undefined));
    expect(handledName).toBe("hello");
  });

  test("warns and resolves when neither a core case nor a plugin matches", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await handleCommand({ commandName: "nope" } as unknown as ChatInputCommandInteraction, () => undefined);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("no handler for /nope");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("handleCommand — /plugins", () => {
  // config.adminUserIds is empty in this test process (ADMIN_USER_IDS unset), so this exercises the
  // no-admins-configured refusal — which is exactly the isAdmin gate: drop it and the handler would
  // deferReply and hit the index/state I/O instead of refusing. The rendered list body is covered by
  // renderPluginsList's own tests (plugins/updates.test.ts) and the fixture E2E in the deploy check.
  test("refuses a non-admin before any deferReply / index fetch", async () => {
    let replied: { content?: string } | undefined;
    let deferred = false;
    const interaction = {
      commandName: "plugins",
      user: { id: "999" },
      options: { getSubcommand: () => "list" },
      reply: async (o: { content?: string }) => {
        replied = o;
      },
      deferReply: async () => {
        deferred = true;
      },
    } as unknown as ChatInputCommandInteraction;
    await handleCommand(interaction);
    expect(replied?.content).toContain("set `ADMIN_USER_IDS`");
    expect(deferred).toBe(false); // gated before any I/O
  });
});

describe("buildCommandBody — core-only identity", () => {
  // The framework must not change the core registration body, AND #100's connector removal is pinned
  // here: with no plugins the built body must equal the captured core JSON MINUS the two connector
  // commands (fixtures/command-body.main.json was captured pre-#100 with /link + /unlink present).
  test("with no plugins, the body equals the fixture minus the removed connector commands", () => {
    const body = buildCommandBody(config.commandPrefix, commandData, new Map(), { info() {}, warn() {}, error() {} });
    const expected = coreBodyFixture.filter((c: { name: string }) => c.name !== "link" && c.name !== "unlink");
    expect(body).toEqual(expected);
  });
});
