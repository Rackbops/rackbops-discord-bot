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

describe("validateHostMessage: buttons is always refused", () => {
  test("a populated buttons list is refused", () => {
    const result = validateHostMessage({ content: "hi", buttons: [{ customId: "x", label: "y" }] }, { partial: false });
    expect(result).toEqual({ ok: false, reason: "interactive buttons are not supported yet" });
  });

  test("buttons: [] is refused too -- the key's presence is what signals intent, not its contents", () => {
    const result = validateHostMessage({ content: "hi", buttons: [] }, { partial: false });
    expect(result).toEqual({ ok: false, reason: "interactive buttons are not supported yet" });
  });
});

describe("validateHostMessage: partial (edit)", () => {
  test("no parts at all is refused", () => {
    expect(validateHostMessage({}, { partial: true })).toEqual({
      ok: false,
      reason: "at least one of content, card or links must be present",
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
