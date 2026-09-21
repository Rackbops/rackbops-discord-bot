// The plugin request MAILBOX (#105, extended by #241). The admin panel can't write the bot's data (the
// bot is the sole writer), so each panel action becomes a request file in data/plugins/requests/
// (written for the update actions by `ops/bot-ops.sh plugin-request` via `docker exec -u bun`; the
// routing actions get the same treatment in #240). The bot drains them --
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
  /**
   * How long to wait before looking a second time at a file that will not parse (default 250 ms). The wait
   * is made once per drain, by the first such file: a later one in the same drain is looked at again at
   * once, because waiting for each would stall a mailbox of broken files by 250 ms apiece. A writer older
   * than #240 is not atomic (`cat > file`; #240 is where `ops/bot-ops.sh` learns to write to a temp name and
   * rename it), and an instance can run this bot with that older script until `install.sh` is re-run, so a
   * request can be read while it is still being written -- empty, or cut off -- and rejecting it then would
   * lose a good request. (That older script can only write the five update actions -- it refuses every
   * other one -- so the half-written file is never a `webhook-add`, which would be deleted rather than set
   * aside.) Now that the mailbox is drained every few seconds that is a real window, so a file that fails
   * to PARSE gets exactly one more look before it is rejected (a file that parses but fails validation gets
   * none), which covers a write that finishes within the wait and not one that runs longer. Injected so no
   * test waits on a wall clock.
   */
  tornReadRetryMs?: number;
}

const TORN_READ_RETRY_MS = 250;

// Single-flight: the boot drain and a tick drain (both call consumePluginRequests) must not overlap —
// two readdir passes could each see, apply, and unlink the same file. A module-level promise chain
// (the shape host.ts's stateMutator uses) serializes them; a restart between conversations is fine.
let draining: Promise<void> = Promise.resolve();

// Files that were dealt with but could not be removed: a request that was applied (ROUTING or UPDATE), or
// any file that was refused. Left alone a routing request would be applied again on every drain -- a
// webhook-add asks Discord again each time --, an update request likewise (an update-now would ask for a
// restart each time: the bot restarts, the boot drain finds the file again, and it restarts again, until
// someone deletes the file by hand; #263), and a refused file would be refused again, and logged again,
// every few seconds. So each is remembered under its name, with the text that was read: a later drain finds
// the same text, does NOT handle it again, and tries the delete once more (a transient EBUSY should not
// leave a secret on disk until a restart). A different text under the same name is a different request and
// is handled normally.
// A file that could not be read at all is remembered as UNREAD, and only that kind is also deleted again
// when it is still unreadable: a name that was read before may since hold a new request. (What is left of
// that risk: a new request under a name remembered as UNREAD, which is itself unreadable at that moment,
// goes with it -- it could not have been handled either.)
//
// What this does NOT survive is a restart -- the map is in memory, and `PluginStateFile` (contract.ts,
// vendored by another repo) has nowhere to put a persisted list. For an update-now the loop is ended a
// different way: an update-now or schedule for the version that is ALREADY installed is refused
// (`validate`), so once the restart the update-now caused has installed the target, the replayed file is
// refused and no longer pins or restarts. The residual is an undeletable file AND an installed version that
// never becomes the requested one (the install fails and falls back, is skipped at selection, or an
// operator's `PLUGINS=name@version` pin wins over the request): one restart per boot, as it was, and left
// as it is. A second, older hazard is unchanged too: an undeletable update-now that is still in the
// mailbox after a LATER upgrade past its version (installed 1.2.0, the file says 1.1.0) is replayed once
// against the newer install -- it pins the older version and restarts, and is refused once that lands --
// and a stale `schedule` is likewise applied again after a restart. `main` did the same on every drain.
//
// What is remembered for a file that could not even be read. A symbol, not a string: every string is a text
// some file could hold, and a stuck file whose text happened to BE the marker would be taken for one that
// was never read -- so a request that later reused its name would be deleted unhandled on one failed read.
const UNREAD: unique symbol = Symbol("unread");
const undeletable = new Map<string, string | typeof UNREAD>();

