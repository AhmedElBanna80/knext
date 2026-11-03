/**
 * Route keys are matched with the picomatch Next ships (`next/dist/compiled/picomatch`,
 * `{ dot: true, contains: true }`, as collect-build-traces does), never with a matcher of
 * ours; without that module only a minimal rule is applied and anything it cannot judge
 * fails the build. Also: the excludes that apply to every route reach literal-path
 * candidates, and the ordinary-word exemption in the credential check is exact.
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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
    deriveTraceRules,
    globalExcludes,
    loadRouteMatcher,
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

// An app that has next installed (the file-manager workspace app), and one that does not.
const WITH_NEXT = resolve(import.meta.dir, "../../../../apps/file-manager");
const real = loadRouteMatcher(WITH_NEXT);
const none = loadRouteMatcher(app({}));
// What Next itself computes, straight from the module it ships.
const nextPicomatch = createRequire(join(WITH_NEXT, "package.json"))(
    "next/dist/compiled/picomatch",
) as (
    glob: string,
    opts: { dot: boolean; contains: boolean },
) => (s: string) => boolean;
const nextSays = (key: string, route: string) =>
    nextPicomatch(key, { dot: true, contains: true })(route);

describe("the matcher is Next's own picomatch when next is installed in the app", () => {
    it("is found, and answers exactly as Next's module does", () => {
        expect(real.kind).toBe("picomatch");
        const keys = [
            "*",
            "**",
            "/**",
            "/*",
            "/**/*",
            "/",
            "/api/**",
            "/api/*",
            "!/admin/*",
            "/blog/[slug]",
            "/blog/\\[slug\\]",
            "/(group)/x",
            "/{api,admin}/*",
            "api/*",
            "*/x",
        ];
        const routes = [
            "/.well-known/x",
            "/.hidden",
            "/",
            "/api",
            "/api/foo",
            "/admin/x",
            "/blog/[slug]",
            "/(group)/x",
            "/{api,admin}/*",
            "/shop/api/x",
        ];
        for (const key of keys) {
            for (const route of routes) {
                expect(real.matches(key, route) || key === route).toBe(
                    nextSays(key, route) || key === route,
                );
            }
        }
    });

    it("`/api/**` matches `/api`, `!` negates, `/*` does not match the root (all as Next's module says)", () => {
        expect(real.matches("/api/**", "/api")).toBe(true);
        expect(real.matches("!/admin/*", "/")).toBe(true);
        expect(real.matches("!/admin/*", "/admin/x")).toBe(false);
        expect(real.matches("/*", "/")).toBe(false);
        expect(real.matches("/*", "/api/foo")).toBe(true);
    });

    it("is not taken from a copy outside an installed node_modules, and absent next means the minimal rule", () => {
        expect(none.kind).toBe("minimal");
        expect(none.why).toMatch(/`next` is not installed in this app/);
    });

    it("an installed next whose picomatch has moved is reported as that, not as 'not installed'", () => {
        const root = app({
            "node_modules/next/package.json":
                '{"name":"next","version":"99.0.0"}',
        });
        const moved = loadRouteMatcher(root);
        expect(moved.kind).toBe("minimal");
        expect(moved.why).toMatch(
            /next\/dist\/compiled\/picomatch.*could not be loaded/,
        );
        expect(moved.why).not.toMatch(/not installed/);
        expect(() =>
            deriveTraceRules({ "/": ["d/**"] }, { "/admin/*": ["d/p"] }, moved),
        ).toThrow(/could not be loaded/);
        expect(() =>
            deriveTraceRules({ "/": ["d/**"] }, { "/admin/*": ["d/p"] }, none),
        ).toThrow(/`next` is not installed in this app/);
    });
});

describe("a key's own include globs are always kept", () => {
    const keys = [
        "/blog/[slug]",
        "/blog/\\[slug\\]",
        "/(group)/x",
        "/{api,admin}/*",
        "/**/*",
        "/",
    ];
    for (const matcher of [real, none]) {
        for (const key of keys) {
            it(`${matcher.kind}: ${key}`, () => {
                const rules = deriveTraceRules(
                    { [key]: ["d/**"] },
                    {},
                    matcher,
                );
                expect(rules.flatMap((r) => r.includes)).toContain("d/**");
            });
        }
    }

    it("another include key that covers this route contributes its globs to it, so an exclude aimed at that other key does not take them away here", () => {
        const rules = deriveTraceRules(
            { "/api/x": ["a/**"], "/api/*": ["b/**"] },
            { "/api/\\*": ["b/**"] },
            real,
        );
        const forX = rules.find((r) => r.includes.includes("a/**"));
        expect(forX?.includes.sort()).toEqual(["a/**", "b/**"]);
        expect(forX?.excludes).toEqual([]);
        const forStar = rules.find((r) => !r.includes.includes("a/**"));
        expect(forStar).toEqual({ includes: ["b/**"], excludes: ["b/**"] });
    });

    it("an exclude key equal to the route text counts, whatever picomatch makes of it", () => {
        const rules = deriveTraceRules(
            { "/blog/[slug]": ["d/**"] },
            { "/blog/[slug]": ["d/p"] },
            real,
        );
        expect(rules[0].excludes).toEqual(["d/p"]);
    });
});

