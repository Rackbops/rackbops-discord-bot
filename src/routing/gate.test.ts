import { describe, expect, test } from "bun:test";
import { freshRouting, type PluginRouting, type RoutingFile } from "./model";
import { gateCommand, refusalMessage, whereOf, type Where } from "./gate";

const HOME = "111111111111111111";
const OTHER = "222222222222222222";
const CHAN_1 = "222222222222222001";
const CHAN_2 = "222222222222222002";
const ELSEWHERE = "222222222222222099";
const THREAD = "555555555555555555";

function routing(plugins: Record<string, PluginRouting>): RoutingFile {
  return { ...freshRouting(), plugins };
}

// `music` lives in OTHER, and its commands run only in CHAN_1 and CHAN_2 there.
const listed = routing({ music: { servers: { [OTHER]: { commands: [CHAN_1, CHAN_2] } } } });

const here = (over: Partial<Where> = {}): Where => ({ guildId: OTHER, channelId: CHAN_1, ...over });

function logCapture() {
  const lines: unknown[][] = [];
  return { log: { error: (...a: unknown[]) => void lines.push(a) }, lines };
}

describe("refusalMessage", () => {
  test("names one channel, two channels, and up to five", () => {
    expect(refusalMessage("rsetlist", ["1"])).toBe("`/rsetlist` works in <#1> here.");
    expect(refusalMessage("rsetlist", ["1", "2"])).toBe("`/rsetlist` works in <#1> or <#2> here.");
    expect(refusalMessage("rsetlist", ["1", "2", "3"])).toBe("`/rsetlist` works in <#1>, <#2> or <#3> here.");
    expect(refusalMessage("rsetlist", ["1", "2", "3", "4", "5"])).toBe("`/rsetlist` works in <#1>, <#2>, <#3>, <#4> or <#5> here.");
  });

  test("more than five: the first five, then how many more", () => {
    expect(refusalMessage("rsetlist", ["1", "2", "3", "4", "5", "6"])).toBe("`/rsetlist` works in <#1>, <#2>, <#3>, <#4>, <#5> and 1 more here.");
    expect(refusalMessage("rsetlist", Array.from({ length: 12 }, (_, i) => String(i + 1)))).toBe(
      "`/rsetlist` works in <#1>, <#2>, <#3>, <#4>, <#5> and 7 more here.",
    );
  });
});

describe("gateCommand", () => {
  const run = (plugin: string | undefined, where: Where, file: RoutingFile = listed) =>
    gateCommand(plugin, "rsetlist", where, async () => file, logCapture().log);

  test("a command in a listed channel is allowed", async () => {
    expect(await run("music", here({ channelId: CHAN_1 }))).toBeUndefined();
    expect(await run("music", here({ channelId: CHAN_2 }))).toBeUndefined();
  });

  test("a command in an unlisted channel is refused, naming the channels", async () => {
    expect(await run("music", here({ channelId: ELSEWHERE }))).toBe(`\`/rsetlist\` works in <#${CHAN_1}> or <#${CHAN_2}> here.`);
  });

  test("a thread under a listed channel is allowed", async () => {
    expect(await run("music", here({ channelId: THREAD, parentChannelId: CHAN_2 }))).toBeUndefined();
  });

  test("a thread under an unlisted channel is refused", async () => {
    expect(await run("music", here({ channelId: THREAD, parentChannelId: ELSEWHERE }))).toBe(
      `\`/rsetlist\` works in <#${CHAN_1}> or <#${CHAN_2}> here.`,
    );
  });

  test("a plugin with no entry for the server is allowed", async () => {
    // Placed, but only elsewhere: nothing restricts it here.
    expect(await run("music", here({ guildId: HOME, channelId: ELSEWHERE }))).toBeUndefined();
    // No entry at all (unplaced), and an entry whose scope is "all".
    expect(await run("weather", here({ channelId: ELSEWHERE }))).toBeUndefined();
    expect(await run("music", here({ channelId: ELSEWHERE }), routing({ music: { servers: { [OTHER]: { commands: "all" } } } }))).toBeUndefined();
    expect(await run("music", here({ channelId: ELSEWHERE }), freshRouting())).toBeUndefined();
  });

  test("a DM is allowed", async () => {
    expect(await run("music", { guildId: null, channelId: ELSEWHERE })).toBeUndefined();
  });

  test("no plugin (a core command) is allowed", async () => {
    expect(await run(undefined, here({ channelId: ELSEWHERE }))).toBeUndefined();
  });

  test("a routing read that throws is logged and allowed", async () => {
    const { log, lines } = logCapture();
    const boom = new Error("EIO");
    const result = await gateCommand("music", "rsetlist", here({ channelId: ELSEWHERE }), async () => Promise.reject(boom), log);
    expect(result).toBeUndefined();
    expect(lines).toEqual([["[gate] could not decide whether /rsetlist may run here; letting it run", boom]]);
  });

  test("a channel whose parent could not be determined is allowed", async () => {
    // Not on the list, and not known to be anything else: the gate does not refuse what it cannot judge.
    expect(await run("music", here({ channelId: THREAD, parentUnknown: true }))).toBeUndefined();
    // ... but a channel that IS on the list is allowed either way, and one that is known is judged.
    expect(await run("music", here({ channelId: ELSEWHERE }))).not.toBeUndefined();
  });
});

