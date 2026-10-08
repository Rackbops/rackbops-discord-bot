// Child-process fixture for src/commandPrefix.test.ts: a bot process started under a real, non-empty
// COMMAND_PREFIX. Not a test file itself: the parent spawns it with the env it needs, it prints one
// JSON object on stdout, and exits.
//
// Why a separate process: config resolves process.env once, at import, and bun runs every test file
// in ONE process -- so `commands.ts`'s module-level prefix is "" for the whole suite, and nothing in it
// can see what a `pip` instance's own dispatch and replies do. Here the prefix is real from the first
// import. And the process-global state this reads or flips (restart.ts's handoff flag, update.ts's
// in-flight flag, announce.ts's plugin-state-ready flag, the admin list) starts fresh and dies with
// the process, instead of depending on, or leaking into, whichever test file ran before.
//
// Expects from the parent: COMMAND_PREFIX, BOT_DATA_DIR (a fresh temp dir), and ADMIN_USER_IDS,
// REPORT_ROLE_ID, GIT_SHA all empty. PLUGIN_INDEX_URL should point nowhere real; fetch is stubbed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INDEX = {
  schemaVersion: 1,
  generatedAt: "2026-10-01T00:00:00.000Z",
  plugins: [
    { name: "demo", package: "@x/demo", version: "1.1.0", description: "d", hostApiVersion: 1, commands: [], env: [], releases: [] },
  ],
};
globalThis.fetch = (async () => new Response(JSON.stringify(INDEX), { status: 200 })) as unknown as typeof fetch;

const { config } = await import("../src/config");
const { DATA_DIR } = await import("../src/storage");
const { handleCommand, commandData } = await import("../src/commands");
const { markPluginStateReady } = await import("../src/announce");

/** Dispatch one chat-input interaction through the real handleCommand; the last thing it said. */
async function dispatch(commandName: string, userId: string, sub = "list", name: string | null = null): Promise<string> {
  let said = "(nothing)";
  const capture = async (o: unknown) => {
    said = typeof o === "string" ? o : String((o as { content?: unknown }).content);
  };
  const interaction = {
    commandName,
    user: { id: userId },
    channelId: "1",
    applicationId: "2",
    token: "t",
    options: {
      getSubcommand: () => sub,
      getString: (key: string) => (key === "name" ? name : null),
      getInteger: () => null,
    },
    reply: capture,
    deferReply: async () => {},
    editReply: capture,
  };
  await handleCommand(interaction as never);
  return said;
}

const p = config.commandPrefix;
const out: Record<string, unknown> = { prefix: p, registered: commandData.map((c) => c.name) };

// A non-admin, no admins configured, /report unconfigured: the three refusals.
out.refuseUpdate = await dispatch(`${p}update`, "999");
out.refusePlugins = await dispatch(`${p}plugins`, "999");
out.refuseReport = await dispatch(`${p}report`, "999");

// An admin, before the plugin state is ready: what only each admin-gated row's own body does (the
// row-swap guard). /update with no GIT_SHA answers "disabled" before any network; /plugins update
// refuses until the boot state.json write has landed.
config.adminUserIds.push("111");
out.adminUpdate = await dispatch(`${p}update`, "111");
out.adminPluginsNotReady = await dispatch(`${p}plugins`, "111", "update", "demo");

// The plugin state ready, with one plugin ("demo") installed: the two /plugins replies that name the
// command back to the admin.
mkdirSync(join(DATA_DIR, "plugins"), { recursive: true });
writeFileSync(
  join(DATA_DIR, "plugins", "state.json"),
  JSON.stringify({ hostApiVersion: 1, writtenAt: "", plugins: [{ name: "demo", enabled: true, installedVersion: "1.0.0" }] }),
);
markPluginStateReady();
out.notInstalled = await dispatch(`${p}plugins`, "111", "update", "nope");
out.unknownSubcommand = await dispatch(`${p}plugins`, "111", "bogus", "demo");

console.log(JSON.stringify(out));
process.exit(0);
