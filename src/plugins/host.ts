// Loads, wires and activates the installed plugin bundles, and records what happened in
// data/plugins/state.json. Everything here is pure/DI'd (importer, makeHost, storage, log injected)
// so host.test.ts drives it with fake bundles and a temp dir, no discord.js Client and no network.
// Runs inside the bot's activate(), after takeOver() — see src/index.ts.
import {
  MessageFlags,
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
/** #218: every option path (subcommand groups/subcommands walked recursively, space-joined, e.g.
 *  `"group sub q"`) whose built JSON declares `autocomplete: true` — the host never routes an
 *  autocomplete interaction to a plugin (see `buildCommandBody` below and `index.ts`'s handler), so
 *  these are dead pickers. Total: a malformed/absent `options` (not an array) yields `[]`. */
export function autocompleteOptionPaths(json: RESTPostAPIChatInputApplicationCommandsJSONBody): string[] {
  const paths: string[] = [];
  const walk = (options: unknown, prefix: readonly string[]): void => {
    if (!Array.isArray(options)) return;
    for (const opt of options) {
      if (typeof opt !== "object" || opt === null) continue;
      const o = opt as { name?: unknown; autocomplete?: unknown; options?: unknown };
      if (typeof o.name !== "string") continue;
      const path = [...prefix, o.name];
      if (o.autocomplete === true) paths.push(path.join(" "));
      walk(o.options, path);
    }
  };
  walk((json as { options?: unknown }).options, []);
  return paths;
}

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
    // #218: a live command with a dead picker is still better than dropping it outright — warn, don't
    // refuse. A typed value still works; only the autocomplete suggestions never load (index.ts
    // answers every autocomplete interaction with an empty list — see its handler for why).
    const autocompletePaths = autocompleteOptionPaths(built);
    if (autocompletePaths.length > 0) {
      log.warn(
        `[plugins] ${entry.name}: command "${bare}" asks for autocomplete on ` +
          `${autocompletePaths.map((p) => `"${p}"`).join(", ")} — the host does not route autocomplete ` +
          `to plugins (#287), so the picker offers no suggestions; a typed value still works`,
      );
    }
    body.push(built);
  }
  return body;
}

/** The most one plugin tick gets (#217) before `pluginTicks` stops waiting on it: its check then
 *  rejects, which `runTick` logs as that plugin's own failure before moving on to the next plugin.
 *  Kept under `announce.ts`'s 60s `TICK_MS` so a single hung tick can't by itself hold `guardedTick`
 *  past the next interval — `runTick` awaits checks one after another, so before this a hung tick
 *  held every plugin loaded after it for as long as it hung. At the bound the host also aborts the
 *  call's `AbortSignal` (#248), so a cooperating tick bails; one that ignores the signal keeps
 *  running — concurrently with whatever runs next, that plugin's other ticks included — and
 *  `pluginTicks` skips that tick (with a warning) until it settles, rather than starting a second
 *  call on top of it. A call that never settles therefore silences that tick until the bot
 *  restarts; its siblings keep running. */
export const PLUGIN_TICK_TIMEOUT_MS = 30_000;

/** How long a stop (a requested restart, or a SIGTERM/SIGINT) waits for plugin ticks it has just
 *  aborted to settle before it stops waiting on them (#248). Kept under `shutdown.ts`'s 8s
 *  `SHUTDOWN_GRACE_MS`, so a tick that ignores its signal releases the drain with room left for
 *  `disposePlugins` and the gateway close — and a restart is delayed by at most this, never held
 *  forever the way #217 had to rule out. */
export const PLUGIN_TICK_ABORT_GRACE_MS = 5_000;

/** Rejects if `p` hasn't settled within `ms`, and clears its timer either way — unlike
 *  `disposePlugins`' race below (a one-shot on the way out, where a leftover timer is harmless),
 *  this runs on every 60s tick, and a timer left armed after its tick settled would sit dead for up
 *  to `ms`, holding the event loop open that long. Once the timeout wins, `onTimeout` runs (it
 *  aborts the call's signal, #248) and `p`'s late settle lands on an already-settled resolve/reject
 *  and is dropped, never an unhandled rejection. */
