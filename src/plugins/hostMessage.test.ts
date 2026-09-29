import { describe, expect, test } from "bun:test";
import { ButtonStyle } from "discord.js";
import { LIMITS, validateHostMessage, wrapBareUrls } from "./hostMessage";

const full = (content = "hi") => ({ content });

describe("wrapBareUrls", () => {
  test("wraps a bare url and leaves an already-wrapped one alone", () => {
    expect(wrapBareUrls("see <https://a.example> and https://b.example now")).toBe(
      "see <https://a.example> and <https://b.example> now",
    );
  });

  test("wraps two separate bare urls", () => {
    expect(wrapBareUrls("https://a.example https://b.example")).toBe("<https://a.example> <https://b.example>");
  });

  test("text with no url is unchanged", () => {
    expect(wrapBareUrls("no links here")).toBe("no links here");
  });

  // #736 review: a URL sitting loose inside an unrelated bracketed span must still be wrapped on its
  // own -- treating the whole span as "already wrapped" left it unsuppressed, since Discord's <url>
  // syntax needs the brackets immediately around the URL itself, not just present somewhere nearby.
  test("a url loose inside an unrelated bracketed span is still wrapped on its own", () => {
    expect(wrapBareUrls("<click here https://evil.example more text>")).toBe(
      "<click here <https://evil.example> more text>",
    );
  });

  test("a tightly wrapped url (nothing else inside the brackets) is the only thing left untouched", () => {
    expect(wrapBareUrls("<https://a.example>")).toBe("<https://a.example>");
  });
});

describe("validateHostMessage: content", () => {
  test("accepted at 2000 chars, refused at 2001", () => {
    expect(validateHostMessage(full("a".repeat(2000)), { partial: false })).toMatchObject({ ok: true });
    expect(validateHostMessage(full("a".repeat(2001)), { partial: false })).toEqual({
      ok: false,
      reason: `content is longer than ${LIMITS.CONTENT_MAX} after link wrapping`,
    });
  });

  test("the 2000-char bound is checked after link wrapping, not before", () => {
    // "https://x.example" (18 chars) wraps to "<https://x.example>" (20 chars) -- pad so only the
    // POST-wrap length crosses the limit.
    const url = "https://x.example";
    const content = url + "a".repeat(LIMITS.CONTENT_MAX - url.length - 1);
    expect(content.length).toBe(LIMITS.CONTENT_MAX - 1); // under the limit unwrapped
    const result = validateHostMessage(full(content), { partial: false });
    expect(result).toEqual({ ok: false, reason: `content is longer than ${LIMITS.CONTENT_MAX} after link wrapping` });
  });

  test("empty content is refused", () => {
    expect(validateHostMessage(full(""), { partial: false })).toEqual({ ok: false, reason: "content is empty" });
  });

  test("content missing entirely (non-partial) is refused the same way", () => {
    expect(validateHostMessage({}, { partial: false })).toEqual({ ok: false, reason: "content is empty" });
  });
});

