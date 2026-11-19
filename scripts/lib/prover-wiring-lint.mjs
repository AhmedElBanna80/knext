/**
 * Lint: a mutation-prover row whose catching spec only does a SOURCE-TEXT match on the
 * subject is a WIRING row, and must say so. Each row is also counted as WIRING, BEHAVIOURAL or
 * UNATTRIBUTED, so a green total cannot overstate what the rows prove.
 *
 * Why. A row is only as strong as the spec that must go red for it. When that spec reads the
 * subject file and asserts `toContain` / `toMatch` / `includes` / `indexOf` / `match` on the raw
 * text, the row proves the text is present, not what the code DOES. That is a legitimate
 * guarantee (a call is wired in the right phase) but it must be labelled, so nobody reads a
 * green wiring row as behavioural proof.
 *
 * The label is explicit and read from the prover source (never inferred from a row's wording):
 *   - row level:  an object literal `{ subject: 'K', kind: 'wiring', ... }`, or a positional
 *                 row built by a callee named like `wiring*` (e.g. `wiringRow('WR1', 'K', ...)`)
 *                 whose body sets `kind: 'wiring'`;
 *   - prover level: a top-level `const WIRING_SUBJECTS = ['K', ...]` naming subject keys whose
 *                 every row is wiring (used where rows are generated or the table is positional).
 *
 * CLASSIFICATION (heuristic). Each spec that names a subject (its base name appears in the
 * spec's text) is classified for that subject by `classifyPair`:
 *   - 'text'      the spec only reads the file's text and asserts on it: a substring/regex check;
 *   - 'executed'  the spec runs or loads the subject: an import/require, or its path passed to a
 *                 spawn-family call (`spawnSync('bash', [p])`), or a path used in some other way
 *                 that is not a text read;
 *   - 'other'     the spec reads the text and does something that is neither a substring check
 *                 nor an execution (parses it, stores it, never asserts on it), or the path is
 *                 named but never read, or a shell option this lint cannot read is in front of it.
 *   - 'mixed'     the spec both executes the subject and reads it as text: every use is classified,
 *                 not only the first, and two kinds of use make the verdict 'mixed'.
 *                 A text read handed to a LOCAL helper counts as text when that helper only asserts
 *                 on its parameter (`assertHas(src)`); see `helperChecksArg`.
 * A subject is then classified by `subjectAttribution`:
 *   - 'text'          every naming spec is 'text' (a row on it is WIRING);
 *   - 'executed'      every naming spec is 'executed' (an unlabelled row on it is BEHAVIOURAL);
 *   - 'unattributed'  anything else: no spec names it, or the naming specs disagree, or one is
 *                     'other' or 'mixed'. Its unlabelled rows are UNATTRIBUTED.
 *
 * LIMIT, the attribution one (the reason 'unattributed' exists). A row carries no spec field, so a
 * row cannot be tied to the spec that catches it. Where a subject is named by a text-only spec AND
 * an executing spec, the row might be caught by either, so it is UNATTRIBUTED, never BEHAVIOURAL.
 * The summary only ever credits behaviour when every naming spec executes the subject.
 *
 * Other documented limits (each one errs toward NOT calling a row text-only, except where stated):
 *   - Text flows are followed through `resolve`/`join`/`new URL` path builders, `const` bindings,
 *     `Bun.file(p)` handles read with `.text()`, and aliases of the read functions
 *     (`const rf = readFileSync`). A flow through a function parameter, a re-export, or a property
 *     of an object is not followed; a subject named only there is not seen.
 *   - A string method (`slice`, `split`, `replace`, `substring`, `match`, ...) whose RESULT is used
 *     for anything but an assertion or another string method (`JSON.parse(x.slice(..))`, a spawn
 *     argument built with `.replace()`, a helper) is not a substring check. Any unrecognised
 *     consumer counts as escaping, so this can only under-count text-only rows.
 *   - `bash -n <subject>` parses the file and does not run it, but only when `-n` (or a flag cluster
 *     containing `n`) comes BEFORE the subject and only flags precede it. `bash <subject> -n`
 *     runs the subject.
 *   - Limited to the spec's own text. A spec that delegates the check to a helper module is not
 *     seen, and its subject is UNATTRIBUTED unless another spec names it.
 */
import ts from 'typescript';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proverSubjectPaths, referencedSpecs } from './prover-lane.mjs';

const parse = (name, source, kind) =>
  ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, kind);

