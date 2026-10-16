import { REST, Routes, type Client } from "discord.js";
import { config } from "./config";
import { state, saveState, type PendingUpdateReport } from "./state";
import { sameSha, type AttemptResolution } from "./update";
import { prefixedName } from "./commandNaming";
import { sendToChannel } from "./announce";
import { shortSha as short } from "./storage";
import { withoutRequest } from "./plugins/delivery";

// The other half of /update: the command says what it's *trying* to become, this says what it
// actually became. Without it the dangerous failure — a container recreated without --build,
// which comes back on the old image and logs a perfectly clean startup — is indistinguishable
// from a successful update.

/** Interaction tokens are valid ~15 min; a restart is normally far inside that. */
const TOKEN_TTL_MS = 15 * 60 * 1000;

/** Past this, the restart is ancient history (a box that was down for days) — log, don't message. */
const MAX_REPORT_AGE_MS = 24 * 60 * 60 * 1000;

/** Ephemeral, matching the /update reply this follows up on. */
const EPHEMERAL = 1 << 6;

export type UpdateOutcome =
  /** Came back on the sha we exited for — the update landed. */
  | "updated"
  /** Came back on the sha we left on — the image was never rebuilt. */
  | "noop"
  /** Came back on the sha we left on because the process restarted before the new build took over (#450). */
  | "interrupted"
  /** Came back on the sha we left on because the update landed and the operator rolled it back (#558). */
  | "rolled-back"
  /** Came back on some third sha — neither the build we left nor the one we were picking up (someone deployed in between, or an automatic update landed). */
  | "unexpected"
  /** Came back without a GIT_SHA baked in — nothing to compare. */
  | "unknown";

/** `report.rolledBack` and `report.interrupted` are boots' verdicts (`resolveUpdateAttempt`, #558 and #450), saved with
 *  the report; a rollback wins, since a rolled-back swap did land first. */
export function decideUpdateOutcome(o: { report: PendingUpdateReport; runningSha?: string }): UpdateOutcome {
  if (!o.runningSha) return "unknown";
  if (sameSha(o.runningSha, o.report.toSha)) return "updated";
  if (sameSha(o.runningSha, o.report.fromSha)) return o.report.rolledBack ? "rolled-back" : o.report.interrupted ? "interrupted" : "noop";
  return "unexpected";
}

/** Names both shas, so nobody has to compare them by eye to learn which case this is. */
export function updateOutcomeMessage(
  outcome: UpdateOutcome,
  report: PendingUpdateReport,
  runningSha?: string,
): string {
  const now = runningSha ? short(runningSha) : "unknown";
  switch (outcome) {
    case "updated":
      return `✅ Back up on \`${now}\` — updated from \`${short(report.fromSha)}\`.`;
    case "noop":
      return (
        `⚠️ Back up on \`${now}\` — the **same build** I left on. ` +
        `\`${short(report.toSha)}\` was not picked up: the image wasn't rebuilt. ` +
        "Redeploy with `--build` (see the README)."
      );
    case "interrupted":
      return (
        `⚠️ Back up on \`${now}\` — the update to \`${short(report.toSha)}\` did not take: this process is back on ` +
        "the build it left on (it restarted before the new build had taken over). " +
        `Run /${prefixedName(config.commandPrefix, "update")} again.`
      );
    case "rolled-back":
      return (
        `⚠️ Back up on \`${now}\` — the update to \`${short(report.toSha)}\` landed and was then rolled back (the new build was stopped and this one started again). ` +
        `Automatic updates skip \`${short(report.toSha)}\` until a newer commit lands; run /${prefixedName(config.commandPrefix, "update")} to apply it anyway.`
      );
    case "unexpected":
      return (
        `❓ Back up on \`${now}\`, which is neither the build I left on ` +
        `(\`${short(report.fromSha)}\`) nor the one I was picking up ` +
        `(\`${short(report.toSha)}\`) — something else deployed in between (an automatic update, or a redeploy by hand).`
      );
    case "unknown":
      return (
        `❓ Back up, but with no \`GIT_SHA\` baked in — I can't tell whether ` +
        `\`${short(report.toSha)}\` was picked up. Rebuild with \`GIT_SHA\` to restore this check.`
      );
  }
}

/** Whether the stored interaction token is still inside its validity window. */
export function tokenUsable(report: PendingUpdateReport, now: number): boolean {
  if (!report.interactionToken || !report.applicationId) return false;
  return now - report.requestedAt < TOKEN_TTL_MS;
}

export function reportTooOld(report: PendingUpdateReport, now: number): boolean {
  return now - report.requestedAt >= MAX_REPORT_AGE_MS;
}

export type DeliveryRoute = "token" | "dm" | "channel" | "none";

export interface Deliverers {
  viaToken(report: PendingUpdateReport, content: string): Promise<void>;
  viaDm(report: PendingUpdateReport, content: string): Promise<void>;
  viaChannel(report: PendingUpdateReport, content: string): Promise<void>;
}

/**
 * Interaction follow-up first (it lands where the command was run), then a DM, then the
 * channel. Every route may legitimately be gone — an expired token, closed DMs, a deleted
 * channel — so each failure is logged and falls through rather than propagating.
 */
