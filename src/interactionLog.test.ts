import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createInteractionLine, customIdPrefix, describeInteraction, interactionLogLine, type InteractionLike } from "./interactionLog";
import { jsonLogLine } from "./logFormat";
import { beginShutdown, onBeforeExit, requestRestart, resetForTest, runExitHooks, setExitFn, stateForTest, withCritical } from "./restart";

// #328: the one line per interaction. index.ts can't run under test, so its wiring is pinned in
// index.test.ts; what is tested here is what a line may and may not carry.

const USER = "222222222222222222";
const GUILD = "999999999999999999";
const CHANNEL = "888888888888888888";
const SECRET = "Pick-up-the-dry-cleaning-4471";

function fake(kind: "command" | "component" | "modal" | "autocomplete", o: Partial<InteractionLike> = {}): InteractionLike {
  return {
    user: { id: USER },
    guildId: null,
    channelId: "dm-channel",
    isChatInputCommand: () => kind === "command",
    isMessageComponent: () => kind === "component",
    isModalSubmit: () => kind === "modal",
    ...o,
  };
}

/** A command's options as discord.js reads them, holding `SECRET` as a typed value. */
function options(sub: string | null, group: string | null = null) {
  return {
    getSubcommandGroup: () => group,
    getSubcommand: () => sub,
    getString: () => SECRET,
    data: [{ name: "text", value: SECRET }],
    toString: () => SECRET,
  };
}

describe("describeInteraction + interactionLogLine", () => {
  test("a command in a DM: its name, the user, dm, the outcome and the duration", () => {
    const facts = describeInteraction(fake("command", { commandName: "web", options: options(null) }));
    expect(facts).not.toBeNull();
    expect(interactionLogLine(facts!, "answered", 41.6)).toBe(`[interaction] command /web user=${USER} where=dm outcome=answered 42ms`);
  });

  test("a command in a server names the guild and the channel; subcommand group and name follow the command", () => {
    const facts = describeInteraction(fake("command", { commandName: "task", options: options("done", "admin"), guildId: GUILD, channelId: CHANNEL }));
    expect(interactionLogLine(facts!, "gated", 3)).toBe(
      `[interaction] command /task admin done user=${USER} where=guild:${GUILD}/channel:${CHANNEL} outcome=gated 3ms`,
    );
  });

  test("never an option value: a command carrying a distinctive value logs none of it", () => {
    for (const o of [options("remind"), options(null), { getSubcommand: () => { throw new Error(SECRET); }, getSubcommandGroup: () => null }, SECRET]) {
      const facts = describeInteraction(fake("command", { commandName: "remind", options: o }));
      const line = interactionLogLine(facts!, "answered", 1);
      expect(line).not.toContain(SECRET);
      expect(line).toContain("command /remind");
    }
  });

  test("a component or a modal logs only its customId's prefix, never the rest of the id", () => {
    const button = describeInteraction(fake("component", { customId: `tracker:d.o.${SECRET}` }));
    expect(interactionLogLine(button!, "answered", 5)).toBe(`[interaction] component tracker user=${USER} where=dm outcome=answered 5ms`);
    const modal = describeInteraction(fake("modal", { customId: `tracker:reply:${SECRET}` }));
    expect(interactionLogLine(modal!, "unclaimed", 0)).toBe(`[interaction] modal tracker user=${USER} where=dm outcome=unclaimed 0ms`);
  });

  test("a hostile prefix is quoted and bounded, so it cannot forge a line; no colon is (none)", () => {
    expect(customIdPrefix("a b\n[interaction] command /x:rest")).toBe(JSON.stringify("a b\n[interaction] command /x"));
    expect(customIdPrefix(`${"x".repeat(60)}:y`)).toBe(JSON.stringify(`${"x".repeat(37)}...`));
    expect(customIdPrefix("nocolon")).toBe("(none)");
    expect(customIdPrefix("report:abc")).toBe("report");
  });

  test("an interaction that throws while being read gives no line, never a throw", () => {
    const broken = fake("command", { commandName: "web" });
    Object.defineProperty(broken, "user", { get: () => { throw new Error("gone"); } });
    expect(describeInteraction(broken)).toBeNull();
  });

  test("autocomplete (and anything else) writes no line", () => {
    expect(describeInteraction(fake("autocomplete", { commandName: "remind" }))).toBeNull();
  });

  test("a negative or non-finite duration is 0ms", () => {
    const facts = describeInteraction(fake("command", { commandName: "web" }))!;
    expect(interactionLogLine(facts, "error", -5)).toEndWith("outcome=error 0ms");
    expect(interactionLogLine(facts, "error", Number.NaN)).toEndWith("outcome=error 0ms");
  });

  test("under LOG_FORMAT=json the line is one JSON object", () => {
    const line = interactionLogLine(describeInteraction(fake("command", { commandName: "web" }))!, "answered", 7);
    const parsed = JSON.parse(jsonLogLine("info", [line], new Date("2026-09-30T00:00:00Z")));
    expect(parsed).toEqual({ time: "2026-09-30T00:00:00.000Z", level: "info", msg: line });
  });

  test("the exiting outcome renders like the others (#446)", () => {
    const facts = describeInteraction(fake("command", { commandName: "update" }))!;
    expect(interactionLogLine(facts, "exiting", 1234)).toBe(`[interaction] command /update user=${USER} where=dm outcome=exiting 1234ms`);
  });
});

