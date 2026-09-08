import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { config, REPORT_PROJECTS } from "./config";
import { handleReportCommand } from "./report";
import { checkForUpdate, type DisabledReason, type UpdateDecision } from "./update";
import { withCritical, requestRestart } from "./restart";
import { handoffFailureMessage } from "./handoff";
import type { RedeployResult } from "./redeploy";
import { DATA_DIR, readJsonOrFresh } from "./storage";
import { commandNamer } from "./commandNaming";
import { isPluginStateReady } from "./announce";
import { loadPluginIndex } from "./plugins";
import { mutatePluginState } from "./plugins/host";
import {
  renderPluginsList,
  parseScheduleTime,
  planPluginAction,
  type PluginAction,
  type PluginActionResult,
} from "./plugins/updates";
import { HOST_API_VERSION, type PluginCommand, type PluginStateFile } from "./plugins/contract";

/**
 * /update is gated on an explicit Discord user-ID allowlist rather than a guild role:
 * roles get reassigned and inherited, an ID list only changes when the operator edits
 * the env. An empty list fails closed.
 */
export function isAdmin(userId: string, adminUserIds: string[]): boolean {
  return adminUserIds.includes(userId);
}

// COMMAND_PREFIX namespaces the command names (e.g. `r_` → `r_report`) so a second debug/staging
// bot can coexist in the same server. Empty by default → plain `report`/`update`/`plugins`.
const prefix = config.commandPrefix;

/** Start a command under the configured prefix. Build every command with this — a hand-written
 *  `new SlashCommandBuilder().setName("foo")` registers outside the namespace. */
const cmd = commandNamer(prefix);

/**
 * The command name with COMMAND_PREFIX stripped, so dispatch reads the same whether or not a
 * prefix is configured. Tolerates an already-bare name: a command registered without `cmd()`
 * still dispatches, rather than being silently mangled into a name that matches no case.
 */
export function bareName(commandName: string, p: string = prefix): string {
  return commandName.startsWith(p) ? commandName.slice(p.length) : commandName;
}

