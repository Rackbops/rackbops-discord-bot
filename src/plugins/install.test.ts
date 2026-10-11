import { describe, expect, test } from "bun:test";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlugins, MAX_METADATA_BYTES, MAX_TARBALL_BYTES, readCapped, reconcileManifest, resolveRegistryBase, runBounded, tarExtract, type InstallDeps } from "./install";
import { HOST_API_VERSION, type PluginIndexEntry } from "./contract";
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

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Extract stub that also writes a `package.json` with the given `botPlugin` block (or none, when
 * `botPlugin` is undefined), mirroring what `tar` pulls out of a real bundle alongside `plugin.js`. */
function extractWithManifest(botPlugin: unknown): InstallDeps["extract"] {
  return async (_tarPath, destDir) => {
    mkdirSync(join(destDir, "dist"), { recursive: true });
    writeFileSync(join(destDir, "dist", "plugin.js"), "extracted");
    if (botPlugin !== undefined) {
      writeFileSync(join(destDir, "package.json"), JSON.stringify({ name: "@rackbops/plugin-demo", botPlugin }));
    }
  };
}

function capturingLog(): { log: InstallDeps["log"]; warns: string[] } {
  const warns: string[] = [];
  return { log: { info() {}, warn: (m) => warns.push(m), error() {} }, warns };
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

  test("a broken target whose bundle fails host-API reconciliation falls back to the recorded previous version (#104, #223)", async () => {
    await withDataDir(async (dataDir) => {
      seedCached(dataDir, "1.0.0"); // the last-good bundle is on disk, no package.json (never refused)
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      const mismatched = HOST_API_VERSION + 1;
      const result = await installPlugins(
        [{ name: "demo", entry: entry({ version: "1.1.0" }) }],
        dataDir,
        { demo: { installedVersion: "1.0.0", targetVersion: "1.1.0" } },
        {
          fetch: makeFetch({ bytes, integrity: sri(bytes), calls }),
          extract: extractWithManifest({ hostApiVersion: mismatched }),
          now: () => 1,
          log: noopLog,
        },
      );
      expect(result.installed.map((i) => i.version)).toEqual(["1.0.0"]);
      expect(result.fallbacks.demo).toMatchObject({ attempted: "1.1.0" });
      expect(result.fallbacks.demo?.reason).toContain(`v${mismatched}`);
      expect(result.fallbacks.demo?.reason).toContain(`v${HOST_API_VERSION}`);
      expect(result.skips).toEqual({});
    });
  });

  // #224: extract-then-rename, never straight into the final versionDir.
  test("a part-way extract failure leaves no bundle behind, and the next attempt re-fetches", async () => {
    await withDataDir(async (dataDir) => {
      const bytes = new TextEncoder().encode("x");
      const partialExtract: InstallDeps["extract"] = async (_tarPath, destDir) => {
        mkdirSync(join(destDir, "dist"), { recursive: true });
        writeFileSync(join(destDir, "dist", "plugin.js"), "partial");
        throw new Error("tar exited 137: killed");
      };
      const calls: string[] = [];
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, {
        fetch: makeFetch({ bytes, integrity: sri(bytes), calls }),
        extract: partialExtract,
        now: () => 1,
        log: noopLog,
      });
      expect(result.skips.demo).toContain("tar exited 137");
      expect(existsSync(join(dataDir, "plugins", "demo", "1.0.0", "dist", "plugin.js"))).toBe(false);
      const pluginDir = join(dataDir, "plugins", "demo");
      const leftovers = existsSync(pluginDir) ? readdirSync(pluginDir) : [];
      expect(leftovers.some((n) => n.startsWith(".staging-"))).toBe(false);

      // a second attempt re-fetches — nothing partial was ever committed to the cache
      const calls2: string[] = [];
      await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, {
        fetch: makeFetch({ bytes, integrity: sri(bytes), calls: calls2 }),
        extract: fakeExtract,
        now: () => 2,
        log: noopLog,
      });
      expect(calls2.length).toBeGreaterThan(0);
    });
  });

  test("a staging directory left behind is never treated as a cached version", async () => {
    await withDataDir(async (dataDir) => {
      const stagingDir = join(dataDir, "plugins", "demo", ".staging-9.9.9-1");
      mkdirSync(join(stagingDir, "dist"), { recursive: true });
      writeFileSync(join(stagingDir, "dist", "plugin.js"), "stale");
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, {
        fetch: makeFetch({ bytes, integrity: sri(bytes), calls }),
        extract: fakeExtract,
        now: () => 1,
        log: noopLog,
      });
      expect(result.installed[0]?.version).toBe("1.0.0");
      expect(calls.length).toBeGreaterThan(0); // fetched — the staging leftover was not reused
    });
  });

  test("the bundle is extracted to a staging dir and moved into place, not written there directly", async () => {
    await withDataDir(async (dataDir) => {
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      const destDirs: string[] = [];
      const capturingExtract: InstallDeps["extract"] = async (tarPath, destDir) => {
        destDirs.push(destDir);
        await fakeExtract(tarPath, destDir);
      };
      await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, {
        fetch: makeFetch({ bytes, integrity: sri(bytes), calls }),
        extract: capturingExtract,
        now: () => 1,
        log: noopLog,
      });
      const versionDir = join(dataDir, "plugins", "demo", "1.0.0");
      expect(destDirs).toHaveLength(1);
      expect(destDirs[0]).not.toBe(versionDir);
      expect(existsSync(join(versionDir, "dist", "plugin.js"))).toBe(true);
    });
  });

  test("a previous partial version directory is replaced, not merged", async () => {
    await withDataDir(async (dataDir) => {
      const versionDir = join(dataDir, "plugins", "demo", "1.0.0");
      mkdirSync(versionDir, { recursive: true });
      writeFileSync(join(versionDir, "leftover.txt"), "stale");
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, {
        fetch: makeFetch({ bytes, integrity: sri(bytes), calls }),
        extract: fakeExtract,
        now: () => 1,
        log: noopLog,
      });
      expect(result.installed).toHaveLength(1);
      expect(existsSync(join(versionDir, "leftover.txt"))).toBe(false);
      expect(existsSync(join(versionDir, "dist", "plugin.js"))).toBe(true);
    });
  });

  // #223: the bundle's own package.json botPlugin block, reconciled against the host.
  test("a bundle whose package.json declares a different hostApiVersion is refused and never lands", async () => {
    await withDataDir(async (dataDir) => {
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      const mismatched = HOST_API_VERSION + 1;
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, {
        fetch: makeFetch({ bytes, integrity: sri(bytes), calls }),
        extract: extractWithManifest({ hostApiVersion: mismatched }),
        now: () => 1,
        log: noopLog,
      });
      expect(result.skips.demo).toContain(`v${mismatched}`);
      expect(result.skips.demo).toContain(`v${HOST_API_VERSION}`);
      expect(existsSync(join(dataDir, "plugins", "demo", "1.0.0"))).toBe(false);
    });
  });

  test("a cached bundle whose package.json declares a different hostApiVersion is refused with no fetch", async () => {
    await withDataDir(async (dataDir) => {
      const versionDir = join(dataDir, "plugins", "demo", "1.0.0");
      mkdirSync(join(versionDir, "dist"), { recursive: true });
      writeFileSync(join(versionDir, "dist", "plugin.js"), "cached");
      const mismatched = HOST_API_VERSION + 1;
      writeFileSync(join(versionDir, "package.json"), JSON.stringify({ botPlugin: { hostApiVersion: mismatched } }));
      const calls: string[] = [];
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, { demo: { installedVersion: "1.0.0" } }, {
        fetch: makeFetch({ bytes: new Uint8Array(), integrity: "x", calls }),
        extract: fakeExtract,
        now: () => 1,
        log: noopLog,
      });
      expect(result.skips.demo).toContain(`v${mismatched}`);
      expect(result.skips.demo).toContain(`v${HOST_API_VERSION}`);
      expect(calls).toEqual([]);
    });
  });

  test("divergent commands or env keys warn but still install", async () => {
    await withDataDir(async (dataDir) => {
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      const { log, warns } = capturingLog();
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, {
        fetch: makeFetch({ bytes, integrity: sri(bytes), calls }),
        extract: extractWithManifest({ hostApiVersion: HOST_API_VERSION, commands: ["other"], env: [{ key: "X" }] }),
        now: () => 1,
        log,
      });
      expect(result.installed).toHaveLength(1);
      expect(result.skips).toEqual({});
      expect(warns.some((w) => w.includes("commands"))).toBe(true);
      expect(warns.some((w) => w.includes("env keys"))).toBe(true);
    });
  });

  test("a bundle with no package.json installs with a warning and is never refused", async () => {
    await withDataDir(async (dataDir) => {
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      const { log, warns } = capturingLog();
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, {
        fetch: makeFetch({ bytes, integrity: sri(bytes), calls }),
        extract: fakeExtract,
        now: () => 1,
        log,
      });
      expect(result.installed).toHaveLength(1);
      expect(result.skips).toEqual({});
      expect(warns.some((w) => w.includes("no readable package.json"))).toBe(true);
    });
  });

  test("an unparseable package.json installs with a warning and is never refused", async () => {
    await withDataDir(async (dataDir) => {
      const bytes = new TextEncoder().encode("x");
      const calls: string[] = [];
      const { log, warns } = capturingLog();
      const badJsonExtract: InstallDeps["extract"] = async (_tarPath, destDir) => {
        mkdirSync(join(destDir, "dist"), { recursive: true });
        writeFileSync(join(destDir, "dist", "plugin.js"), "extracted");
        writeFileSync(join(destDir, "package.json"), "{");
      };
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, {
        fetch: makeFetch({ bytes, integrity: sri(bytes), calls }),
        extract: badJsonExtract,
        now: () => 1,
        log,
      });
      expect(result.installed).toHaveLength(1);
      expect(result.skips).toEqual({});
      expect(warns.some((w) => w.includes("not valid JSON"))).toBe(true);
    });
  });

  // AMENDMENT to the #223 plan: reconciliation compares against the HOST's HOST_API_VERSION, never
  // entry.hostApiVersion — the index's hostApiVersion describes entry.version alone, so comparing
  // against it would wrongly refuse a #222 keepOlder bundle whose manifest still says the OLDER host
  // API it was actually built against.
  test("a kept older bundle is not refused when the index entry needs a newer host (#222)", async () => {
    await withDataDir(async (dataDir) => {
      const versionDir = join(dataDir, "plugins", "demo", "1.0.0");
      mkdirSync(join(versionDir, "dist"), { recursive: true });
      writeFileSync(join(versionDir, "dist", "plugin.js"), "cached");
      writeFileSync(join(versionDir, "package.json"), JSON.stringify({ botPlugin: { hostApiVersion: HOST_API_VERSION } }));
      const calls: string[] = [];
      const result = await installPlugins(
        [{ name: "demo", entry: entry({ version: "2.0.0", hostApiVersion: HOST_API_VERSION + 1, intents: [] }) }],
        dataDir,
        { demo: { installedVersion: "1.0.0" } },
        { fetch: makeFetch({ bytes: new Uint8Array(), integrity: "x", calls }), extract: fakeExtract, now: () => 1, log: noopLog },
      );
      expect(result.installed.map((i) => i.version)).toEqual(["1.0.0"]);
      expect(result.skips).toEqual({});
      expect(calls).toEqual([]); // cached, no fetch — and reconciliation still ran (matches the host)
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

// #281: PLUGIN_REGISTRY_URL="" (what compose's env_file: delivers a bare `KEY=` line as, and what
// .env.example ships) must resolve like unset, the same rule src/config.ts's optional() already applies
// to PLUGIN_INDEX_URL. REGISTRY_BASE itself is a module-level constant computed once at import from the
// real process.env, so it can't be driven per test; resolveRegistryBase is the pure seam that can.
// #496/#497/#498: install/registry hardening -- versions checked before they reach a path, a cached
// version chosen by semver, a bounded tarball download, and an interrupted install's leftovers swept.
describe("installPlugins: hardening (#496, #497, #498)", () => {
  const seedVersion = (dataDir: string, version: string, name = "demo") => {
    mkdirSync(join(dataDir, "plugins", name, version, "dist"), { recursive: true });
    writeFileSync(join(dataDir, "plugins", name, version, "dist", "plugin.js"), `v${version}`);
  };
  const noFetch: InstallDeps["fetch"] = async () => {
    throw new Error("must not fetch");
  };
  const deps = (over: Partial<InstallDeps> = {}): InstallDeps => ({ fetch: noFetch, extract: fakeExtract, now: () => 1, log: noopLog, ...over });

  test("a version that is not major.minor.patch is refused before any fetch, path or delete", async () => {
    await withDataDir(async (dataDir) => {
      // A bundle outside the plugin dir, where every walking version below lands
      // (<dataDir>/plugins/demo/<version> resolves to <dataDir>/victim): unchecked, the cache fast path
      // would load it as the plugin, and a failed extract would rmSync it.
      mkdirSync(join(dataDir, "victim", "dist"), { recursive: true });
      writeFileSync(join(dataDir, "victim", "dist", "plugin.js"), "not a plugin");
      for (const [label, selected, pins] of [
        ["an index dist-tag", { name: "demo", entry: entry({ version: "latest" }) }, {}],
        ["an index version that walks out of the plugin dir", { name: "demo", entry: entry({ version: "../../victim" }) }, {}],
        ["a state.json installedVersion that walks out of the plugin dir", { name: "demo", entry: entry() }, { demo: { installedVersion: "../../victim" } }],
        ["a release version followed by a walk", { name: "demo", entry: entry() }, { demo: { installedVersion: "1.0.0/../../../victim" } }],
        ["a prerelease version followed by a walk", { name: "demo", entry: entry() }, { demo: { installedVersion: "1.0.0-a/../../../victim" } }],
        ["a state.json targetVersion", { name: "demo", entry: entry() }, { demo: { targetVersion: "1.0" } }],
      ] as const) {
        const result = await installPlugins([selected as SelectedPlugin], dataDir, pins as Record<string, { installedVersion?: string; targetVersion?: string }>, deps());
        expect(result.installed, label).toEqual([]);
        expect(result.skips.demo, label).toMatch(/is not a version \(expected major\.minor\.patch\)$/);
      }
      expect(readFileSync(join(dataDir, "victim", "dist", "plugin.js"), "utf8")).toBe("not a plugin");
    });
  });

  test("the newest cached version is chosen by semver: 1.10.0 over 1.9.0, a release over its prerelease, and a non-version dir never", async () => {
    for (const [cached, expected] of [
      [["1.9.0", "1.10.0"], "1.10.0"],
      [["1.2.3-rc.1", "1.2.3"], "1.2.3"],
      [["1.2.3-rc.2", "1.2.3-rc.10"], "1.2.3-rc.10"],
      [["1.0.0", "latest", "2.0"], "1.0.0"],
    ] as const) {
      await withDataDir(async (dataDir) => {
        for (const v of cached) seedVersion(dataDir, v);
        const result = await installPlugins([{ name: "demo", entry: entry({ version: "9.0.0" }) }], dataDir, {}, deps());
        expect(result.installed[0]?.version, cached.join(",")).toBe(expected);
      });
    }
  });

  test("a registry integrity that is not sha512, or is empty, is refused as a mismatch", async () => {
    const bytes = new TextEncoder().encode("tarball");
    for (const integrity of [`sha1-${new Bun.CryptoHasher("sha1").update(bytes).digest("base64")}`, `sha256-${new Bun.CryptoHasher("sha256").update(bytes).digest("base64")}`, "", "sha512-"]) {
      await withDataDir(async (dataDir) => {
        const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, deps({ fetch: makeFetch({ bytes, integrity, calls: [] }) }));
        expect(result.skips.demo, integrity).toBe("integrity mismatch for @rackbops/plugin-demo@1.0.0");
      });
    }
  });

  test("registry metadata without dist.tarball or dist.integrity is refused", async () => {
    for (const dist of [{}, { tarball: TARBALL_URL }, { integrity: "sha512-x" }, { tarball: 5, integrity: "sha512-x" }]) {
      await withDataDir(async (dataDir) => {
        const fetch: InstallDeps["fetch"] = async () => new Response(JSON.stringify({ dist }));
        const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, deps({ fetch }));
        expect(result.skips.demo).toBe("registry entry for @rackbops/plugin-demo@1.0.0 has no dist.tarball/integrity");
      });
    }
  });

  test("a tarball the registry answers with an error status is refused with that status", async () => {
    await withDataDir(async (dataDir) => {
      const fetch: InstallDeps["fetch"] = async (url) =>
        url === TARBALL_URL ? new Response("boom", { status: 500, statusText: "Internal Server Error" }) : new Response(JSON.stringify({ dist: { tarball: TARBALL_URL, integrity: "sha512-x" } }));
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, deps({ fetch }));
      expect(result.skips.demo).toBe(`${TARBALL_URL}: 500 Internal Server Error`);
    });
  });

  test("a tarball that declares more than MAX_TARBALL_BYTES is refused without reading it", async () => {
    await withDataDir(async (dataDir) => {
      let pulled = 0;
      const fetch: InstallDeps["fetch"] = async (url) => {
        if (url !== TARBALL_URL) return new Response(JSON.stringify({ dist: { tarball: TARBALL_URL, integrity: "sha512-x" } }));
        const body = new ReadableStream<Uint8Array>({ pull: (c) => void (pulled += 1, c.enqueue(new Uint8Array(1024))) });
        return new Response(body, { headers: { "content-length": String(MAX_TARBALL_BYTES + 1) } });
      };
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, deps({ fetch }));
      expect(result.skips.demo).toBe(`${TARBALL_URL} is larger than ${MAX_TARBALL_BYTES} bytes`);
      expect(pulled).toBeLessThanOrEqual(1); // at most the stream's own first priming pull
    });
  });

  test("a tarball of undeclared length is abandoned the moment it passes MAX_TARBALL_BYTES", async () => {
    await withDataDir(async (dataDir) => {
      const chunk = new Uint8Array(1024 * 1024);
      let sent = 0;
      const fetch: InstallDeps["fetch"] = async (url) => {
        if (url !== TARBALL_URL) return new Response(JSON.stringify({ dist: { tarball: TARBALL_URL, integrity: "sha512-x" } }));
        const body = new ReadableStream<Uint8Array>({ pull: (c) => void (sent += chunk.byteLength, c.enqueue(chunk)) }); // endless
        return new Response(body);
      };
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, deps({ fetch }));
      expect(result.skips.demo).toBe(`${TARBALL_URL} is larger than ${MAX_TARBALL_BYTES} bytes`);
      expect(sent).toBeLessThan(MAX_TARBALL_BYTES + 4 * chunk.byteLength); // stopped, not read to the end
    });
  });

  test("registry metadata larger than MAX_METADATA_BYTES is refused before the tarball is fetched", async () => {
    await withDataDir(async (dataDir) => {
      const calls: string[] = [];
      const fetch: InstallDeps["fetch"] = async (url) => {
        calls.push(url);
        return new Response(`{"pad":"${"x".repeat(MAX_METADATA_BYTES)}"}`);
      };
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, deps({ fetch }));
      expect(result.skips.demo).toMatch(new RegExp(`is larger than ${MAX_METADATA_BYTES} bytes$`));
      expect(calls).toHaveLength(1);
    });
  });

  test("a tarball that arrives in several chunks is reassembled whole: its integrity matches and it installs", async () => {
    await withDataDir(async (dataDir) => {
      const parts = ["tar", "ball-", "bytes"].map((p) => new TextEncoder().encode(p));
      const whole = new TextEncoder().encode("tarball-bytes");
      const fetch: InstallDeps["fetch"] = async (url) => {
        if (url !== TARBALL_URL) return new Response(JSON.stringify({ dist: { tarball: TARBALL_URL, integrity: sri(whole) } }));
        return new Response(new ReadableStream<Uint8Array>({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }));
      };
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, deps({ fetch }));
      expect(result.skips).toEqual({});
      expect(result.installed[0]?.version).toBe("1.0.0");
    });
  });

  test("an interrupted install's leftovers are swept before installing: .staging-* dirs and plugins/tmp tarballs", async () => {
    await withDataDir(async (dataDir) => {
      seedVersion(dataDir, "1.0.0");
      mkdirSync(join(dataDir, "plugins", "demo", ".staging-1.0.0-5", "dist"), { recursive: true });
      mkdirSync(join(dataDir, "plugins", "other", ".staging-2.0.0-6"), { recursive: true });
      mkdirSync(join(dataDir, "plugins", "tmp"), { recursive: true });
      writeFileSync(join(dataDir, "plugins", "tmp", "demo-1.0.0-5.tgz"), "partial");
      writeFileSync(join(dataDir, "plugins", "index.json"), "{}"); // a file at the top level is not a plugin dir
      const infos: string[] = [];
      const warns: string[] = [];
      const log = { info: (m: string) => infos.push(m), warn: (m: string) => warns.push(m), error() {} };
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, deps({ log }));
      expect(result.installed[0]?.version).toBe("1.0.0");
      expect(readdirSync(join(dataDir, "plugins", "demo"))).toEqual(["1.0.0"]);
      expect(readdirSync(join(dataDir, "plugins", "other"))).toEqual([]);
      expect(readdirSync(join(dataDir, "plugins", "tmp"))).toEqual([]);
      expect(existsSync(join(dataDir, "plugins", "index.json"))).toBe(true);
      expect(infos).toContain("[plugins] removed 3 leftover(s) of an interrupted install");
      // The top-level file is passed over, not listed as a dir and warned about, wherever it sorts.
      expect(warns.filter((w) => w.includes("leftover"))).toEqual([]);
    });
  });

  test("a plugin named tmp shares plugins/tmp with the tarballs: its staging leftover goes, its versions stay", async () => {
    await withDataDir(async (dataDir) => {
      seedVersion(dataDir, "1.0.0", "tmp");
      mkdirSync(join(dataDir, "plugins", "tmp", ".staging-1.1.0-5"), { recursive: true });
      writeFileSync(join(dataDir, "plugins", "tmp", "tmp-1.1.0-5.tgz"), "partial");
      await installPlugins([], dataDir, {}, deps());
      expect(readdirSync(join(dataDir, "plugins", "tmp"))).toEqual(["1.0.0"]);
    });
  });

  test("a fresh data dir with no plugins/ yet has nothing to sweep, says nothing about it, and installs normally", async () => {
    await withDataDir(async (dataDir) => {
      const bytes = new TextEncoder().encode("tarball");
      const lines: string[] = [];
      const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {} };
      const result = await installPlugins([{ name: "demo", entry: entry() }], dataDir, {}, deps({ log, fetch: makeFetch({ bytes, integrity: sri(bytes), calls: [] }) }));
      expect(result.installed[0]?.version).toBe("1.0.0");
      expect(lines.filter((l) => l.includes("leftover"))).toEqual([]);
    });
  });

  test("a plugins/ with nothing left over says nothing about a sweep", async () => {
    await withDataDir(async (dataDir) => {
      seedVersion(dataDir, "1.0.0");
      const lines: string[] = [];
      const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {} };
      await installPlugins([], dataDir, {}, deps({ log }));
      expect(lines).toEqual([]);
    });
  });

  test("a plugins/ that cannot be listed is warned about, and the sweep never throws", async () => {
    await withDataDir(async (dataDir) => {
      writeFileSync(join(dataDir, "plugins"), "not a directory");
      const warns: string[] = [];
      const log = { info() {}, warn: (m: string) => warns.push(m), error() {} };
      await expect(installPlugins([], dataDir, {}, deps({ log }))).resolves.toEqual({ installed: [], skips: {}, fallbacks: {} });
      expect(warns).toHaveLength(1);
      expect(warns[0]).toStartWith(`[plugins] could not list ${join(dataDir, "plugins")} to sweep install leftovers: `);
    });
  });

  // tarExtract's bound is runBounded's: a command that never finishes stands in for a stalled tar. The
  // bound must not wait on anything the command's children hold -- a killed `tar -z` dies, but the child
  // it forked, blocked opening a FIFO, keeps its stderr pipe open -- so the rejection arrives on time
  // whatever the children do.
  test.skipIf(process.platform === "win32")("a command still running at its timeout is rejected on time, naming it", async () => {
    const started = Date.now();
    await expect(runBounded(["sleep", "30"], 200, "tar")).rejects.toThrow("tar did not finish within 200ms");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test.skipIf(process.platform === "win32")("a command still running at its timeout is killed, not left to finish", async () => {
    await withDataDir(async (dir) => {
      const marker = join(dir, "finished");
      await expect(runBounded(["sh", "-c", `sleep 1; touch '${marker}'`], 200, "tar")).rejects.toThrow("tar did not finish within 200ms");
      await Bun.sleep(1_500);
      expect(existsSync(marker)).toBe(false);
    });
  });

  // The real stall: tar blocked opening a FIFO nothing writes to. tarExtract must pass its own timeoutMs
  // through, not the minute-long default.
  test.skipIf(process.platform === "win32" || Bun.which("mkfifo") === null)("tarExtract gives up on a tar that never finishes after its timeoutMs", async () => {
    await withDataDir(async (dir) => {
      const fifo = join(dir, "stalled.tgz");
      Bun.spawnSync(["mkfifo", fifo]);
      const started = Date.now();
      try {
        await expect(tarExtract(fifo, join(dir, "out"), 300)).rejects.toThrow("tar did not finish within 300ms");
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        // Open the FIFO for writing and close it, so a tar child still blocked opening it sees EOF and exits.
        try {
          closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
        } catch {
          // no reader left: nothing is blocked on it
        }
      }
    });
  });

  test.skipIf(process.platform === "win32")("a non-zero exit is rejected with the command's stderr", async () => {
    await expect(runBounded(["sh", "-c", "echo boom >&2; exit 3"], 5_000, "tar")).rejects.toThrow("tar exited 3: boom");
  });

  test.skipIf(process.platform === "win32")("a zero exit resolves", async () => {
    await expect(runBounded(["true"], 5_000, "tar")).resolves.toBeUndefined();
  });
});

