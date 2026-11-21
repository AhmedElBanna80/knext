/**
 * The two Dockerfile lines a vinext app's in-process Rust image is built around (ADR-0069
 * Amendment 1, D18), in a module of their own with no imports, so the generator (`render.ts`, which
 * stays free of I/O) and the hint (`init.ts`) read the same text: the refusal the generated module
 * raises and the advice the CLI prints cannot drift apart, and core's own copy of both (it never
 * imports this package) has one place here to be held against. `ffi-vinext-known-good.test.ts`, in
 * core's test directory and not in core's source, holds the copies in step and checks that the
 * generated module and the shipped vinext template each carry both lines.
 */

/** The line that closes the two directories a vinext image's library sits under. */
export const VINEXT_CLOSE_LINE = 'RUN chmod go-w /app /app/native';

/**
 * The scaffolded vinext Dockerfile's `COPY` of `native/` (no line end), which the one close line goes
 * directly after.
 */
export const VINEXT_NATIVE_COPY = 'COPY --chown=0:0 --chmod=a-w native /app/native';