// #446: index.ts registers an exit hook that writes the line with `exiting` and the handler's `finally` writes
// it with the real outcome; this is what makes exactly one of the two land. index.ts can't run under test, so
// the rule lives here, and index.test.ts pins that the handler goes through it.
describe("createInteractionLine (#446)", () => {
  const facts = describeInteraction(fake("command", { commandName: "update" }))!;
  /** A clock that answers each call from `times`, then the last one again. */
  const clock = (...times: number[]) => {
    let i = 0;
    return () => times[Math.min(i++, times.length - 1)]!;
  };

  test("writes once, whichever caller is first: the exit hook before the handler returns", () => {
    const written: string[] = [];
    const line = createInteractionLine(facts, (l) => written.push(l), clock(1000, 1250));
    line("exiting");
    line("answered");
    expect(written).toEqual([`[interaction] command /update user=${USER} where=dm outcome=exiting 250ms`]);
  });

  test("writes once, whichever caller is first: the handler returning before any exit", () => {
    const written: string[] = [];
    const line = createInteractionLine(facts, (l) => written.push(l), clock(1000, 1007));
    line("answered");
    line("exiting");
    line("error");
    expect(written).toEqual([`[interaction] command /update user=${USER} where=dm outcome=answered 7ms`]);
  });

  test("writes nothing without facts (autocomplete)", () => {
    const written: string[] = [];
    const line = createInteractionLine(null, (l) => written.push(l));
    line("answered");
    line("exiting");
    expect(written).toEqual([]);
  });

  test("the duration runs from when the writer was made, not from when it is called", () => {
    const written: string[] = [];
    const line = createInteractionLine(facts, (l) => written.push(l), clock(5, 50_005));
    line("gated");
    expect(written[0]).toEndWith("outcome=gated 50000ms");
  });

  // The handler's pattern (index.ts), driven through the real restart machinery: the writer, the exit hook
  // registered before the work, and the hook removed with the real outcome written in a `finally`.
  describe("as index.ts's handler uses it, through restart.ts", () => {
    beforeEach(() => resetForTest());
    afterEach(() => resetForTest());

    /** What the handler does around `work`; `exits` records the exit function's calls, after the hooks. */
    const handle = async (written: string[], work: () => Promise<void>, exits: string[] = []) => {
      const restore = setExitFn((code) => exits.push(`exit ${code}`));
      const line = createInteractionLine(facts, (l) => written.push(l.replace(/ \d+ms$/, "")));
      const offExit = onBeforeExit(() => line("exiting"));
      try {
        await work();
      } finally {
        offExit();
        line("answered");
        restore();
      }
    };
    const exitingLine = `[interaction] command /update user=${USER} where=dm outcome=exiting`;
    const answeredLine = `[interaction] command /update user=${USER} where=dm outcome=answered`;

    test("a command that requests a restart inside its critical section leaves one exiting line, before the exit", async () => {
      const written: string[] = [];
      const exits: string[] = [];
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      try {
        await handle(written, () => withCritical(async () => requestRestart("update")), exits);
      } finally {
        logSpy.mockRestore();
      }
      expect(written).toEqual([exitingLine]);
      expect(exits).toEqual(["exit 75"]);
    });

    test("a command that returns normally leaves one answered line, and its hook is gone", async () => {
      const written: string[] = [];
      await handle(written, async () => {});
      expect(written).toEqual([answeredLine]);
      expect(stateForTest().exitHooks).toBe(0);
    });

    test("an interaction that finishes during a shutdown's drain writes its own outcome, not exiting", async () => {
      const written: string[] = [];
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      try {
        beginShutdown("SIGTERM");
        await handle(written, async () => {});
        runExitHooks(); // the shutdown handler's exit, after the drain
      } finally {
        logSpy.mockRestore();
      }
      expect(written).toEqual([answeredLine]);
    });

    test("an interaction still in flight at the shutdown's exit writes exiting once, and not again when it returns", async () => {
      const written: string[] = [];
      let finish: () => void = () => {};
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      try {
        const running = handle(written, () => new Promise<void>((resolve) => (finish = resolve)));
        beginShutdown("SIGTERM");
        runExitHooks();
        expect(written).toEqual([exitingLine]);
        finish();
        await running;
      } finally {
        logSpy.mockRestore();
      }
      expect(written).toEqual([exitingLine]);
    });
  });

  test("a write that throws is its first and only attempt: the second caller does not write again", () => {
    let attempts = 0;
    const line = createInteractionLine(facts, () => {
      attempts += 1;
      throw new Error("stdout closed");
    });
    expect(() => line("exiting")).toThrow("stdout closed");
    line("answered");
    expect(attempts).toBe(1);
  });
});