// readCapped's boundary, driven with a small max: the tarball download above uses MAX_TARBALL_BYTES.
describe("readCapped (#497)", () => {
  const body = (...sizes: number[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const n of sizes) c.enqueue(new Uint8Array(n).fill(7));
        c.close();
      },
    });

  test("a body of exactly max bytes is read whole, across chunks", async () => {
    expect(await readCapped(new Response(body(4, 4, 2)), 10)).toEqual(new Uint8Array(10).fill(7));
  });

  test("one byte over max is refused", async () => {
    expect(await readCapped(new Response(body(4, 4, 3)), 10)).toBe("too-large");
  });

  test("a declared Content-Length of exactly max is read; one over is refused", async () => {
    expect(await readCapped(new Response(body(10), { headers: { "content-length": "10" } }), 10)).toEqual(new Uint8Array(10).fill(7));
    expect(await readCapped(new Response(body(11), { headers: { "content-length": "11" } }), 10)).toBe("too-large");
  });

  test("a Content-Length that understates the body is not trusted: the running count still refuses it", async () => {
    expect(await readCapped(new Response(body(8, 8), { headers: { "content-length": "3" } }), 10)).toBe("too-large");
  });

  test("no body is zero bytes", async () => {
    expect(await readCapped(new Response(null), 10)).toEqual(new Uint8Array(0));
  });
});

