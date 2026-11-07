# ui (shadcn primitives)

## Overview
React 19 presentational primitives in the shadcn "new-york" style (`packages/ui/components.json`). Each component is a `React.forwardRef` wrapper around a native element that merges caller classes over fixed Tailwind defaults via `cn` from [`../../lib/EGM.md`](../../lib/EGM.md).

## Interface
- `button.tsx:buttonVariants` - `cva` class builder. Variants `variant`: `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`; `size`: `default`, `sm`, `lg`, `icon`. `defaultVariants` is `{ variant: 'default', size: 'default' }`.
- `button.tsx:ButtonProps` - extends `React.ButtonHTMLAttributes<HTMLButtonElement>` and `VariantProps<typeof buttonVariants>`, plus optional `asChild?: boolean`.
- `button.tsx:Button` - `forwardRef<HTMLButtonElement, ButtonProps>`. Renders `Slot` from `@radix-ui/react-slot` when `asChild` is true, otherwise a native `button`. `displayName = 'Button'`.
- `card.tsx:Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` - each is `forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>` rendering a `div`, with a `displayName` matching the export name.

## Invariants
- `button.tsx:Button` defaults `asChild = false`, so a native `button` element is rendered unless the caller opts in to `Slot`.
- `button.tsx:Button` passes `className` into `buttonVariants({ variant, size, className })` and wraps the result in `cn`, so caller classes are merged through `tailwind-merge` and win on conflicting utilities.
- Every `card.tsx` component calls `cn(<default classes>, className)` with the defaults first, so the caller's `className` overrides conflicting defaults.
- All components forward `ref` and spread remaining `...props` onto the rendered element.
- `card.tsx:CardTitle` renders a `div`, not a heading element.

## Side Effects
- None. The components are pure render functions with no state, effects, network, or storage access.

## Verification
- Run: `node ../../scripts/bun-test.mjs packages/ui` (from `packages/ui`)
