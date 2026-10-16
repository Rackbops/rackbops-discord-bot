import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MessageFlags,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";

// report.ts pulls in the `config` singleton, which resolves process.env at import time -- the
// required vars are primed once by test/setup.ts's bunfig preload (#136).
const { handleReportCommand, handleReportModal, reportAnnouncement, REPORT_DM_REFUSAL } = await import("./report");
const { config, repoForProject } = await import("./config");

// Every test in this file runs as a member of a configured instance (a role, a token), and restores the shared
// config singleton and the globals it touches afterwards: every test file shares one process and one module
// registry, so a leaked role or prefix would reach other files (#447).
const ROLE = "role-1";
const realRole = config.reportRoleId;
const realToken = config.githubToken;
const realPrefix = config.commandPrefix;
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realError = console.error;
/** What `console.warn` / `console.error` were called with in the current test, joined to one string per call. */
let warns: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  config.reportRoleId = ROLE;
  config.githubToken = "test-token";
  warns = [];
  errors = [];
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
});
afterEach(() => {
  config.reportRoleId = realRole;
  config.githubToken = realToken;
  config.commandPrefix = realPrefix;
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.error = realError;
});

const WOW_REPO = repoForProject("wow")!;
const ISSUE_URL = `https://github.com/${WOW_REPO}/issues/7`;

/** Stand-in for GitHub: answers the label POST and the issue POST as asked, and records what was sent. */
function stubGithub(o: { label?: 201 | 422 | 500 | "reject"; issue?: 201 | 500 } = {}) {
  const seen = { urls: [] as string[], issues: [] as { title: string; body: string; labels: string[] }[] };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.urls.push(String(url));
    if (String(url).endsWith("/labels")) {
      if (o.label === "reject") throw new TypeError("fetch failed");
      return new Response("{}", { status: o.label ?? 201 });
    }
    if (String(url).endsWith("/issues")) {
      seen.issues.push(JSON.parse(String(init?.body)) as { title: string; body: string; labels: string[] });
      if (o.issue === 500) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ number: 7, html_url: ISSUE_URL }), { status: 201 });
    }
    throw new Error(`unstubbed fetch: ${String(url)}`);
  }) as unknown as typeof fetch;
  return seen;
}

