// Tests for the #105 request mailbox consumer — pure over an in-memory FS seam + fake mutate/restart,
// no real filesystem. `validate` (the trust boundary) is tested directly for every reject reason;
// `consumePluginRequests` is tested for order, delete-on-apply, quarantine, one-restart-per-drain,
// and the single-flight guard.
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { freshRouting, freshSecrets, repairRouting, repairSecrets, type DiscoveryFile, type RoutingFile } from "../routing/model";
import type { RoutingRequestDeps } from "../routing/requests";
import type { PluginIndex, PluginIndexEntry, PluginStateEntry, PluginStateFile } from "./contract";
import { consumePluginRequests, resetPluginRequestsForTest, validate, type PluginRequestDeps } from "./requests";

const REQ_DIR = "/data/plugins/requests";

function entry(name: string, version: string, hostApiVersion = 1): PluginIndexEntry {
  return { name, package: `@rackbops/plugin-${name}`, version, description: name, hostApiVersion, commands: [], env: [], releases: [] };
}
function installedMap(...names: [string, string | undefined][]): Map<string, PluginStateEntry> {
  return new Map(names.map(([name, v]) => [name, { name, enabled: true, configured: true, missingEnv: [], active: true, ...(v ? { installedVersion: v } : {}) }]));
}
const entryMap = (...es: PluginIndexEntry[]) => new Map(es.map((e) => [e.name, e]));

describe("validate (#105 trust boundary)", () => {
  const installed = installedMap(["warbandeer", "1.0.0"]);
  const entries = entryMap(entry("warbandeer", "1.1.0"));
  const ok = (raw: unknown) => validate(raw, installed, entries, 1);

  test("accepts each well-formed action", () => {
    expect(ok({ action: "update-now", plugin: "warbandeer", version: "1.1.0", requestedBy: "email:x" }).ok).toBe(true);
    expect(ok({ action: "schedule", plugin: "warbandeer", version: "1.1.0", at: "2026-09-06T18:30-07:00", requestedBy: "token" }).ok).toBe(true);
    expect(ok({ action: "remind", plugin: "warbandeer", version: "1.1.0", days: 7, requestedBy: "token" }).ok).toBe(true);
    expect(ok({ action: "skip", plugin: "warbandeer", version: "1.1.0", requestedBy: "token" }).ok).toBe(true);
    expect(ok({ action: "cancel", plugin: "warbandeer", requestedBy: "token" }).ok).toBe(true);
  });

  test("rejects a non-object / unknown action / bad plugin / missing requestedBy", () => {
    expect(ok(null).ok).toBe(false);
    expect(ok("nope").ok).toBe(false);
    expect(ok({ action: "delete-everything", plugin: "warbandeer", version: "1.1.0", requestedBy: "t" }).ok).toBe(false);
    expect(ok({ action: "skip", plugin: "Warbandeer", version: "1.1.0", requestedBy: "t" }).ok).toBe(false); // uppercase
    expect(ok({ action: "skip", plugin: "warbandeer", version: "1.1.0", requestedBy: "" }).ok).toBe(false);
  });

  test("rejects a version with a slash or path traversal (the security gate)", () => {
    for (const version of ["1.0.0/../../etc", "../../evil", "1.0.0/x", "latest"]) {
      expect(ok({ action: "update-now", plugin: "warbandeer", version, requestedBy: "t" }).ok, version).toBe(false);
    }
  });

  test("rejects a not-installed plugin (updateEntry would silently no-op)", () => {
    expect(ok({ action: "skip", plugin: "ghost", version: "1.1.0", requestedBy: "t" }).ok).toBe(false);
  });

  test("rejects a bad schedule time and out-of-range days", () => {
    expect(ok({ action: "schedule", plugin: "warbandeer", version: "1.1.0", at: "tomorrow", requestedBy: "t" }).ok).toBe(false);
    expect(ok({ action: "schedule", plugin: "warbandeer", version: "1.1.0", at: "2026-09-06T18:30", requestedBy: "t" }).ok).toBe(false); // no offset
    expect(ok({ action: "remind", plugin: "warbandeer", version: "1.1.0", days: 0, requestedBy: "t" }).ok).toBe(false);
    expect(ok({ action: "remind", plugin: "warbandeer", version: "1.1.0", days: 1000, requestedBy: "t" }).ok).toBe(false);
  });

  test("rejects an update to the index's CURRENT version when it's host-API-incompatible", () => {
    const incompatEntries = entryMap(entry("warbandeer", "1.1.0", 2)); // needs host API v2
    expect(validate({ action: "update-now", plugin: "warbandeer", version: "1.1.0", requestedBy: "t" }, installed, incompatEntries, 1).ok).toBe(false);
    // …but an explicit pin to a DIFFERENT (older) version is honored (compat unknowable per-release).
    expect(validate({ action: "update-now", plugin: "warbandeer", version: "1.0.5", requestedBy: "t" }, installed, incompatEntries, 1).ok).toBe(true);
  });
});

