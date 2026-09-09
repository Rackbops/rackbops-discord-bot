import { afterEach, describe, expect, test } from "bun:test";
import type { ModalSubmitInteraction } from "discord.js";

// report.ts pulls in the `config` singleton, which resolves process.env at import time -- the
// required vars are primed once by test/setup.ts's bunfig preload (#136).
const { handleReportModal } = await import("./report");
const { config } = await import("./config");

/** A minimal stand-in for a `report:<project>` modal submit, capturing what gets sent back. */
function fakeModalSubmit(o: { customId: string; title?: string; description?: string; username?: string }) {
  const calls: { deferred: boolean; replied?: unknown; edited?: unknown } = { deferred: false };
  const interaction = {
    customId: o.customId,
    user: { username: o.username ?? "alice" },
    fields: {
      getTextInputValue: (id: string) => (id === "title" ? (o.title ?? "Title") : (o.description ?? "Description")),
    },
    deferReply: async () => {
      calls.deferred = true;
    },
    reply: async (content: unknown) => {
      calls.replied = content;
    },
    editReply: async (content: unknown) => {
      calls.edited = content;
    },
  } as unknown as ModalSubmitInteraction;
  return { interaction, calls };
}

describe("handleReportModal — upstream failure clamping (#55, #186)", () => {
  const realFetch = globalThis.fetch;
  const realToken = config.githubToken;
  afterEach(() => {
    globalThis.fetch = realFetch;
    config.githubToken = realToken;
  });

  // The exact scenario #55/#186 name: GitHub answers 502 with a multi-KB HTML body. Before the
  // fix, `err.message` (which embeds the raw body) went straight into `editReply`, which Discord
  // rejects past its 2000-char cap — silently leaving the deferred "thinking…" reply to expire.
  test("a 5 KB GitHub 502 body posts a clamped failure message and the interaction is not left deferred", async () => {
    config.githubToken = "test-token"; // createIssue requires one
    const bigHtmlBody = `<html><body>Bad Gateway</body></html>${"x".repeat(5000)}`;
    globalThis.fetch = (() => new Response(bigHtmlBody, { status: 502 })) as unknown as typeof fetch;

    const { interaction, calls } = fakeModalSubmit({ customId: "report:wow" });
    await handleReportModal(interaction);

    expect(calls.deferred).toBe(true);
    expect(calls.edited).toBeDefined();
    const edited = calls.edited as { content: string; allowedMentions?: { parse: string[] } };
    // The interaction ended in an editReply, not stuck on the deferred "thinking…" state.
    expect(edited.content).toContain("Couldn't file the issue");
    expect(edited.content.length).toBeLessThan(500); // well under Discord's 2000-char cap
    expect(edited.content).not.toContain(bigHtmlBody); // the raw 5 KB body did not leak through whole
    expect(edited.content.endsWith("…")).toBe(true); // truncated, not merely short by luck
  });

  // Isolates the DEFENSIVE clampReply layer from clampUpstreamBody: a rejected fetch (not a
  // res.text() embed) can still carry an arbitrarily long Error.message, so this must be caught
  // even though clampUpstreamBody never runs on this path. Mutation: dropping `clampReply(...)`
  // from report.ts's catch block passes here undetected if only the upstream-body test exists.
  test("a long non-upstream error message is clamped too, independent of clampUpstreamBody", async () => {
    config.githubToken = "test-token";
    globalThis.fetch = (() => Promise.reject(new Error("y".repeat(5000)))) as unknown as typeof fetch;

    const { interaction, calls } = fakeModalSubmit({ customId: "report:wow" });
    await handleReportModal(interaction);

    const edited = calls.edited as { content: string };
    expect(edited.content.length).toBeLessThan(1950); // clampReply's 1900-char budget + prefix/suffix
    expect(edited.content.endsWith("…")).toBe(true);
  });

  // Parity with the success path (report.ts:130), which already sets this: the description is
  // untrusted free text in a now-public message, so an `@everyone` typed into the modal must not
  // fire from the failure edit either.
  test("the failure edit carries allowedMentions: { parse: [] }, matching the success path", async () => {
    config.githubToken = "test-token";
    globalThis.fetch = (() => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const { interaction, calls } = fakeModalSubmit({ customId: "report:wow" });
    await handleReportModal(interaction);

    const edited = calls.edited as { allowedMentions?: { parse: string[] } };
    expect(edited.allowedMentions).toEqual({ parse: [] });
  });

  // An unknown project (including a forged inherited-key customId) never reaches the network at
  // all — repoForProject's Object.hasOwn fence stops it before deferReply.
  test("an unknown project is refused before any deferReply or fetch", async () => {
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
  });
});