/** A minimal stand-in for a `/report` slash command: what it replied and what modal it showed. */
function fakeCommand(o: { member: unknown; commandName?: string; project?: string }) {
  const calls = { replied: undefined as undefined | { content?: string; flags?: unknown }, modals: [] as unknown[] };
  const interaction = {
    commandName: o.commandName ?? "report",
    member: o.member,
    options: { getString: (name: string) => (name === "project" ? (o.project ?? "wow") : null) },
    reply: async (c: { content?: string; flags?: unknown }) => {
      calls.replied = c;
    },
    showModal: async (m: { toJSON(): unknown }) => {
      calls.modals.push(m.toJSON());
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, calls };
}

/** A minimal stand-in for a `report:<project>` modal submit, capturing what gets sent back. `editOutcomes[n]` says
 *  whether the n-th `editReply` resolves or rejects (default: resolves). The title, description and username default
 *  to random markers so a "never in the log" assertion can mean something. */
function fakeModalSubmit(o: {
  customId: string;
  title?: string;
  description?: string;
  username?: string;
  member?: unknown;
  editOutcomes?: ("ok" | "reject")[];
}) {
  const marks = {
    title: o.title ?? `title-${crypto.randomUUID()}`,
    description: o.description ?? `description-${crypto.randomUUID()}`,
    username: o.username ?? `user-${crypto.randomUUID()}`,
    userId: "424242424242424242",
  };
  const calls = {
    deferred: false,
    deferArgs: undefined as unknown,
    replied: undefined as undefined | { content?: string; flags?: unknown },
    edits: [] as unknown[],
    get edited(): unknown {
      return this.edits.at(-1);
    },
  };
  const interaction = {
    customId: o.customId,
    user: { username: marks.username, id: marks.userId },
    member: "member" in o ? o.member : { roles: [ROLE] },
    fields: {
      getTextInputValue: (id: string) => (id === "title" ? marks.title : marks.description),
    },
    deferReply: async (args?: unknown) => {
      calls.deferred = true;
      calls.deferArgs = args;
    },
    reply: async (content: { content?: string; flags?: unknown }) => {
      calls.replied = content;
    },
    editReply: async (content: unknown) => {
      const n = calls.edits.length;
      calls.edits.push(content);
      if (o.editOutcomes?.[n] === "reject") throw new Error("edit rejected");
    },
  } as unknown as ModalSubmitInteraction;
  return { interaction, calls, marks };
}

/** #503 item 11: a log line never carries what the reporter wrote -- the title, the description or the username. */
function expectNoReportTextInLog(marks: { title: string; description: string; username: string }): void {
  for (const line of [...warns, ...errors]) {
    expect(line).not.toContain(marks.title);
    expect(line).not.toContain(marks.description);
    expect(line).not.toContain(marks.username);
  }
}

// Every command is registered under COMMAND_PREFIX, so on a `pip` instance the user typed
// `/pipreport` and `/report` does not exist there. Both user-facing names must be the registered one.
describe("/report names itself by its registered (prefixed) name", () => {
  // Mutation: reverting the interpolation to the literal "`/report`" fails this.
  test("the not-configured refusal names the command the user typed", async () => {
    config.reportRoleId = undefined;
    for (const typed of ["pipreport", "rreport", "report"]) {
      let replied: { content?: string; flags?: unknown } | undefined;
      const interaction = {
        commandName: typed,
        reply: async (o: { content?: string; flags?: unknown }) => {
          replied = o;
        },
      } as unknown as ChatInputCommandInteraction;
      await handleReportCommand(interaction);
      expect(replied?.content).toBe(
        `\`/${typed}\` isn't configured — an admin must set \`REPORT_ROLE_ID\` and \`GITHUB_TOKEN\`.`,
      );
      expect(replied?.flags).toBe(MessageFlags.Ephemeral); // a refusal is the reporter's own business
      if (typed !== "report") expect(replied?.content).not.toContain("`/report`");
    }
  });

  // A modal submit has no commandName, so the footer's name comes from config.commandPrefix at submit
  // time. Mutation: passing a literal "report" to reportBody (or dropping the prefix) fails this.
  test("the filed issue's footer names the prefixed command", async () => {
    config.commandPrefix = "pip";
    const seen = stubGithub();

    const { interaction } = fakeModalSubmit({ customId: "report:wow", username: "alice" });
    await handleReportModal(interaction);

    expect(seen.issues).toHaveLength(1);
    expect(seen.issues[0]!.body).toContain("_Filed from Discord via `/pipreport` by **alice**._");
    expect(seen.issues[0]!.body).not.toContain("`/report`");
  });
});

// #447: the role gate on the command, in every shape a member can arrive in.
describe("handleReportCommand — the role gate and the modal", () => {
  const ROLE_REFUSAL = "You don't have the role required to file reports.";

  // Mutation: dropping the Array.isArray branch sends a raw string[] to `.cache.has` and throws; inverting
  // hasReportRole refuses the role holder and admits the roleless one.
  test("a member holding the role, as a raw string array, gets the modal; without it, the ephemeral role refusal", async () => {
    const withRole = fakeCommand({ member: { roles: [ROLE] } });
    await handleReportCommand(withRole.interaction);
    expect(withRole.calls.modals).toHaveLength(1);
    expect(withRole.calls.replied).toBeUndefined();

    const without = fakeCommand({ member: { roles: ["other"] } });
    await handleReportCommand(without.interaction);
    expect(without.calls.modals).toHaveLength(0);
    expect(without.calls.replied?.content).toContain("You don't have the role");
    expect(without.calls.replied?.flags).toBe(MessageFlags.Ephemeral);
  });

  test("a cached role manager is read the same way", async () => {
    const withRole = fakeCommand({ member: { roles: { cache: new Map([[ROLE, {}]]) } } });
    await handleReportCommand(withRole.interaction);
    expect(withRole.calls.modals).toHaveLength(1);

    const without = fakeCommand({ member: { roles: { cache: new Map() } } });
    await handleReportCommand(without.interaction);
    expect(without.calls.modals).toHaveLength(0);
    expect(without.calls.replied?.content).toBe(ROLE_REFUSAL);
  });

  test("a DM (no member) is refused in words, not with the role message (#504)", async () => {
    const dm = fakeCommand({ member: null });
    await handleReportCommand(dm.interaction);
    expect(dm.calls.modals).toHaveLength(0);
    expect(dm.calls.replied?.content).toBe(REPORT_DM_REFUSAL);
    expect(dm.calls.replied?.flags).toBe(MessageFlags.Ephemeral);
  });

  test("the DM refusal's text is pinned: never an empty reply Discord would reject (#504)", () => {
    expect(REPORT_DM_REFUSAL).toBe("This command works only in a server channel.");
  });

  // Mutation: setMaxLength(1200) on the title, or dropping `required`, fails the field assertions.
  test("the modal is report:<project> with the Title and Description fields", async () => {
    // The custom id carries the project the user chose, not a constant: the submit routes on it.
    const other = fakeCommand({ member: { roles: [ROLE] }, project: "abm" });
    await handleReportCommand(other.interaction);
    expect((other.calls.modals[0] as { custom_id: string }).custom_id).toBe("report:abm");

    const { interaction, calls } = fakeCommand({ member: { roles: [ROLE] }, project: "wow" });
    await handleReportCommand(interaction);

    const modal = calls.modals[0] as {
      custom_id: string;
      components: { components: { custom_id: string; style: number; max_length?: number; required?: boolean }[] }[];
    };
    expect(modal.custom_id).toBe("report:wow");
    expect(modal.components).toHaveLength(2);
    const [title, description] = modal.components.map((row) => row.components[0]!);
    expect(title).toMatchObject({ custom_id: "title", style: TextInputStyle.Short, max_length: 120, required: true });
    expect(description).toMatchObject({ custom_id: "description", style: TextInputStyle.Paragraph, required: true });
    expect(description!.max_length).toBeUndefined();
  });
});

describe("handleReportModal — the outcome a channel sees (#447, #445)", () => {
  // Mutation: `deferReply({ flags: Ephemeral })` makes the outcome private; dropping `allowedMentions` from the
  // success edit lets an `@everyone` typed into the modal fire.
  test("the public outcome: a plain deferReply (no Ephemeral flag) and the success edit with allowedMentions parse []", async () => {
    stubGithub();
    const { interaction, calls, marks } = fakeModalSubmit({ customId: "report:wow", username: "alice" });
    await handleReportModal(interaction);

    expect((calls.deferArgs as { flags?: unknown } | undefined)?.flags).toBeUndefined();
    expect(calls.edits).toHaveLength(1);
    expect(calls.edited).toEqual({
      content: reportAnnouncement({
        repo: WOW_REPO,
        number: 7,
        url: ISSUE_URL,
        title: marks.title,
        description: marks.description,
        username: "alice",
      }),
      allowedMentions: { parse: [] },
    });
    expect(warns).toEqual([]);
    expect(errors).toEqual([]);
  });

  // Discord wants an acknowledgement within 3 s and the label call alone may take 10: the defer has to come first.
  // Mutation: moving deferReply below ensureLabel leaves the interaction unacknowledged for the whole round trip.
  test("the interaction is deferred before the first network call", async () => {
    const { interaction, calls } = fakeModalSubmit({ customId: "report:wow" });
    const deferredAtFirstFetch: boolean[] = [];
    const seen = stubGithub();
    const stubbed = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      deferredAtFirstFetch.push(calls.deferred);
      return stubbed(...args);
    }) as typeof fetch;
    await handleReportModal(interaction);

    expect(seen.urls.length).toBeGreaterThan(0);
    expect(deferredAtFirstFetch[0]).toBe(true);
  });

  // #445. Mutation: moving the announcement edit back inside the create-issue `try` makes the catch say
  // "Couldn't file the issue" about an issue that exists.
  test("the issue is created and the announcement edit then rejects: the channel is told it was filed, not that it failed", async () => {
    const seen = stubGithub({ label: 422 });
    const { interaction, calls, marks } = fakeModalSubmit({
      customId: "report:wow",
      username: "alice",
      editOutcomes: ["reject", "ok"],
    });
    await handleReportModal(interaction);

    expect(seen.issues).toHaveLength(1); // filed exactly once: no retry, no duplicate
    expect(calls.edits).toHaveLength(2);
    expect(calls.edits[1]).toEqual({
      content: `📋 **alice** filed **${WOW_REPO}#7** — ${ISSUE_URL}`,
      allowedMentions: { parse: [] },
    });
    for (const edit of calls.edits) expect((edit as { content: string }).content).not.toContain("Couldn't file");
    // The warning is the only record of the Discord failure when the fallback succeeds: it names the issue and why.
    const failed = warns.filter((w) => w.includes("announcement edit failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(`${WOW_REPO}#7`);
    expect(failed[0]).toContain("edit rejected");
    expectNoReportTextInLog(marks);
  });

  // Mutation: removing the clamp around the fallback's content lets an over-long name past Discord's cap.
  // (A real username is at most 32 characters; the fake can say anything, which is what lets the clamp be pinned.)
  test("the fallback edit is clamped like every other public edit", async () => {
    stubGithub();
    const { interaction, calls } = fakeModalSubmit({
      customId: "report:wow",
      username: "u".repeat(3000),
      editOutcomes: ["reject", "ok"],
    });
    await handleReportModal(interaction);

    const fallback = (calls.edits[1] as { content: string }).content;
    expect(fallback.length).toBeLessThanOrEqual(1901); // clampReply's 1900 plus its ellipsis
    expect(fallback.endsWith("…")).toBe(true);
  });

  // Mutation: dropping the fallback's `.catch` lets the second rejection escape the handler.
  test("both edits rejecting is logged at error level and does not throw", async () => {
    stubGithub();
    const { interaction, calls } = fakeModalSubmit({ customId: "report:wow", editOutcomes: ["reject", "reject"] });
    await handleReportModal(interaction); // must not throw

    expect(calls.edits).toHaveLength(2);
    expect(errors.filter((e) => e.includes("fallback edit"))).toHaveLength(1);
    expect(errors[0]).toContain(`${WOW_REPO}#7`);
  });
});

// #445 (the cut) — a public message must not end in a lone surrogate.
describe("reportAnnouncement", () => {
  // Mutation: `slice` instead of `sliceUtf16` leaves the high surrogate of the emoji at the cut.
  test("the description is cut without splitting a surrogate pair", () => {
    const o = { repo: WOW_REPO, number: 7, url: ISSUE_URL, title: "t", username: "alice" };
    const head = reportAnnouncement({ ...o, description: "" });
    const probe = reportAnnouncement({ ...o, description: "x".repeat(5000) });
    const limit = probe.indexOf("\n… (truncated", head.length) - head.length; // how many UTF-16 units are kept
    // The emoji's high surrogate is the last unit that fits, its low surrogate the first that does not.
    const description = `${"a".repeat(limit - 1)}😀${"b".repeat(200)}`;

    const out = reportAnnouncement({ ...o, description });
    expect(out).toContain("… (truncated");
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });
});

// #448: the submit re-checks the gate. Mutation: deleting a check lets the submit through to the network;
// moving it after `deferReply` leaves the interaction deferred.
describe("handleReportModal — the gate on a submit (#448)", () => {
  test("a submit without the role is refused before deferReply and before any fetch, ephemerally", async () => {
    const seen = stubGithub();
    const { interaction, calls, marks } = fakeModalSubmit({ customId: "report:wow", member: { roles: [] } });
    await handleReportModal(interaction);

    expect(calls.replied?.content).toContain("You don't have the role");
    expect(calls.replied?.flags).toBe(MessageFlags.Ephemeral);
    expect(calls.deferred).toBe(false);
    expect(calls.edits).toHaveLength(0);
    expect(seen.urls).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("no report role");
    expect(warns[0]).toContain(marks.userId);
    expect(warns[0]).toContain("wow");
    expectNoReportTextInLog(marks);
  });

  test("a submit from a DM (no member) is refused the same way", async () => {
    const seen = stubGithub();
    const { interaction, calls } = fakeModalSubmit({ customId: "report:wow", member: null });
    await handleReportModal(interaction);

    expect(calls.replied?.content).toContain("You don't have the role");
    expect(calls.deferred).toBe(false);
    expect(seen.urls).toEqual([]);
  });

  test("a cached role manager that holds the role is let through", async () => {
    const seen = stubGithub();
    const { interaction, calls } = fakeModalSubmit({
      customId: "report:wow",
      member: { roles: { cache: new Map([[ROLE, {}]]) } },
    });
    await handleReportModal(interaction);

    expect(calls.replied).toBeUndefined();
    expect(calls.deferred).toBe(true);
    expect(seen.issues).toHaveLength(1);
  });

  test("a submit while the role is not configured is refused, naming the prefixed command", async () => {
    config.reportRoleId = undefined;
    config.commandPrefix = "pip";
    const seen = stubGithub();
    const { interaction, calls, marks } = fakeModalSubmit({ customId: "report:wow" });
    await handleReportModal(interaction);

    expect(calls.replied?.content).toBe(
      "`/pipreport` isn't configured — an admin must set `REPORT_ROLE_ID` and `GITHUB_TOKEN`.",
    );
    expect(calls.replied?.flags).toBe(MessageFlags.Ephemeral);
    expect(calls.deferred).toBe(false);
    expect(seen.urls).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("not configured");
    // The line identifies the submit: who, and for which (known) project.
    expect(warns[0]).toContain(marks.userId);
    expect(warns[0]).toContain("wow");
    expectNoReportTextInLog(marks);
  });

  test("a submit while the token is not configured is refused the same way", async () => {
    config.githubToken = undefined;
    const seen = stubGithub();
    const { interaction, calls, marks } = fakeModalSubmit({ customId: "report:wow" });
    await handleReportModal(interaction);

    expect(calls.replied?.content).toContain("isn't configured");
    expect(calls.replied?.flags).toBe(MessageFlags.Ephemeral);
    expect(calls.deferred).toBe(false);
    expect(seen.urls).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(marks.userId);
    expect(warns[0]).toContain("wow");
  });

  // The project fence runs first, so the refusals above only ever log a KNOWN project key. Mutation: moving the gate
  // above the fence would let a roleless submit with a forged customId write its attacker-controlled text to the log.
  test("a roleless submit for an unknown project is refused as unknown, and nothing is logged", async () => {
    const seen = stubGithub();
    const forged = "report:evil\n[report] forged line";
    const { interaction, calls } = fakeModalSubmit({ customId: forged, member: { roles: [] } });
    await handleReportModal(interaction);

    expect(calls.replied?.content).toContain("Unknown project");
    expect(calls.deferred).toBe(false);
    expect(seen.urls).toEqual([]);
    expect(warns).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// #503 item 7: the label is best-effort. Mutation: always passing the label (or dropping ensureLabel's catch) fails these.
describe("handleReportModal — the label is best-effort (#503)", () => {
  test("ensureLabel failing on the network files the issue without the label", async () => {
    const seen = stubGithub({ label: "reject" });
    const { interaction, calls, marks } = fakeModalSubmit({ customId: "report:wow", username: "alice" });
    await handleReportModal(interaction);

    expect(seen.issues).toHaveLength(1);
    expect(seen.issues[0]!.labels).toEqual([]);
    expect(calls.edits).toHaveLength(1);
    expect((calls.edited as { content: string }).content).toContain(`${WOW_REPO}#7`);
    expect(warns.filter((w) => w.includes("without the automated label"))).toHaveLength(1);
    expectNoReportTextInLog(marks);
  });

  test("ensureLabel answering 201 or 422 files with the label", async () => {
    for (const label of [201, 422] as const) {
      const seen = stubGithub({ label });
      const { interaction } = fakeModalSubmit({ customId: "report:wow" });
      await handleReportModal(interaction);
      expect(seen.issues).toHaveLength(1);
      expect(seen.issues[0]!.labels).toEqual(["automated"]);
    }
    expect(warns).toEqual([]);
  });
});

describe("handleReportModal — upstream failure clamping (#55, #186)", () => {
  // The exact scenario #55/#186 name: GitHub answers 502 with a multi-KB HTML body. Before the
  // fix, `err.message` (which embeds the raw body) went straight into `editReply`, which Discord
  // rejects past its 2000-char cap — silently leaving the deferred "thinking…" reply to expire.
  test("a 5 KB GitHub 502 body posts a clamped failure message and the interaction is not left deferred", async () => {
    const bigHtmlBody = `<html><body>Bad Gateway</body></html>${"x".repeat(5000)}`;
    globalThis.fetch = (() => new Response(bigHtmlBody, { status: 502 })) as unknown as typeof fetch;

    const { interaction, calls, marks } = fakeModalSubmit({ customId: "report:wow" });
    await handleReportModal(interaction);

    expect(calls.deferred).toBe(true);
    expect(calls.edited).toBeDefined();
    const edited = calls.edited as { content: string; allowedMentions?: { parse: string[] } };
    // The interaction ended in an editReply, not stuck on the deferred "thinking…" state.
    expect(edited.content).toContain("Couldn't file the issue");
    expect(edited.content.length).toBeLessThan(500); // well under Discord's 2000-char cap
    expect(edited.content).not.toContain(bigHtmlBody); // the raw 5 KB body did not leak through whole
    expect(edited.content.endsWith("…")).toBe(true); // truncated, not merely short by luck
    // #503 item 11: and the failure is now in the log, exactly once, without the report's text.
    expect(warns.filter((w) => w.includes("could not file an issue"))).toHaveLength(1);
    expectNoReportTextInLog(marks);
  });

  // Isolates the DEFENSIVE clampReply layer from clampUpstreamBody: a rejected fetch (not a
  // res.text() embed) can still carry an arbitrarily long Error.message, so this must be caught
  // even though clampUpstreamBody never runs on this path. Mutation: dropping `clampReply(...)`
  // from report.ts's catch block passes here undetected if only the upstream-body test exists.
  test("a long non-upstream error message is clamped too, independent of clampUpstreamBody", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("y".repeat(5000)))) as unknown as typeof fetch;

    const { interaction, calls, marks } = fakeModalSubmit({ customId: "report:wow" });
    await handleReportModal(interaction);

    const edited = calls.edited as { content: string };
    expect(edited.content.length).toBeLessThan(1950); // clampReply's 1900-char budget + prefix/suffix
    expect(edited.content.endsWith("…")).toBe(true);
    // The log line carries the message clamped to 300 characters plus the ellipsis, not the public reply's 1900.
    const logged = warns.filter((w) => w.includes("could not file an issue"));
    expect(logged).toEqual([`[report] could not file an issue in ${WOW_REPO}: ${"y".repeat(300)}…`]);
    expectNoReportTextInLog(marks);
  });

  // Parity with the success path, which already sets this: the description is
  // untrusted free text in a now-public message, so an `@everyone` typed into the modal must not
  // fire from the failure edit either.
  test("the failure edit carries allowedMentions: { parse: [] }, matching the success path", async () => {
    globalThis.fetch = (() => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const { interaction, calls } = fakeModalSubmit({ customId: "report:wow" });
    await handleReportModal(interaction);

    const edited = calls.edited as { allowedMentions?: { parse: string[] } };
    expect(edited.allowedMentions).toEqual({ parse: [] });
  });

  // An unknown project (including a forged inherited-key customId) never reaches the network at
  // all — repoForProject's Object.hasOwn fence stops it before deferReply. It is the one refusal that is not
  // logged: its project string is attacker-controlled until that fence has accepted it (#503 item 11).
  test("an unknown project is refused before any deferReply or fetch, and is not logged", async () => {
    let fetchCalled = false;
    globalThis.fetch = (() => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const { interaction, calls } = fakeModalSubmit({ customId: "report:constructor" });
    await handleReportModal(interaction);

    expect(calls.deferred).toBe(false);
    expect(fetchCalled).toBe(false);
    expect((calls.replied as { content: string }).content).toContain("Unknown project");
    expect(warns).toEqual([]);
    expect(errors).toEqual([]);
  });
});
