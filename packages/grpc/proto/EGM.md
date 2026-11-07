# proto

## Overview

The buf module of `@getknext/grpc` (`../buf.yaml`, `modules: - path: proto`).
It holds the contracts this package ships for apps to import. `package.json`
lists `proto` under `files`, and `src/add-function.ts:packagedOptionsProto`
reads `proto/knext/v1/options.proto` at run time.

## Subdirectories & Boundaries

- knext: [./knext/EGM.md](./knext/EGM.md) - the versioned knext packages; `v1`
  is the zone-function options contract (function name, contract version, and
  per-RPC `Auth`).
