# Luma — rackbops-discord-bot mascot assets

Luma is the selected mascot direction for this bot: a living lantern with a small blurple chat charm. The flame carries the expression, while the charm provides a visible nod to Discord without reproducing its logo.

## Start here

- [Master illustration](luma.png)
- [Design specification](luma-mascot-design-spec.md)
- [Favicon SVG](luma-favicon.svg) and [dedicated 16 px SVG](luma-favicon-16.svg)
- [Favicon size proof](luma-favicon-size-proof.png)
- [Visual style guide](luma-style-guide.png)
- [Design philosophy](design-philosophy.md)
- [Generation prompts](generation-prompts.md)
- [Palette](palette.json) and [validation report](asset-validation.json)
- [Seven-concept exploration](concepts/README.md)

## Asset inventory

| File | Purpose |
|---|---|
| `luma.png` | Canonical transparent full illustration; large layouts and Discord avatar candidate |
| `luma-favicon.svg` | Editable 64×64 compact mark |
| `luma-favicon-16.svg` | Dedicated simplified 16×16 mark |
| `luma-favicon-{16,32,48,180,192,512}.png` | Raster tab, touch, and app icon candidates |
| `luma-favicon.ico` | Multi-resolution browser fallback |
| `luma-favicon-size-proof.png` | Native-size inspection on light and dark fields |
| `luma-style-guide.png` | Master, compact mark, and palette overview |

The favicon is a purpose-drawn lantern and flame, not a miniature of the detailed illustration. The dedicated 16 px source removes most lantern texture and facial detail. The 180/192/512 px exports are ordinary square icons, not maskable app icons.

## Source and regeneration

`luma.png` is the generated raster master. `luma-favicon.svg` and `luma-favicon-16.svg` are original hand-authored vector sources. The PNGs and ICO derive from those SVGs; regenerate them whenever either source changes. [Generation prompts](generation-prompts.md) records the concept and the chat-charm edit, plus an identity block for future poses.

The exact palette tokens govern the vector assets. The painted raster intentionally contains additional shades. See the [design specification](luma-mascot-design-spec.md) for the durable silhouette, expression, and use rules.

## Integration status

The Luma favicon is linked from the shared admin page and served by the admin image for both `prod` and `debug` instances. The Discord application's avatar is not changed. A running deployment picks up the browser icon when its admin image is rebuilt from this revision; these asset files alone do not update a live container.
