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

  // #453: the bare-URL class runs to whitespace, so it used to swallow whatever trailed the URL into the
  // brackets: a masked link's closing paren, a full stop, closing bold.
  describe("what trails a url stays outside the brackets (#453)", () => {
    const cases: [string, string, string][] = [
      ["a masked link keeps working, and its destination stops unfurling", "[docs](https://a.example/x)", "[docs](<https://a.example/x>)"],
      ["a sentence's full stop", "Read https://a.example.", "Read <https://a.example>."],
      ["a comma, colon, semicolon, ! and ?", "https://a.example, https://b.example: https://c.example; https://d.example! https://e.example?", "<https://a.example>, <https://b.example>: <https://c.example>; <https://d.example>! <https://e.example>?"],
      ["closing bold", "**https://a.example**", "**<https://a.example>**"],
      ["italic, strikethrough and a spoiler", "_https://a.example_ ~~https://b.example~~ ||https://c.example||", "_<https://a.example>_ ~~<https://b.example>~~ ||<https://c.example>||"],
      ["quotes", `'https://a.example' "https://b.example"`, `'<https://a.example>' "<https://b.example>"`],
      ["a parenthesised url", "(see https://a.example/x)", "(see <https://a.example/x>)"],
      ["a url with its own pair of parens keeps it", "https://en.wikipedia.org/wiki/Foo_(bar)", "<https://en.wikipedia.org/wiki/Foo_(bar)>"],
      ["...and a masked link to one keeps both", "[w](https://en.wikipedia.org/wiki/Foo_(bar))", "[w](<https://en.wikipedia.org/wiki/Foo_(bar)>)"],
      ["...and a full stop after one", "see https://en.wikipedia.org/wiki/Foo_(bar).", "see <https://en.wikipedia.org/wiki/Foo_(bar)>."],
      ["...and parentheses around one: only the unpartnered paren is cut", "(see https://en.wikipedia.org/wiki/Foo_(bar))", "(see <https://en.wikipedia.org/wiki/Foo_(bar)>)"],
      ["an unmatched closing bracket", "[https://a.example]", "[<https://a.example>]"],
      ["several trailing marks at once", "(**https://a.example**).", "(**<https://a.example>**)."],
      ["a query and a path are the url's own", "https://a.example/p?q=1&r=2#frag", "<https://a.example/p?q=1&r=2#frag>"],
    ];
    for (const [label, input, expected] of cases) test(label, () => expect(wrapBareUrls(input)).toBe(expected));

    test("trimming never cuts into the scheme", () => {
      expect(wrapBareUrls("https://...")).toBe("<https://>...");
    });

    test("a markdown marker at the end stays in the url unless the same marker opened it", () => {
      expect(wrapBareUrls("https://youtu.be/dQw4w9WgXc_")).toBe("<https://youtu.be/dQw4w9WgXc_>"); // an id can end in _
      expect(wrapBareUrls("see https://a.example/C_* and https://a.example/x|")).toBe("see <https://a.example/C_*> and <https://a.example/x|>");
      expect(wrapBareUrls("**_https://a.example_**")).toBe("**_<https://a.example>_**"); // nested markers, each opened
    });

    test("! and ? are cut as sentence ends -- a deliberate trade-off against the rare url that ends in one", () => {
      expect(wrapBareUrls("https://en.wikipedia.org/wiki/Oklahoma!")).toBe("<https://en.wikipedia.org/wiki/Oklahoma>!");
    });

    test("a bare url stops before a `](`, so it never swallows what follows as its own", () => {
      expect(wrapBareUrls("x https://a.example](https://b.example)")).toBe("x <https://a.example>](<https://b.example>)");
    });

    test("a url's own square brackets are kept, and only an unpartnered one is cut", () => {
      expect(wrapBareUrls("https://[::1]:8080/x")).toBe("<https://[::1]:8080/x>");
      expect(wrapBareUrls("https://a.example/list[0]")).toBe("<https://a.example/list[0]>");
      expect(wrapBareUrls("[https://a.example/list[0]]")).toBe("[<https://a.example/list[0]>]");
    });

    test("a lone trailing backtick stays in the url (a paired one would have made a code span)", () => {
      expect(wrapBareUrls("https://a.example/x`")).toBe("<https://a.example/x`>");
    });
  });

  describe("a masked link's destination is wrapped whole, its text left alone (#453)", () => {
    const cases: [string, string, string][] = [
      ["nothing in the destination is trimmed", "[clip](https://youtu.be/dQw4w9WgXc_) [x](https://a.example/end.)", "[clip](<https://youtu.be/dQw4w9WgXc_>) [x](<https://a.example/end.>)"],
      ["two masked links back to back", "[a](https://a.example/x)[b](https://b.example/y)", "[a](<https://a.example/x>)[b](<https://b.example/y>)"],
      ["a destination with its own pair of parens mid-path", "[x](https://a.example/(v2)/end.)", "[x](<https://a.example/(v2)/end.>)"],
      ["two joined by a slash", "[Wowhead](https://www.wowhead.com/item=1)/[Armory](https://b.example/x)", "[Wowhead](<https://www.wowhead.com/item=1>)/[Armory](<https://b.example/x>)"],
      ["a url as the text is not touched", "[https://a.example](https://b.example)", "[https://a.example](<https://b.example>)"],
      ["a destination the plugin already wrapped is not touched, nor its text", "[https://a.example](<https://b.example>)", "[https://a.example](<https://b.example>)"],
    ];
    for (const [label, input, expected] of cases) test(label, () => expect(wrapBareUrls(input)).toBe(expected));
  });

  describe("a url inside code is left alone (#453)", () => {
    test("an inline code span", () => {
      expect(wrapBareUrls("run `curl https://a.example/x` then https://b.example")).toBe(
        "run `curl https://a.example/x` then <https://b.example>",
      );
    });

    test("a double-backtick span, with or without a backtick inside, and a fenced block", () => {
      expect(wrapBareUrls("``https://a.example``")).toBe("``https://a.example``");
      expect(wrapBareUrls("``a ` https://a.example``")).toBe("``a ` https://a.example``");
      expect(wrapBareUrls("``https://a.example ` x``")).toBe("``https://a.example ` x``");
      expect(wrapBareUrls("```\nGET https://a.example/x\n```\nhttps://b.example")).toBe(
        "```\nGET https://a.example/x\n```\n<https://b.example>",
      );
    });

    test("an inline span may cross a line, as Discord's does", () => {
      expect(wrapBareUrls("`a\nhttps://a.example`")).toBe("`a\nhttps://a.example`");
    });

    test("a url between two fenced blocks is outside both", () => {
      expect(wrapBareUrls("```\none\n``` https://a.example ```\ntwo\n```")).toBe("```\none\n``` <https://a.example> ```\ntwo\n```");
    });

    test("a lone backtick is not a code span: the url after it is still wrapped", () => {
      expect(wrapBareUrls("it` https://a.example")).toBe("it` <https://a.example>");
    });
  });
});