describe("consumePluginRequests drain", () => {
  beforeEach(resetPluginRequestsForTest);

  function harness(files: Record<string, unknown>, opts: { routing?: RoutingRequestDeps; state?: PluginStateFile } = {}) {
    const fs = new Map<string, string>(Object.entries(files).map(([k, v]) => [k, JSON.stringify(v)]));
    const rejected: string[] = [];
    const restarts: string[] = [];
    const mutations: number[] = [];
    const warns: string[] = [];
    const errors: string[] = [];
    let indexLoads = 0;
    let stateReads = 0;
    let state: PluginStateFile = opts.state ?? { hostApiVersion: 1, writtenAt: "", plugins: [{ name: "warbandeer", enabled: true, configured: true, missingEnv: [], active: true, installedVersion: "1.0.0" }] };
    const deps: PluginRequestDeps = {
      requestsDir: REQ_DIR,
      readDir: async (dir) => (dir === REQ_DIR ? [...fs.keys()] : Promise.reject(new Error("ENOENT"))),
      readFile: async (path) => {
        const name = path.slice(REQ_DIR.length + 1);
        const v = fs.get(name);
        if (v === undefined) throw new Error("ENOENT");
        return v;
      },
      unlink: async (path) => {
        const name = path.slice(REQ_DIR.length + 1);
        if (!fs.delete(name)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      rename: async (from, to) => {
        const name = from.slice(REQ_DIR.length + 1);
        fs.delete(name);
        rejected.push(to.slice((REQ_DIR + "/rejected/").length));
      },
      mkdir: async () => {},
      loadIndex: async (): Promise<PluginIndex> => {
        indexLoads += 1;
        return { schemaVersion: 1, generatedAt: "", plugins: [entry("warbandeer", "1.1.0")] };
      },
      readState: async () => {
        stateReads += 1;
        return state;
      },
      mutateState: async (mutate) => { state = mutate(state); mutations.push(1); },
      requestRestart: (reason) => restarts.push(reason),
      hostApiVersion: 1,
      now: () => new Date("2026-09-05T12:00:00.000Z"),
      log: {
        info() {},
        warn: (message) => void warns.push(message),
        error: (message, err) => void errors.push(err === undefined ? message : `${message} ${String(err)}`),
      },
      // No pause before a second look at a file that will not parse: the tests are not waiting for a writer.
      tornReadRetryMs: 0,
      ...(opts.routing === undefined ? {} : { routing: opts.routing }),
    };
    return {
      deps,
      fs,
      rejected,
      restarts,
      mutations,
      warns,
      errors,
      get indexLoads() { return indexLoads; },
      get stateReads() { return stateReads; },
      get state() { return state; },
    };
  }
  const wb = (over: object) => ({ plugin: "warbandeer", requestedBy: "email:me@x.com", ...over });

  test("applies a valid update-now: sets targetVersion, deletes the file, ONE restart", async () => {
    const h = harness({ "100-update-now-1.json": wb({ action: "update-now", version: "1.1.0" }) });
    await consumePluginRequests(h.deps);
    expect(h.state.plugins[0]?.targetVersion).toBe("1.1.0");
    expect(h.state.pendingReport).toMatchObject({ plugin: "warbandeer", toVersion: "1.1.0", userId: "email:me@x.com" });
    expect(h.fs.size).toBe(0); // deleted
    expect(h.restarts).toHaveLength(1);
  });

  test("honors the request's EXPLICIT version, not the index's current (pins are explicit)", async () => {
    // index current is 1.1.0, but the request pins 1.0.5 — the mailbox must queue 1.0.5.
    const h = harness({ "100-update-now-1.json": wb({ action: "update-now", version: "1.0.5" }) });
    await consumePluginRequests(h.deps);
    expect(h.state.plugins[0]?.targetVersion).toBe("1.0.5");
  });

  test("skip/schedule/remind/cancel apply their mutation and never restart", async () => {
    const h = harness({
      "100-skip-1.json": wb({ action: "skip", version: "1.1.0" }),
    });
    await consumePluginRequests(h.deps);
    expect(h.state.plugins[0]?.skippedVersion).toBe("1.1.0");
    expect(h.restarts).toHaveLength(0);
    expect(h.fs.size).toBe(0);
  });

  test("processes files in filename (epoch) order", async () => {
    const h = harness({
      "200-skip-1.json": wb({ action: "skip", version: "2.0.0" }),
      "100-skip-1.json": wb({ action: "skip", version: "1.1.0" }),
    });
    await consumePluginRequests(h.deps);
    // 100 then 200 → last-writer 2.0.0 wins (deterministic click order).
    expect(h.state.plugins[0]?.skippedVersion).toBe("2.0.0");
  });

  test("multiple update-now files share ONE restart across the drain (later files not stranded)", async () => {
    // Two update-now files + a cancel: the restart is requested ONCE, after the whole drain — a
    // restart-per-file would fire twice and (in production) strand the files dropped after the first.
    const h = harness({
      "100-update-now-1.json": wb({ action: "update-now", version: "1.0.5" }),
      "200-update-now-1.json": wb({ action: "update-now", version: "1.1.0" }),
      "300-cancel-1.json": wb({ action: "cancel" }),
    });
    await consumePluginRequests(h.deps);
    expect(h.fs.size).toBe(0); // all three drained despite the two update-nows
    expect(h.restarts).toHaveLength(1); // exactly one restart, AFTER the full drain
  });

  test("a malformed / invalid file is quarantined to rejected/, never thrown, others still apply", async () => {
    const h = harness({
      "200-skip-1.json": wb({ action: "skip", version: "1.1.0" }),
      "300-x.json": wb({ action: "nope", version: "1.1.0" }),
    });
    h.fs.set("100-x.json", "{ not json"); // raw invalid JSON (bypasses the harness's JSON.stringify)
    await consumePluginRequests(h.deps);
    expect(h.rejected.sort()).toEqual(["100-x.json", "300-x.json"]);
    expect(h.state.plugins[0]?.skippedVersion).toBe("1.1.0"); // the valid one still applied
    expect(h.fs.size).toBe(0);
  });

  test("single-flight: two concurrent drains process each file once", async () => {
    const h = harness({ "100-skip-1.json": wb({ action: "skip", version: "1.1.0" }) });
    await Promise.all([consumePluginRequests(h.deps), consumePluginRequests(h.deps)]);
    expect(h.mutations).toHaveLength(1); // applied exactly once, not twice
  });

  test("an empty / missing requests dir is a no-op", async () => {
    const h = harness({});
    await consumePluginRequests(h.deps);
    expect(h.mutations).toHaveLength(0);
    expect(h.restarts).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------------
  // #241: the four routing actions share the directory, and #249's fix rides along.
  // -------------------------------------------------------------------------------------------------
  describe("routing requests in the mailbox (#241)", () => {
    const HOME = "111111111111111111";
    const OTHER = "222222222222222222";
    const CH = "333333333333333331";
    const WH_ID = "555555555555555555";
    const TOKEN = "TOKEN_abcdefghij0123456789xyz";
    const URL_OK = `https://discord.com/api/webhooks/${WH_ID}/${TOKEN}`;
    const ID = "req_12345678";
    const AT = "2026-09-05T12:00:00.000Z";

    const discovery = (): DiscoveryFile => ({
      v: 1,
      generatedAt: AT,
      bot: { id: "900000000000000000", username: "Setlist Bot" },
      inviteUrl: "",
      homeGuildId: HOME,
      guilds: [{ id: HOME, name: "Home", channels: [{ id: CH, name: "general", canSend: true }], commands: null }],
      plugins: {},
    });

    /** Routing deps over an in-memory routing.json, recording what was called. */
    function routingFake(over: Partial<RoutingRequestDeps> = {}) {
      let routing: RoutingFile = freshRouting();
      let secrets = freshSecrets();
      const calls: string[] = [];
      const deps: RoutingRequestDeps = {
        readDiscovery: async () => discovery(),
        readRouting: async () => structuredClone(routing),
        readSecrets: async () => structuredClone(secrets),
        mutateRouting: async (mutate) => {
          calls.push("mutateRouting");
          routing = repairRouting(mutate(repairRouting(routing)));
        },
        mutateSecrets: async (mutate) => {
          calls.push("mutateSecrets");
          secrets = repairSecrets(mutate(repairSecrets(secrets)));
        },
        fetchWebhook: async () => ({ ok: true, id: WH_ID, channelId: CH, guildId: HOME }),
        applyRouting: async (reason) => {
          calls.push(`applyRouting ${reason}`);
          return {};
        },
        refreshDiscovery: async () => void calls.push("refreshDiscovery"),
        now: () => new Date(AT),
        log: { warn() {} },
        ...over,
      };
      return {
        deps,
        calls,
        get routing() {
          return routing;
        },
        get secrets() {
          return secrets;
        },
      };
    }

    const req = (over: object = {}) => ({ requestedBy: "email:me@x.com", id: ID, ...over });
    const refresh = (over: object = {}) => req({ action: "discovery-refresh", ...over });
    const setPlugin = (over: object = {}) => req({ action: "routing-set", plugin: "music", servers: { [HOME]: { commands: "all" } }, ...over });
    const addWebhook = (over: object = {}) => req({ action: "webhook-add", url: URL_OK, ...over });
    const removeWebhook = (over: object = {}) => req({ action: "webhook-remove", channelId: CH, ...over });

    test("a routing action is dispatched and removed from the mailbox", async () => {
      const r = routingFake();
      const h = harness({ "100-discovery-refresh-1.json": refresh() }, { routing: r.deps });
      await consumePluginRequests(h.deps);
      expect(r.calls).toContain("refreshDiscovery");
      expect(h.fs.size).toBe(0);
      expect(h.rejected).toEqual([]);
      expect(h.warns).toEqual([]);
    });

    test("routing-set, webhook-add and webhook-remove are each applied and removed", async () => {
      const r = routingFake();
      const h = harness(
        {
          "100-routing-set-1.json": setPlugin({ id: undefined }),
          "200-webhook-add-1.json": addWebhook({ id: undefined }),
          "300-webhook-remove-1.json": removeWebhook({ id: undefined }),
        },
        { routing: r.deps },
      );
      await consumePluginRequests(h.deps);
      expect(r.calls).toEqual([
        "mutateRouting",
        "applyRouting routing-set music",
        "mutateSecrets",
        "mutateRouting",
        "mutateRouting",
        "mutateSecrets",
      ]);
      expect(h.fs.size).toBe(0);
      expect(h.rejected).toEqual([]);
      expect(r.routing.plugins.music).toEqual({ servers: { [HOME]: { commands: "all" } } });
      expect(r.routing.webhooks).toEqual({});
      expect(r.secrets.webhooks).toEqual({});
    });

    test("each invalid form is rejected with a reason naming the field", async () => {
      const r = routingFake();
      const h = harness(
        {
          "100-routing-set-1.json": setPlugin({ plugin: "Bad Name", id: "req_00000001" }),
          "200-routing-set-1.json": setPlugin({ servers: "nope", id: "req_00000002" }),
          "300-webhook-remove-1.json": removeWebhook({ channelId: "abc", id: "req_00000003" }),
          "400-x.json": req({ action: "discovery-refresh", requestedBy: "", id: "req_00000004" }),
        },
        { routing: r.deps },
      );
      await consumePluginRequests(h.deps);
      expect(h.warns).toEqual([
        "[plugins] rejecting request 100-routing-set-1.json: bad plugin name",
        "[plugins] rejecting request 200-routing-set-1.json: routing must be an object with a servers object",
        "[plugins] rejecting request 300-webhook-remove-1.json: bad channel id",
        "[plugins] rejecting request 400-x.json: missing requestedBy",
      ]);
      // A refusal that carries no url is set aside for the operator, as an invalid update request is.
      expect(h.rejected.sort()).toEqual(["100-routing-set-1.json", "200-routing-set-1.json", "300-webhook-remove-1.json", "400-x.json"]);
      // The only routing writes are the four results (each request carried an id): nothing was applied.
      expect(r.calls).toEqual(["mutateRouting", "mutateRouting", "mutateRouting", "mutateRouting"]);
      expect(r.routing.results.map((x) => [x.ok, x.reason])).toEqual([
        [false, "bad plugin name"],
        [false, "routing must be an object with a servers object"],
        [false, "bad channel id"],
        [false, "missing requestedBy"],
      ]);
    });

    test("with no routing deps a routing action is rejected", async () => {
      const h = harness({
        "100-routing-set-1.json": setPlugin(),
        "200-webhook-add-1.json": addWebhook(),
      });
      await consumePluginRequests(h.deps);
      expect(h.warns).toEqual([
        "[plugins] rejecting request 100-routing-set-1.json: routing is not available",
        "[plugins] rejecting request 200-webhook-add-1.json: routing is not available",
      ]);
      // The routing-set is set aside; the webhook-add may carry a url, so it is deleted.
      expect(h.rejected).toEqual(["100-routing-set-1.json"]);
      expect(h.fs.size).toBe(0);
    });

    test("the five update actions validate and apply exactly as before", async () => {
      const r = routingFake();
      const h = harness(
        {
          "100-skip-1.json": wb({ action: "skip", version: "1.1.0" }),
          "200-cancel-1.json": wb({ action: "cancel" }),
          "300-skip-2.json": wb({ action: "skip", version: "latest" }),
          "400-skip-3.json": wb({ plugin: "ghost", action: "skip", version: "1.1.0" }),
        },
        { routing: r.deps },
      );
      await consumePluginRequests(h.deps);
      // Two acceptances, applied through the state mutator (skip, then cancel clears the pending state)...
      expect(h.mutations).toHaveLength(2);
      expect(h.state.plugins[0]?.skippedVersion).toBe("1.1.0");
      // ...and two rejections, quarantined as they always were, with their old reasons' substance.
      expect(h.rejected.sort()).toEqual(["300-skip-2.json", "400-skip-3.json"]);
      expect(h.warns.some((w) => w.includes("300-skip-2.json") && w.includes("bad version"))).toBe(true);
      expect(h.warns.some((w) => w.includes("400-skip-3.json") && w.includes("ghost is not an installed plugin"))).toBe(true);
      // None of it went near the routing handler, and it recorded no result.
      expect(r.calls).toEqual([]);
      expect(r.routing.results).toEqual([]);
      expect(h.fs.size).toBe(0);
    });

    test("a request whose validation throws is rejected, and the next file in the drain is still applied", async () => {
      // #249: `validate` threw out of the drain with the file still queued, so it threw on every later drain.
      const trap = {
        name: "trap",
        enabled: true,
        configured: true,
        missingEnv: [],
        active: true,
        get installedVersion(): string {
          throw new Error("boom");
        },
      } as unknown as PluginStateEntry;
      const state: PluginStateFile = {
        hostApiVersion: 1,
        writtenAt: "",
        plugins: [{ name: "warbandeer", enabled: true, configured: true, missingEnv: [], active: true, installedVersion: "1.0.0" }, trap],
      };
      const h = harness(
        {
          "100-skip-1.json": wb({ plugin: "trap", action: "skip", version: "1.1.0" }),
          "200-skip-1.json": wb({ action: "skip", version: "1.1.0" }),
        },
        { state },
      );
      await consumePluginRequests(h.deps);
      expect(h.rejected).toEqual(["100-skip-1.json"]);
      expect(h.warns).toEqual(["[plugins] rejecting request 100-skip-1.json: validation threw — boom"]);
      expect(h.state.plugins[0]?.skippedVersion).toBe("1.1.0"); // the next file was still applied
      expect(h.fs.size).toBe(0); // and the thrower is gone, so it cannot wedge the next drain
    });

    test("validate does not throw on a 100k-deep action, plugin, version, at or days", () => {
      const nest = (kind: "array" | "object"): unknown => {
        let value: unknown = "leaf";
        for (let i = 0; i < 100_000; i += 1) value = kind === "array" ? [value] : { next: value };
        return value;
      };
      const installed = installedMap(["warbandeer", "1.0.0"]);
      const entries = entryMap(entry("warbandeer", "1.1.0"));
      for (const kind of ["array", "object"] as const) {
        const deep = nest(kind);
        const base = { action: "schedule", plugin: "warbandeer", version: "1.1.0", at: "2026-09-06T18:30-07:00", requestedBy: "t" };
        const cases: Record<string, object> = {
          action: { ...base, action: deep },
          plugin: { ...base, plugin: deep },
          version: { ...base, version: deep },
          at: { ...base, at: deep },
          days: { ...base, action: "remind", days: deep },
        };
        for (const [field, raw] of Object.entries(cases)) {
          let result: ReturnType<typeof validate> | undefined;
          expect(() => (result = validate(raw, installed, entries, 1)), `${kind} ${field}`).not.toThrow();
          expect(result?.ok, `${kind} ${field}`).toBe(false);
          // Named, not printed: the reason stays short however deep the value was.
          expect(result && !result.ok && result.reason.length, `${kind} ${field}`).toBeLessThan(80);
        }
      }
    });

    test("the reasons an update request is refused with still name the field and quote a short value", () => {
      const installed = installedMap(["warbandeer", "1.0.0"]);
      const entries = entryMap(entry("warbandeer", "1.1.0"));
      const why = (raw: object) => {
        const v = validate(raw, installed, entries, 1);
        return v.ok ? undefined : v.reason;
      };
      expect(why({ action: "nope", plugin: "warbandeer", requestedBy: "t" })).toContain("unknown action");
      expect(why({ action: "skip", plugin: "Bad", requestedBy: "t" })).toContain("bad plugin name");
      expect(why({ action: "skip", plugin: "warbandeer", version: "latest", requestedBy: "t" })).toContain("bad version");
      expect(why({ action: "schedule", plugin: "warbandeer", version: "1.1.0", at: "soon", requestedBy: "t" })).toContain("bad schedule time");
      expect(why({ action: "remind", plugin: "warbandeer", version: "1.1.0", days: 0, requestedBy: "t" })).toContain("bad days");
      // A long value is clipped rather than echoed at length.
      expect(why({ action: "skip", plugin: "warbandeer", version: "x".repeat(5000), requestedBy: "t" })!.length).toBeLessThan(80);
    });

    test("the Plugin Index is not loaded for a drain of routing requests only", async () => {
      const r = routingFake();
      const h = harness({ "100-discovery-refresh-1.json": refresh(), "200-routing-set-1.json": setPlugin() }, { routing: r.deps });
      await consumePluginRequests(h.deps);
      expect(h.indexLoads).toBe(0);
      expect(h.stateReads).toBe(0);
      expect(h.fs.size).toBe(0);
    });

    test("… and is loaded once for a drain that mixes both", async () => {
      const r = routingFake();
      const h = harness(
        {
          "100-discovery-refresh-1.json": refresh(),
          "200-skip-1.json": wb({ action: "skip", version: "1.1.0" }),
          "300-routing-set-1.json": setPlugin(),
          "400-cancel-1.json": wb({ action: "cancel" }),
        },
        { routing: r.deps },
      );
      await consumePluginRequests(h.deps);
      expect(h.indexLoads).toBe(1);
      expect(h.stateReads).toBe(1);
      expect(h.fs.size).toBe(0);
      expect(h.state.plugins[0]?.skippedVersion).toBe("1.1.0");
    });

    test("a Plugin Index that cannot be loaded leaves the update files queued, as it always did", async () => {
      const h = harness({ "100-skip-1.json": wb({ action: "skip", version: "1.1.0" }) });
      h.deps.loadIndex = async () => {
        throw new Error("index down");
      };
      await expect(consumePluginRequests(h.deps)).rejects.toThrow("index down");
      expect(h.fs.size).toBe(1);
      expect(h.rejected).toEqual([]);
    });

    test("a rejected file that carries a webhook url is deleted, not moved to rejected/", async () => {
      const r = routingFake();
      const escaped = String.raw`{"action":"skip","plugin":"ghost","version":"1.1.0","requestedBy":"https:\/\/discord.com\/api\/webhooks\/123456\/TOKENTOKENTOKENTOKENTOKEN"}`;
      const h = harness(
        {
          // Refused by the parser, named for what it carries.
          "100-webhook-add-1.json": addWebhook({ url: "https://discord.com/api/webhooks/123456/short" }),
          // Refused as an update request, but its text holds a url.
          "200-x.json": wb({ plugin: "ghost", action: "skip", version: "1.1.0", requestedBy: URL_OK }),
          // The same, with the slashes JSON-escaped.
          "400-y.json": {},
          // A webhook-add the writer named for something else.
          "500-z.json": addWebhook({ url: "nope" }),
          // A refusal that carries nothing secret is still set aside.
          "600-w.json": wb({ action: "nope", version: "1.1.0" }),
        },
        { routing: r.deps },
      );
      h.fs.set("400-y.json", escaped);
      await consumePluginRequests(h.deps);
      expect(h.rejected).toEqual(["600-w.json"]);
      expect(h.fs.size).toBe(0);
    });

    test("a file the writer named for webhook-add is treated as secret even when nothing in it can be read", async () => {
      const r = routingFake();
      const h = harness({}, { routing: r.deps });
      // Unparseable, and with no url in its text: only its NAME says what it was meant to carry.
      h.fs.set("100-webhook-add-1.json", "{ not json");
      await consumePluginRequests(h.deps);
      expect(h.warns).toEqual(["[plugins] rejecting request 100-webhook-add-1.json: unreadable JSON"]);
      expect(h.rejected).toEqual([]);
      expect(h.fs.size).toBe(0);
    });

    test("a webhook-add file that cannot even be read is deleted, and the fs error is not quoted", async () => {
      const r = routingFake();
      const h = harness({ "100-webhook-add-1.json": addWebhook() }, { routing: r.deps });
      h.deps.readFile = async () => {
        throw new Error(`EIO reading a file that holds ${URL_OK}`);
      };
      await consumePluginRequests(h.deps);
      expect(h.warns).toEqual(["[plugins] rejecting request 100-webhook-add-1.json: unreadable JSON"]);
      expect(h.rejected).toEqual([]);
      expect(h.fs.size).toBe(0);
    });

    test("a url whose slashes are spelled \\u002f is still recognised, wherever the file is named", async () => {
      const h = harness({});
      // Built from character codes: a `backslash u 0 0 2 f` typed into an editor or a tool can be turned
      // into the character it stands for, and then this would only be testing a plain slash.
      const slash = `${String.fromCharCode(92)}u002f`;
      const escaped = `https:${slash}${slash}discord.com${slash}api${slash}webhooks${slash}123456${slash}TOKENTOKENTOKENTOKENTOKEN`;
      expect(escaped).not.toContain("/");
      h.fs.set("100-x.json", `{"action":"skip","plugin":"ghost","version":"1.1.0","requestedBy":"${escaped}"}`);
      await consumePluginRequests(h.deps);
      expect(h.rejected).toEqual([]);
      expect(h.fs.size).toBe(0);
    });

    test("an update request that carries a url is refused and deleted, never applied", async () => {
      // Its `requestedBy` would land in state.json and a log line, and no update request has a reason to
      // hold a webhook url.
      const h = harness({
        "100-skip-1.json": wb({ action: "skip", version: "1.1.0", requestedBy: URL_OK }),
        "200-skip-1.json": wb({ action: "skip", version: "1.1.0", note: URL_OK }),
        "300-skip-1.json": wb({ action: "skip", version: "1.1.0" }),
      });
      await consumePluginRequests(h.deps);
      expect(h.warns).toEqual([
        "[plugins] rejecting request 100-skip-1.json: a webhook url does not belong in this request",
        "[plugins] rejecting request 200-skip-1.json: a webhook url does not belong in this request",
      ]);
      expect(h.rejected).toEqual([]);
      // Only the clean one was applied, and the url never reached the state.
      expect(h.mutations).toHaveLength(1);
      expect(JSON.stringify(h.state)).not.toContain(TOKEN);
      expect(h.fs.size).toBe(0);
    });

    test("a file named for webhook-add that is not a routing request is refused and deleted", async () => {
      const h = harness({ "100-webhook-add-1.json": wb({ action: "skip", version: "1.1.0" }) });
      await consumePluginRequests(h.deps);
      expect(h.warns).toEqual(["[plugins] rejecting request 100-webhook-add-1.json: not a routing action"]);
      expect(h.rejected).toEqual([]);
      expect(h.mutations).toHaveLength(0);
      expect(h.fs.size).toBe(0);
    });

    test("every spelling of a webhook url is recognised in a file that is not named for one", async () => {
      const bs = String.fromCharCode(92);
      const u = (hex: string) => `${bs}u${hex}`;
      const forms: Record<string, string> = {
        plain: `https://discord.com/api/webhooks/${WH_ID}/${TOKEN}`,
        "upper case": `HTTPS://DISCORD.COM/API/WEBHOOKS/${WH_ID}/${TOKEN}`,
        versioned: `https://discord.com/api/v10/webhooks/${WH_ID}/${TOKEN}`,
        discordapp: `https://discordapp.com/api/webhooks/${WH_ID}/${TOKEN}`,
        canary: `https://canary.discord.com/api/webhooks/${WH_ID}/${TOKEN}`,
        "a port": `https://discord.com:443/api/webhooks/${WH_ID}/${TOKEN}`,
        "a doubled slash": `https://discord.com//api/webhooks/${WH_ID}/${TOKEN}`,
        "a trailing dot": `https://discord.com./api/webhooks/${WH_ID}/${TOKEN}`,
        "no host": `/api/webhooks/${WH_ID}/${TOKEN}`,
        "just the path": `webhooks/${WH_ID}/${TOKEN}`,
        "percent-encoded slashes": `https:%2F%2Fdiscord.com%2Fapi%2Fwebhooks%2F${WH_ID}%2F${TOKEN}`,
        "json-escaped slashes": `https:${bs}/${bs}/discord.com${bs}/api${bs}/webhooks${bs}/${WH_ID}${bs}/${TOKEN}`,
        "a unicode-escaped letter in the host": `https://${u("0064")}iscord.com/api/webhooks/${WH_ID}/${TOKEN}`,
        "a unicode-escaped dot": `https://discord${u("002e")}com/api/webhooks/${WH_ID}/${TOKEN}`,
        "unicode-escaped slashes": `https:${u("002f")}${u("002f")}discord.com${u("002f")}api${u("002f")}webhooks${u("002f")}${WH_ID}${u("002f")}${TOKEN}`,
        "a unicode-escaped letter in webhooks": `https://discord.com/api/${u("0077")}ebhooks/${WH_ID}/${TOKEN}`,
        // Forms only the HOST half of the detector can catch: the token has a character no token has, so the
        // path pattern (id, then 20+ token characters) does not match, but the host and `webhooks/` do.
        "the host, with an odd token": `https://discord.com/api/webhooks/${WH_ID}/aaaaaaaaaa.bbbbbbbbbb`,
        "the host in upper case, with an odd token": `HTTPS://DISCORD.COM/API/WEBHOOKS/${WH_ID}/aaaaaaaaaa.bbbbbbbbbb`,
        "the host with a version, with an odd token": `https://discord.com/api/v10/webhooks/${WH_ID}/aaaaaaaaaa.bbbbbbbbbb`,
        "the host as discordapp.com, with an odd token": `https://discordapp.com/api/webhooks/${WH_ID}/aaaaaaaaaa.bbbbbbbbbb`,
        // A form only the PATH half can catch, in upper case: there is no host to fall back on.
        "upper case, no host": `/API/WEBHOOKS/${WH_ID}/${TOKEN}`,
        // Real tokens hold hyphens and underscores; the run of token characters must not stop at them.
        "no host, a token with a hyphen": `webhooks/${WH_ID}/aaaaaaaaaa-bbbbbbbbbb`,
        "no host, a token with an underscore": `webhooks/${WH_ID}/aaaaaaaaaa_bbbbbbbbbb`,
        // Hex digits of an escape are read in either case.
        "unicode-escaped slashes in upper-case hex": `https:${u("002F")}${u("002F")}discord.com${u("002F")}api${u("002F")}webhooks${u("002F")}${WH_ID}${u("002F")}${TOKEN}`,
      };
      for (const [name, url] of Object.entries(forms)) {
        const h = harness({});
        h.fs.set("100-x.json", `{"action":"skip","plugin":"ghost","version":"1.1.0","requestedBy":"${url}"}`);
        await consumePluginRequests(h.deps);
        expect(h.rejected, name).toEqual([]);
        expect(h.fs.size, name).toBe(0);
        expect(h.mutations, name).toHaveLength(0);
        expect(h.warns, name).toEqual(["[plugins] rejecting request 100-x.json: a webhook url does not belong in this request"]);
      }
    });

    test("the path form has bounds: an id of 5 to 25 digits and a token of 20 or more, with no host to help", async () => {
      // No host, so only the path half of the detector can flag these. A snowflake is 5 to 25 digits, and no
      // token is shorter than 20 characters; text that is not shaped like either is not a url.
      const cases: [string, boolean][] = [
        [`webhooks/12345/${"a".repeat(20)}`, true],
        [`webhooks/${"1".repeat(25)}/${"a".repeat(20)}`, true],
        [`webhooks/1234/${"a".repeat(20)}`, false],
        [`webhooks/${"1".repeat(26)}/${"a".repeat(20)}`, false],
        [`webhooks/${WH_ID}/${"a".repeat(19)}`, false],
        [`webhooks/${WH_ID}/${"a".repeat(20)}`, true],
        [`webhooks/abcde/${"a".repeat(20)}`, false],
      ];
      for (const [text, flagged] of cases) {
        const h = harness({ "100-x.json": wb({ action: "skip", version: "1.1.0", requestedBy: text }) });
        await consumePluginRequests(h.deps);
        // Flagged: refused and deleted, never applied. Not flagged: an ordinary update request, applied.
        expect(h.mutations.length, text).toBe(flagged ? 0 : 1);
        expect(h.warns.length, text).toBe(flagged ? 1 : 0);
        expect(h.rejected, text).toEqual([]);
      }
    });

    test("text that only talks about webhooks is not mistaken for one", async () => {
      const h = harness({ "100-skip-1.json": wb({ action: "skip", version: "1.1.0", requestedBy: "https://example.com/api/webhooks-are-nice" }) });
      await consumePluginRequests(h.deps);
      expect(h.mutations).toHaveLength(1);
      expect(h.warns).toEqual([]);
    });

    test("a file that parses on the second read is applied, not rejected", async () => {
      const good = JSON.stringify(wb({ action: "skip", version: "1.1.0" }));
      for (const firstRead of ["", '{"plugin":"warbandeer","requestedBy":"email:me@x.com","act']) {
        const h = harness({});
        h.fs.set("100-skip-1.json", good);
        const real = h.deps.readFile;
        let reads = 0;
        h.deps.readFile = async (path) => {
          reads += 1;
          return reads === 1 ? firstRead : real(path);
        };
        await consumePluginRequests(h.deps);
        expect(reads).toBe(2);
        expect(h.rejected).toEqual([]);
        expect(h.warns).toEqual([]);
        expect(h.state.plugins[0]?.skippedVersion).toBe("1.1.0");
      }
    });

    test("the second look waits 250 ms by default, and tornReadRetryMs overrides it", async () => {
      const delays: number[] = [];
      const timers = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? -1);
        fn();
        return 0;
      }) as never);
      try {
        const byDefault = harness({});
        delete byDefault.deps.tornReadRetryMs;
        byDefault.fs.set("100-skip-1.json", "{ not json");
        await consumePluginRequests(byDefault.deps);
        expect(delays).toEqual([250]);

        delays.length = 0;
        const custom = harness({});
        custom.deps.tornReadRetryMs = 7;
        custom.fs.set("100-skip-1.json", "{ not json");
        await consumePluginRequests(custom.deps);
        expect(delays).toEqual([7]);

        // A file that parses the first time is not waited for at all.
        delays.length = 0;
        const fine = harness({ "100-skip-1.json": wb({ action: "skip", version: "1.1.0" }) });
        delete fine.deps.tornReadRetryMs;
        await consumePluginRequests(fine.deps);
        expect(delays).toEqual([]);
      } finally {
        timers.mockRestore();
      }
    });

    test("what the second look reads is what is judged: a url that only the complete file holds is still caught", async () => {
      const h = harness({});
      const complete = JSON.stringify(wb({ action: "skip", version: "1.1.0", requestedBy: URL_OK }));
      h.fs.set("100-x.json", complete);
      const real = h.deps.readFile;
      let reads = 0;
      h.deps.readFile = async (path) => {
        reads += 1;
        // The first look finds the file cut off before the url; the second finds all of it.
        return reads === 1 ? '{"action":"skip","plugin":"warbandeer","version":"1.1.0","requestedBy":"em' : real(path);
      };
      await consumePluginRequests(h.deps);
      expect(h.warns).toEqual(["[plugins] rejecting request 100-x.json: a webhook url does not belong in this request"]);
      expect(h.mutations).toHaveLength(0);
      expect(h.rejected).toEqual([]);
    });

    test("a webhook-add whose id is (part of) its own url records no result, and the request is still applied", async () => {
      const cases: [string, string][] = [
        ["the whole token", TOKEN],
        ["the start of the token", TOKEN.slice(0, 12)],
        ["the end of the token", TOKEN.slice(-12)],
        ["a stretch of the url", `${WH_ID}`],
        ["the token with something around it", `x${TOKEN}y`],
      ];
      for (const [name, id] of cases) {
        const r = routingFake();
        const h = harness({ "100-webhook-add-1.json": addWebhook({ id }) }, { routing: r.deps });
        await consumePluginRequests(h.deps);
        expect(r.routing.results, name).toEqual([]);
        expect(JSON.stringify(r.routing), name).not.toContain(TOKEN);
        // Dropped, not fatal: the webhook was added and the file removed.
        expect(r.calls, name).toContain("mutateSecrets");
        expect(h.fs.size, name).toBe(0);
      }
      // An ordinary id is kept.
      const kept = routingFake();
      const h = harness({ "100-webhook-add-1.json": addWebhook({ id: "req_12345678" }) }, { routing: kept.deps });
      await consumePluginRequests(h.deps);
      expect(kept.routing.results.map((x) => x.id)).toEqual(["req_12345678"]);
    });

    test("a refused file that was moved aside is not remembered as stuck: a later request under the same name is handled", async () => {
      const r = routingFake();
      const h = harness({ "100-routing-set-1.json": setPlugin({ plugin: "Bad Name" }) }, { routing: r.deps });
      await consumePluginRequests(h.deps);
      expect(h.rejected).toEqual(["100-routing-set-1.json"]);
      // The same name arrives again, this time a good request, before the next drain has seen the folder empty.
      h.fs.set("100-routing-set-1.json", JSON.stringify(setPlugin()));
      await consumePluginRequests(h.deps);
      expect(r.calls).toContain("applyRouting routing-set music");
      expect(h.fs.size).toBe(0);
    });

    test("a file that still does not parse is rejected once, after exactly one retry", async () => {
      const h = harness({});
      h.fs.set("100-skip-1.json", "{ not json");
      const real = h.deps.readFile;
      let reads = 0;
      h.deps.readFile = async (path) => {
        reads += 1;
        return real(path);
      };
      await consumePluginRequests(h.deps);
      // Read twice -- the file and its one retry -- and rejected once, not looked at again and again.
      expect(reads).toBe(2);
      expect(h.warns).toHaveLength(1);
      expect(h.rejected).toEqual(["100-skip-1.json"]);
      // The next drain finds it gone: it is not read at all.
      await consumePluginRequests(h.deps);
      expect(reads).toBe(2);
    });

    test("a secret-bearing file that still does not parse is deleted after its one retry, never quarantined", async () => {
      const h = harness({});
      h.fs.set("100-webhook-add-1.json", `{"url":"${URL_OK}", oops`);
      const real = h.deps.readFile;
      let reads = 0;
      h.deps.readFile = async (path) => {
        reads += 1;
        return real(path);
      };
      await consumePluginRequests(h.deps);
      expect(reads).toBe(2);
      expect(h.warns).toEqual(["[plugins] rejecting request 100-webhook-add-1.json: unreadable JSON"]);
      expect(h.rejected).toEqual([]);
      expect(h.fs.size).toBe(0);
    });

    test("a request that parses but fails validation is not read a second time", async () => {
      const h = harness({ "100-skip-1.json": wb({ action: "skip", version: "not-a-version" }) });
      const real = h.deps.readFile;
      let reads = 0;
      h.deps.readFile = async (path) => {
        reads += 1;
        return real(path);
      };
      await consumePluginRequests(h.deps);
      expect(reads).toBe(1);
      expect(h.rejected).toEqual(["100-skip-1.json"]);
    });

    test("a file that has gone by the second look keeps its first failure, and is not a crash", async () => {
      const gone = harness({});
      gone.fs.set("100-skip-1.json", "{ not json");
      const real = gone.deps.readFile;
      let reads = 0;
      gone.deps.readFile = async (path) => {
        reads += 1;
        if (reads > 1) throw new Error("ENOENT");
        return real(path);
      };
      await consumePluginRequests(gone.deps);
      expect(reads).toBe(2);
      expect(gone.warns).toHaveLength(1);
      expect(gone.warns[0]).toContain("unreadable JSON");
    });

    test("the parser's quoted text is taken out of an unparseable file's reason", async () => {
      const h = harness({});
      // Bun's parser quotes a bare identifier: `Unexpected identifier "<text>"`.
      h.fs.set("100-x.json", `{"note":${TOKEN}}`);
      await consumePluginRequests(h.deps);
      expect(h.warns).toHaveLength(1);
      expect(h.warns[0]).toContain("100-x.json: unreadable JSON — ");
      expect(h.warns[0]).not.toContain(TOKEN);
      expect(h.warns[0]).toContain('"..."');
    });

    test("a Plugin Index that is down does not hold up the routing requests behind an update request", async () => {
      const r = routingFake();
      const h = harness({ "100-skip-1.json": wb({ action: "skip", version: "1.1.0" }), "200-discovery-refresh-1.json": refresh() }, { routing: r.deps });
      h.deps.loadIndex = async () => {
        throw new Error("index down");
      };
      await expect(consumePluginRequests(h.deps)).rejects.toThrow("index down");
      // The routing request behind it was applied and removed; the update request stays queued.
      expect(r.calls).toContain("refreshDiscovery");
      expect([...h.fs.keys()]).toEqual(["100-skip-1.json"]);
      expect(h.rejected).toEqual([]);
    });

    test("a routing request whose file cannot be deleted is not applied again, and its delete is retried on the next drains", async () => {
      const r = routingFake();
      const h = harness({ "100-webhook-add-1.json": addWebhook() }, { routing: r.deps });
      const realUnlink = h.deps.unlink;
      let unlinkAttempts = 0;
      let failing = true;
      h.deps.unlink = async (path) => {
        unlinkAttempts += 1;
        if (failing) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
        return realUnlink(path);
      };
      await consumePluginRequests(h.deps);
      // Applied once, reported by name only, and the file is still there (it holds the url).
      expect(h.errors).toEqual(["[plugins] couldn't delete applied request 100-webhook-add-1.json; it will not be applied again"]);
      expect(h.fs.size).toBe(1);
      const callsAfterFirst = r.calls.length;
      const resultsAfterFirst = r.routing.results.length;
      const attemptsAfterFirst = unlinkAttempts;
      // Two more drains while it is still stuck: not applied again, no new error, and the delete IS tried again.
      await consumePluginRequests(h.deps);
      await consumePluginRequests(h.deps);
      expect(r.calls).toHaveLength(callsAfterFirst);
      expect(r.routing.results).toHaveLength(resultsAfterFirst);
      expect(h.errors).toHaveLength(1);
      expect(unlinkAttempts).toBe(attemptsAfterFirst + 2);
      // The busy file is released: the next drain removes it, and still does not apply it again.
      failing = false;
      await consumePluginRequests(h.deps);
      expect(h.fs.size).toBe(0);
      expect(r.calls).toHaveLength(callsAfterFirst);
    });

    test("a secret-bearing refusal whose file cannot be deleted is skipped from then on, and deleted once it can be", async () => {
      const r = routingFake();
      const h = harness({ "100-webhook-add-1.json": addWebhook({ url: "https://discord.com/api/webhooks/123456/short" }) }, { routing: r.deps });
      const realUnlink = h.deps.unlink;
      let failing = true;
      h.deps.unlink = async (path) => {
        if (failing) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return realUnlink(path);
      };
      await consumePluginRequests(h.deps);
      expect(h.errors).toEqual(["[plugins] couldn't delete rejected request 100-webhook-add-1.json"]);
      expect(h.warns).toHaveLength(1);
      const resultsAfterFirst = r.routing.results.length;
      // Not refused again, logged again or recorded again.
      await consumePluginRequests(h.deps);
      await consumePluginRequests(h.deps);
      expect(h.warns).toHaveLength(1);
      expect(h.errors).toHaveLength(1);
      expect(r.routing.results).toHaveLength(resultsAfterFirst);
      // And it goes as soon as it can, never into rejected/.
      failing = false;
      await consumePluginRequests(h.deps);
      expect(h.fs.size).toBe(0);
      expect(h.rejected).toEqual([]);
    });

    test("a different request under the name of a stuck one is handled, not mistaken for it", async () => {
      const r = routingFake();
      const h = harness({ "100-discovery-refresh-1.json": refresh() }, { routing: r.deps });
      h.deps.unlink = async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      };
      await consumePluginRequests(h.deps);
      const first = r.calls.filter((c) => c === "refreshDiscovery").length;
      // Someone puts another request under the same name (different text) while the first is stuck.
      h.fs.set("100-discovery-refresh-1.json", JSON.stringify(refresh({ id: "req_99999999" })));
      await consumePluginRequests(h.deps);
      expect(r.calls.filter((c) => c === "refreshDiscovery").length).toBe(first + 1);
    });

    test("an update file that is refused and cannot be moved or deleted is not refused, and logged, again on every drain", async () => {
      const h = harness({ "100-skip-1.json": wb({ action: "skip", version: "not-a-version" }) });
      h.deps.rename = async () => {
        throw new Error("EXDEV");
      };
      h.deps.unlink = async () => {
        throw new Error("EACCES");
      };
      await consumePluginRequests(h.deps);
      const warns = h.warns.length;
      const errors = h.errors.length;
      await consumePluginRequests(h.deps);
      await consumePluginRequests(h.deps);
      expect(h.warns).toHaveLength(warns);
      expect(h.errors).toHaveLength(errors);
    });

    test("a file that cannot be read, is refused, and cannot be removed is skipped from then on", async () => {
      const h = harness({ "100-skip-1.json": wb({ action: "skip", version: "1.1.0" }) });
      h.deps.readFile = async () => {
        throw new Error("EIO: i/o error");
      };
      h.deps.rename = async () => {
        throw new Error("EXDEV");
      };
      h.deps.unlink = async () => {
        throw new Error("EACCES");
      };
      await consumePluginRequests(h.deps);
      const warns = h.warns.length;
      const errors = h.errors.length;
      expect(warns).toBe(1);
      await consumePluginRequests(h.deps);
      await consumePluginRequests(h.deps);
      expect(h.warns).toHaveLength(warns);
      expect(h.errors).toHaveLength(errors);
    });

    test("two files that will not parse cost one pause between them, not one each", async () => {
      const delays: number[] = [];
      const timers = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? -1);
        fn();
        return 0;
      }) as never);
      try {
        const h = harness({});
        delete h.deps.tornReadRetryMs;
        h.fs.set("100-a.json", "{ not json");
        h.fs.set("200-b.json", "{ also not json");
        h.fs.set("300-c.json", "nope");
        await consumePluginRequests(h.deps);
        // Each was still read a second time and rejected; the wait happened once.
        expect(delays).toEqual([250]);
        expect(h.rejected.sort()).toEqual(["100-a.json", "200-b.json", "300-c.json"]);
      } finally {
        timers.mockRestore();
      }
    });

    test("a refused file that cannot be moved or deleted is also skipped from then on", async () => {
      const r = routingFake();
      const h = harness({ "100-routing-set-1.json": setPlugin({ plugin: "Bad Name" }) }, { routing: r.deps });
      h.deps.rename = async () => {
        throw new Error("EXDEV");
      };
      h.deps.unlink = async () => {
        throw new Error("EACCES");
      };
      await consumePluginRequests(h.deps);
      const warnsAfterFirst = h.warns.length;
      await consumePluginRequests(h.deps);
      expect(h.warns).toHaveLength(warnsAfterFirst);
      expect(r.routing.results).toHaveLength(1);
    });

    test("a file that is already gone when it is deleted is fine, not a stuck request", async () => {
      const r = routingFake();
      const h = harness({ "100-discovery-refresh-1.json": refresh() }, { routing: r.deps });
      h.deps.unlink = async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      };
      await consumePluginRequests(h.deps);
      expect(h.errors).toEqual([]);
    });

    test("an entry for a file that has gone is forgotten, so a new request under that name is handled", async () => {
      const r = routingFake();
      const h = harness({ "100-discovery-refresh-1.json": refresh() }, { routing: r.deps });
      const realUnlink = h.deps.unlink;
      h.deps.unlink = async () => {
        throw new Error("EACCES");
      };
      await consumePluginRequests(h.deps);
      const first = r.calls.filter((c) => c === "refreshDiscovery").length;
      // The operator removes the file by hand; the panel later sends another under the same name.
      h.fs.delete("100-discovery-refresh-1.json");
      await consumePluginRequests(h.deps);
      h.deps.unlink = realUnlink;
      h.fs.set("100-discovery-refresh-1.json", JSON.stringify(refresh()));
      await consumePluginRequests(h.deps);
      expect(r.calls.filter((c) => c === "refreshDiscovery").length).toBe(first + 1);
    });

    test("an error message that holds a url is redacted in the rejection log, for an update request too", async () => {
      // Not a reason the code would produce; the point is that no path to a log line trusts the message.
      const throwingGetter = {
        name: "trap",
        enabled: true,
        configured: true,
        missingEnv: [],
        active: true,
        get installedVersion(): string {
          throw new Error(`boom near ${URL_OK}`);
        },
      } as unknown as PluginStateEntry;
      const state: PluginStateFile = {
        hostApiVersion: 1,
        writtenAt: "",
        plugins: [{ name: "warbandeer", enabled: true, configured: true, missingEnv: [], active: true, installedVersion: "1.0.0" }, throwingGetter],
      };
      const h = harness(
        {
          "100-skip-1.json": wb({ plugin: "trap", action: "skip", version: "1.1.0" }),
          "200-skip-1.json": wb({ action: "skip", version: "1.1.0" }),
        },
        { state },
      );
      h.deps.mutateState = async () => {
        throw new Error(`write failed near ${URL_OK}`);
      };
      await consumePluginRequests(h.deps);
      expect(h.warns).toEqual([
        "[plugins] rejecting request 100-skip-1.json: validation threw — boom near [webhook url]",
        "[plugins] rejecting request 200-skip-1.json: apply failed — write failed near [webhook url]",
      ]);
      expect(JSON.stringify([h.warns, h.errors])).not.toContain(TOKEN);
    });

    test("a failing result write's message is redacted before it is logged", async () => {
      const r = routingFake({
        mutateRouting: async () => {
          throw new Error(`disk error near ${URL_OK}`);
        },
      });
      const h = harness({ "100-discovery-refresh-1.json": refresh() }, { routing: r.deps });
      await consumePluginRequests(h.deps);
      expect(h.warns).toEqual(["[plugins] couldn't record the result of request 100-discovery-refresh-1.json: disk error near [webhook url]"]);
    });

    test("a secret-bearing file whose delete fails is reported by name only", async () => {
      const r = routingFake();
      const h = harness({ "100-webhook-add-1.json": addWebhook({ url: "bad" }) }, { routing: r.deps });
      h.deps.unlink = async () => {
        throw new Error(`EACCES: cannot delete, the file holds ${URL_OK}`);
      };
      await consumePluginRequests(h.deps);
      expect(h.errors).toEqual(["[plugins] couldn't delete rejected request 100-webhook-add-1.json"]);
      expect(h.rejected).toEqual([]);
    });

    test("an unparseable file named webhook-add is deleted and its reason carries no parser text", async () => {
      const r = routingFake();
      const h = harness({}, { routing: r.deps });
      h.fs.set("100-webhook-add-1.json", `{"action":"webhook-add","url":"${URL_OK}", oops`);
      await consumePluginRequests(h.deps);
      expect(h.warns).toEqual(["[plugins] rejecting request 100-webhook-add-1.json: unreadable JSON"]);
      expect(h.rejected).toEqual([]);
      expect(h.fs.size).toBe(0);
    });

    test("an unparseable file that is not secret keeps its parser message, and is set aside", async () => {
      const h = harness({});
      h.fs.set("100-skip-1.json", "{ not json");
      await consumePluginRequests(h.deps);
      expect(h.warns).toHaveLength(1);
      expect(h.warns[0]).toContain("100-skip-1.json: unreadable JSON — ");
      expect(h.rejected).toEqual(["100-skip-1.json"]);
    });

    test("an unparseable file whose TEXT holds a url, whatever it is named, carries no parser text", async () => {
      const h = harness({});
      h.fs.set("100-x.json", `{"note":"https://discord.com/api/webhooks/123456/${TOKEN}" oops`);
      await consumePluginRequests(h.deps);
      expect(h.warns).toEqual(["[plugins] rejecting request 100-x.json: unreadable JSON"]);
      expect(h.rejected).toEqual([]);
    });

    test("a reason that somehow contains a webhook url is redacted in the log and in the result", async () => {
      // The request is well-formed; the lookup dependency blows up with the url in its message. Nothing
      // in this code path should produce that, which is why it is checked against a dep that does.
      const r = routingFake({
        fetchWebhook: async () => {
          throw new Error(`lookup failed for ${URL_OK}`);
        },
      });
      const h = harness({ "100-webhook-add-1.json": addWebhook() }, { routing: r.deps });
      await consumePluginRequests(h.deps);
      expect(h.warns).toEqual(["[plugins] rejecting request 100-webhook-add-1.json: apply failed — lookup failed for [webhook url]"]);
      expect(r.routing.results).toEqual([
        { id: ID, action: "webhook-add", ok: false, reason: "apply failed — lookup failed for [webhook url]", at: AT },
      ]);
      expect(JSON.stringify([h.warns, h.errors, r.routing])).not.toContain(TOKEN);
    });

    test("an applied request records an ok result under its id", async () => {
      const r = routingFake();
      const h = harness({ "100-discovery-refresh-1.json": refresh() }, { routing: r.deps });
      await consumePluginRequests(h.deps);
      expect(r.routing.results).toEqual([{ id: ID, action: "discovery-refresh", ok: true, at: AT }]);
    });

    test("an applied routing-set records its plugin", async () => {
      const r = routingFake();
      const h = harness({ "100-routing-set-1.json": setPlugin() }, { routing: r.deps });
      await consumePluginRequests(h.deps);
      expect(r.routing.results).toEqual([{ id: ID, action: "routing-set", plugin: "music", ok: true, at: AT }]);
    });

    test("an applied webhook-add records the channel Discord named", async () => {
      const r = routingFake();
      const h = harness({ "100-webhook-add-1.json": addWebhook(), "200-webhook-remove-1.json": removeWebhook({ id: "req_87654321" }) }, { routing: r.deps });
      await consumePluginRequests(h.deps);
      expect(r.routing.results).toEqual([
        { id: ID, action: "webhook-add", channelId: CH, ok: true, at: AT },
        { id: "req_87654321", action: "webhook-remove", channelId: CH, ok: true, at: AT },
      ]);
    });

    test("a refused request records its reason", async () => {
      const r = routingFake();
      const h = harness({ "100-routing-set-1.json": setPlugin({ servers: { [OTHER]: { commands: "all" } } }) }, { routing: r.deps });
      await consumePluginRequests(h.deps);
      expect(r.routing.results).toEqual([
        { id: ID, action: "routing-set", plugin: "music", ok: false, reason: `server ${OTHER} is not one the bot is in`, at: AT },
      ]);
    });

    test("a request that fails to parse is still recorded under its id, without the fields it got wrong", async () => {
      const r = routingFake();
      const h = harness({ "100-routing-set-1.json": setPlugin({ plugin: "Bad Name" }) }, { routing: r.deps });
      await consumePluginRequests(h.deps);
      expect(r.routing.results).toEqual([{ id: ID, action: "routing-set", ok: false, reason: "bad plugin name", at: AT }]);
    });

    test("a request with no id records nothing", async () => {
      const r = routingFake();
      const h = harness(
        {
          "100-discovery-refresh-1.json": refresh({ id: undefined }),
          "200-discovery-refresh-1.json": refresh({ id: "bad id" }),
          "300-routing-set-1.json": setPlugin({ id: undefined, servers: { [OTHER]: { commands: "all" } } }),
        },
        { routing: r.deps },
      );
      await consumePluginRequests(h.deps);
      expect(r.routing.results).toEqual([]);
      // Applied and refused alike: the only mutateRouting calls would be result writes, and there were none.
      expect(r.calls).toEqual(["refreshDiscovery", "refreshDiscovery", "refreshDiscovery"]);
      // The two that were fine were still applied and removed; the refusal was set aside.
      expect(h.rejected).toEqual(["300-routing-set-1.json"]);
    });

    test("a failing result write does not fail the request", async () => {
      const r = routingFake({
        mutateRouting: async () => {
          throw new Error("disk full");
        },
      });
      const h = harness({ "100-discovery-refresh-1.json": refresh() }, { routing: r.deps });
      await consumePluginRequests(h.deps);
      // Applied and removed -- not rejected, and the failure is said out loud.
      expect(h.fs.size).toBe(0);
      expect(h.rejected).toEqual([]);
      expect(h.warns).toEqual(["[plugins] couldn't record the result of request 100-discovery-refresh-1.json: disk full"]);
    });

    test("update actions record no result", async () => {
      const r = routingFake();
      const h = harness({ "100-skip-1.json": wb({ action: "skip", version: "1.1.0", id: ID }) }, { routing: r.deps });
      await consumePluginRequests(h.deps);
      expect(r.routing.results).toEqual([]);
      expect(r.calls).toEqual([]);
    });

    test("two routing requests arriving together are applied one after the other, never interleaved", async () => {
      const order: string[] = [];
      const gate: { release: () => void } = { release: () => {} };
      const blocked = new Promise<void>((resolve) => (gate.release = resolve));
      const r = routingFake({
        refreshDiscovery: async () => {
          order.push("first:start");
          await blocked;
          order.push("first:end");
        },
        applyRouting: async (reason) => {
          order.push(`second:${reason}`);
          return {};
        },
      });
      const h = harness(
        { "100-discovery-refresh-1.json": refresh(), "200-routing-set-1.json": setPlugin() },
        { routing: r.deps },
      );
      const drain = consumePluginRequests(h.deps);
      // A second drain started while the first is stuck on its first file must not reach the second file.
      const second = consumePluginRequests(h.deps);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(order).toEqual(["first:start"]);
      gate.release();
      await Promise.all([drain, second]);
      expect(order).toEqual(["first:start", "first:end", "second:routing-set music"]);
    });
  });
});