const TITLE_CALLEES = new Set(['describe', 'it', 'test']);
const PATH_CALLEES = new Set(['resolve', 'join', 'URL', 'fileURLToPath']);
const SUBSTRING_METHODS = new Set([
  'includes',
  'indexOf',
  'lastIndexOf',
  'match',
  'matchAll',
  'search',
  'test',
  'startsWith',
  'endsWith',
  'slice',
  'substring',
  'split',
  // Rewriting the source text is a text-only use too (`src.replace(a, b)`), not a parse.
  'replace',
  'replaceAll',
]);
// Methods whose RESULT is (or contains) text, so the result can reach an executing consumer. A
// predicate or an index (`includes`, `indexOf`, `test`) cannot carry text, so it is never followed.
const TEXT_RESULT_METHODS = new Set([
  'slice',
  'substring',
  'split',
  'replace',
  'replaceAll',
  'match',
  'matchAll',
]);
const SUBSTRING_MATCHERS = new Set(['toContain', 'toMatch', 'toContainEqual', 'toInclude']);
// Pass-through string methods: `src.toLowerCase().includes(x)` still checks the source text.
const TEXT_TRANSFORMS = new Set([
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'normalize',
  'toString',
]);
// Readers that turn a file handle into its text: `Bun.file(p).text()`.
const READ_ADAPTERS = new Set(['text', ...TEXT_TRANSFORMS]);
// Names of read functions. `readFileSync`, `readFile`, `readText`, `read`, and any alias bound to one.
const READ_NAME = /^(readFile|read[A-Z_]|read$)/;
// Calls that run (or load) what they are given: a path handed to one of these is EXECUTED.
const EXECUTING_CALLEES = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
  'require',
  'eval',
  'runInNewContext',
  'runInThisContext',
]);
const MAX_FLOW_DEPTH = 4;
// Array methods whose result still holds the text (`lines.filter(..)`, `parts.join(..)`).
const ARRAY_TEXT_METHODS = new Set(['filter', 'find', 'at', 'concat', 'join', 'flatMap', 'map']);
const COMPARISON_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}
/** `Bun.file(p)`: a file handle whose text is read with `.text()`. */
const isBunFile = (n) =>
  ts.isCallExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) &&
  n.expression.name.text === 'file' &&
  ts.isIdentifier(n.expression.expression) &&
  n.expression.expression.text === 'Bun';
/** A read of a file's contents: a read-named call, an alias of one, or `Bun.file(p)` (a handle). */
const isReadCall = (n, aliases) =>
  (ts.isCallExpression(n) || ts.isNewExpression(n)) &&
  (READ_NAME.test(calleeName(n) ?? '') || aliases.has(calleeName(n) ?? '') || isBunFile(n));

const strLit = (n) =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;

/**
 * `bash -n p` / `sh -n p`: a SYNTAX check parses the subject without running it, so it neither
 * executes the subject nor counts as a text read. The `-n` must come BEFORE the subject (a flag or a
 * flag cluster containing `n`, with only flags in front of the subject). After the subject the script
 * runs, and `-n` is one of its arguments. The shell must be `bash`/`sh`, either the first argument of
 * the spawn (`spawnSync('bash', [...])`) or the first element of a Bun.spawn-style array.
 */
// Bash options this lint can read. A letter in NOARG_SHORT takes no argument; -o/-O take one (the next word).
const NOARG_SHORT = 'abefhkmnptuvxBCHPT';
const NOARG_LONG = new Set(['--posix', '--norc', '--noprofile', '--login', '--restricted', '--noediting']);
const ARG_LONG = new Set(['--rcfile', '--init-file']);

/**
 * How a shell invocation treats the subject, read from the words before it (see the header):
 *   'check'   -n is set: the subject is parsed, not run;
 *   'run'     the subject is run (no -n, or a word before it ends the options);
 *   'unknown' an option this lint cannot read, or an argument missing: unattributed, never executed;
 * and undefined when the subject is not an argument of a shell at all.
 */
function shellArgKind(expr) {
  const arr = expr.parent;
  if (!arr || !ts.isArrayLiteralExpression(arr)) return undefined;
  const shells = (n) => n !== undefined && ['bash', 'sh'].includes(strLit(n));
  const call = arr.parent;
  let args;
  if (
    call &&
    (ts.isCallExpression(call) || ts.isNewExpression(call)) &&
    call.arguments[1] === arr &&
    shells(call.arguments[0])
  ) {
    args = arr.elements;
  } else if (shells(arr.elements[0])) {
    args = arr.elements.slice(1);
  } else {
    return undefined;
  }
  const idx = args.indexOf(expr);
  if (idx < 0) return undefined;
  const before = args.slice(0, idx).map(strLit);
  let check = false;
  for (let i = 0; i < before.length; i++) {
    const f = before[i];
    if (f === undefined) return 'unknown'; // a non-literal option word: cannot be read
    if (f === '-' || !/^[-+]/.test(f)) return 'run'; // the first word that is not an option ends them
    if (f.startsWith('--')) {
      if (NOARG_LONG.has(f)) continue;
      if (!ARG_LONG.has(f) || i + 1 >= before.length) return 'unknown';
      i += 1; // --rcfile X: the argument is the next word, and it is before the subject
      continue;
    }
    const m = /^([-+])([A-Za-z]+)$/.exec(f);
    if (!m) return 'unknown';
    for (let j = 0; j < m[2].length; j++) {
      const c = m[2][j];
      if (c === 'o' || c === 'O') {
        // -o X / +o X / -O X: the option's argument is the next word, which must itself be before the subject.
        if (j !== m[2].length - 1 || i + 1 >= before.length) return 'unknown';
        i += 1;
        break;
      }
      if (c === 'n') check = m[1] === '-'; // the LAST setting wins: '+n' turns the check off again
      else if (!NOARG_SHORT.includes(c)) return 'unknown';
    }
  }
  return check ? 'check' : 'run';
}

