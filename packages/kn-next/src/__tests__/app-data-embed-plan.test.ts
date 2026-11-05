/**
 * planAppData: declared directories and globs agree and fail closed; excludes
 * follow outputFileTracingExcludes; route keys pick which excludes apply.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
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
import { planAppData } from "../adapters/app-data-embed.mjs";

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function app(files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "knext-plan-")));
    temps.push(root);
    for (const [rel, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), body);
    }
    return root;
}
const rels = (plan: ReturnType<typeof planAppData>) =>
    plan.files.map((f) => f.rel);
const names = (plan: ReturnType<typeof planAppData>) =>
    plan.files.flatMap((f) => [f.rel, ...f.aliases]).sort();

describe("a declared directory and a glob over it agree", () => {
    it("a symlinked directory inside the root: both embed the files behind it", () => {
        const root = app({ "data/a.json": "{}", "shared/x.json": "{}" });
        symlinkSync("../shared", join(root, "data/sub"));
        const viaDir = planAppData({ root, includes: ["data"] });
        const viaGlob = planAppData({ root, includes: ["data/**"] });
        expect(rels(viaDir)).toEqual(["data/a.json", "shared/x.json"]);
        expect(names(viaDir)).toEqual([
            "data/a.json",
            "data/sub/x.json",
            "shared/x.json",
        ]);
        expect(names(viaGlob)).toEqual(expect.arrayContaining(names(viaDir)));
        expect(rels(viaGlob)).toEqual(rels(viaDir));
    });

    it("a symlinked directory that leaves the root fails the same way both ways", () => {
        const outside = app({ "o.json": "{}" });
        const root = app({ "data/a.json": "{}" });
        symlinkSync(outside, join(root, "data/out"));
        expect(() => planAppData({ root, includes: ["data"] })).toThrow(
            /outside the app root/,
        );
        expect(() => planAppData({ root, includes: ["data/**"] })).toThrow(
            /outside the app root/,
        );
    });

    it("a dangling link fails the build, whether the pattern is a directory or a glob", () => {
        const root = app({ "data/a.json": "{}" });
        symlinkSync("../nope", join(root, "data/gone.json"));
        for (const pattern of ["data", "data/**", "data/*", "data/*.json"]) {
            expect(() => planAppData({ root, includes: [pattern] })).toThrow(
                /dangling[\s\S]*data\/gone\.json/,
            );
        }
    });

    it("a directory holding only a dangling link is an error, not an empty plan", () => {
        const root = app({});
        mkdirSync(join(root, "data"));
        symlinkSync("../nope", join(root, "data/gone.json"));
        expect(() => planAppData({ root, includes: ["data"] })).toThrow(
            /dangling[\s\S]*data\/gone\.json/,
        );
    });

    it("a pattern that names a dangling link exactly fails too", () => {
        const root = app({ "data/a.json": "{}" });
        symlinkSync("../nope", join(root, "data/gone.json"));
        expect(() =>
            planAppData({ root, includes: ["data/gone.json"] }),
        ).toThrow(/dangling[\s\S]*data\/gone\.json/);
    });

    it("a dangling link inside an excluded directory is not an error", () => {
        const root = app({ "data/a.json": "{}", "data/tmp/x": "1" });
        symlinkSync("../nope", join(root, "data/tmp/gone.json"));
        const plan = planAppData({
            root,
            rules: [{ includes: ["data/**"], excludes: ["data/tmp"] }],
        });
        expect(rels(plan)).toEqual(["data/a.json"]);
    });

    it("a dangling link the pattern does not reach is ignored", () => {
        const root = app({ "data/a.json": "{}", "other/x": "1" });
        symlinkSync("../nope", join(root, "other/gone.json"));
        expect(rels(planAppData({ root, includes: ["data/**"] }))).toEqual([
            "data/a.json",
        ]);
    });

    it("a glob selects only what it matches, not everything under its literal prefix", () => {
        const root = app({
            "data/a.json": "{}",
            "data/b.txt": "t",
            "data/sub/c.json": "{}",
        });
        expect(rels(planAppData({ root, includes: ["data/*.json"] }))).toEqual([
            "data/a.json",
        ]);
        expect(
            rels(planAppData({ root, includes: ["data/**/*.json"] })),
        ).toEqual(["data/a.json", "data/sub/c.json"]);
    });

    it("a link loop terminates", () => {
        const root = app({ "data/a.json": "{}" });
        symlinkSync("..", join(root, "data/loop"));
        const plan = planAppData({ root, includes: ["data"] });
        expect(rels(plan)).toContain("data/a.json");
    });

    it("a file that is not a regular file fails instead of vanishing", () => {
        // a directory symlink resolving to a socket-like special is platform specific;
        // a FIFO is portable on POSIX
        const root = app({ "data/a.json": "{}" });
        const made = spawnSync("mkfifo", [join(root, "data/pipe")]);
        expect(made.status).toBe(0);
        expect(() => planAppData({ root, includes: ["data"] })).toThrow(
            /not a regular file[\s\S]*data\/pipe/,
        );
    });
});

