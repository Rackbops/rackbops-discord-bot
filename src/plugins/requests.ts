// The plugin request MAILBOX (#105, extended by #241). The admin panel can't write the bot's data (the
// bot is the sole writer), so each panel action becomes a request file in data/plugins/requests/
// (written by `ops/bot-ops.sh plugin-request` via `docker exec -u bun`). The bot drains them --
// validating each, applying the surviving ones, then deleting the file (a malformed/invalid one is moved
// aside to requests/rejected/). Two families share the directory:
//
//   * the five UPDATE actions (update-now, schedule, remind, skip, cancel) on an ALREADY-installed
//     plugin, validated against `PluginRequest` and applied through the SAME version-parameterized state
//     builders `/plugins` uses (#104) -- this file;
//   * the four ROUTING actions (routing-set, webhook-add, webhook-remove, discovery-refresh) against
//     servers and channels the bot can see -- `src/routing/requests.ts`, which this file only
//     dispatches to.
//
// This is the trust boundary: a dropped file can only ever run those nine actions -- never arbitrary
// code, never a path outside requests/, never enable a new plugin (that stays `PLUGINS=`-only).
//
// A file that may carry a WEBHOOK URL is a secret: its rejection deletes it rather than moving it to
// rejected/, and no reason it produces quotes a parser or a fetch error. See `src/routing/requests.ts`.
//
// Pure over injected deps (a filesystem seam + the mutate/restart deps) so it unit-tests in a temp dir.
import { join } from "node:path";
import { withResult, type RequestResult } from "../routing/model";
import {
  applyRoutingRequest,
  parseRoutingRequest,
  redactWebhookUrls,
  requestIdOf,
  ROUTING_ACTIONS,
  RoutingRefusal,
  type RoutingRequestDeps,
} from "../routing/requests";
import { shown } from "../routing/resolve";
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
  /** What the four routing actions run against (#241). Absent: a routing action is rejected. */
  routing?: RoutingRequestDeps;
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Whether the text of a request file holds a webhook URL. JSON may spell a slash `\/` or `/`, so
// those are read as the slash they are before looking.
const WEBHOOK_URL_IN_TEXT = /discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\//i;
function carriesWebhookUrl(text: string): boolean {
  return WEBHOOK_URL_IN_TEXT.test(text.replace(/\\\//g, "/").replace(/\\u002f/gi, "/"));
}

interface PluginContext {
  installed: Map<string, PluginStateEntry>;
  entryByName: Map<string, PluginIndexEntry>;
}

async function drainOnce(deps: PluginRequestDeps): Promise<void> {
  let files: string[];
  try {
    files = (await deps.readDir(deps.requestsDir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return; // no requests dir yet (or unreadable) — nothing to drain
  }
  if (files.length === 0) return;

  // The Plugin Index is a network fetch (five-second timeout) and only the five update actions need it,
  // so it is loaded the first time a file needs it -- once per drain -- and never for a drain of routing
  // requests alone. A load that throws propagates out of the drain exactly as it always has, leaving
  // the files that were not reached queued.
  let pluginContext: Promise<PluginContext> | undefined;
  const loadPluginContext = (): Promise<PluginContext> =>
    (pluginContext ??= Promise.all([deps.loadIndex(), deps.readState()]).then(([index, state]) => ({
      installed: new Map(state.plugins.map((p) => [p.name, p])),
      entryByName: new Map(index.plugins.map((e) => [e.name, e])),
    })));
  let restartReason: string | undefined;

  for (const file of files) {
    const path = join(deps.requestsDir, file);
    // The writer names a webhook request for its action, so the name alone says it may hold a URL --
    // even when the file cannot be read or parsed.
    const namedForSecret = file.includes("webhook-add");
    let text: string;
    try {
      text = await deps.readFile(path);
    } catch (err) {
      await reject(deps, path, file, namedForSecret ? "unreadable JSON" : `unreadable JSON — ${errorText(err)}`, namedForSecret);
      continue;
    }
    const secretBearing = namedForSecret || carriesWebhookUrl(text);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      // A parser's message quotes what it choked on, which for such a file may be the URL.
      await reject(deps, path, file, secretBearing ? "unreadable JSON" : `unreadable JSON — ${errorText(err)}`, secretBearing);
      continue;
    }

    const action = isRecord(raw) ? raw.action : undefined;
    if (typeof action === "string" && ROUTING_ACTIONS.has(action)) {
      await handleRoutingRequest(deps, path, file, raw, action, secretBearing || action === "webhook-add");
      continue;
    }

    const { installed, entryByName } = await loadPluginContext();
    // #249: validation must not be able to wedge the mailbox. A throw here used to escape the drain with
    // this file still queued, so every later drain threw on it again.
    let v: Valid;
    try {
      v = validate(raw, installed, entryByName, deps.hostApiVersion);
    } catch (err) {
      v = { ok: false, reason: `validation threw — ${errorText(err)}` };
    }
    if (!v.ok) {
      await reject(deps, path, file, v.reason, secretBearing);
      continue;
    }
    try {
      const restart = await apply(v.request, deps);
      if (restart) restartReason ??= `plugin update (panel): ${v.request.plugin} → ${restart}`;
      await unlinkTolerant(deps, path);
    } catch (err) {
      // An apply failure is unexpected (the mutator write failed) — move it aside so it doesn't loop.
      await reject(deps, path, file, `apply failed — ${errorText(err)}`, secretBearing);
    }
  }

  // ONE restart after the full drain, so an update-now doesn't strand later co-dropped files (two
  // update-nows share it — buildPluginStateFile consumes each targetVersion independently).
  if (restartReason !== undefined) deps.requestRestart(restartReason);
}

type Outcome = { ok: true; channelId?: string } | { ok: false; reason: string };

/**
 * One routing request: parse, apply, record what became of it under the id the panel chose (if it chose
 * one), then delete the file -- or, for a refusal, reject it. A request is "applied" once its change is
 * written; see `applyRoutingRequest`.
 */
async function handleRoutingRequest(
  deps: PluginRequestDeps,
  path: string,
  file: string,
  raw: unknown,
  action: string,
  secretBearing: boolean,
): Promise<void> {
  const routing = deps.routing;
  let outcome: Outcome;
  let plugin: string | undefined;
  if (routing === undefined) {
    outcome = { ok: false, reason: "routing is not available" };
  } else {
    const parsed = parseRoutingRequest(raw);
    if (!parsed.ok) {
      outcome = { ok: false, reason: parsed.reason };
    } else {
      if (parsed.request.action === "routing-set") plugin = parsed.request.plugin;
      try {
        const applied = await applyRoutingRequest(parsed.request, routing);
        outcome = { ok: true, ...(applied.channelId === undefined ? {} : { channelId: applied.channelId }) };
      } catch (err) {
        outcome = { ok: false, reason: err instanceof RoutingRefusal ? err.message : `apply failed — ${errorText(err)}` };
      }
    }
  }

  // No reason leaves this function, in a log or in a result, without passing through this.
  const reason = outcome.ok ? undefined : redactWebhookUrls(outcome.reason);
  const id = requestIdOf(raw);
  if (routing !== undefined && id !== undefined) {
    const result: RequestResult = {
      id,
      action,
      ...(plugin === undefined ? {} : { plugin }),
      ...(outcome.ok && outcome.channelId !== undefined ? { channelId: outcome.channelId } : {}),
      ok: outcome.ok,
      ...(reason === undefined ? {} : { reason }),
      at: deps.now().toISOString(),
    };
    try {
      await routing.mutateRouting((current) => withResult(current, result));
    } catch (err) {
      // The change is already made; failing to say so must not turn an applied request into a rejected one.
      deps.log.warn(`[plugins] couldn't record the result of request ${file}: ${redactWebhookUrls(errorText(err))}`);
    }
  }

  if (outcome.ok) await unlinkTolerant(deps, path);
  else await reject(deps, path, file, reason ?? "rejected", secretBearing);
}

type Valid = { ok: true; request: PluginRequest } | { ok: false; reason: string };

/** Validate a parsed request against `PluginRequest` + formats + the installed/compatibility
 *  pre-flight. Pure. A `false` result is moved to rejected/; a `true` result is safe to apply.
 *  Every untrusted value that goes into a reason goes through `shown`: it cannot throw and it clips. */
export function validate(
  raw: unknown,
  installed: Map<string, PluginStateEntry>,
  entryByName: Map<string, PluginIndexEntry>,
  hostApiVersion: number,
): Valid {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "not an object" };
  const r = raw as Record<string, unknown>;
  const action = r.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) return { ok: false, reason: `unknown action ${shown(action)}` };
  if (typeof r.plugin !== "string" || !PLUGIN_NAME_RE.test(r.plugin)) return { ok: false, reason: `bad plugin name ${shown(r.plugin)}` };
  if (typeof r.requestedBy !== "string" || r.requestedBy.length === 0) return { ok: false, reason: "missing requestedBy" };
  const plugin = r.plugin;

  // Pre-flight: the plugin must be installed (updateEntry silently no-ops on an unknown name, so a
  // missing check would delete the file having done nothing — hiding operator error).
  const stateEntry = installed.get(plugin);
  if (!stateEntry?.installedVersion) return { ok: false, reason: `${plugin} is not an installed plugin` };

  // `version` (required for all but cancel) — the traversal-safe gate.
  if (action !== "cancel") {
    if (typeof r.version !== "string" || !VERSION_RE.test(r.version)) {
      return { ok: false, reason: `bad version ${shown(r.version)}` };
    }
  }
  if (action === "schedule") {
    if (typeof r.at !== "string" || !ISO_OFFSET_RE.test(r.at) || Number.isNaN(Date.parse(r.at))) {
      return { ok: false, reason: `bad schedule time ${shown(r.at)}` };
    }
  }
  if (action === "remind" && r.days !== undefined) {
    if (typeof r.days !== "number" || !Number.isInteger(r.days) || r.days < 1 || r.days > 999) {
      return { ok: false, reason: `bad days ${shown(r.days)}` };
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

/**
 * Refuse a request file. Logged, then moved aside to rejected/ so an operator can look at it -- except a
 * `secretBearing` file, which may hold a webhook URL and is DELETED instead: rejected/ would keep the
 * secret on disk indefinitely, in a folder nobody treats as secret. If that delete fails the error names
 * the file and nothing else.
 */
async function reject(deps: PluginRequestDeps, path: string, file: string, reason: string, secretBearing = false): Promise<void> {
  deps.log.warn(`[plugins] rejecting request ${file}: ${redactWebhookUrls(reason)}`);
  if (secretBearing) {
    try {
      await deps.unlink(path);
    } catch {
      deps.log.error(`[plugins] couldn't delete rejected request ${file}`);
    }
    return;
  }
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
