/**
 * What a vinext app's in-process Rust image is built around (ADR-0069 Amendment 1, D18), in a module
 * of its own with no imports, so the generator (`render.ts`, which stays free of I/O) and the hint
 * (`init.ts`) read the same definition: the refusal the generated module raises and the advice the
 * CLI prints cannot drift apart, and core's own copy of the two lines (it never imports this
 * package) has one place here to be held against. `ffi-vinext-known-good.test.ts`, in core's test
 * directory and not in core's source, holds the copies in step and checks that the generated module
 * and the shipped vinext template each carry both lines. The two directories are defined once, here:
 * the lines are built from them, and so are the hint's reading of the COPY and the refusal's test of
 * which directories the line fixes (`vinext-pair.test.ts` changes the pair and watches all three move).
 */

/** The two directories a vinext image's library sits under, and that its close line closes: the app's, then its native/. */
export const VINEXT_DIRS = ['/app', '/app/native'] as const;

/** The line that closes them. */
export const VINEXT_CLOSE_LINE = `RUN chmod go-w ${VINEXT_DIRS.join(' ')}`;

/**
 * The scaffolded vinext Dockerfile's `COPY` of `native/` (no line end), which the one close line goes
 * directly after.
 */
export const VINEXT_NATIVE_COPY = `COPY --chown=0:0 --chmod=a-w native ${VINEXT_DIRS[1]}`;

/**
 * The scaffolded vinext Dockerfile's first line: its own pinned `syntax` directive. The hint reads a
 * parser directive as a change in how the file is read and confirms nothing past one, except this line,
 * byte for byte, as the first line of the file. `ffi-vinext-known-good.test.ts` holds it to the
 * shipped template's first line, so a bump of the pin there fails until it is bumped here.
 */
export const VINEXT_SYNTAX_LINE =
  '# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b';