function withTickTimeout(p: Promise<void>, ms: number, label: string, onTimeout: (err: Error) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`plugin tick ${label} exceeded ${ms}ms`);
      onTimeout(err);
      reject(err);
    }, ms);
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * #248: what lets a stop cancel plugin ticks rather than walk away from them. Every plugin tick call
 * is registered here with its `AbortController` for as long as the call itself is pending — past
 * `PLUGIN_TICK_TIMEOUT_MS` too — and, when `hold` is wired, holds one unit of `restart.ts`'s critical
 * section for that whole time. That closes #217's gap: a tick the timeout abandoned no longer lets a
 * restart or a SIGTERM drain exit under it. `stop()` — wired to `restart.ts`'s `onStopRequested`, so
 * it runs when a restart is requested or a shutdown begins — aborts every pending call, refuses to
 * start new ones, and releases each hold once its call settles or `graceMs` elapses, whichever is
 * first. The grace is what keeps a tick that ignores its signal from holding a restart forever.
 */
export interface PluginTickControl {
  /** Registers one call; returns the signal to pass it, its abort (for the per-call timeout), and the
   *  function to call when it settles. */
  begin(): { signal: AbortSignal; abort: (reason: Error) => void; settle: () => void };
  /** Aborts every pending call and bounds how long each still holds a stop. Idempotent. */
  stop(reason: string): void;
  /** True once `stop` has run: no new plugin tick call starts. */
  readonly stopping: boolean;
}

export function createPluginTickControl(opts: {
  /** Opens one unit of the critical section and returns its release (`restart.ts`'s begin/endCritical).
   *  Omitted in tests that don't exercise the restart path. */
  hold?: () => () => void;
  graceMs?: number;
} = {}): PluginTickControl {
  const graceMs = opts.graceMs ?? PLUGIN_TICK_ABORT_GRACE_MS;
  const pending = new Set<{ controller: AbortController; release: () => void }>();
  let stopping = false;
  return {
    get stopping() {
      return stopping;
    },
    begin() {
      const controller = new AbortController();
      const endHold = opts.hold?.();
      let released = false;
      const call = {
        controller,
        // Idempotent: a call can be released by its own settle AND by the stop's grace timer.
        release: () => {
          if (released) return;
          released = true;
          endHold?.();
        },
      };
      pending.add(call);
      return {
        signal: controller.signal,
        abort: (reason) => controller.abort(reason),
        settle: () => {
          pending.delete(call);
          call.release();
        },
      };
    },
    stop(reason) {
      if (stopping) return;
      stopping = true;
      const calls = [...pending];
      if (calls.length === 0) return;
      for (const call of calls) call.controller.abort(new Error(`plugin tick aborted: ${reason}`));
      // One timer for the whole batch: past it, every call still pending lets go of the stop. Ref'd on
      // purpose, like awaitCriticalIdle's — the process is alive only to finish exactly this.
      setTimeout(() => {
        for (const call of calls) call.release();
      }, graceMs);
    },
  };
}

/** Each plugin tick wrapped so it only runs while that plugin's `running` flag is true — a tick
 * can fire between startScheduler and activatePlugins, and must not run before activate() resolved —
 * is abandoned after `timeoutMs` if it hasn't settled (#217, see PLUGIN_TICK_TIMEOUT_MS), and is never
 * started while its own previous call is still pending. Each call gets an `AbortSignal` (#248),
 * aborted at the timeout and at a stop; once `control` is stopping no new call starts. `timeoutMs` is
 * the test seam, like `guardedTick`'s `watchdogMs`: real callers take the default. `control` defaults
 * to one with no critical-section hold, which is #217's behaviour at a restart. */
