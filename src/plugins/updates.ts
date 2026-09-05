// Plugin update NOTIFICATIONS: tell admins, once per new version and with what changed, that a
// newer version of an installed plugin exists. It NEVER installs, restarts, schedules, or moves a
// pin — that is #104 (`/plugins update|remind|skip|cancel`). #95's UX principle: the operator's copy
// changes only when the operator says so. Pure decision + rendering, with one impure orchestrator
// (`checkPluginUpdates`) whose every side effect is an injected dep, so all of this unit-tests
// without a Discord Client. Deliberately imports nothing from restart/install.
import type {
  PluginIndex,
  PluginIndexEntry,
  PluginRelease,
  PluginStateEntry,
  PluginStateFile,
} from "./contract";

const MESSAGE_LIMIT = 2000; // Discord's hard content cap (mirrors src/report.ts).

/**
 * Semver ordering: -1 (a<b), 0 (equal), 1 (a>b). Release parts compared numerically; a prerelease
 * ranks BELOW its release (`1.0.0-rc.1 < 1.0.0`); dotted prerelease identifiers compare numerically
 * when both are numeric, a numeric identifier ranks below an alphanumeric one, otherwise ASCII, and
 * a shorter prerelease ranks below an otherwise-equal longer one (semver §11). Build metadata (`+…`)
 * is ignored. Small and pure — the repo has no semver dep, and install.ts's private comparator is
 * descending and prerelease-blind.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const [aMain, aPre] = splitPrerelease(a);
  const [bMain, bPre] = splitPrerelease(b);
  const am = aMain.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bm = bMain.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(am.length, bm.length); i++) {
    const d = (am[i] ?? 0) - (bm[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  // Equal release parts: a version WITH a prerelease is lower than one without.
  if (!aPre && !bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  const ap = aPre.split(".");
  const bp = bPre.split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1; // a shorter prerelease is lower
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number.parseInt(x, 10) - Number.parseInt(y, 10);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function splitPrerelease(v: string): [string, string] {
  const noBuild = v.split("+")[0] ?? v;
  const dash = noBuild.indexOf("-");
  return dash === -1 ? [noBuild, ""] : [noBuild.slice(0, dash), noBuild.slice(dash + 1)];
}

export type PluginUpdateAction = "notify" | "remind" | "none";

export interface PluginUpdateDecision {
  name: string;
  /** The pinned/installed version the notice compares against. */
  from: string;
  /** The strictly-newer index version. */
  to: string;
  /** `to` runs on this bot's host API. An incompatible newer version still surfaces (worded
   *  "needs a newer bot"), never installable. */
  compatible: boolean;
  /** The host API `to` requires — for the incompatible-version wording. */
  neededHostApi: number;
  /** Releases in `(from, to]`, newest first. */
  releases: PluginRelease[];
  action: PluginUpdateAction;
}

/**
 * Per INSTALLED plugin, decide whether to notify/remind about a newer index version. Pure — decides
 * only about *telling* admins, never about installing. `notify` on a version not yet notified (and
 * not skipped); `remind` when a snooze (`remindAt`) has come due for the still-current notice; a
 * version newer than a skipped/snoozed one re-notifies because `to` differs from what was recorded.
 */
export function decidePluginUpdates(
  state: PluginStateFile,
  index: PluginIndex,
  hostApiVersion: number,
  now: Date,
): PluginUpdateDecision[] {
  const entryByName = new Map(index.plugins.map((e) => [e.name, e]));
  const decisions: PluginUpdateDecision[] = [];
  for (const p of state.plugins) {
    const from = p.installedVersion;
    if (!from) continue; // never installed — nothing to update
    const entry = entryByName.get(p.name);
    if (!entry) continue; // not in the index — nothing to compare against
    if (compareSemver(entry.version, from) <= 0) continue; // not strictly newer
    const to = entry.version;
    let action: PluginUpdateAction;
    if (to === p.skippedVersion) action = "none";
    else if (to !== p.notifiedVersion) action = "notify";
    else if (p.remindAt !== undefined && now.getTime() >= Date.parse(p.remindAt)) action = "remind";
    else action = "none";
    decisions.push({
      name: p.name,
      from,
      to,
      compatible: entry.hostApiVersion === hostApiVersion,
      neededHostApi: entry.hostApiVersion,
      releases: releasesBetween(entry, from, to),
      action,
    });
  }
  return decisions;
}