/** Is this path expression handed to a call that runs (or loads) it, directly or in an argument array? */
function spawnedBy(node) {
  let n = node;
  while (n.parent && ts.isArrayLiteralExpression(n.parent)) n = n.parent;
  const c = n.parent;
  return Boolean(
    c &&
      (ts.isCallExpression(c) || ts.isNewExpression(c)) &&
      c.arguments?.includes(n) &&
      EXECUTING_CALLEES.has(calleeName(c) ?? ''),
  );
}

/** The value a read produces, through `await`, parens, casts and `.text()`-style adapters. */
function readValueEnd(expr) {
  let cur = expr;
  for (;;) {
    const p = cur.parent;
    if (p && (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p))) {
      cur = p;
      continue;
    }
    if (
      p &&
      ts.isPropertyAccessExpression(p) &&
      p.expression === cur &&
      READ_ADAPTERS.has(p.name.text)
    ) {
      const c = p.parent;
      if (c && ts.isCallExpression(c) && c.expression === p) {
        cur = c;
        continue;
      }
    }
    return cur;
  }
}

/**
 * What a read call binds. A read that already went through an adapter (`Bun.file(p).text()`) binds
 * TEXT. A bare `Bun.file(p)` binds a HANDLE, whose text is only read by a later `f.text()`.
 */
function readBinding(c) {
  const v = declaredName(c);
  const end = readValueEnd(c);
  if (end !== c) return v ? { name: v } : { inline: end };
  return v ? { name: v, handle: isBunFile(c) } : { inline: end };
}

/** Climb from a path literal through path builders; returns the outermost path expression. */
function outerPathExpr(node) {
  let cur = node;
  for (;;) {
    const p = cur.parent;
    if (!p) return cur;
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p)) {
      cur = p;
      continue;
    }
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(cur)) {
      const name = calleeName(p);
      if (PATH_CALLEES.has(name)) {
        cur = p;
        continue;
      }
    }
    return cur;
  }
}

