// Plugin update NOTIFICATIONS (#103) + the ACTIONS on them (#104). #103: tell admins, once per new
// version and with what changed, that a newer version of an installed plugin exists — the
// notification itself never installs, restarts, or moves a pin. #104 adds acting on that notice
// (`/plugins update|remind|skip|cancel`, scheduled execution, boot report-back): the pin moves and
// the bot restarts ONLY when an admin explicitly asks. #95's UX principle throughout: the operator's
// copy changes only when the operator says so. Pure decision + rendering, with two impure
// orchestrators (`checkPluginUpdates`, `reportPluginUpdateOutcome`) whose every side effect is an
// injected dep, so all of this unit-tests without a Discord Client. Deliberately imports nothing from
// restart/install — the restart hooks a scheduled update needs are injected.
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
    if (to === p.scheduled?.version) action = "none"; // already scheduled (#104) — don't keep nagging
    else if (to === p.skippedVersion) action = "none";
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
  const msg = `${head}${notes}\n${last}`;
  // Belt-and-suspenders (mirrors renderPluginsList): the budget keeps this within the cap for any
  // realistic input; a pathologically long plugin name (head + footer alone > cap) could still
  // overflow, so hard-cap rather than let Discord reject the send.
  return msg.length <= MESSAGE_LIMIT ? msg : msg.slice(0, MESSAGE_LIMIT);
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
      // A pending scheduled update (#104) — shown regardless of whether the index still lists that
      // version as current, so `/plugins cancel` has something visible to act on.
      if (p.scheduled) {
        line += `\n  ⏳ update to ${p.scheduled.version} scheduled <t:${Math.floor(Date.parse(p.scheduled.at) / 1000)}:R>`;
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

// ---- #104: acting on an update (/plugins update|remind|skip|cancel) ------------------------------
// Pure: parse the schedule time and plan the state mutation + reply for each action. The command
// handler (src/commands.ts) does the I/O (mutatePluginState, requestRestart, reply); these decide.

/** A Discord timestamp markup, so the admin sees their own local time. */
function discordTs(ms: number, style: "F" | "R" = "F"): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** A Discord user snowflake — 17-20 digits. #105's panel requests record `requestedBy` as a panel
 *  identity (`email:<addr>` / `token`), which is NOT DM-able; the heads-up + report-back DM sites use
 *  this to skip a futile `users.fetch(<email>)` and log the outcome instead (the panel actor sees the
 *  result on the panel's own refresh). */
export function isDiscordUserId(s: string): boolean {
  return /^\d{17,20}$/.test(s);
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Parse a schedule time. `HH:MM` is the next occurrence of that wall-clock time in **UTC** (today if
 * still ahead of `now`, else tomorrow — so it always resolves to a moment in the future). An ISO-8601
 * string that carries an offset (or `Z`) is taken as-is. Anything else — including a bare ISO string
 * with no offset, which would be ambiguous — is rejected with the two accepted forms.
 */
export function parseScheduleTime(input: string, now: Date): { at: Date } | { error: string } {
  const s = input.trim();
  const hhmm = HHMM_RE.exec(s);
  if (hhmm) {
    const [h, m] = [Number(hhmm[1]), Number(hhmm[2])];
    const at = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0, 0),
    );
    if (at.getTime() <= now.getTime()) at.setUTCDate(at.getUTCDate() + 1); // already passed → tomorrow (UTC)
    return { at };
  }
  // An ISO datetime is only unambiguous with an explicit offset or Z; require one.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:?\d{2}|Z)$/.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return { at: new Date(ms) };
  }
  return {
    error:
      "Couldn't read that time. Use **HH:MM** (24-hour, **UTC** — the next such time) " +
      "or a full ISO-8601 datetime with an offset, e.g. `2026-09-06T18:30-07:00`.",
  };
}

export type PluginAction =
  | { kind: "update"; at?: Date } // at omitted = now
  | { kind: "remind"; days: number }
  | { kind: "skip" }
  | { kind: "cancel" };

/** What the handler knows about the plugin when planning an action (from state + the fresh index). */
export interface PluginActionContext {
  name: string;
  installedVersion?: string;
  /** The index's current version, or undefined if the plugin isn't in the index. */
  latestVersion?: string;
  /** `latestVersion` runs on this bot's host API. */
  compatible: boolean;
  /** The host API `latestVersion` needs — for the incompatible wording. */
  neededHostApi: number;
  botHostApi: number;
  /** A pending update exists to cancel — a `scheduled` entry OR a `targetVersion` already set (a
   *  schedule that fired at its instant and set the pin before the cancel arrived). */
  hasPending: boolean;
  now: Date;
  requestedBy: string;
  channelId?: string;
}