export const commandData: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  cmd("report")
    .setDescription("File a GitHub issue for a project")
    .addStringOption((o) =>
      o
        .setName("project")
        .setDescription("Which project the report is about")
        .setRequired(true)
        .addChoices(...Object.keys(REPORT_PROJECTS).map((k) => ({ name: k, value: k }))),
    ),
  cmd("update")
    .setDescription("Restart the bot to pick up the latest build (admins only)")
    // Hides it from non-admins in the UI. Defence in depth — the ID allowlist is the gate.
    .setDefaultMemberPermissions(0),
  cmd("plugins")
    .setDescription("Installed plugins and available updates (admins only)")
    .setDefaultMemberPermissions(0)
    .addSubcommand((s) => s.setName("list").setDescription("List installed plugins and any available updates"))
    .addSubcommand((s) =>
      s
        .setName("update")
        .setDescription("Update a plugin now, or schedule it for a time")
        .addStringOption((o) => o.setName("name").setDescription("Plugin name").setRequired(true))
        .addStringOption((o) =>
          o.setName("at").setDescription("When: HH:MM (24h, UTC) or ISO-8601 with offset. Omit = now"),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("remind")
        .setDescription("Snooze the update reminder for a plugin")
        .addStringOption((o) => o.setName("name").setDescription("Plugin name").setRequired(true))
        .addIntegerOption((o) =>
          o.setName("days").setDescription("Days to snooze (default 7)").setMinValue(1).setMaxValue(365),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("skip")
        .setDescription("Skip this version — no reminders until a newer one appears")
        .addStringOption((o) => o.setName("name").setDescription("Plugin name").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("cancel")
        .setDescription("Cancel a plugin's scheduled update")
        .addStringOption((o) => o.setName("name").setDescription("Plugin name").setRequired(true)),
    ),
].map((c) => c.toJSON());

// What selectPlugins() checks a plugin's declared command names against before any plugin loads.
export const CORE_COMMAND_NAMES: string[] = commandData.map((c) => bareName(c.name));

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  lookup: (bare: string) => PluginCommand | undefined = () => undefined,
): Promise<void> {
  const bare = bareName(interaction.commandName);
  switch (bare) {
    case "update": {
      if (!isAdmin(interaction.user.id, config.adminUserIds)) {
        await interaction.reply({
          content: config.adminUserIds.length
            ? "⛔ You're not allowed to run this."
            : "⛔ No admins are configured — set `ADMIN_USER_IDS` to enable `/update`.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Inside a critical section so the restart waits for the reply to be delivered.
      await withCritical(async () => {
        try {
          const { decision, latestSha, reason, redeploy } = await checkForUpdate({
            force: true,
            // Recorded so the next boot can report back what build it actually landed on.
            requester: {
              userId: interaction.user.id,
              channelId: interaction.channelId ?? undefined,
              applicationId: interaction.applicationId,
              interactionToken: interaction.token,
            },
          });
          await interaction.editReply(
            updateReply(decision, latestSha, { runningSha: config.gitSha, reason, redeploy }),
          );
        } catch (err) {
          await interaction.editReply(`⚠️ Update check failed: ${(err as Error).message}`);
        }
      });
      return;
    }
    case "report": {
      await handleReportCommand(interaction);
      return;
    }
    case "plugins": {
      if (!isAdmin(interaction.user.id, config.adminUserIds)) {
        await interaction.reply({
          content: config.adminUserIds.length
            ? "⛔ You're not allowed to run this."
            : "⛔ No admins are configured — set `ADMIN_USER_IDS` to enable `/plugins`.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const sub = interaction.options.getSubcommand();
      if (sub === "list") {
        // Deferred: re-fetching the Plugin Index (for "available" + notes) can outrun the 3s window.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const [{ index }, state] = await Promise.all([
            loadPluginIndex(config.pluginIndexUrl, DATA_DIR),
            // Read state.json directly (not via host.ts's readPluginState) to avoid a commands↔host
            // import cycle — the path mirrors host.ts's statePath.
            readJsonOrFresh<PluginStateFile>(
              `${DATA_DIR}/plugins/state.json`,
              () => ({ hostApiVersion: HOST_API_VERSION, writtenAt: "", plugins: [] }),
              "plugins",
            ),
          ]);
          await interaction.editReply(renderPluginsList(state, index, new Date()));
        } catch (err) {
          // Match the /update deferred convention: a failure edits the deferred reply with an
          // error rather than leaving the admin's "thinking…" hanging.
          await interaction.editReply(`⚠️ Couldn't list plugins: ${(err as Error).message}`);
        }
        return;
      }
      // #104: update | remind | skip | cancel — all read the index + state, validate, then mutate the
      // shared state.json (host.ts's single race-safe mutator). Refuse until the boot state.json write
      // has landed, so a command firing in the startup window (the gateway is up + this listener live
      // before that one-time whole-file write) can't race it — the update tick is gated the same way.
      if (!isPluginStateReady()) {
        await interaction.reply({
          content: "⏳ The bot is still starting up — try that again in a moment.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const [{ index }, state] = await Promise.all([
          loadPluginIndex(config.pluginIndexUrl, DATA_DIR),
          readJsonOrFresh<PluginStateFile>(
            `${DATA_DIR}/plugins/state.json`,
            () => ({ hostApiVersion: HOST_API_VERSION, writtenAt: "", plugins: [] }),
            "plugins",
          ),
        ]);
        const name = interaction.options.getString("name", true);
        const stateEntry = state.plugins.find((p) => p.name === name);
        if (!stateEntry?.installedVersion) {
          await interaction.editReply(`⚠️ **${name}** isn't an installed plugin. See \`/plugins list\`.`);
          return;
        }
        const entry = index.plugins.find((e) => e.name === name);

        let action: PluginAction;
        if (sub === "update") {
          const at = interaction.options.getString("at") ?? undefined;
          if (at) {
            const parsed = parseScheduleTime(at, new Date());
            if ("error" in parsed) {
              await interaction.editReply(parsed.error);
              return;
            }
            action = { kind: "update", at: parsed.at };
          } else {
            action = { kind: "update" };
          }
        } else if (sub === "remind") {
          action = { kind: "remind", days: interaction.options.getInteger("days") ?? 7 };
        } else if (sub === "skip") {
          action = { kind: "skip" };
        } else if (sub === "cancel") {
          action = { kind: "cancel" };
        } else {
          await interaction.editReply(`Unknown /plugins subcommand: ${sub}`);
          return;
        }

        const result: PluginActionResult = planPluginAction(action, {
          name,
          installedVersion: stateEntry.installedVersion,
          latestVersion: entry?.version,
          compatible: entry ? entry.hostApiVersion === HOST_API_VERSION : false,
          neededHostApi: entry?.hostApiVersion ?? HOST_API_VERSION,
          botHostApi: HOST_API_VERSION,
          hasPending: stateEntry.scheduled !== undefined || stateEntry.targetVersion !== undefined,
          now: new Date(),
          requestedBy: interaction.user.id,
          channelId: interaction.channelId ?? undefined,
        });

        if (result.restart) {
          // `update` NOW: mirror /update — mutate + reply inside withCritical so the exit (deferred by
          // the critical section) lands only after the pin write and the reply have gone out.
          const { from, to } = result.restart;
          await withCritical(async () => {
            if (result.mutate) await mutatePluginState(DATA_DIR, result.mutate);
            await interaction.editReply(result.reply);
            requestRestart(`plugin update: ${name} ${from} → ${to}`);
          });
        } else {
          if (result.mutate) await mutatePluginState(DATA_DIR, result.mutate);
          await interaction.editReply(result.reply);
        }
      } catch (err) {
        await interaction.editReply(`⚠️ Couldn't act on the plugin: ${(err as Error).message}`);
      }
      return;
    }
    default: {
      // A loaded plugin's command (or nothing). The lookup is keyed by bare name; a name that
      // matches no core case and no plugin just warns rather than silently dropping.
      const pluginCommand = lookup(bare);
      if (pluginCommand) await pluginCommand.handle(interaction);
      else console.warn(`[interaction] no handler for /${interaction.commandName}`);
      return;
    }
  }
}

/**
 * `runningSha` is passed in rather than read off the `config` singleton: config resolves
 * process.env at import time and is shared across the whole bun test process, so a formatter
 * that reaches into it can only be tested by winning a race against whichever test file
 * imports config first.
 */
export function updateReply(
  decision: UpdateDecision,
  latestSha: string,
  o: { runningSha?: string; reason?: DisabledReason; redeploy?: RedeployResult } = {},
): string {
  const short = latestSha.slice(0, 7);
  const running = o.runningSha?.slice(0, 7);
  switch (decision) {
    case "busy":
      return "⏳ An update is already in progress — I'll report how it went; ask again after that.";
    case "disabled":
      // Two ways to end up here, and they need different things from the operator: bake a
      // GIT_SHA, versus push the branch you built from (nazumods/wow#871).
      if (o.reason === "unpublished-sha") {
        return (
          `⚠️ Self-update is disabled — this build's commit \`${running}\` ` +
          `isn't on \`${config.githubRepo}\`, so I can't tell what I'm missing. ` +
          `Push the branch you built from, or deploy a pushed commit.`
        );
      }
      return "⚠️ Self-update is disabled — this build has no `GIT_SHA` baked in.";
    case "current":
      return `✅ Already on the latest build (\`${running}\`).`;
    case "suppressed":
    case "restart":
      // A self-contained redeploy that *worked* never reaches here: the replacement retires
      // this process mid-await, and delivers the ✅ itself from `pendingUpdateReport`. So a
      // result present at all is a failed swap, and the reply says so instead of promising a
      // return that isn't coming (nazumods/wow#879).
      if (o.redeploy) {
        const kind =
          o.redeploy.outcome === "timeout" || o.redeploy.outcome === "stalled"
            ? o.redeploy.outcome
            : "failed";
        return handoffFailureMessage(kind, { targetSha: latestSha, error: o.redeploy.error });
      }
      // No "if I come back on the same build…" caveat: the bot answers that itself now,
      // with a follow-up naming the build it actually landed on (see updateReport.ts).
      return `🔄 Restarting to pick up \`${short}\`. I'll report back once I'm up.`;
  }
}
