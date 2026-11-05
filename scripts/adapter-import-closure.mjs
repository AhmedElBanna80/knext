#!/usr/bin/env node
/**
 * adapter-import-closure.mjs — the adapter EXECUTION-CLOSURE guard (S1, #545).
 *
 * WHAT THIS PROVES, EXACTLY: the adapter never *executes* CLI code. That makes
 * `src/cli/` REVIEW-SAFE — a CLI defect cannot corrupt a compat result. It does
 * NOT make CLI changes WINDOW-safe: the compat-window digest hashes SHIPPED
 * BYTES, and `dist/cli/**` ships inside the tarball under test
 * (`files: ["dist"]` + `bin: ./dist/cli/kn-next.js`), so a CLI change resets the
 * window. An earlier draft of ADR-0039 conflated the two claims; do not
 * reintroduce that reading (corrected on PR #574).
 *
 * The claim is not free to keep true: packages/kn-next/package.json exports
 * `./internal/cli-validate` and `./internal/cli-shared` from `dist/cli/`, so one
 * import is all it would take to make the adapter execute CLI code.
 *
 * This module computes the closure from SOURCE (the built dist is not available
 * in a plain `pnpm install` tree) and reports any member under a `cli/`
 * directory — `src/cli/` for a relative import, `dist/cli/` for a self-referential
 * subpath export. It is deliberately conservative:
 *   • an unresolvable RELATIVE import throws rather than being skipped (a walker
 *     that silently drops what it cannot resolve is a permanently-green guard);
 *   • dynamic `import()` and `require()` count exactly like a static import —
 *     the runtime reaches them either way.
 *
 * Bare specifiers to OTHER packages (`next`, `node:*`) are not traversed: they
 * are not knext's code. Bare specifiers to the package's OWN name are resolved
 * through its `exports` map, which is precisely the drift path above.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const BUILTINS = new Set(builtinModules);

/** Extensions tried, in order, for an extensionless relative specifier. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

/** Any file living under a `cli/` directory is CLI code the adapter must not execute. */
const CLI_DIR = /(^|\/)cli\//;

/**
 * @typedef {{ kind: string, file: string, specifier: string, detail: string }} ClosureViolation
 * @typedef {{ files: string[], externals: string[], violations: ClosureViolation[] }} ClosureResult
 */

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_KEYWORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * Lex source into `{ type, value }` tokens: `word`, `string`, `punct`. Comments and
 * template text are consumed and emit nothing but an operand placeholder (a template's
 * `${ }` expressions ARE lexed as code); regex literals likewise. Anything it cannot
 * terminate throws: a scanner that guesses past an unterminated construct is how a real
 * import gets silently dropped from the closure.
 */
function tokenize(source, file) {
  const tokens = [];
  // An operand placeholder (a finished template or regex), and the "(" a `${` opens.
  const OPERAND = { type: 'string', value: '' };
  const EXPR_OPEN = { type: 'punct', value: '(' };
  const braceStack = []; // 'brace' | 'template', for `${ ... }` nesting
  const n = source.length;
  let i = 0;
  const fail = (what, at) => {
    const line = source.slice(0, at).split('\n').length;
    throw new Error(
      `adapter closure: unterminated ${what} at ${file}:${line}. Refusing to guess: the scanner cannot tell what imports follow it.`,
    );
  };
  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === 'string') return false;
    if (prev.type === 'word') return REGEX_AFTER_KEYWORD.has(prev.value);
    return !(prev.value === ')' || prev.value === ']');
  };
  /**
   * Consume template text from `i` (just after a backtick or the `}` closing a `${`).
   * Returns true when the template closed, false when it stopped at a `${` expression.
   */
  const lexTemplateText = (startAt) => {
    while (i < n) {
      const c = source[i];
      if (c === '\\') {
        i += 2;
      } else if (c === '`') {
        i++;
        return true;
      } else if (c === '$' && source[i + 1] === '{') {
        i += 2;
        braceStack.push('template');
        return false;
      } else {
        i++;
      }
    }
    fail('template literal', startAt);
  };

  while (i < n) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
    } else if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) fail('block comment', i);
      i = close + 2;
    } else if (c === '"' || c === "'") {
      const startAt = i;
      let value = '';
      i++;
      for (;;) {
        if (i >= n || source[i] === '\n') fail('string literal', startAt);
        const d = source[i];
        if (d === c) {
          i++;
          break;
        }
        if (d === '\\') {
          value += source[i + 1] ?? '';
          i += 2;
        } else {
          value += d;
          i++;
        }
      }
      tokens.push({ type: 'string', value });
    } else if (c === '`') {
      const startAt = i;
      i++;
      tokens.push(lexTemplateText(startAt) ? OPERAND : EXPR_OPEN);
    } else if (c === '/' && regexAllowed()) {
      const startAt = i;
      i++;
      let inClass = false;
      for (;;) {
        if (i >= n || source[i] === '\n') fail('regex literal', startAt);
        const d = source[i];
        if (d === '\\') {
          i += 2;
        } else if (d === '[') {
          inClass = true;
          i++;
        } else if (d === ']') {
          inClass = false;
          i++;
        } else if (d === '/' && !inClass) {
          i++;
          break;
        } else {
          i++;
        }
      }
      while (i < n && /[a-z]/i.test(source[i])) i++; // flags
      tokens.push(OPERAND); // so a following `/` is division
    } else if (WORD_CHAR.test(c) || c.charCodeAt(0) > 127) {
      let j = i + 1;
      while (j < n && (WORD_CHAR.test(source[j]) || source.charCodeAt(j) > 127)) j++;
      tokens.push({ type: 'word', value: source.slice(i, j) });
      i = j;
    } else if (c === '}' && braceStack[braceStack.length - 1] === 'template') {
      braceStack.pop();
      const startAt = i;
      i++;
      tokens.push(lexTemplateText(startAt) ? OPERAND : EXPR_OPEN);
    } else {
      if (c === '{') braceStack.push('brace');
      if (c === '}') braceStack.pop();
      tokens.push({ type: 'punct', value: c });
      i++;
    }
  }
  if (braceStack.includes('template')) fail('template literal expression', n);
  return tokens;
}

