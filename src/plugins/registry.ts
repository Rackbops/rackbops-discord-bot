// Pure plugin selection — no I/O, no imports beyond the contract's types. Runs after the Plugin
// Index is loaded (src/plugins/index.ts) and before the discord.js Client is constructed
// (src/index.ts), so every skip decision here is made from data alone, never from plugin code.
import type { PluginIndex, PluginIndexEntry, PluginStateEntry } from "./contract";

interface ConfiguredPlugin {
  name: string;
  version?: string;
}

/** The two `state.json` fields that decide which version `installPlugins` resolves for a plugin
 * when there is no explicit `PLUGINS=name@version` pin: the last-good `installedVersion`, and #104's
 * transient `targetVersion` (an explicit `/plugins update` the next boot should try first). */
type VersionPins = Pick<PluginStateEntry, "installedVersion" | "targetVersion">;

const VERSION_PREFIX = /^(\d+)\.(\d+)\.(\d+)/;

/**
 * `a` is provably older than `b`: both begin with dotted `major.minor.patch` numbers, small enough
 * to compare exactly, and `a`'s are lower. Everything else — equal, newer, a prerelease tag on the
 * same numbers, text that isn't a version at all (the index's shape check only wants a string, so
 * `version: "latest"` passes it) — is "not older", so a caller that keeps only provably-older
 * versions stays on its conservative path for anything it cannot order.
 */
function isOlderVersion(a: string, b: string): boolean {
  const pa = VERSION_PREFIX.exec(a);
  const pb = VERSION_PREFIX.exec(b);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (!Number.isSafeInteger(na) || !Number.isSafeInteger(nb)) return false;
    if (na !== nb) return na < nb;
  }
  return false;
}

/**
 * `entry` is only absent for the "not in the plugin index" skip reason — every other outcome
 * (selected, or skipped for host-API or a command collision) has a real entry to report against.
 */
export interface SelectedPlugin {
  name: string;
  entry?: PluginIndexEntry;
  pinnedVersion?: string;
  skipped?: string;
}

/**
 * Walks `configured` (parsed `PLUGINS=` tokens, in order) against the Plugin Index, skipping a
 * plugin that isn't published, whose index entry needs a different host API than this bot's (unless
 * an older pinned or last-good version is kept — see the check below), is itself named after a
 * reserved core command (#185 — its interaction-routing prefix would collide), or whose command
 * names collide with core or an earlier-selected plugin. A skipped plugin is still returned (with
 * `skipped` set) so a caller can report why — this is what #99/#101/#102 read to build `state.json`
 * and the panel's listing.
 *
 * `installed` is the previous boot's per-plugin pins (`pinsFromState`) — what lets a last-good or
 * target version be kept past an index host-API bump. Left out, only an explicit
 * `PLUGINS=name@version` pin can be.
 */