describe("whereOf", () => {
  const interaction = (over: Record<string, unknown> = {}) =>
    ({ guildId: OTHER, channelId: THREAD, channel: null, ...over }) as Parameters<typeof whereOf>[0];
  const thread = (parentId: string | null = CHAN_1) => ({ isThread: () => true, parentId });
  const plainChannel = { isThread: () => false, parentId: null };
  const noFetch = async (): Promise<unknown> => {
    throw new Error("must not be fetched");
  };

  test("reads the parent of a thread", async () => {
    expect(await whereOf(interaction({ channel: thread(CHAN_2) }), noFetch)).toEqual({ guildId: OTHER, channelId: THREAD, parentChannelId: CHAN_2 });
  });

  test("a channel that is not a thread has no parent, and is not fetched again", async () => {
    expect(await whereOf(interaction({ channelId: CHAN_1, channel: plainChannel }), noFetch)).toEqual({ guildId: OTHER, channelId: CHAN_1 });
  });

  test("a DM has no guild", async () => {
    expect(await whereOf(interaction({ guildId: null, channel: plainChannel }), noFetch)).toEqual({ guildId: null, channelId: THREAD });
  });

  test("fetches a channel that is not cached, once", async () => {
    const fetched: string[] = [];
    const where = await whereOf(interaction(), async (id) => {
      fetched.push(id);
      return thread(CHAN_1);
    });
    expect(fetched).toEqual([THREAD]);
    expect(where).toEqual({ guildId: OTHER, channelId: THREAD, parentChannelId: CHAN_1 });
    // A fetched channel that is not a thread has no parent, and that is a known answer.
    expect(await whereOf(interaction(), async () => plainChannel)).toEqual({ guildId: OTHER, channelId: THREAD });
  });

  test("survives the fetch failing: the parent is not known", async () => {
    const where = await whereOf(interaction(), async () => Promise.reject(new Error("Unknown Channel")));
    expect(where).toEqual({ guildId: OTHER, channelId: THREAD, parentUnknown: true });
    // A fetch that finds nothing is the same.
    expect(await whereOf(interaction(), async () => null)).toEqual({ guildId: OTHER, channelId: THREAD, parentUnknown: true });
  });

  test("a thread that says nothing about its parent is not known either", async () => {
    expect(await whereOf(interaction({ channel: thread(null) }), noFetch)).toEqual({ guildId: OTHER, channelId: THREAD, parentUnknown: true });
    const broken = {
      isThread: () => {
        throw new Error("boom");
      },
    };
    expect(await whereOf(interaction({ channel: broken }), noFetch)).toEqual({ guildId: OTHER, channelId: THREAD, parentUnknown: true });
  });
});