/** The enclosing call whose argument list directly holds `expr`, if any. */
const argOf = (expr) => {
  const p = expr.parent;
  return p && (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(expr)
    ? p
    : undefined;
};

/** The VariableDeclaration an expression initialises (through await / toString / as). */
function declaredName(expr) {
  let cur = expr;
  for (;;) {
    const p = cur.parent;
    if (!p) return undefined;
    if (ts.isVariableDeclaration(p) && p.initializer === cur && ts.isIdentifier(p.name))
      return p.name.text;
    if (
      ts.isAwaitExpression(p) ||
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      (ts.isPropertyAccessExpression(p) && p.expression === cur) ||
      (ts.isCallExpression(p) && p.expression === cur)
    ) {
      cur = p;
      continue;
    }
    return undefined;
  }
}

function identifierUses(sf, name) {
  const uses = [];
  const visit = (n) => {
    if (ts.isIdentifier(n) && n.text === name) {
      const p = n.parent;
      // A declaration (a `const` or a parameter) is not a use of the value it binds.
      const isDecl = p && (ts.isVariableDeclaration(p) || ts.isParameter(p)) && p.name === n;
      const isKey = p && ts.isPropertyAccessExpression(p) && p.name === n;
      if (!isDecl && !isKey) uses.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return uses;
}

/** A node that opens a scope a binding can be declared in. */
const isScopeNode = (n) =>
  ts.isBlock(n) ||
  ts.isSourceFile(n) ||
  ts.isForOfStatement(n) ||
  ts.isForStatement(n) ||
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n);

/** Does scope node `s` itself declare `name` (a parameter, a const/let, a function, a for-of binding)? */
function declaresName(s, name) {
  const isName = (d) => ts.isIdentifier(d.name) && d.name.text === name;
  if (
    ts.isArrowFunction(s) ||
    ts.isFunctionExpression(s) ||
    ts.isFunctionDeclaration(s) ||
    ts.isMethodDeclaration(s)
  ) {
    return s.parameters.some(isName);
  }
  if (ts.isBlock(s) || ts.isSourceFile(s)) {
    return s.statements.some(
      (st) =>
        (ts.isVariableStatement(st) && st.declarationList.declarations.some(isName)) ||
        (ts.isFunctionDeclaration(st) && st.name?.text === name),
    );
  }
  if (ts.isForOfStatement(s) || ts.isForStatement(s)) {
    const init = s.initializer;
    return Boolean(init && ts.isVariableDeclarationList(init) && init.declarations.some(isName));
  }
  return false;
}

/**
 * The uses of the binding `decl` (a VariableDeclaration, a parameter's function, or a FunctionDeclaration)
 * introduces, in its own scope and NOT under a nearer redeclaration of the same name. Unlike
 * `identifierUses` (every identifier of that spelling in the file), this does not count the `before` of an
 * unrelated helper as a use of this test's `before`.
 */
function bindingUses(decl, name) {
  let scope = decl.parent;
  while (scope && !isScopeNode(scope)) scope = scope.parent;
  if (!scope) return [];
  const shadowed = (n) => {
    for (let a = n.parent; a && a !== scope; a = a.parent) {
      if (isScopeNode(a) && declaresName(a, name)) return true;
    }
    return false;
  };
  const out = [];
  const visit = (n) => {
    if (ts.isIdentifier(n) && n.text === name) {
      const p = n.parent;
      const isDeclName =
        p &&
        (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p)) &&
        p.name === n;
      const isKey = p && ts.isPropertyAccessExpression(p) && p.name === n;
      if (!isDeclName && !isKey && !shadowed(n)) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
}

/** The function a return statement belongs to (the nearest enclosing function-like node). */
function enclosingFunction(node) {
  let f = node.parent;
  while (
    f &&
    !(ts.isArrowFunction(f) || ts.isFunctionExpression(f) || ts.isFunctionDeclaration(f))
  ) {
    f = f.parent;
  }
  return f;
}

/** The name a function is bound to: `function f()` or `const f = () => ...`. Anything else is anonymous. */
function functionName(fn) {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text;
  const p = fn.parent;
  return p && ts.isVariableDeclaration(p) && p.initializer === fn && ts.isIdentifier(p.name)
    ? p.name.text
    : undefined;
}

/** Names bound to a read function: `const rf = readFileSync` (or `= fs.readFileSync`). */
function readAliases(sf) {
  const out = new Set();
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = n.initializer;
      const name = ts.isIdentifier(init)
        ? init.text
        : ts.isPropertyAccessExpression(init)
          ? init.name.text
          : undefined;
      if (name !== undefined && READ_NAME.test(name)) out.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Helpers whose parameter is being checked right now: a helper that calls back into itself is refused. */
const helpersInFlight = new Set();

/** The local function (declaration, or `const f = () => ..`) named `name` in this file, or undefined. */
function localFunction(sf, name) {
  let found;
  const visit = (n) => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    )
      found = n.initializer;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/**
 * Does a LOCAL helper only assert on the argument `arg` it is called with? True when the helper is in this
 * file, the argument lands on a plain parameter, and every use of that parameter inside the helper is a
 * substring/regex check (so the helper's body is string and assert methods only). Helpers may call further
 * helpers; a cycle is refused. Helper bodies that store, parse or otherwise hand on the text are not checks.
 */
function helperChecksArg(call, arg) {
  if (!ts.isIdentifier(call.expression)) return false;
  const idx = call.arguments.indexOf(arg);
  if (idx < 0) return false;
  const fn = localFunction(call.getSourceFile(), call.expression.text);
  const param = fn?.parameters[idx];
  if (!fn || !param || param.dotDotDotToken || !ts.isIdentifier(param.name)) return false;
  if (helpersInFlight.has(fn)) return false;
  helpersInFlight.add(fn);
  try {
    const uses = bindingUses(param, param.name.text);
    return uses.length > 0 && uses.every((u) => isSubstringUse(u));
  } finally {
    helpersInFlight.delete(fn);
  }
}

/**
 * Does the value of `node` reach something other than an assertion or another string method? That
 * is what makes a `slice`/`split`/`replace` result an EXECUTING or parsing use of the text, not a
 * substring check. A result that is dropped, asserted on (`expect(..)`), or matched (`re.test(..)`,
 * `s.includes(..)`) does not escape. A result passed to any other call, returned, compared, or
 * stored where it is later passed on, does. Anything not followed (depth limit, destructuring) escapes.
 */
function escapesTextCheck(node, depth = 0) {
  if (depth > MAX_FLOW_DEPTH) return true;
  let cur = node;
  for (;;) {
    const p = cur.parent;
    if (!p) return false;
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isAwaitExpression(p)) {
      cur = p;
      continue;
    }
    if (ts.isTemplateSpan(p)) {
      cur = p.parent;
      continue;
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      cur = p;
      continue;
    }
    if (ts.isArrayLiteralExpression(p)) {
      cur = p;
      continue;
    }
    // A comparison yields a boolean, which carries no text.
    if (ts.isBinaryExpression(p) && COMPARISON_OPERATORS.has(p.operatorToken.kind)) return false;
    // A line count or a length is a number, not text.
    if (ts.isPropertyAccessExpression(p) && p.expression === cur && p.name.text === 'length')
      return false;
    // A predicate or an index (`indexOf`, `includes`, `test`) is a boolean or a number: it carries no text.
    if (
      ts.isPropertyAccessExpression(p) &&
      p.expression === cur &&
      SUBSTRING_METHODS.has(p.name.text)
    ) {
      return false;
    }
    // Another text method on the result (`x.slice(0).trim()`, `lines.filter(..)`) is still text.
    if (
      ts.isPropertyAccessExpression(p) &&
      p.expression === cur &&
      (TEXT_TRANSFORMS.has(p.name.text) ||
        TEXT_RESULT_METHODS.has(p.name.text) ||
        ARRAY_TEXT_METHODS.has(p.name.text))
    ) {
      const c = p.parent;
      if (c && ts.isCallExpression(c) && c.expression === p) {
        cur = c;
        continue;
      }
      return true;
    }
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      if (!p.arguments?.includes(cur)) return true;
      // An assertion or a match does not hand the text on.
      if (ts.isIdentifier(p.expression) && p.expression.text === 'expect') return false;
      if (
        ts.isPropertyAccessExpression(p.expression) &&
        (SUBSTRING_METHODS.has(p.expression.name.text) || p.expression.name.text === 'test')
      ) {
        return false;
      }
      return !helperChecksArg(p, cur);
    }
    if (ts.isVariableDeclaration(p) && p.initializer === cur) {
      if (!ts.isIdentifier(p.name)) return true;
      return bindingUses(p, p.name.text).some((u) => escapesTextCheck(u, depth + 1));
    }
    // `for (const line of lines)`: each line is the loop variable.
    if (ts.isForOfStatement(p) && p.expression === cur) {
      const init = p.initializer;
      if (!ts.isVariableDeclarationList(init) || init.declarations.length !== 1) return true;
      const name = init.declarations[0].name;
      if (!ts.isIdentifier(name)) return true;
      return bindingUses(init.declarations[0], name.text).some((u) =>
        escapesTextCheck(u, depth + 1),
      );
    }
    // A value returned from a named helper escapes only if one of its call sites lets it escape.
    if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === cur)) {
      const fn = ts.isArrowFunction(p) ? p : enclosingFunction(p);
      const name = fn && functionName(fn);
      if (!name) return true;
      return bindingUses(ts.isFunctionDeclaration(fn) ? fn : fn.parent, name).some((u) => {
        const c = u.parent;
        return (
          !(c && ts.isCallExpression(c) && c.expression === u) || escapesTextCheck(c, depth + 1)
        );
      });
    }
    if (ts.isExpressionStatement(p)) return false; // computed and dropped
    return true; // passed on, stored in an object, or otherwise consumed
  }
}