describe("excludes follow Next's matching of route keys", () => {
    const routes = ["/", "/api/foo", "/blog/[slug]", "/(group)/page"];

    it("'*' and '**' apply to every route", () => {
        for (const key of ["*", "**"]) {
            for (const route of routes) {
                expect(
                    deriveTraceRules(
                        { [route]: ["d/**"] },
                        { [key]: ["d/p"] },
                        real,
                    )[0].excludes,
                ).toEqual(["d/p"]);
            }
        }
    });

    it("`/**/*` and `/*` do not match the root route (Next's picomatch says so), but do match deeper ones", () => {
        for (const key of ["/**/*", "/*"]) {
            expect(
                deriveTraceRules({ "/": ["d/**"] }, { [key]: ["d/p"] }, real)[0]
                    .excludes,
            ).toEqual([]);
            expect(
                deriveTraceRules(
                    { "/api/foo": ["d/**"] },
                    { [key]: ["d/p"] },
                    real,
                )[0].excludes,
            ).toEqual(["d/p"]);
        }
    });

    it("`!` negation: applies to routes that do NOT match the rest", () => {
        const inc = { "/": ["d/**"], "/admin/x": ["e/**"] };
        const rules = deriveTraceRules(inc, { "!/admin/*": ["d/p"] }, real);
        const forRoot = rules.find((r) => r.includes.includes("d/**"));
        const forAdmin = rules.find((r) => r.includes.includes("e/**"));
        expect(forRoot?.excludes).toEqual(["d/p"]);
        expect(forAdmin?.excludes).toEqual([]);
    });

    it("`/api/**` reaches `/api`", () => {
        expect(
            deriveTraceRules(
                { "/api": ["d/**"] },
                { "/api/**": ["d/p"] },
                real,
            )[0].excludes,
        ).toEqual(["d/p"]);
    });

    it("braces, groups and brackets are picomatch's", () => {
        expect(
            deriveTraceRules(
                { "/api/foo": ["d/**"] },
                { "/{api,admin}/*": ["d/p"] },
                real,
            )[0].excludes,
        ).toEqual(["d/p"]);
        expect(
            deriveTraceRules(
                { "/blog/[slug]": ["d/**"] },
                { "/blog/\\[slug\\]": ["d/p"] },
                real,
            )[0].excludes,
        ).toEqual(["d/p"]);
    });

    it("a key that matches no include key's route does not apply", () => {
        expect(
            deriveTraceRules(
                { "/api/foo": ["d/**"] },
                { "/admin/*": ["d/p"] },
                real,
            )[0].excludes,
        ).toEqual([]);
    });
});

describe("without next's picomatch: a minimal rule, and a loud failure for anything else", () => {
    it("exclude keys equal to an include key, or matching every route, are applied", () => {
        for (const key of ["*", "**", "/**", "**/*", "/admin"]) {
            const rules = deriveTraceRules(
                { "/admin": ["d/**"], "/": ["e/**"] },
                { [key]: ["d/p"] },
                none,
            );
            expect(
                rules.find((r) => r.includes.includes("d/**"))?.excludes,
            ).toEqual(["d/p"]);
        }
        // an exact key applies to its own route only
        const exact = deriveTraceRules(
            { "/admin": ["d/**"], "/": ["e/**"] },
            { "/admin": ["d/p"] },
            none,
        );
        expect(
            exact.find((r) => r.includes.includes("e/**"))?.excludes,
        ).toEqual([]);
    });

    it("any other exclude key fails, naming it and the fix", () => {
        expect(() =>
            deriveTraceRules({ "/": ["d/**"] }, { "/admin/*": ["d/p"] }, none),
        ).toThrow(
            /outputFileTracingExcludes\['\/admin\/\*'\][\s\S]*[Ii]nstall next/,
        );
    });

    it("includes alone need no matcher: every key's globs are kept", () => {
        const rules = deriveTraceRules(
            { "/a/[id]": ["x/**"], "/(g)/b": ["y/**"] },
            {},
            none,
        );
        expect(rules.flatMap((r) => r.includes).sort()).toEqual([
            "x/**",
            "y/**",
        ]);
    });
});

describe("globalExcludes: the excludes that apply to every known route", () => {
    it("a key that matches every route is global; a route-specific one is not", () => {
        expect(
            globalExcludes(
                { "/": ["a"], "/api/foo": ["b"] },
                {
                    "*": ["g1"],
                    "**": ["g2"],
                    "/admin/*": ["no"],
                    "/api/*": ["no-some"],
                },
                real,
            ).sort(),
        ).toEqual(["g1", "g2"]);
    });

    it("with no include keys the root route stands in", () => {
        expect(
            globalExcludes({}, { "*": ["g"], "/admin/*": ["no"] }, real),
        ).toEqual(["g"]);
    });

    it("without next only the all-routes keys can be global", () => {
        expect(globalExcludes({ "/": ["a"] }, { "**": ["g"] }, none)).toEqual([
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
