# Luma — mascot design specification

Status: **selected by the user as the rackbops-discord-bot mascot direction**. This package establishes the character and favicon sources. The favicon is wired into the shared admin page for `prod` and `debug`; it does not claim a live container has been rebuilt or the Discord avatar changed.

## Identity and purpose

Luma is a living lantern whose flame is a face. The character represents the bot delivering announcements and keeping conversations visible. A small blurple hanging charm with two white chat dots provides the Discord nod. The charm is not the Discord logo and must remain visually subordinate to the lantern.

Luma is distinct from Bop, the rack-unit robot in the separate `rackbops` repo, and from the crystalline Artifact Gremlin, Chanel the television, Folio the dragon, and other existing repo mascots. The other concepts explored for this task are recorded in [concepts](concepts/README.md).

## Source hierarchy

1. `luma.png` — canonical full illustration for identity, material, proportions, and expression.
2. `luma-favicon.svg` — editable compact identity for browser and app icons.
3. `luma-favicon-16.svg` — dedicated reduction for 16 px rendering.
4. This specification — durable rules for future assets.

Future illustrated poses should use the PNG master as an image reference. A stray highlight or patina patch in one generated pose is not a new identity requirement.

## Silhouette and anatomy

- Broad metal handle above a squat lantern body.
- Domed aged-brass cap with visible vents.
- Four broad uprights surrounding a curved glass enclosure.
- One warm flame inside the glass; its upper tips may move, but the face remains in the bright lower flame.
- Stable substantial base rather than legs or floating fragments.
- Small two-dot blurple charm tied at the lower right.

The lantern must read from its outer shape before glass texture or face detail. Do not add robot joints, equalizer bars, ears, wings, humanoid limbs, or a second face on the metal.

## Face and temperament

Default: two attentive eyes, lightly lifted brows, and a restrained warm smile. Luma is quietly helpful rather than frantic, mischievous, or omniscient. Concern can appear in the brow or flame tilt; error must not be shown as damage or extinguishing. Never rely on the mascot alone to convey a consequential status.

## Materials and palette

The full illustration uses painted gouache-and-ink rendering: aged brass, dark oxblood metal, slightly weathered glass, and warm flame. Brush texture and patina support the broad forms. Avoid plastic gloss, polished chrome, neon crystal, photoreal soot, or a flat sticker treatment for the full illustration.

| Vector role | Hex | Use |
|---|---|---|
| Night | `#241b1a` | Icon field, darkest contour |
| Lantern shadow | `#5b342a` | Frame depth |
| Glass | `#69382a` | Flame backdrop |
| Aged brass | `#d79a50` | Handle and frame |
| Brass highlight | `#efc477` | Readable edge |
| Flame | `#f5a33c` | Outer fire |
| Flame light | `#ffe3a0` | Face field |
| Chat blurple | `#5865f2` | Small charm |

These are exact SVG tokens and targets for future artwork, not a claim that every painted pixel matches a swatch.

## Favicon and app icon

Purpose-draw the lantern; never shrink `luma.png` into a browser tab. Keep, in order: brass handle, lantern frame, bright flame, two eyes. The small blurple charm is present where it remains legible. Remove vents, patina, glass reflections, rope, and complex flame tongues. The dedicated 16 px SVG reduces the charm to a two-dot blurple circle.

The general SVG has a 64×64 viewBox and a dark rounded-square field for predictable contrast. Raster exports are 16, 32, 48, 180, 192, and 512 px, plus a multi-resolution ICO. The 180/192/512 px files are ordinary icon candidates, not maskable exports. A browser that scales the general SVG to 16 px will not automatically select the dedicated 16 px drawing; use the 16 px PNG or ICO frame for that control.

## Usage and consistency

Use the full illustration for README or profile imagery and the compact mark for tabs, navigation, and small app icons. Preserve clear space around the handle and charm. On dark layouts, keep the warm center bright enough to separate from the frame; on light layouts, retain the dark outer contour. Keep the chat charm secondary and do not replace it with the official Discord mark.

Potential future poses include ready, delivering, thinking, concerned, celebrating, and resting. They are not part of this initial package. Future poses may change flame posture and light intensity while preserving the lantern's structure and chat charm.

## Reference precedent

The package structure follows the source hierarchy, purpose-drawn favicon, prompt provenance, and proof conventions seen in `R:/repos/the-keeper/assets/` and `R:/repos/research-triage/assets/`. Their characters and visual motifs are not reused.
