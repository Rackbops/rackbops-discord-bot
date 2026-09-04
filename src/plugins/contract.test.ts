import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HOST_API_VERSION } from "./contract";

// The contract is read before the discord.js Client exists and is vendored verbatim into the plugins
// repo, so it must stay a pure type module: no runtime code beyond one integer export. Pinned three
// ways. The strict one is what survives type stripping: Bun's transpiler drops `import type`,
// interfaces and type aliases, so a value import, a re-export, a dynamic import or a stray statement
// all show up in its output — including on a line shared with an `import type`, which a
// start-of-line regex alone would miss. The source-level checks stay as the readable explanation.
describe("src/plugins/contract.ts", () => {
  const source = readFileSync(new URL("./contract.ts", import.meta.url), "utf8");
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  test("stripped of types, the module is exactly `export const HOST_API_VERSION = 1;`", () => {
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    expect(js.replace(/\s+/g, " ").trim()).toBe("export const HOST_API_VERSION = 1;");
  });

  test("every `import` in the source is `import type`; no require, no re-exports", () => {
    const imports = [...withoutComments.matchAll(/\bimport\b(?!\.meta)/g)];
    expect(imports.length).toBeGreaterThan(0);
    for (const m of imports) {
      expect(withoutComments.slice(m.index, m.index + 12)).toMatch(/^import\s+type\b/);
    }
    expect(withoutComments).not.toMatch(/\brequire\s*\(/);
    expect(withoutComments).not.toMatch(/^\s*export\b.*\bfrom\b/m);
  });

  test("HOST_API_VERSION is the only runtime export, and it is 1", async () => {
    const mod = await import("./contract");
    expect(Object.keys(mod)).toEqual(["HOST_API_VERSION"]);
    expect(HOST_API_VERSION).toBe(1);
  });
});