describe("validateHostMessage: card", () => {
  const cardWith = (over: Record<string, unknown>) => ({ card: { title: "t", ...over } });

  test("title accepted at 256, refused at 257", () => {
    expect(validateHostMessage(cardWith({ title: "t".repeat(256) }), { partial: true })).toMatchObject({ ok: true });
    expect(validateHostMessage(cardWith({ title: "t".repeat(257) }), { partial: true })).toEqual({
      ok: false,
      reason: `card title is longer than ${LIMITS.CARD_TITLE_MAX}`,
    });
  });

  test("description accepted at 4096, refused at 4097", () => {
    expect(validateHostMessage(cardWith({ description: "d".repeat(4096) }), { partial: true })).toMatchObject({ ok: true });
    expect(validateHostMessage(cardWith({ description: "d".repeat(4097) }), { partial: true })).toEqual({
      ok: false,
      reason: `card description is longer than ${LIMITS.CARD_DESCRIPTION_MAX}`,
    });
  });

  test("footer accepted at 2048, refused at 2049", () => {
    expect(validateHostMessage(cardWith({ footer: "f".repeat(2048) }), { partial: true })).toMatchObject({ ok: true });
    expect(validateHostMessage(cardWith({ footer: "f".repeat(2049) }), { partial: true })).toEqual({
      ok: false,
      reason: `card footer is longer than ${LIMITS.CARD_FOOTER_MAX}`,
    });
  });

  test("25 fields accepted, 26 refused", () => {
    const fields = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `n${i}`, value: "v" }));
    expect(validateHostMessage(cardWith({ fields: fields(25) }), { partial: true })).toMatchObject({ ok: true });
    expect(validateHostMessage(cardWith({ fields: fields(26) }), { partial: true })).toEqual({
      ok: false,
      reason: `card has more than ${LIMITS.CARD_FIELDS_MAX} fields`,
    });
  });

  test("field name accepted at 256, refused at 257", () => {
    const withName = (len: number) => cardWith({ fields: [{ name: "n".repeat(len), value: "v" }] });
    expect(validateHostMessage(withName(256), { partial: true })).toMatchObject({ ok: true });
    expect(validateHostMessage(withName(257), { partial: true })).toEqual({
      ok: false,
      reason: `card field name must be 1..${LIMITS.CARD_FIELD_NAME_MAX} characters`,
    });
  });

  test("field value accepted at 1024, refused at 1025", () => {
    const withValue = (len: number) => cardWith({ fields: [{ name: "n", value: "v".repeat(len) }] });
    expect(validateHostMessage(withValue(1024), { partial: true })).toMatchObject({ ok: true });
    expect(validateHostMessage(withValue(1025), { partial: true })).toEqual({
      ok: false,
      reason: `card field value must be 1..${LIMITS.CARD_FIELD_VALUE_MAX} characters`,
    });
  });

  test("card total accepted at 6000, refused at 6001 -- each part still within its own limit", () => {
    // title(256) + footer(2048) + description(3696) = 6000 exactly; bumping description by one
    // crosses the total without any single part exceeding its own bound.
    const base = { title: "t".repeat(256), footer: "f".repeat(2048) };
    const ok = validateHostMessage({ card: { ...base, description: "d".repeat(3696) } }, { partial: true });
    expect(ok).toMatchObject({ ok: true });
    const refused = validateHostMessage({ card: { ...base, description: "d".repeat(3697) } }, { partial: true });
    expect(refused).toEqual({ ok: false, reason: `card total exceeds ${LIMITS.CARD_TOTAL_MAX}` });
  });

  test("an https card url is accepted, an http one is refused", () => {
    expect(validateHostMessage(cardWith({ url: "https://example.com" }), { partial: true })).toMatchObject({ ok: true });
    expect(validateHostMessage(cardWith({ url: "http://example.com" }), { partial: true })).toEqual({
      ok: false,
      reason: "card url must be https",
    });
  });
});

describe("validateHostMessage: links", () => {
  test("5 links accepted, 6 refused", () => {
    const links = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `l${i}`, url: "https://example.com" }));
    expect(validateHostMessage({ links: links(5) }, { partial: true })).toMatchObject({ ok: true });
    expect(validateHostMessage({ links: links(6) }, { partial: true })).toEqual({
      ok: false,
      reason: `more than ${LIMITS.LINKS_MAX} link buttons`,
    });
  });

  test("label accepted at 80, refused at 81", () => {
    const withLabel = (len: number) => ({ links: [{ label: "l".repeat(len), url: "https://example.com" }] });
    expect(validateHostMessage(withLabel(80), { partial: true })).toMatchObject({ ok: true });
    expect(validateHostMessage(withLabel(81), { partial: true })).toEqual({
      ok: false,
      reason: `link label must be 1..${LIMITS.LINK_LABEL_MAX} characters`,
    });
  });

  test("an http link is refused", () => {
    const result = validateHostMessage({ links: [{ label: "l", url: "http://example.com" }] }, { partial: true });
    expect(result).toEqual({ ok: false, reason: "link url must be https" });
  });

  test("links build one action row of link-style buttons", () => {
    const result = validateHostMessage(
      { links: [{ label: "a", url: "https://a.example" }, { label: "b", url: "https://b.example" }] },
      { partial: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.payload.components).toHaveLength(1);
    const row = result.payload.components![0] as { components: { style: number; label: string; url: string }[] };
    expect(row.components).toHaveLength(2);
    for (const button of row.components) expect(button.style).toBe(ButtonStyle.Link);
    expect(row.components.map((b) => b.label)).toEqual(["a", "b"]);
  });
});

