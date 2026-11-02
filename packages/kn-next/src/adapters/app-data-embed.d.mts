export type AppDataFile = {
    rel: string;
    abs: string;
    size: number;
    declared: boolean;
    aliases: string[];
};

export type AppDataPlan = {
    files: AppDataFile[];
    totalBytes: number;
    skipped: { rel: string; reason: string }[];
    warnings: string[];
};

export declare function readTraceIncludes(
    root: string,
    opts?: { warn?: (message: string) => void },
): Promise<string[]>;

export declare function serverOutputFiles(serverDir: string): string[];

export declare function scanDataLiterals(source: string, cwdRoot: string, entryDir: string): string[];

export declare function planAppData(input: {
    root: string;
    includes: string[];
    candidates?: string[];
    sidecarPackages?: Iterable<string>;
}): AppDataPlan;

export declare function dataPathsMissing(binary: Uint8Array, files: { rel: string }[]): string[];

export declare function rewriteFsImports(
    source: string,
    prefix: string,
): { contents: string; count: number };

export declare function discoverDataLiterals(input: {
    serverDir: string;
    cwdRoot: string;
    entryDir: string;
}): string[];
