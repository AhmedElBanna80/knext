/**
 * Shared CLI utilities for kn-next build and deploy commands.
 * Single source of truth for config loading.
 *
 * NOTE: copyAdapters and getNitroPreset were removed as part of the
 * vinext → official Next.js Adapter migration. The CLI now runs plain
 * `npm run build` which invokes `next build` with output:'standalone'.
 * Adapters are no longer copied to a Nitro .output/ directory.
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import type { KnativeNextConfig } from "../config";
import { validateConfig } from "./validate";

/**
 * Portable "is this module the entry point?" check (#68).
 *
 * Bun exposes `import.meta.main`; plain Node does not. Comparing the module's
 * own file URL against the executed script path (argv[1]) works on both
 * runtimes. realpathSync resolves symlinks (npm bin shims, .bin/ links) so the
 * comparison holds when the CLI is launched via an installed `kn-next` bin.
 *
 * @param importMetaUrl - pass `import.meta.url` from the calling module
 */
export function isMainModule(importMetaUrl: string): boolean {
    const entry = argv[1];
    if (!entry) {
        return false;
    }
    const modulePath = fileURLToPath(importMetaUrl);
    try {
        return realpathSync(modulePath) === realpathSync(entry);
    } catch {
        return modulePath === entry;
    }
}

const CONFIG_FILE = "kn-next.config.ts";

/**
 * Loads kn-next.config.ts from the current working directory.
 * Runs validation after loading — fails fast with clear error messages.
 */
export async function loadConfig(): Promise<KnativeNextConfig> {
    const configPath = resolve(process.cwd(), CONFIG_FILE);

    if (!existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }

    const module = await import(configPath);
    const config: KnativeNextConfig = module.default;

    validateConfig(config);

    return config;
}
