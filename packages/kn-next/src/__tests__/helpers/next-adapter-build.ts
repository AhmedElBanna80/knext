/**
 * A stand-in for `next build` with a knext adapter wired (#2250), for tests
 * that stub the build runner. On `npm run build` it records `resolved` the way
 * the adapter's `modifyConfig` does, through the real `recordNextConfigFacts`
 * and the env the CLI set, and lets its refusal throw, failing the build as
 * Next would. Any other command is a no-op. `projectDir` is what Next passes
 * to `modifyConfig`; set it to stand in for a build of another directory.
 */

import { recordNextConfigFacts } from "../../adapters/next-config-facts.js";

export interface ResolvedNextConfig {
    distDir?: string;
    output?: string;
    experimental?: { turbopackModuleFragments?: boolean };
}

export function adapterBuild(
    resolved: ResolvedNextConfig = {},
    projectDir?: string,
) {
    return (argv: readonly unknown[]): void => {
        if (argv[0] === "npm" && argv[1] === "run" && argv[2] === "build") {
            recordNextConfigFacts(
                {
                    distDir: ".next",
                    output: "standalone",
                    experimental: {},
                    ...resolved,
                },
                { phase: "phase-production-build", projectDir },
            );
        }
    };
}

/** The resolved config that turns the Bun-incompatible chunks on. */
export const FRAGMENTS_ON: ResolvedNextConfig = {
    experimental: { turbopackModuleFragments: true },
};
