# Pip avatar and banner design specification

Pip's avatar is a small teal-and-ivory messenger sprite with leaf-shaped ears, a swept crest, attentive eyes and a simple shoulder wrap. This specification records the existing artwork, its saved design prompts, and practical rules for making consistent future assets. The supplied PNG is the visual reference. It remains named `pip-canonical-review-v1.png`; publication does not imply a separate final-art approval or a live Discord avatar change.

## Source assets and scope

The following six files are preserved from the existing design package. Their sizes and hashes are recorded in [provenance.json](provenance.json).

| File | Role | Verified format or contents |
| --- | --- | --- |
| [pip-canonical-review-v1.png](pip-canonical-review-v1.png) | Avatar reference master | 1254 × 1254 RGB PNG; 1,892,101 bytes; opaque background |
| [qa-circular-inspection.png](qa-circular-inspection.png) | Circular crop review | 512 × 512 RGB PNG; gray exterior around the circular proof |
| [qa-size-inspection.png](qa-size-inspection.png) | Small-size review sheet | 800 × 420 RGB PNG; labeled square previews at 32, 64, 128 and 256 px, with two additional circular previews |
| [prompt-canonical-v1.txt](prompt-canonical-v1.txt) | Initial character direction | Saved prompt, unchanged |
| [prompt-refine-1.txt](prompt-refine-1.txt) | First framing refinement | Saved prompt, unchanged |
| [prompt-refine-2.txt](prompt-refine-2.txt) | Second framing refinement | Saved prompt, unchanged |

The companion banner adds [the unmodified generated master](pip-banner-master-v1.png), [the exact 680 × 240 upload export](pip-banner-680x240-v1.png), and [its generation prompt](prompt-banner-v1.txt). Its design and export details are documented below.

The README, this specification and provenance record document the assets. This package contains no editable vector master, layered painting, separate transparent cutout, animated character, alternate pose, standalone small-size avatar export, or dedicated favicon. None should be inferred from the review sheet.

## Character identity

The initial prompt describes a thoughtful, curious, quietly mischievous personal-assistant messenger sprite. The observed portrait expresses that through a slight head angle, attentive eyes, a gently uneven brow and a small closed-mouth smile. Keep the expression friendly and capable, without exaggerated baby proportions or a broad comic grin.

The durable visual features are:

1. A warm pale-ivory rounded face, with subtle painted warmth in the cheeks and forehead.
2. Two very large dark eyes with amber-brown lower regions and small bright highlights. They dominate the face.
3. A small warm-toned nose, fine mouth line and understated half-smile.
4. Two broad teal leaf-shaped ear fins. In the supplied view, the ear on the viewer's left rises much higher; the right ear extends outward. Preserve this intentional asymmetry in matching portraits.
5. One broad curved teal crest above the forehead. Its comma-like sweep is a major silhouette cue. The ears and crest should read as soft leaf-like forms rather than horns.
6. A teal shoulder wrap widening toward the bottom edge of the square. The portrait shows no hands.
7. One round warm-gold clasp near the collar on the viewer's right. It is the only distinct accessory.

The reference is a bust rather than a full-body character model. It does not establish body height, hands, feet, a back view, or anatomy hidden by the wrap. Those need a separate design decision before future views are treated as canonical.

## Shape and composition

The main recognition sequence is the ivory face, the three-part teal silhouette, and the paired dark eyes. The wrap grounds the bust; the small gold clasp supplies a secondary accent. Large contiguous shapes should carry the identity before surface detail is considered.

Use the square PNG as supplied for the first upload. The character sits within a large field of deep navy, with open space above the crest and beside the ear tips. The shoulders continue to the bottom edge. The circular proof shows the ears and crest inside the crop, while the lower wrap is intentionally cut by the circle.

The initial prompt requested a face about half the image width. The later prompts prioritized increased breathing room, including explicit zoom-out instructions. Those numbers are historical generation instructions, not measurements certified for the delivered PNG. For future revisions, use the supplied artwork and the visible circular proof to judge framing rather than assuming every numeric prompt instruction was achieved exactly.

Recommended framing checks for a derivative:

- Preserve the square aspect ratio and the source's navy background.
- Keep both complete ear tips, the crest and all facial features inside a centered inscribed circle.
- Inspect the circular view separately; a feature can fit in the square and still be clipped by a circle.
- Allow the shoulder wrap to run off the lower edge.
- Do not enlarge the face at the expense of the ears or crest without reviewing the circular crop again.
- Do not stretch, mirror, rotate, or tightly crop the reference as a routine export operation.

