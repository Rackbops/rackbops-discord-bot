// #168: FIRST import on purpose — ESM evaluates imports in source order, so this prints the env
// file / data dir before ./config's module-body resolveConfig(process.env) gets a chance to throw
// on a wrong BOT_ENV_FILE. Side-effect only; see src/bootLog.ts. Pinned by index.test.ts.
import "./bootLog";
import { pathToFileURL } from "node:url";
import { Client, Events, REST } from "discord.js";
import { config } from "./config";
import { DATA_DIR, createJsonWriter, createKeyedJsonMutator, readJsonOrFresh, writeJsonAtomic } from "./storage";
import { createClient, CORE_INTENTS } from "./client";
import { bareName, commandData, handleCommand, CORE_COMMAND_NAMES } from "./commands";
import { isReportModal, handleReportModal } from "./report";
import { startScheduler, describeReleaseWatch, announceTo, isPluginStateReady, markPluginStateReady, livePluginRequestDeps, sendToChannel } from "./announce";
import { startRequestDrain } from "./plugins/drain";
import { consumePluginRequests } from "./plugins/requests";
import { owedReportNow, reportUpdateOutcome } from "./updateReport";
import { resolveUpdateAttempt } from "./update";
import { bootMode, ownContainerShortId, writeMarker, HANDOFF_FROM_ENV, VERIFY_DEADLINE_MS } from "./handoff";
import { detectRollback, finishProbation, healOwnName, resolveBootMode, stepAside, takeOver } from "./redeploy";
import { createReadyHandler } from "./ready";
import {
  awaitCriticalIdle,
  beginCritical,
  beginShutdown,
  endCritical,
  isShuttingDown,
  onBeforeExit,
  onStopRequested,
  restartPending,
  runExitHooks,
  withCritical,
} from "./restart";
import { createShutdownHandler, SHUTDOWN_GRACE_MS } from "./shutdown";
import { loadPluginIndex } from "./plugins";
import { selectPlugins, collectIntents, describeSkips, pinsFromState } from "./plugins/registry";
import { HOST_API_VERSION } from "./plugins/contract";
import type { HostApi, HostStorage, PluginIndexEntry, PluginModule, PluginStateFile } from "./plugins/contract";
import { installPlugins, tarExtract } from "./plugins/install";
import type { InstallResult } from "./plugins/install";
import type { LoadedPlugin, LoadResult, PluginCommandMap } from "./plugins/host";
import {
  activatePlugins,
  answerUnclaimedPress,
  buildCommandBody,
  createHostApi,
  createPluginTickControl,
  dispatchPluginAutocomplete,
  dispatchPluginInteractionOutcome,
  disposePlugins,
  findPluginCommand,
  HTTP_MAX_BODY_BYTES,
  loadPlugins,
  mutatePluginState,
  PLUGIN_DISPOSE_TIMEOUT_MS,
  PLUGIN_TICK_TIMEOUT_MS,
  pluginCommandMap,
  pluginTicks,
  readPluginState,
  routeHttpRequest,
  writePluginState,
} from "./plugins/host";
import { startHostHttp } from "./http";
import { createInteractionLine, describeInteraction, type InteractionOutcome } from "./interactionLog";
import { createTrustedProxy, PROXY_BOOT_REFRESH_TIMEOUT_MS } from "./net/clientIp";
import { reportPluginUpdateOutcome } from "./plugins/updates";
import { editOwnMessage, sendPayloadDm, sendPayloadToChannel, withoutRequest } from "./plugins/delivery";
import { describePlugins, readDiscovery } from "./routing/discovery";
import { applyRouting, guildJoined, guildLeft, initRouting } from "./routing/live";
import { gateCommand, whereOf } from "./routing/gate";
import { liveExecuteWebhook, markWebhookBroken, postForPlugin, type PostDeps } from "./routing/post";
import { readRouting, readSecrets } from "./routing/store";