describe("outputFileTracingExcludes", () => {
    const root = () =>
        app({
            "data/a.json": "{}",
            "data/private/b.json": "{}",
            "data/private/deep/c.json": "{}",
            "data/.env": "S=1",
        });

    it("an exclude removes its matches from the include's files", () => {
        const plan = planAppData({
            root: root(),
            rules: [
                {
                    includes: ["data/**"],
                    excludes: ["data/private/**", "data/.env"],
                },
            ],
        });
        expect(rels(plan)).toEqual(["data/a.json"]);
    });

    it("a bare directory exclude covers everything under it, as Next's contains-match does", () => {
        const plan = planAppData({
            root: root(),
            rules: [
                {
                    includes: ["data/**"],
                    excludes: ["./data/private", "data/.env"],
                },
            ],
        });
        expect(rels(plan)).toEqual(["data/a.json"]);
    });

    it("an excluded credential does not fail the build (it is not traced)", () => {
        const plan = planAppData({
            root: root(),
            rules: [
                {
                    includes: ["data/**"],
                    excludes: ["data/private/**", "data/.env"],
                },
            ],
        });
        expect(rels(plan)).not.toContain("data/.env");
    });

    it("without the exclude the same includes embed the private files", () => {
        const plan = planAppData({
            root: app({ "data/a.json": "{}", "data/private/b.json": "{}" }),
            includes: ["data/**"],
        });
        expect(rels(plan)).toEqual(["data/a.json", "data/private/b.json"]);
    });

    it("an exclude of one rule does not remove what another rule includes", () => {
        const two = planAppData({
            root: app({ "data/a.json": "{}", "other/o.json": "{}" }),
            rules: [
                { includes: ["data/a.json"], excludes: [] },
                { includes: ["other/**"], excludes: ["data/**"] },
            ],
        });
        expect(rels(two)).toEqual(["data/a.json", "other/o.json"]);
    });

    it("an excluded directory is not judged: a link in it that leaves the app root is not an error", () => {
        const outside = app({ "o.json": "{}" });
        const r = app({ "data/a.json": "{}", "data/tmp/x": "1" });
        symlinkSync(outside, join(r, "data/tmp/out"));
        const plan = planAppData({
            root: r,
            rules: [{ includes: ["data/**"], excludes: ["data/tmp"] }],
        });
        expect(rels(plan)).toEqual(["data/a.json"]);
        expect(() => planAppData({ root: r, includes: ["data/**"] })).toThrow(
            /outside the app root/,
        );
    });

    it("an exclude that matches through a link's target removes the link's file too", () => {
        const r = app({ "data/a.json": "{}", "private/p.json": "{}" });
        symlinkSync("../private/p.json", join(r, "data/p.json"));
        const plan = planAppData({
            root: r,
            rules: [{ includes: ["data/**"], excludes: ["private/**"] }],
        });
        expect(rels(plan)).toEqual(["data/a.json"]);
    });
});
