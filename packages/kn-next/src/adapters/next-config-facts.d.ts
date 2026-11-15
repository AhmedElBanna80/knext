/** Hand-maintained types for `next-config-facts.js` (#2250). */

export interface NextConfigFacts {
    distDir: string;
    output: string | null;
    turbopackModuleFragments: boolean;
    /** Set when the adapter refused the build; the refusal's code. */
    refused?: string;
}

export interface NextConfigRefusal {
    code: "custom-dist-dir" | "bun-turbopack-fragments";
    message: string;
}

export declare const CONFIG_FACTS_OUT_ENV: "KNEXT_CONFIG_FACTS_OUT";
export declare const KNEXT_BUILDER_ENV: "KNEXT_BUILDER";
export declare const CUSTOM_DIST_DIR_MESSAGE: (distDir: string) => string;
export declare const TURBOPACK_FRAGMENTS_BUN_DETAIL: string;
export declare const TURBOPACK_FRAGMENTS_BUN_HINT: string;

export declare function isDefaultDistDir(distDir: unknown): boolean;
export declare function refusalFor(
    facts: Pick<NextConfigFacts, "distDir" | "turbopackModuleFragments"> &
        Partial<NextConfigFacts>,
    opts: { runtime?: string; builder?: string },
): NextConfigRefusal | undefined;
export declare function recordNextConfigFacts(
    config: {
        distDir?: string;
        output?: string;
        experimental?: { turbopackModuleFragments?: boolean };
    },
    ctx: { phase: string },
    env?: Record<string, string | undefined>,
): NextConfigFacts | undefined;
export declare function readNextConfigFacts(
    path: string,
): NextConfigFacts | undefined;

declare const factsAdapter: {
    name: "knext-config-facts";
    modifyConfig<C extends Record<string, unknown>>(
        config: C,
        ctx: { phase: string },
    ): C;
};
export default factsAdapter;
