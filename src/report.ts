import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { config, repoForProject } from "./config";
import { prefixedName } from "./commandNaming";
import { clampReply, createIssue, ensureLabel, sliceUtf16 } from "./github";

const REPORT_LABEL = "automated";
const MODAL_PREFIX = "report:"; // modal customId = report:<project>

/** Issue body: the reporter's text plus a traceability footer naming the Discord user by
 * plain username (never a pingable mention) and `command`, the registered name the report was
 * filed through (`COMMAND_PREFIX` included, e.g. `pipreport`). Pure — unit-tested. */
export function reportBody(description: string, username: string, command: string): string {
  return `${description}\n\n---\n_Filed from Discord via \`/${command}\` by **${username}**._`;
}

// Discord's hard cap on a message's content. The modal's Description field is unbounded, so a
// long report has to be clamped rather than rejected at send time (nazumods/wow#870).
const MESSAGE_LIMIT = 2000;
const TRUNCATED = "\n… (truncated — the issue has the rest)";

/** The channel-visible confirmation: who filed what, where it landed, and the report itself.
 * Pure — unit-tested. */
export function reportAnnouncement(o: {
  repo: string;
  number: number;
  url: string;
  title: string;
  description: string;
  username: string;
}): string {
  const head = `📋 **${o.username}** filed **${o.repo}#${o.number}** — ${o.url}\n**${o.title}**\n`;
  const room = MESSAGE_LIMIT - head.length;
  if (o.description.length <= room) return head + o.description;
  // sliceUtf16, not slice (#445): a cut inside an emoji must not leave a lone high surrogate in a public message.
  return head + sliceUtf16(o.description, Math.max(0, room - TRUNCATED.length)) + TRUNCATED;
}

/** Does the interacting member hold the configured REPORT_ROLE_ID? Reads roles straight from
 * the interaction payload (no privileged Members intent), handling both a cached role manager
 * and the raw string[] of an uncached member. Reached from the command and, since #448, from the
 * modal submit; no `member` (a DM) holds no role. */
function hasReportRole(interaction: {
  member: ChatInputCommandInteraction["member"] | ModalSubmitInteraction["member"];
}): boolean {
  if (!config.reportRoleId) return false;
  const roles = interaction.member?.roles;
  if (!roles) return false;
  return Array.isArray(roles)
    ? roles.includes(config.reportRoleId)
    : roles.cache.has(config.reportRoleId);
}

/** Is this modal submission one of ours? */
export function isReportModal(customId: string): boolean {
  return customId.startsWith(MODAL_PREFIX);
}

/** `/report project:<..>` → gate on config + role, then pop the Title/Description modal. The
 *  not-configured refusal names `interaction.commandName`, the name the user typed (`/pipreport`
 *  under `COMMAND_PREFIX=pip`), not a bare `/report` that doesn't exist on a prefixed instance. */
