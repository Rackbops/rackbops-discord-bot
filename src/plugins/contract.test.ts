import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HOST_API_VERSION } from "./contract";

// The contract is read before the discord.js Client exists and is vendored verbatim into the plugins
// repo, so it must stay a pure type module: type-only imports, no side effects, one integer export.
// Pinned at the source level (like index.test.ts) because a value import would only show up at boot.
describe("src/plugins/contract.ts", () => {
  const source = readFileSync(new URL("./contract.ts", import.meta.url), "utf8");

  test("every import is type-only, so importing the module runs nothing", () => {
    const imports = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^\s*import type\b/);
    expect(source).not.toMatch(/\brequire\(/);
  });

  test("HOST_API_VERSION is the only runtime export, and it is 1", async () => {
    const mod = await import("./contract");
    expect(Object.keys(mod)).toEqual(["HOST_API_VERSION"]);
    expect(HOST_API_VERSION).toBe(1);
  });
});
