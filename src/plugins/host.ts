// Loads, wires and activates the installed plugin bundles, and records what happened in
// data/plugins/state.json. Everything here is pure/DI'd (importer, makeHost, storage, log injected)
// so host.test.ts drives it with fake bundles and a temp dir, no discord.js Client and no network.
// Runs inside the bot's activate(), after takeOver() — see src/index.ts.
import {
  MessageFlags,
  SlashCommandBuilder,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { commandNamer } from "../commandNaming";
import { createKeyedJsonMutator } from "../storage";
import type {
  HostApi,
  HostStorage,
  Plugin,
  PluginCommand,
  PluginIndexEntry,
  PluginLog,
  PluginModule,
  PluginStateEntry,
  PluginStateFile,
  TickCheck,
} from "./contract";
import { HOST_API_VERSION } from "./contract";
import type { SelectedPlugin } from "./registry";
import type { InstalledPlugin } from "./install";

/** console-shaped base logger the host prefixes per plugin; injected so tests capture the lines. */
export interface BaseLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface LoadedPlugin {
  entry: PluginIndexEntry;
  version: string;
  plugin: Plugin;
  /** Flipped true by activatePlugins once activate() resolves; gates this plugin's ticks. */
  running: boolean;
  /** Set if activate() threw. */
  error?: string;
}

export type PluginCommandMap = Map<string, { entry: PluginIndexEntry; command: PluginCommand }>;

/**
 * Builds a HostApi for one plugin. `env` is ONLY the keys the plugin's Plugin Index entry declares,
 * read from `processEnv` — never the whole environment. `log` prefixes every line with `[name] `.
 */
export function createHostApi(opts: {
  entry: PluginIndexEntry;
  processEnv: Record<string, string | undefined>;
  dataDir: string;
  baseLog: BaseLog;
  storage: HostStorage;
  announce: (message: string) => Promise<void>;
}): HostApi {
  const { name } = opts.entry;
  const env: Record<string, string | undefined> = {};
  for (const { key } of opts.entry.env) env[key] = opts.processEnv[key];
  const log: PluginLog = {
    info: (m) => opts.baseLog.info(`[${name}] ${m}`),
    warn: (m) => opts.baseLog.warn(`[${name}] ${m}`),
    error: (m, e) => opts.baseLog.error(`[${name}] ${m}`, e),
  };
  return { name, env, dataDir: opts.dataDir, log, storage: opts.storage, announce: opts.announce };
}

export interface LoadResult {
  loaded: LoadedPlugin[];
  /** name -> reason, for bundles whose import or createPlugin threw. */
  errors: Record<string, string>;
}

/**
 * Imports each installed bundle and runs its `createPlugin(host)` — pure, no side effects yet
 * (those are `activate()`). A rejecting import or a throwing `createPlugin` is isolated: that
 * plugin is recorded in `errors` and left out of `loaded`, never crashing the others or the bot.
 */
export async function loadPlugins(
  installed: readonly InstalledPlugin[],
  makeHost: (entry: PluginIndexEntry) => HostApi,
  importer: (bundlePath: string) => Promise<PluginModule>,
  log: BaseLog,
): Promise<LoadResult> {
  const loaded: LoadedPlugin[] = [];
  const errors: Record<string, string> = {};
  for (const { entry, version, bundlePath } of installed) {
    try {
      const mod = await importer(bundlePath);
      const plugin = mod.createPlugin(makeHost(entry));
      loaded.push({ entry, version, plugin, running: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors[entry.name] = message;
      log.error(`[plugins] ${entry.name}: ${message}`);
    }
  }
  return { loaded, errors };
}

/**
 * Bare-name -> plugin command, dropping a whole plugin's command set if any of its names collide
 * with a core name or an earlier plugin's. Defence in depth behind #98's pre-load collision check
 * — never a throw. `coreCommandNames` are the bare core names (already claimed).
 */
export function pluginCommandMap(
  loaded: readonly LoadedPlugin[],
  coreCommandNames: readonly string[],
  log: BaseLog,
): PluginCommandMap {
  const map: PluginCommandMap = new Map();
  const claimed = new Set<string>(coreCommandNames);
  for (const { entry, plugin } of loaded) {
    try {
      // `plugin.commands` is plugin-controlled and only type-asserted, not validated — a malformed
      // value (non-array, throwing getter) must skip this plugin, never throw out of here.
      const commands = plugin.commands ?? [];
      const collision = commands.find((c) => claimed.has(c.name));
      if (collision) {
        log.warn(`[plugins] ${entry.name}: command "${collision.name}" collides with an already-registered command — skipping this plugin's commands`);
        continue;
      }
      for (const command of commands) {
        claimed.add(command.name);
        map.set(command.name, { entry, command });
      }
    } catch (err) {
      log.error(`[plugins] ${entry.name}: ignoring malformed commands — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return map;
}

/**
 * The full slash-command registration body: core JSON first, then each plugin command built on a
 * `COMMAND_PREFIX`-named builder (so a plugin can't register outside the namespace). A command that
 * builds to the wrong name is dropped and logged rather than trusted.
 */
export function buildCommandBody(
  prefix: string,
  coreCommandJson: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[],
  map: PluginCommandMap,
  log: BaseLog,
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const cmd = commandNamer(prefix);
  const body: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [...coreCommandJson];
  for (const [bare, { entry, command }] of map) {
    let built: RESTPostAPIChatInputApplicationCommandsJSONBody;
    try {
      // Plugin code: `build()` and discord.js's `toJSON()` (which validates) can both throw. Isolate
      // it — a bad builder drops just its command, never crashing the whole registration/boot.
      built = command.build(cmd(bare)).toJSON();
    } catch (err) {
      log.error(`[plugins] ${entry.name}: command "${bare}" failed to build — dropping it`, err);
      continue;
    }
    if (built.name !== `${prefix}${bare}`) {
      log.warn(`[plugins] ${entry.name}: command "${bare}" built the wrong name "${built.name}" — dropping it`);
      continue;
    }
    body.push(built);
  }
  return body;
}

/** Each plugin tick wrapped so it only runs while that plugin's `running` flag is true — a tick
 * can fire between startScheduler and activatePlugins, and must not run before activate() resolved. */
export function pluginTicks(loaded: readonly LoadedPlugin[], log: BaseLog): TickCheck[] {
  const checks: TickCheck[] = [];
  for (const lp of loaded) {
    try {
      // `plugin.ticks` is plugin-controlled and only type-asserted — a malformed value (non-iterable,
      // throwing getter) must skip this plugin's ticks, never throw out of here into activate()'s
      // caller (this runs OUTSIDE the setup try, at the startScheduler call).
      for (const tick of lp.plugin.ticks ?? []) {
        checks.push({
          name: `${lp.entry.name}:${tick.name}`,
          run: async () => {
            if (lp.running) await tick.run();
          },
        });
      }
    } catch (err) {
      log.error(`[plugins] ${lp.entry.name}: ignoring malformed ticks — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return checks;
}

/** Runs each plugin's `activate()` in order, isolated: a throw is recorded and logged, the plugin
 * left not-running, and the rest (and the bot) carry on. Mutates each LoadedPlugin in place. */
export async function activatePlugins(loaded: readonly LoadedPlugin[], log: BaseLog): Promise<void> {
  for (const lp of loaded) {
    try {
      await lp.plugin.activate?.();
      lp.running = true;
    } catch (err) {
      lp.error = err instanceof Error ? err.message : String(err);
      log.error(`[plugins] ${lp.entry.name} failed to activate — the bot keeps running without it: ${lp.error}`);
    }
  }
}

/** The most one plugin's `dispose()` gets (#184) — a server close or a handle release is normally
 *  near-instant; this exists only so one wedged plugin can't consume the whole shutdown grace and
 *  starve every other plugin's own dispose. `shutdown.ts` separately bounds the WHOLE
 *  `disposePlugins` call to whatever's left of its own grace budget — the two nest the same way
 *  `SHUTDOWN_GRACE_MS`/`DESTROY_CLIENT_TIMEOUT_MS` do. Disposing plugins CONCURRENTLY (see
 *  `disposePlugins` below), not one after another, is what makes that claim actually hold for any
 *  number of running plugins: N plugins each bounded by this SAME timeout, run at once, cost the
 *  same worst case as one — never N times as long. A sequential loop was tried first and reverted
 *  in review: it let two-or-more wedged plugins' timeouts sum past `shutdown.ts`'s own outer bound,
 *  so the outer bound could fire and the process could exit mid-way through a LATER plugin's
 *  dispose, never having given it a real chance to run at all. */
export const PLUGIN_DISPOSE_TIMEOUT_MS = 2_000;

/**
 * `activatePlugins`'s counterpart (#184), called once on the way out (`shutdown.ts`'s drain, after
 * in-flight critical sections have settled and before the gateway connection closes). Only plugins
 * that are actually `running` are disposed — one that never activated, or whose `activate()` threw,
 * has nothing `dispose()` could safely release. Unlike `activatePlugins` (deliberately sequential,
 * "in order"), every running plugin's `dispose?.()` starts at once and each is bounded
 * independently by the SAME `timeoutMs` (see that constant's own comment for why concurrent, not
 * sequential, is what actually keeps one wedged plugin from delaying another's chance to even
 * start) — nothing about shutdown depends on dispose ordering the way `activate()`'s setup might. A
 * throw — sync or async, including a malformed non-function `dispose` — is isolated exactly like
 * `activatePlugins` isolates a throwing `activate()`, logged and never propagated, and never stops
 * any other plugin's own dispose (`Promise.allSettled`, not `Promise.all`). `running` is flipped
 * false for every plugin this touches regardless of outcome, so `pluginTicks`' gate (`:166`) stops
 * ticking against a resource that dispose either released or failed to release — a dying handle is
 * not a reason to keep using it. Mutates each LoadedPlugin in place, like `activatePlugins`.
 */
export async function disposePlugins(loaded: readonly LoadedPlugin[], log: BaseLog, timeoutMs: number): Promise<void> {
  const running = loaded.filter((lp) => lp.running);
  await Promise.allSettled(
    running.map(async (lp) => {
      try {
        await Promise.race([
          Promise.resolve().then(() => lp.plugin.dispose?.()),
          new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      } catch (err) {
        log.error(`[plugins] ${lp.entry.name} dispose failed — continuing: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        lp.running = false;
      }
    }),
  );
}

/**
 * #185: which plugin (by name) a component/modal `customId` belongs to, by an exact split on the
 * FIRST colon — plugin names are `^[a-z][a-z0-9-]*$` (no colon can appear in one), so the
 * longest-name-wins ambiguity a generic prefix scheme would need to resolve never arises; a plain
 * split is exact. `undefined` for no colon at all, or a prefix that doesn't match any of `names`.
 */
export function routeInteractionByPrefix(customId: string, names: readonly string[]): string | undefined {
  const i = customId.indexOf(":");
  if (i === -1) return undefined;
  const prefix = customId.slice(0, i);
  return names.includes(prefix) ? prefix : undefined;
}

/**
 * Routes one component/modal interaction to the plugin its `customId` names, if any — called from
 * index.ts's InteractionCreate handler AFTER the core `report:` modal check, so that reserved
 * prefix never reaches here regardless of what plugins are installed. Dispatches ONLY to a
 * `running` plugin (activate() already resolved) that actually declared `interactions`; prefix
 * resolution itself runs over every LOADED plugin (not just running ones) so a match against a
 * not-yet-running plugin is deliberately blocked by this running check, not silently absent from
 * routing. A throwing handler is isolated — logged as "[plugins] <name> interaction failed" — and
 * the caller gets a best-effort ephemeral "something went wrong" reply, sent only if the plugin
 * hadn't already replied/deferred (a plugin that started its own reply flow keeps ownership of it).
 * Returns whether a plugin actually claimed this interaction, so the caller can tell that apart
 * from "no plugin's prefix matched."
 */
export async function dispatchPluginInteraction(
  loaded: readonly LoadedPlugin[],
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  log: BaseLog,
): Promise<boolean> {
  const routedName = routeInteractionByPrefix(
    interaction.customId,
    loaded.map((lp) => lp.entry.name),
  );
  const lp = routedName ? loaded.find((l) => l.entry.name === routedName) : undefined;
  if (!lp?.running || !lp.plugin.interactions) return false;
  try {
    await lp.plugin.interactions(interaction);
  } catch (err) {
    log.error(`[plugins] ${lp.entry.name} interaction failed`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Something went wrong.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
  return true;
}

const STATE_FRESH: PluginStateFile = { hostApiVersion: HOST_API_VERSION, writtenAt: "", plugins: [] };

function statePath(dataDir: string): string {
  return `${dataDir}/plugins/state.json`;
}

/** The env keys the plugin requires that are unset — an enabled-but-unconfigured plugin still loads
 * (D2), so this is reported, not fatal. `configured` is "no required key missing". */
function missingRequiredEnv(entry: PluginIndexEntry, processEnv: Record<string, string | undefined>): string[] {
  return entry.env.filter((e) => e.required && processEnv[e.key] === undefined).map((e) => e.key);
}

/**
 * Builds the state.json content from this boot's outcome, preserving the operator-bookkeeping fields
 * (`notifiedVersion`/`skippedVersion`/`remindAt`/`scheduled`, and the top-level `pendingReport`)
 * from the previous file — the bot is the only writer of those, and #103/#104 own them. Pure so the
 * content and the preservation are unit-tested directly.
 */
export function buildPluginStateFile(opts: {
  selected: readonly SelectedPlugin[];
  installed: readonly InstalledPlugin[];
  installSkips: Record<string, string>;
  /** #104: a `/plugins update` target that failed and was reverted to the previous version. */
  fallbacks: Record<string, { attempted: string; reason: string }>;
  loaded: readonly LoadedPlugin[];
  loadErrors: Record<string, string>;
  processEnv: Record<string, string | undefined>;
  previous: PluginStateFile;
  now: Date;
}): PluginStateFile {
  const installedByName = new Map(opts.installed.map((i) => [i.entry.name, i]));
  const loadedByName = new Map(opts.loaded.map((l) => [l.entry.name, l]));
  const previousByName = new Map(opts.previous.plugins.map((p) => [p.name, p]));

  const plugins: PluginStateEntry[] = opts.selected.map((sp) => {
    const prev = previousByName.get(sp.name);
    const installed = installedByName.get(sp.name);
    const loaded = loadedByName.get(sp.name);
    const installedVersion = installed?.version ?? sp.pinnedVersion ?? prev?.installedVersion;
    const availableVersion =
      sp.entry && installedVersion && sp.entry.version !== installedVersion ? sp.entry.version : undefined;
    const missingEnv = sp.entry ? missingRequiredEnv(sp.entry, opts.processEnv) : [];
    // First failure along the chain: selection skip -> install skip -> #104 update-fallback (installed
    // on the previous version, target failed) -> load error -> activate error. `targetVersion` is NOT
    // carried forward: it lived for exactly this boot — success promoted it into installedVersion (via
    // `installed.version` below), failure reverted to the previous, either way it is now consumed.
    const error =
      sp.skipped ?? opts.installSkips[sp.name] ?? opts.fallbacks[sp.name]?.reason ?? opts.loadErrors[sp.name] ?? loaded?.error;
    const entry: PluginStateEntry = {
      name: sp.name,
      enabled: true,
      configured: missingEnv.length === 0,
      missingEnv,
      active: loaded?.running === true,
    };
    if (installedVersion !== undefined) entry.installedVersion = installedVersion;
    if (availableVersion !== undefined) entry.availableVersion = availableVersion;
    if (error !== undefined) entry.error = error;
    if (prev?.notifiedVersion !== undefined) entry.notifiedVersion = prev.notifiedVersion;
    if (prev?.skippedVersion !== undefined) entry.skippedVersion = prev.skippedVersion;
    if (prev?.remindAt !== undefined) entry.remindAt = prev.remindAt;
    if (prev?.scheduled !== undefined) entry.scheduled = prev.scheduled;
    return entry;
  });

  const state: PluginStateFile = { hostApiVersion: HOST_API_VERSION, writtenAt: opts.now.toISOString(), plugins };
  if (opts.previous.pendingReport !== undefined) state.pendingReport = opts.previous.pendingReport;
  return state;
}

/** Reads the previous state.json (fresh if absent/corrupt) — the source of the preserved bookkeeping
 * fields and of the installed-version pins installPlugins resolves against. */
export async function readPluginState(dataDir: string, storage: HostStorage): Promise<PluginStateFile> {
  return storage.readJsonOrFresh<PluginStateFile>(statePath(dataDir), () => ({ ...STATE_FRESH }), "plugins");
}

/** Writes data/plugins/state.json atomically, preserving the previous file's bookkeeping fields. */
export async function writePluginState(opts: {
  dataDir: string;
  storage: HostStorage;
  selected: readonly SelectedPlugin[];
  installed: readonly InstalledPlugin[];
  installSkips: Record<string, string>;
  fallbacks: Record<string, { attempted: string; reason: string }>;
  loaded: readonly LoadedPlugin[];
  loadErrors: Record<string, string>;
  processEnv: Record<string, string | undefined>;
  previous: PluginStateFile;
  now: () => Date;
}): Promise<void> {
  const state = buildPluginStateFile({
    selected: opts.selected,
    installed: opts.installed,
    installSkips: opts.installSkips,
    fallbacks: opts.fallbacks,
    loaded: opts.loaded,
    loadErrors: opts.loadErrors,
    processEnv: opts.processEnv,
    previous: opts.previous,
    now: opts.now(),
  });
  await opts.storage.writeJsonAtomic(statePath(opts.dataDir), state);
}

// The ONE runtime mutator of state.json. The boot writePluginState above is a single whole-file
// write ordered before any tick (index.ts sets the "state ready" flag only after it); every
// subsequent runtime change (#103's notifiedVersion, #104's schedules) goes through this shared
// keyed mutator, which serializes read-modify-write per path so concurrent ticks can't lose an
// update. A module singleton so all callers share the one per-path queue.
const stateMutator = createKeyedJsonMutator<PluginStateFile>();

/** Race-safe read-modify-write of data/plugins/state.json (see stateMutator). */
export async function mutatePluginState(
  dataDir: string,
  mutate: (state: PluginStateFile) => PluginStateFile,
): Promise<void> {
  await stateMutator.update(statePath(dataDir), () => ({ ...STATE_FRESH }), mutate, "plugins");
}
