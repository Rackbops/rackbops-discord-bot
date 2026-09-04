import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// index.ts can't be imported directly in a test: its top-level code runs the whole boot sequence
// (resolveBootMode, client.login(...)) as a side effect of module evaluation, so `import`ing it
// here would attempt a real Discord login. A source-level check is the only way to guard that it
// actually wires up the mention-safe Client (#48) — createClient() from ./client — rather than
// reintroducing an inline `new Client(...)` with no allowedMentions default.
describe("index.ts wiring", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  test("constructs its Client via createClient(collectIntents(...)), not an inline `new Client(...)`", () => {
    expect(source).toMatch(/\bcreateClient\(collectIntents\(/);
    expect(source).not.toMatch(/new Client\(/);
  });

  test("loads the Plugin Index and selects plugins before the Client is constructed", () => {
    const loadCall = source.indexOf("loadPluginIndex(");
    const selectCall = source.indexOf("selectPlugins(");
    const createCall = source.indexOf("createClient(collectIntents(");
    expect(loadCall).toBeGreaterThan(-1);
    expect(selectCall).toBeGreaterThan(-1);
    expect(createCall).toBeGreaterThan(-1);
    expect(loadCall).toBeLessThan(createCall);
    expect(selectCall).toBeLessThan(createCall);
  });

  test("no plugin code is imported — only the manifest reader and pure selection", () => {
    expect(source).not.toMatch(/\bimport\(/);
  });
});
