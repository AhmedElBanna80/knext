/**
 * A vinext app that follows `knext ffi init`'s advice stays on the known-good path.
 *
 * In-process Rust (ADR-0069 Amendment 1) tells a vinext app to add ONE line to the `Dockerfile` it
 * was scaffolded with, so `/app` and `/app/native` are closed to group and other on any builder.
 * `isKnownGoodTemplateDockerfile` is a byte-exact comparison of that Dockerfile against the shipped
 * template; a Dockerfile it does not recognise switches `deploy` to image-sourced assets and a
 * `docker create` / `docker cp --platform linux/amd64` lock-step check (`deploy.ts`), a different and
 * slower path that an arm64-only image may not survive. So the template plus exactly that line, right
 * after the `native/` COPY, has to be recognised too, and nothing near it may be.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    DEFAULT_BUILD,
    dockerfileHint,
    VINEXT_CLOSE_LINE,
} from "../../../ffi/src/init";
import { BUILDERS, DEFAULT_BUILDER_ID } from "../adapters/artifact-contract";
import { packageRoot } from "../cli/create";
import {
    isKnownGoodTemplateDockerfile,
    VINEXT_FFI_CLOSE_LINE,
    vinextTemplateWithCloseLine,
} from "../cli/runtime-image";

const dirs: string[] = [];
function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-vinext-known-good-"));
    dirs.push(dir);
    return dir;
}
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const templateDir = join(packageRoot(), "templates", "app");
const template = () =>
    readFileSync(join(templateDir, "Dockerfile.hbs"), "utf8");
const NATIVE_COPY = "COPY --chown=0:0 --chmod=a-w native /app/native\n";
const LINE = "RUN chmod go-w /app /app/native";

/** Whether core recognises `text` as the known-good vinext Dockerfile. */
function known(text: string): boolean {
    const dockerfile = join(tmp(), "Dockerfile");
    writeFileSync(dockerfile, text);
    return isKnownGoodTemplateDockerfile(dockerfile);
}

/** `text` with `insert` put right after the template's native/ COPY line. */
function afterCopy(insert: string, text = template()): string {
    expect(text.split(NATIVE_COPY).length - 1).toBe(1);
    return text.replace(NATIVE_COPY, () => `${NATIVE_COPY}${insert}`);
}

describe("the scaffolded vinext Dockerfile plus the one line knext ffi init adds is known-good", () => {
    it("the line core recognises is exactly the line the hint prints", () => {
        expect(VINEXT_FFI_CLOSE_LINE).toBe(LINE);
        expect(VINEXT_CLOSE_LINE).toBe(VINEXT_FFI_CLOSE_LINE);
    });

    it("the build the hint assumes when a config names none is core's default, and the one build it speaks to is a builder core has", () => {
        // Core owns both: the ffi package keeps its own copy of the default and of the builder name
        // (it cannot import core), so this is where a change in core is noticed.
        expect(DEFAULT_BUILD).toBe(DEFAULT_BUILDER_ID);
        expect(BUILDERS.map((b) => b.id)).toContain("vinext");
        const cwd = tmp();
        writeFileSync(join(cwd, "Dockerfile"), template());
        expect(dockerfileHint(cwd, "vinext")).toContain(LINE);
        for (const b of BUILDERS.filter((b) => b.id !== "vinext")) {
            expect(dockerfileHint(cwd, b.id), b.id).toBe("");
        }
    });

    it("the template with the line directly after its native/ COPY is known-good: following the hint does not take the app off the host-built path", () => {
        expect(known(afterCopy(`${LINE}\n`))).toBe(true);
    });

    it("the unmodified template stays known-good, and does not already carry the line (that is why the hint is needed)", () => {
        expect(known(template())).toBe(true);
        expect(template()).not.toContain(LINE);
    });

    it("what the hint prints, applied the way it says, is what core recognises, and silences the hint", () => {
        const cwd = tmp();
        writeFileSync(join(cwd, "Dockerfile"), template());
        const printed = dockerfileHint(cwd);
        const line = /^ {2}(RUN chmod .*)$/m.exec(printed)?.[1];
        expect(line).toBe(VINEXT_FFI_CLOSE_LINE);
        const followed = afterCopy(`${line}\n`);
        expect(known(followed)).toBe(true);
        const after = tmp();
        writeFileSync(join(after, "Dockerfile"), followed);
        expect(dockerfileHint(after)).toBe("");
    });

    it("is NOT known-good when the line is anywhere else, is not exactly that line, or comes with any other change", () => {
        const t = template();
        const cases: [string, string][] = [
            [
                "a blank line between the COPY and the line",
                afterCopy(`\n${LINE}\n`),
            ],
            ["a comment above the line", afterCopy(`# close them\n${LINE}\n`)],
            ["the line twice", afterCopy(`${LINE}\n${LINE}\n`)],
            [
                "the line before the COPY",
                t.replace(NATIVE_COPY, () => `${LINE}\n${NATIVE_COPY}`),
            ],
            [
                "the line after USER",
                t.replace(
                    "USER 65532:65532\n",
                    () => `USER 65532:65532\n${LINE}\n`,
                ),
            ],
            ["/app alone", afterCopy("RUN chmod go-w /app\n")],
            ["/app/native alone", afterCopy("RUN chmod go-w /app/native\n")],
            [
                "the two in the other order",
                afterCopy("RUN chmod go-w /app/native /app\n"),
            ],
            [
                "a recursive chmod",
                afterCopy("RUN chmod -R go-w /app /app/native\n"),
            ],
            [
                "a mode that opens them",
                afterCopy("RUN chmod go+w /app /app/native\n"),
            ],
            [
                "the line plus a trailing comment",
                afterCopy(`${LINE} # closed\n`),
            ],
            ["CRLF on the inserted line", afterCopy(`${LINE}\r\n`)],
            [
                "the line and an edit elsewhere",
                `${afterCopy(`${LINE}\n`)}# a user comment\n`,
            ],
            [
                "the line and no trailing newline on the file",
                afterCopy(`${LINE}\n`).trimEnd(),
            ],
        ];
        for (const [why, text] of cases) {
            expect(known(text), why).toBe(false);
        }
    });

    it("the variant is the template text with the line spliced in, and only when the template holds the native/ COPY exactly once", () => {
        expect(vinextTemplateWithCloseLine(template())).toBe(
            afterCopy(`${LINE}\n`),
        );
        // Spliced into whatever text it is given, so a change to the template flows into it.
        expect(vinextTemplateWithCloseLine(`a\n${NATIVE_COPY}b\n`)).toBe(
            `a\n${NATIVE_COPY}${LINE}\nb\n`,
        );
        // A template that has no such COPY, or has it twice, has no variant: it fails closed.
        expect(vinextTemplateWithCloseLine("FROM scratch\n")).toBeUndefined();
        expect(
            vinextTemplateWithCloseLine(`${NATIVE_COPY}${NATIVE_COPY}`),
        ).toBeUndefined();
        expect(
            vinextTemplateWithCloseLine(`x ${NATIVE_COPY}\n${NATIVE_COPY}`),
        ).toBeUndefined();
    });

    it("a missing Dockerfile is not known-good, with the variant in play (never throws)", () => {
        const missing = join(tmp(), "nope", "Dockerfile");
        mkdirSync(join(missing, ".."), { recursive: true });
        expect(isKnownGoodTemplateDockerfile(missing)).toBe(false);
    });
});
