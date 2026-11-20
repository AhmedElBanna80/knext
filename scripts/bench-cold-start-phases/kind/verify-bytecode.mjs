#!/usr/bin/env node
// Independent proof that a `bun build --compile` executable carries bytecode, read from the
// executable itself (not from a build flag or a CLI claim).
//
//   verify-bytecode.mjs standalone <binary>
//       The turbopack+bun executable. The compile embeds a per-build marker
//       `knext-standalone-exec:<24 hex>`; the marker is read out of the binary and checked with the
//       same verifier `knext build` uses (bytecode-exec-verify.mjs): the marker sits under a
//       `// @bun @bytecode` module pragma and a second copy sits in the bytecode constant pool.
//
//   verify-bytecode.mjs pragma <binary> <baseline-binary>
//       The vinext+bun executable. Its default compile passes `bytecode: true` but embeds no marker
//       and `knext build` runs no bytecode check on it, so the marker route does not exist. Instead
//       count the module pragma `// @bun @bytecode @bun-cjs` (Latin-1 and UTF-16LE) in the binary
//       and in a baseline probe compiled WITHOUT bytecode for the same target and Bun: the Bun
//       runtime embeds one copy of the text itself (measured: 1 in a no-bytecode build, 2 with
//       bytecode), so the check passes only when the binary's count exceeds the baseline's. That
//       shows the build requested bytecode; it is not a per-build marker proof.
//
// Exit 0 verified (one verdict line on stdout), 1 not verified (reason on stderr), 2 usage or
// unreadable input. A missing baseline is a usage error, never a pass.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { verifyBytecodeExec } = await import(
  resolve(HERE, "../../../packages/kn-next/src/adapters/bytecode-exec-verify.mjs")
);

const PRAGMA = "// @bun @bytecode @bun-cjs";
const MARKER_RE = /knext-standalone-exec:[0-9a-f]{24}/;

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

function read(path) {
  try {
    return readFileSync(path);
  } catch (e) {
    return die(2, `cannot read ${path}: ${e.message}`);
  }
}

function count(buf, text) {
  let n = 0;
  for (const enc of ["latin1", "utf16le"]) {
    const needle = Buffer.from(text, enc);
    for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + needle.length)) n++;
  }
  return n;
}

const [mode, binary, baseline] = process.argv.slice(2);
if (!mode || !binary) die(2, "usage: verify-bytecode.mjs standalone <binary> | pragma <binary> <baseline>");

if (mode === "standalone") {
  const buf = read(binary);
  let marker = null;
  for (const enc of ["latin1", "utf16le"]) {
    const m = buf.toString(enc).match(MARKER_RE);
    if (m) {
      marker = m[0];
      break;
    }
  }
  if (!marker) die(1, `no knext-standalone-exec marker in ${binary}: not the entry knext compiled`);
  const v = verifyBytecodeExec(buf, marker);
  if (!v.ok) die(1, `bytecode check failed for ${binary}: ${v.reason}`);
  console.log(`bytecode verified: ${marker} sits under a @bytecode pragma with a constant-pool copy`);
} else if (mode === "pragma") {
  if (!baseline) die(2, "pragma mode needs a baseline probe binary (compiled without bytecode)");
  const app = count(read(binary), PRAGMA);
  const base = count(read(baseline), PRAGMA);
  if (app <= base) {
    die(1, `no bytecode evidence in ${binary}: @bytecode pragma count app=${app} is not above baseline=${base}`);
  }
  console.log(`the build requested bytecode (pragma differential): @bytecode pragma count app=${app} baseline=${base}`);
} else {
  die(2, `unknown mode '${mode}'`);
}
