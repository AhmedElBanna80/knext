/**
 * knext's full adapter records the resolved config facts (#2250), the same way
 * the facts-only adapter does, so an app wired through `adapterPath` gets the
 * same resolved-config refusals. The recorded `output` is the one this adapter
 * hands back to Next, after its own standalone default.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FACTS_OUT_ENV } from "../adapters/next-config-facts.js";
import adapter from "../adapters/next-adapter";

type ModifyConfig = NonNullable<typeof adapter.modifyConfig>;
const modifyConfig = adapter.modifyConfig as ModifyConfig;

let dir: string;
let out: string;
beforeEach(() => {
    spyOn(console, "log").mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), "knext-adapter-facts-"));
    out = join(dir, "facts.json");
    process.env[CONFIG_FACTS_OUT_ENV] = out;
});
afterEach(() => {
    delete process.env[CONFIG_FACTS_OUT_ENV];
    rmSync(dir, { recursive: true, force: true });
});

const build = (
    config: Record<string, unknown>,
    phase = "phase-production-build",
) =>
    modifyConfig(
        {
            experimental: {},
            ...config,
        } as unknown as Parameters<ModifyConfig>[0],
        { phase } as Parameters<ModifyConfig>[1],
    );

describe("the full knext adapter records the resolved config facts", () => {
    it("records the output after its own standalone default", () => {
        build({ distDir: ".next" });
        expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
            distDir: ".next",
            output: "standalone",
            turbopackModuleFragments: false,
        });
    });

    it("records an explicit static export unchanged (Next validates it first)", () => {
        build({ distDir: ".next", output: "export" });
        expect(JSON.parse(readFileSync(out, "utf8")).output).toBe("export");
    });

    it("refuses a custom distDir from the resolved value", () => {
        expect(() => build({ distDir: "build" })).toThrow(
            /^\[knext-refuse:custom-dist-dir\] /,
        );
    });

    it("records nothing in a dev server, even when the CLI's path is set", () => {
        build({ distDir: "build" }, "phase-development-server");
        expect(existsSync(out)).toBe(false);
    });
});
