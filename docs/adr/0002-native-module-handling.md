# ADR 0002: Native Module Handling

## Context
Next.js and its underlying tools (like SWC and LightningCSS) use native binaries for performance. When bundling a Next.js application into a single self-contained binary using Bun, handling these native dependencies is challenging because they cannot be easily cross-compiled or bundled into a single JS/TS file. We need a strategy to ensure these essential native modules are available at runtime.

## Options

### Option A: Embed via `{ type: 'file' }`
Use Bun's `{ type: 'file' }` import syntax to embed the native `.node` binaries or platform-specific executables into the binary. This makes the modules available via the Bun virtual file system (`$bunfs`).

### Option B: External Dynamic Linking
Keep native modules outside the binary and require them to be present on the host system in a specific directory.

### Option C: Drop Non-Essential Native Dependencies (sharp)
Remove dependencies on native modules that are not strictly required for the core application to function. For example, dropping `sharp` for image optimization to minimize supply chain risk and binary size.

## Decision
**Option A for essential modules and Option C for non-essential modules.**

We will:
- Use **Option A** to embed essential native binaries: `@next/swc-*` and `lightningcss`.
- Use **Option C** to drop `sharp` (Next/Image optimization) for v1.

## Rationale
- **Option A** ensures that essential performance-critical components like SWC are available regardless of the host environment, maintaining the "self-contained" promise of the final binary.
- **Option C** for `sharp` minimizes supply chain risk, reduces the final binary size significantly for v1, and avoids complex cross-compilation/bundling issues associated with `libvips`.

## Native Dependencies
- `@next/swc-*`
- `lightningcss`

## Consequences
- The final binary size will include the native binaries for SWC and LightningCSS.
- Cross-platform binary generation will require embedding the correct native binary for the target architecture.
- Image optimization will be disabled or limited by default in v1.

## Revisit triggers
- If users require high-performance image optimization in production.
- If Bun provides a more native way to handle Node.js native addons in bundled binaries.