// #454: the hand checks, and the two reachable builder catches that turn a discord.js throw into a fixed
// reason, each asserting the exact reason (never caller text, never a raw TypeError). The third catch,
// buildButtonRows', is not reachable: validateButtons hand-checks everything ButtonBuilder validates.
describe("validateHostMessage: fixed refusals for every shape check and builder throw (#454)", () => {
  const refuse = (message: unknown, partial = true) => validateHostMessage(message, { partial, pluginName: "p" });

  test("a builder throw on the card is \"card is not valid\": a non-boolean inline", () => {
    expect(refuse({ card: { title: "t", fields: [{ name: "n", value: "v", inline: "yes" }] } })).toEqual({ ok: false, reason: "card is not valid" });
  });

  // #508: HostCard.color is a number. discord.js's setColor also resolves a name or a hex string, so
  // "Random" used to be accepted and sent as some colour; anything but a whole 0..0xFFFFFF is refused.
  test("a card colour that is not a whole number from 0 to 0xFFFFFF", () => {
    for (const color of ["Random", "#ff0000", "#zzz", 0x1000000, -1, 1.5, Number.NaN, null]) {
      expect(refuse({ card: { title: "t", color } }), String(color)).toEqual({ ok: false, reason: "card color must be a whole number from 0 to 0xFFFFFF" });
    }
    for (const color of [0, 0xffffff, 0x5865f2]) expect(refuse({ card: { title: "t", color } }), String(color)).toMatchObject({ ok: true });
  });

  // #508: whitespace alone shows as nothing, and Discord is expected to refuse it as empty (inferred), so
  // it is empty here too, with the reason an empty one already gets.
  test("a card title, a field name or value, or a card-less post's content that is only whitespace is empty", () => {
    for (const blank of [" ", "   ", "\n\t", "\u3000"]) {
      expect(refuse({ content: blank }, false), JSON.stringify(blank)).toEqual({ ok: false, reason: "content is empty" });
      // Beside a card it shows the card; in an edit it may blank the text over one: both kept.
      expect(refuse({ content: blank, card: { title: "t" } }, false), JSON.stringify(blank)).toMatchObject({ ok: true, payload: { content: blank } });
      expect(refuse({ content: blank }), JSON.stringify(blank)).toMatchObject({ ok: true, payload: { content: blank } });
      expect(refuse({ card: { title: blank } }), JSON.stringify(blank)).toEqual({ ok: false, reason: "card title is empty" });
      expect(refuse({ card: { title: "t", fields: [{ name: blank, value: "v" }] } })).toEqual({
        ok: false,
        reason: `card field name must be 1..${LIMITS.CARD_FIELD_NAME_MAX} characters`,
      });
      expect(refuse({ card: { title: "t", fields: [{ name: "n", value: blank }] } })).toEqual({
        ok: false,
        reason: `card field value must be 1..${LIMITS.CARD_FIELD_VALUE_MAX} characters`,
      });
    }
    // Whitespace around real text is kept as written.
    expect(refuse({ content: " hi " }, false)).toMatchObject({ ok: true, payload: { content: " hi " } });
  });

  test("a builder throw on a link button is \"link button is not valid\"", () => {
    for (const url of ["https://", "https://a b"]) {
      expect(refuse({ links: [{ label: "l", url }] })).toEqual({ ok: false, reason: "link button is not valid" });
    }
  });

  test("non-string content", () => {
    for (const content of [5, null, { toString: () => "x" }]) {
      expect(refuse({ content }, false)).toEqual({ ok: false, reason: "content must be a string" });
      expect(refuse({ content })).toEqual({ ok: false, reason: "content must be a string" });
    }
  });

  test("links that are not a list", () => {
    for (const links of [5, "https://a.example", { label: "l", url: "https://a.example" }]) {
      expect(refuse({ links })).toEqual({ ok: false, reason: "links must be a list" });
    }
  });

  test("an empty or non-string card title", () => {
    for (const title of ["", undefined, 5]) {
      expect(refuse({ card: { title } })).toEqual({ ok: false, reason: "card title is empty" });
    }
  });

  test("a card that is not an object", () => {
    for (const card of [null, 5, "card"]) expect(refuse({ card })).toEqual({ ok: false, reason: "card must be an object" });
  });

  test("a card field that is not an object", () => {
    for (const field of [null, 5, "f"]) {
      expect(refuse({ card: { title: "t", fields: [field] } })).toEqual({ ok: false, reason: "card field must be an object" });
    }
  });

  test("card fields that are not a list", () => {
    for (const fields of [{}, 5, "f"]) {
      expect(refuse({ card: { title: "t", fields } })).toEqual({ ok: false, reason: "card fields must be a list" });
    }
  });

  test("a non-string card description or footer", () => {
    expect(refuse({ card: { title: "t", description: 5 } })).toEqual({ ok: false, reason: "card description must be a string" });
    expect(refuse({ card: { title: "t", footer: 5 } })).toEqual({ ok: false, reason: "card footer must be a string" });
  });

  test("a link button that is not an object", () => {
    for (const link of [null, 5, "https://a.example"]) {
      expect(refuse({ links: [link] })).toEqual({ ok: false, reason: "link button must be an object" });
    }
  });
});

