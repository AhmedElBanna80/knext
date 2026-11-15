// Declarations for tag-backlog.js (kept as .js to match cache-handler.js's
// runtime-loaded style; this .d.ts exists because TS consumers, currently the
// tests, import it and @getknext/core's typecheck runs with implicit-any off).

/** Entries a backlog holds before it collapses. */
export declare const BACKLOG_MAX_ENTRIES: number;

/** A stored value: the generation itself, or a record that carries it. */
export type BacklogValue = number | { generation: number };

export interface TagBacklog {
    readonly max: number;
    readonly collapsed: boolean;
    readonly generation: number;
    snapshot(ns: string): Array<[string, BacklogValue]>;
    sizeOf(ns: string): number;
    size(): number;
    pending(): boolean;
    record(
        ns: string,
        names: Iterable<string>,
        value?: (
            prev: BacklogValue | undefined,
            generation: number,
        ) => BacklogValue,
    ): boolean;
    settle(ns: string, name: string, recordedAt: number): boolean;
    beginSweep(): number;
    endSweep(startedAt: number): void;
    dropCollapse(): void;
    clear(): void;
}

export declare function createTagBacklog(opts?: {
    namespaces?: string[];
    max?: number;
    onCollapse?: (namespace: string) => void;
}): TagBacklog;
