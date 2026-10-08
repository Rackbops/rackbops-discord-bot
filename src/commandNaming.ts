import { SlashCommandBuilder } from "discord.js";

// Extracted from commands.ts so the plugin loader (src/plugins/host.ts) can name plugin commands
// through the same namer WITHOUT importing commands.ts — host.ts imports commands.ts's commandNamer
// was the one host→commands edge, and it made commands.ts unable to import host.ts back (the shared
// state.json mutator). With the namer here, that cycle is gone and #104's /plugins handlers can use
// host.ts's mutatePluginState.

/** The name a bare command is registered (and typed) under: `prefixedName("pip", "update")` →
 *  `pipupdate`. The one place the prefix and a name are joined — `commandNamer` registers through
 *  it, `buildCommandBody` (src/plugins/host.ts) checks a plugin's built name against it, and a
 *  user-facing string that names a command with no interaction to read it from (a DM, an issue
 *  footer) builds the name with it too. Where an interaction IS at hand, its `commandName` is this
 *  same string, as Discord delivered it. */
export function prefixedName(prefix: string, name: string): string {
  return `${prefix}${name}`;
}

/** Returns a builder-namer bound to `prefix`: `commandNamer("r_")("dmf")` → a `SlashCommandBuilder`
 *  already named `r_dmf`. Both core commands (commands.ts) and plugin commands (host.ts) build
 *  through this, keeping every command inside the `COMMAND_PREFIX` namespace. */
export function commandNamer(prefix: string): (name: string) => SlashCommandBuilder {
  return (name: string) => new SlashCommandBuilder().setName(prefixedName(prefix, name));
}
