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

  // #168: the data-dir log line MOVED into src/bootLog.ts (so it and the new env-file line both
  // print before ./config's module-body resolveConfig can throw) — index.ts itself no longer
  // contains the literal text, only the import that runs it first. See bootLog.test.ts for the
  // #139 data-dir coverage this test used to carry directly.
  test("imports ./bootLog as its FIRST import, so the boot log runs before ./config can throw (#168)", () => {
    const firstImport = source.match(/^import\s+(?:[^;]+?\s+from\s+)?["']([^"']+)["'];/m)?.[1];
    expect(firstImport).toBe("./bootLog");
    // Mutation: a bare literal-string check alone would still pass if a real import moved above the
    // bootLog line but happened to also match some other regex — assert ordering explicitly too.
    expect(source.indexOf('import "./bootLog";')).toBeLessThan(source.indexOf('from "./config"'));
  });

  test("loads the Plugin Index, selects plugins, and logs skip reasons before the Client is constructed", () => {
    const loadCall = source.indexOf("loadPluginIndex(");
    const selectCall = source.indexOf("selectPlugins(");
    const describeCall = source.indexOf("describeSkips(");
    const createCall = source.indexOf("createClient(collectIntents(");
    expect(loadCall).toBeGreaterThan(-1);
    expect(selectCall).toBeGreaterThan(-1);
    expect(describeCall).toBeGreaterThan(-1);
    expect(createCall).toBeGreaterThan(-1);
    expect(loadCall).toBeLessThan(createCall);
    expect(selectCall).toBeLessThan(createCall);
    expect(describeCall).toBeLessThan(createCall);
  });

  test("no plugin code loads at module-eval — the bundle import() is inside activate(), after takeOver", () => {
    const activateFn = source.indexOf("async function activate(");
    const dynImport = source.indexOf("import(pathToFileURL");
    expect(activateFn).toBeGreaterThan(-1);
    expect(dynImport).toBeGreaterThan(activateFn); // the only dynamic import is inside activate()
    // the top-level boot block (before activate) must run NO dynamic import
    expect(source.slice(0, activateFn)).not.toMatch(/\bimport\(/);
  });

  test("installs+loads plugins inside activate() before rest.put, and activates before the scheduler", () => {
    const activateFn = source.indexOf("async function activate(");
    const install = source.indexOf("installPlugins(", activateFn);
    const load = source.indexOf("loadPlugins(", activateFn);
    const interactionOn = source.indexOf("client.on(Events.InteractionCreate", activateFn);
    const activatePlugins = source.indexOf("await activatePlugins(", activateFn);
    const startSched = source.indexOf("startScheduler(client", activateFn);
    const restPut = source.indexOf("rest.put(", activateFn);
    const report = source.indexOf("reportUpdateOutcome(", activateFn);
    // #104: the plugin update-report call. "reportUpdateOutcome(" is NOT a substring of
    // "reportPluginUpdateOutcome(" (…report P lugin…, not …report U pdate…), so the scan above finds
    // the /update report, and this finds the plugin one.
    const markReady = source.indexOf("markPluginStateReady(", activateFn);
    const pluginReport = source.indexOf("reportPluginUpdateOutcome(", activateFn);
    for (const pos of [install, load, interactionOn, activatePlugins, startSched, restPut, report, markReady, pluginReport])
      expect(pos).toBeGreaterThan(-1);
    expect(install).toBeLessThan(restPut); // builders come from the bundles
    expect(load).toBeLessThan(restPut);
    expect(activatePlugins).toBeLessThan(startSched); // #107: activate first so the scheduler's first synchronous tick runs plugin ticks (running=true) at boot
    expect(activatePlugins).toBeLessThan(report);
    expect(markReady).toBeLessThan(pluginReport); // report-back clears its marker via the now-live mutator
    // #59/#143: neither the interaction handler nor plugin activation/the scheduler depends on
    // command registration having completed — attaching/starting them first cuts the "no handler,
    // no ticks" window (worst on a self-update handoff) by the rest.put round-trip.
    expect(interactionOn).toBeLessThan(restPut);
    expect(activatePlugins).toBeLessThan(restPut);
    expect(startSched).toBeLessThan(restPut);
  });

  test("no ./warbandeer import remains — the baked-in connector is gone (#100)", () => {
    expect(source).not.toMatch(/from "\.\/warbandeer\//);
  });

  // #154: the first (and only) signal handler in this codebase. Registered before resolveBootMode
  // so even a standby stopped mid-verify (nothing has started yet — trivially idle) drains cleanly,
  // rather than the daemon's SIGKILL being the first thing that ever touches it.
  test("registers SIGTERM and SIGINT handlers before resolveBootMode is called (#154)", () => {
    const sigterm = source.indexOf('process.on("SIGTERM"');
    const sigint = source.indexOf('process.on("SIGINT"');
    const resolveBootModeCall = source.indexOf("await resolveBootMode(");
    expect(sigterm).toBeGreaterThan(-1);
    expect(sigint).toBeGreaterThan(-1);
    expect(resolveBootModeCall).toBeGreaterThan(-1);
    expect(sigterm).toBeLessThan(resolveBootModeCall);
    expect(sigint).toBeLessThan(resolveBootModeCall);
  });

  // Both signals must share the exact same handler instance (createShutdownHandler called once) —
  // two separately-built handlers would each hold their own `draining` flag, so a SIGTERM then a
  // SIGINT would wrongly start a second, independent drain instead of being recognised as "already
  // draining, exit now."
  test("both signals are registered against the SAME handler instance, not two separately-built ones", () => {
    const createCalls = (source.match(/createShutdownHandler\(/g) ?? []).length;
    expect(createCalls).toBe(1);
    const handlerVar = source.match(/const (\w+) = createShutdownHandler\(/)?.[1];
    expect(handlerVar).toBeTruthy();
    expect(source).toMatch(new RegExp(`process\\.on\\("SIGTERM",\\s*${handlerVar}\\)`));
    expect(source).toMatch(new RegExp(`process\\.on\\("SIGINT",\\s*${handlerVar}\\)`));
  });

  // #184: the shutdown handler is wired (and process.on registered) before activate() ever runs,
  // so disposePlugins can't just close over loadResult.loaded directly — it needs a module-level
  // variable activate() assigns into, read live at signal time.
  test("createShutdownHandler is passed a disposePlugins dep", () => {
    const createCallStart = source.indexOf("createShutdownHandler(");
    expect(createCallStart).toBeGreaterThan(-1);
    const createCallEnd = source.indexOf("});", createCallStart);
    const createCallBody = source.slice(createCallStart, createCallEnd);
    expect(createCallBody).toMatch(/disposePlugins:\s*\(\)\s*=>\s*disposePlugins\(/);
  });

  test("assigns the module-level loaded-plugins variable inside activate(), after loadPlugins resolves", () => {
    const activateFn = source.indexOf("async function activate(");
    const loadCall = source.indexOf("await loadPlugins(", activateFn);
    // the variable the shutdown handler's disposePlugins closure reads — declared once, at module
    // scope, before the handler is built, then assigned here once real plugins exist.
    const varDecl = source.match(/let (\w+): readonly LoadedPlugin\[\] = \[\];/)?.[1];
    expect(varDecl).toBeTruthy();
    expect(loadCall).toBeGreaterThan(-1);
    const assignment = source.indexOf(`${varDecl} = loadResult.loaded;`, loadCall);
    expect(assignment).toBeGreaterThan(loadCall); // assigned only after the real load result exists
  });
});
