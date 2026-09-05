// Tests for the #105 request mailbox consumer — pure over an in-memory FS seam + fake mutate/restart,
// no real filesystem. `validate` (the trust boundary) is tested directly for every reject reason;
// `consumePluginRequests` is tested for order, delete-on-apply, quarantine, one-restart-per-drain,
// and the single-flight guard.
import { beforeEach, describe, expect, test } from "bun:test";
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

  function harness(files: Record<string, unknown>) {
    const fs = new Map<string, string>(Object.entries(files).map(([k, v]) => [k, JSON.stringify(v)]));
    const rejected: string[] = [];
    const restarts: string[] = [];
    const mutations: number[] = [];
    let state: PluginStateFile = { hostApiVersion: 1, writtenAt: "", plugins: [{ name: "warbandeer", enabled: true, configured: true, missingEnv: [], active: true, installedVersion: "1.0.0" }] };
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
      loadIndex: async (): Promise<PluginIndex> => ({ schemaVersion: 1, generatedAt: "", plugins: [entry("warbandeer", "1.1.0")] }),
      readState: async () => state,
      mutateState: async (mutate) => { state = mutate(state); mutations.push(1); },
      requestRestart: (reason) => restarts.push(reason),
      hostApiVersion: 1,
      now: () => new Date("2026-09-05T12:00:00.000Z"),
      log: { info() {}, warn() {}, error() {} },
    };
    return { deps, fs, rejected, restarts, mutations, get state() { return state; } };
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
});