export async function handleReportCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!config.reportRoleId || !config.githubToken) {
    await interaction.reply({
      content: `\`/${interaction.commandName}\` isn't configured — an admin must set \`REPORT_ROLE_ID\` and \`GITHUB_TOKEN\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!hasReportRole(interaction)) {
    await interaction.reply({
      content: "You don't have the role required to file reports.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const project = interaction.options.getString("project", true);
  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${project}`)
    .setTitle(`Report an issue — ${project}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Title")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(120)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("What happened? Steps, expected vs actual")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

/**
 * Modal submit → re-check the gate, create the GitHub issue in the mapped repo, then say so **in the
 * channel the report was filed from** (nazumods/wow#870).
 *
 * The outcome is deliberately not ephemeral: the point is transparency about what's been
 * reported, so the confirmation is the announcement. The refusals stay private, since a
 * missing role or an unconfigured bot is the reporter's own business and not an issue anyone
 * else needs to see.
 *
 * `allowedMentions: { parse: [] }` because the description is now free text on its way into a
 * public message — an `@everyone` typed into the modal must render as text, not fire.
 *
 * The gate runs again here (#448), before `deferReply` and before any network call: the same
 * configuration and role checks as `handleReportCommand`, refusing ephemerally. The command's gate is the
 * user-facing one; this is defence in depth, because this code cannot verify that Discord scopes a modal
 * submission to the interaction that showed it (CONTEXT.md already says a forged `modal_submit` can carry any
 * `customId`), and whether a roleless account can actually forge one is left unverified. It also closes what
 * used to be an accepted race, a role revoked between showing the modal and submitting it. The project fence
 * stays first: it is what makes the project safe to log.
 *
 * Three steps, three outcomes (#445, #503):
 *  1. The label is best-effort. `ensureLabel` never throws; when it cannot confirm the label the issue is
 *     filed without it, and the log says so.
 *  2. The issue. Only a failure HERE says "Couldn't file the issue": nothing was filed.
 *  3. The announcement. The issue exists whatever happens in this step, so a failure here is logged and falls
 *     back to a minimal public edit naming the issue; if that fails too it is logged at error level and nothing
 *     else is attempted (the deferred reply expires; the issue exists, and the log says so).
 *
 * Every refusal and failure writes one `[report]` line (#503 item 11, the `/report` half) — except the
 * unknown-project refusal, whose project string is attacker-controlled until `repoForProject` has accepted it.
 * None carries the title, the description or the username; the user id and a known project key are all that
 * identify the submit. The create-issue message is clamped to 300 characters for the log (the public reply
 * keeps `clampReply`'s default).
 *
 * A modal submit carries no `commandName`, so the command name — the issue footer's and the not-configured
 * refusal's — is built from `config.commandPrefix`, the same prefix `/report` was registered under, read at
 * submit time.
 */
export async function handleReportModal(interaction: ModalSubmitInteraction): Promise<void> {
  const project = interaction.customId.slice(MODAL_PREFIX.length);
  const repo = repoForProject(project);
  if (!repo) {
    await interaction.reply({ content: `Unknown project \`${project}\`.`, flags: MessageFlags.Ephemeral });
    return;
  }

  // #448: the same gate as the command, as defence in depth. Before deferReply and before any network call;
  // ephemeral, like the command's refusals.
  const command = prefixedName(config.commandPrefix, "report");
  if (!config.reportRoleId || !config.githubToken) {
    console.warn(`[report] refused a modal submit for ${project} from ${interaction.user.id}: not configured`);
    await interaction.reply({
      content: `\`/${command}\` isn't configured — an admin must set \`REPORT_ROLE_ID\` and \`GITHUB_TOKEN\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!hasReportRole(interaction)) {
    console.warn(`[report] refused a modal submit for ${project} from ${interaction.user.id}: no report role`);
    await interaction.reply({
      content: "You don't have the role required to file reports.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const title = interaction.fields.getTextInputValue("title");
  const description = interaction.fields.getTextInputValue("description");
  const username = interaction.user.username;
  await interaction.deferReply();
  // Step 1 of 3 (#445, #503): the label is best-effort; without it the issue is filed unlabelled.
  const labelled = await ensureLabel(repo, REPORT_LABEL);
  if (!labelled) console.warn(`[report] filing in ${repo} without the ${REPORT_LABEL} label (could not be confirmed)`);
  // Step 2: the issue. Only a failure HERE means the report was not filed.
  let issue: { number: number; url: string };
  try {
    const body = reportBody(description, username, command);
    issue = await createIssue(repo, title, body, labelled ? [REPORT_LABEL] : []);
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[report] could not file an issue in ${repo}: ${clampReply(message, 300)}`);
    await interaction.editReply({
      content: clampReply(`⚠️ Couldn't file the issue: ${message}`),
      allowedMentions: { parse: [] },
    });
    return;
  }
  // Step 3: the announcement. The issue exists whatever happens here, so a failure must never say it does not.
  try {
    await interaction.editReply({
      content: reportAnnouncement({ repo, number: issue.number, url: issue.url, title, description, username }),
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.warn(`[report] filed ${repo}#${issue.number} but the announcement edit failed: ${(err as Error).message}`);
    await interaction
      .editReply({
        content: clampReply(`📋 **${username}** filed **${repo}#${issue.number}** — ${issue.url}`),
        allowedMentions: { parse: [] },
      })
      .catch((again: unknown) =>
        console.error(`[report] the fallback edit for ${repo}#${issue.number} failed too: ${(again as Error).message}`),
      );
  }
}