/** Releases in `(from, to]` by semver, newest first. */
function releasesBetween(entry: PluginIndexEntry, from: string, to: string): PluginRelease[] {
  return entry.releases
    .filter((r) => compareSemver(r.version, from) > 0 && compareSemver(r.version, to) <= 0)
    .sort((a, b) => compareSemver(b.version, a.version));
}

/** Render release-notes blocks, clamped to `maxLen` with a `… full notes: <url>` tail (the
 *  `reportAnnouncement` clamp shape). `maxLen` is a budget the caller sets so the WHOLE message it
 *  wraps these notes in stays within Discord's cap — not just the notes sub-part. */
function renderNotes(releases: PluginRelease[], maxLen = MESSAGE_LIMIT): string {
  if (releases.length === 0) return "(no release notes published)";
  const body = releases.map((r) => `**${r.version}** (${r.publishedAt.slice(0, 10)})\n${r.notes}`).join("\n\n");
  if (body.length <= maxLen) return body;
  const tail = `\n… full notes: ${releases[0]?.url ?? ""}`;
  return body.slice(0, Math.max(0, maxLen - tail.length)) + tail;
}

/** The `(from, to]` release notes for a plugin, rendered + clamped. Exported for `/plugins list`. */
export function releaseNotesBetween(entry: PluginIndexEntry, from: string, to: string): string {
  return renderNotes(releasesBetween(entry, from, to));
}

/** The DM/channel notification text. Compatible: the four operator options. Incompatible: says the
 *  bot must update first, and offers no install path. */
export function notificationMessage(u: PluginUpdateDecision, botHostApi: number): string {
  const head = `📦 **${u.name}** ${u.to} is available (installed ${u.from}).\n`;
  const last = u.compatible
    ? `Update with \`/plugins update ${u.name}\` (now, or \`at:\` a time), \`/plugins remind ${u.name}\`, \`/plugins skip ${u.name}\`, or use the admin panel.`
    : `This version needs a newer bot (host API v${u.neededHostApi}, this bot is v${botHostApi}) — update the bot first.`;
  // Budget the notes so head + notes + "\n" + last stays within Discord's 2000-char cap — clamping
  // only the notes (as before) let the assembled message overflow and Discord rejected the send,
  // silently losing the notice after retries. Same whole-message budgeting as report.ts.
  const notes = renderNotes(u.releases, MESSAGE_LIMIT - head.length - last.length - 1);
  return `${head}${notes}\n${last}`;
}

/** The `/plugins list` body: per installed plugin, its version, any newer version + first-release
 *  note, and skip/snooze markers. Uses the (freshly-fetched) index for "available" + notes. Pure. */
export function renderPluginsList(state: PluginStateFile, index: PluginIndex, _now: Date): string {
  if (state.plugins.length === 0) return "No plugins installed.";
  const entryByName = new Map(index.plugins.map((e) => [e.name, e]));
  const out = state.plugins
    .map((p) => {
      let line = `• **${p.name}** — installed ${p.installedVersion ?? "(not installed)"}`;
      const entry = entryByName.get(p.name);
      if (p.installedVersion && entry && compareSemver(entry.version, p.installedVersion) > 0) {
        line += ` → ${entry.version} available`;
        if (p.skippedVersion === entry.version) line += " (skipped)";
        else if (p.remindAt !== undefined) line += ` (remind <t:${Math.floor(Date.parse(p.remindAt) / 1000)}:R>)`;
        const firstBlock = releaseNotesBetween(entry, p.installedVersion, entry.version).split("\n\n")[0] ?? "";
        if (firstBlock) line += `\n${firstBlock.slice(0, 300)}`;
      }
      return line;
    })
    .join("\n");
  // Clamp the whole reply — many plugins each with a note can exceed Discord's cap and editReply
  // would reject it, leaving the deferred reply hanging.
  if (out.length <= MESSAGE_LIMIT) return out;
  const trunc = "\n… (list truncated)";
  return out.slice(0, Math.max(0, MESSAGE_LIMIT - trunc.length)) + trunc;
}

export interface PluginNotifyDeliverers {
  /** DM a single admin. */
  dmUser(userId: string, content: string): Promise<void>;
  /** Post to ANNOUNCE_CHANNEL_ID (the DM fallback). */
  postAnnounce(content: string): Promise<void>;
}

