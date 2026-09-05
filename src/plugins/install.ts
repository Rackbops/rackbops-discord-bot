// Installs the plugins #98 selected: resolve package@version on the npm registry, download the
// tarball, verify its dist.integrity, and extract dist/plugin.js into data/plugins/<name>/<version>/.
// Pure over injected I/O (fetch/extract/now/log) so it unit-tests with a fake fetch + fixture
// tarball and never hits the network or the real data dir. No plugin CODE runs here — that is
// loadPlugins/activatePlugins in host.ts, inside the bot's activate() after takeOver().
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PluginIndexEntry } from "./contract";
import type { SelectedPlugin } from "./registry";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
// Development-only override so the end-to-end fixture-plugin flow can point at a local registry
// stub (see .env.example). Production leaves it unset and resolves against npm.
const REGISTRY_BASE = (process.env.PLUGIN_REGISTRY_URL ?? DEFAULT_REGISTRY).replace(/\/$/, "");
const FETCH_TIMEOUT_MS = 30_000;

export interface InstallLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface InstallDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Extracts `package/dist/plugin.js` and `package/package.json` from `tarPath` into `destDir`
   * (flattening the leading `package/`). Injected so tests use a plain writer, production uses tar. */
  extract: (tarPath: string, destDir: string) => Promise<void>;
  now: () => number;
  log: InstallLog;
}

export interface InstalledPlugin {
  entry: PluginIndexEntry;
  version: string;
  bundlePath: string;
}

export interface InstallResult {
  installed: InstalledPlugin[];
  /** name -> reason, for the plugins that couldn't be installed (download/integrity/extract). */
  skips: Record<string, string>;
}

/** The production `extract`: `tar` flattening the npm tarball's `package/` prefix. `tar` is present
 * in `oven/bun:1-slim` (verified — see the issue's Acceptance). */
export async function tarExtract(tarPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const proc = Bun.spawn(
    ["tar", "-xzf", tarPath, "-C", destDir, "--strip-components=1", "package/dist/plugin.js", "package/package.json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`tar exited ${exitCode}: ${stderr.trim()}`);
}

interface RegistryVersion {
  dist?: { tarball?: unknown; integrity?: unknown };
}

async function fetchJson(fetchImpl: InstallDeps["fetch"], url: string): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

/** SRI compare: `dist.integrity` is `sha512-<base64>`; hash the tarball bytes and compare base64. */
function integrityMatches(bytes: Uint8Array, integrity: string): boolean {
  const [algo, expected] = integrity.split("-", 2);
  if (algo !== "sha512" || !expected) return false;
  const actual = new Bun.CryptoHasher("sha512").update(bytes).digest("base64");
  return actual === expected;
}

/**
 * Installs each selected, non-skipped plugin. Version resolution: an operator pin
 * (`PLUGINS=name@version`) wins, then the version recorded in the previous `state.json`
 * (`installedVersions[name]`), then the index's current version — the bot NEVER moves an installed
 * plugin to a newer version on its own (that is #104's explicit action). A cached
 * `data/plugins/<name>/<version>/plugin.js` is reused with no fetch. Any per-plugin failure
 * (download, integrity mismatch, extract) is recorded in `skips` and affects only that plugin.
 */
export async function installPlugins(
  selected: readonly SelectedPlugin[],
  dataDir: string,
  installedVersions: Record<string, string | undefined>,
  deps: InstallDeps,
): Promise<InstallResult> {
  const installed: InstalledPlugin[] = [];
  const skips: Record<string, string> = {};

  for (const sp of selected) {
    if (sp.skipped || !sp.entry) continue;
    const entry = sp.entry;
    const version = sp.pinnedVersion ?? installedVersions[sp.name] ?? entry.version;
    const versionDir = join(dataDir, "plugins", sp.name, version);
    const bundlePath = join(versionDir, "plugin.js");

    if (existsSync(bundlePath)) {
      installed.push({ entry, version, bundlePath });
      continue;
    }

    try {
      const meta = (await fetchJson(
        deps.fetch,
        `${REGISTRY_BASE}/${encodeURIComponent(entry.package)}/${version}`,
      )) as RegistryVersion;
      const tarball = meta.dist?.tarball;
      const integrity = meta.dist?.integrity;
      if (typeof tarball !== "string" || typeof integrity !== "string") {
        throw new Error(`registry entry for ${entry.package}@${version} has no dist.tarball/integrity`);
      }

      const tarRes = await deps.fetch(tarball, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!tarRes.ok) throw new Error(`${tarball}: ${tarRes.status} ${tarRes.statusText}`);
      const bytes = new Uint8Array(await tarRes.arrayBuffer());

      if (!integrityMatches(bytes, integrity)) {
        skips[sp.name] = `integrity mismatch for ${entry.package}@${version}`;
        deps.log.error(`[plugins] ${sp.name}: ${skips[sp.name]}`);
        continue;
      }

      const tmpDir = join(dataDir, "plugins", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const tarPath = join(tmpDir, `${sp.name}-${version}-${deps.now()}.tgz`);
      await Bun.write(tarPath, bytes);
      try {
        await deps.extract(tarPath, versionDir);
      } finally {
        rmSync(tarPath, { force: true });
      }
      if (!existsSync(bundlePath)) {
        throw new Error(`extract produced no plugin.js for ${entry.package}@${version}`);
      }
      deps.log.info(`[plugins] ${sp.name}@${version} downloaded, integrity ok`);
      installed.push({ entry, version, bundlePath });
    } catch (err) {
      skips[sp.name] = err instanceof Error ? err.message : String(err);
      deps.log.error(`[plugins] ${sp.name}: install failed — ${skips[sp.name]}`);
    }
  }

  return { installed, skips };
}
