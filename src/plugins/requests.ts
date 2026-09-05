// The plugin request MAILBOX (#105). The admin panel can't write state.json (the bot is the sole
// writer), so each panel action becomes a request file in data/plugins/requests/ (written by
// `ops/bot-ops.sh plugin-request` via `docker exec -u bun`). The bot drains them — validating each
// against `PluginRequest`, applying the surviving ones through the SAME version-parameterized state
// builders `/plugins` uses (#104), then deleting the file (a malformed/invalid one is moved aside to
// requests/rejected/). This is the trust boundary: a dropped file can only ever run the five actions
// on an ALREADY-installed plugin — never arbitrary code, never a path outside requests/, never enable
// a new plugin (that stays `PLUGINS=`-only). Pure over injected deps (a filesystem seam + the mutate/
// restart deps) so it unit-tests in a temp dir.
import { join } from "node:path";
import type { PluginIndex, PluginIndexEntry, PluginRequest, PluginStateEntry, PluginStateFile } from "./contract";
import {
  cancelPending,
  pinUpdateNow,
  remindLater,
  scheduleUpdate,
  skipVersion,
  type PluginUpdateLog,
} from "./updates";

const DAY_MS = 24 * 60 * 60 * 1000;
const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
// Anchored semver, no slashes/dots-only — this is the AUTHORITATIVE path-traversal gate, since a
// version flows into a filesystem join and an npm URL segment in install.ts.
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:?\d{2}|Z)$/;
const ACTIONS = new Set(["update-now", "schedule", "remind", "skip", "cancel"]);

