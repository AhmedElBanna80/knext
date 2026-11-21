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
 * - every argument of a call that prints or raises (a "sink"): any `new XError(...)` or `XError(...)`
 *   (`Error`, `TypeError`, `RangeError`, `FfiLoadError`, `RustError`, `RustPanicError`...), an alias
 *   of one (`const E = FfiLoadError`, `class Sub extends RustError`), `Reflect.construct(<sink>,
 *   [...])` (the array's elements), `console.log/info/debug/warn/error(...)`,
 *   `process.stderr.write(...)`, `process.stdout.write(...)`, `process.emitWarning(...)`,
 *   `Bun.write(Bun.stderr | Bun.stdout, ...)` (what follows the stream) and `bad.push(...)` (the list
 *   of failing directories a refusal prints), so a bare variable handed to one of them is a leaf too;
 * - the same calls under another spelling: `console['warn'](p)`, a name bound to one (`const w =
 *   console.warn`, `const log = w`, `console.error.bind(console)`) or destructured from its object
 *   (`const { warn } = console`, `const { warn: w } = console`);
 * - the right-hand side of an assignment to a `.message`;
 * - the arguments a function declares as text-bearing (`PARAM_SINKS`: `$openFile`'s second and fourth,
 *   which it puts into its refusals), checked at every call, so the function itself needs no
 *   allowance for them.
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

/** A raising or printing call the scan recognised. */
export interface SinkCall {
  /** The top-level function, class or variable it is in. */
  readonly fn: string;
  /** What is called (`FfiLoadError`, `console.warn`, an alias such as `E`). */
  readonly callee: string;
  /** The 1-based line it is on. */
  readonly line: number;
}

/** What a call must be named to count as printing or raising, besides anything ending in `Error`. */
const SINKS = new Set([
  'console.log',
  'console.info',
  'console.debug',
  'console.warn',
  'console.error',
  'process.stderr.write',
  'process.stdout.write',
  'process.emitWarning',
  'bad.push',
]);

/**
 * Calls that print only when their first argument is a stream: `Bun.write(Bun.stderr, text)` writes
 * `text` there, so what follows the stream is what reaches a reader.
 */
const STREAM_WRITERS = new Set(['Bun.write']);
const STREAMS = /^(?:Bun\.(?:stderr|stdout)|process\.std(?:err|out))$/;

/** Any error class: `Error`, `TypeError`, `FfiLoadError`... (a `new` of one, or a call of one). */
const ERROR_CLASS = /^(?:[A-Za-z_$][\w$]*\.)*[\w$]*Error$/;

/**
 * A function whose arguments (by position) become message text inside it. At every call of it those
 * arguments are leaves; inside it, the parameter at that position is covered by the call sites.
 * `$openFile(path, what, lib, missing)`: `what` is spliced into its refusals, `missing` is the refusal
 * for an absent file, raised as it is.
 */
const PARAM_SINKS: Record<string, readonly number[]> = { $openFile: [1, 3] };

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

const parse = (source: string) =>
  ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** The top-level function, class or variable `node` is inside. */
const ownerOf = (node: ts.Node): string => {
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

/** What is called, with `a['b']` and `a["b"]` read as `a.b`, so a spelling does not hide a sink. */
const calleeText = (e: ts.Expression, sf: ts.SourceFile): string => {
  const u = unwrap(e);
  if (ts.isPropertyAccessExpression(u)) return `${calleeText(u.expression, sf)}.${u.name.text}`;
  if (ts.isElementAccessExpression(u) && ts.isStringLiteralLike(u.argumentExpression)) {
    return `${calleeText(u.expression, sf)}.${u.argumentExpression.text}`;
  }
  return collapse(u.getText(sf));
};

/** The function a binding is given, with `.bind(...)` looked through: `console.warn.bind(console)` is `console.warn`. */
const boundName = (init: ts.Expression, sf: ts.SourceFile): string => {
  const u = unwrap(init);
  if (ts.isCallExpression(u)) {
    const callee = calleeText(u.expression, sf);
    if (callee.endsWith('.bind')) return callee.slice(0, -'.bind'.length);
  }
  return calleeText(u, sf);
};

/** `Bun.write(Bun.stderr, a, b)`: the arguments after the stream, or undefined when it is not a write to one. */
const streamWriteArgs = (
  callee: string,
  args: readonly ts.Expression[],
  sf: ts.SourceFile,
): readonly ts.Expression[] | undefined =>
  STREAM_WRITERS.has(callee) && args[0] && STREAMS.test(calleeText(args[0], sf))
    ? args.slice(1)
    : undefined;

/**
 * The names that raise or print: every error class by name, every sink by its dotted name, plus every
 * name bound to one (`const E = FfiLoadError`, `class Sub extends RustError`, `const w = console.warn`,
 * `const { warn } = console`), to a fixed point so an alias of an alias counts.
 */
const sinkNames = (sf: ts.SourceFile): Set<string> => {
  const names = new Set<string>();
  const isSinkName = (text: string) => SINKS.has(text) || ERROR_CLASS.test(text) || names.has(text);
  let grew = true;
  while (grew) {
    grew = false;
    const add = (name: string) => {
      if (!names.has(name)) {
        names.add(name);
        grew = true;
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
        node.heritageClauses?.some(
          (h) =>
            h.token === ts.SyntaxKind.ExtendsKeyword &&
            h.types.some((t) => isSinkName(collapse(t.expression.getText(sf)))),
        )
      ) {
        if (node.name) add(node.name.text);
        else if (
          ts.isVariableDeclaration(node.parent) &&
          ts.isIdentifier(node.parent.name) &&
          node.parent.initializer === node
        ) {
          add(node.parent.name.text);
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isSinkName(boundName(node.initializer, sf))
      ) {
        add(node.name.text);
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer
      ) {
        const base = boundName(node.initializer, sf);
        for (const el of node.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const prop =
            el.propertyName && ts.isIdentifier(el.propertyName)
              ? el.propertyName.text
              : el.name.text;
          if (isSinkName(`${base}.${prop}`)) add(el.name.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return names;
};

/** Every raising and printing call in `source`, in source order. */
export function sinkCalls(source: string): SinkCall[] {
  const sf = parse(source);
  const names = sinkNames(sf);
  const out: SinkCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const callee = calleeText(node.expression, sf);
      if (
        SINKS.has(callee) ||
        ERROR_CLASS.test(callee) ||
        names.has(callee) ||
        streamWriteArgs(callee, node.arguments ?? [], sf) !== undefined
      ) {
        out.push({
          fn: ownerOf(node),
          callee,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every value in `source` that reaches text without going through `$show`, in source order. */
export function leaves(source: string): Leaf[] {
  const sf = parse(source);
  const names = sinkNames(sf);
  const isSink = (callee: string) =>
    SINKS.has(callee) || ERROR_CLASS.test(callee) || names.has(callee);
  const found = new Map<number, Leaf>();

  // The parameter names a PARAM_SINKS function takes its text through, by function.
  const covered = new Map<string, Set<string>>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.name.text in PARAM_SINKS) {
      const at = PARAM_SINKS[stmt.name.text] as readonly number[];
      covered.set(
        stmt.name.text,
        new Set(
          at.flatMap((i) => {
            const p = stmt.parameters[i];
            return p && ts.isIdentifier(p.name) ? [p.name.text] : [];
          }),
        ),
      );
    }
  }

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
      const fn = ownerOf(l);
      // A parameter a PARAM_SINKS function takes its text through: its callers are scanned instead.
      if (ts.isIdentifier(l) && covered.get(fn)?.has(l.text)) continue;
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
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) &&
      ((ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'message') ||
        (ts.isElementAccessExpression(node.left) &&
          ts.isStringLiteralLike(node.left.argumentExpression) &&
          node.left.argumentExpression.text === 'message'))
    ) {
      record(node.right);
    } else if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const callee = calleeText(node.expression, sf);
      const args = node.arguments ?? [];
      const streamed = streamWriteArgs(callee, args, sf);
      if (isSink(callee)) {
        for (const arg of args) record(arg);
      } else if (streamed) {
        for (const arg of streamed) record(arg);
      } else if (
        callee === 'Reflect.construct' &&
        args[0] &&
        isSink(collapse(args[0].getText(sf)))
      ) {
        const list = args[1] && unwrap(args[1]);
        if (list && ts.isArrayLiteralExpression(list)) for (const el of list.elements) record(el);
        else if (args[1]) record(args[1]); // an array it cannot see into is a leaf as a whole
      } else if (callee in PARAM_SINKS) {
        for (const i of PARAM_SINKS[callee] as readonly number[]) {
          const arg = args[i];
          if (arg) record(arg);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found.entries()].sort(([a], [b]) => a - b).map(([, leaf]) => leaf);
}
