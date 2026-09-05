import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlugins, tarExtract, type InstallDeps } from "./install";
import type { PluginIndexEntry } from "./contract";
import type { SelectedPlugin } from "./registry";

const noopLog: InstallDeps["log"] = { info() {}, warn() {}, error() {} };
const TARBALL_URL = "https://registry.npmjs.org/@rackbops/plugin-demo/-/plugin-demo-1.0.0.tgz";

function entry(over: Partial<PluginIndexEntry> = {}): PluginIndexEntry {
  return {
    name: "demo",
    package: "@rackbops/plugin-demo",
    version: "1.0.0",
    description: "d",
    hostApiVersion: 1,
    intents: [],
    commands: ["demo"],
    env: [],
    releases: [],
    ...over,
  };
}

const sri = (bytes: Uint8Array): string => `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;

/** Fake fetch: metadata for a non-tarball URL, the tarball bytes for the tarball URL; records URLs. */
function makeFetch(opts: { bytes: Uint8Array; integrity: string; calls: string[] }): InstallDeps["fetch"] {
  return async (url) => {
    opts.calls.push(url);
    if (url === TARBALL_URL) return new Response(opts.bytes);
    return new Response(JSON.stringify({ dist: { tarball: TARBALL_URL, integrity: opts.integrity } }), {
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** A fake extract standing in for `tar`: writes dist/plugin.js into the version dir, mirroring what
 * `tar --strip-components=1` produces from `package/dist/plugin.js`. The real tarExtract is exercised
 * by the Linux-only test at the bottom (Windows `tar` mangles C: drive-letter paths). */
const fakeExtract: InstallDeps["extract"] = async (_tarPath, destDir) => {
  mkdirSync(join(destDir, "dist"), { recursive: true });
  writeFileSync(join(destDir, "dist", "plugin.js"), "extracted");
};

function withDataDir<T>(fn: (dataDir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "install-test-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("installPlugins", () => {
  test("downloads, verifies integrity, extracts, and reports the registry URL", async () => {
    await withDataDir(async (dataDir) => {
      const bytes = new TextEncoder().encode("tarball-bytes");
      const calls: string[] = [];
      const selected: SelectedPlugin[] = [{ name: "demo", entry: entry() }];
      const result = await installPlugins(selected, dataDir, {}, {
        fetch: makeFetch({ bytes, integrity: sri(bytes), calls }),
        extract: fakeExtract,
        now: () => 111,
        log: noopLog,
      });
      expect(result.skips).toEqual({});
      const bundlePath = join(dataDir, "plugins", "demo", "1.0.0", "dist", "plugin.js");
      expect(result.installed[0]?.bundlePath).toBe(bundlePath);
      expect(existsSync(bundlePath)).toBe(true);
      // metadata URL carries the encoded package + version
      expect(calls.some((u) => u === "https://registry.npmjs.org/%40rackbops%2Fplugin-demo/1.0.0")).toBe(true);
    });
  });

  test("an integrity mismatch is skipped and nothing is extracted", async () => {
    await withDataDir(async (dataDir) => {
      const bytes = new TextEncoder().encode("tarball-bytes");
      const calls: string[] = [];
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, {
        fetch: makeFetch({ bytes, integrity: "sha512-AAAAwrong", calls }),
        extract: fakeExtract,
        now: () => 1,
        log: noopLog,
      });
      expect(result.installed).toHaveLength(0);
      expect(result.skips.demo).toContain("integrity mismatch for @rackbops/plugin-demo@1.0.0");
      expect(existsSync(join(dataDir, "plugins", "demo", "1.0.0", "dist", "plugin.js"))).toBe(false);
    });
  });

  test("a cached version is reused with no fetch", async () => {
    await withDataDir(async (dataDir) => {
      const bundlePath = join(dataDir, "plugins", "demo", "1.0.0", "dist", "plugin.js");
      mkdirSync(join(dataDir, "plugins", "demo", "1.0.0", "dist"), { recursive: true });
      writeFileSync(bundlePath, "cached");
      const calls: string[] = [];
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, { demo: { installedVersion: "1.0.0" } }, {
        fetch: makeFetch({ bytes: new Uint8Array(), integrity: "x", calls }),
        extract: fakeExtract,
        now: () => 1,
        log: noopLog,
      });
      expect(result.installed[0]?.bundlePath).toBe(bundlePath);
      expect(calls).toEqual([]); // no network
    });
  });

  test("with no pin and no state, the newest cached version is reused rather than upgrading to the index", async () => {
    await withDataDir(async (dataDir) => {
      // 1.0.0 is cached on disk; the index now offers 2.0.0. With no pin and empty state, the bot
      // must NOT silently upgrade — it reuses the cached 1.0.0 and makes no network call.
      mkdirSync(join(dataDir, "plugins", "demo", "1.0.0", "dist"), { recursive: true });
      writeFileSync(join(dataDir, "plugins", "demo", "1.0.0", "dist", "plugin.js"), "cached");
      const calls: string[] = [];
      const result = await installPlugins([{ name: "demo", entry: entry({ version: "2.0.0" }) }], dataDir, {}, {
        fetch: makeFetch({ bytes: new Uint8Array(), integrity: "x", calls }),
        extract: fakeExtract,
        now: () => 1,
        log: noopLog,
      });
      expect(result.installed[0]?.version).toBe("1.0.0");
      expect(calls).toEqual([]); // no upgrade fetch
    });
  });

  test("a pinned version wins over the index's current version", async () => {
    await withDataDir(async (dataDir) => {
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      await installPlugins([{ name: "demo", entry: entry({ version: "2.0.0" }), pinnedVersion: "1.0.0" }], dataDir, {}, {
        fetch: makeFetch({ bytes, integrity: sri(bytes), calls }),
        extract: fakeExtract,
        now: () => 1,
        log: noopLog,
      });
      expect(calls.some((u) => u.endsWith("/1.0.0"))).toBe(true);
      expect(calls.some((u) => u.endsWith("/2.0.0"))).toBe(false);
    });
  });

  test("the previously-installed version wins over the index's newer version", async () => {
    await withDataDir(async (dataDir) => {
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      await installPlugins([{ name: "demo", entry: entry({ version: "2.0.0" }) }], dataDir, { demo: { installedVersion: "1.0.0" } }, {
        fetch: makeFetch({ bytes, integrity: sri(bytes), calls }),
        extract: fakeExtract,
        now: () => 1,
        log: noopLog,
      });
      expect(calls.some((u) => u.endsWith("/1.0.0"))).toBe(true);
      expect(calls.some((u) => u.endsWith("/2.0.0"))).toBe(false);
    });
  });

  test("a 404 skips that plugin with a reason and leaves the others installed", async () => {
    await withDataDir(async (dataDir) => {
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      const okFetch = makeFetch({ bytes, integrity: sri(bytes), calls });
      const fetch: InstallDeps["fetch"] = async (url, init) => {
        if (url.includes("plugin-missing")) return new Response("nope", { status: 404, statusText: "Not Found" });
        return okFetch(url, init);
      };
      const result = await installPlugins(
        [
          { name: "missing", entry: entry({ name: "missing", package: "@rackbops/plugin-missing" }) },
          { name: "demo", entry: entry() },
        ],
        dataDir,
        {},
        { fetch, extract: fakeExtract, now: () => 1, log: noopLog },
      );
      expect(result.skips.missing).toContain("404");
      expect(result.installed.map((i) => i.entry.name)).toEqual(["demo"]);
    });
  });

  test("a selection-skipped or entry-less plugin is not installed", async () => {
    await withDataDir(async (dataDir) => {
      const calls: string[] = [];
      const result = await installPlugins(
        [
          { name: "gone", skipped: "not in the plugin index" },
          { name: "bad", entry: entry({ name: "bad" }), skipped: "needs host API v2" },
        ],
        dataDir,
        {},
        { fetch: makeFetch({ bytes: new Uint8Array(), integrity: "x", calls }), extract: fakeExtract, now: () => 1, log: noopLog },
      );
      expect(result.installed).toEqual([]);
      expect(calls).toEqual([]);
    });
  });

  // #104: a failed targetVersion install falls back to the recorded last-good version.
  const seedCached = (dataDir: string, version: string) => {
    mkdirSync(join(dataDir, "plugins", "demo", version, "dist"), { recursive: true });
    writeFileSync(join(dataDir, "plugins", "demo", version, "dist", "plugin.js"), `cached ${version}`);
  };

  test("a broken target reverts to the recorded previous version (cached), recording the failure", async () => {
    await withDataDir(async (dataDir) => {
      seedCached(dataDir, "1.0.0"); // the last-good bundle is on disk
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      // integrity that won't match the tarball bytes → the 1.1.0 target install fails.
      const result = await installPlugins(
        [{ name: "demo", entry: entry({ version: "1.1.0" }) }],
        dataDir,
        { demo: { installedVersion: "1.0.0", targetVersion: "1.1.0" } },
        { fetch: makeFetch({ bytes, integrity: "sha512-bogus", calls }), extract: fakeExtract, now: () => 1, log: noopLog },
      );
      expect(result.installed.map((i) => i.version)).toEqual(["1.0.0"]); // came back on the previous
      expect(result.fallbacks.demo).toMatchObject({ attempted: "1.1.0" });
      expect(result.fallbacks.demo?.reason).toContain("integrity mismatch");
      expect(result.skips).toEqual({});
    });
  });

  test("the fallback is the RECORDED previous version, never a newer cached one (no silent upgrade)", async () => {
    await withDataDir(async (dataDir) => {
      seedCached(dataDir, "1.0.0"); // hand-lowered pin
      seedCached(dataDir, "2.0.0"); // an older-run's cache, NEWER than the pin
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      const result = await installPlugins(
        [{ name: "demo", entry: entry({ version: "2.0.1" }) }],
        dataDir,
        { demo: { installedVersion: "1.0.0", targetVersion: "2.0.1" } },
        { fetch: makeFetch({ bytes, integrity: "sha512-bogus", calls }), extract: fakeExtract, now: () => 1, log: noopLog },
      );
      // MUST be 1.0.0 (the recorded pin), NOT 2.0.0 (newestCached) — else it silently upgrades.
      expect(result.installed.map((i) => i.version)).toEqual(["1.0.0"]);
      expect(result.fallbacks.demo?.attempted).toBe("2.0.1");
    });
  });

  test("a broken target with no cached previous is a plain skip (no fallback invented)", async () => {
    await withDataDir(async (dataDir) => {
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      const result = await installPlugins(
        [{ name: "demo", entry: entry({ version: "1.1.0" }) }],
        dataDir,
        { demo: { targetVersion: "1.1.0" } }, // no installedVersion recorded
        { fetch: makeFetch({ bytes, integrity: "sha512-bogus", calls }), extract: fakeExtract, now: () => 1, log: noopLog },
      );
      expect(result.installed).toEqual([]);
      expect(result.skips.demo).toContain("integrity mismatch");
      expect(result.fallbacks).toEqual({});
    });
  });

  // Real tar, Linux/CI only: Windows tar reads a C:\ path as a remote host and fails. In the image
  // (oven/bun:1-slim, Linux) this is the actual production path.
  test.skipIf(process.platform === "win32")("tarExtract flattens package/ and extracts plugin.js (real tar)", async () => {
    await withDataDir(async (dataDir) => {
      const stage = join(dataDir, "stage");
      mkdirSync(join(stage, "package", "dist"), { recursive: true });
      writeFileSync(join(stage, "package", "dist", "plugin.js"), "export const createPlugin=()=>({})");
      writeFileSync(join(stage, "package", "package.json"), JSON.stringify({ name: "@rackbops/plugin-demo", version: "1.0.0" }));
      const tgz = join(dataDir, "demo.tgz");
      const packed = Bun.spawnSync(["tar", "-czf", tgz, "-C", stage, "package"]);
      expect(packed.exitCode).toBe(0);
      const dest = join(dataDir, "out");
      await tarExtract(tgz, dest);
      // --strip-components=1 drops `package/`, leaving dist/plugin.js + package.json
      expect(readFileSync(join(dest, "dist", "plugin.js"), "utf8")).toContain("createPlugin");
      expect(existsSync(join(dest, "package.json"))).toBe(true);
    });
  });
});
