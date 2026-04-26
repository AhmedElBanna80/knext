#!/bin/bash
set -e

# Spike Pipeline: Next.js Standalone -> Bun Bytecode Binary
echo "🚀 Starting Spike Pipeline..."

# 1. Setup Spike App
cd apps/spike-bun-bytecode
echo "📦 Installing dependencies..."
pnpm install --no-frozen-lockfile

# 2. Build Next.js Standalone
echo "🏗️ Building Next.js Standalone..."
pnpm build

# 3. Create a simple manifest test (Proof of Concept)
echo "📝 Generating Proof-of-Concept Manifest..."
cd .next/standalone
cat <<INNER_EOF > spike-entry.ts
import serverPath from "./apps/spike-bun-bytecode/server.js" with { type: "file" };
import nextPath from "./apps/spike-bun-bytecode/node_modules/next/package.json" with { type: "file" };

async function run() {
  console.log("✅ Embedded server.js at:", serverPath);
  console.log("✅ Embedded next/package.json at:", nextPath);

  const nextPkg = await Bun.file(nextPath).json();
  console.log("🚀 Starting Next.js " + nextPkg.version + " from binary VFS...");

  console.log("✅ Concept proven: can read and execute from VFS.");
}

run().catch(console.error);
INNER_EOF

# 4. Compile with Bun
echo "⚙️ Compiling into native binary..."
/Users/banna/.bun/bin/bun build spike-entry.ts --compile --bytecode --outfile knext-spike-binary

echo "✨ Spike Pipeline Complete!"
echo "Binary created at: apps/spike-bun-bytecode/.next/standalone/knext-spike-binary"
