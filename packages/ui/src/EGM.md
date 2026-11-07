# src

## Overview
Source root of `@getknext/ui`. `index.ts` is the package entry point: `main`, `types` and the `"."` export in `packages/ui/package.json` all point at it. It re-exports the component and utility surface. `styles/globals.css` holds the Tailwind directives and, in `@layer base`, the HSL theme variables (`--background`, `--foreground`, `--card`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, their `-foreground` pairs, and `--radius: 0.5rem`) on `:root` with dark overrides under `.dark`. It is not imported by `index.ts`.

## Interface
- `index.ts` re-exports `Button`, `type ButtonProps` and `buttonVariants` from `./components/ui/button`.
- `index.ts` re-exports `Card`, `CardContent`, `CardDescription`, `CardFooter`, `CardHeader` and `CardTitle` from `./components/ui/card`.
- `index.ts` re-exports `cn` from `./lib/utils`.
- Subdirectories:
  - [`./components/EGM.md`](./components/EGM.md) - component grouping (see [`./components/ui/EGM.md`](./components/ui/EGM.md)).
  - [`./lib/EGM.md`](./lib/EGM.md) - the `cn` class-merge utility.

## Invariants
- `index.ts` is re-exports only. It defines no symbols of its own, so the public surface of the package root is exactly the names listed above.

## Side Effects
- None. Importing `index.ts` only evaluates the re-exported modules, which define components and constants.
- `styles/globals.css`, when a consumer's build includes it, applies global base styles: `* { @apply border-border }` and `body { @apply bg-background text-foreground }`.

## Verification
- Run: `node ../../scripts/bun-test.mjs packages/ui` (from `packages/ui`)
