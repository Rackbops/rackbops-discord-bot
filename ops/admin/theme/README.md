# ops/admin/theme

Build-only package: turns the pinned `@rackbops/styles` into `../public/rb-theme.css`, which is **committed** (no build at deploy, no CDN at runtime).
To bump the design system: edit the exact pin in `package.json`, run `bun install`, then `bun run build`, and commit both `package.json`/`bun.lock` and the regenerated `rb-theme.css`.
Never hand-edit `rb-theme.css`; its first line names the version it was built from.
`ops/admin/server.test.ts` fails if that stamped version and the pin disagree, so a bump without a rebuild cannot merge.
