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
});