export function selectPlugins(
  index: PluginIndex,
  configured: ConfiguredPlugin[],
  hostApiVersion: number,
  coreCommandNames: readonly string[],
  installed: ReadonlyMap<string, VersionPins> = new Map(),
): SelectedPlugin[] {
  const byName = new Map(index.plugins.map((entry) => [entry.name, entry]));
  const claimedBy = new Map<string, string>();
  for (const name of coreCommandNames) claimedBy.set(name, "core");

  const selected: SelectedPlugin[] = [];
  for (const cfg of configured) {
    const entry = byName.get(cfg.name);
    if (!entry) {
      selected.push({ name: cfg.name, pinnedVersion: cfg.version, skipped: "not in the plugin index" });
      continue;
    }

    // The index's hostApiVersion describes `entry.version` — the index's CURRENT version — and
    // nothing else (PluginRelease carries no host API). #222: rather than skip a plugin whenever
    // that differs from this bot's, an OLDER version is kept when the current one needs a NEWER
    // host — an older version may still target ours. Every version installPlugins may try must be
    // provably older than the current one (its resolution, install.ts:306-328: an explicit
    // PLUGINS pin, and only that; otherwise #104's targetVersion and, should that install fail, the
    // last-good installedVersion). Everything else stays skipped, as before: no pin; a version
    // equal to, newer than, or unorderable against the current one; a current that needs an OLDER
    // host than ours (assuming a plugin's host API never decreases across its versions, no older
    // version can match either); and an entry that declares intents —
    // collectIntents would union them into the whole Client for a plugin that only ever runs the
    // older version, and a privileged intent the operator hasn't enabled is an unrecoverable login
    // failure. So this only ever un-skips a plugin in cases that cannot change the Client's intents.
    // installPlugins' newest-cached fallback is not modelled (it needs disk access), so a plugin
    // with no pin and no state.json record stays skipped. #223: install.ts's reconcileManifest DOES
    // check a kept version's own declared hostApiVersion — against this host's HOST_API_VERSION, not
    // entry.hostApiVersion, since entry describes only the index's current version — on both the
    // cache-reuse and post-extract paths, and refuses a mismatch instead of loading it. (requests.ts's
    // pre-flight likewise rules out only the index's current version, without the conditions above.)
    const pin = installed.get(cfg.name);
    const candidates =
      cfg.version !== undefined
        ? [cfg.version]
        : [pin?.targetVersion, pin?.installedVersion].filter((v): v is string => v !== undefined);
    const keepOlder =
      entry.hostApiVersion > hostApiVersion &&
      (entry.intents ?? []).length === 0 &&
      candidates.length > 0 &&
      candidates.every((v) => isOlderVersion(v, entry.version));
    if (entry.hostApiVersion !== hostApiVersion && !keepOlder) {
      selected.push({
        name: cfg.name,
        entry,
        pinnedVersion: cfg.version,
        skipped: `needs host API v${entry.hostApiVersion}, this bot is v${hostApiVersion}`,
      });
      continue;
    }

    // #185: a plugin's OWN name (not its commands) becomes its interaction-routing prefix
    // (`<name>:`) — core's `report:` modal prefix is already reserved (src/report.ts's
    // MODAL_PREFIX), so a plugin literally named "report" would have every one of its own modal
    // submissions silently swallowed by the core handler instead of reaching it, regardless of
    // whether any of its commands happen to collide. `coreCommandNames` already IS that reserved
    // set (it's what the command-collision check below guards), so reusing it here for the name
    // itself is the same reservation, extended to the one place a plugin's `name` (not its
    // `commands`) is what actually matters.
    if (coreCommandNames.includes(cfg.name)) {
      selected.push({
        name: cfg.name,
        entry,
        pinnedVersion: cfg.version,
        skipped: `plugin name "${cfg.name}" collides with the core command "${cfg.name}" — its interaction-routing prefix "${cfg.name}:" is reserved`,
      });
      continue;
    }

    const collision = entry.commands.find((bare) => claimedBy.has(bare));
    if (collision !== undefined) {
      const owner = claimedBy.get(collision)!;
      selected.push({
        name: cfg.name,
        entry,
        pinnedVersion: cfg.version,
        skipped:
          owner === "core"
            ? `command "${collision}" collides with the core command`
            : `command "${collision}" collides with plugin "${owner}"`,
      });
      continue;
    }

    for (const bare of entry.commands) claimedBy.set(bare, cfg.name);
    selected.push({ name: cfg.name, entry, pinnedVersion: cfg.version });
  }
  return selected;
}

/**
 * `selectPlugins`' `installed` argument, built from the previous boot's `state.json`: each named
 * plugin's last-good `installedVersion` and #104's transient `targetVersion`. Total on purpose —
 * `readJsonOrFresh` guarantees the file PARSED, not that it has the shape `PluginStateFile`
 * declares, and this runs in index.ts's top-level boot block, where a throw would take the whole bot
 * down instead of degrading (a plugin never crashes the bot, ADR-0004). Anything unrecognised
 * contributes no pin, so that plugin is judged on its explicit `PLUGINS=` pin alone — as if there
 * were no state.json.
 */
export function pinsFromState(state: unknown): Map<string, VersionPins> {
  const pins = new Map<string, VersionPins>();
  const plugins = (state as { plugins?: unknown } | null | undefined)?.plugins;
  if (!Array.isArray(plugins)) return pins;
  for (const p of plugins) {
    if (typeof p !== "object" || p === null) continue;
    const { name, installedVersion, targetVersion } = p as Record<string, unknown>;
    if (typeof name !== "string") continue;
    const pin: VersionPins = {};
    if (typeof installedVersion === "string") pin.installedVersion = installedVersion;
    if (typeof targetVersion === "string") pin.targetVersion = targetVersion;
    if (pin.installedVersion !== undefined || pin.targetVersion !== undefined) pins.set(name, pin);
  }
  return pins;
}

/** One `"<name>: <reason>"` line per skipped plugin, for the caller to log — kept out of this
 * otherwise I/O-free module's own responsibility so the reasons stay unit-testable without a
 * console spy. */
export function describeSkips(selected: readonly SelectedPlugin[]): string[] {
  return selected.filter((sp): sp is SelectedPlugin & { skipped: string } => sp.skipped !== undefined).map((sp) => `${sp.name}: ${sp.skipped}`);
}

/** Deduped union of `core` and every non-skipped plugin's declared intents, in first-seen order. */
export function collectIntents(core: readonly number[], selected: readonly SelectedPlugin[]): number[] {
  const seen = new Set<number>(core);
  const result = [...core];
  for (const sp of selected) {
    if (sp.skipped || !sp.entry) continue;
    for (const intent of sp.entry.intents ?? []) {
      if (!seen.has(intent)) {
        seen.add(intent);
        result.push(intent);
      }
    }
  }
  return result;
}
