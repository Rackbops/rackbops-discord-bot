// Run as a CHILD `bun test` by test/setup.test.ts (#403, #462) -- the `.fixture.ts` name keeps it out of
// discovery, as test/stateLeak.fixture.ts explains. It asserts the environment the preload leaves behind and
// prints the temp root the preload swept, so the parent can tell a platform that ignored TMPDIR by name.
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { config, resolveConfig } from "../src/config";

test("the preload forces the test environment and clears every ambient key it reads", () => {
  console.log(`[preload.fixture] tmpdir=${tmpdir()}`);
  // A deep-equal, so any surviving key names its field. Extend this expected env ONLY with keys the preload itself sets.
  expect(config).toEqual(resolveConfig({ DISCORD_TOKEN: "test-token", ANNOUNCE_CHANNEL_ID: "100", COMMAND_PREFIX: "" }));
  expect(process.env.LOG_FORMAT).toBeUndefined();
  expect(process.env.PLUGIN_REGISTRY_URL).toBeUndefined();
  expect(process.env.GITHUB_TOKEN).toBeUndefined();
  expect(process.env.BOT_DOCKER_SOCKET).toBeUndefined();
  expect(process.env.COMMAND_PREFIX).toBe("");
});
