/**
 * exec.ts — portable shell helper for the kn-next CLI (#68).
 *
 * Replaces `import { $ } from "bun"` / `Bun.spawn(...)` so the CLI runs on
 * plain Node as well as Bun. Backed by Node's `node:child_process.spawn`.
 *
 * INJECTION SAFETY (the Bun.$ guarantee we must reproduce):
 *   Every command is invoked as an ARGV array — `spawn(cmd, args)` with
 *   `shell: false` (the default). No string is ever handed to a shell, so
 *   shell metacharacters (`;`, `|`, `$()`, backticks, `*`, spaces, …) inside
 *   an argument are passed through verbatim as a single, uninterpreted token.
 *   This is structurally injection-proof: there is no shell to inject into.
 *   Do NOT add a `shell: true` option or build command strings here.
 *
 * Both Node and Bun implement `node:child_process`, so this single module
 * works on both runtimes — Bun stays a first-class supported runtime.
 */

import { spawn } from "node:child_process";

export interface ExecOptions {
    /** Working directory for the spawned process. Defaults to process.cwd(). */
    cwd?: string;
    /**
     * When true, suppress the child's stdout/stderr from being inherited by
     * this process (mirrors Bun.$`...`.quiet()). Output is still captured and
     * returned/available on error. Defaults to false (inherit stderr).
     */
    quiet?: boolean;
    /** Extra environment variables merged over process.env. */
    env?: NodeJS.ProcessEnv;
}

/**
 * Error thrown when a spawned command exits non-zero. Carries the exit code,
 * the argv, and captured stderr so callers can produce a clear failure.
 */
export class ExecError extends Error {
    readonly code: number | null;
    readonly argv: string[];
    readonly stderr: string;

    constructor(argv: string[], code: number | null, stderr: string) {
        super(
            `Command failed with exit code ${code}: ${argv.join(" ")}` +
                (stderr ? `\n${stderr}` : ""),
        );
        this.name = "ExecError";
        this.code = code;
        this.argv = argv;
        this.stderr = stderr;
    }
}

/**
 * Internal: spawn an argv with no shell and collect stdout/stderr.
 * Rejects with ExecError on a non-zero exit (or spawn failure).
 */
function spawnArgv(
    argv: string[],
    options: ExecOptions,
): Promise<{ stdout: string; stderr: string }> {
    if (!Array.isArray(argv) || argv.length === 0) {
        return Promise.reject(
            new Error("exec: argv must be a non-empty string[]"),
        );
    }
    const [cmd, ...args] = argv;

    return new Promise((resolve, reject) => {
        // shell:false (default) — argv elements are passed directly to the OS,
        // never concatenated into a shell command line. This is the no-injection
        // guarantee; keep it.
        const child = spawn(cmd, args, {
            cwd: options.cwd ?? process.cwd(),
            env: options.env ? { ...process.env, ...options.env } : process.env,
            stdio: ["ignore", "pipe", options.quiet ? "pipe" : "inherit"],
        });

        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", (err) => reject(err));
        child.on("close", (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new ExecError(argv, code, stderr));
            }
        });
    });
}

/**
 * Run a command to completion. Resolves on exit 0, rejects (ExecError) otherwise.
 * Mirrors `await Bun.$`cmd`` — use when you don't need the output.
 *
 * @param argv - command + args as a single ARGV array (NOT a shell string)
 */
export async function run(
    argv: string[],
    options: ExecOptions = {},
): Promise<void> {
    await spawnArgv(argv, options);
}

/**
 * Run a command and return its stdout as a string.
 * Mirrors `await Bun.$`cmd`.text()` / the old `Bun.spawn(...).stdout` capture.
 *
 * @param argv - command + args as a single ARGV array (NOT a shell string)
 * @returns the child's stdout (not trimmed — callers trim as needed)
 */
export async function capture(
    argv: string[],
    options: ExecOptions = {},
): Promise<string> {
    // Capture mode always pipes both streams so output is never lost.
    const { stdout } = await spawnArgv(argv, { ...options, quiet: true });
    return stdout;
}