export interface PluginUpdateLog {
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

/**
 * DM each admin the notice; if ANY DM fails, fall back to the announce channel ONCE (not per admin,
 * and only as a fallback — a clean DM run never posts publicly). No admins → warn only. Returns true
 * if it reached someone, so the caller only records the version as notified after a real delivery.
 */
export async function deliverPluginNotification(
  message: string,
  adminUserIds: string[],
  deliverers: PluginNotifyDeliverers,
  log: PluginUpdateLog,
): Promise<boolean> {
  if (adminUserIds.length === 0) {
    log.warn("[plugins] a plugin update is available but ADMIN_USER_IDS is empty — no one to notify");
    return false;
  }
  let delivered = false;
  let anyDmFailed = false;
  for (const id of adminUserIds) {
    try {
      await deliverers.dmUser(id, message);
      delivered = true;
    } catch (err) {
      anyDmFailed = true;
      log.warn(`[plugins] couldn't DM admin ${id} about a plugin update — will try the announce channel`);
    }
  }
  if (anyDmFailed) {
    try {
      await deliverers.postAnnounce(message);
      delivered = true;
    } catch (err) {
      log.error("[plugins] channel fallback for a plugin update notice failed", err);
    }
  }
  return delivered;
}

export interface PluginUpdateDeps {
  /** Re-fetch the Plugin Index (writes the cache) and return it. */
  loadIndex: () => Promise<PluginIndex>;
  readState: () => Promise<PluginStateFile>;
  /** Race-safe read-modify-write of state.json — the ONLY runtime mutator of it. */
  mutateState: (mutate: (state: PluginStateFile) => PluginStateFile) => Promise<void>;
  deliverers: PluginNotifyDeliverers;
  adminUserIds: string[];
  hostApiVersion: number;
  now: () => Date;
  log: PluginUpdateLog;
}

// A version that fails to deliver retries next tick; give up after this many so a permanently
// undeliverable notice (e.g. every admin has DMs closed AND no announce channel) doesn't retry
// forever. In-memory on purpose — a restart is a fine reason to try again.
const MAX_DELIVERY_ATTEMPTS = 3;
const deliveryFailures = new Map<string, number>();

/** Test seam: clear the in-memory retry counters between cases. */
export function resetPluginUpdateStateForTest(): void {
  deliveryFailures.clear();
}

/** Record a version as notified: `notifiedVersion`/`availableVersion` = `to`, and clear any snooze
 *  (a fired remind must not re-fire every tick). */
function markNotified(state: PluginStateFile, name: string, to: string): PluginStateFile {
  return {
    ...state,
    plugins: state.plugins.map((p) =>
      p.name === name ? { ...p, notifiedVersion: to, availableVersion: to, remindAt: undefined } : p,
    ),
  };
}

/**
 * The scheduler tick body: re-fetch the index, decide, and for each notify/remind DM the admins with
 * the release notes — recording the version as notified ONLY after a successful delivery, so a failed
 * send retries next tick (capped at MAX_DELIVERY_ATTEMPTS). NEVER installs, restarts, or moves a pin.
 */
export async function checkPluginUpdates(deps: PluginUpdateDeps): Promise<void> {
  const index = await deps.loadIndex();
  const state = await deps.readState();
  const decisions = decidePluginUpdates(state, index, deps.hostApiVersion, deps.now());
  for (const d of decisions) {
    if (d.action === "none") continue; // already notified/skipped, or a snooze not yet due
    const message = notificationMessage(d, deps.hostApiVersion);
    const delivered = await deliverPluginNotification(message, deps.adminUserIds, deps.deliverers, deps.log);
    const key = `${d.name}@${d.to}`;
    if (delivered) {
      deliveryFailures.delete(key);
      await deps.mutateState((s) => markNotified(s, d.name, d.to));
    } else if (deps.adminUserIds.length > 0) {
      // A genuine delivery failure (not the no-admins case, which warned and will retry once admins
      // exist). Retry next tick, but cap it so an undeliverable notice stops eventually.
      const attempts = (deliveryFailures.get(key) ?? 0) + 1;
      deliveryFailures.set(key, attempts);
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        deps.log.error(
          `[plugins] gave up notifying about ${d.name} ${d.to} after ${attempts} attempts — recording it notified`,
        );
        deliveryFailures.delete(key);
        await deps.mutateState((s) => markNotified(s, d.name, d.to));
      }
    }
  }
}
