# lib

## Overview
Shared class-name utility for the `@getknext/ui` components.

## Interface
- `utils.ts:cn(...inputs: ClassValue[])` - returns `twMerge(clsx(inputs))`.

## Invariants
- `utils.ts:cn` resolves conditional class inputs with `clsx` first, then de-duplicates conflicting Tailwind utilities with `twMerge`. A later conflicting utility wins over an earlier one, which is the ordering the components in [`../components/ui/EGM.md`](../components/ui/EGM.md) rely on.

## Side Effects
- None. `utils.ts:cn` is a pure function.

## Verification
- Run: `node ../../scripts/bun-test.mjs packages/ui` (from `packages/ui`)