/** Is this use of the text variable (or inline read) a pure substring/regex assertion? */
function isSubstringUse(use) {
  // Climb a chain of pass-through string methods (`v.toLowerCase().trim()`) to the value that is
  // finally checked. Without this, one `.toLowerCase()` hid a substring check from the lint.
  let cur = use;
  for (;;) {
    const q = cur.parent;
    if (
      q &&
      ts.isPropertyAccessExpression(q) &&
      q.expression === cur &&
      TEXT_TRANSFORMS.has(q.name.text)
    ) {
      const c = q.parent;
      if (c && ts.isCallExpression(c) && c.expression === q) {
        cur = c;
        continue;
      }
    }
    break;
  }
  const p = cur.parent;
  // v.includes(...) / v.indexOf(...) / v.match(...). A text-returning method whose result is passed
  // on (JSON.parse, a spawn argument, a helper) is not a substring check.
  if (
    p &&
    ts.isPropertyAccessExpression(p) &&
    p.expression === cur &&
    SUBSTRING_METHODS.has(p.name.text)
  ) {
    const c = p.parent;
    if (TEXT_RESULT_METHODS.has(p.name.text) && c && ts.isCallExpression(c) && c.expression === p) {
      return !escapesTextCheck(c);
    }
    return true;
  }
  // expect(v).[not.]toContain(...)
  const call = argOf(cur);
  if (call && ts.isIdentifier(call.expression) && call.expression.text === 'expect') {
    let cur = call.parent;
    while (cur && ts.isPropertyAccessExpression(cur)) {
      if (SUBSTRING_MATCHERS.has(cur.name.text)) return true;
      cur = cur.parent;
    }
  }
  // A local helper that asserts on its argument (`assertHas(src)`): the text is checked inside it.
  if (cur.parent && ts.isCallExpression(cur.parent) && helperChecksArg(cur.parent, cur)) return true;
  // regex.test(v)
  if (
    call &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === 'test'
  ) {
    return true;
  }
  return false;
}

