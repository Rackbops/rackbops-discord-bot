import { describe, expect, test } from "bun:test";
import { DiscordAPIError, Routes, type RESTPostAPIChatInputApplicationCommandsJSONBody as CommandJson } from "discord.js";
import type { PluginCommand, PluginIndexEntry } from "../plugins/contract";
import type { PluginCommandMap } from "../plugins/host";
import { freshRouting, type PluginRouting, type RoutingFile } from "./model";
import { describeError, ownerOf, planRegistration, registerPlan, type RegistrationPlan } from "./register";

const HOME = "111111111111111111";
const OTHER = "222222222222222222";
const THIRD = "333333333333333333";
const APP = "900000000000000000";
const NOW = new Date("2026-09-21T12:00:00.000Z");

const CORE = ["report", "update", "plugins"];
const MUSIC = ["setlist", "spotify", "party"];
const WOW = ["dmf", "reset"];

function command(name: string): CommandJson {
  return { name, description: `the ${name} command` };
}

/** The world a boot sees: core commands, then music's, then wow's -- in the order buildCommandBody makes. */
function world(prefix = "") {
  const map: PluginCommandMap = new Map();
  for (const bare of MUSIC) map.set(bare, { entry: { name: "music" } as PluginIndexEntry, command: { name: bare } as PluginCommand });
  for (const bare of WOW) map.set(bare, { entry: { name: "wow" } as PluginIndexEntry, command: { name: bare } as PluginCommand });
  const fullBody = [...CORE, ...MUSIC, ...WOW].map((bare) => command(`${prefix}${bare}`));
  return { prefix, map, fullBody, loaded: ["music", "wow"] };
}

function routing(plugins: Record<string, PluginRouting>): RoutingFile {
  return { ...freshRouting(), plugins };
}

function plan(overrides: Partial<Parameters<typeof planRegistration>[0]> & { routing: RoutingFile }): RegistrationPlan {
  const w = world(overrides.prefix ?? "");
  return planRegistration({
    fullBody: w.fullBody,
    prefix: w.prefix,
    commandMap: w.map,
    loaded: w.loaded,
    guildIds: [HOME, OTHER],
    homeGuildId: HOME,
    ...overrides,
  });
}

function routed(p: RegistrationPlan): Map<string, CommandJson[]> {
  if (p.mode !== "routed") throw new Error(`expected a routed plan, got ${p.mode}`);
  return p.bodies;
}

const names = (body: readonly CommandJson[] | undefined): string[] => (body ?? []).map((c) => c.name);

describe("ownerOf", () => {
  test("ownerOf strips the prefix and names the plugin, or null for core", () => {
    const { map } = world("r_");
    expect(ownerOf("r_setlist", "r_", map)).toBe("music");
    expect(ownerOf("r_dmf", "r_", map)).toBe("wow");
    // Core commands carry the prefix too, and no plugin owns them.
    for (const bare of CORE) expect(ownerOf(`r_${bare}`, "r_", map)).toBeNull();
    // An unknown name is nobody's, so it is treated as core rather than dropped.
    expect(ownerOf("r_nonsense", "r_", map)).toBeNull();
    // With no prefix the name is the bare name.
    expect(ownerOf("setlist", "", world().map)).toBe("music");
    // A name that does not carry the configured prefix is looked up as it is.
    expect(ownerOf("setlist", "r_", map)).toBe("music");
  });

  test("a command named like an inherited property is not owned by anyone", () => {
    const { map } = world();
    for (const name of ["constructor", "__proto__", "toString"]) expect(ownerOf(name, "", map)).toBeNull();
  });
});

