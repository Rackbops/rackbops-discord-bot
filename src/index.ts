import { pathToFileURL } from "node:url";
import { Client, Events, REST, Routes } from "discord.js";
import { config } from "./config";
import { DATA_DIR, createJsonWriter, createKeyedJsonMutator, readJsonOrFresh, writeJsonAtomic } from "./storage";
import { createClient, CORE_INTENTS } from "./client";
import { commandData, handleCommand, CORE_COMMAND_NAMES } from "./commands";
import { isReportModal, handleReportModal } from "./report";
import { startScheduler, announceTo } from "./announce";
import { reportUpdateOutcome } from "./updateReport";
import { writeMarker, HANDOFF_FROM_ENV, VERIFY_DEADLINE_MS } from "./handoff";
import { resolveBootMode, takeOver } from "./redeploy";
import { loadPluginIndex } from "./plugins";
import { selectPlugins, collectIntents, describeSkips } from "./plugins/registry";
import { HOST_API_VERSION } from "./plugins/contract";
import type { HostApi, HostStorage, PluginIndexEntry, PluginModule, PluginStateFile } from "./plugins/contract";
import { installPlugins, tarExtract } from "./plugins/install";
import type { InstallResult } from "./plugins/install";
import type { LoadResult, PluginCommandMap } from "./plugins/host";
import {
  activatePlugins,
  buildCommandBody,
  createHostApi,
  loadPlugins,
  pluginCommandMap,
  pluginTicks,
  readPluginState,
  writePluginState,
} from "./plugins/host";

// The boot-time half of plugin support: read the manifest and pick intents before the Client
// exists (intents are frozen at construction) — no plugin code runs until #99's activate().
const pluginIndexResult = await loadPluginIndex(config.pluginIndexUrl, DATA_DIR);
const selectedPlugins = selectPlugins(
  pluginIndexResult.index,
  config.plugins,
  HOST_API_VERSION,
  CORE_COMMAND_NAMES,
);
const skipReasons = describeSkips(selectedPlugins);
for (const line of skipReasons) console.warn(`[plugins] ${line}`);
console.log(
  `[plugins] index: ${pluginIndexResult.source}, ${selectedPlugins.length - skipReasons.length} selected, ${skipReasons.length} skipped`,
);

const client = createClient(collectIntents(CORE_INTENTS, selectedPlugins));
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

  // Plugin setup — install and load BEFORE command registration (the builders come from the bundles)
  // and inside activate() (after takeOver()) so nothing plugin-side runs during the handoff overlap.
  // Fully isolated: per-plugin failures are already contained inside install/load/build, and this
  // outer try degrades ANY unexpected failure to core-only registration — a plugin never crashes boot.
  const storage: HostStorage = { readJsonOrFresh, writeJsonAtomic, createJsonWriter, createKeyedJsonMutator };
  let previousState: PluginStateFile = { hostApiVersion: HOST_API_VERSION, writtenAt: "", plugins: [] };
  let installResult: InstallResult = { installed: [], skips: {} };
  let loadResult: LoadResult = { loaded: [], errors: {} };
  let commandMap: PluginCommandMap = new Map();
  let commandBody = commandData;
  try {
    previousState = await readPluginState(DATA_DIR, storage);
    const installedVersions = Object.fromEntries(previousState.plugins.map((p) => [p.name, p.installedVersion]));
    installResult = await installPlugins(selectedPlugins, DATA_DIR, installedVersions, {
      fetch,
      extract: tarExtract,
      now: Date.now,
      log: console,
    });
    const makeHost = (entry: PluginIndexEntry): HostApi =>
      createHostApi({
        entry,
        processEnv: process.env,
        dataDir: DATA_DIR,
        baseLog: console,
        storage,
        announce: (message) => announceTo(client, config.announceChannelId, message),
      });
    loadResult = await loadPlugins(
      installResult.installed,
      makeHost,
      async (bundlePath) => (await import(pathToFileURL(bundlePath).href)) as PluginModule,
      console,
    );
    commandMap = pluginCommandMap(loadResult.loaded, CORE_COMMAND_NAMES, console);
    commandBody = buildCommandBody(config.commandPrefix, commandData, commandMap, console);
  } catch (err) {
    console.error("[plugins] plugin setup failed — the bot starts core-only", err);
  }

  try {
    await rest.put(
      config.guildId
        ? Routes.applicationGuildCommands(c.user.id, config.guildId)
        : Routes.applicationCommands(c.user.id),
      { body: commandBody },
    );
    console.log(`Registered ${commandBody.length} slash commands`);
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
        await handleCommand(interaction, (bare) => commandMap.get(bare)?.command);
      } else if (interaction.isModalSubmit() && isReportModal(interaction.customId)) {
        await handleReportModal(interaction);
      }
    } catch (err) {
      console.error("[interaction]", err);
    }
  });

  startScheduler(client, pluginTicks(loadResult.loaded, console));

  // Activate plugins AFTER the scheduler is up (pluginTicks are running-gated, so a tick that fires
  // before this resolves is skipped) — a throwing activate() is isolated, never crashing the bot.
  await activatePlugins(loadResult.loaded, console);
  try {
    await writePluginState({
      dataDir: DATA_DIR,
      storage,
      selected: selectedPlugins,
      installed: installResult.installed,
      installSkips: installResult.skips,
      loaded: loadResult.loaded,
      loadErrors: loadResult.errors,
      processEnv: process.env,
      previous: previousState,
      now: () => new Date(),
    });
  } catch (err) {
    // A data/plugins/state.json write failure (a full/read-only volume) is bookkeeping for ops
    // tooling — it must not crash a bot that is otherwise up and serving.
    console.error("[plugins] writing data/plugins/state.json failed", err);
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