/**
 * How one spec treats one subject file: 'text' (substring/regex checks only), 'executed' (run or
 * loaded), or 'other' (read as text but not substring-checked, or named but never read).
 * @param {string} specSource
 * @param {string} subjectPath repo-relative subject path
 * @returns {'text' | 'executed' | 'mixed' | 'other'}
 */
export function classifyPair(specSource, subjectPath, specPath = SPEC_DEFAULT) {
  const sf = parse('spec.ts', specSource, ts.ScriptKind.TS);
  const lits = [];
  const collect = (n) => {
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      refersTo(n.text, subjectPath, specPath)
    ) {
      lits.push(n);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  // An import / require of the subject (any extension spelling) means the spec EXECUTES it.
  let imported = false;
  const findImports = (n) => {
    const spec =
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier
        ? strLit(n.moduleSpecifier)
        : ts.isCallExpression(n) &&
            n.arguments.length > 0 &&
            (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
              /^(require|mock|doMock|module)$/.test(calleeName(n) ?? ''))
          ? strLit(n.arguments[0])
          : undefined;
    if (spec !== undefined && refersTo(spec, subjectPath, specPath)) imported = true;
    ts.forEachChild(n, findImports);
  };
  findImports(sf);
  const kinds = new Set(); // every use's kind: one kind is a verdict, two is 'mixed'
  if (imported) kinds.add('executed');
  const aliases = readAliases(sf);
  const textExprs = []; // { name, handle } or { inline }: the file's text, or a handle to it
  for (const lit of lits) {
    const parent = lit.parent;
    // An import/require specifier names the subject but is not a use of it: `imported` already counts it.
    if (parent && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent))) continue;
    if (parent && ts.isCallExpression(parent) && (parent.expression.kind === ts.SyntaxKind.ImportKeyword || /^(require|mock|doMock|module)$/.test(calleeName(parent) ?? ''))) continue;
    const outer = outerPathExpr(lit);
    const sk = shellArgKind(outer);
    if (sk === 'unknown') return 'other';
    if (sk === 'check') continue; // `bash -n <subject>` parses, it does not run
    const direct = argOf(outer);
    if (direct && TITLE_CALLEES.has(calleeName(direct) ?? '') && direct.arguments[0] === outer)
      continue;
    if (direct && isReadCall(direct, aliases)) {
      textExprs.push(readBinding(direct));
      continue;
    }
    const pathVar = declaredName(outer);
    if (!pathVar) {
      if (!spawnedBy(outer)) return 'other';
      kinds.add('executed');
      continue;
    }
    const uses = identifierUses(sf, pathVar);
    if (uses.length === 0) return 'other';
    for (const u of uses) {
      const uk = shellArgKind(u);
      if (uk === 'unknown') return 'other';
      if (uk === 'check') continue;
      const c = argOf(u);
      if (!c || !isReadCall(c, aliases)) {
        if (!spawnedBy(u)) return 'other';
        kinds.add('executed');
        continue;
      }
      textExprs.push(readBinding(c));
    }
  }
  // A handle (`const f = Bun.file(p)`) is text only through `f.text()`. Any other use of it is not.
  const expanded = [];
  for (const t of textExprs) {
    if (!t.handle) {
      expanded.push(t);
      continue;
    }
    const uses = identifierUses(sf, t.name);
    if (uses.length === 0) return 'other';
    for (const u of uses) {
      const read = u.parent;
      const c =
        read &&
        ts.isPropertyAccessExpression(read) &&
        read.expression === u &&
        read.name.text === 'text'
          ? read.parent
          : undefined;
      if (!c || !ts.isCallExpression(c) || c.expression !== read) return 'other';
      expanded.push(readBinding(c));
    }
  }
  let judged = 0;
  for (const t of expanded) {
    if (t.inline) {
      judged++;
      if (!isSubstringUse(t.inline)) return 'other';
      continue;
    }
    for (const u of identifierUses(sf, t.name)) {
      judged++;
      if (!isSubstringUse(u)) return 'other';
    }
  }
  if (judged > 0) kinds.add('text');
  if (kinds.size === 0) return 'other';
  return kinds.size === 1 ? [...kinds][0] : 'mixed';
}

/**
 * Is the (spec, subject) pair a pure source-text substring/regex check? (`classifyPair === 'text'`.)
 * @param {string} specSource
 * @param {string} subjectPath repo-relative subject path
 */
export function isTextOnlyPair(specSource, subjectPath) {
  return classifyPair(specSource, subjectPath) === 'text';
}

/** The spec a classifyPair call is given when the caller does not say where it lives (tests/ is the usual home). */
const SPEC_DEFAULT = 'tests/spec.test.ts';
/** Extensions a relative module specifier may leave off (mirrors what node, bun and tsc resolve). */
const MODULE_EXTS = ['', '.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.sh'];