export interface PluginRequestDeps {
  /** The requests directory, e.g. `<dataDir>/plugins/requests`. */
  requestsDir: string;
  // Filesystem seam (node:fs/promises in production; fakes in tests).
  readDir: (dir: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  unlink: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
  /** Re-fetch the Plugin Index (for the installed-plugin + compatibility pre-flight). */
  loadIndex: () => Promise<PluginIndex>;
  readState: () => Promise<PluginStateFile>;
  /** MUST be host.ts's `mutatePluginState` singleton, or serialization vs the tick/`/plugins` breaks. */
  mutateState: (mutate: (s: PluginStateFile) => PluginStateFile) => Promise<void>;
  requestRestart: (reason: string) => void;
  hostApiVersion: number;
  now: () => Date;
  log: PluginUpdateLog;
}

// Single-flight: the boot drain and a tick drain (both call consumePluginRequests) must not overlap —
// two readdir passes could each see, apply, and unlink the same file. A module-level promise chain
// (the shape host.ts's stateMutator uses) serializes them; a restart between conversations is fine.
let draining: Promise<void> = Promise.resolve();

/** Test seam: reset the single-flight chain between cases. */
export function resetPluginRequestsForTest(): void {
  draining = Promise.resolve();
}

/** Drain the request mailbox once, serialized against any concurrent drain. Never throws. */
export function consumePluginRequests(deps: PluginRequestDeps): Promise<void> {
  const run = draining.then(
    () => drainOnce(deps),
    () => drainOnce(deps),
  );
  draining = run.catch(() => {});
  return run;
}

async function drainOnce(deps: PluginRequestDeps): Promise<void> {
  let files: string[];
  try {
    files = (await deps.readDir(deps.requestsDir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return; // no requests dir yet (or unreadable) — nothing to drain
  }
  if (files.length === 0) return;

  const [index, state] = await Promise.all([deps.loadIndex(), deps.readState()]);
  const installed = new Map(state.plugins.map((p) => [p.name, p]));
  const entryByName = new Map(index.plugins.map((e) => [e.name, e]));
  let restartReason: string | undefined;

  for (const file of files) {
    const path = join(deps.requestsDir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(await deps.readFile(path));
    } catch (err) {
      await reject(deps, path, file, `unreadable JSON — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const v = validate(raw, installed, entryByName, deps.hostApiVersion);
    if (!v.ok) {
      await reject(deps, path, file, v.reason);
      continue;
    }
    try {
      const restart = await apply(v.request, deps);
      if (restart) restartReason ??= `plugin update (panel): ${v.request.plugin} → ${restart}`;
      await unlinkTolerant(deps, path);
    } catch (err) {
      // An apply failure is unexpected (the mutator write failed) — move it aside so it doesn't loop.
      await reject(deps, path, file, `apply failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ONE restart after the full drain, so an update-now doesn't strand later co-dropped files (two
  // update-nows share it — buildPluginStateFile consumes each targetVersion independently).
  if (restartReason !== undefined) deps.requestRestart(restartReason);
}

type Valid = { ok: true; request: PluginRequest } | { ok: false; reason: string };

/** Validate a parsed request against `PluginRequest` + formats + the installed/compatibility
 *  pre-flight. Pure. A `false` result is moved to rejected/; a `true` result is safe to apply. */
export function validate(
  raw: unknown,
  installed: Map<string, PluginStateEntry>,
  entryByName: Map<string, PluginIndexEntry>,
  hostApiVersion: number,
): Valid {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "not an object" };
  const r = raw as Record<string, unknown>;
  const action = r.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) return { ok: false, reason: `unknown action ${JSON.stringify(action)}` };
  if (typeof r.plugin !== "string" || !PLUGIN_NAME_RE.test(r.plugin)) return { ok: false, reason: `bad plugin name ${JSON.stringify(r.plugin)}` };
  if (typeof r.requestedBy !== "string" || r.requestedBy.length === 0) return { ok: false, reason: "missing requestedBy" };
  const plugin = r.plugin;

  // Pre-flight: the plugin must be installed (updateEntry silently no-ops on an unknown name, so a
  // missing check would delete the file having done nothing — hiding operator error).
  const stateEntry = installed.get(plugin);
  if (!stateEntry?.installedVersion) return { ok: false, reason: `${plugin} is not an installed plugin` };

  // `version` (required for all but cancel) — the traversal-safe gate.
  if (action !== "cancel") {
    if (typeof r.version !== "string" || !VERSION_RE.test(r.version)) {
      return { ok: false, reason: `bad version ${JSON.stringify(r.version)}` };
    }
  }
  if (action === "schedule") {
    if (typeof r.at !== "string" || !ISO_OFFSET_RE.test(r.at) || Number.isNaN(Date.parse(r.at))) {
      return { ok: false, reason: `bad schedule time ${JSON.stringify(r.at)}` };
    }
  }
  if (action === "remind" && r.days !== undefined) {
    if (typeof r.days !== "number" || !Number.isInteger(r.days) || r.days < 1 || r.days > 999) {
      return { ok: false, reason: `bad days ${JSON.stringify(r.days)}` };
    }
  }
  // The only compatibility check the index shape allows: it carries hostApiVersion for the CURRENT
  // version only (PluginRelease has none). If the pin equals the index's current and is incompatible,
  // reject; any other version is honored (a bad one fails install and reverts + reports, per #104).
  if ((action === "update-now" || action === "schedule")) {
    const entry = entryByName.get(plugin);
    if (entry && r.version === entry.version && entry.hostApiVersion !== hostApiVersion) {
      return { ok: false, reason: `${plugin} ${r.version} needs host API v${entry.hostApiVersion} (bot is v${hostApiVersion})` };
    }
  }
  return { ok: true, request: raw as PluginRequest };
}

/** Apply one validated request through the shared #104 builders. Returns the target version if this
 *  request needs a restart (update-now), else undefined. */
async function apply(r: PluginRequest, deps: PluginRequestDeps): Promise<string | undefined> {
  switch (r.action) {
    case "update-now": {
      const report = {
        plugin: r.plugin,
        toVersion: r.version,
        userId: r.requestedBy, // a panel identity — the report-back DM site skips a non-snowflake
        channelId: undefined,
        requestedAt: deps.now().getTime(),
      };
      await deps.mutateState(pinUpdateNow(r.plugin, r.version, report));
      return r.version;
    }
    case "schedule":
      await deps.mutateState(scheduleUpdate(r.plugin, r.version, r.at, r.requestedBy));
      return undefined;
    case "remind":
      await deps.mutateState(remindLater(r.plugin, new Date(deps.now().getTime() + (r.days ?? 7) * DAY_MS).toISOString()));
      return undefined;
    case "skip":
      await deps.mutateState(skipVersion(r.plugin, r.version));
      return undefined;
    case "cancel":
      await deps.mutateState(cancelPending(r.plugin));
      return undefined;
  }
}

async function unlinkTolerant(deps: PluginRequestDeps, path: string): Promise<void> {
  try {
    await deps.unlink(path);
  } catch {
    /* already consumed by a racing drain (single-flight makes this rare) — fine */
  }
}

async function reject(deps: PluginRequestDeps, path: string, file: string, reason: string): Promise<void> {
  deps.log.warn(`[plugins] rejecting request ${file}: ${reason}`);
  const rejectedDir = join(deps.requestsDir, "rejected");
  try {
    await deps.mkdir(rejectedDir);
    await deps.rename(path, join(rejectedDir, file));
  } catch (err) {
    // Couldn't move it aside — unlink so it doesn't re-reject every drain; if that fails too, log.
    try {
      await deps.unlink(path);
    } catch {
      deps.log.error(`[plugins] couldn't quarantine or delete rejected request ${file}`, err);
    }
  }
}
