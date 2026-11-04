export declare const ALIASED_FS: { fs: string[]; promises: string[] };

export declare function installEmbeddedDataAlias(
    files: { rel: string; path: string }[],
    where: { appRoot: string; cwd?: string },
): (p: unknown) => unknown;
