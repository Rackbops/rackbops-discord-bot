// The one way the bot tells its admins something: DM each, fall back to the announce channel ONCE when any DM
// failed, warn when there is no one to tell. Shared by the plugin update notice (src/plugins/updates.ts) and the
// failed-automatic-update notice (src/update.ts, wired in src/announce.ts) (#505). The log texts are passed in as
// whole sentences, so each caller keeps its own wording and none is spliced from a subject.

export interface AdminNoticeDeliverers {
  /** DM a single admin. */
  dmUser(userId: string, content: string): Promise<void>;
  /** Post to ANNOUNCE_CHANNEL_ID (the DM fallback). */
  postAnnounce(content: string): Promise<void>;
}

export interface AdminNoticeLog {
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface AdminNoticeTexts {
  /** Logged (warn) when `ADMIN_USER_IDS` is empty. */
  noAdmins: string;
  /** Logged (warn) when one admin's DM failed. */
  dmFailed: (userId: string, reason: string) => string;
  /** Logged (error) when the announce-channel fallback failed too. */
  fallbackFailed: string;
}

/**
 * DM each admin the notice; if ANY DM fails, fall back to the announce channel ONCE (not per admin, and only as a
 * fallback — a clean DM run never posts publicly). No admins → warn only. Returns true if it reached someone, so a
 * caller that records "notified" does so only after a real delivery.
 */
export async function deliverAdminNotice(
  message: string,
  adminUserIds: string[],
  deliverers: AdminNoticeDeliverers,
  log: AdminNoticeLog,
  texts: AdminNoticeTexts,
): Promise<boolean> {
  if (adminUserIds.length === 0) {
    log.warn(texts.noAdmins);
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
      log.warn(texts.dmFailed(id, err instanceof Error ? err.message : String(err)));
    }
  }
  if (anyDmFailed) {
    try {
      await deliverers.postAnnounce(message);
      delivered = true;
    } catch (err) {
      log.error(texts.fallbackFailed, err);
    }
  }
  return delivered;
}