export function pluginTicks(
  loaded: readonly LoadedPlugin[],
  log: BaseLog,
  timeoutMs = PLUGIN_TICK_TIMEOUT_MS,
  control: PluginTickControl = createPluginTickControl(),
): TickCheck[] {
  const checks: TickCheck[] = [];
  for (const lp of loaded) {
    try {
      // `plugin.ticks` is plugin-controlled and only type-asserted — a malformed value (non-iterable,
      // throwing getter) must skip this plugin's ticks, never throw out of here into activate()'s
      // caller (this runs OUTSIDE the setup try, at the startScheduler call).
      for (const tick of lp.plugin.ticks ?? []) {
        const name = `${lp.entry.name}:${tick.name}`;
        // Per check, not per plugin or per name: true from the moment a call starts until that call
        // ITSELF settles — not until the wait on it gives up — so a call the timeout abandoned still
        // blocks a second one being started on top of it (#217). `pluginTicks` runs once, at boot, so
        // this outlives every tick.
        let inFlight = false;
        checks.push({
          name,
          run: async () => {
            if (!lp.running) return;
            // #248: on the way out — don't start a call the stop would only have to abort.
            if (control.stopping) return;
            if (inFlight) {
              log.warn(`[plugins] ${name}: its previous tick is still running — skipping this one`);
              return;
            }
            inFlight = true;
            const { signal, abort, settle } = control.begin();
            // The async wrapper still starts the tick synchronously, but turns a sync throw or a plain
            // (non-promise) return — plugin code is only type-asserted — into a promise, so EVERY path
            // reaches the finally that releases the flag and the hold; a throw that skipped it would
            // silence this tick for good.
            const call = (async () => tick.run(signal))().finally(() => {
              inFlight = false;
              settle();
            });
            // At the bound, abort rather than only walk away: a cooperating tick bails now. The hold
            // and the in-flight flag stay with the call itself (the finally above), not with the wait.
            await withTickTimeout(call, timeoutMs, name, abort);
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
 * false for every plugin this touches regardless of outcome, so `pluginTicks`' running gate stops
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
 *
 * **#225:** a plugin taken out of `PLUGINS=` (not in `opts.selected` this boot) is no longer dropped —
 * its previous entry is carried forward as `enabled: false, active: false`, appended after the
 * selected entries, in the previous file's order, de-duplicated by name (first wins). Carried:
 * `installedVersion` (the pin — the whole point, so re-enabling never falls through to
 * `newestCachedVersion` and silently reuses a version the operator moved away from),
 * `notifiedVersion`/`skippedVersion`/`remindAt`/`scheduled`, `configured`/`missingEnv` exactly as the
 * last boot it ran left them. Dropped: `targetVersion` (a one-boot transient that never ran this
 * boot), `availableVersion` (recomputed each boot from the index, only for selected plugins), `error`
 * (a this-boot outcome). An entry that was already `enabled: false` is carried again the same way —
 * off entries never expire on their own.
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

  // #225: carry forward every previous entry that isn't selected this boot, as enabled: false — its
  // pin and bookkeeping survive a disable, so re-enabling later resolves against installedVersion
  // instead of falling through to newestCachedVersion (which could out-rank a hand-lowered pin the
  // same way #104's update-fallback already guards against). Previous-file order, de-duplicated by
  // name (first wins) — a corrupt previous file with a repeated name must not double an entry.
  const selectedNames = new Set(opts.selected.map((sp) => sp.name));
  const carriedNames = new Set<string>();
  const offEntries: PluginStateEntry[] = [];
  for (const prev of opts.previous.plugins) {
    if (selectedNames.has(prev.name) || carriedNames.has(prev.name)) continue;
    carriedNames.add(prev.name);
    const offEntry: PluginStateEntry = {
      name: prev.name,
      enabled: false,
      configured: prev.configured,
      missingEnv: prev.missingEnv,
      active: false,
    };
    if (prev.installedVersion !== undefined) offEntry.installedVersion = prev.installedVersion;
    if (prev.notifiedVersion !== undefined) offEntry.notifiedVersion = prev.notifiedVersion;
    if (prev.skippedVersion !== undefined) offEntry.skippedVersion = prev.skippedVersion;
    if (prev.remindAt !== undefined) offEntry.remindAt = prev.remindAt;
    if (prev.scheduled !== undefined) offEntry.scheduled = prev.scheduled;
    offEntries.push(offEntry);
  }

  const state: PluginStateFile = {
    hostApiVersion: HOST_API_VERSION,
    writtenAt: opts.now.toISOString(),
    plugins: [...plugins, ...offEntries],
  };
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