/**
 * The repo paths a relative specifier can name, resolved from the SPEC's directory: the file as written, with
 * each extension, or an index file in that directory. A bare specifier (a package) names no repo file.
 */
function specifierTargets(spec, specPath) {
  const t = posix.normalize(posix.join(posix.dirname(specPath), spec));
  return [...MODULE_EXTS.map((e) => t + e), ...MODULE_EXTS.slice(1).map((e) => `${t}/index${e}`)];
}

/**
 * Does one path literal in a spec name the subject? A relative literal names it only when it RESOLVES (from the
 * spec's directory) to the subject's repo path, so '../other/render' does not name scripts/lib/render.mjs. A
 * non-relative literal names it when it is the subject's repo path, its bare file name, or a path suffix of it.
 */
function refersTo(lit, subjectPath, specPath = SPEC_DEFAULT) {
  if (lit.startsWith('./') || lit.startsWith('../')) {
    return specifierTargets(lit, specPath).includes(subjectPath);
  }
  return lit === subjectPath || lit === subjectPath.split('/').pop() || subjectPath.endsWith(`/${lit}`);
}

/**
 * Does a spec name the subject at all? Its bare file name must appear on a path boundary (not as the tail of
 * '../other/render.mjs' or 'data.mjs'), or its full repo path must appear, or a quoted literal must refer to it.
 * A spec that does not name a subject does not attribute it (see subjectAttribution).
 */