describe("validateHostMessage: buttons (#323)", () => {
  const P = { partial: false, pluginName: "feed" } as const;
  const btn = (i: number, over: Record<string, unknown> = {}) => ({ customId: `feed:b${i}`, label: `b${i}`, ...over });
  const btns = (n: number) => Array.from({ length: n }, (_, i) => btn(i));
  type Row = { type: number; components: { type: number; style: number; label: string; custom_id?: string; url?: string }[] };
  const rowsOf = (result: ReturnType<typeof validateHostMessage>): Row[] => {
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    return result.payload.components as unknown as Row[];
  };

  test("renders one row per 5 buttons, in list order, with customId and label", () => {
    const rows = rowsOf(validateHostMessage({ content: "hi", buttons: btns(7) }, P));
    expect(rows.map((r) => r.components.length)).toEqual([5, 2]);
    expect(rows.flatMap((r) => r.components.map((c) => c.custom_id))).toEqual(btns(7).map((b) => b.customId));
    expect(rows[0]!.components[0]!.label).toBe("b0");
  });

  test("style maps to ButtonStyle, defaulting to secondary", () => {
    const rows = rowsOf(
      validateHostMessage(
        {
          content: "hi",
          buttons: [
            btn(0),
            btn(1, { style: "primary" }),
            btn(2, { style: "secondary" }),
            btn(3, { style: "success" }),
            btn(4, { style: "danger" }),
          ],
        },
        P,
      ),
    );
    expect(rows[0]!.components.map((c) => c.style)).toEqual([
      ButtonStyle.Secondary,
      ButtonStyle.Primary,
      ButtonStyle.Secondary,
      ButtonStyle.Success,
      ButtonStyle.Danger,
    ]);
  });

  test("an unknown style is refused, including link and a prototype key", () => {
    for (const style of ["link", "premium", "toString", 1]) {
      expect(validateHostMessage({ content: "hi", buttons: [btn(0, { style })] }, P)).toEqual({
        ok: false,
        reason: "button style must be one of primary, secondary, success, danger",
      });
    }
  });

  test("the links row comes after the button rows", () => {
    const rows = rowsOf(
      validateHostMessage({ content: "hi", buttons: btns(6), links: [{ label: "l", url: "https://a.example" }] }, P),
    );
    expect(rows).toHaveLength(3);
    expect(rows[2]!.components[0]!.style).toBe(ButtonStyle.Link);
    expect(rows[2]!.components[0]!.url).toBe("https://a.example");
  });

  test("25 buttons (5 rows) accepted; 26 refused; 21 plus a links row refused; 20 plus a links row accepted", () => {
    expect(rowsOf(validateHostMessage({ content: "hi", buttons: btns(25) }, P))).toHaveLength(5);
    const tooMany = { ok: false, reason: `buttons and links need more than ${LIMITS.ROWS_MAX} rows` } as const;
    expect(validateHostMessage({ content: "hi", buttons: btns(26) }, P)).toEqual(tooMany);
    const link = [{ label: "l", url: "https://a.example" }];
    expect(validateHostMessage({ content: "hi", buttons: btns(21), links: link }, P)).toEqual(tooMany);
    expect(rowsOf(validateHostMessage({ content: "hi", buttons: btns(20), links: link }, P))).toHaveLength(5);
    // `links: []` adds no row, so it does not count against the limit.
    expect(rowsOf(validateHostMessage({ content: "hi", buttons: btns(25), links: [] }, P))).toHaveLength(5);
  });

  test("a customId without the calling plugin's prefix is refused", () => {
    const refused = { ok: false, reason: 'button customId must start with "feed:"' } as const;
    for (const customId of ["other:x", "report:x", "feedx", "feed", "", "Feed:x", 7, undefined]) {
      expect(validateHostMessage({ content: "hi", buttons: [{ customId, label: "l" }] }, P)).toEqual(refused);
    }
  });

  test("a bare prefix is enough to route, so it is accepted", () => {
    expect(rowsOf(validateHostMessage({ content: "hi", buttons: [{ customId: "feed:", label: "l" }] }, P))).toHaveLength(1);
  });

  test("customId accepted at 100 characters, refused at 101", () => {
    const id = (len: number) => `feed:${"x".repeat(len - 5)}`;
    expect(validateHostMessage({ content: "hi", buttons: [{ customId: id(100), label: "l" }] }, P)).toMatchObject({ ok: true });
    expect(validateHostMessage({ content: "hi", buttons: [{ customId: id(101), label: "l" }] }, P)).toEqual({
      ok: false,
      reason: `button customId is longer than ${LIMITS.CUSTOM_ID_MAX}`,
    });
  });

  test("label accepted at 80, refused empty and at 81", () => {
    expect(validateHostMessage({ content: "hi", buttons: [btn(0, { label: "l".repeat(80) })] }, P)).toMatchObject({ ok: true });
    const refused = { ok: false, reason: `button label must be 1..${LIMITS.BUTTON_LABEL_MAX} characters` } as const;
    expect(validateHostMessage({ content: "hi", buttons: [btn(0, { label: "l".repeat(81) })] }, P)).toEqual(refused);
    expect(validateHostMessage({ content: "hi", buttons: [btn(0, { label: "" })] }, P)).toEqual(refused);
    expect(validateHostMessage({ content: "hi", buttons: [btn(0, { label: 5 })] }, P)).toEqual(refused);
  });

  test("a duplicate customId is refused", () => {
    expect(validateHostMessage({ content: "hi", buttons: [btn(0), btn(0, { label: "again" })] }, P)).toEqual({
      ok: false,
      reason: "button customIds must be unique within a message",
    });
  });

  test("malformed input is refused, never thrown", () => {
    expect(validateHostMessage({ content: "hi", buttons: "nope" }, P)).toEqual({ ok: false, reason: "buttons must be a list" });
    expect(validateHostMessage({ content: "hi", buttons: { 0: btn(0) } }, P)).toEqual({ ok: false, reason: "buttons must be a list" });
    expect(validateHostMessage({ content: "hi", buttons: [null] }, P)).toEqual({ ok: false, reason: "button must be an object" });
    expect(validateHostMessage({ content: "hi", buttons: ["feed:x"] }, P)).toEqual({ ok: false, reason: "button must be an object" });
  });

  test("a refusal reason never echoes the caller's customId or label", () => {
    const result = validateHostMessage({ content: "hi", buttons: [{ customId: "SECRET-ID", label: "SECRET-LABEL" }] }, P);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).not.toContain("SECRET");
  });

  test("without a pluginName there is no prefix to check, so buttons are refused, [] included", () => {
    for (const buttons of [btns(1), []]) {
      expect(validateHostMessage({ content: "hi", buttons }, { partial: false })).toEqual({
        ok: false,
        reason: "interactive buttons are not supported here",
      });
    }
  });

  test("buttons: [] on a post sends an empty components list", () => {
    expect(rowsOf(validateHostMessage({ content: "hi", buttons: [] }, P))).toEqual([]);
  });

  test("edit: buttons alone is enough, and buttons: [] clears every row", () => {
    const E = { partial: true, pluginName: "feed" } as const;
    const result = validateHostMessage({ buttons: [] }, E);
    expect(result).toEqual({ ok: true, payload: { components: [], allowedMentions: { parse: [] } } });
    expect(rowsOf(validateHostMessage({ buttons: btns(3) }, E))).toHaveLength(1);
  });

  test("edit: non-empty links alone is the whole new row set (only the links row)", () => {
    const rows = rowsOf(validateHostMessage({ links: [{ label: "Open", url: "https://a.example" }] }, { partial: true, pluginName: "feed" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.components.map((c) => c.style)).toEqual([ButtonStyle.Link]);
  });

  test("invalid links are refused before buttons are counted into rows", () => {
    // Six links is itself invalid; it must be reported as that, not as a row overflow computed from it.
    const sixLinks = Array.from({ length: 6 }, () => ({ label: "l", url: "https://a.example" }));
    const result = validateHostMessage({ content: "hi", buttons: btns(25), links: sixLinks }, P);
    expect(result).toEqual({ ok: false, reason: `more than ${LIMITS.LINKS_MAX} link buttons` });
  });

  test("edit: links: [] alone still sends no components key, exactly as before #323", () => {
    const result = validateHostMessage({ links: [] }, { partial: true, pluginName: "feed" });
    expect(result).toEqual({ ok: true, payload: { allowedMentions: { parse: [] } } });
  });

  test("edit: content alone leaves components out, so existing buttons stay", () => {
    const result = validateHostMessage({ content: "done" }, { partial: true, pluginName: "feed" });
    expect(result).toEqual({ ok: true, payload: { content: "done", allowedMentions: { parse: [] } } });
  });
});

describe("validateHostMessage: partial (edit)", () => {
  test("no parts at all is refused", () => {
    expect(validateHostMessage({}, { partial: true })).toEqual({
      ok: false,
      reason: "at least one of content, card, links or buttons must be present",
    });
  });

  test("a card alone, with no content, is accepted", () => {
    const result = validateHostMessage({ card: { title: "t" } }, { partial: true });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unreachable");
    expect(result.payload.content).toBeUndefined();
    expect(result.payload.embeds).toHaveLength(1);
  });
});

describe("validateHostMessage: the built payload", () => {
  test("always carries allowedMentions: { parse: [] }, content-only", () => {
    const result = validateHostMessage(full("hello world"), { partial: false });
    expect(result).toEqual({ ok: true, payload: { content: "hello world", allowedMentions: { parse: [] } } });
  });

  test("carries it alongside a card and links too", () => {
    const result = validateHostMessage(
      { content: "hi", card: { title: "t" }, links: [{ label: "a", url: "https://a.example" }] },
      { partial: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.payload.allowedMentions).toEqual({ parse: [] });
    expect(result.payload.embeds).toHaveLength(1);
    expect(result.payload.components).toHaveLength(1);
  });

  test("a non-object message is refused, not thrown", () => {
    expect(validateHostMessage("nope", { partial: false })).toEqual({ ok: false, reason: "message must be an object" });
    expect(validateHostMessage(null, { partial: false })).toEqual({ ok: false, reason: "message must be an object" });
  });
});
