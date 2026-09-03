import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// index.ts can't be imported directly in a test: its top-level code runs the whole boot sequence
// (resolveBootMode, client.login(...)) as a side effect of module evaluation, so `import`ing it
// here would attempt a real Discord login. A source-level check is the only way to guard that it
// actually wires up the mention-safe Client (#48) — createClient() from ./client — rather than
// reintroducing an inline `new Client(...)` with no allowedMentions default.
describe("index.ts wiring", () => {
  test("constructs its Client via createClient(), not an inline `new Client(...)`", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/\bcreateClient\(\)/);
    expect(source).not.toMatch(/new Client\(/);
  });
});