export function namesSubject(specSource, subjectPath, specPath = SPEC_DEFAULT) {
  const base = subjectPath.split('/').pop();
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (specSource.includes(subjectPath)) return true;
  if (new RegExp(`(?<![\\w./-])${esc(base)}(?![\\w-])`).test(specSource)) return true;
  for (const m of specSource.matchAll(/(['"`])([^'"`\n]*)\1/g)) {
    if (refersTo(m[2], subjectPath, specPath)) return true;
  }
  return false;
}

/**
 * How each subject of a prover is caught, from the specs that name it (see the header).
 * @param {string} proverSource
 * @param {(specPath: string) => string | undefined} readSpec
 * @returns {Map<string, {path: string, kind: 'text' | 'executed' | 'unattributed'}>}
 */
export function subjectAttribution(proverSource, readSpec) {
  const out = new Map();
  const subjects = proverSubjectPaths(proverSource);
  if (subjects.size === 0) return out;
  const specs = referencedSpecs(proverSource)
    .map((p) => ({ p, text: readSpec(p) }))
    .filter((x) => typeof x.text === 'string');
  for (const [key, path] of subjects) {
    // A spec names the subject only by a path that resolves to it (see namesSubject); the verdict uses the same path.
    const verdicts = specs
      .filter((x) => namesSubject(x.text, path, x.p))
      .map((x) => classifyPair(x.text, path, x.p));
    let kind = 'unattributed';
    if (verdicts.length > 0 && verdicts.every((v) => v === 'text')) kind = 'text';
    else if (verdicts.length > 0 && verdicts.every((v) => v === 'executed')) kind = 'executed';
    out.set(key, { path, kind });
  }
  return out;
}

/**
 * Subject keys of a prover whose catching spec(s) only do a substring/regex match on the file.
 * @param {string} proverSource
 * @param {(specPath: string) => string | undefined} readSpec
 * @returns {Map<string, string>} key -> subject path
 */
export function textOnlySubjects(proverSource, readSpec) {
  const out = new Map();
  for (const [key, { path, kind }] of subjectAttribution(proverSource, readSpec)) {
    if (kind === 'text') out.set(key, path);
  }
  return out;
}

/** Subject keys named in a top-level `const WIRING_SUBJECTS = [...]`. */
export function declaredWiringSubjects(proverSource) {
  const sf = parse('prover.mjs', proverSource, ts.ScriptKind.JS);
  const out = new Set();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (
        ts.isIdentifier(d.name) &&
        d.name.text === 'WIRING_SUBJECTS' &&
        d.initializer &&
        ts.isArrayLiteralExpression(d.initializer)
      ) {
        for (const e of d.initializer.elements) {
          const s = strLit(e);
          if (s) out.add(s);
        }
      }
    }
  }
  return out;
}

/** Does the local helper `name` build rows carrying `kind: 'wiring'`? (A name alone proves nothing.) */
function helperSetsWiringKind(sf, name) {
  let found = false;
  const visit = (n) => {
    const decl =
      (ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === name &&
        n.initializer) ||
      (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body);
    if (decl) {
      const scan = (m) => {
        if (
          ts.isPropertyAssignment(m) &&
          (ts.isIdentifier(m.name) ? m.name.text : strLit(m.name)) === 'kind' &&
          strLit(m.initializer) === 'wiring'
        ) {
          found = true;
        }
        ts.forEachChild(m, scan);
      };
      scan(decl);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/**
 * Rows targeting each subject key, with whether each carries the wiring label.
 * Recognised shapes: object literal `{ subject: 'K', kind?: 'wiring' }`, and a positional call
 * `fn(id, 'K', ...)` (labelled iff `fn` is named like `wiring*` and sets `kind: 'wiring'`).
 * @returns {Map<string, {total: number, labelled: number}>}
 */
export function rowsBySubject(proverSource) {
  const sf = parse('prover.mjs', proverSource, ts.ScriptKind.JS);
  const out = new Map();
  const add = (k, labelled) => {
    const e = out.get(k) ?? { total: 0, labelled: 0 };
    e.total++;
    if (labelled) e.labelled++;
    out.set(k, e);
  };
  const visit = (n) => {
    if (ts.isObjectLiteralExpression(n)) {
      let subject;
      let kind;
      for (const p of n.properties) {
        if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
        const name = p.name && (ts.isIdentifier(p.name) ? p.name.text : strLit(p.name));
        if (name === 'subject' && ts.isPropertyAssignment(p)) subject = strLit(p.initializer);
        if (name === 'kind' && ts.isPropertyAssignment(p)) kind = strLit(p.initializer);
      }
      if (subject !== undefined) add(subject, kind === 'wiring');
    } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.arguments.length >= 4) {
      const k = strLit(n.arguments[1]);
      if (
        k !== undefined &&
        strLit(n.arguments[0]) !== undefined &&
        !/^(resolve|join)$/.test(n.expression.text)
      ) {
        add(k, /wiring/i.test(n.expression.text) && helperSetsWiringKind(sf, n.expression.text));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Findings for one prover: text-only subjects with unlabelled rows.
 * @returns {string[]}
 */
export function auditWiringLabels(proverSource, readSpec) {
  const findings = [];
  const declared = declaredWiringSubjects(proverSource);
  const rows = rowsBySubject(proverSource);
  for (const [key, path] of textOnlySubjects(proverSource, readSpec)) {
    if (declared.has(key)) continue;
    const r = rows.get(key);
    if (r && r.total > 0 && r.labelled === r.total) continue;
    findings.push(
      `subject '${key}' (${path}) is only substring/regex-matched by its spec, so its rows are WIRING rows` +
        ` but are not labelled (${r ? `${r.labelled}/${r.total} rows carry kind: 'wiring'` : 'no rows found'}); ` +
        `label each row \`kind: 'wiring'\` (or use a wiring* row helper), or list '${key}' in WIRING_SUBJECTS`,
    );
  }
  return findings;
}

/**
 * One prover's rows, split by what they can prove. A row is WIRING when its subject is text-only
 * (or declared in WIRING_SUBJECTS), or when it carries the label. An unlabelled row is BEHAVIOURAL
 * only when every spec naming its subject executes it. Every other unlabelled row is UNATTRIBUTED:
 * the row cannot be tied to one spec, so it is reported apart and never counted as behavioural.
 * A self-declared label only ever moves a row to wiring, so it cannot inflate the behavioural count.
 * @returns {{total: number, wiring: number, behavioural: number, unattributed: number}}
 */
export function summarizeProverRows(proverSource, readSpec) {
  const attribution = subjectAttribution(proverSource, readSpec);
  const declared = declaredWiringSubjects(proverSource);
  let total = 0;
  let wiring = 0;
  let behavioural = 0;
  let unattributed = 0;
  for (const [key, r] of rowsBySubject(proverSource)) {
    total += r.total;
    const kind = declared.has(key) ? 'text' : (attribution.get(key)?.kind ?? 'unattributed');
    if (kind === 'text') {
      wiring += r.total;
      continue;
    }
    wiring += r.labelled;
    const unlabelled = r.total - r.labelled;
    if (kind === 'executed') behavioural += unlabelled;
    else unattributed += unlabelled;
  }
  return { total, wiring, behavioural, unattributed };
}

// CLI: `node scripts/lib/prover-wiring-lint.mjs`. Prints each prover's row split and exits 1 on any
// unlabelled text-only row (every finding is printed to stderr).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const readSpec = (rel) => {
    const p = resolve(REPO_ROOT, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  };
  let failed = false;
  for (const f of readdirSync(resolve(REPO_ROOT, 'scripts'))
    .filter((n) => /^mutation-prove-.*\.mjs$/.test(n))
    .sort()) {
    const rel = `scripts/${f}`;
    const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    const s = summarizeProverRows(src, readSpec);
    console.log(
      `${rel}: total ${s.total}, wiring ${s.wiring}, behavioural ${s.behavioural}, unattributed ${s.unattributed}`,
    );
    for (const finding of auditWiringLabels(src, readSpec)) {
      console.error(`${rel}: ${finding}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}
