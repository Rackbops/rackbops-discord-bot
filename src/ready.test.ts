import { describe, expect, test } from "bun:test";
import { createReadyHandler, type ReadyDeps } from "./ready";

// #435: the ClientReady handler's one invariant -- a standby takes over BEFORE anything that makes this
// process the bot is attached, and a normal boot never calls takeOver -- driven with fakes instead of read
// off index.ts's source. index.test.ts pins that index.ts hands everything to createReadyHandler.
interface Client {
  id: string;
}

function harness(mode: "standby" | "normal", overrides: Partial<ReadyDeps<Client>> = {}) {
  const order: string[] = [];
  const activated: Client[] = [];
  const lines: unknown[] = [];
  const deps: ReadyDeps<Client> = {
    mode,
    takeOver: async () => {
      order.push("takeOver");
    },
    activate: async (c) => {
      order.push("activate");
      activated.push(c);
    },
    clearVerifyTimer: () => {
      order.push("clear");
    },
    log: {
      log: (line?: unknown) => {
        order.push("log");
        lines.push(line);
      },
    },
    describe: (c) => `Logged in as ${c.id}`,
    ...overrides,
  };
  return { handler: createReadyHandler(deps), order, activated, lines };
}

describe("createReadyHandler (#435)", () => {
  test("standby: logs the login, clears the verify timer, takes over, then activates — in that order", async () => {
    const { handler, order } = harness("standby");
    await handler({ id: "a" });
    // Mutation: swapping takeOver and activate, or moving the clear after either, changes this list.
    expect(order).toEqual(["log", "clear", "takeOver", "activate"]);
  });

  test("activate waits for a slow takeOver to settle before it runs", async () => {
    let finishTakeOver!: () => void;
    const takeOverSettled = new Promise<void>((resolve) => {
      finishTakeOver = resolve;
    });
    const { handler, order } = harness("standby", {
      takeOver: async () => {
        order.push("takeOver:start");
        await takeOverSettled;
        order.push("takeOver:done");
      },
    });
    const running = handler({ id: "a" });
    await Bun.sleep(10);
    // Mutation: dropping the `await` on takeOver (or firing it with `void`) lets activate start here.
    expect(order).toEqual(["log", "clear", "takeOver:start"]);
    finishTakeOver();
    await running;
    expect(order).toEqual(["log", "clear", "takeOver:start", "takeOver:done", "activate"]);
  });

  test("normal: never calls takeOver, and still clears the timer before activating", async () => {
    const { handler, order } = harness("normal", {
      takeOver: async () => {
        throw new Error("takeOver must not run in normal mode");
      },
    });
    await handler({ id: "a" });
    // Mutation: dropping the mode === "standby" gate makes takeOver throw here.
    expect(order).toEqual(["log", "clear", "activate"]);
  });

  test("a takeOver that rejects means activate never runs, and the rejection reaches the caller", async () => {
    const { handler, order, activated } = harness("standby", {
      takeOver: async () => {
        throw new Error("retire failed");
      },
    });
    await expect(handler({ id: "a" })).rejects.toThrow("retire failed");
    // Mutation: wrapping takeOver() in a try that swallows lets activate run beside the live original.
    expect(order).not.toContain("activate");
    expect(activated).toEqual([]);
  });

  test("the login line is what describe() returned for this client, sent to the injected log", async () => {
    const { handler, lines } = harness("normal");
    await handler({ id: "a" });
    // Mutation: logging a fixed string, or ignoring describe(), changes this line.
    expect(lines).toEqual(["Logged in as a"]);
  });

  test("activate receives the client the gateway handed over", async () => {
    const client: Client = { id: "gateway-client" };
    const { handler, activated } = harness("normal");
    await handler(client);
    expect(activated).toHaveLength(1);
    expect(activated[0]).toBe(client);
  });
});