/** Test seam: reset the single-flight chain between cases. */
export function resetPluginRequestsForTest(): void {
  draining = Promise.resolve();
  undeletable.clear();
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

// Whether the text of a request file holds a webhook URL, or enough of one to be its secret: the path
// `webhooks/<id>/<token>` with or without a host (so a port, a doubled slash or a trailing dot cannot hide
// it), or the discord API host followed by `webhooks/`. JSON can spell any character as an escape and a
// URL can percent-encode any character (a slash, or a letter of `webhooks` or of the host), so those are
// read as what they stand for before looking. Each is decoded ONCE: a doubly-encoded spelling (`%2577`)
// is not chased, since no writer of this mailbox and no URL parser produces one.
const WEBHOOK_PATH_IN_TEXT = /webhooks\/\d{5,25}\/[\w-]{20,}/i;
const WEBHOOK_HOST_IN_TEXT = /discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\//i;
function carriesWebhookUrl(text: string): boolean {
  const plain = text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, "/")
    .replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return WEBHOOK_PATH_IN_TEXT.test(plain) || WEBHOOK_HOST_IN_TEXT.test(plain);
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Parsed = { ok: true; raw: unknown } | { ok: false; message: string };
function tryParse(text: string): Parsed {
  try {
    return { ok: true, raw: JSON.parse(text) };
  } catch (err) {
    return { ok: false, message: errorText(err) };
  }
}

// A parser's message quotes what it choked on -- Bun's says `Unexpected identifier "<text>"` -- which may
// be a token. The shape of the message is what an operator needs, so the quoted text is taken out.
const withoutQuotedText = (message: string): string => message.replace(/"[^"]*"/g, '"..."');

const isNotFound = (err: unknown): boolean => typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";

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
  // Forget a stuck file once it is gone, so a request that arrives later under the same name is handled.
  for (const name of [...undeletable.keys()]) if (!files.includes(name)) undeletable.delete(name);
  if (files.length === 0) return;

  // The Plugin Index is a network fetch (five-second timeout) and only the five update actions need it,
  // so it is loaded the first time a file needs it -- once per drain -- and never for a drain of routing
  // requests alone. A load that throws leaves the update files queued and fails the drain, as it always
  // has -- but only at its end, after the routing requests that did not need the index were handled.
  let pluginContext: Promise<PluginContext> | undefined;
  const loadPluginContext = (): Promise<PluginContext> =>
    (pluginContext ??= Promise.all([deps.loadIndex(), deps.readState()]).then(([index, state]) => ({
      installed: new Map(state.plugins.map((p) => [p.name, p])),
      entryByName: new Map(index.plugins.map((e) => [e.name, e])),
    })));
  let restartReason: string | undefined;
  let loadFailure: unknown;
  let paused = false;

  for (const file of files) {
    const path = join(deps.requestsDir, file);
    // The writer names a webhook request for its action, so the name alone says it may hold a URL --
    // even when the file cannot be read or parsed.
    const namedForSecret = file.includes("webhook-add");
    const stuck = undeletable.get(file);
    let text: string;
    try {
      text = await deps.readFile(path);
    } catch (err) {
      if (stuck !== undefined) {
        // Reported already. A file that has only ever been unreadable is deleted again; one that was read
        // (and dealt with) under this name may since have been replaced by a request that has not been
        // handled, and a failed read must not delete that.
        if (stuck === UNREAD && (await removeFile(deps, path))) undeletable.delete(file);
        continue;
      }
      const gone = await reject(deps, path, file, namedForSecret ? "unreadable JSON" : `unreadable JSON — ${errorText(err)}`, namedForSecret);
      if (!gone) undeletable.set(file, UNREAD);
      continue;
    }
    if (stuck !== undefined) {
      if (text === stuck) {
        // The file whose delete failed: it was dealt with, so only the delete is tried again.
        if (await removeFile(deps, path)) undeletable.delete(file);
        continue;
      }
      undeletable.delete(file); // another request under the same name
    }
    // Refuses this file; one that cannot then be removed is remembered (see `undeletable`).
    const refuse = async (reason: string, secret = false): Promise<void> => {
      if (!(await reject(deps, path, file, reason, secret))) undeletable.set(file, text);
    };
    let parsed = tryParse(text);
    if (!parsed.ok) {
      // A writer older than #240 is not atomic, so this may be a request still being written: look once more before
      // rejecting it (see `tornReadRetryMs`). The wait is made once per drain, by the first file that needs
      // it; a later one is looked at again at once. If the file has gone or cannot be read now, the first
      // failure stands.
      if (!paused) {
        await pause(deps.tornReadRetryMs ?? TORN_READ_RETRY_MS);
        paused = true;
      }
      try {
        const again = await deps.readFile(path);
        if (again !== text) {
          text = again;
          parsed = tryParse(again);
        }
      } catch {
        /* keep the first failure */
      }
    }
    const holdsUrl = carriesWebhookUrl(text);
    const secretBearing = namedForSecret || holdsUrl;
    if (!parsed.ok) {
      // For a file that may hold a URL the parser's message is not quoted at all, and for any other its
      // quoted text is taken out.
      const why = secretBearing ? "unreadable JSON" : `unreadable JSON — ${withoutQuotedText(parsed.message)}`;
      await refuse(why, secretBearing);
      continue;
    }
    const raw = parsed.raw;

    const action = isRecord(raw) ? raw.action : undefined;
    if (typeof action === "string" && ROUTING_ACTIONS.has(action)) {
      await handleRoutingRequest(deps, path, file, text, raw, action, secretBearing || action === "webhook-add");
      continue;
    }

    // Not a routing request. An update request has no reason to hold a webhook url, and one that does
    // would be stored (its `requestedBy` lands in state.json and a log line): refuse it, and delete it.
    if (secretBearing) {
      await refuse(holdsUrl ? "a webhook url does not belong in this request" : "not a routing action", true);
      continue;
    }

    let context: PluginContext;
    try {
      context = await loadPluginContext();
    } catch (err) {
      // This file stays queued, as it always has; the routing requests behind it are not held up by it.
      loadFailure ??= err;
      continue;
    }
    const { installed, entryByName } = context;
    // #249: validation must not be able to wedge the mailbox. A throw here used to escape the drain with
    // this file still queued, so every later drain threw on it again.
    let v: Valid;
    try {
      v = validate(raw, installed, entryByName, deps.hostApiVersion);
    } catch (err) {
      v = { ok: false, reason: `validation threw — ${errorText(err)}` };
    }
    if (!v.ok) {
      await refuse(v.reason);
      continue;
    }
    try {
      const restart = await apply(v.request, deps);
      if (restart) restartReason ??= `plugin update (panel): ${v.request.plugin} → ${restart}`;
      // An applied request whose file cannot be removed is remembered, as a routing request is (see
      // `undeletable`): applied again on every drain it would restart the bot again for an update-now, and
      // write state again (silently: nothing on this path logs) for the rest (#263).
      if (!(await removeFile(deps, path))) {
        deps.log.error(`[plugins] couldn't delete applied request ${file}; it will not be applied again`);
        undeletable.set(file, text);
      }
    } catch (err) {
      // An apply failure is unexpected (the mutator write failed) — move it aside so it doesn't loop.
      await refuse(`apply failed — ${errorText(err)}`);
    }
  }

  // A failed load of the Plugin Index still fails the drain, as it always has -- once the routing
  // requests that did not need it have been dealt with.
  if (loadFailure !== undefined) throw loadFailure;

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
  text: string,
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

  // A request whose file cannot be removed is remembered (with the text that was read) and not handled
  // again: applying it on every drain would ask Discord about the same webhook every few seconds, and
  // record a result each time. Its delete is tried again on each drain.
  let removed: boolean;
  if (outcome.ok) {
    removed = await removeFile(deps, path);
    if (!removed) deps.log.error(`[plugins] couldn't delete applied request ${file}; it will not be applied again`);
  } else {
    removed = await reject(deps, path, file, reason ?? "rejected", secretBearing);
  }
  if (!removed) undeletable.set(file, text);
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
  // An update to the version that is ALREADY installed is a no-op, so it is refused (#263) rather than
  // pinned and restarted for. That ends the restart loop of an applied update-now whose file cannot be
  // deleted, once the install has landed (the file is seen again after the restart it caused, and by then it
  // names the installed version; see the residual beside `undeletable`), and it is a better answer to a
  // double-click in the panel too. Only these two actions: skip, remind and cancel for the installed version
  // are harmless and still apply. Placed after the shape checks above (version, schedule time, days), so a
  // malformed version is still "bad version" and a bad schedule time is still that, and before the host-API
  // check (the one corner where the reason changes for a request that was refused before: the index's
  // current version, incompatible with this bot, and also the installed one, is now "already on", which is
  // the more useful answer). Both values in the reason are already validated text.
  if ((action === "update-now" || action === "schedule") && r.version === stateEntry.installedVersion) {
    return { ok: false, reason: `${plugin} is already on ${r.version}` };
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

/** Delete a request file. True once it is gone (already gone counts -- a racing drain may have consumed it,
 *  which single-flight makes rare); false if it could not be removed. */
async function removeFile(deps: PluginRequestDeps, path: string): Promise<boolean> {
  try {
    await deps.unlink(path);
    return true;
  } catch (err) {
    return isNotFound(err);
  }
}

/**
 * Refuse a request file. Logged, then moved aside to rejected/ so an operator can look at it -- except a
 * `secretBearing` file, which may hold a webhook URL and is DELETED instead: rejected/ would keep the
 * secret on disk indefinitely, in a folder nobody treats as secret. If that delete fails the error names
 * the file and nothing else. Resolves true when the file is gone (moved or deleted), false when it is not.
 */
async function reject(deps: PluginRequestDeps, path: string, file: string, reason: string, secretBearing = false): Promise<boolean> {
  deps.log.warn(`[plugins] rejecting request ${file}: ${redactWebhookUrls(reason)}`);
  if (secretBearing) {
    try {
      await deps.unlink(path);
      return true;
    } catch {
      deps.log.error(`[plugins] couldn't delete rejected request ${file}`);
      return false;
    }
  }
  const rejectedDir = join(deps.requestsDir, "rejected");
  try {
    await deps.mkdir(rejectedDir);
    await deps.rename(path, join(rejectedDir, file));
    return true;
  } catch (err) {
    // Couldn't move it aside — unlink so it doesn't re-reject every drain; if that fails too, log.
    try {
      await deps.unlink(path);
      return true;
    } catch {
      deps.log.error(`[plugins] couldn't quarantine or delete rejected request ${file}`, err);
      return false;
    }
  }
}
