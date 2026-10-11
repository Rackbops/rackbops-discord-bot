// Boot-time Plugin Index fetch, with a cache — no plugin code loads here. Deliberately dependency-
// free of src/config.ts (src/plugins/* stays that way; see CONTEXT.md). The cache write goes through
// src/storage.ts's writeFileAtomic, a config-free leaf that imports only node:* (#496: it used to be a
// copy here, which missed #253's per-process token).
import { join } from "node:path";
import { writeFileAtomic } from "../storage";
import type { PluginIndex } from "./contract";

type PluginIndexSource = "fresh" | "cache" | "none";

interface LoadPluginIndexResult {
  index: PluginIndex;
  source: PluginIndexSource;
}

interface LoadPluginIndexDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Stamped into the cache file as `writtenAt` when a fetch succeeds. */
  now?: () => Date;
  timeoutMs?: number;
  /** Returns the file's text, or undefined if it doesn't exist. */
  readFile?: (path: string) => Promise<string | undefined>;
  writeFile?: (path: string, data: string) => Promise<void>;
}

// `writtenAt` is when THIS bot cached the file — distinct from the manifest's own `generatedAt`,
// which is the plugins repo's CI clock. The "using the cached copy from <writtenAt>" warning below
// needs the former.
interface CachedPluginIndex {
  writtenAt: string;
  index: PluginIndex;
}

const EMPTY_INDEX: PluginIndex = { schemaVersion: 1, generatedAt: "", plugins: [] };

async function defaultReadFile(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return file.text();
}

// #154/#253: the replacement writes this exact cache file at boot (loadPluginIndex below, called from
// index.ts before takeOver, so before the "the standby writes nothing until it has taken over"
// invariant state.json relies on applies here) at the same time the ORIGINAL's own pluginUpdates tick
// can re-fetch and re-cache the same manifest: two processes, one path, very likely the same small pid
// under an init. writeFileAtomic's temp name carries a per-process token as well as pid and counter, so
// the two writes never share a temp file.

/** Exported (only) so storage.test.ts-style direct concurrent-call tests can drive it without the
 *  extra async work (fetch, response parsing, validation) `loadPluginIndex` does first — that
 *  work desynchronizes two top-level `loadPluginIndex` calls enough that their writes rarely
 *  genuinely overlap, unlike two direct back-to-back calls to this function. */
export async function defaultWriteFile(path: string, data: string): Promise<void> {
  await writeFileAtomic(path, data);
}

/** A caller-supplied value in a log line, as JSON (`"2"` and `2` read differently, an object shows its
 *  contents rather than `[object Object]`) and bounded, so an index cannot flood the log. */
function shownValue(value: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value); // undefined has no JSON form
  } catch {
    s = String(value);
  }
  return s.length > 66 ? `${s.slice(0, 63)}...` : s;
}

/** Why one index entry is unusable, or undefined. */
function entryProblem(p: unknown): string | undefined {
  if (typeof p !== "object" || p === null) return "not an object";
  const e = p as Record<string, unknown>;
  if (typeof e.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(e.name)) return "name is not a plugin name";
  if (typeof e.package !== "string") return "package is not a string";
  if (typeof e.version !== "string") return "version is not a string";
  if (typeof e.description !== "string") return "description is not a string";
  if (typeof e.hostApiVersion !== "number") return "hostApiVersion is not a number";
  if (!Array.isArray(e.commands)) return "commands is not a list";
  // #496: each env element is read for its `key` (host.ts's env slice, install.ts's reconcileManifest),
  // so a null element is refused here rather than thrown on later, where one throw took every plugin down.
  if (!Array.isArray(e.env) || !e.env.every((k) => typeof k === "object" && k !== null && typeof (k as { key?: unknown }).key === "string")) {
    return "env is not a list of { key } entries";
  }
  if (!Array.isArray(e.releases)) return "releases is not a list";
  // discord.js's IntentsBitField throws on a non-number flag (BitFieldInvalid) — validated here so
  // a malformed entry never reaches createClient() uncaught. A bad entry that slipped past this would
  // also get cached, crash-looping every restart until the cache is cleared.
  if (e.intents !== undefined && !(Array.isArray(e.intents) && e.intents.every((i) => typeof i === "number"))) {
    return "intents is not a list of numbers";
  }
  return undefined;
}

/**
 * Why `value` is not a usable Plugin Index, or undefined when it is. One bad entry makes the WHOLE index
 * unusable, deliberately: a partly-dropped index would quietly unload a plugin the operator listed, and
 * the cached copy is the better fallback. The reason names the first failing check and, for an entry,
 * its position and name, so the log says what to fix in the plugins repo (#496).
 */
function pluginIndexProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) return `schemaVersion is ${shownValue(v.schemaVersion)}, not 1`;
  if (!Array.isArray(v.plugins)) return "plugins is not a list";
  // Duplicate names collapse silently in registry.ts's Map-keyed lookup (last one wins), so
  // rejecting them here — same bucket as every other malformed-manifest case — is cheaper than
  // guarding it at every later consumer.
  const seenNames = new Set<string>();
  for (const [i, p] of v.plugins.entries()) {
    const name: unknown = typeof p === "object" && p !== null ? (p as { name?: unknown }).name : undefined;
    const where = `plugins[${i}]${typeof name === "string" ? ` (${shownValue(name)})` : ""}`;
    const problem = entryProblem(p);
    if (problem !== undefined) return `${where}: ${problem}`;
    if (seenNames.has(name as string)) return `${where}: duplicate name`;
    seenNames.add(name as string);
  }
  return undefined;
}

/**
 * Fetches the Plugin Index with a timeout, validates its shape, and atomically caches it. Any
 * failure (unreachable, timeout, bad JSON, bad shape) falls back to the cached copy with a
 * warning, or an empty index with a warning if there's no usable cache. Never throws — a manifest
 * outage degrades to "no new plugins," never a boot failure.
 */
export async function loadPluginIndex(
  url: string,
  dataDir: string,
  deps: LoadPluginIndexDeps = {},
): Promise<LoadPluginIndexResult> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 5000;
  const readFile = deps.readFile ?? defaultReadFile;
  const writeFile = deps.writeFile ?? defaultWriteFile;
  const cachePath = join(dataDir, "plugins", "index.json");

  // `why` heads every line: "index unreachable (...)" for a fetch that got no usable answer, "index
  // invalid (...)" for one that did but whose body is not a usable index (#496).
  const useCache = async (why: string): Promise<LoadPluginIndexResult> => {
    let raw: string | undefined;
    try {
      raw = await readFile(cachePath);
    } catch (err) {
      console.warn(`[plugins] ${why} — cache read failed (${err}), no plugins will load`);
      return { index: EMPTY_INDEX, source: "none" };
    }
    if (raw === undefined) {
      console.warn(`[plugins] ${why} — no cached copy, no plugins will load`);
      return { index: EMPTY_INDEX, source: "none" };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CachedPluginIndex>;
      if (typeof parsed.writtenAt !== "string") throw new Error("cached copy has no writtenAt");
      const problem = pluginIndexProblem(parsed.index);
      if (problem !== undefined) throw new Error(`cached copy is invalid: ${problem}`);
      console.warn(`[plugins] ${why} — using the cached copy from ${parsed.writtenAt}`);
      return { index: parsed.index as PluginIndex, source: "cache" };
    } catch (err) {
      console.warn(`[plugins] ${why} — cached copy is unreadable (${err}), no plugins will load`);
      return { index: EMPTY_INDEX, source: "none" };
    }
  };

  // config.ts accepts a bare absolute path (POSIX — this bot only ever runs in the Linux
  // container) as shorthand, but fetch() can't resolve a schemeless string as a URL at all.
  const fetchUrl = url.startsWith("/") ? `file://${url}` : url;

  let res: Response;
  try {
    res = await fetchFn(fetchUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return useCache(`index unreachable (${String(err)})`);
  }
  if (!res.ok) return useCache(`index unreachable (HTTP ${res.status})`);

  // Two steps, two causes: a body that stops arriving (a reset, the timeout firing mid-body) is the
  // network's fault and reads as unreachable; a body that arrives whole but does not parse is the
  // index's.
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return useCache(`index unreachable (body read failed: ${String(err)})`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    return useCache(`index invalid (not JSON: ${String(err)})`);
  }
  const problem = pluginIndexProblem(body);
  if (problem !== undefined) return useCache(`index invalid (${problem})`);

  const cacheFile: CachedPluginIndex = { writtenAt: now().toISOString(), index: body as PluginIndex };
  try {
    await writeFile(cachePath, JSON.stringify(cacheFile, null, 2));
  } catch (err) {
    // The fetch itself succeeded — a cache-write failure (e.g. a read-only volume) must not
    // discard a good, freshly-fetched index.
    console.warn(`[plugins] fetched the index but failed to cache it (${err})`);
  }
  return { index: body as PluginIndex, source: "fresh" };
}
