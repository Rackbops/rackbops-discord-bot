import { describe, expect, spyOn, test } from "bun:test";

// announce.ts imports the `config` singleton (resolved from process.env at import time), so
// prime the required vars before pulling the module in — see config.test.ts.
process.env.DISCORD_TOKEN ??= "test-token";
process.env.ANNOUNCE_CHANNEL_ID ??= "100";
const { runTick } = await import("./announce");

// Scoped to runTick's isolation guarantee (issue #43) — not a wider push at #57's broader
// "no announce/dmf tests" gap. checkDmf/checkWeeklyReset/etc. call real discord.js/Blizzard/
// GitHub APIs and aren't exported, so this exercises the actual extracted isolation mechanism
// onTick delegates to, rather than mocking discord.js's Client end-to-end.
describe("runTick", () => {
  test("a throwing check doesn't stop the rest from running", async () => {
    const ran: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    await runTick([
      { name: "dmf", run: async () => void ran.push("dmf") },
      {
        name: "boom",
        run: async () => {
          throw new Error("bad DMF_TIMEZONE");
        },
      },
      { name: "realm", run: async () => void ran.push("realm") },
    ]);
    // The crux of the fix: realm still ran despite boom throwing between it and dmf. Asserted
    // before mockRestore(), which clears the spy's own call history.
    expect(ran).toEqual(["dmf", "realm"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("logs the failing check's name, not just a bare error", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    await runTick([
      {
        name: "dmf",
        run: async () => {
          throw new Error("bad DMF_TIMEZONE");
        },
      },
    ]);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("dmf");
    errorSpy.mockRestore();
  });

  test("runs checks in the given order", async () => {
    const ran: string[] = [];
    await runTick([
      { name: "a", run: async () => void ran.push("a") },
      { name: "b", run: async () => void ran.push("b") },
      { name: "c", run: async () => void ran.push("c") },
    ]);
    expect(ran).toEqual(["a", "b", "c"]);
  });

  test("a later check's throw doesn't retroactively affect an earlier one that already ran", async () => {
    const ran: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runTick([
        { name: "first", run: async () => void ran.push("first") },
        {
          name: "second",
          run: async () => {
            throw new Error("boom");
          },
        },
      ]);
    } finally {
      errorSpy.mockRestore();
    }
    expect(ran).toEqual(["first"]);
  });
});
