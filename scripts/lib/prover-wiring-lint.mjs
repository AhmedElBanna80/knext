/**
 * Lint: a mutation-prover row whose catching spec only does a SOURCE-TEXT match on the
 * subject is a WIRING row, and must say so.
 *
 * Why. A row is only as strong as the spec that must go red for it. When that spec reads the
 * subject file and asserts `toContain` / `toMatch` / `includes` / `indexOf` / `match` on the raw
 * text, the row proves the text is present, not what the code DOES. That is a legitimate
 * guarantee (a call is wired in the right phase) but it must be labelled, so nobody reads a
 * green wiring row as behavioural proof.
 *
 * The label is explicit and read from the prover source (never inferred from a row's wording):
 *   - row level:  an object literal `{ subject: 'K', kind: 'wiring', ... }`, or a positional
 *                 row built by a callee named like `wiring*` (e.g. `wiringRow('WR1', 'K', ...)`);
 *   - prover level: a top-level `const WIRING_SUBJECTS = ['K', ...]` naming subject keys whose
 *                 every row is wiring (used where rows are generated or the table is positional).
 *
 * HEURISTIC (documented limits, see `textOnlySubjects`). For each (prover, referenced spec,
 * subject file) the spec is parsed and every string literal equal to, or ending in `/`, the
 * subject's base name is classified by walking up through `resolve`/`join`/`new URL`:
 *   - the path (or a const holding it) reaches `readFileSync`/`readFile`/`read*`: a TEXT READ;
 *   - it is a describe/it/test title: ignored;
 *   - anything else (spawned, sourced, imported, passed on): EXECUTED.
 * The pair is text-only iff there is at least one text read, no executed occurrence, and every
 * use of the text variable is a substring/regex assertion or method (`expect(v).toContain`/
 * `toMatch`, `v.includes`/`indexOf`/`match`/`search`/`test`/`slice`/`split`). Text passed to anything else
 * (a parser, a helper) is not a substring match and is not flagged. This is deliberately
 * conservative: it can miss a text-only row (false negative) but a flagged pair is genuinely
 * a substring-only check. A subject named only via a path variable defined in another module
 * is not seen.
 */
import ts from 'typescript';
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
]);
const SUBSTRING_MATCHERS = new Set(['toContain', 'toMatch', 'toContainEqual', 'toInclude']);

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}
const isReadCall = (n) =>
  (ts.isCallExpression(n) || ts.isNewExpression(n)) &&
  /^(readFile|read[A-Z_]|read$)/.test(calleeName(n) ?? '');

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
      const isDecl = p && ts.isVariableDeclaration(p) && p.name === n;
      const isKey = p && ts.isPropertyAccessExpression(p) && p.name === n;
      if (!isDecl && !isKey) uses.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return uses;
}

/** Is this use of the text variable (or inline read) a pure substring/regex assertion? */
function isSubstringUse(use) {
  const p = use.parent;
  // v.includes(...) / v.indexOf(...) / v.match(...)
  if (
    p &&
    ts.isPropertyAccessExpression(p) &&
    p.expression === use &&
    SUBSTRING_METHODS.has(p.name.text)
  ) {
    return true;
  }
  // expect(v).[not.]toContain(...)
  const call = argOf(use);
  if (call && ts.isIdentifier(call.expression) && call.expression.text === 'expect') {
    let cur = call.parent;
    while (cur && ts.isPropertyAccessExpression(cur)) {
      if (SUBSTRING_MATCHERS.has(cur.name.text)) return true;
      cur = cur.parent;
    }
  }
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
 * Is the (spec, subject base name) pair a pure source-text substring/regex check?
 * @param {string} specSource
 * @param {string} subjectPath repo-relative subject path
 */
export function isTextOnlyPair(specSource, subjectPath) {
  const base = subjectPath.split('/').pop();
  const sf = parse('spec.ts', specSource, ts.ScriptKind.TS);
  const lits = [];
  const collect = (n) => {
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      (n.text === base || n.text.endsWith(`/${base}`))
    ) {
      lits.push(n);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  // An import / require of the subject (any extension spelling) means the spec EXECUTES it.
  const stem = base.replace(/\.[^.]+$/, '');
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
    if (spec !== undefined) {
      const last = spec.split('/').pop();
      if (last === base || last === stem) imported = true;
    }
    ts.forEachChild(n, findImports);
  };
  findImports(sf);
  if (imported) return false;
  let reads = 0;
  const textExprs = []; // identifiers or inline read calls holding the file text
  for (const lit of lits) {
    const outer = outerPathExpr(lit);
    const direct = argOf(outer);
    if (direct && TITLE_CALLEES.has(calleeName(direct) ?? '') && direct.arguments[0] === outer)
      continue;
    if (direct && isReadCall(direct)) {
      reads++;
      const v = declaredName(direct);
      textExprs.push(v ? { name: v } : { inline: direct });
      continue;
    }
    const pathVar = declaredName(outer);
    if (!pathVar) return false; // spawned, sourced, imported, passed on: executed
    const uses = identifierUses(sf, pathVar);
    if (uses.length === 0) return false;
    for (const u of uses) {
      const c = argOf(u);
      if (!c || !isReadCall(c)) return false; // used for anything but a text read
      reads++;
      const v = declaredName(c);
      textExprs.push(v ? { name: v } : { inline: c });
    }
  }
  if (reads === 0) return false;
  let judged = 0;
  for (const t of textExprs) {
    if (t.inline) {
      judged++;
      if (!isSubstringUse(t.inline)) return false;
      continue;
    }
    for (const u of identifierUses(sf, t.name)) {
      judged++;
      if (!isSubstringUse(u)) return false;
    }
  }
  return judged > 0;
}

/**
 * Subject keys of a prover whose catching spec(s) only do a substring/regex match on the file.
 * @param {string} proverSource
 * @param {(specPath: string) => string | undefined} readSpec
 * @returns {Map<string, string>} key -> subject path
 */
export function textOnlySubjects(proverSource, readSpec) {
  const out = new Map();
  const subjects = proverSubjectPaths(proverSource);
  if (subjects.size === 0) return out;
  const specs = referencedSpecs(proverSource)
    .map((s) => readSpec(s))
    .filter((s) => typeof s === 'string');
  if (specs.length === 0) return out;
  for (const [key, path] of subjects) {
    // The subject is text-only only if EVERY spec that mentions it checks it as text.
    const mentioning = specs.filter((s) => s.includes(path.split('/').pop()));
    if (mentioning.length > 0 && mentioning.every((s) => isTextOnlyPair(s, path)))
      out.set(key, path);
  }
  return out;
}

const strLit = (n) =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;

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

/**
 * Rows targeting each subject key, with whether each carries the wiring label.
 * Recognised shapes: object literal `{ subject: 'K', kind?: 'wiring' }`, and a positional call
 * `fn(id, 'K', ...)` (labelled iff `fn` is named like `wiring*`).
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
        add(k, /wiring/i.test(n.expression.text));
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
