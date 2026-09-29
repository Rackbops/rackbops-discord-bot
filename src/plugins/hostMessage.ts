// Pure validation + payload building for HostApi.post/dm/edit (#736, decision 6). No I/O and no
// discord.js Client -- takes a HostMessage-shaped value, returns either a fixed refusal reason (never
// echoing caller text) or a built payload. Built through discord.js's own EmbedBuilder /
// ActionRowBuilder / ButtonBuilder so their own validators run too, on top of the LIMITS checked by
// hand; either can refuse, and a builder throw is converted to a fixed reason rather than left to
// escape as a raw discord.js error string.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { APIActionRowComponent, APIButtonComponent, APIEmbed } from "discord.js";
import type { HostButton, HostCard, HostCardField, HostLinkButton, HostMessage } from "./contract";

/** The numbers behind decision 6. `CARD_TOTAL_MAX` is title + description + footer + every field's
 *  name and value, summed -- Discord's own 6000-character embed budget. */
export const LIMITS = {
  CONTENT_MAX: 2000,
  CARD_TITLE_MAX: 256,
  CARD_DESCRIPTION_MAX: 4096,
  CARD_FIELDS_MAX: 25,
  CARD_FIELD_NAME_MAX: 256,
  CARD_FIELD_VALUE_MAX: 1024,
  CARD_FOOTER_MAX: 2048,
  CARD_TOTAL_MAX: 6000,
  LINKS_MAX: 5,
  LINK_LABEL_MAX: 80,
  BUTTONS_PER_ROW: 5,
  ROWS_MAX: 5,
  BUTTON_LABEL_MAX: 80,
  CUSTOM_ID_MAX: 100,
} as const;

/** `HostButton.style` -> discord.js's `ButtonStyle` (#323). `Link` and `Premium` are deliberately
 *  absent: a link button is `HostMessage.links`, and a premium button is not a plugin's to send. */
const BUTTON_STYLES: Record<NonNullable<HostButton["style"]>, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

export interface BuiltPayload {
  content?: string;
  embeds?: APIEmbed[];
  components?: APIActionRowComponent<APIButtonComponent>[];
  allowedMentions: { parse: [] };
}

export type ValidationResult = { ok: true; payload: BuiltPayload } | { ok: false; reason: string };

// Matches a URL that is ALREADY tightly wrapped -- `<` immediately before it, `>` immediately after,
// nothing else between -- or a bare http(s) URL otherwise. The first alternative must require the
// brackets to hold nothing but the URL itself: a looser first cut ("<[^>]*>", matching any bracketed
// span containing a URL anywhere inside it) let a URL sitting mid-sentence inside an UNRELATED
// bracketed span -- "<click here https://evil.example more text>" -- read as "already wrapped" and
// pass through untouched, even though the URL there is not adjacent to either bracket and Discord's
// own <url> suppression syntax requires exactly that adjacency (#736 review). Matching the wrapped
// form as `<(url)>` closes that: a URL is only ever left alone when the brackets truly hold nothing
// else, and a URL loose inside a larger bracketed span is still found and wrapped on its own.
const URL_OR_WRAPPED_RE = /<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>]+)/g;

/** Wraps every bare `http(s)://` run in `<...>` so it does not unfurl, leaving a URL that is already
 *  tightly wrapped (`<url>`, nothing else inside the brackets) untouched. `MessageFlags.SuppressEmbeds`
 *  would also hide the card, so this is the only way to keep a link from unfurling without losing the
 *  card too (decision 5). */
export function wrapBareUrls(content: string): string {
  return content.replace(URL_OR_WRAPPED_RE, (whole: string, alreadyWrapped: string | undefined, bare: string | undefined) =>
    alreadyWrapped !== undefined ? whole : `<${bare}>`,
  );
}

