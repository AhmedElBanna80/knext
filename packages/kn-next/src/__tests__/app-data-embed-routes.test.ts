/**
 * Route keys are read the way Next reads them (picomatch with `contains`), the
 * excludes that apply to every route reach literal-path candidates, and the
 * ordinary-word exemption in the credential check is exact.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    deriveTraceRules,
    globalExcludes,
    planAppData,
} from "../adapters/app-data-embed.mjs";

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function app(files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "knext-routes-")));
    temps.push(root);
    for (const [rel, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), body);
    }
    return root;
}
const rels = (plan: ReturnType<typeof planAppData>) =>
    plan.files.map((f) => f.rel);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("route keys are read the way Next reads them (picomatch, contains)", () => {
    const routes = ["/", "/api/foo", "/**/*", "/blog/[slug]", "/(group)/page"];

    it("'*' as an exclude key applies to every route", () => {
        for (const route of routes) {
            const rules = deriveTraceRules(
                { [route]: ["d/**"] },
                { "*": ["d/p"] },
            );
            expect(rules[0].excludes).toEqual(["d/p"]);
        }
    });

    it("'**' and '/**' apply to every route too", () => {
        for (const key of ["**", "/**"]) {
            for (const route of routes) {
                expect(
                    deriveTraceRules(
                        { [route]: ["d/**"] },
                        { [key]: ["d/p"] },
                    )[0].excludes,
                ).toEqual(["d/p"]);
            }
        }
    });

    it("a specific key does not apply to an unrelated route", () => {
        expect(
            deriveTraceRules(
                { "/api/foo": ["d/**"] },
                { "/admin/*": ["d/p"] },
            )[0].excludes,
        ).toEqual([]);
    });

    it("brackets are a character class, as in picomatch: escaped brackets match the text, bare ones do not", () => {
        expect(
            deriveTraceRules(
                { "/blog/[slug]": ["d/**"] },
                { "/blog/\\[slug\\]": ["d/p"] },
            )[0].excludes,
        ).toEqual(["d/p"]);
        expect(
            deriveTraceRules(
                { "/blog/[slug]": ["d/**"] },
                { "/blog/[slug]": ["d/p"] },
            )[0].excludes,
        ).toEqual([]);
        expect(
            deriveTraceRules(
                { "/blog/s": ["d/**"] },
                { "/blog/[slug]": ["d/p"] },
            )[0].excludes,
        ).toEqual(["d/p"]);
    });

    it("a backslash makes the next character literal", () => {
        expect(
            deriveTraceRules({ "/x/a*b": ["d/**"] }, { "a\\*b": ["d/p"] })[0]
                .excludes,
        ).toEqual(["d/p"]);
        expect(
            deriveTraceRules({ "/x/aXb": ["d/**"] }, { "a\\*b": ["d/p"] })[0]
                .excludes,
        ).toEqual([]);
    });

    it("braces and a trailing wildcard", () => {
        expect(
            deriveTraceRules(
                { "/api/foo": ["d/**"] },
                { "/{api,admin}/*": ["d/p"] },
            )[0].excludes,
        ).toEqual(["d/p"]);
    });

    it("a key matches inside a route (picomatch contains), not only at its start", () => {
        expect(
            deriveTraceRules(
                { "/shop/api/x": ["d/**"] },
                { "api/*": ["d/p"] },
            )[0].excludes,
        ).toEqual(["d/p"]);
    });
});

describe("globalExcludes: the excludes that apply to every known route", () => {
    it("a key that matches every route is global; a route-specific one is not", () => {
        expect(
            globalExcludes(
                { "/": ["a"], "/api/foo": ["b"] },
                {
                    "*": ["g1"],
                    "/**": ["g2"],
                    "/admin/*": ["no"],
                    "/api/*": ["no-some"],
                },
            ).sort(),
        ).toEqual(["g1", "g2"]);
    });

    it("with no include keys the root route stands in", () => {
        expect(globalExcludes({}, { "*": ["g"], "/admin/*": ["no"] })).toEqual([
            "g",
        ]);
    });
});

describe("literal-path candidates honour the global excludes", () => {
    it("an excluded file, or one under an excluded directory, is not embedded and the skip names why", () => {
        const root = app({
            "data/x.json": "{}",
            "data/p/y.json": "{}",
            "data/ok.json": "{}",
        });
        const plan = planAppData({
            root,
            includes: [],
            candidateExcludes: ["data/x.json", "data/p"],
            candidates: [
                join(root, "data/x.json"),
                join(root, "data/p/y.json"),
                join(root, "data/ok.json"),
            ],
        });
        expect(rels(plan)).toEqual(["data/ok.json"]);
        expect(plan.skipped.map((s) => s.rel).sort()).toEqual([
            "data/p/y.json",
            "data/x.json",
        ]);
        for (const s of plan.skipped) {
            expect(s.reason).toBe("excluded by outputFileTracingExcludes");
        }
    });

    it("a file a rule declares is judged by that rule's excludes, not by the candidate excludes", () => {
        const root = app({ "data/x.json": "{}" });
        const plan = planAppData({
            root,
            rules: [{ includes: ["data/x.json"], excludes: [] }],
            candidateExcludes: ["data/x.json"],
            candidates: [join(root, "data/x.json")],
        });
        expect(rels(plan)).toEqual(["data/x.json"]);
        expect(plan.skipped).toEqual([]);
    });

    it("a link whose target is excluded is not embedded either", () => {
        const root = app({ "private/p.json": "{}", "data/ok.json": "{}" });
        symlinkSync("../private/p.json", join(root, "data/p.json"));
        const plan = planAppData({
            root,
            includes: [],
            candidateExcludes: ["private"],
            candidates: [join(root, "data/p.json"), join(root, "data/ok.json")],
        });
        expect(rels(plan)).toEqual(["data/ok.json"]);
        expect(plan.skipped.map((s) => s.rel)).toEqual(["data/p.json"]);
    });
});

describe("the ordinary-word exemption does not cover a name that also carries a credential word", () => {
    for (const name of [
        "tokenizerSecret.json",
        "tokenizer-token.json",
        "secretaryToken.txt",
        "tokenizer_credentials.json",
        "tokenizersPassword.txt",
    ]) {
        it(name, () => {
            const root = app({ [`conf/${name}`]: "x" });
            expect(() => planAppData({ root, includes: ["conf/*"] })).toThrow(
                new RegExp(`look like secrets[\\s\\S]*conf/${escapeRe(name)}`),
            );
        });
    }

    it("the plain words still pass", () => {
        const root = app({
            "conf/tokenizer.json": "{}",
            "conf/tokenizers.json": "{}",
            "conf/tokenization.json": "{}",
            "conf/secretary.txt": "x",
            "conf/secretaries.csv": "x",
        });
        expect(planAppData({ root, includes: ["conf/*"] }).files).toHaveLength(
            5,
        );
    });
});
