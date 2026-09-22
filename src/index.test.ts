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

  // #222: without the previous boot's version pins, a plugin that is last-good (rather than explicitly
  // pinned) on an older version is disabled the moment the index moves to a version declaring a different
  // host API. registry.test.ts pins the logic; this pins the one thing it cannot see — that the top-level
  // boot block actually reads the pins BEFORE selecting (not inside activate(), which runs after the
  // Client is built) and hands them to selectPlugins as its 5th argument.
  test("reads state.json's version pins before selectPlugins and passes them in (#222)", () => {
    const activateFn = source.indexOf("async function activate(");
    const pinsRead = source.indexOf("pinsFromState(await readPluginState(");
    const selectCall = source.indexOf("selectPlugins(");
    expect(pinsRead).toBeGreaterThan(-1);
    expect(pinsRead).toBeLessThan(selectCall);
    expect(selectCall).toBeLessThan(activateFn);
    // the variable handed to selectPlugins is the one built from that read
    expect(source).toMatch(/const installedPins = pinsFromState\(await readPluginState\(DATA_DIR, bootStorage\)\);/);
    const selectArgs = source.slice(selectCall, source.indexOf(");", selectCall));
    expect(selectArgs).toMatch(/CORE_COMMAND_NAMES,\s*installedPins,?\s*$/);
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

  // #239: registration moved into src/routing/, but with no routing the bot must make EXACTLY the call
  // it always made. index.ts can't run under test, so the shape of the wiring is pinned in the source.
  describe("command registration is routed through src/routing (#239)", () => {
    const activateFn = source.indexOf("async function activate(");
    const initCall = source.indexOf("initRouting({", activateFn);
    const applyCall = source.indexOf('applyRouting("boot")', activateFn);
    const catchMessage = source.indexOf("[startup] slash-command registration failed", activateFn);
    // The text of the initRouting({...}) call alone: a property name like `log:` or `dataDir:` appears
    // elsewhere in this file, so a pin on the whole source could pass while this call is wrong.
    const initBlock = source.slice(initCall, applyCall);

    test("the one rest.put is the REST call it always was: the route, and the body as `{ body }`", () => {
      // Exactly one, and it is the injected `put` -- so every registration goes through the planner.
      expect((source.match(/rest\.put\(/g) ?? []).length).toBe(1);
      expect(source).toMatch(/put:\s*\(route,\s*body\)\s*=>\s*rest\.put\(route,\s*\{\s*body\s*\}\)/);
    });

    test("initRouting is given the full command body, built once", () => {
      expect(initBlock).toMatch(/fullBody:\s*commandBody,/);
      // Plugin builders run once, not once per server: buildCommandBody is called exactly once.
      expect((source.match(/buildCommandBody\(/g) ?? []).length).toBe(1);
      // And the home server, prefix and data dir are the ones the old code read.
      expect(initBlock).toMatch(/homeGuildId:\s*config\.guildId,/);
      expect(initBlock).toMatch(/prefix:\s*config\.commandPrefix,/);
      expect(initBlock).toMatch(/dataDir:\s*DATA_DIR,/);
    });

    test("initRouting is given the bot's own id and name, the command map, and the loaded plugins' summaries", () => {
      // appId is the route's first argument in every PUT, so a wrong one is a wrong route.
      // The Client the servers are read from.
      expect(initBlock).toMatch(/client:\s*c,/);
      expect(initBlock).toMatch(/appId:\s*c\.user\.id,/);
      expect(initBlock).toMatch(/botUsername:\s*c\.user\.username,/);
      // The command map is how the planner finds each command's owner: an empty one would read every
      // plugin command as a core command and send it to every server.
      expect(initBlock).toMatch(/\n\s*commandMap,\n/);
      expect(initBlock).toMatch(
        /plugins:\s*describePlugins\(loadResult\.loaded,\s*commandBody,\s*config\.commandPrefix,\s*commandMap\),/,
      );
      expect(initBlock).toMatch(/now:\s*\(\)\s*=>\s*new Date\(\),/);
      expect(initBlock).toMatch(/log:\s*console,/);
    });

    test("initRouting and applyRouting sit inside the same try whose catch keeps a failure from taking the bot down", () => {
      expect(initCall).toBeGreaterThan(activateFn);
      expect(applyCall).toBeGreaterThan(initCall);
      const tryStart = source.lastIndexOf("try {", initCall);
      const catchStart = source.indexOf("} catch (err) {", applyCall);
      // Nothing between the `try {` and initRouting but the comment that explains it, and the catch that
      // follows applyRouting is the one with the operator message.
      expect(tryStart).toBeGreaterThan(source.lastIndexOf("startScheduler(client", initCall));
      expect(catchStart).toBeGreaterThan(applyCall);
      expect(catchMessage).toBeGreaterThan(catchStart);
      expect(source.slice(catchStart, catchMessage)).not.toMatch(/\btry\s*\{/);
    });

    test("today's `Registered N slash commands` line is printed for single mode only", () => {
      expect(source).toMatch(
        /const \{ mode: routingMode \} = await applyRouting\("boot"\);\s*\n\s*if \(routingMode === "single"\) console\.log\(`Registered \$\{commandBody\.length\} slash commands`\);/,
      );
      expect((source.match(/Registered \$\{commandBody\.length\} slash commands/g) ?? []).length).toBe(1);
      // The result's mode is not named `mode`: that is the module-level boot mode (standby or normal),
      // and shadowing it inside activate() invites an edit that means the other one.
      expect(source).not.toMatch(/const \{ mode \} = await applyRouting/);
    });

    test("the operator message for a failed registration is still there, word for word", () => {
      expect(source).toContain('"[startup] slash-command registration failed" +');
      expect(source).toContain('"; the bot keeps running, but its slash commands won\'t appear in that guild until this is" +');
      expect(source).toContain('" bot still needs the applications.commands scope for its commands to appear in a guild.",');
    });
  });

  // #243: where a plugin posts, and which channels its commands run in. index.ts can't run under test, so
  // the wiring is pinned in the source, in the same idiom as the block above.
  describe("plugin announcements and the channel gate are routed (#243)", () => {
    const activateFn = source.indexOf("async function activate(");
    const depsStart = source.indexOf("const postDeps: PostDeps = {", activateFn);
    const makeHostStart = source.indexOf("const makeHost = ", activateFn);
    // The text of the postDeps object alone: `log:` and `dataDir:` appear all over this file.
    const depsBlock = source.slice(depsStart, makeHostStart);
    const interactionStart = source.indexOf("client.on(Events.InteractionCreate", activateFn);
    const handleCall = source.indexOf("await handleCommand(", interactionStart);

    test("a plugin's announce goes through postForPlugin with its own name and the default channel", () => {
      expect(source).toMatch(/announce:\s*\(message\)\s*=>\s*postForPlugin\(entry\.name,\s*message,\s*postDeps\),/);
      // The old wiring -- every plugin posting straight to the one channel -- is gone.
      expect(source).not.toMatch(/announce:\s*\(message\)\s*=>\s*announceTo\(/);
      expect(depsBlock).toMatch(/defaultChannelId:\s*config\.announceChannelId,/);
    });

    test("postDeps is built once, in activate(), before the hosts are made", () => {
      expect(activateFn).toBeGreaterThan(-1);
      expect(depsStart).toBeGreaterThan(activateFn);
      expect(makeHostStart).toBeGreaterThan(depsStart);
      expect((source.match(/const postDeps: PostDeps = \{/g) ?? []).length).toBe(1);
    });

    test("announceTo is still the bot's send path", () => {
      expect(depsBlock).toMatch(/sendAsBot:\s*\(channelId,\s*message\)\s*=>\s*announceTo\(client,\s*channelId,\s*message\),/);
      expect(source).toMatch(/import \{[^}]*\bannounceTo\b[^}]*\} from "\.\/announce";/);
    });

    test("routing and secrets are read from the data dir, the webhook goes out over the real fetch, and a dead one is marked in the data dir", () => {
      expect(depsBlock).toMatch(/readRouting:\s*\(\)\s*=>\s*readRouting\(DATA_DIR\),/);
      expect(depsBlock).toMatch(/readSecrets:\s*\(\)\s*=>\s*readSecrets\(DATA_DIR\),/);
      expect(depsBlock).toMatch(/executeWebhook:\s*liveExecuteWebhook\(\),/);
      expect(depsBlock).toMatch(/markBroken:\s*markWebhookBroken\(DATA_DIR\),/);
      expect(depsBlock).toMatch(/log:\s*console,/);
    });

    test("the interaction handler passes a gate built from whereOf and gateCommand", () => {
      // Only a chat-input command is gated: the call is inside the isChatInputCommand branch.
      expect(interactionStart).toBeGreaterThan(activateFn);
      expect(handleCall).toBeGreaterThan(interactionStart);
      expect(source.lastIndexOf("interaction.isChatInputCommand()", handleCall)).toBeGreaterThan(interactionStart);
      const handleBlock = source.slice(handleCall, source.indexOf("} else if", handleCall));
      expect(handleBlock).toMatch(/\(bare\)\s*=>\s*commandMap\.get\(bare\)\?\.command,/);
      // whereOf is handed over as a thunk, never awaited here: the gate calls it only when the channel's own
      // id cannot decide, so a plugin with no routing (or a listed channel, or a DM) costs no Discord fetch.
      expect(handleBlock).toMatch(/\(\)\s*=>\s*whereOf\(chatInput,\s*\(id\)\s*=>\s*client\.channels\.fetch\(id\)\)/);
      expect(handleBlock).not.toMatch(/await\s+whereOf\(/);
      // The plugin that owns the command is the one whose routing decides, and the command name shown is the registered one.
      expect(handleBlock).toMatch(
        /gateCommand\(\s*commandMap\.get\(bare\)\?\.entry\.name,\s*chatInput\.commandName,\s*chatInput,\s*\(\)\s*=>\s*whereOf\([^]*?\),\s*\(\)\s*=>\s*readRouting\(DATA_DIR\),\s*console,?\s*\)/,
      );
    });

    test("only plugin commands reach the gate: it is an argument to handleCommand, not a check in front of it", () => {
      // Core commands are resolved inside handleCommand before it consults the gate (commands.ts), so no
      // gateCommand call may sit outside the handleCommand call.
      expect((source.match(/gateCommand\(/g) ?? []).length).toBe(1);
      expect(source.slice(0, handleCall)).not.toMatch(/gateCommand\(/);
    });
  });

  // #218: the host routes no autocomplete to plugins — index.ts can't run under test, so the branch's
  // shape is pinned in the source, the same idiom as the describes above.
  describe("an autocomplete interaction is answered with an empty list inside the InteractionCreate handler (#218)", () => {
    test("the branch exists inside the handler, and respond([]) appears exactly once in the file", () => {
      const start = source.indexOf("client.on(Events.InteractionCreate");
      const end = source.indexOf("client.on(Events.GuildCreate");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const handlerBlock = source.slice(start, end);
      expect(handlerBlock).toMatch(/else if \(interaction\.isAutocomplete\(\)\)\s*\{[\s\S]*?await interaction\.respond\(\[\]\);/);
      expect((source.match(/respond\(\[\]\)/g) ?? []).length).toBe(1);
    });
  });

  // #241: the request mailbox is also drained every few seconds on its own timer. index.ts can't run under
  // test, so the shape of the wiring is pinned in the source: that the timer is started at all, and how.
  describe("the request-mailbox timer is wired (#241)", () => {
    const activateFn = source.indexOf("async function activate(");
    const scheduler = source.indexOf("startScheduler(client", activateFn);
    const start = source.indexOf("startRequestDrain({", activateFn);
    // The text of the call alone, so a property name that appears elsewhere cannot satisfy a pin.
    const call = source.slice(start, source.indexOf("});", start));

    test("the request drain starts after the scheduler, gated on plugin state and restarts, inside a critical section", () => {
      expect(scheduler).toBeGreaterThan(activateFn);
      expect(start).toBeGreaterThan(scheduler);
      expect((source.match(/startRequestDrain\(/g) ?? []).length).toBe(1);
      expect(source).toMatch(/import \{ startRequestDrain \} from "\.\/plugins\/drain";/);
      // Nothing is drained until the boot state write and boot drain have landed...
      expect(call).toMatch(/ready:\s*isPluginStateReady,/);
      // ...none starts on the way out...
      expect(call).toMatch(/\n\s*restartPending,\n/);
      // ...and a drain is a critical section, so a restart an update-now asks for waits for it.
      expect(call).toMatch(/drain:\s*\(\)\s*=>\s*withCritical\(\(\)\s*=>\s*consumePluginRequests\(livePluginRequestDeps\(\)\)\),/);
      expect(call).toMatch(/log:\s*console,/);
    });

    test("every drain runs after initRouting: the boot drain follows registration and precedes the ready flag", () => {
      const init = source.indexOf("initRouting({", activateFn);
      const applied = source.indexOf('applyRouting("boot")', activateFn);
      const bootDrain = source.indexOf("await consumePluginRequests(livePluginRequestDeps())", activateFn);
      const ready = source.indexOf("markPluginStateReady();", activateFn);
      for (const pos of [init, applied, bootDrain, ready]) expect(pos).toBeGreaterThan(-1);
      expect(init).toBeLessThan(applied);
      expect(applied).toBeLessThan(bootDrain);
      // The timer's beats (and the tick's) are gated on this flag, so they cannot run before initRouting.
      expect(bootDrain).toBeLessThan(ready);
    });
  });

  // #259: joining and leaving a server. index.ts can't run under test, so the wiring is pinned in the source.
  describe("a server joined or left after boot is wired to guildJoined / guildLeft (#259)", () => {
    const activateFn = source.indexOf("async function activate(");
    const createListener = source.indexOf("client.on(Events.GuildCreate", activateFn);
    const deleteListener = source.indexOf("client.on(Events.GuildDelete", activateFn);
    const initCall = source.indexOf("initRouting({", activateFn);
    const bootCall = source.indexOf('applyRouting("boot")', activateFn);

    test("joining and leaving a server are wired to guildJoined / guildLeft, inside activate(), before the boot registration", () => {
      expect(activateFn).toBeGreaterThan(-1);
      expect(createListener).toBeGreaterThan(activateFn);
      expect(deleteListener).toBeGreaterThan(activateFn);
      // Attached before initRouting and the boot registration, so a server joined while that runs is not missed.
      expect(createListener).toBeLessThan(initCall);
      expect(deleteListener).toBeLessThan(initCall);
      expect(initCall).toBeLessThan(bootCall);
      expect(source).toMatch(/client\.on\(Events\.GuildCreate,\s*\(guild\)\s*=>\s*void guildJoined\(guild\)\);/);
      expect(source).toMatch(/client\.on\(Events\.GuildDelete,\s*\(guild\)\s*=>\s*void guildLeft\(guild\)\);/);
      for (const name of ["guildJoined", "guildLeft"]) {
        expect(source).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./routing/live";`));
      }
      // One of each: a second listener would register twice.
      expect((source.match(/Events\.GuildCreate/g) ?? []).length).toBe(1);
      expect((source.match(/Events\.GuildDelete/g) ?? []).length).toBe(1);
    });

    test("neither listener can reject into the emitter", () => {
      // `void`, and the functions are the never-rejecting ones -- not applyRouting, which can reject in single mode.
      expect((source.match(/void guildJoined\(guild\)/g) ?? []).length).toBe(1);
      expect((source.match(/void guildLeft\(guild\)/g) ?? []).length).toBe(1);
      expect(source).not.toMatch(/Events\.Guild(?:Create|Delete),\s*async/);
      expect(source).not.toMatch(/Events\.Guild(?:Create|Delete),[^\n]*(?:applyRouting|refreshDiscovery)/);
      expect(source).not.toMatch(/await guild(?:Joined|Left)\(/);
    });

    test("availability events are not wired: a server going into or coming back from an outage is neither a join nor a leave", () => {
      expect(source).not.toMatch(/Events\.GuildAvailable/);
      expect(source).not.toMatch(/Events\.GuildUnavailable/);
      expect(source).not.toMatch(/["']guildAvailable["']|["']guildUnavailable["']/);
    });
  });

  test("no ./warbandeer import remains — the baked-in connector is gone (#100)", () => {
    expect(source).not.toMatch(/from "\.\/warbandeer\//);
  });

  // #185: core's report: modal check must be an EARLIER branch in the same if/else-if chain as
  // plugin interaction dispatch, so core always wins that prefix regardless of what plugins are
  // installed -- a reordering (or splitting them into two independent `if`s that could both fire)
  // would let a plugin's dispatch run even for a report: modal submit.
  test("core's report: modal check comes before plugin interaction dispatch, in the same else-if chain", () => {
    const reportCheck = source.indexOf("isReportModal(interaction.customId)");
    const dispatchBranch = source.indexOf(
      '} else if (interaction.isMessageComponent() || interaction.isModalSubmit())',
    );
    const dispatchCall = source.indexOf("dispatchPluginInteraction(");
    expect(reportCheck).toBeGreaterThan(-1);
    expect(dispatchBranch).toBeGreaterThan(-1);
    expect(dispatchCall).toBeGreaterThan(-1);
    // Mutation: reordering the branches, or splitting them into two independent `if`s (either of
    // which could then both fire on the same interaction) fails one of these three.
    expect(reportCheck).toBeLessThan(dispatchBranch);
    expect(dispatchBranch).toBeLessThan(dispatchCall);
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
