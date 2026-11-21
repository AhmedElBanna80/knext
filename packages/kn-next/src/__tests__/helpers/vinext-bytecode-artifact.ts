/**
 * Stand-in compiled-executable bytes for tests that drive `buildVinextExecutable`
 * without a real compile. One definition, so the "what a bytecode compile leaves"
 * model cannot drift between suites. (The real thing is exercised by
 * `vinext-compile-og-exec` and `vinext-build-include-real-compile`.)
 */

const PAD = "\0".repeat(256);

/** One compiled module: pragma, then the banner (source), as Bun lays it out. */
const moduleSource = (marker: string, bytecode: boolean) =>
    `// @bun ${bytecode ? "@bytecode " : ""}@bun-esm\nglobalThis.__knextVinextExecMarker=${JSON.stringify(marker)};export{};\n${PAD}`;

/** `modules` banner-headed modules plus (with bytecode) the constant-pool copy of the marker. */
export function bytecodeArtifact(
    marker: string,
    modules = 1,
    bytecode = true,
): Buffer {
    return Buffer.from(
        `ELF…${bytecode ? `pool:${marker}…` : ""}${Array.from({ length: modules }, () => moduleSource(marker, bytecode)).join("")}`,
        "latin1",
    );
}

/** The marker the CLI passed to the compile (`--marker <m>`) in `argv`. */
export function markerFromArgv(argv: readonly string[] | undefined): string {
    return argv?.[argv.indexOf("--marker") + 1] ?? "";
}

/** The artifact a bytecode compile leaves for the marker in `argv`. */
export function bytecodeFor(
    argv: readonly string[] | undefined,
    modules = 1,
): Buffer {
    return bytecodeArtifact(markerFromArgv(argv), modules);
}