// A standby that never reaches ClientReady must say so rather than sit there: the original is
// holding its announcements, waiting on exactly this answer. Saying it beats being timed out —
// the requester gets the reason instead of a shrug. Cleared the moment the login lands.
//
// Armed HERE, from the raw env, before the first boot await (#492, #494): every import has evaluated by this
// point, and `loadPluginIndex` (5 s), `readPluginState` and `resolveBootMode` (10 s) all run inside the 90 s now,
// instead of before it. The original's 120 s `HANDOFF_DEADLINE_MS` counts from its `startContainer`, so the
// margin is 30 s less the container's own start latency and import time (src/handoff.ts). A raw standby the daemon
// later downgrades to normal (the original is gone) has nothing to verify against and is cleared below.
const verifyTimer =
  bootMode(process.env) === "standby"
    ? setTimeout(async () => {
        console.error("[handoff] no gateway login — giving up so the original can resume");
        await writeMarker({
          status: "failed",
          sha: config.gitSha,
          error: "the replacement never completed a gateway login",
          replacementId: ownContainerShortId(),
          at: Date.now(),
        });
        process.exit(1);
      }, VERIFY_DEADLINE_MS)
    : undefined;

// The boot-time half of plugin support: read the manifest and pick intents before the Client
// exists (intents are frozen at construction) — no plugin code runs until #99's activate().
const pluginIndexResult = await loadPluginIndex(config.pluginIndexUrl, DATA_DIR);
// #222: the previous boot's per-plugin version pins (state.json), so a plugin that is last-good on an
// older version — rather than explicitly pinned, which needs no state — can be kept when the index
// moves to a version declaring a different host API (all a hostApiVersion in the index describes is
// its current version). This is a second read of the file activate() reads for installPlugins, kept
// separate on purpose: activate()'s read sits inside its own try/catch, while this one is not —
// pinsFromState accepts any parsed shape, and readPluginState degrades a corrupt file to fresh (moving
// it aside once, here, instead of in activate()), but a read that fails for another reason (EACCES, EIO)
// is rethrown by readJsonOrFresh (#509) and fails the boot here, with the real error in the log.
const bootStorage: HostStorage = { readJsonOrFresh, writeJsonAtomic, createJsonWriter, createKeyedJsonMutator };
const installedPins = pinsFromState(await readPluginState(DATA_DIR, bootStorage));
const selectedPlugins = selectPlugins(
  pluginIndexResult.index,
  config.plugins,
  HOST_API_VERSION,
  CORE_COMMAND_NAMES,
  installedPins,
);
const skipReasons = describeSkips(selectedPlugins);
for (const line of skipReasons) console.warn(`[plugins] ${line}`);
console.log(
  `[plugins] index: ${pluginIndexResult.source}, ${selectedPlugins.length - skipReasons.length} selected, ${skipReasons.length} skipped`,
);

const client = createClient(collectIntents(CORE_INTENTS, selectedPlugins));

// #184: the plugins actually loaded this boot, kept in module scope (not activate()-local, unlike
// loadResult below) so the shutdown handler — wired here, before activate() has ever run — can
// dispose them by the time a signal actually arrives. Empty until activate() assigns it, so for a signal
// that arrives before any plugin has loaded disposePlugins has nothing to dispose (it still sets the
// host's `disposing` flag, #541, so a boot that reaches activatePlugins afterwards activates none).
let currentLoadedPlugins: readonly LoadedPlugin[] = [];
// #220: stops the host's HTTP listener, once activate() has started one (HTTP_PORT set). A no-op until
// then, so a signal before activate() has nothing to stop.
let stopHttp: () => void = () => {};
// #548: the scheduler's FIRST tick, assigned by activate() when it starts the scheduler. A standby's
// probation waits on it (redeploy.ts's finishProbation) before the stopped original is removed. Already
// settled until then, and in a normal boot nothing reads it.
let firstTick: Promise<void> = Promise.resolve();

// #154: the first (and only) signal handler in this codebase, registered before resolveBootMode's
// own daemon call below so even a standby stopped mid-verify drains cleanly (trivially idle —
// nothing has started yet). destroyClient closes over `client`, which exists by now even though
// login hasn't happened — destroying a not-yet-logged-in Client is safe. Both signals share the
// SAME handler instance (see shutdown.ts's own comment on why that matters for a repeat signal).
const shutdownHandler = createShutdownHandler({
  beginShutdown,
  awaitIdle: awaitCriticalIdle,
  // #184: reads currentLoadedPlugins live at call time, not at wiring time (this closure is built
  // before activate() ever runs) — see that variable's own comment.
  // #220: the HTTP listener stops first, so no new request reaches a plugin that is being disposed.
  disposePlugins: () => {
    stopHttp();
    return disposePlugins(currentLoadedPlugins, console, PLUGIN_DISPOSE_TIMEOUT_MS);
  },
  destroyClient: () => client.destroy(),
  // #446: the exit hooks run here, at the shutdown's exit after the drain, not at the signal -- so an
  // interaction that finished during the drain wrote its own outcome and only one still in flight now
  // writes `exiting` (restart.ts, onBeforeExit). The second-signal exit goes through this too.
  exit: (code) => {
    runExitHooks();
    process.exit(code);
  },
  log: console,
  graceMs: SHUTDOWN_GRACE_MS,
});
process.on("SIGTERM", shutdownHandler);
process.on("SIGINT", shutdownHandler);

