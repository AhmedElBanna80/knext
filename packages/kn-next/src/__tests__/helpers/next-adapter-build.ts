/**
 * A stand-in for `next build` with a knext adapter wired (#2250), for tests
 * that stub the build runner. On `npm run build` it records `resolved` the way
 * the adapter's `modifyConfig` does, through the real `recordNextConfigFacts`
 * and the env the CLI set, and lets its refusal throw, failing the build as
 * Next would. Any other command is a no-op.
 */

import { recordNextConfigFacts } from "../../adapters/next-config-facts.js";

export interface ResolvedNextConfig {
    distDir?: string;
    output?: string;
    experimental?: { turbopackModuleFragments?: boolean };
}

export function adapterBuild(resolved: ResolvedNextConfig = {}) {
    return (argv: readonly unknown[]): void => {
        if (argv[0] === "npm" && argv[1] === "run" && argv[2] === "build") {
            recordNextConfigFacts(
                {
                    distDir: ".next",
                    output: "standalone",
                    experimental: {},
                    ...resolved,
                },
                { phase: "phase-production-build" },
            );
        }
    };
}

/** The resolved config that turns the Bun-incompatible chunks on. */
export const FRAGMENTS_ON: ResolvedNextConfig = {
    experimental: { turbopackModuleFragments: true },
};