// #453: validateHostMessage refuses over-long content before wrapping, so content a plugin passes on
// cannot stall the bot: the code-span alternative is quadratic on a long run of unpaired backticks, and
// the first trailing-trim version was quadratic on trailing parens. The bounds are generous -- unbounded,
// the backtick input below takes seconds.
describe("validateHostMessage: wrapping cost is bounded (#453)", () => {
  test("adversarial content at the 2000-character limit wraps quickly", () => {
    for (const content of ["https://a" + ")".repeat(1990), "https://a" + ".)".repeat(995), "``" + "a`".repeat(999), "[x](https://a" + "(".repeat(1985)]) {
      const started = performance.now();
      expect(validateHostMessage({ content }, { partial: false }).ok).toBeDefined();
      expect(performance.now() - started).toBeLessThan(200);
    }
  });

  test("content over the limit is refused before it is wrapped, with the same reason", () => {
    // Backtick-heavy on purpose: wrapping it unbounded takes seconds, so only the check before wrapping
    // keeps this fast.
    for (const content of ["`".repeat(50_000) + "a".repeat(50_000), "https://a" + ")".repeat(100_000)]) {
      const started = performance.now();
      expect(validateHostMessage({ content }, { partial: false })).toEqual({
        ok: false,
        reason: `content is longer than ${LIMITS.CONTENT_MAX} after link wrapping`,
      });
      expect(performance.now() - started).toBeLessThan(200);
    }
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

  // #508: Discord caps a link button's url at 512; discord.js's builder does not, so a longer one used to
  // reach Discord and come back as a raw API error.
  test("a link url longer than LINK_URL_MAX (512) is refused; exactly 512 is accepted", () => {
    const urlOf = (len: number) => `https://a.example/${"x".repeat(len - "https://a.example/".length)}`;
    expect(urlOf(512)).toHaveLength(512);
    expect(validateHostMessage({ links: [{ label: "l", url: urlOf(512) }] }, { partial: true })).toMatchObject({ ok: true });
    expect(validateHostMessage({ links: [{ label: "l", url: urlOf(513) }] }, { partial: true })).toEqual({
      ok: false,
      reason: `link url is longer than ${LIMITS.LINK_URL_MAX}`,
    });
    expect(LIMITS.LINK_URL_MAX).toBe(512);
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