describe("planRegistration", () => {
  test("with no routing the plan is today's single guild call, body untouched", () => {
    const w = world();
    const p = plan({ routing: freshRouting() });
    expect(p.mode).toBe("single");
    if (p.mode !== "single" || p.scope !== "guild") throw new Error("expected a single guild plan");
    expect(p.guildId).toBe(HOME);
    // Every command, in the full body's order: plugin commands included, nothing filtered, nothing reordered.
    expect(p.body).toEqual(w.fullBody);
    expect(names(p.body)).toEqual([...CORE, ...MUSIC, ...WOW]);
  });

  test("with no routing and no home server the plan is today's global call", () => {
    const w = world();
    const p = plan({ routing: freshRouting(), homeGuildId: undefined });
    expect(p.mode).toBe("single");
    if (p.mode !== "single" || p.scope !== "global") throw new Error("expected a single global plan");
    expect(p.body).toEqual(w.fullBody);
    // No guild id on a global plan: nothing to scope it to.
    expect("guildId" in p).toBe(false);
  });

  test("a file that places nobody is still single", () => {
    // Webhook metadata, an updatedBy, even a plugin table with no entries: none of it is a placement.
    const noPlacements: RoutingFile = {
      ...freshRouting(),
      updatedBy: "someone",
      webhooks: { "444444444444444444": { id: "555555555555555555", guildId: HOME, addedAt: "t", addedBy: "u" } },
    };
    for (const homeGuildId of [HOME, undefined]) {
      const p = plan({ routing: noPlacements, homeGuildId });
      expect(p.mode).toBe("single");
    }
  });

  test("the single plan's body is a copy, so a caller cannot change the full body through it", () => {
    const w = world();
    const p = plan({ routing: freshRouting() });
    if (p.mode !== "single") throw new Error("expected single");
    p.body.pop();
    expect(w.fullBody).toHaveLength(CORE.length + MUSIC.length + WOW.length);
  });

  test("a placed plugin's commands go only to its servers", () => {
    const p = plan({
      routing: routing({ music: { servers: { [OTHER]: { commands: "all" } } } }),
      guildIds: [HOME, OTHER, THIRD],
    });
    const bodies = routed(p);
    expect(names(bodies.get(OTHER))).toEqual([...CORE, ...MUSIC]);
    // Neither the home server nor the third one gets music's commands.
    for (const guildId of [HOME, THIRD]) {
      for (const bare of MUSIC) expect(names(bodies.get(guildId))).not.toContain(bare);
    }
  });

  test("an unplaced plugin's commands go to the home server only", () => {
    // music is placed (in OTHER); wow has no entry, so it is unplaced and lives in the home server.
    const bodies = routed(
      plan({ routing: routing({ music: { servers: { [OTHER]: { commands: "all" } } } }), guildIds: [HOME, OTHER, THIRD] }),
    );
    expect(names(bodies.get(HOME))).toEqual([...CORE, ...WOW]);
    expect(names(bodies.get(OTHER))).toEqual([...CORE, ...MUSIC]);
    expect(names(bodies.get(THIRD))).toEqual([...CORE]);
  });

  test("with no home server an unplaced plugin's commands go to every server", () => {
    const bodies = routed(
      plan({ routing: routing({ music: { servers: { [OTHER]: { commands: "all" } } } }), homeGuildId: undefined, guildIds: [HOME, OTHER] }),
    );
    // wow is unplaced and there is no home server, so it lives everywhere.
    expect(names(bodies.get(HOME))).toEqual([...CORE, ...WOW]);
    expect(names(bodies.get(OTHER))).toEqual([...CORE, ...MUSIC, ...WOW]);
  });

  test("core commands go to every server", () => {
    const bodies = routed(
      plan({ routing: routing({ music: { servers: { [OTHER]: { commands: "all" } } } }), guildIds: [HOME, OTHER, THIRD] }),
    );
    for (const guildId of [HOME, OTHER, THIRD]) {
      for (const bare of CORE) expect(names(bodies.get(guildId))).toContain(bare);
    }
  });

  test("a server nobody lives in gets core only", () => {
    const bodies = routed(
      plan({
        routing: routing({ music: { servers: { [OTHER]: { commands: "all" } } }, wow: { servers: { [OTHER]: { commands: "all" } } } }),
        guildIds: [HOME, OTHER, THIRD],
      }),
    );
    // Both plugins are placed in OTHER, so neither HOME nor THIRD has anyone living in it.
    expect(names(bodies.get(HOME))).toEqual(CORE);
    expect(names(bodies.get(THIRD))).toEqual(CORE);
  });

  test("a plugin placed nowhere is registered nowhere", () => {
    // An entry with no servers is a decision ("nowhere"), not the absence of one ("home").
    const bodies = routed(plan({ routing: routing({ music: { servers: {} } }), guildIds: [HOME, OTHER] }));
    for (const guildId of [HOME, OTHER]) {
      for (const bare of MUSIC) expect(names(bodies.get(guildId))).not.toContain(bare);
    }
    // wow, unplaced, is still at home.
    expect(names(bodies.get(HOME))).toEqual([...CORE, ...WOW]);
  });

  test("order within a body is the full body's order", () => {
    // A plugin placed in both servers, plus an unplaced one at home: every body is a subsequence of
    // the full body, in its order -- core first, then music, then wow.
    const w = world();
    const bodies = routed(
      plan({ routing: routing({ music: { servers: { [HOME]: { commands: "all" }, [OTHER]: { commands: "all" } } } }) }),
    );
    for (const body of bodies.values()) {
      const positions = names(body).map((n) => names(w.fullBody).indexOf(n));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(positions.every((p) => p >= 0)).toBe(true);
    }
    expect(names(bodies.get(HOME))).toEqual([...CORE, ...MUSIC, ...WOW]);
  });

  test("routed bodies follow the servers in the order given, and a repeat is one server", () => {
    const bodies = routed(plan({ routing: routing({ music: { servers: {} } }), guildIds: [THIRD, HOME, OTHER, HOME] }));
    expect([...bodies.keys()]).toEqual([THIRD, HOME, OTHER]);
  });

  test("the prefix is respected: owners are found through the prefixed names", () => {
    const bodies = routed(plan({ prefix: "r_", routing: routing({ music: { servers: { [OTHER]: { commands: "all" } } } }) }));
    expect(names(bodies.get(OTHER))).toEqual(["r_report", "r_update", "r_plugins", "r_setlist", "r_spotify", "r_party"]);
    expect(names(bodies.get(HOME))).toEqual(["r_report", "r_update", "r_plugins", "r_dmf", "r_reset"]);
  });

  test("clearGlobal is set only when there is no home server", () => {
    const placed = routing({ music: { servers: { [OTHER]: { commands: "all" } } } });
    const withHome = plan({ routing: placed, homeGuildId: HOME });
    const noHome = plan({ routing: placed, homeGuildId: undefined });
    if (withHome.mode !== "routed" || noHome.mode !== "routed") throw new Error("expected routed plans");
    expect(withHome.clearGlobal).toBe(false);
    expect(noHome.clearGlobal).toBe(true);
  });

  test("a plugin named like an inherited property is placed like any other", () => {
    // `constructor` is a legal plugin name; a lookup on the routing file must not answer for Object.
    const w = world();
    const map: PluginCommandMap = new Map([
      ["conf", { entry: { name: "constructor" } as PluginIndexEntry, command: { name: "conf" } as PluginCommand }],
    ]);
    const placedInOther: PluginRouting = { servers: { [OTHER]: { commands: "all" } } };
    const bodies = routed(
      planRegistration({
        routing: routing({ constructor: placedInOther }),
        fullBody: [...w.fullBody.slice(0, 3), command("conf")],
        prefix: "",
        commandMap: map,
        loaded: ["constructor"],
        guildIds: [HOME, OTHER],
        homeGuildId: HOME,
      }),
    );
    expect(names(bodies.get(OTHER))).toContain("conf");
    expect(names(bodies.get(HOME))).not.toContain("conf");
  });
});

