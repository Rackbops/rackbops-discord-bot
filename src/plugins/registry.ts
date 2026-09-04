// Pure plugin selection — no I/O, no imports beyond the contract's types. Runs after the Plugin
// Index is loaded (src/plugins/index.ts) and before the discord.js Client is constructed
// (src/index.ts), so every skip decision here is made from data alone, never from plugin code.
import type { PluginIndex, PluginIndexEntry } from "./contract";

export interface ConfiguredPlugin {
  name: string;
  version?: string;
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
 * plugin that isn't published, needs a newer host, or whose command names collide with core or an
 * earlier-selected plugin. A skipped plugin is still returned (with `skipped` set) so a caller can
 * report why — this is what #99/#101/#102 read to build `state.json` and the panel's listing.
 */
export function selectPlugins(
  index: PluginIndex,
  configured: ConfiguredPlugin[],
  hostApiVersion: number,
  coreCommandNames: readonly string[],
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

    if (entry.hostApiVersion !== hostApiVersion) {
      selected.push({
        name: cfg.name,
        entry,
        pinnedVersion: cfg.version,
        skipped: `needs host API v${entry.hostApiVersion}, this bot is v${hostApiVersion}`,
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
