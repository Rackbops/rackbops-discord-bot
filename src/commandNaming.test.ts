import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// commands.ts pulls in the `config` singleton -- the required vars are primed once by test/setup.ts's
// bunfig preload (#136).
const { prefixedName, commandNamer } = await import("./commandNaming");
const { CORE_COMMAND_NAMES } = await import("./commands");

describe("prefixedName", () => {
  test("joins COMMAND_PREFIX and the bare name, with nothing between", () => {
    expect(prefixedName("pip", "update")).toBe("pipupdate");
    expect(prefixedName("r", "plugins")).toBe("rplugins");
    expect(prefixedName("r_", "dmf")).toBe("r_dmf");
    expect(prefixedName("", "report")).toBe("report");
  });

  test("commandNamer registers a command under exactly that name", () => {
    expect(commandNamer("pip")("plugins").name).toBe("pipplugins");
    expect(commandNamer("")("report").name).toBe("report");
  });
});

/**
 * A core command named bare: `/report`, `/update` or `/plugins` as a name, written the way a reply
 * writes one (after a quote, backtick or space). Not when it is a path segment (`./update`,
 * `data/plugins/`, `${DATA_DIR}/plugins/state.json`, `/containers/${id}/update` -- anything straight
 * after a word character, `.`, `}`, `/` or `-`), an escaped slash in a regex literal (`\/update`), or
 * a longer word (`/updates`). One pattern, shared by the scan and the probe test that pins what it
 * catches, so weakening it fails that test.
 */
const BARE_CORE_NAME = new RegExp(`(?<![\\w.}/\\\\-])/(?:${CORE_COMMAND_NAMES.join("|")})(?![\\w/-])`);

/** Comments dropped by a real parser (Bun's own transpiler), so a doc comment that says "`/update`
 *  is gated on ..." isn't mistaken for a reply, and no runtime string or code is lost the way a
 *  regex stripper loses it (a `src/plugins/*` inside a line comment opens no block here). Types go
 *  too, string-literal types included, which is fine: no type reaches a user. */
const transpiler = new Bun.Transpiler({ loader: "ts" });
function codeOf(source: string): string {
  return transpiler.transformSync(source);
}

/** The files the scan read (`/`-separated, relative to `src/`), and each `file: line` of their
 *  transpiled code that names a core command bare. Tests are excluded. */
function scanForBareCoreCommandNames(): { scanned: string[]; found: string[] } {
  const srcDir = import.meta.dir;
  const scanned: string[] = [];
  const found: string[] = [];
  for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: srcDir })) {
    if (file.endsWith(".test.ts")) continue;
    const name = file.replaceAll("\\", "/");
    scanned.push(name);
    for (const line of codeOf(readFileSync(join(srcDir, file), "utf8")).split("\n")) {
      if (BARE_CORE_NAME.test(line)) found.push(`${name}: ${line.trim()}`);
    }
  }
  return { scanned, found };
}

// Every command is registered as `prefixedName(COMMAND_PREFIX, name)`, so on a `pip` instance the
// commands are `/pipupdate`, `/pipplugins`, `/pipreport` and the bare names do not exist there. A
// reply, DM or issue footer that tells someone to run `/update` sends them looking for nothing. Name
// the command with `interaction.commandName` (what the user typed) or, with no interaction at hand,
// `prefixedName(config.commandPrefix, "<name>")`. Six strings had this bug at once, so it is a
// standing check rather than a per-string test: reverting any one of them to a literal fails here.
// A tripwire, not a proof: anything BARE_CORE_NAME exempts slips by -- for example a name built at
// runtime (`"/" + "update"`), or written straight after a `}` (`${emoji}/update`) or a `-`.
// src/commandPrefix.test.ts checks the actual replies under a real prefix.
describe("no user-facing string names a core command without its COMMAND_PREFIX", () => {
  test("the pattern catches a bare name and leaves paths, regexes and prefixed names alone", () => {
    expect(CORE_COMMAND_NAMES).toEqual(["report", "update", "plugins"]);
    // What it must catch...
    expect(BARE_CORE_NAME.test("enable `/update`.")).toBe(true);
    expect(BARE_CORE_NAME.test('"`/report` isn\'t configured"')).toBe(true);
    expect(BARE_CORE_NAME.test("See `/plugins list`.")).toBe(true);
    expect(BARE_CORE_NAME.test("Unknown /plugins subcommand")).toBe(true);
    expect(BARE_CORE_NAME.test("'/update'")).toBe(true);
    // ...and what it must leave alone.
    expect(BARE_CORE_NAME.test('import { x } from "./update";')).toBe(false);
    expect(BARE_CORE_NAME.test("`${DATA_DIR}/plugins/state.json`")).toBe(false);
    expect(BARE_CORE_NAME.test("`/containers/${id}/update`")).toBe(false);
    expect(BARE_CORE_NAME.test("const r = /\\/update$/;")).toBe(false);
    expect(BARE_CORE_NAME.test("enable `/${interaction.commandName}`")).toBe(false);
    expect(BARE_CORE_NAME.test("enable `/pipupdate`")).toBe(false);
    expect(BARE_CORE_NAME.test("/updates")).toBe(false);
  });

  test("comments are dropped and code is kept, including after a `/*` inside a line comment", () => {
    const code = codeOf(
      [
        "/** `/update` is gated */",
        "export const a = 1; // see `/plugins`",
        "// src/plugins/* stays dependency-free",
        'export const m = "see `/report`";',
        "// end */",
        'export const u = "a//b"; export const n = "`/update` here";',
      ].join("\n"),
    );
    expect(code).not.toContain("is gated");
    expect(code).not.toContain("see `/plugins`");
    expect(code).toContain('"see `/report`"'); // a fake block opener in a line comment eats nothing
    expect(code).toContain('"`/update` here"'); // nor does a `//` inside a string
    expect(code.split("\n").filter((line) => BARE_CORE_NAME.test(line))).toHaveLength(2);
  });

  test("src/ has none", () => {
    const { scanned, found } = scanForBareCoreCommandNames();
    // "Found nothing" only means something if the walk read the files the bug lived in.
    expect(scanned).toEqual(expect.arrayContaining(["commands.ts", "report.ts", "plugins/updates.ts", "announce.ts"]));
    expect(found).toEqual([]);
  });
});
