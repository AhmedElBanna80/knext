/**
 * A scan of the generated module for every value that can reach a printed message, so a test can say
 * something about EVERY interpolation and concatenation instead of the ones somebody remembered to
 * list.
 *
 * It parses the source with the TypeScript compiler (so strings, comments, regular expressions and
 * templates nested in templates are never mistaken for each other) and reports each "leaf": a value
 * that ends up in text without going through `$show`. A leaf is found in
 *
 * - every `${...}` of every template literal (whatever the template says: nothing is filtered by its
 *   text, so a message that does not start with `knext ffi:` is scanned like any other);
 * - every `+` chain that has a string or a template among its operands (`'text ' + path`);
 * - every argument of a call that prints or raises: `new FfiLoadError(...)`, `new Error(...)`,
 *   `new RustError(...)`, `new RustPanicError(...)`, `console.warn(...)`, `console.error(...)` and
 *   `bad.push(...)` (the list of failing directories a refusal prints), so a bare variable handed to
 *   one of them is a leaf too.
 *
 * A conditional or a `||`/`&&`/`??` is looked through to the values it can yield. A string literal, a
 * template (its own interpolations are leaves of their own) and a call of `$show(...)` are not leaves.
 * Each leaf is keyed by the top-level function it is in and the text of the expression, so what a
 * test allows is allowed in ONE function, not everywhere the same name appears.
 */
import ts from 'typescript';

export interface Leaf {
  /** The top-level function, class or variable the leaf is in (`<top>` outside one). */
  readonly fn: string;
  /** The expression's source, whitespace collapsed. */
  readonly expr: string;
  /** `fn::expr`: what an allowlist is keyed by. */
  readonly key: string;
  /** The 1-based line it is on. */
  readonly line: number;
}

/** What a call must be named to count as printing or raising. */
const SINKS = new Set([
  'FfiLoadError',
  'Error',
  'RustError',
  'RustPanicError',
  'console.warn',
  'console.error',
  'bad.push',
]);

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Every value in `source` that reaches text without going through `$show`, in source order. */
export function leaves(source: string): Leaf[] {
  const sf = ts.createSourceFile(
    'module.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found = new Map<number, Leaf>();

  const owner = (node: ts.Node): string => {
    let top: ts.Node = node;
    while (top.parent && top.parent.kind !== ts.SyntaxKind.SourceFile) top = top.parent;
    if (ts.isFunctionDeclaration(top) || ts.isClassDeclaration(top)) {
      return top.name?.text ?? '<anonymous>';
    }
    if (ts.isVariableStatement(top)) {
      const decl = top.declarationList.declarations[0];
      return decl && ts.isIdentifier(decl.name) ? decl.name.text : '<top>';
    }
    return '<top>';
  };

  const unwrap = (e: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)
      ? unwrap(e.expression)
      : e;

  const isPlus = (e: ts.Expression): e is ts.BinaryExpression =>
    ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken;

  /** The operands of a `+` chain, left to right. */
  const operands = (e: ts.Expression): ts.Expression[] => {
    const u = unwrap(e);
    return isPlus(u) ? [...operands(u.left), ...operands(u.right)] : [u];
  };

  /** A `+` chain with a string or a template among its operands is a concatenation, not arithmetic. */
  const isConcat = (e: ts.Expression): boolean =>
    isPlus(e) && operands(e).some((o) => ts.isStringLiteralLike(o) || ts.isTemplateExpression(o));

  const collect = (e: ts.Expression, out: ts.Expression[]): void => {
    const u = unwrap(e);
    if (ts.isStringLiteralLike(u) || ts.isTemplateExpression(u)) return; // its spans are leaves of their own
    if (ts.isConditionalExpression(u)) {
      collect(u.whenTrue, out);
      collect(u.whenFalse, out);
      return;
    }
    if (ts.isBinaryExpression(u)) {
      const k = u.operatorToken.kind;
      if (
        (k === ts.SyntaxKind.PlusToken && isConcat(u)) ||
        k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.QuestionQuestionToken ||
        k === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        collect(u.left, out);
        collect(u.right, out);
        return;
      }
    }
    if (ts.isCallExpression(u) && ts.isIdentifier(u.expression) && u.expression.text === '$show') {
      return;
    }
    out.push(u);
  };

  const record = (e: ts.Expression): void => {
    const out: ts.Expression[] = [];
    collect(e, out);
    for (const l of out) {
      const start = l.getStart(sf);
      const expr = collapse(l.getText(sf));
      const fn = owner(l);
      found.set(start, {
        fn,
        expr,
        key: `${fn}::${expr}`,
        line: sf.getLineAndCharacterOfPosition(start).line + 1,
      });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) record(span.expression);
    } else if (ts.isBinaryExpression(node) && isConcat(node)) {
      record(node);
    } else if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      if (SINKS.has(collapse(node.expression.getText(sf)))) {
        for (const arg of node.arguments ?? []) record(arg);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found.entries()].sort(([a], [b]) => a - b).map(([, leaf]) => leaf);
}