export async function deliverUpdateReport(
  report: PendingUpdateReport,
  content: string,
  deliverers: Deliverers,
  now: number,
): Promise<DeliveryRoute> {
  const routes: [DeliveryRoute, () => Promise<void>][] = [];
  if (tokenUsable(report, now)) routes.push(["token", () => deliverers.viaToken(report, content)]);
  routes.push(["dm", () => deliverers.viaDm(report, content)]);
  if (report.channelId) routes.push(["channel", () => deliverers.viaChannel(report, content)]);

  for (const [route, send] of routes) {
    try {
      await send();
      return route;
    } catch (err) {
      // #545: the `token` route posts to `/webhooks/<app>/<interaction token>`, so a REST error from it
      // carries the /update requester's token in `url`; withoutRequest keeps code/status/method.
      console.warn(`[updateReport] ${route} delivery failed`, withoutRequest(err));
    }
  }
  return "none";
}

export function liveDeliverers(client: Client): Deliverers {
  return {
    // The follow-up webhook route is authenticated by the interaction token itself, so this
    // posts unauthenticated. discord.js's WebhookClient can't set the ephemeral flag.
    //
    // This bypasses `Client` entirely (a raw REST call, not `client.channels`/`client.users`), so
    // it never sees the Client-level `allowedMentions: { parse: [] }` default (#48) — set it here
    // too. `content` is always bot-generated (updateOutcomeMessage's sha-based text) so nothing
    // here can currently be pinged, but this is the one send path outside the Client's reach, and
    // the whole point of the client-wide default was that no call site should have to remember to
    // opt in to *safety*.
    async viaToken(report, content) {
      await new REST().post(
        Routes.webhook(report.applicationId!, report.interactionToken!) as `/${string}`,
        { body: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } }, auth: false },
      );
    },
    async viaDm(report, content) {
      const user = await client.users.fetch(report.userId);
      await user.send(content);
    },
    async viaChannel(report, content) {
      // The client default is allowedMentions: { parse: [] } (#48), so the ping here needs an
      // explicit opt-in — report.userId is trusted (it's who requested the /update, not
      // arbitrary text), unlike the content this is prefixed onto.
      await sendToChannel(client, report.channelId!, `<@${report.userId}> ${content}`, {
        allowedMentions: { users: [report.userId] },
      });
    },
  };
}

/** The report owed right now, or `null`: what `index.ts` remembers when it resolves the swap record at boot. */
export function owedReportNow(): PendingUpdateReport | null {
  return state.pendingUpdateReport ?? null;
}

/**
 * Deliver the follow-up owed from a `/update`-initiated restart, if any. `resolution` is what this boot made of the
 * swap record (`resolveUpdateAttempt`, #450): `in-flight` leaves the report in place for the new build, which is
 * about to retire this process and has the same report in its own snapshot (or for this container's next boot, when
 * the probe could not tell). An `interrupted` swap needs nothing passed here: that boot marked the report itself
 * (`report.interrupted`), which `decideUpdateOutcome` reads, so the truthful outcome also survives a boot that died
 * between resolving and delivering. `owed` is the report the boot saw when it resolved the record (`index.ts` takes it
 * there, before the interaction handler attaches); a different one is a `/update` this process took since, and is left
 * for its own restart. The default, the report owed at call time, is for a caller that has no such moment.
 *
 * The marker is cleared and persisted *before* delivery is attempted: a delivery that fails must not leave a report
 * that re-fires on every subsequent boot. A save that fails is logged and delivery goes ahead anyway (#506 item 12:
 * one report beats none, at the cost of at most one repeat at the next boot). Nothing here throws.
 */
export async function reportUpdateOutcome(
  client: Client,
  resolution: AttemptResolution = "none",
  deliverers: Deliverers = liveDeliverers(client),
  owed: PendingUpdateReport | null = owedReportNow(),
): Promise<void> {
  const report = state.pendingUpdateReport;
  if (!report) return;
  // Only the report the boot saw (`owed`, taken where the swap record was resolved) is owed to anyone yet. One armed
  // since — by a `/update` this process took while it finished starting — describes a restart still in progress: sending
  // it now would say "the image wasn't rebuilt" to a requester whose build is running, and clear the report the
  // replacement is about to deliver as "updated".
  if (report !== owed) {
    console.log(`[updateReport] a report for ${short(report.toSha)} was armed since this boot began — its restart reports it`);
    return;
  }
  const now = Date.now();
  // Age first, then the in-flight hold: a report a boot keeps leaving for "the new build or the next boot" (a probe
  // that stays unknown) must still die at 24 h, or it would survive every boot for good.
  const tooOld = reportTooOld(report, now);
  if (resolution === "in-flight" && !tooOld) {
    console.log(`[updateReport] a swap to ${short(report.toSha)} may be in flight — leaving its report to the new build or the next boot`);
    return;
  }

  state.pendingUpdateReport = undefined;
  try {
    await saveState();
  } catch (err) {
    console.warn("[updateReport] could not clear the pending report before delivering it (it may repeat once at the next boot)", err);
  }

  if (tooOld) {
    console.log(
      `[updateReport] dropping a stale report for ${short(report.toSha)} ` +
        `(requested ${Math.round((now - report.requestedAt) / 3_600_000)}h ago)`,
    );
    return;
  }

  const outcome = decideUpdateOutcome({ report, runningSha: config.gitSha });
  const content = updateOutcomeMessage(outcome, report, config.gitSha);
  const route = await deliverUpdateReport(report, content, deliverers, now);
  console.log(`[updateReport] ${outcome} (delivered via ${route}): ${content}`);
}
