// Declarations for include-plan.mjs (runtime-neutral: node fs/path only).

export type EmbedPlan = {
    root: string;
    entrypoints: string[];
    relpaths: string[];
    report: { excluded: string[]; nonModule: string[]; unmatched: string[] };
};

export declare function planIncludes(root: string, include: string[]): EmbedPlan;
export declare function planEmbed(input: {
    root: string;
    include: string[];
    exclude?: string[];
}): EmbedPlan;
export declare function embeddedPath(rel: string): string;
export declare function walkFiles(dir: string, root: string, out: string[]): void;
export declare const toPosix: (p: string) => string;
