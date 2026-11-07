# @getknext/ui

## Overview
A private (`"private": true` in `package.json`) React 19 component library in shadcn style (`components.json`: `style: "new-york"`, `rsc: true`, `tsx: true`). It is consumed from source: there is no build step, and `main`, `types` and the `"."` export all resolve to `./src/index.ts`. This package is never published to npm.

## Interface
- `package.json:exports["."]` -> `./src/index.ts` (see [`./src/EGM.md`](./src/EGM.md)).
- `package.json:exports["./components/*"]` -> `./src/components/*.tsx`. Because the components live in `src/components/ui/`, the wildcard has to include the `ui/` segment, as in `@getknext/ui/components/ui/button`.
- `package.json:scripts.test` is `node ../../scripts/bun-test.mjs packages/ui`. `scripts.typecheck` runs `../../node_modules/typescript-tsc7/bin/tsc --noEmit`.
- `tailwind.config.ts:config` (default export, `Config`) sets `darkMode: ['class']`, `content: ['./src/**/*.{ts,tsx}']`, `borderRadius` `lg`/`md`/`sm` derived from `var(--radius)`, an empty `colors` extension, and `plugins: [require('tailwindcss-animate')]`.
- `tsconfig.json` maps the path alias `@/*` to `./src/*` and sets `strict`, `noEmit`, `jsx: "react-jsx"` and `types: ["bun"]`.
- Subdirectories:
  - [`./src/EGM.md`](./src/EGM.md) - package entry point and re-export surface.
  - [`./src/components/EGM.md`](./src/components/EGM.md) -> [`./src/components/ui/EGM.md`](./src/components/ui/EGM.md) - `Button` and the `Card` family.
  - [`./src/lib/EGM.md`](./src/lib/EGM.md) - the `cn` utility.

## Invariants
- `react` and `react-dom` `^19.0.0` are `peerDependencies`, so consumers supply React.
- Runtime `dependencies` are limited to `class-variance-authority`, `clsx`, `tailwind-merge` and `@radix-ui/react-slot`.
- `tailwind.config.ts` loads `tailwindcss-animate`, but that package is not declared in `package.json` `dependencies` or `devDependencies`, so it must be resolvable from the workspace.
- `tsconfig.node.json` includes `vite.config.ts`, but no such file exists in this package.
- `devDependencies` pin `tailwindcss` `^4`, while `tailwind.config.ts` and `src/styles/globals.css` (`@tailwind base/components/utilities`) use the v3-style JS config and directives.
- `tailwind.config.ts` extends `colors` with nothing, so the token classes the components use (`bg-primary`, `border-input`, `bg-card`, ...) are not mapped to the `--primary`/`--card`/... CSS variables that `src/styles/globals.css` defines. A consumer must supply that mapping.
- `package.json:exports` exposes only `"."` and `"./components/*"`, so `src/styles/globals.css` (named as the shadcn `tailwind.css` in `components.json`) is not reachable through a package subpath.

## Side Effects
- None at runtime. The package's source has no I/O, network, or global-state mutation.

## Verification
- Run: `node ../../scripts/bun-test.mjs packages/ui` (from `packages/ui`)
