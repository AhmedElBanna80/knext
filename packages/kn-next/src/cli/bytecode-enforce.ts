/**
 * The ONE place a failed bytecode verdict becomes a failed build: delete the
 * artifact (a binary that failed the proof must never be picked up by the
 * image step) and throw the actionable error. Shared by every compiled target.
 */

import { rmSync } from "node:fs";
import { UsageError } from "./shared";

export type BytecodeVerdict = { ok: true } | { ok: false; reason: string };

export function enforceBytecodeVerdict(
    verdict: BytecodeVerdict,
    artifactPath: string,
    what: string,
): void {
    if (verdict.ok) return;
    rmSync(artifactPath, { force: true });
    throw new UsageError(
        `The compiled ${what} executable failed the bytecode check: ${verdict.reason}.\n\n` +
            "Refusing to ship it — a binary without bytecode boots, but pays a full compile on every cold start.",
    );
}