export interface PluginActionResult {
  reply: string;
  /** The state mutation to apply, or absent for a refusal / no-op (nothing is written then). */
  mutate?: (s: PluginStateFile) => PluginStateFile;
  /** Set only for `update` NOW — the handler restarts (inside withCritical) after the reply lands. */
  restart?: { from: string; to: string };
}

/** True when the index offers a strictly-newer version than what's installed. */
function hasNewer(ctx: PluginActionContext): boolean {
  return (
    ctx.installedVersion !== undefined &&
    ctx.latestVersion !== undefined &&
    compareSemver(ctx.latestVersion, ctx.installedVersion) > 0
  );
}

/** Map over the plugins, replacing the named entry with `f(entry)`; other entries untouched. */
function updateEntry(
  s: PluginStateFile,
  name: string,
  f: (e: PluginStateEntry) => PluginStateEntry,
): PluginStateFile {
  return { ...s, plugins: s.plugins.map((p) => (p.name === name ? f(p) : p)) };
}

// ---- Version-parameterized state-mutation builders -------------------------------------------------
// The pure `(PluginStateFile) => PluginStateFile` builders behind each action. Extracted so BOTH the
// index-derived path (`planPluginAction`, called with `version = the index's latest`) and the
// explicit-pin path (the request mailbox #105, called with `version = the request's pinned version`)
// share one implementation — a request must be able to pin a version even if the index has since
// moved. Each is a plain function of the values it needs, no `ctx`/index.

/** Set the transient `targetVersion` (the next boot installs it) + the boot report-back. */
export function pinUpdateNow(
  name: string,
  version: string,
  report: NonNullable<PluginStateFile["pendingReport"]>,
): (s: PluginStateFile) => PluginStateFile {
  return (s) => ({ ...updateEntry(s, name, (e) => ({ ...e, targetVersion: version })), pendingReport: report });
}

/** Queue a scheduled update — the tick fires it at `at` (ISO-8601). */
export function scheduleUpdate(
  name: string,
  version: string,
  at: string,
  requestedBy: string,
): (s: PluginStateFile) => PluginStateFile {
  return (s) => updateEntry(s, name, (e) => ({ ...e, scheduled: { version, at, requestedBy } }));
}

/** Snooze the update reminder until `at` (ISO-8601). */
export function remindLater(name: string, at: string): (s: PluginStateFile) => PluginStateFile {
  return (s) => updateEntry(s, name, (e) => ({ ...e, remindAt: at }));
}

/** Skip `version` — no more notices until a newer version appears. */
export function skipVersion(name: string, version: string): (s: PluginStateFile) => PluginStateFile {
  return (s) => updateEntry(s, name, (e) => ({ ...e, skippedVersion: version }));
}

/** Drop any pending update — clears BOTH `scheduled` and `targetVersion` (the latter is set the
 *  instant a schedule fires, so a cancel that loses the fire-instant race would otherwise leave the
 *  pin queued), and this plugin's `pendingReport` (so a spurious latched restart doesn't report an
 *  update that won't happen). Next boot, with no `targetVersion`, the plugin stays on its installed
 *  version. */
