/**
 * #2481, on the path a user actually runs. `knext deploy function` prints its
 * preflight failure from @getknext/grpc, not from core's `formatPreflightFailure`.
 * This drives the REAL chain — grpc's `deployFunction`, core's `buildDeployHost`
 * and `preflightCRSchema` — with only kubectl stubbed,
 * for a BackendService the installed CRD is too old to know.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { deployFunction } from "../../../grpc/src/deploy-function";
import { buildDeployHost } from "../cli/grpc-dispatch";
import type { KubectlResult } from "../cli/schema/preflight";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASES = join(
    HERE,
    "..",
    "..",
    "..",
    "kn-next-operator",
    "config",
    "crd",
    "bases",
);
const FIXTURE = join(HERE, "..", "..", "..", "grpc", "fixtures", "zone");
const DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE = `registry.example.com/shop/orders@${DIGEST}`;

const scratch: string[] = [];
afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** The shipped BackendService CRD with `spec.wakeAhead` removed: an older operator. */
function oldBackendServiceCrd(): string {
    const crd = YAML.parse(
        readFileSync(
            join(BASES, "apps.kn-next.dev_backendservices.yaml"),
            "utf8",
        ),
    );
    // biome-ignore lint/suspicious/noExplicitAny: walking a parsed CRD document
    const spec = crd.spec.versions[0].schema.openAPIV3Schema.properties
        .spec as any;
    expect(spec.properties.wakeAhead).toBeDefined();
    delete spec.properties.wakeAhead;
    return JSON.stringify(crd);
}

async function deployAgainstOldCrd() {
    const dir = mkdtempSync(join(tmpdir(), "knext-2481-real-path-"));
    scratch.push(dir);
    cpSync(FIXTURE, dir, { recursive: true });
    const argvs: string[][] = [];
    const kubectl = {
        capture: (argv: readonly string[]): KubectlResult => {
            argvs.push([...argv]);
            const a = argv.join(" ");
            if (a.includes("--dry-run=server")) {
                return {
                    ok: false,
                    stdout: "",
                    stderr: 'Error from server (BadRequest): strict decoding error: unknown field "spec.wakeAhead"',
                };
            }
            if (a.includes("--raw"))
                return { ok: false, stdout: "", stderr: "forbidden" };
            if (a.includes("get crd backendservices.apps.kn-next.dev")) {
                return { ok: true, stdout: oldBackendServiceCrd(), stderr: "" };
            }
            return {
                ok: false,
                stdout: "",
                stderr: `unexpected kubectl: ${a}`,
            };
        },
        run: () => {
            throw new Error("apply must not run after a failed preflight");
        },
    };
    let err = "";
    const code = await deployFunction({
        cwd: dir,
        argv: [
            "function",
            "orders",
            "--zone",
            "shop",
            "--image",
            IMAGE,
            "--namespace",
            "prod",
            "--no-wake-ahead",
        ],
        io: {
            stdout: () => {},
            stderr: (s) => {
                err += s;
            },
        },
        host: buildDeployHost(kubectl),
    });
    return { code, err, argvs };
}

describe("knext deploy function: preflight skew on the real path (#2481)", () => {
    it("reads the BackendService CRD, names BackendService, and names the unknown field", async () => {
        const { code, err, argvs } = await deployAgainstOldCrd();
        expect(code).toBe(1);

        // (a) the known-field set came from the BackendService CRD, never NextApp's.
        const crdReads = argvs
            .filter((a) => a.includes("crd"))
            .map((a) => a.join(" "));
        expect(
            crdReads.some((a) =>
                a.includes("backendservices.apps.kn-next.dev"),
            ),
        ).toBe(true);
        expect(argvs.flat().some((a) => a.includes("nextapps"))).toBe(false);

        // (b) the printed message names BackendService.
        expect(err).toContain("PREFLIGHT FAILED");
        expect(err).toContain("BackendService CRD");
        expect(err).toContain("backendservices.apps.kn-next.dev");
        expect(err).not.toMatch(/NextApp/);

        // (c) the unknown field is named.
        expect(err).toContain("spec.wakeAhead");
    });
});
