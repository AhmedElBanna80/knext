import { describe, expect, it } from 'bun:test';
import { specifiersOf } from '../scripts/adapter-import-closure.mjs';

/**
 * Scanner tests for `specifiersOf` in `scripts/adapter-import-closure.mjs`.
 *
 * The old scanner ran `\bfrom\s*["']([^"']+)` over raw source, so a string
 * literal `'from'` matched and the capture ran across code to the next quote,
 * reporting source fragments as packages. The scanner now tokenizes, so quoted
 * text, comments, template text and regex literals never produce specifiers.
 */

const found = (source: string) => [...specifiersOf(source)].sort();

describe('specifiersOf: text that is not an import', () => {
  it("a string literal 'from' reports no specifier (the reported bug)", () => {
    const src = `const x = 'from';\nconst y = 'node:fs';\nconsole.log(x, y);\n`;
    expect(found(src)).toEqual([]);
  });

  it('a double-quoted "from" followed by code and another quote reports nothing', () => {
    expect(found(`const a = "from"; const b = "z";`)).toEqual([]);
  });

  it('quoted import( and require( text reports nothing', () => {
    const src = `const a = "import('x')"; const b = 'require("y")'; const c = 'import "z"';`;
    expect(found(src)).toEqual([]);
  });

  it('template-literal text reports nothing, but an expression inside it is still code', () => {
    const src = 'const a = `from "nope" and require("nope2")`;\nconst b = `${require("real")}`;\n';
    expect(found(src)).toEqual(['real']);
  });

  it('regex literals containing quotes and from do not derail the scan', () => {
    const src = `const re = /from\\s*["']([^"']+)/g;\nimport { a } from 'real';\n`;
    expect(found(src)).toEqual(['real']);
  });

  it('commented-out imports are not found', () => {
    const src = `// import x from 'line'\n/* import y from 'block' */\nimport z from 'live';`;
    expect(found(src)).toEqual(['live']);
  });

  it('a // inside a string is not a comment (the import after it is still found)', () => {
    const src = `const u = 'http://x'; import a from 'after-url';`;
    expect(found(src)).toEqual(['after-url']);
  });
});

describe('specifiersOf: real imports are still found', () => {
  it('static, multi-line, side-effect, dynamic and require forms', () => {
    const src = [
      `import a from 'one';`,
      `import {`,
      `  b,`,
      `  c,`,
      `} from "two";`,
      `import * as ns from\n  'three';`,
      `import 'four';`,
      `export { d } from 'five';`,
      `export * from "six";`,
      `const m = await import('seven');`,
      `const r = require("eight");`,
      `import type { T } from 'nine';`,
    ].join('\n');
    expect(found(src)).toEqual([
      'eight',
      'five',
      'four',
      'nine',
      'one',
      'seven',
      'six',
      'three',
      'two',
    ]);
  });

  it('a real import after a string literal holding quoted from text is found', () => {
    const src = `const label = 'from';\nimport x from 'real';\nconst l2 = "from";`;
    expect(found(src)).toEqual(['real']);
  });

  it('division is not mistaken for a regex start', () => {
    const src = `const q = (a + b) / 2 / 3; const t = a / b; import x from 'after-div';`;
    expect(found(src)).toEqual(['after-div']);
  });
});

describe('specifiersOf: fails closed on what it cannot parse', () => {
  it('throws on an unterminated string', () => {
    expect(() => specifiersOf(`const a = 'oops;\nimport x from 'real';`)).toThrow(/unterminated/i);
  });

  it('throws on an unterminated block comment', () => {
    expect(() => specifiersOf(`/* never closed\nimport x from 'real';`)).toThrow(/unterminated/i);
  });

  it('throws on an unterminated template literal', () => {
    expect(() => specifiersOf('const a = `never closed')).toThrow(/unterminated/i);
  });
});