// A daemon call only happens here when the env actually says standby (#46) — an ordinary boot
// resolves this without ever touching the docker socket, same as before.
const mode = await resolveBootMode(process.env);
// #548: a standby whose original is RUNNING although this container has taken over before was rolled
// back by the operator (`docker start <name>`); it steps aside instead of stopping the original again.
if (mode === "standby" && (await detectRollback(process.env))) await stepAside();
// A raw standby the daemon downgraded (the original is confirmed gone) has nothing to verify against.
if (mode === "normal") clearTimeout(verifyTimer);
// #547: a swapped-in container whose rename never landed converges here; an ordinary boot (no HANDOFF_FROM)
// still never touches the socket. Every restart of a swapped-in container pays this one bounded inspect
// (10 s at most), because HANDOFF_FROM never clears from its env.
if (mode === "normal" && bootMode(process.env) === "standby") await healOwnName();

// A completed gateway login is the verification bar for STOPPING the original: process-alive proves
// nothing, and this is the first moment the new build has demonstrated it can actually do its job.
// `takeOver` is crash-proof — a retire failure exits this process rather than falling through to
// `activate`, so a doomed handoff can never leave two live bots on the shared token. The removal, the
// canonical name and `:latest` wait for `activate()` and the first tick (#548, `finishProbation`): until
// then the stopped original is the way back. The order (clear the verify timer, takeOver only in
// standby, then activate, then afterActivate in standby) lives in `src/ready.ts`, where `ready.test.ts`
// drives it (#435); index.test.ts pins that this call is the only thing attached to ClientReady.
client.once(
  Events.ClientReady,
  createReadyHandler({
    mode,
    takeOver: () => takeOver(process.env[HANDOFF_FROM_ENV]!),
    afterActivate: () => finishProbation(process.env[HANDOFF_FROM_ENV]!, firstTick),
    activate,
    clearVerifyTimer: () => clearTimeout(verifyTimer),
    log: console,
    describe: (c) => `Logged in as ${c.user.tag}`,
  }),
);

/**
 * Everything that makes this process *the* bot. Held back until the handoff completes so the
 * overlap stays silent: both instances hold the same `DISCORD_TOKEN` and Discord delivers
 * every event to both sessions, so a standby that registered these would double each reply.
 */