type PutCall = { route: string; body: CommandJson[] };

function fakePut(failures: Record<string, unknown> = {}) {
  const calls: PutCall[] = [];
  const put = async (route: `/${string}`, body: CommandJson[]): Promise<unknown> => {
    calls.push({ route, body });
    if (Object.hasOwn(failures, route)) throw failures[route];
    return undefined;
  };
  return { calls, put };
}

const now = () => NOW;
const guildRoute = (id: string) => `/applications/${APP}/guilds/${id}/commands`;
const GLOBAL_ROUTE = `/applications/${APP}/commands`;

describe("registerPlan in single mode", () => {
  test("single mode issues exactly one put, to the guild route", async () => {
    const w = world();
    const { calls, put } = fakePut();
    const results = await registerPlan(put, APP, plan({ routing: freshRouting() }), now);
    // Exactly the call the bot always made: one PUT, to the home guild's commands, with every command.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.route).toBe(guildRoute(HOME));
    expect(calls[0]!.body).toEqual(w.fullBody);
    expect(results).toEqual([{ guildId: HOME, registered: w.fullBody.length, at: NOW.toISOString() }]);
  });

  test("single mode issues exactly one put, to the global route", async () => {
    const w = world();
    const { calls, put } = fakePut();
    const results = await registerPlan(put, APP, plan({ routing: freshRouting(), homeGuildId: undefined }), now);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.route).toBe(GLOBAL_ROUTE);
    expect(calls[0]!.body).toEqual(w.fullBody);
    expect(results).toEqual([{ guildId: "global", registered: w.fullBody.length, at: NOW.toISOString() }]);
  });

  test("single mode uses exactly the route the pre-routing code used, computed the way it computed it", async () => {
    // What src/index.ts evaluated before #239: `config.guildId ? applicationGuildCommands(id, guildId)
    // : applicationCommands(id)`. Recomputed here with discord.js's own Routes, not typed out.
    const before = (guildId: string | undefined) =>
      guildId ? Routes.applicationGuildCommands(APP, guildId) : Routes.applicationCommands(APP);
    for (const homeGuildId of [HOME, undefined]) {
      const { calls, put } = fakePut();
      await registerPlan(put, APP, plan({ routing: freshRouting(), homeGuildId }), now);
      expect(calls.map((c) => c.route)).toEqual([before(homeGuildId)]);
    }
  });

  test("single mode lets a failure throw", async () => {
    const boom = Object.assign(new Error("Missing Access"), { code: 50001 });
    const { put } = fakePut({ [guildRoute(HOME)]: boom });
    // The caller keeps today's catch and its long operator message, so the error must reach it as it was.
    await expect(registerPlan(put, APP, plan({ routing: freshRouting() }), now)).rejects.toBe(boom);
  });
});

