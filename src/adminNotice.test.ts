import { describe, expect, test } from "bun:test";
import { deliverAdminNotice, type AdminNoticeTexts } from "./adminNotice";

const TEXTS: AdminNoticeTexts = {
  noAdmins: "[x] no admins configured",
  dmFailed: (id, reason) => `[x] DM to ${id} failed (${reason})`,
  fallbackFailed: "[x] the channel fallback failed",
};

function harness(opts: { failDm?: string[]; failPost?: boolean } = {}) {
  const dms: Array<{ id: string; content: string }> = [];
  const posts: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    dms,
    posts,
    warns,
    errors,
    deliverers: {
      dmUser: async (id: string, content: string) => {
        if (opts.failDm?.includes(id)) throw new Error(`closed DMs for ${id}`);
        dms.push({ id, content });
      },
      postAnnounce: async (content: string) => {
        if (opts.failPost) throw new Error("channel gone");
        posts.push(content);
      },
    },
    log: { warn: (m: string) => void warns.push(m), error: (m: string) => void errors.push(m) },
  };
}

describe("deliverAdminNotice (#505)", () => {
  test("every DM ok -> each admin DMed, no announce post, true (M2c)", async () => {
    const h = harness();
    expect(await deliverAdminNotice("hello", ["1", "2"], h.deliverers, h.log, TEXTS)).toBe(true);
    expect(h.dms).toEqual([
      { id: "1", content: "hello" },
      { id: "2", content: "hello" },
    ]);
    expect(h.posts).toEqual([]);
  });

  test("one DM fails -> one announce post (not one per admin), true, and the DM failure is logged with its id and reason", async () => {
    const h = harness({ failDm: ["1", "2"] });
    expect(await deliverAdminNotice("hello", ["1", "2"], h.deliverers, h.log, TEXTS)).toBe(true);
    expect(h.posts).toEqual(["hello"]);
    expect(h.warns).toEqual(["[x] DM to 1 failed (closed DMs for 1)", "[x] DM to 2 failed (closed DMs for 2)"]);
  });

  test("no admins -> the noAdmins text is warned, nothing is sent, false", async () => {
    const h = harness();
    expect(await deliverAdminNotice("hello", [], h.deliverers, h.log, TEXTS)).toBe(false);
    expect(h.warns).toEqual(["[x] no admins configured"]);
    expect(h.dms).toEqual([]);
    expect(h.posts).toEqual([]);
  });

  test("every DM fails and the fallback fails too -> false, the fallback text is logged as an error", async () => {
    const h = harness({ failDm: ["1"], failPost: true });
    expect(await deliverAdminNotice("hello", ["1"], h.deliverers, h.log, TEXTS)).toBe(false);
    expect(h.errors).toEqual(["[x] the channel fallback failed"]);
  });

  test("a failed DM to one admin does not stop the next, and the fallback covers the failed one", async () => {
    const h = harness({ failDm: ["1"] });
    expect(await deliverAdminNotice("hello", ["1", "2"], h.deliverers, h.log, TEXTS)).toBe(true);
    expect(h.dms).toEqual([{ id: "2", content: "hello" }]);
    expect(h.posts).toEqual(["hello"]);
  });
});
