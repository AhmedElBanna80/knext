/**
 * #68 — portable shell helper (Node child_process, argv arrays).
 *
 * The kn-next CLI must run on plain Node (no Bun). The shell helper that
 * replaces `import { $ } from "bun"` / `Bun.spawn` must:
 *   1. Run a real command via an ARGV array and return its stdout (capture()).
 *   2. NEVER interpret shell metacharacters — each argv element is a single,
 *      uninterpreted token. This is the injection-safety guarantee that
 *      `Bun.$` provided via auto-escaping and that we must reproduce.
 *   3. Reject a non-zero exit with an error that carries the exit code.
 *   4. Expose nothing from the "bun" module — the helper is Node-native.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capture, run } from "../cli/exec";

describe("#68 exec helper — capture()", () => {
    it("returns stdout for a real command via an argv array", async () => {
        const out = await capture(["node", "-e", "process.stdout.write('hi')"]);
        expect(out).toBe("hi");
    });

    it("treats a metacharacter-laden argument as ONE uninterpreted token (no shell injection)", async () => {
        // If this were concatenated into a shell string, `$(whoami)` and `` `id` ``
        // would be command-substituted and `; touch …` would run a 2nd command.
        // With an argv array the whole thing is ONE literal argument echoed back
        // verbatim — proving no shell interpretation happened. The marker we
        // expect NOT to see is the OUTPUT of any substituted command, so we
        // build it from a unique token that only appears if a shell ran it.
        const sentinel = "INJECTED_BY_SHELL";
        const payload = `value; echo ${sentinel}; $(echo ${sentinel}) \`echo ${sentinel}\``;
        const out = await capture([
            "node",
            "-e",
            "process.stdout.write(process.argv[1])",
            payload,
        ]);
        // Output is EXACTLY the payload — the literal string, unmodified.
        expect(out).toBe(payload);
        // If a shell had run, `$(echo X)`/`` `echo X` `` would collapse to `X`,
        // so the payload would no longer contain the literal `$(echo …)` form.
        // Its survival proves no substitution occurred.
        expect(out).toContain(`$(echo ${sentinel})`);
        expect(out).toContain(`\`echo ${sentinel}\``);
    });

    it("does not expand a glob or variable passed as an argument", async () => {
        const out = await capture([
            "node",
            "-e",
            "process.stdout.write(process.argv[1])",
            "*; $HOME",
        ]);
        expect(out).toBe("*; $HOME");
    });

    it("rejects on a non-zero exit code", async () => {
        await expect(
            capture(["node", "-e", "process.exit(3)"]),
        ).rejects.toThrow(/exit|code|3/i);
    });
});

describe("#68 exec helper — run()", () => {
    it("resolves (to undefined) on exit 0", async () => {
        // run() resolves with no value on success. Assert the resolution
        // directly — chaining `.resolves.not.toThrow()` misuses toThrow (a
        // function-matcher) against an already-resolved value, which some
        // runners (bun test) correctly reject.
        await expect(
            run(["node", "-e", "process.exit(0)"]),
        ).resolves.toBeUndefined();
    });

    it("rejects on a non-zero exit", async () => {
        await expect(run(["node", "-e", "process.exit(1)"])).rejects.toThrow(
            /exit|code|1/i,
        );
    });
});

describe("#68 exec module is Node-native (no bun import)", () => {
    it("exec.ts source imports node:child_process and not the bun module", () => {
        const src = readFileSync(
            join(__dirname, "..", "cli", "exec.ts"),
            "utf-8",
        );
        expect(src).toContain("node:child_process");
        // No `from "bun"` import in actual CODE (the docstring may mention what
        // it replaces, so strip comments before matching).
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:])\/\/.*$/gm, "$1");
        expect(code).not.toMatch(/import[^;]*from\s+["']bun["']/);
    });
});
