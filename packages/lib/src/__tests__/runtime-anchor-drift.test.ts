import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #2787 - `lazy-sdk-loaders.mjs` carries a hand copy of `runtimeAnchor()` from
 * `runtime-anchor.ts` (the .mjs is unprocessed and cannot import a transpiled
 * sibling). This pins the two together: normalized logic must match, and both
 * must behave identically across stack shapes.
 */
const SRC = join(import.meta.dir, '..');
const tsSource = readFileSync(join(SRC, 'runtime-anchor.ts'), 'utf8');
const mjsSource = readFileSync(join(SRC, 'lazy-sdk-loaders.mjs'), 'utf8');

/** Strip comments, `export`, and blank lines; collapse whitespace. */
function normalize(code: string): string {
  return (
    code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/^\s*\/\/.*$/, '').trim())
      .filter(Boolean)
      .join('\n')
      .replace(/^export /gm, '')
      .replace(/\s+/g, ' ')
      // The TS transpiler folds `return undefined;` to `return;` (same semantics).
      .replace(/return undefined;/g, 'return;')
  );
}

/** Slice from the REAL_LOCATION constant through the end of runtimeAnchor(). */
function logicSlice(code: string): string {
  const start = code.indexOf('const REAL_LOCATION');
  const fnStart = code.indexOf('function runtimeAnchor');
  expect(start).toBeGreaterThan(-1);
  expect(fnStart).toBeGreaterThan(start);
  const end = code.indexOf('\n}', fnStart) + 2;
  return code.slice(start, end);
}

const transpiler = new Bun.Transpiler({ loader: 'ts' });
const tsLogic = transpiler.transformSync(logicSlice(tsSource));
const mjsLogic = logicSlice(mjsSource);

type Anchor = () => string;
type Stack = { fileName?: string | null } | 'string';

/** Build the logic with a fake `Error` whose stack yields `stack`'s file name. */
function build(logic: string, stack: Stack): Anchor {
  const body = `${logic.replace(/^export /gm, '')}; return runtimeAnchor;`;
  class FakeError {
    static prepareStackTrace: unknown;
    static stackTraceLimit = 10;
    stack: unknown;
    constructor() {
      const prep = FakeError.prepareStackTrace as
        | ((e: unknown, s: unknown[]) => unknown)
        | undefined;
      if (stack === 'string' || !prep) {
        this.stack = 'Error\n  at x';
      } else {
        const sites = stack.fileName === undefined ? [] : [{ getFileName: () => stack.fileName }];
        this.stack = prep(this, sites);
      }
    }
  }
  return new Function('Error', 'process', body)(FakeError, { cwd: () => '/work' }) as Anchor;
}

describe('runtimeAnchor copy parity (#2787)', () => {
  it('normalized logic of the .mjs copy equals the .ts original', () => {
    expect(normalize(mjsLogic)).toBe(normalize(tsLogic));
  });

  const shapes: Array<[string, Stack, string]> = [
    [
      'real posix call',
      { fileName: '/app/node_modules/@getknext/lib/dist/x.js' },
      '/app/node_modules/@getknext/lib/dist/x.js',
    ],
    ['file: url', { fileName: 'file:///app/x.js' }, 'file:///app/x.js'],
    ['webpack-internal', { fileName: 'webpack-internal:///(rsc)/x.js' }, '/work/'],
    ['$bunfs', { fileName: '/$bunfs/root/app' }, '/work/'],
    ['~BUN', { fileName: '/~BUN/root/app' }, '/work/'],
    ['null file name', { fileName: null }, '/work/'],
    ['empty stack', {}, '/work/'],
    ['non-array stack', 'string', '/work/'],
  ];
  for (const [name, stack, expected] of shapes) {
    it(`both return the same anchor: ${name}`, () => {
      const a = build(tsLogic, stack)();
      const b = build(mjsLogic, stack)();
      expect(a).toBe(expected);
      expect(b).toBe(a);
    });
  }
});
