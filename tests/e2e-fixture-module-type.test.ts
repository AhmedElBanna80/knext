// The compile-cache docker e2e (#2247) proves V8 accepts the baked cache for
// .next/standalone/server.js in the form production pods load it. A scaffolded
// app's package.json sets "type": "module", so Next emits an ESM server.js and
// Node logs "V8 code cache for ESM file://...". The e2e fixture must carry the
// same module type, or the e2e proves the CommonJS form nobody ships.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const typeOf = (text: string) => /"type"\s*:\s*"([a-z]+)"/.exec(text)?.[1];

const SCAFFOLD = 'packages/kn-next/templates/app/package.json.hbs';
const FIXTURE = 'packages/kn-next/src/__tests__/fixtures/standalone-drain-app/package.json';
const E2E = [
  'packages/kn-next/src/__tests__/standalone-drain.docker-e2e.test.ts',
  'packages/kn-next/src/__tests__/standalone-webpack-build.docker-e2e.test.ts',
];

describe('the compile-cache e2e fixture loads server.js the way production does (#2247)', () => {
  it('the scaffold declares a module type', () => {
    expect(typeOf(read(SCAFFOLD))).toBeDefined();
  });

  it("the fixture's module type equals the scaffold's", () => {
    expect(typeOf(read(FIXTURE))).toBe(typeOf(read(SCAFFOLD)));
  });

  for (const file of E2E) {
    it(`${file} asserts the server.js cache line in the form that module type produces`, () => {
      expect(typeOf(read(SCAFFOLD))).toBe('module');
      const text = read(file);
      // The literal must be the argument of a .toMatch( call (any full-line
      // comments between are skipped), so a mention in a comment cannot pass.
      const literal = String.raw`/V8 code cache for ESM file:\/\/\/app\/\.next\/standalone\/server\.js was accepted/`;
      const escaped = literal.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      const asArgument = new RegExp(String.raw`\.toMatch\(\s*(?:\/\/[^\n]*\n\s*)*` + escaped + ',');
      expect(text).toMatch(asArgument);
      expect(text).not.toMatch(
        /V8 code cache for CommonJS \\\/app\\\/\\\.next\\\/standalone\\\/server\\\.js/,
      );
    });
  }
});