These are implementation recommendations for maintaining the supplied design, rather than claims that new derivatives have already been approved.

## Painting and finish

The intended finish is a modern storybook illustration with clean sculptural forms and a matte, hand-painted gouache character. The actual PNG contains visible brush-like texture, layered teal shading and warm highlights. Maintain that balance: the forms should remain clear even where the surface has substantial texture.

The saved prompt asked for restrained texture and no gradients. The supplied raster nevertheless has tonal variation and shading. Preserve the observed painting rather than treating that negative prompt as proof of a flat-color deliverable. The background is a dark navy painted field, not transparency.

For future matching artwork, avoid glossy plastic rendering, metallic armor, photorealistic skin, heavy outlines, extra ornament or busy scenery. The original exclusions also cover text, borders, watermarks, sparkles, wings, generic robot or screen faces, humanoid fairies, dragons, raccoons, TV mascots, lanterns and equipment beyond the clasp. These exclusions describe the supplied prompt's direction; they are not a list of additional assets.

## Color reference

The palette relationship matters more than a single pixel: deep navy surroundings; dark and mid teal silhouette; warm ivory face; very dark eyes; small amber and gold accents. The large light face against the dark field creates the strongest contrast.

The following values are reproducible samples from this PNG, not previously approved flat-color brand tokens. Each value is the per-channel median of an 11 × 11 pixel square centered on the listed coordinate, with the top-left pixel as `(0, 0)`. Coordinates and values apply only to the unchanged 1254 × 1254 source.

| Area sampled | Center in source pixels | Sample |
| --- | --- | --- |
| Navy background | 30, 30 | `#001B3E` |
| Warm ivory face | 620, 665 | `#FDE1AE` |
| Mid teal wrap | 670, 1040 | `#006470` |
| Teal crest | 650, 300 | `#0A777A` |
| Lighter teal ear | 366, 472 | `#3A9A7D` |
| Gold clasp | 751, 857 | `#FAB542` |
| Dark eye | 588, 565 | `#060E14` |
| Amber eye | 567, 607 | `#BD6D10` |

The painting contains many intermediate shades. Do not recolor the master to this short table, or claim it is an exact palette of the entire image. A future vector mark or interface palette needs its own explicit token choices and contrast checks. No text accessibility contrast certification is implied by these artwork samples.

## Companion profile banner

The banner extends the avatar's painted navy, teal and warm-gold world into a quiet twilight woodland. Teal leaves frame the top and right edges; amber fireflies and a trail of small lights lead across the center toward the right. The left third, especially the lower-left area, stays comparatively dark and uncluttered for the circular avatar overlap. Low-contrast foliage remains in that space. There is no character, text, logo, UI or border in the artwork.

The avatar PNG was used as the visual style and palette reference for the generation. It was not pasted into the banner. The saved banner prompt requested an exact 17:6 composition, ideally 1360 × 480, for a 680 × 240 upload. The actual generated master is 1884 × 835, so it does not have the requested aspect ratio. It is preserved unchanged as `pip-banner-master-v1.png`.

The production-sized file is `pip-banner-680x240-v1.png`, an opaque RGB PNG measuring exactly 680 × 240 pixels, or 17:6. It is 222,496 bytes, below the 10 MB limit shown in the supplied upload UI. These dimensions and limit document that observed upload target; they are not a claim about every Discord banner surface.

The export was made with ImageMagick using this command from the asset directory:

```sh
magick pip-banner-master-v1.png -filter Lanczos -resize '680x240^' -gravity center -extent 680x240 pip-banner-680x240-v1.png
```

The resize produces 680 × 301 pixels; the centered extent operation removes the excess vertical area to reach 680 × 240. The export preserves the dark left-side space and the principal illuminated foliage and fireflies on the right. Both the full master and final crop were visually inspected. There was no repainting or character redesign during this export.

For future banner variants, retain the original master, keep important detail clear of the overlapping-avatar area, and inspect the final target crop rather than relying only on the uncropped source. Avoid adding lettering or a second Pip portrait. Do not apply the avatar prompt's exclusions on scenery and glow to this separate banner: the banner prompt intentionally introduces woodland foliage and firefly light.

