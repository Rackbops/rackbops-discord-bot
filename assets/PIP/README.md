# Pip design assets

This folder holds Pip's avatar, companion profile banner and design artifacts for the separate Pip Discord identity.

## Files

- [Avatar PNG](pip-canonical-review-v1.png): the original 1254 × 1254 RGB PNG, preserved byte-for-byte.
- [Profile banner upload PNG](pip-banner-680x240-v1.png): 680 × 240 RGB PNG (17:6), 222,496 bytes.
- [Profile banner master](pip-banner-master-v1.png): the unmodified generated 1884 × 835 PNG.
- [Banner generation prompt](prompt-banner-v1.txt): the exact prompt, with the avatar used as the style and palette reference.
- [Circular-crop inspection](qa-circular-inspection.png): a 512 × 512 review proof.
- [Size inspection](qa-size-inspection.png): square previews at 32, 64, 128 and 256 px, plus small circular previews.
- [Initial design prompt](prompt-canonical-v1.txt) and framing refinements [one](prompt-refine-1.txt) and [two](prompt-refine-2.txt): the saved prompts, preserved verbatim.
- [Full design specification](pip-design-spec.md): identity, composition, finish, sampled colors, small-size use, reproduction limits and review checklist.
- [Provenance and verification](provenance.json).

The avatar is a painted teal-and-ivory messenger sprite against a dark navy background, with leaf-shaped ears, a swept crest, large amber-and-dark eyes, a teal wrap and a gold clasp. The QA images are review aids, not alternative avatar masters. The prompts record design intent, not a guarantee of exact reproducibility.

The companion banner uses painted navy woodland, teal foliage and warm amber fireflies, with the left side kept dark for the overlapping avatar. Use the 680 × 240 export for the requested profile-banner upload. It was derived from the preserved master with a Lanczos resize to cover, followed by a centered crop; see the specification and provenance for the exact command.

## Verification and status

The PNGs were decoded successfully and visually inspected. The canonical PNG's SHA-256 is `393ec6500d81fd50ca2a20bc229e719baf120c6454712034261fdc8d373fe72e`.

This is an asset-only change. It does not set the Discord application's avatar or banner, or alter any running instance. Related work: [Pip identity epic #332](https://github.com/Rackbops/rackbops-discord-bot/issues/332) and [live acceptance #338](https://github.com/Rackbops/rackbops-discord-bot/issues/338). This asset delivery does not complete either issue.
