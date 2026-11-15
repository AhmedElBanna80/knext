// Declarations for replay-loop.js (kept as .js to match cache-handler.js's
// runtime-loaded style; this .d.ts exists because TS consumers, currently the
// tests, import it and @getknext/core's typecheck runs with implicit-any off).

export interface ReplayLoopOptions {
    label: string;
    pending(): boolean;
    run(): Promise<unknown>;
    retryInMs(): number;
    unreachable(): boolean;
    onUnreachable(): void;
    track(p: Promise<unknown>): Promise<unknown>;
    log?: (...args: unknown[]) => void;
}

export interface ReplayLoop {
    start(): void;
    reset(): void;
}

export declare function createReplayLoop(opts: ReplayLoopOptions): ReplayLoop;