describe("resolveRegistryBase", () => {
  test("a blank value falls back to the default registry", () => {
    expect(resolveRegistryBase({ PLUGIN_REGISTRY_URL: "" })).toBe("https://registry.npmjs.org");
  });
  test("a whitespace-only value falls back to the default registry", () => {
    expect(resolveRegistryBase({ PLUGIN_REGISTRY_URL: "   " })).toBe("https://registry.npmjs.org");
  });
  test("an unset value falls back to the default registry", () => {
    expect(resolveRegistryBase({})).toBe("https://registry.npmjs.org");
  });
  test("a real value is used, with its trailing slash stripped", () => {
    expect(resolveRegistryBase({ PLUGIN_REGISTRY_URL: "http://localhost:4873/" })).toBe("http://localhost:4873");
    expect(resolveRegistryBase({ PLUGIN_REGISTRY_URL: "http://localhost:4873" })).toBe("http://localhost:4873");
  });
});

// The tests above pin resolveRegistryBase in isolation -- they say nothing about whether install.ts's
// own module-level REGISTRY_BASE constant is actually WIRED to it. `const REGISTRY_BASE =
// resolveRegistryBase(process.env)` and `const REGISTRY_BASE = process.env.PLUGIN_REGISTRY_URL ??
// DEFAULT_REGISTRY` (the pre-#281 form) both leave every test above green, since neither line is
// exercised by them -- the consumer boundary, not the predicate, is what a regression would actually
// hit. A fresh `bun -e` subprocess is the only seam: process.env at Bun's own startup is what
// REGISTRY_BASE captures, and it can't be swapped inside this already-running test process.
const REPO_ROOT = join(import.meta.dir, "..", "..");
describe("REGISTRY_BASE is resolved through resolveRegistryBase: a blank PLUGIN_REGISTRY_URL in a fresh process is the default registry (#281)", () => {
  const runInFreshProcess = (registryUrl: string): string => {
    const proc = Bun.spawnSync(
      [process.execPath, "-e", 'import { REGISTRY_BASE } from "./src/plugins/install.ts"; console.log(REGISTRY_BASE)'],
      { cwd: REPO_ROOT, env: { ...process.env, PLUGIN_REGISTRY_URL: registryUrl } },
    );
    return new TextDecoder().decode(proc.stdout).trim();
  };

  test("a blank PLUGIN_REGISTRY_URL", () => {
    expect(runInFreshProcess("")).toBe("https://registry.npmjs.org");
  });
  test("a real PLUGIN_REGISTRY_URL, trailing slash stripped", () => {
    expect(runInFreshProcess("http://localhost:4873/")).toBe("http://localhost:4873");
  });
});

