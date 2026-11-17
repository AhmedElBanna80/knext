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

/** The shipped BackendService CRD; with `withoutWakeAhead`, `spec.wakeAhead` is removed (an older operator). */
function backendServiceCrd(withoutWakeAhead: boolean): string {
    const crd = YAML.parse(
        readFileSync(
            join(BASES, "apps.kn-next.dev_backendservices.yaml"),
            "utf8",
        ),
    ) as {
        spec: {
            versions: {
                schema: {
                    openAPIV3Schema: {
                        properties: {
                            spec: { properties: Record<string, unknown> };
                        };
                    };
                };
            }[];
        };
    };
    const spec = crd.spec.versions[0].schema.openAPIV3Schema.properties.spec;
    expect(spec.properties.wakeAhead).toBeDefined();
    if (withoutWakeAhead) delete spec.properties.wakeAhead;
    return JSON.stringify(crd);
}

async function deployAgainstCrd(withoutWakeAhead: boolean) {
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
                    // Generic on purpose: it names NO field, so a field named in the output
                    // can only have come from diffing the CR against the served CRD.
                    stderr: "Error from server (BadRequest): strict decoding error",
                };
            }
            if (a.includes("--raw"))
                return { ok: false, stdout: "", stderr: "forbidden" };
            if (a.includes("get crd backendservices.apps.kn-next.dev")) {
                return {
                    ok: true,
                    stdout: backendServiceCrd(withoutWakeAhead),
                    stderr: "",
                };
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
    it("old CRD: reads the BackendService CRD, names BackendService, and names the unknown field from the diff", async () => {
        const { code, err, argvs } = await deployAgainstCrd(true);
        expect(code).toBe(1);

        // The known-field set was read from the BackendService CRD...
        const reads = argvs.map((a) => a.join(" "));
        expect(
            reads.some(
                (a) =>
                    a.includes("get crd") &&
                    a.includes("backendservices.apps.kn-next.dev"),
            ),
        ).toBe(true);
        // ...and kubectl was never asked for NextApp's CRD (this can fail; the
        // message-text check below cannot, grpc hardcodes its wording).
        expect(reads.some((a) => a.includes("nextapps.apps.kn-next.dev"))).toBe(
            false,
        );

        expect(err).toContain("PREFLIGHT FAILED");
        expect(err).toContain("BackendService CRD");
        expect(err).toContain("backendservices.apps.kn-next.dev");

        // The stubbed apiserver error is generic, so this name is proof the
        // field came from the CR-vs-served-CRD diff.
        expect(err).toContain("spec.wakeAhead");
    });

    it("current CRD: wakeAhead is known, so it is NOT reported and the outcome differs", async () => {
        const { code, err, argvs } = await deployAgainstCrd(false);
        expect(code).toBe(1);
        expect(
            argvs.some((a) =>
                a
                    .join(" ")
                    .includes("get crd backendservices.apps.kn-next.dev"),
            ),
        ).toBe(true);
        expect(err).toContain("PREFLIGHT FAILED");
        expect(err).not.toContain("spec.wakeAhead");
        expect(err).toContain("the apiserver did not name the field");
    });
});
