# templates

## Overview
Scaffolding that `@getknext/ffi` writes into a user's app. It ships in the tarball:
`package.json` `files` lists `templates`. At run time it is read from beside `dist/` and `src/`
(`src/init.ts:TEMPLATE_DIR`).

## Subdirectories & Boundaries
- init: [./init/EGM.md](./init/EGM.md) holds the files `knext ffi init` copies, which form the
  starter `rust/` crate.
