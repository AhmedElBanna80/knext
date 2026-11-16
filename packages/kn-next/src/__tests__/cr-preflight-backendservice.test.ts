/**
 * Zone functions add two CRD surfaces: `NextApp.spec.backends[]` (the zone half
 * of a binding) and the `BackendService` kind. The CLI's schema preflight must
 * know both, in both directions:
 *  - against the CRDs this repo ships, every new field is KNOWN;
 *  - against an older CRD that lacks them, the preflight's diff names exactly
 *    the missing fields, so an operator-first upgrade is enforced before the
 *    cluster is touched;
 *  - `serviceAccountName` is NOT a BackendService field, so a strict apply
 *    rejects it and a non-strict one prunes it: a user can never choose the
 *    identity a function runs as.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
    BACKENDSERVICE_CRD_NAME,
    BACKENDSERVICE_KIND,
    crdGetArgv,
    crdSchemaFromCrdObject,
    crdSchemaFromOpenApiV3Doc,
    flattenSchemaPaths,
    unknownEmittedFields,
} from "../cli/schema/crd-schema";
import {
    formatPreflightFailure,
    type KubectlCapture,
    preflightCRSchema,
} from "../cli/schema/preflight";

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

type Node = { properties?: Record<string, Node>; items?: Node };

function loadCrd(file: string): {
    spec: { versions: { schema: { openAPIV3Schema: Node } }[] };
} {
    return YAML.parse(readFileSync(join(BASES, file), "utf-8"));
}

function known(crd: unknown): ReadonlySet<string> {
    const schema = crdSchemaFromCrdObject(crd);
    if (!schema) throw new Error("no v1alpha1 schema in the bundled CRD");
    return flattenSchemaPaths(schema);
}

const NEXTAPP_FIELDS = [
    "spec.backends",
    "spec.backends.*.name",
    "spec.backends.*.service",
];

const BACKENDSERVICE_FIELDS = [
    "spec.zone",
    "spec.image",
    "spec.language",
    "spec.port",
    "spec.protoVersion",
    "spec.wakeAhead",
    "spec.scaling.minScale",
    "spec.scaling.maxScale",
    "spec.scaling.containerConcurrency",
    "spec.resources.cpuLimit",
    "spec.env.*.name",
    "spec.env.*.valueFrom.secretKeyRef.name",
    "spec.envFrom.*.secretRef.name",
    "spec.volumes.*.name",
    "spec.volumes.*.mountPath",
    "spec.volumes.*.secret.secretName",
    "spec.volumes.*.projected.sources.*.secret.name",
    "spec.volumes.*.projected.sources.*.configMap.name",
    "spec.imagePullSecrets.*.name",
    "status.servedProtoVersion",
];

describe("CLI schema preflight knows the zone-function CRD fields", () => {
    it("the bundled NextApp CRD defines spec.backends[]", () => {
        const set = known(loadCrd("apps.kn-next.dev_nextapps.yaml"));
        expect(unknownEmittedFields(NEXTAPP_FIELDS, set)).toEqual([]);
    });

    it("an older NextApp CRD without spec.backends is diagnosed by name", () => {
        const crd = loadCrd("apps.kn-next.dev_nextapps.yaml");
        const spec =
            crd.spec.versions[0]?.schema.openAPIV3Schema.properties?.spec;
        if (!spec?.properties?.backends)
            throw new Error("bundled CRD has no spec.backends");
        delete spec.properties.backends;
        expect(unknownEmittedFields(NEXTAPP_FIELDS, known(crd))).toEqual([
            "spec.backends",
        ]);
    });

    it("the bundled BackendService CRD defines every field the CLI will emit", () => {
        const set = known(loadCrd("apps.kn-next.dev_backendservices.yaml"));
        expect(unknownEmittedFields(BACKENDSERVICE_FIELDS, set)).toEqual([]);
    });

    it("an older BackendService CRD without spec.zone is diagnosed by name", () => {
        const crd = loadCrd("apps.kn-next.dev_backendservices.yaml");
        const spec =
            crd.spec.versions[0]?.schema.openAPIV3Schema.properties?.spec;
        if (!spec?.properties?.zone)
            throw new Error("bundled CRD has no spec.zone");
        delete spec.properties.zone;
        expect(unknownEmittedFields(BACKENDSERVICE_FIELDS, known(crd))).toEqual(
            ["spec.zone"],
        );
    });

    it("serviceAccountName is not a BackendService field (a function never runs as a user-chosen identity)", () => {
        const set = known(loadCrd("apps.kn-next.dev_backendservices.yaml"));
        expect(
            unknownEmittedFields(
                ["spec.serviceAccountName", "spec.template"],
                set,
            ),
        ).toEqual(["spec.serviceAccountName", "spec.template"]);
    });

    it("reads the BackendService schema by kind and by CRD name", () => {
        expect(crdGetArgv(BACKENDSERVICE_CRD_NAME)).toEqual([
            "kubectl",
            "get",
            "crd",
            "backendservices.apps.kn-next.dev",
            "-o",
            "json",
        ]);
        const crd = loadCrd("apps.kn-next.dev_backendservices.yaml");
        const schema = crdSchemaFromCrdObject(crd);
        const doc = {
            components: {
                schemas: {
                    "dev.kn-next.apps.v1alpha1.BackendServiceList": {},
                    "dev.kn-next.apps.v1alpha1.BackendService": schema,
                    "dev.kn-next.apps.v1alpha1.NextApp": {},
                },
            },
        };
        const found = crdSchemaFromOpenApiV3Doc(doc, BACKENDSERVICE_KIND);
        expect(found?.schema).toBe(schema);
    });
});

// Schemas for the scripted schema reads below: an older BackendService CRD
// (no scaling) and a NextApp that knows none of its fields.
const objSchema = (properties: Record<string, unknown>) => ({
    type: "object",
    properties,
});
const OLD_BACKENDSERVICE = objSchema({
    apiVersion: { type: "string" },
    kind: { type: "string" },
    metadata: { type: "object" },
    spec: objSchema({
        zone: { type: "string" },
        image: { type: "string" },
        language: { type: "string" },
        port: { type: "integer" },
    }),
});
const NEXTAPP = objSchema({
    apiVersion: { type: "string" },
    kind: { type: "string" },
    metadata: { type: "object" },
    spec: objSchema({ image: { type: "string" }, zone: { type: "string" } }),
});

// #2481 — every user-facing preflight message names the kind actually being
// preflighted. A BackendService failure must never tell the user about NextApp.
describe("#2481 — preflight failure messages name the kind being preflighted", () => {
    const BS_CR = {
        apiVersion: "apps.kn-next.dev/v1alpha1",
        kind: "BackendService",
        metadata: { name: "fn", namespace: "z" },
        spec: {
            zone: "z",
            image: `r/fn@sha256:${"a".repeat(64)}`,
            language: "go",
            port: 8080,
            scaling: { minScale: 0, maxScale: 3 },
        },
    };
    const NA_CR = {
        apiVersion: "apps.kn-next.dev/v1alpha1",
        kind: "NextApp",
        metadata: { name: "web", namespace: "z" },
        spec: { image: `r/web@sha256:${"b".repeat(64)}`, zone: "z" },
    };

    function withCR<T>(cr: unknown, fn: (crPath: string) => T): T {
        const dir = mkdtempSync(join(tmpdir(), "knext-2481-preflight-"));
        try {
            const crPath = join(dir, "cr.json");
            writeFileSync(crPath, JSON.stringify(cr));
            return fn(crPath);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    // Runs preflightCRSchema against a CR written to a temp file, with the
    // apply's stderr and the schema reads scripted by the caller.
    function outcomeFor(
        cr: unknown,
        apply: { ok: boolean; stderr: string },
        schemaReads: { openapi: boolean } = { openapi: false },
    ) {
        const kubectl: KubectlCapture = (argv) => {
            if (argv[1] === "apply")
                return { ok: apply.ok, stdout: "", stderr: apply.stderr };
            if (argv[2] === "--raw")
                return schemaReads.openapi
                    ? {
                          ok: true,
                          stdout: JSON.stringify({
                              components: {
                                  schemas: {
                                      "dev.kn-next.apps.v1alpha1.NextApp":
                                          NEXTAPP,
                                      "dev.kn-next.apps.v1alpha1.BackendService":
                                          OLD_BACKENDSERVICE,
                                  },
                              },
                          }),
                          stderr: "",
                      }
                    : { ok: false, stdout: "", stderr: "forbidden" };
            if (argv[1] === "get" && argv[2] === "crd")
                return { ok: false, stdout: "", stderr: "forbidden" };
            return { ok: false, stdout: "", stderr: "unexpected" };
        };
        return withCR(cr, (crPath) =>
            preflightCRSchema({ kubectl }, { crPath, namespace: "z" }),
        );
    }

    const SKEW_STDERR =
        'Error from server: strict decoding error: unknown field "spec.scaling", unknown field "spec.wakeAhead"';
    const WEBHOOK_STDERR =
        'Internal error occurred: failed calling webhook "vnextapp.kn-next.dev": Post "https://x": no endpoints available';
    const GENERIC_STDERR = "error: forbidden: cannot patch backendservices";

    it("a blocked BackendService (webhook down) names BackendService, never NextApp", () => {
        const out = outcomeFor(BS_CR, { ok: false, stderr: WEBHOOK_STDERR });
        expect(out.reason).toBe("webhook-unavailable");
        const msg = formatPreflightFailure(out);
        expect(msg).toContain("BackendService");
        expect(msg).not.toContain("NextApp");
    });

    it("a skewed BackendService names BackendService and its own CRD in the hint, never NextApp", () => {
        const out = outcomeFor(
            BS_CR,
            { ok: false, stderr: SKEW_STDERR },
            { openapi: true },
        );
        expect(out.verdict).toBe("skew");
        const msg = formatPreflightFailure(out);
        expect(msg).toContain("BackendService");
        expect(msg).toContain("spec.scaling");
        expect(msg).toContain("backendservices.apps.kn-next.dev");
        expect(msg).not.toContain("NextApp");
        expect(msg).not.toContain("nextapps");
    });

    it("a BackendService whose dry run did not complete names BackendService, never NextApp", () => {
        const out = outcomeFor(BS_CR, { ok: false, stderr: GENERIC_STDERR });
        expect(out.reason).toBe("apply-failed");
        const msg = formatPreflightFailure(out);
        expect(msg).toContain("BackendService");
        expect(msg).not.toContain("NextApp");
        expect(msg).not.toContain("nextapps");
    });

    it("the NextApp path still names NextApp in every failure message", () => {
        const webhook = formatPreflightFailure(
            outcomeFor(NA_CR, { ok: false, stderr: WEBHOOK_STDERR }),
        );
        expect(webhook).toContain("NextApp");
        const generic = formatPreflightFailure(
            outcomeFor(NA_CR, { ok: false, stderr: GENERIC_STDERR }),
        );
        expect(generic).toContain("NextApp");
        const skew = formatPreflightFailure(
            outcomeFor(NA_CR, { ok: false, stderr: SKEW_STDERR }),
        );
        expect(skew).toContain("NextApp");
        expect(skew).toContain("nextapps.apps.kn-next.dev");
    });

    it("scan: no hard-coded NextApp or nextapps literal in the preflight message paths", () => {
        const src = readFileSync(
            join(HERE, "..", "cli", "schema", "preflight.ts"),
            "utf-8",
        );
        const start = src.indexOf("export function preflightCRSchema(");
        const end = src.indexOf("export function assertCRSchemaCompatible(");
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        // Comments are not user-facing; only code and string literals are scanned.
        const code = src
            .slice(start, end)
            .split("\n")
            .filter((line) => {
                const t = line.trim();
                return !(
                    t.startsWith("*") ||
                    t.startsWith("/*") ||
                    t.startsWith("//")
                );
            })
            .join("\n");
        expect(code).not.toMatch(/NextApp/);
        expect(code).not.toMatch(/nextapps/);
    });
});
