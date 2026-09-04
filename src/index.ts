import { Client, Events, REST, Routes } from "discord.js";
import { config } from "./config";
import { createClient } from "./client";
import { commandData, handleCommand } from "./commands";
import { isReportModal, handleReportModal } from "./report";
import { startScheduler } from "./announce";
import { reportUpdateOutcome } from "./updateReport";
import { writeMarker, HANDOFF_FROM_ENV, VERIFY_DEADLINE_MS } from "./handoff";
import { resolveBootMode, takeOver } from "./redeploy";
import { startWarbandeerServer, warbandeerConnectorConfigured } from "./warbandeer/server";

const client = createClient();
// A daemon call only happens here when the env actually says standby (#46) — an ordinary boot
// resolves this without ever touching the docker socket, same as before.
const mode = await resolveBootMode(process.env);

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  clearTimeout(verifyTimer);
  // A completed gateway login is the verification bar: process-alive proves nothing, and this
  // is the first moment the new build has demonstrated it can actually do its job. `takeOver` is
  // crash-proof — a retire failure exits this process rather than falling through to `activate`,
  // so a doomed handoff can never leave two live bots on the shared token.
  if (mode === "standby") await takeOver(process.env[HANDOFF_FROM_ENV]!);
  await activate(c);
});

/**
 * Everything that makes this process *the* bot. Held back until the handoff completes so the
 * overlap stays silent: both instances hold the same `DISCORD_TOKEN` and Discord delivers
 * every event to both sessions, so a standby that registered these would double each reply.
 */
async function activate(c: Client<true>): Promise<void> {
  const rest = new REST().setToken(config.discordToken);
  try {
    await rest.put(
      config.guildId
        ? Routes.applicationGuildCommands(c.user.id, config.guildId)
        : Routes.applicationCommands(c.user.id),
      { body: commandData },
    );
    console.log(`Registered ${commandData.length} slash commands`);
  } catch (err) {
    // A command-registration failure must not take the whole bot down. This used to run unguarded
    // in the ClientReady handler, so a throw became an unhandled rejection, the process crashed,
    // and restart:unless-stopped relaunched it into a tight loop. The usual cause is a guild the
    // bot was added to without the applications.commands scope — Discord rejects that with 50001
    // Missing Access, a config/invite problem no restart can fix. Log it and keep running: the
    // scheduler and any already-registered commands still work, and the next boot after the invite
    // is fixed will register them.
    console.error(
      "[startup] slash-command registration failed" +
        (config.guildId ? ` for guild ${config.guildId}` : " (global)") +
        "; the bot keeps running, but its slash commands won't appear in that guild until this is" +
        ' fixed. "Missing Access" (50001) means the bot lacks the applications.commands scope there.' +
        " Re-invite it with that scope (that fixes both this error and command visibility)." +
        " Clearing DISCORD_SERVER_ID switches to global registration and stops the error, but the" +
        " bot still needs the applications.commands scope for its commands to appear in a guild.",
      err,
    );
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction);
      } else if (interaction.isModalSubmit() && isReportModal(interaction.customId)) {
        await handleReportModal(interaction);
      }
    } catch (err) {
      console.error("[interaction]", err);
    }
  });

  startScheduler(client);
  // Absent WARBANDEER_INGEST_PORT means the connector never starts at all — fail closed
  // (docs/adr/0001) rather than binding a port nobody asked for. Guarded the same way command
  // registration is above: Bun.serve throwing (a privileged port under the non-root `bun` user,
  // the port already in use) must not become an unhandled rejection that crashes the whole bot
  // into a restart:unless-stopped loop over one optional feature failing to bind.
  if (warbandeerConnectorConfigured()) {
    try {
      startWarbandeerServer(config.warbandeerIngestPort!);
    } catch (err) {
      console.error(
        `[startup] Warbandeer connector failed to start on :${config.warbandeerIngestPort} — ` +
          "the bot keeps running without it; /link will report the feature disabled. Check the " +
          "port isn't already in use and isn't a privileged one the container's non-root user can't bind.",
        err,
      );
    }
  }
  // Deliberately not awaited: an owed /update follow-up must never hold up the scheduler,
  // and reportUpdateOutcome already swallows every delivery failure of its own.
  reportUpdateOutcome(client).catch((err) => console.error("[updateReport]", err));
}

// A standby that never reaches ClientReady must say so rather than sit there: the original is
// holding its announcements, waiting on exactly this answer. Saying it beats being timed out —
// the requester gets the reason instead of a shrug. Cleared the moment the login lands.
const verifyTimer =
  mode === "standby"
    ? setTimeout(async () => {
        console.error("[handoff] no gateway login — giving up so the original can resume");
        await writeMarker({
          status: "failed",
          sha: config.gitSha,
          error: "the replacement never completed a gateway login",
          at: Date.now(),
        });
        process.exit(1);
      }, VERIFY_DEADLINE_MS)
    : undefined;

await client.login(config.discordToken);