describe("registerPlan in routed mode", () => {
  const placed = routing({ music: { servers: { [OTHER]: { commands: "all" } } } });

  test("routed mode puts once per server, in order", async () => {
    const { calls, put } = fakePut();
    const results = await registerPlan(put, APP, plan({ routing: placed, guildIds: [HOME, OTHER, THIRD] }), now);
    expect(calls.map((c) => c.route)).toEqual([guildRoute(HOME), guildRoute(OTHER), guildRoute(THIRD)]);
    expect(calls.map((c) => names(c.body).length)).toEqual([CORE.length + WOW.length, CORE.length + MUSIC.length, CORE.length]);
    expect(results).toEqual([
      { guildId: HOME, registered: CORE.length + WOW.length, at: NOW.toISOString() },
      { guildId: OTHER, registered: CORE.length + MUSIC.length, at: NOW.toISOString() },
      { guildId: THIRD, registered: CORE.length, at: NOW.toISOString() },
    ]);
  });

  test("routed mode puts one server at a time, never several at once", async () => {
    let running = 0;
    let peak = 0;
    const put = async (): Promise<unknown> => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return undefined;
    };
    await registerPlan(put, APP, plan({ routing: placed, guildIds: [HOME, OTHER, THIRD] }), now);
    expect(peak).toBe(1);
  });

  test("a refusal in one server is recorded and the rest still register", async () => {
    const refusal = Object.assign(new Error("Missing Access"), { code: 50001 });
    const { calls, put } = fakePut({ [guildRoute(OTHER)]: refusal });
    const results = await registerPlan(put, APP, plan({ routing: placed, guildIds: [HOME, OTHER, THIRD] }), now);
    // All three were attempted, in order, despite the middle one being refused...
    expect(calls.map((c) => c.route)).toEqual([guildRoute(HOME), guildRoute(OTHER), guildRoute(THIRD)]);
    // ...and only that one carries an error.
    expect(results.map((r) => [r.guildId, r.registered, r.error])).toEqual([
      [HOME, CORE.length + WOW.length, undefined],
      [OTHER, 0, "Missing Access (50001)"],
      [THIRD, CORE.length, undefined],
    ]);
  });

  test("every server refused still resolves, with an error against each", async () => {
    const refusal = Object.assign(new Error("Missing Access"), { code: 50001 });
    const { put } = fakePut({ [guildRoute(HOME)]: refusal, [guildRoute(OTHER)]: refusal });
    const results = await registerPlan(put, APP, plan({ routing: placed }), now);
    expect(results.map((r) => r.error)).toEqual(["Missing Access (50001)", "Missing Access (50001)"]);
  });

  test("a DiscordAPIError is reported as \"message (code)\"", async () => {
    // The real class, not a stand-in: its `message` is Discord's text and its `code` the numeric error.
    const real = new DiscordAPIError(
      { message: "Missing Access", code: 50001 },
      50001,
      403,
      "PUT",
      `https://discord.com/api/v10/applications/${APP}/guilds/${OTHER}/commands`,
      { body: undefined, files: undefined },
    );
    const { put } = fakePut({ [guildRoute(OTHER)]: real });
    const results = await registerPlan(put, APP, plan({ routing: placed }), now);
    expect(results.find((r) => r.guildId === OTHER)!.error).toBe("Missing Access (50001)");
  });

  test("a long error is clipped", async () => {
    const { put } = fakePut({ [guildRoute(HOME)]: new Error("x".repeat(1000)) });
    const results = await registerPlan(put, APP, plan({ routing: placed }), now);
    const error = results.find((r) => r.guildId === HOME)!.error!;
    expect(error).toHaveLength(200);
    expect(error.endsWith("...")).toBe(true);
    expect(error.startsWith("Error: xxxx")).toBe(true);
  });

  test("routed mode empties the global scope when asked, and survives that failing", async () => {
    const noHome = plan({ routing: placed, homeGuildId: undefined });

    // Asked to, it makes one last put to the global route with an empty list -- and reports nothing.
    const ok = fakePut();
    const okResults = await registerPlan(ok.put, APP, noHome, now);
    expect(ok.calls.at(-1)).toEqual({ route: GLOBAL_ROUTE, body: [] });
    expect(ok.calls).toHaveLength(3);
    expect(okResults.map((r) => r.guildId)).toEqual([HOME, OTHER]);

    // A failure there is recorded against "global", and does not throw.
    const failing = fakePut({ [GLOBAL_ROUTE]: Object.assign(new Error("Unknown application"), { code: 10002 }) });
    const failResults = await registerPlan(failing.put, APP, noHome, now);
    expect(failResults.at(-1)).toEqual({ guildId: "global", registered: 0, error: "Unknown application (10002)", at: NOW.toISOString() });
    expect(failResults.slice(0, -1).every((r) => r.error === undefined)).toBe(true);
  });

  test("routed mode leaves the global scope alone when there is a home server", async () => {
    const { calls, put } = fakePut();
    await registerPlan(put, APP, plan({ routing: placed, homeGuildId: HOME }), now);
    expect(calls.map((c) => c.route)).not.toContain(GLOBAL_ROUTE);
  });

  test("routed mode with no servers makes no calls, and a global clear only when asked", async () => {
    const none = fakePut();
    expect(await registerPlan(none.put, APP, plan({ routing: placed, guildIds: [] }), now)).toEqual([]);
    expect(none.calls).toEqual([]);
    const clearing = fakePut();
    await registerPlan(clearing.put, APP, plan({ routing: placed, guildIds: [], homeGuildId: undefined }), now);
    expect(clearing.calls).toEqual([{ route: GLOBAL_ROUTE, body: [] }]);
  });
});

describe("describeError", () => {
  test("a Discord-shaped error is message and code; anything else is its text", () => {
    expect(describeError(Object.assign(new Error("Missing Access"), { code: 50001 }))).toBe("Missing Access (50001)");
    expect(describeError(new Error("boom"))).toBe("Error: boom");
    expect(describeError("plain text")).toBe("plain text");
    expect(describeError(undefined)).toBe("undefined");
    // A code that is not a number is not a Discord code (Node's own errors carry string codes).
    expect(describeError(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }))).toBe("Error: connect failed");
  });

  test("it never throws, even for a value whose text cannot be made", () => {
    const hostile = {
      get code(): number {
        throw new Error("no code for you");
      },
    };
    const noText = Object.create(null) as object;
    expect(() => describeError(hostile)).not.toThrow();
    expect(describeError(noText)).toBe("unknown error");
  });
});