function validateCardShape(card: unknown): { ok: true; value: HostCard } | { ok: false; reason: string } {
  if (typeof card !== "object" || card === null) return { ok: false, reason: "card must be an object" };
  const c = card as Partial<HostCard>;
  if (typeof c.title !== "string" || c.title.length === 0) return { ok: false, reason: "card title is empty" };
  if (c.title.length > LIMITS.CARD_TITLE_MAX) return { ok: false, reason: `card title is longer than ${LIMITS.CARD_TITLE_MAX}` };
  if (c.description !== undefined) {
    if (typeof c.description !== "string") return { ok: false, reason: "card description must be a string" };
    if (c.description.length > LIMITS.CARD_DESCRIPTION_MAX) {
      return { ok: false, reason: `card description is longer than ${LIMITS.CARD_DESCRIPTION_MAX}` };
    }
  }
  if (c.url !== undefined && (typeof c.url !== "string" || !c.url.startsWith("https://"))) {
    return { ok: false, reason: "card url must be https" };
  }
  if (c.footer !== undefined) {
    if (typeof c.footer !== "string") return { ok: false, reason: "card footer must be a string" };
    if (c.footer.length > LIMITS.CARD_FOOTER_MAX) return { ok: false, reason: `card footer is longer than ${LIMITS.CARD_FOOTER_MAX}` };
  }
  const rawFields = c.fields ?? [];
  if (!Array.isArray(rawFields)) return { ok: false, reason: "card fields must be a list" };
  if (rawFields.length > LIMITS.CARD_FIELDS_MAX) return { ok: false, reason: `card has more than ${LIMITS.CARD_FIELDS_MAX} fields` };
  const fields: HostCardField[] = [];
  for (const f of rawFields) {
    if (typeof f !== "object" || f === null) return { ok: false, reason: "card field must be an object" };
    const field = f as Partial<HostCardField>;
    if (typeof field.name !== "string" || field.name.length === 0 || field.name.length > LIMITS.CARD_FIELD_NAME_MAX) {
      return { ok: false, reason: `card field name must be 1..${LIMITS.CARD_FIELD_NAME_MAX} characters` };
    }
    if (typeof field.value !== "string" || field.value.length === 0 || field.value.length > LIMITS.CARD_FIELD_VALUE_MAX) {
      return { ok: false, reason: `card field value must be 1..${LIMITS.CARD_FIELD_VALUE_MAX} characters` };
    }
    fields.push({ name: field.name, value: field.value, ...(field.inline !== undefined ? { inline: field.inline } : {}) });
  }
  const value: HostCard = {
    title: c.title,
    ...(c.description !== undefined ? { description: c.description } : {}),
    ...(c.url !== undefined ? { url: c.url } : {}),
    ...(c.color !== undefined ? { color: c.color } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    ...(c.footer !== undefined ? { footer: c.footer } : {}),
  };
  const total =
    value.title.length + (value.description?.length ?? 0) + (value.footer?.length ?? 0) +
    fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  if (total > LIMITS.CARD_TOTAL_MAX) return { ok: false, reason: `card total exceeds ${LIMITS.CARD_TOTAL_MAX}` };
  return { ok: true, value };
}

/** Builds the embed through `EmbedBuilder` so its own validators run too; a throw there becomes a
 *  fixed refusal rather than a raw discord.js error string. */
function buildEmbed(card: HostCard): { ok: true; value: APIEmbed } | { ok: false; reason: string } {
  try {
    const embed = new EmbedBuilder().setTitle(card.title);
    if (card.description !== undefined) embed.setDescription(card.description);
    if (card.url !== undefined) embed.setURL(card.url);
    if (card.color !== undefined) embed.setColor(card.color);
    if (card.footer !== undefined) embed.setFooter({ text: card.footer });
    for (const f of card.fields ?? []) embed.addFields({ name: f.name, value: f.value, inline: f.inline ?? false });
    return { ok: true, value: embed.toJSON() };
  } catch {
    return { ok: false, reason: "card is not valid" };
  }
}

function validateLinks(links: unknown): { ok: true; value: HostLinkButton[] } | { ok: false; reason: string } {
  if (!Array.isArray(links)) return { ok: false, reason: "links must be a list" };
  if (links.length > LIMITS.LINKS_MAX) return { ok: false, reason: `more than ${LIMITS.LINKS_MAX} link buttons` };
  const value: HostLinkButton[] = [];
  for (const l of links) {
    if (typeof l !== "object" || l === null) return { ok: false, reason: "link button must be an object" };
    const link = l as Partial<HostLinkButton>;
    if (typeof link.label !== "string" || link.label.length === 0 || link.label.length > LIMITS.LINK_LABEL_MAX) {
      return { ok: false, reason: `link label must be 1..${LIMITS.LINK_LABEL_MAX} characters` };
    }
    if (typeof link.url !== "string" || !link.url.startsWith("https://")) {
      return { ok: false, reason: "link url must be https" };
    }
    value.push({ label: link.label, url: link.url });
  }
  return { ok: true, value };
}

/** Builds one action row of link-style buttons through `ActionRowBuilder`/`ButtonBuilder`, so their
 *  own validators run too; a throw becomes a fixed refusal, like `buildEmbed`. */
function buildLinksRow(
  links: HostLinkButton[],
): { ok: true; value: APIActionRowComponent<APIButtonComponent> } | { ok: false; reason: string } {
  try {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      links.map((l) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(l.label).setURL(l.url)),
    );
    return { ok: true, value: row.toJSON() as APIActionRowComponent<APIButtonComponent> };
  } catch {
    return { ok: false, reason: "link button is not valid" };
  }
}

