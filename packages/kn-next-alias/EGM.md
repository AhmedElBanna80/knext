# kn-next-alias

## Overview

The legacy bare-name npm alias package (`package.json` `description`: "All
functionality lives in @getknext/core — this package only forwards to its
CLI"). It holds no direct source files; its only code is the forwarding shim
under `bin/`. It depends on `@getknext/core` (`package.json` `dependencies`),
requires Node `>=24` (`package.json` `engines`), and publishes only `bin`,
`README.md` and `LICENSE` (`package.json` `files`) publicly with npm
provenance (`package.json` `publishConfig.access: public`,
`publishConfig.provenance: true`). Its single `bin` entry maps to
`bin/kn-next.js` (`package.json` `bin`). The canonical command is `knext`.

## Subdirectories & Boundaries

- bin: [./bin/EGM.md](./bin/EGM.md) - Node shim that resolves the
  `@getknext/core` CLI entry point and re-executes it in a child process with
  the same argv, forwarding `SIGINT`/`SIGTERM`/`SIGHUP` and propagating the
  child's exit code or signal.