/**
 * Every module specifier the file references, static or dynamic.
 *
 * Token-based rather than regex-over-raw-source: a string literal `'from'`, quoted
 * `import`/`require` text, template text, comments and regex literals can never
 * produce a specifier. Throws on a construct it cannot terminate.
 *
 * @param {string} source
 * @param {string} [file] used only in error messages
 * @returns {string[]}
 */
export function specifiersOf(source, file = '<source>') {
  const tokens = tokenize(source, file);
  const found = new Set();
  const isSpecifier = (t) => t?.type === 'string' && t.value !== '';
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'word') continue;
    const prev = tokens[k - 1];
    if (prev?.type === 'punct' && prev.value === '.') continue; // member access, e.g. `x.from`
    const next = tokens[k + 1];
    if ((t.value === 'from' || t.value === 'import') && isSpecifier(next)) {
      found.add(next.value);
    } else if (
      (t.value === 'import' || t.value === 'require') &&
      next?.type === 'punct' &&
      next.value === '(' &&
      isSpecifier(tokens[k + 2])
    ) {
      found.add(tokens[k + 2].value);
    }
  }
  return [...found];
}

/** Resolve a relative specifier to a real file, or return null. */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, ...EXTENSIONS.map((ext) => base + ext)];
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const ext of EXTENSIONS) candidates.push(join(base, `index${ext}`));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Walk an `exports` map entry down to its file target. */
function exportTarget(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    for (const key of ['import', 'default', 'require', 'node']) {
      if (key in entry) {
        const target = exportTarget(entry[key]);
        if (target) return target;
      }
    }
  }
  return null;
}

/**
 * Compute the adapter entry's transitive import closure.
 *
 * @param {string} entryFile absolute path to the adapter entry
 * @param {{ packageRoot: string }} options the package whose `exports` map self-references resolve through
 * @returns {ClosureResult}
 */
export function computeAdapterClosure(entryFile, { packageRoot }) {
  const pkgJsonPath = join(packageRoot, 'package.json');
  const pkg = existsSync(pkgJsonPath)
    ? JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    : { name: undefined, exports: {} };
  const selfName = pkg.name;
  const exportsMap = pkg.exports ?? {};

  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const externals = [];
  /** @type {ClosureViolation[]} */
  const violations = [];
  const seen = new Set();
  const queue = [resolve(entryFile)];

  const flagIfCli = (memberPath, fromFile, specifier, kind) => {
    const rel = relative(packageRoot, memberPath).split('\\').join('/');
    if (CLI_DIR.test(rel)) {
      violations.push({
        kind,
        file: relative(packageRoot, fromFile).split('\\').join('/'),
        specifier,
        detail: `${relative(packageRoot, fromFile)} imports "${specifier}" → ${rel}, which is CLI code under a cli/ directory: the adapter must never EXECUTE the CLI (ADR-0039). Note this is the execution claim, not a freeze exclusion — dist/cli/** ships in the tarball and IS inside the compat-window digest`,
      });
    }
  };

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);

    if (!existsSync(file)) {
      throw new Error(`adapter closure: ${file} does not exist`);
    }
    if (/\.json$/.test(file)) continue;

    const source = readFileSync(file, 'utf8');
    for (const specifier of specifiersOf(source, file)) {
      if (specifier.startsWith('node:') || BUILTINS.has(specifier)) continue;

      if (specifier.startsWith('.') || isAbsolute(specifier)) {
        const resolved = resolveRelative(file, specifier);
        if (!resolved) {
          throw new Error(
            `adapter closure: cannot resolve "${specifier}" from ${file}. A specifier the walker cannot resolve is silently dropped from the closure, which is how this guard goes permanently green — fix the import or teach the resolver.`,
          );
        }
        flagIfCli(resolved, file, specifier, 'relative-import');
        queue.push(resolved);
        continue;
      }

      // Self-referential subpath: `@getknext/core/internal/cli-validate` etc.
      if (selfName && (specifier === selfName || specifier.startsWith(`${selfName}/`))) {
        const subpath = specifier === selfName ? '.' : `.${specifier.slice(selfName.length)}`;
        const target = exportTarget(exportsMap[subpath]);
        if (target) {
          const targetPath = resolve(packageRoot, target);
          flagIfCli(targetPath, file, specifier, 'self-subpath-export');
        }
        externals.push(specifier);
        continue;
      }

      externals.push(specifier);
    }
  }

  return { files: files.sort(), externals: [...new Set(externals)].sort(), violations };
}

/* c8 ignore start — CLI wrapper */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };
  const packageRoot = resolve(arg('package-root', 'packages/kn-next'));
  const entry = resolve(arg('entry', join(packageRoot, 'src/adapters/next-adapter.ts')));
  const { files, violations } = computeAdapterClosure(entry, { packageRoot });
  console.log(`adapter closure: ${files.length} file(s) from ${relative(process.cwd(), entry)}`);
  for (const f of files) console.log(`  ${relative(packageRoot, f)}`);
  if (violations.length > 0) {
    for (const v of violations) console.error(`::error::${v.detail}`);
    process.exit(1);
  }
  console.log('no cli/ file in the adapter closure — the adapter executes no CLI code (ADR-0039)');
}
/* c8 ignore stop */