export function cancelPending(name: string): (s: PluginStateFile) => PluginStateFile {
  return (s) => {
    const cleared = updateEntry(s, name, (e) => {
      const next = { ...e };
      delete next.scheduled;
      delete next.targetVersion;
      return next;
    });
    if (cleared.pendingReport?.plugin === name) {
      const next = { ...cleared };
      delete next.pendingReport;
      return next;
    }
    return cleared;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Plan one `/plugins` action: a refusal (no `mutate`, explaining why) or a success (the `mutate` to
 * persist + the reply, and for `update` now the `restart` marker). NEVER performs I/O. `update`/
 * `remind`/`skip` require a strictly-newer version; `update` also requires compatibility; `cancel`
 * always works. The target version is the INDEX's latest (`ctx.latestVersion`); the request mailbox
 * (#105) instead calls the builders above directly with the request's explicit pinned version.
 */
export function planPluginAction(action: PluginAction, ctx: PluginActionContext): PluginActionResult {
  const { name } = ctx;

  if (action.kind === "cancel") {
    if (!ctx.hasPending) return { reply: `**${name}** has no scheduled update.` };
    return { reply: `Cancelled the pending update for **${name}**.`, mutate: cancelPending(name) };
  }

  // update / remind / skip all need a newer version to act on.
  if (!hasNewer(ctx)) {
    return { reply: `**${name}** is already on the latest version (${ctx.installedVersion ?? "?"}).` };
  }
  const from = ctx.installedVersion!;
  const to = ctx.latestVersion!;

  if (action.kind === "skip") {
    return {
      reply: `Skipping **${name}** ${to} — I won't mention it again until a newer version appears.`,
      mutate: skipVersion(name, to),
    };
  }

  if (action.kind === "remind") {
    const at = ctx.now.getTime() + action.days * DAY_MS;
    return {
      reply: `Okay — I'll remind you about **${name}** ${to} ${discordTs(at)} (${discordTs(at, "R")}).`,
      mutate: remindLater(name, new Date(at).toISOString()),
    };
  }

  // action.kind === "update"
  if (!ctx.compatible) {
    return {
      reply: `**${name}** ${to} needs a newer bot (host API v${ctx.neededHostApi}, this bot is v${ctx.botHostApi}) — update the bot first.`,
    };
  }
  if (action.at) {
    return {
      reply: `Scheduled **${name}** ${to} for ${discordTs(action.at.getTime())} (${discordTs(action.at.getTime(), "R")}).`,
      mutate: scheduleUpdate(name, to, action.at.toISOString(), ctx.requestedBy),
    };
  }
  // update now: set the transient targetVersion + the boot report-back, then the handler restarts.
  const report: PluginStateFile["pendingReport"] = {
    plugin: name,
    toVersion: to,
    userId: ctx.requestedBy,
    channelId: ctx.channelId,
    requestedAt: ctx.now.getTime(),
  };
  return {
    reply: `Updating **${name}** ${from} → ${to} now — restarting, back in a moment.`,
    restart: { from, to },
    mutate: pinUpdateNow(name, to, report),
  };
}

// ---- #104: report-back on the boot after an update ----------------------------------------------

/** Decide the boot report-back message for a completed (or failed) update, from the freshly-written
 *  state entry. Success when the plugin actually came up on the target; else one of two failures. */
export function decidePluginReportOutcome(
  report: NonNullable<PluginStateFile["pendingReport"]>,
  entry: PluginStateEntry | undefined,
): { ok: boolean; message: string } {
  const to = report.toVersion;
  const name = report.plugin;
  const installed = entry?.installedVersion;
  if (entry && installed === to && entry.active) {
    return { ok: true, message: `✅ **${name}** is now ${to}.` };
  }
  const why = entry?.error ? ` (${entry.error})` : "";
  if (installed !== undefined && installed !== to) {
    // Reverted: the target failed to install, so the previous version was reused (from cache).
    return { ok: false, message: `⚠️ **${name}** could not be updated to ${to}${why} — still on ${installed}.` };
  }
  // Installed the target but activate() threw (or no installed version at all).
  return { ok: false, message: `⚠️ **${name}** updated to ${to} but failed to start${why}.` };
}

export interface PluginNotifyDeliverers {
  /** DM a single admin. */
  dmUser(userId: string, content: string): Promise<void>;
  /** Post to ANNOUNCE_CHANNEL_ID (the DM fallback). */
  postAnnounce(content: string): Promise<void>;
}

export interface PluginUpdateLog {
  info(message: string): void;
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
  // #104 — running a due scheduled update. Injected (updates.ts imports nothing from restart.ts), so
  // the "never restarts without a due schedule" property stays unit-testable with fakes.
  /** True while an exit or handoff is already in flight — a due schedule then defers to the next tick. */
  restartPending: () => boolean;
  /** Ask the process to exit (exit 75) so the orchestrator respawns it into the new pin. */
  requestRestart: (reason: string) => void;
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
 * The scheduler tick body. First the NOTIFICATION pass (#103): re-fetch the index, decide, and for
 * each notify/remind DM the admins the release notes — recording the version as notified ONLY after a
 * successful delivery, so a failed send retries next tick (capped at MAX_DELIVERY_ATTEMPTS). This pass
 * never installs, restarts, or moves a pin. THEN `runDueSchedules` (#104): if an admin scheduled an
 * update whose time has come, it moves the pin (`targetVersion`) and restarts — the one place this
 * tick acts on an update, and only because an admin explicitly asked it to.
 */
export async function checkPluginUpdates(deps: PluginUpdateDeps): Promise<void> {
  const index = await deps.loadIndex();
  const state = await deps.readState();
  const decisions = decidePluginUpdates(state, index, deps.hostApiVersion, deps.now());
  for (const d of decisions) {
    if (d.action === "none") continue; // already notified/skipped/scheduled, or a snooze not yet due
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
  await runDueSchedules(deps);
}

/**
 * #104: run at most ONE due scheduled update per tick (a restart ends the process, so a second due
 * schedule waits for the next boot). The serialized `mutateState` is the sole arbiter of "did this
 * fire" — a concurrent `/plugins cancel` that clears the schedule inside the same per-path queue
 * makes `acted` stay false, so the tick never restarts onto a cancelled update. The heads-up DM is
 * best-effort (the boot report is the authoritative outcome); the actual exit is deferred by the
 * tick's own `withCritical` (announce.ts) until the DM + the state write have settled.
 */
async function runDueSchedules(deps: PluginUpdateDeps): Promise<void> {
  if (deps.restartPending()) return; // an earlier restart (e.g. autoUpdate) already won this tick
  const state = await deps.readState();
  const now = deps.now();
  for (const p of state.plugins) {
    const sched = p.scheduled;
    if (!sched || now.getTime() < Date.parse(sched.at)) continue;

    const to = sched.version;
    const from = p.installedVersion;
    let acted = false;
    await deps.mutateState((s) => {
      const cur = s.plugins.find((x) => x.name === p.name);
      // Re-check inside the serialized turn: a cancel that landed since the read wins.
      if (!cur?.scheduled || now.getTime() < Date.parse(cur.scheduled.at) || cur.scheduled.version !== to) {
        return s;
      }
      acted = true;
      const report: PluginStateFile["pendingReport"] = {
        plugin: p.name,
        toVersion: to,
        userId: cur.scheduled.requestedBy,
        channelId: undefined,
        requestedAt: now.getTime(),
      };
      const plugins = s.plugins.map((x) => {
        if (x.name !== p.name) return x;
        const next = { ...x, targetVersion: to };
        delete next.scheduled;
        return next;
      });
      return { ...s, plugins, pendingReport: report };
    });
    if (!acted) continue; // cancelled out from under us — leave it, try the next plugin

    // A panel-origin schedule's requestedBy is an identity string, not a DM-able snowflake — skip the
    // futile fetch (the panel actor sees the result on refresh); a Discord requester gets the heads-up.
    if (isDiscordUserId(sched.requestedBy)) {
      try {
        await deps.deliverers.dmUser(
          sched.requestedBy,
          `Updating **${p.name}** ${from ?? "?"} → ${to} now, as scheduled — restarting, back in a moment.`,
        );
      } catch {
        /* a closed DM must not abort the update — the boot report is authoritative */
      }
    }
    deps.requestRestart(`plugin update (scheduled): ${p.name} ${from ?? "?"} → ${to}`);
    return; // one restart per tick
  }
}

export interface PluginReportDeps {
  readState: () => Promise<PluginStateFile>;
  /** The shared race-safe state.json mutator — the pluginUpdates tick can be live concurrently. */
  mutateState: (mutate: (s: PluginStateFile) => PluginStateFile) => Promise<void>;
  dmUser: (userId: string, content: string) => Promise<void>;
  /** Post to the channel the update was requested from (the DM fallback), pinging the requester. */
  postChannel: (channelId: string, userId: string, content: string) => Promise<void>;
  log: PluginUpdateLog;
}

/**
 * #104: the boot after an update, tell the requester what actually came up. Runs after
 * `writePluginState` (so the state entry reflects this boot's install/activate) and is fire-and-forget
 * from `index.ts`. Clears `pendingReport` — through the shared mutator, and BEFORE delivering — so a
 * failed send can't re-fire the report every boot (the `reportUpdateOutcome` rule). DM → channel.
 */
export async function reportPluginUpdateOutcome(deps: PluginReportDeps): Promise<void> {
  const state = await deps.readState();
  const report = state.pendingReport;
  if (!report) return;
  await deps.mutateState((s) => {
    const next = { ...s };
    delete next.pendingReport;
    return next;
  });
  const entry = state.plugins.find((p) => p.name === report.plugin);
  const { message } = decidePluginReportOutcome(report, entry);
  // A panel-origin request's requestedBy is a panel identity, not a DM-able snowflake — there's no
  // Discord user to tell; log the outcome (the panel actor reads it back from /api/plugins).
  if (!isDiscordUserId(report.userId)) {
    deps.log.info(`[plugins] update report-back (panel request by ${report.userId}): ${message}`);
    return;
  }
  try {
    await deps.dmUser(report.userId, message);
  } catch {
    if (report.channelId) {
      try {
        await deps.postChannel(report.channelId, report.userId, message);
      } catch (err) {
        deps.log.error("[plugins] update report-back: DM and channel delivery both failed", err);
      }
    } else {
      deps.log.warn("[plugins] update report-back: DM failed and there's no channel to fall back to");
    }
  }
}
