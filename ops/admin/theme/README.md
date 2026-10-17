# ops/admin/theme

Build-only package: turns the pinned `@rackbops/styles` into `../public/rb-theme.css`, which is **committed** (no build at deploy, no CDN at runtime).
To bump the design system: edit the exact pin in `package.json`, run `bun install`, then `bun run build`, and commit both `package.json`/`bun.lock` and the regenerated `rb-theme.css`.
Never hand-edit `rb-theme.css`; its first line names the version it was built from.
`ops/admin/server.test.ts` compares the stamped banner with the pin, so forgetting to rebuild after a bump fails CI.
It checks the banner line only: a hand edit below it is not caught, which is why the file is never hand-edited.