async function activate(c: Client<true>): Promise<void> {
  // DEMO BRANCH ONLY (#548 acceptance): a build that logs in and then dies in activate(). Never merge.
  throw new Error("#548 demo: this build throws in activate() on purpose");
  const rest = new REST().setToken(config.discordToken);

  // Plugin setup — install and load BEFORE command registration (the builders come from the bundles)
  // and inside activate() (after takeOver()) so nothing plugin-side runs during the handoff overlap.
  // Fully isolated: per-plugin failures are already contained inside install/load/build, and this
  // outer try degrades ANY unexpected failure to core-only registration — a plugin never crashes boot.
  const storage: HostStorage = { readJsonOrFresh, writeJsonAtomic, createJsonWriter, createKeyedJsonMutator };
  let previousState: PluginStateFile = { hostApiVersion: HOST_API_VERSION, writtenAt: "", plugins: [] };
  // #509: true while the read below has not succeeded. readJsonOrFresh rethrows a read that failed for a
  // reason other than corruption, and the catch further down swallows it -- so `previousState` is then the
  // empty default, "could not read", not "nothing there", and the boot write must not build the file from it.
  let previousStateUnread = true;
  let installResult: InstallResult = { installed: [], skips: {}, fallbacks: {} };
  let loadResult: LoadResult = { loaded: [], errors: {} };
  let commandMap: PluginCommandMap = new Map();
  let commandBody = commandData;
  try {
    previousState = await readPluginState(DATA_DIR, storage);
    previousStateUnread = false;
    // Per-plugin pins: the last-good installedVersion plus #104's transient targetVersion (an explicit
    // /plugins update the next boot should try, falling back to installedVersion if it can't install).
    const pins = Object.fromEntries(
      previousState.plugins.map((p) => [p.name, { installedVersion: p.installedVersion, targetVersion: p.targetVersion }]),
    );
    installResult = await installPlugins(selectedPlugins, DATA_DIR, pins, {
      fetch,
      extract: tarExtract,
      now: Date.now,
      log: console,
    });
    // #243: where a plugin's announcements go -- the channels its routing names, through a channel's
    // webhook when it has one, and the default channel (ANNOUNCE_CHANNEL_ID) when routing names none.
    const postDeps: PostDeps = {
      readRouting: () => readRouting(DATA_DIR),
      readSecrets: () => readSecrets(DATA_DIR),
      defaultChannelId: config.announceChannelId,
      sendAsBot: (channelId, message) => announceTo(client, channelId, message),
      executeWebhook: liveExecuteWebhook(),
      markBroken: markWebhookBroken(DATA_DIR),
      log: console,
    };
    const makeHost = (entry: PluginIndexEntry): HostApi =>
      createHostApi({
        entry,
        processEnv: process.env,
        dataDir: DATA_DIR,
        baseLog: console,
        storage,
        announce: (message, destination) => postForPlugin(entry.name, message, postDeps, destination),
        // #736: post/dm/edit/destinations, over the same live Client every other send path uses.
        delivery: {
          readRouting: () => readRouting(DATA_DIR),
          readDiscovery: () => readDiscovery(DATA_DIR),
          sendToChannel: (channelId, payload) => sendPayloadToChannel(client, channelId, payload),
          sendDm: (userId, payload) => sendPayloadDm(client, userId, payload),
          editOwnMessage: (channelId, messageId, payload) => editOwnMessage(client, channelId, messageId, payload),
          // #323: read at call time -- loadResult is assigned once loadPlugins returns, after this host exists.
          handlesInteractions: () =>
            typeof loadResult.loaded.find((lp) => lp.entry.name === entry.name)?.plugin.interactions === "function",
        },
      });
    loadResult = await loadPlugins(
      installResult.installed,
      makeHost,
      async (bundlePath) => (await import(pathToFileURL(bundlePath).href)) as PluginModule,
      console,
    );
    // #184: visible to the shutdown handler's disposePlugins closure from this point on — see
    // currentLoadedPlugins' own comment above.
    currentLoadedPlugins = loadResult.loaded;
    commandMap = pluginCommandMap(loadResult.loaded, CORE_COMMAND_NAMES, console);
    commandBody = buildCommandBody(config.commandPrefix, commandData, commandMap, console);
  } catch (err) {
    console.error("[plugins] plugin setup failed — the bot starts core-only", err);
  }

  // #450: what the previous life of this container left behind — a socket-path swap it started and never finished —
  // is resolved BEFORE the interaction handler attaches: a `/update` that arrived first would arm a fresh record
  // that this would take for the dead life's and clear while its build runs. The verdict is saved on the owed
  // report, which is delivered at the end of this function (`reportUpdateOutcome`). One bounded daemon call, and
  // only when such a record exists; an ordinary boot still never touches the socket. In standby this runs after
  // takeOver, like every other state write of the replacement's. Not during a shutdown (the #541 guard below is the
  // same rule for the rest of activation): the record stays for the next boot, which resolves it the same way.
  const attempt = isShuttingDown() ? "none" : await resolveUpdateAttempt();
  // The report the boot owes, as of this moment: a `/update` taken after the handler attaches arms a newer one that
  // belongs to its own restart, and the report-back at the end of this function must not deliver or clear that one.
  const owedAtBoot = owedReportNow();

  // Attach the interaction handler and bring plugins/the scheduler live BEFORE registering slash
  // commands with Discord: neither depends on that REST round-trip (commandMap/loadResult are
  // already populated above), so doing it first used to leave the bot with no interaction handler
  // and no ticks for the length of one Discord API call, on every boot — worst on a self-update,
  // where takeOver() has already stopped the original and this delay lands inside the no-bot window.
  client.on(Events.InteractionCreate, async (interaction) => {
    // #328: one line per command, component press or modal submit (autocomplete is skipped: it fires on
    // every keystroke), written once the interaction is handled (or, below, at the exit). Only names and
    // ids -- never an option value, a field or a reply (src/interactionLog.ts).
    const facts = describeInteraction(interaction);
    let outcome: InteractionOutcome = "answered";
    // #446: at most one line per interaction -- once it is handled, or from the exit hook when the process
    // exits (a requested restart, or the replacement stopping this container) before the handler returns.
    // `line` writes at most once, whichever comes first (src/interactionLog.ts).
    const line = createInteractionLine(facts, (l) => console.info(l));
    const offExit = facts ? onBeforeExit(() => line("exiting")) : () => {};
    try {
      if (interaction.isChatInputCommand()) {
        // #243: a plugin's commands run only in the channels its routing lists (core commands never reach the gate).
        // #407: and only while their plugin is running -- handleCommand reads the flag through the lookup.
        outcome = await handleCommand(
          interaction,
          (bare) => findPluginCommand(commandMap, loadResult.loaded, bare),
          (bare, chatInput) =>
            gateCommand(
              commandMap.get(bare)?.entry.name,
              chatInput.commandName,
              chatInput,
              () => whereOf(chatInput, (id) => client.channels.fetch(id)),
              () => readRouting(DATA_DIR),
              console,
            ),
        );
      } else if (interaction.isModalSubmit() && isReportModal(interaction.customId)) {
        await handleReportModal(interaction);
      } else if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
        // #185: core's report: modal check above always wins that prefix, regardless of what
        // plugins are installed -- this branch only ever sees what isReportModal() didn't claim.
        outcome = await dispatchPluginInteractionOutcome(loadResult.loaded, interaction, console);
        // #323: a press no running plugin answers gets a short ephemeral reply, not "This interaction failed".
        if (outcome === "unclaimed" && interaction.isMessageComponent()) await answerUnclaimedPress(interaction, console);
      } else if (interaction.isAutocomplete()) {
        // #287: a plugin command's picker goes to its autocomplete(), behind the same routing gate as the
        // command; everything else — core declares no autocomplete option — gets an empty list at once
        // instead of Discord's own 3s timeout failure (#218). The gate's own `[gate]` lines are not logged
        // here: they would repeat on every keystroke, and the command itself logs them when it runs.
        await dispatchPluginAutocomplete({
          interaction,
          bare: bareName(interaction.commandName),
          map: commandMap,
          loaded: loadResult.loaded,
          gate: (bare) =>
            gateCommand(
              commandMap.get(bare)?.entry.name,
              interaction.commandName,
              interaction,
              () => whereOf(interaction, (id) => client.channels.fetch(id)),
              () => readRouting(DATA_DIR),
              { error: () => {} },
            ),
          log: console,
        });
      }
      // #545: a failed reply carries the interaction token (a REST error in `url`, a network failure in `path`) and
      // the reply in `requestBody`; withoutRequest keeps what an operator needs (code, status, method).
    } catch (err) {
      outcome = "error";
      console.error("[interaction]", withoutRequest(err));
    } finally {
      offExit();
      line(outcome);
    }
  });

  // #259: a server the bot joins or leaves after boot. Attached here, before the boot registration below,
  // so a server joined while that registration is running is not missed: it queues behind it on
  // live.ts's chain, and before initRouting both do nothing (the boot registration snapshots a cache that
  // already holds the server). discord.js emits guildCreate only for a server that is new to its cache once
  // the client is Ready -- not for the servers it lists at start-up -- and guildDelete only when the bot is
  // really out; a server going into, or coming back from, an outage is the separate availability pair, which
  // is deliberately NOT wired here: it is neither a join nor a leave. (A server invited while the gateway
  // session is being re-identified, rather than resumed, can arrive as the availability event instead of a
  // join; that gap is known and accepted, see CONTEXT.md.) `void`: neither function can reject, so nothing
  // escapes into the emitter.
  client.on(Events.GuildCreate, (guild) => void guildJoined(guild));
  client.on(Events.GuildDelete, (guild) => void guildLeft(guild));

  // Activate plugins BEFORE starting the scheduler, so the first (synchronous) tick startScheduler
  // fires runs each plugin's ticks with `running` already true — preserving the boot-time announcements
  // the core WoW checks used to make on that first synchronous tick (the wow plugin owns them now, #107).
  // A throwing activate() stays isolated inside activatePlugins (the bot never crashes on it), and
  // pluginTicks' running-gate is kept as defence in depth.
  await activatePlugins(loadResult.loaded, console);
  // #541: a shutdown began during activation. disposePlugins has run, or runs as soon as the drain ends,
  // and the loop refuses every plugin it had not started by then (one already running is disposed). Writing
  // state.json, draining the mailbox, binding HTTP and sending the update report-back now would record and
  // announce a boot that never happened (the report would say "failed to start" for a plugin the shutdown
  // refused). Stop here; the pending report survives to the next boot.
  // Shutdown only (not restartPending, which is also true for a handoff): a handoff that began meanwhile
  // can still fail and leave this process running, and it must then have booted; a pending restart exits
  // by itself.
  if (isShuttingDown()) {
    console.warn("[plugins] shutdown in progress — the rest of activation is skipped");
    return;
  }

  // #248: each plugin tick call holds the critical section until it settles, and a restart request or a
  // shutdown aborts every pending one — so neither exits under a tick mid-write, and a tick that ignores
  // its signal holds the stop for PLUGIN_TICK_ABORT_GRACE_MS at most. Wired before the first tick runs.
  const tickControl = createPluginTickControl({
    hold: () => {
      beginCritical();
      return endCritical;
    },
  });
  onStopRequested((reason) => tickControl.stop(reason));
  console.log(describeReleaseWatch(config.watchedRepos));
  firstTick = startScheduler(client, pluginTicks(loadResult.loaded, console, PLUGIN_TICK_TIMEOUT_MS, tickControl));

  // #220 (ADR-0007): the host's HTTP router, only when HTTP_PORT is set. After activatePlugins, so a
  // plugin's `running` gate is already true; routeHttpRequest answers 503 for one that is not. A bind
  // failure (a port in use) is logged and the bot runs without it — an HTTP plugin must never take
  // the bot down.
  if (config.httpPort !== undefined) {
    try {
      // #319: resolved (or explicitly never-trusted) before the listener binds, so the first request sees the
      // real address set when the sidecar answers within the bound. #493: bounded, so a sidecar that cannot be
      // resolved yet (a first `up`, a host reboot) delays command registration and the ready flag by at most
      // PROXY_BOOT_REFRESH_TIMEOUT_MS, not by the resolver's own timeout; the lookup keeps running and trust
      // lands when it does -- fail closed meanwhile. Failures and recoveries are logged by the proxy itself.
      const proxy = createTrustedProxy({ host: config.trustedProxyHost, log: console });
      if (config.trustedProxyHost === undefined) {
        console.log(
          "[http] TRUSTED_PROXY_HOST is not set -- CF-Connecting-IP will never be trusted; every caller shares one rate-limit budget",
        );
      } else {
        await proxy.refresh(PROXY_BOOT_REFRESH_TIMEOUT_MS);
      }
      const loaded = loadResult.loaded;
      const http = startHostHttp({
        port: config.httpPort,
        maxBodyBytes: HTTP_MAX_BODY_BYTES,
        handle: (request, clientIp) => routeHttpRequest(loaded, request, clientIp, console),
        log: console,
        proxy,
      });
      stopHttp = http.stop;
    } catch (err) {
      console.error(`[http] could not listen on :${config.httpPort} — plugin HTTP routes are off`, err);
    }
  }

  // #241: the request mailbox is also drained every few seconds on its own timer, so a routing change
  // made in the panel shows up while the operator is still looking; the `pluginRequests` tick check
  // stays as the backstop. It is deliberately not part of the tick machinery. Beats do nothing until
  // the boot state write and the boot drain below have landed (`isPluginStateReady`), which is also
  // after `initRouting`, and none starts on the way out. The drain is a critical section, so a restart an
  // update-now asks for waits for it, as it does for a tick -- for at most `REQUEST_DRAIN_TIMEOUT_MS`
  // (#508), past which the beat logs and lets go. The stop function it returns is not kept:
  // like the scheduler's own interval, this timer lives as long as the process, and every way out of the
  // process ends in `process.exit`.
  startRequestDrain({
    ready: isPluginStateReady,
    restartPending,
    drain: () => consumePluginRequests(livePluginRequestDeps()),
    hold: withCritical,
    log: console,
  });

  try {
    // #239: what decides where the commands go now lives in src/routing/. With no routing.json (or
    // one that places nobody) `applyRouting` makes EXACTLY the one PUT that used to be here, to the
    // same route with the same body, and its result is `single` -- so the line below is unchanged.
    // A `single` failure is rethrown once discovery.json is written (see live.ts for what it records
    // and when it is skipped), into the catch below. So is a routing read that fails for a reason other
    // than a parse error (#509): `applyRouting` reads routing first, outside any try, and `readJsonOrFresh`
    // rethrows such a fault -- it lands in the same catch, under its registration headline, with the real
    // error printed after it.
    initRouting({
      client: c,
      put: (route, body) => rest.put(route, { body }),
      appId: c.user.id,
      botUsername: c.user.username,
      dataDir: DATA_DIR,
      homeGuildId: config.guildId,
      prefix: config.commandPrefix,
      fullBody: commandBody,
      commandMap,
      plugins: describePlugins(loadResult.loaded, commandBody, config.commandPrefix, commandMap),
      now: () => new Date(),
      log: console,
    });
    // Not `mode`: that is the module-level boot mode (standby or normal), used again below.
    const { mode: routingMode } = await applyRouting("boot");
    if (routingMode === "single") console.log(`Registered ${commandBody.length} slash commands`);
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

  try {
    if (previousStateUnread) {
      console.error("[plugins] data/plugins/state.json could not be read, so it is left as it is this boot (not rewritten)");
    } else {
      await writePluginState({
        dataDir: DATA_DIR,
        storage,
        selected: selectedPlugins,
        installed: installResult.installed,
        installSkips: installResult.skips,
        fallbacks: installResult.fallbacks,
        loaded: loadResult.loaded,
        loadErrors: loadResult.errors,
        processEnv: process.env,
        previous: previousState,
        now: () => new Date(),
      });
    }
  } catch (err) {
    // A data/plugins/state.json write failure (a full/read-only volume) is bookkeeping for ops
    // tooling — it must not crash a bot that is otherwise up and serving.
    console.error("[plugins] writing data/plugins/state.json failed", err);
  }
  // #105: drain the request mailbox ONCE, AWAITED, before releasing the tick — so a request dropped
  // while the bot was down is honoured before the pluginRequests/pluginUpdates ticks or a /plugins
  // command can interleave (those two ticks wait on the state-ready flag; the others, plugin ticks
  // included, already run from startScheduler), and the single-flight consumer never overlaps the
  // first tick's drain. An update-now request restarts here
  // (exit deferred by nothing at boot → immediate), applying on the next boot; anything queued after
  // is drained by the pluginRequests tick. Swallows its own failures (never blocks startup).
  try {
    await consumePluginRequests(livePluginRequestDeps());
  } catch (err) {
    console.error("[plugins] boot request-mailbox drain failed", err);
  }
  // The boot state write + mailbox drain are done — let the tick run now that it can no longer race
  // that whole-file write. Unconditional: never permanently disable update notices just because one
  // boot write hit a full volume.
  markPluginStateReady();

  // Deliberately not awaited: an owed /update follow-up must never hold up the scheduler,
  // and reportUpdateOutcome already swallows every delivery failure of its own; `attempt` is what this boot made of
  // the swap record (#450).
  reportUpdateOutcome(client, attempt, undefined, owedAtBoot).catch((err) => console.error("[updateReport]", err));

  // #104: and the owed /plugins-update follow-up. Not awaited for the same reason; clears its marker
  // through the shared mutator (the pluginUpdates tick is live now that markPluginStateReady fired).
  reportPluginUpdateOutcome({
    readState: () => readPluginState(DATA_DIR, storage),
    mutateState: (mutate) => mutatePluginState(DATA_DIR, mutate),
    dmUser: async (userId, content) => {
      const user = await client.users.fetch(userId);
      await user.send(content);
    },
    postChannel: async (channelId, userId, content) => {
      await sendToChannel(client, channelId, `<@${userId}> ${content}`, { allowedMentions: { users: [userId] } });
    },
    log: console,
  }).catch((err) => console.error("[plugins] report-back", err));
}

await client.login(config.discordToken);
