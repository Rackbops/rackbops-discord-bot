import { SlashCommandBuilder } from "discord.js";

// Extracted from commands.ts so the plugin loader (src/plugins/host.ts) can name plugin commands
// through the same namer WITHOUT importing commands.ts — host.ts imports commands.ts's commandNamer
// was the one host→commands edge, and it made commands.ts unable to import host.ts back (the shared
// state.json mutator). With the namer here, that cycle is gone and #104's /plugins handlers can use
// host.ts's mutatePluginState.

/** Returns a builder-namer bound to `prefix`: `commandNamer("r_")("dmf")` → a `SlashCommandBuilder`
 *  already named `r_dmf`. Both core commands (commands.ts) and plugin commands (host.ts) build
 *  through this, keeping every command inside the `COMMAND_PREFIX` namespace. */
export function commandNamer(prefix: string): (name: string) => SlashCommandBuilder {
  return (name: string) => new SlashCommandBuilder().setName(`${prefix}${name}`);
}