// reconcileManifest is exported and total (never throws) — its cache-path call in tryInstallVersion
// sits outside that function's own try, so a throw here would take installPlugins down for every
// plugin, not just this one. Direct unit tests for the odd shapes a real or crafted package.json
// could hold.
describe("reconcileManifest", () => {
  test("a package.json that is a directory (unreadable) warns and returns ok", () => {
    withTempDir((dir) => {
      const pkgPath = join(dir, "package.json");
      mkdirSync(pkgPath); // a directory at this path makes readFileSync throw
      const { log, warns } = capturingLog();
      const result = reconcileManifest(entry(), "1.0.0", pkgPath, log);
      expect(result.ok).toBe(true);
      expect(warns).toHaveLength(1);
    });
  });

  test("package.json containing the JSON value null warns and returns ok", () => {
    withTempDir((dir) => {
      const pkgPath = join(dir, "package.json");
      writeFileSync(pkgPath, "null");
      const { log, warns } = capturingLog();
      const result = reconcileManifest(entry(), "1.0.0", pkgPath, log);
      expect(result.ok).toBe(true);
      expect(warns).toHaveLength(1);
    });
  });

  test("a botPlugin block that isn't an object warns and returns ok", () => {
    withTempDir((dir) => {
      const pkgPath = join(dir, "package.json");
      writeFileSync(pkgPath, JSON.stringify({ botPlugin: "not-an-object" }));
      const { log, warns } = capturingLog();
      const result = reconcileManifest(entry(), "1.0.0", pkgPath, log);
      expect(result.ok).toBe(true);
      expect(warns).toHaveLength(1);
    });
  });

  test("commands that aren't an array is tolerated without throwing or refusing", () => {
    withTempDir((dir) => {
      const pkgPath = join(dir, "package.json");
      writeFileSync(pkgPath, JSON.stringify({ botPlugin: { hostApiVersion: HOST_API_VERSION, commands: "demo" } }));
      const result = reconcileManifest(entry(), "1.0.0", pkgPath, noopLog);
      expect(result.ok).toBe(true);
    });
  });

  test("an env entry without a string key is tolerated without throwing or refusing", () => {
    withTempDir((dir) => {
      const pkgPath = join(dir, "package.json");
      writeFileSync(
        pkgPath,
        JSON.stringify({ botPlugin: { hostApiVersion: HOST_API_VERSION, env: [{ notKey: 1 }, "not-an-object", null] } }),
      );
      const result = reconcileManifest(entry(), "1.0.0", pkgPath, noopLog);
      expect(result.ok).toBe(true);
    });
  });

  // #496: documented total, so an index entry's own env element that is not an object (the index check
  // refuses one, but this must not rely on it) is tolerated rather than thrown on.
  test("an index entry env element that is null is tolerated without throwing or refusing", () => {
    withTempDir((dir) => {
      const path = join(dir, "package.json");
      writeFileSync(path, JSON.stringify({ botPlugin: { env: [{ key: "A" }] } }));
      const odd = entry({ env: [null, { key: "A" }] as unknown as PluginIndexEntry["env"] });
      const { log, warns } = capturingLog();
      expect(reconcileManifest(odd, "1.0.0", path, log)).toEqual({ ok: true });
      // The null is skipped, not counted as a key: the remaining keys match, so nothing diverges.
      expect(warns).toEqual([]);
    });
  });

  test("a hostApiVersion that is a string is tolerated without throwing or refusing", () => {
    withTempDir((dir) => {
      const pkgPath = join(dir, "package.json");
      writeFileSync(pkgPath, JSON.stringify({ botPlugin: { hostApiVersion: "not-a-number" } }));
      const result = reconcileManifest(entry(), "1.0.0", pkgPath, noopLog);
      expect(result.ok).toBe(true);
    });
  });
});
