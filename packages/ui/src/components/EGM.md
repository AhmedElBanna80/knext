# components

## Overview
Grouping directory for the package's React components. It holds no source files directly. All components live in the `ui` subdirectory, which matches the `ui` alias (`@/components/ui`) in `packages/ui/components.json`.

## Subdirectories & Boundaries
- ui: [`./ui/EGM.md`](./ui/EGM.md) - shadcn-style `Button` (with `buttonVariants` and `ButtonProps`) and the `Card` family (`Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`). All are stateless `forwardRef` wrappers that merge classes with `cn`.
