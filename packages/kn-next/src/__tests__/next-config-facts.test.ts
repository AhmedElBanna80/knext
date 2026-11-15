/**
 * The resolved next.config facts (#2250): what knext's adapters record from
 * the config Next actually resolved, and the refusals decided from it. Real
 * module, temp files, no mocks.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    CONFIG_FACTS_OUT_ENV,
    isDefaultDistDir,
    KNEXT_BUILDER_ENV,
    readNextConfigFacts,
    recordNextConfigFacts,
    refusalFor,
} from "../adapters/next-config-facts.js";
import { KNEXT_RUNTIME_ENV } from "../adapters/runtime-env";

const BUILD = "phase-production-build";

let dir: string;
let out: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-facts-"));
    out = join(dir, "facts.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = (extra: Record<string, string> = {}) => ({
    [CONFIG_FACTS_OUT_ENV]: out,
    ...extra,
});

describe("isDefaultDistDir", () => {
    it.each([".next", "./.next", ".next/", "./.next//"])("accepts %s", (d) => {
        expect(isDefaultDistDir(d)).toBe(true);
    });
    it.each([
        "build",
        ".next/sub",
        "../.next",
        "",
        "next",
    ])("rejects %s", (d) => {
        expect(isDefaultDistDir(d)).toBe(false);
    });
});

describe("refusalFor", () => {
    const facts = (over = {}) => ({
        distDir: ".next",
        output: "standalone",
        turbopackModuleFragments: false,
        ...over,
    });
    it("refuses a custom distDir, naming it", () => {
        const r = refusalFor(facts({ distDir: "build" }), {
            runtime: "node",
            builder: "webpack",
        });
        expect(r?.code).toBe("custom-dist-dir");
        expect(r?.message).toContain("distDir: 'build'");
    });
    it("refuses turbopackModuleFragments only on bun + turbopack", () => {
        const on = facts({ turbopackModuleFragments: true });
        expect(
            refusalFor(on, { runtime: "bun", builder: "turbopack" })?.code,
        ).toBe("bun-turbopack-fragments");
        for (const [runtime, builder] of [
            ["node", "turbopack"],
            ["bun", "webpack"],
            ["bun", undefined],
        ] as const) {
            expect(refusalFor(on, { runtime, builder })).toBeUndefined();
        }
    });
    it("does not refuse a static export (Next validates it first; the CLI refuses after)", () => {
        expect(
            refusalFor(facts({ output: "export" }), {
                runtime: "node",
                builder: "webpack",
            }),
        ).toBeUndefined();
    });
});

describe("recordNextConfigFacts", () => {
    const config = (over: Record<string, unknown> = {}) => ({
        distDir: ".next",
        output: "standalone",
        experimental: {},
        ...over,
    });

    it("does nothing without the CLI's facts path (plain next build, typegen, dev)", () => {
        expect(
            recordNextConfigFacts(
                config({ distDir: "build" }),
                { phase: BUILD },
                {},
            ),
        ).toBeUndefined();
        expect(existsSync(out)).toBe(false);
    });

    it("does nothing outside the production build, even with the facts path", () => {
        for (const phase of [
            "phase-development-server",
            "phase-production-server",
            "phase-export",
        ]) {
            expect(
                recordNextConfigFacts(
                    config({ distDir: "build" }),
                    { phase },
                    env(),
                ),
            ).toBeUndefined();
        }
        expect(existsSync(out)).toBe(false);
    });

    it("records the resolved facts as JSON at the CLI's path", () => {
        recordNextConfigFacts(
            config({
                output: "export",
                experimental: { turbopackModuleFragments: true },
            }),
            { phase: BUILD },
            env(),
        );
        expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
            distDir: ".next",
            output: "export",
            turbopackModuleFragments: true,
        });
    });

    it("records, then throws a marked refusal, and the file names the refusal", () => {
        expect(() =>
            recordNextConfigFacts(
                config({ distDir: "build" }),
                { phase: BUILD },
                env(),
            ),
        ).toThrow(/^\[knext-refuse:custom-dist-dir\] /);
        expect(JSON.parse(readFileSync(out, "utf8")).refused).toBe(
            "custom-dist-dir",
        );
    });

    it("reads runtime and builder from the env the CLI sets", () => {
        const on = config({ experimental: { turbopackModuleFragments: true } });
        expect(() =>
            recordNextConfigFacts(
                on,
                { phase: BUILD },
                env({
                    [KNEXT_RUNTIME_ENV]: "bun",
                    [KNEXT_BUILDER_ENV]: "turbopack",
                }),
            ),
        ).toThrow(/bun-turbopack-fragments/);
        expect(() =>
            recordNextConfigFacts(
                on,
                { phase: BUILD },
                env({
                    [KNEXT_RUNTIME_ENV]: "bun",
                    [KNEXT_BUILDER_ENV]: "webpack",
                }),
            ),
        ).not.toThrow();
    });

    it("names an unwritable facts path instead of a bare errno", () => {
        expect(() =>
            recordNextConfigFacts(
                config(),
                { phase: BUILD },
                {
                    [CONFIG_FACTS_OUT_ENV]: join(
                        dir,
                        "missing-dir",
                        "facts.json",
                    ),
                },
            ),
        ).toThrow(/could not record the resolved Next\.js config/);
    });

    it("leaves no temp file behind (written tmp-then-rename)", () => {
        recordNextConfigFacts(config(), { phase: BUILD }, env());
        recordNextConfigFacts(config(), { phase: BUILD }, env());
        const { readdirSync } = require("node:fs") as typeof import("node:fs");
        expect(readdirSync(dir)).toEqual(["facts.json"]);
    });
});

describe("recordNextConfigFacts records the app directory", () => {
    it("records modifyConfig's projectDir so the CLI can tell apps apart", () => {
        recordNextConfigFacts(
            { distDir: ".next", experimental: {} },
            { phase: BUILD, projectDir: "/apps/web" },
            env(),
        );
        expect(JSON.parse(readFileSync(out, "utf8")).projectDir).toBe(
            "/apps/web",
        );
    });
});

describe("readNextConfigFacts", () => {
    it("is undefined when no adapter wrote the file", () => {
        expect(readNextConfigFacts(out)).toBeUndefined();
    });
    it("reads what was recorded", () => {
        writeFileSync(
            out,
            JSON.stringify({
                distDir: ".next",
                output: "standalone",
                turbopackModuleFragments: false,
            }),
        );
        expect(readNextConfigFacts(out)?.output).toBe("standalone");
    });
    it("fails closed, naming the file, on a corrupt or wrong-shaped record", () => {
        writeFileSync(out, "{not json");
        expect(() => readNextConfigFacts(out)).toThrow(
            /resolved Next\.js config record/,
        );
        writeFileSync(out, JSON.stringify({ distDir: 7 }));
        expect(() => readNextConfigFacts(out)).toThrow(
            /resolved Next\.js config record/,
        );
    });
});