/**
 * Validates `buttons` (#323): a list of objects, each with a 1..80-character label, a customId that
 * starts with `<pluginName>:` and is at most 100 characters, unique within the message, and an
 * optional style from `BUTTON_STYLES`. The prefix is what routes a press back to the sending plugin
 * (`routeInteractionByPrefix`, host.ts), so a customId naming any other prefix -- another plugin's,
 * or core's `report:` -- is refused rather than sent. Reasons never echo caller text; the plugin name
 * is the host's own value, not the caller's.
 */
function validateButtons(
  buttons: unknown,
  pluginName: string,
): { ok: true; value: Required<HostButton>[] } | { ok: false; reason: string } {
  if (!Array.isArray(buttons)) return { ok: false, reason: "buttons must be a list" };
  const prefix = `${pluginName}:`;
  const seen = new Set<string>();
  const value: Required<HostButton>[] = [];
  for (const b of buttons) {
    if (typeof b !== "object" || b === null) return { ok: false, reason: "button must be an object" };
    const button = b as Partial<HostButton>;
    if (typeof button.label !== "string" || button.label.length === 0 || button.label.length > LIMITS.BUTTON_LABEL_MAX) {
      return { ok: false, reason: `button label must be 1..${LIMITS.BUTTON_LABEL_MAX} characters` };
    }
    if (typeof button.customId !== "string" || !button.customId.startsWith(prefix)) {
      return { ok: false, reason: `button customId must start with "${prefix}"` };
    }
    if (button.customId.length > LIMITS.CUSTOM_ID_MAX) {
      return { ok: false, reason: `button customId is longer than ${LIMITS.CUSTOM_ID_MAX}` };
    }
    if (seen.has(button.customId)) return { ok: false, reason: "button customIds must be unique within a message" };
    seen.add(button.customId);
    const style = button.style ?? "secondary";
    if (typeof style !== "string" || !Object.hasOwn(BUTTON_STYLES, style)) {
      return { ok: false, reason: `button style must be one of ${Object.keys(BUTTON_STYLES).join(", ")}` };
    }
    value.push({ customId: button.customId, label: button.label, style });
  }
  return { ok: true, value };
}

/** Builds the interactive buttons into rows of `BUTTONS_PER_ROW`, in list order, through
 *  `ActionRowBuilder`/`ButtonBuilder`; a throw becomes a fixed refusal, like `buildEmbed`. */
function buildButtonRows(
  buttons: Required<HostButton>[],
): { ok: true; value: APIActionRowComponent<APIButtonComponent>[] } | { ok: false; reason: string } {
  try {
    const rows: APIActionRowComponent<APIButtonComponent>[] = [];
    for (let i = 0; i < buttons.length; i += LIMITS.BUTTONS_PER_ROW) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons
          .slice(i, i + LIMITS.BUTTONS_PER_ROW)
          .map((b) => new ButtonBuilder().setStyle(BUTTON_STYLES[b.style]).setLabel(b.label).setCustomId(b.customId)),
      );
      rows.push(row.toJSON() as APIActionRowComponent<APIButtonComponent>);
    }
    return { ok: true, value: rows };
  } catch {
    return { ok: false, reason: "button is not valid" };
  }
}