The export's SHA-256 is `6a31c81e1bc906abdaeb6ac180f3dc845d84b4092d37546f7bd5ca49bb9bcb0b`. The master's SHA-256 is `c7aea5ae75942c8a8bcf43ac19f8076364d95002434f6db7b0c314ad132c5f32`. The banner's appearance in a live Discord profile has not been verified by this asset publication.

## Avatar and small-size use

The review sheet supports visual inspection at 32, 64, 128 and 256 px. At the smallest square size, the pale face and teal silhouette remain visible, while the fine mouth line, brows, clasp facets and painted texture become less distinct. This is a visual judgment from the included proof, not a measured recognition test.

For ordinary avatar presentation, retain the full square master and let the target surface apply its normal shape. Do not upload the gray-backed circular QA proof as the avatar. Its gray corners and reduced resolution are part of the proof, not the master artwork.

For a requested raster derivative, start from the master each time, preserve aspect ratio, use a high-quality downsampling filter and inspect the result at its actual display size. Save the derivative under a distinct filename and document the dimensions and source hash. Repeatedly resaving a small preview is not an acceptable replacement for a master-derived export.

No 16 px proof or purpose-drawn favicon exists in this package. A favicon would need separate simplification and review; shrinking the portrait alone has not been validated for that use. The small previews embedded in the QA sheet are not delivered as separate production PNGs.

## Accessibility and descriptive use

Suggested descriptive text when an image description is needed: “Pip, a smiling ivory-faced sprite with large amber eyes, teal leaf-shaped ears and crest, and a teal wrap fastened with a gold clasp.”

In a UI that already labels the account or control as Pip, follow that UI's existing rules for decorative images and redundant alternative text. This package does not introduce a custom interface component or certify accessibility of a target application.

## Generation record and reproducibility

The saved prompts record an initial portrait direction followed by two requests to increase breathing room around the character. Both refinement prompts explicitly ask to preserve the character's identity and finish. The second asks for a more substantial zoom-out.

The exact generator version, seed and complete intermediate image sequence are not established by these files. The prompts support future reference-guided work, but do not guarantee regeneration of identical pixels. Preserve the current PNG when exact continuity is required.

Any later image edit should retain the original master, identify the source image and requested change, save the new result separately, and record both its hash and review outcome. Do not silently replace this version while keeping its old provenance.

## Verification performed for this import

- The master and both QA PNGs decoded successfully, and their dimensions and RGB modes were read from the files.
- The three images were visually inspected.
- All three saved prompts were read and preserved verbatim.
- The master file was preserved byte-for-byte. Its SHA-256 is `393ec6500d81fd50ca2a20bc229e719baf120c6454712034261fdc8d373fe72e`.
- Its locally calculated Git blob SHA-1 is `ef79d2d54522e6b0a0bfa08b63c7fe101acfd932`, matching the SHA returned by GitHub when the binary blob was created.
- The publication does not establish that the image has been uploaded to the Pip Discord application, displayed in a live Discord client, or approved as final artwork.

Typechecks, Bun tests and Docker builds are separate repository checks. The asset checks above do not substitute for them or for the repository's review gate.

## Review checklist for future changes

- [ ] Compare the new image with the preserved master for face, eyes, ear asymmetry, crest, wrap and clasp.
- [ ] Inspect a centered circular crop and confirm the full ears and crest remain visible.
- [ ] Inspect actual-size previews at 32, 64, 128 and 256 px; add any new intended target size.
- [ ] Check that no text, watermark, extra accessory or unintended background detail appeared.
- [ ] Confirm the requested file dimensions, color mode, transparency choice and byte size.
- [ ] Update provenance and any affected QA proofs after the final image changes.
- [ ] Record any final-art approval separately from file verification or repository publication.
- [ ] If a live avatar update is requested, verify the correct Pip application and inspect the resulting display through the authorized operator workflow.

## Repository and live integration boundary

These files live under `assets/PIP/` for Pip's separate identity. Existing Luma assets and their admin-page integration are outside this change. This package adds no runtime references, configuration, API calls, credentials or deployment changes, and does not apply the avatar or banner to the live application.

The related work is [Pip identity epic #332](https://github.com/Rackbops/rackbops-discord-bot/issues/332) and [live acceptance #338](https://github.com/Rackbops/rackbops-discord-bot/issues/338). Publishing the design package does not satisfy their delivery, isolation, acceptance or rollback criteria and does not close either issue.
