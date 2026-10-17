// Text helpers for the routing files and the messages made from them. Imports nothing, so `model.ts` and
// `resolve.ts` can both use them without importing each other (#478: they used to, `model.ts` -> `resolve.ts`'s
// `shown` and `resolve.ts` -> `model.ts`'s types and constant, which worked only because `shown` is hoisted).
// `resolve.ts` re-exports `shown` and `model.ts` re-exports `clip`, so their importers are unchanged.

/** U+FFFD, built by code so no editor or tool can quietly turn the escape into a lookalike glyph. */
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/**
 * `text` cut to at most `max` UTF-16 units, as well-formed text: a cut never ends on half of a surrogate
 * pair, and a lone surrogate (a `"\ud83d"` escape in some JSON, say) becomes U+FFFD. A value that is
 * about to go into `routing.json` for the panel to read needs this: a lone surrogate makes text that
 * `encodeURIComponent` throws on.
 */
export function clip(text: string, max: number): string {
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.toWellFormed();
}

/**
 * A value that is about to be put in a message the panel shows. It cannot throw: a string is used as
 * it is, a list or an object is named rather than printed (printing one walks it, and JSON a hundred
 * kilobytes deep overflows the stack in `JSON.stringify` and again in any fallback), and everything
 * else is a primitive. Ids are at most 25 characters, so the clip changes nothing for a real request
 * and only stops a hostile one from echoing itself back at length.
 *
 * The result is always well-formed text. A lone surrogate -- a `"\ud83d"` escape in the JSON, or an
 * emoji cut in half by a clip -- makes a string that `encodeURIComponent` refuses, so whatever shows
 * the reason would throw; a lone one is replaced with U+FFFD, and the cut counts code points, so it
 * never lands inside a surrogate pair. (An emoji made of SEVERAL code points -- a flag, a ZWJ
 * sequence -- can still be cut between its parts; the result is well-formed, just a different emoji.)
 *
 * Two different measures are in play, on purpose: WHETHER to clip is decided on UTF-16 length (over
 * 40 units), while the cut itself keeps 37 code points. For ordinary text the two agree. For
 * emoji-heavy text of 41 to 79 units with 37 or fewer code points nothing is cut and the ellipsis is
 * still appended. That only ever shows for a hostile value; a real id is at most 25 ASCII digits.
 */
export function shown(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "object" && value !== null) text = Array.isArray(value) ? "[list]" : "[object]";
  else if (typeof value === "function") text = "[function]";
  else text = String(value);
  text = text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, REPLACEMENT_CHARACTER);
  if (text.length <= 40) return text;
  // For text of more than 80 units, the first 80 hold at least 40 code points, so 37 are always
  // available -- and a megabyte of hostile text is never spread into an array.
  return `${Array.from(text.slice(0, 80)).slice(0, 37).join("")}...`;
}