/**
 * Validates `message` against `LIMITS` and decision 6, and builds the payload through discord.js's
 * own builders. `opts.partial` (for `edit`) makes every part optional, but at least one of
 * content/card/links/buttons must be present; a part that IS present is still validated in full.
 * `content` is wrapped (`wrapBareUrls`) before its length is checked, so the 2000-character bound is
 * the bound Discord actually sees.
 *
 * `message.buttons` (#323) is rendered as rows of at most 5 interactive buttons, followed by the one
 * row of `links`; more than `ROWS_MAX` rows in all is refused. Each customId must start with
 * `<opts.pluginName>:`; without a `pluginName` there is no prefix to check against, so `buttons` is
 * refused outright (`buttons: []` included, as before #323). When either `buttons` or `links` is
 * given the payload's `components` is the full new set of rows -- `[]` when both are empty, which on
 * `edit` removes the message's buttons -- and when neither is given it is omitted, so an `edit` of
 * other parts leaves the buttons alone. The returned payload always carries
 * `allowedMentions: { parse: [] }` (mentions are inert on every path).
 */
export function validateHostMessage(message: unknown, opts: { partial: boolean; pluginName?: string }): ValidationResult {
  if (typeof message !== "object" || message === null) return { ok: false, reason: "message must be an object" };
  const m = message as Partial<HostMessage>;

  const hasContent = m.content !== undefined;
  const hasCard = m.card !== undefined;
  const hasLinks = m.links !== undefined;
  const hasButtons = m.buttons !== undefined;
  const { pluginName } = opts;
  if (hasButtons && pluginName === undefined) return { ok: false, reason: "interactive buttons are not supported here" };
  if (opts.partial && !hasContent && !hasCard && !hasLinks && !hasButtons) {
    return { ok: false, reason: "at least one of content, card, links or buttons must be present" };
  }

  let content: string | undefined;
  if (!opts.partial || hasContent) {
    if (hasContent && typeof m.content !== "string") return { ok: false, reason: "content must be a string" };
    const wrapped = wrapBareUrls(m.content ?? "");
    if (wrapped.length === 0) return { ok: false, reason: "content is empty" };
    if (wrapped.length > LIMITS.CONTENT_MAX) return { ok: false, reason: `content is longer than ${LIMITS.CONTENT_MAX} after link wrapping` };
    content = wrapped;
  }

  let embeds: APIEmbed[] | undefined;
  if (hasCard) {
    const shape = validateCardShape(m.card);
    if (!shape.ok) return shape;
    const built = buildEmbed(shape.value);
    if (!built.ok) return built;
    embeds = [built.value];
  }

  let components: APIActionRowComponent<APIButtonComponent>[] | undefined;
  if (hasButtons || hasLinks) {
    // Links first, so the row count below is taken from a validated list, not raw caller input.
    let links: HostLinkButton[] = [];
    if (hasLinks) {
      const shape = validateLinks(m.links);
      if (!shape.ok) return shape;
      links = shape.value;
    }
    components = [];
    if (hasButtons && pluginName !== undefined) {
      const shape = validateButtons(m.buttons, pluginName);
      if (!shape.ok) return shape;
      const rows = Math.ceil(shape.value.length / LIMITS.BUTTONS_PER_ROW) + (links.length > 0 ? 1 : 0);
      if (rows > LIMITS.ROWS_MAX) return { ok: false, reason: `buttons and links need more than ${LIMITS.ROWS_MAX} rows` };
      const built = buildButtonRows(shape.value);
      if (!built.ok) return built;
      components.push(...built.value);
    }
    if (links.length > 0) {
      const built = buildLinksRow(links);
      if (!built.ok) return built;
      components.push(built.value);
    }
    // Before #323 a present-but-empty `links` sent no `components` key at all (an edit left the
    // message's rows alone); keep exactly that when `buttons` is absent, so a pre-#323 caller sees
    // no change in behaviour.
    if (components.length === 0 && !hasButtons) components = undefined;
  }

  return {
    ok: true,
    payload: {
      ...(content !== undefined ? { content } : {}),
      ...(embeds !== undefined ? { embeds } : {}),
      ...(components !== undefined ? { components } : {}),
      allowedMentions: { parse: [] },
    },
  };
}
