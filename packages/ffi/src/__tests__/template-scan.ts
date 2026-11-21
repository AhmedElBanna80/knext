/**
 * A scanner for the template literals of a generated module, so a test can say something about EVERY
 * interpolation in a message instead of the ones somebody remembered to list.
 *
 * It reads TypeScript source text and knows just enough of the grammar to not be fooled by what the
 * generated loader contains: single- and double-quoted strings, comments, regular-expression literals,
 * and template literals nested inside the `${...}` of another. It does not parse expressions; it only
 * finds where each one starts and ends.
 */

export interface TemplateLiteral {
  /** The literal as written, backticks included. */
  readonly text: string;
  /** The 1-based line it starts on. */
  readonly line: number;
  /** The source of every `${...}` in it, those of templates nested in an interpolation included. */
  readonly exprs: readonly string[];
}

/** Every outermost template literal in `source`, with the interpolations inside it. */
export function templateLiterals(source: string): TemplateLiteral[] {
  const out: TemplateLiteral[] = [];
  let i = 0;
  let collect: string[] = [];

  const skipString = (quote: string): void => {
    i++;
    while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
    i++;
  };
  const skipRegex = (): void => {
    i++;
    let inClass = false;
    while (i < source.length) {
      const ch = source[i] as string;
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
      i++;
    }
    i++;
  };
  // A slash starts a regular expression, not a division, after one of these.
  const regexAllowed = (): boolean => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(source[j] as string)) j--;
    return (
      j < 0 ||
      '(,=:[!&|?{};'.includes(source[j] as string) ||
      /\breturn$/.test(source.slice(0, j + 1))
    );
  };
  const comment = (): boolean => {
    if (source[i] !== '/') return false;
    if (source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      return true;
    }
    if (source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 2;
      return true;
    }
    return false;
  };
  // Scan up to the unmatched closing brace of an interpolation, which is left at i.
  const expression = (): void => {
    let depth = 0;
    while (i < source.length) {
      const ch = source[i] as string;
      if (ch === '`') template();
      else if (ch === "'" || ch === '"') skipString(ch);
      else if (comment()) continue;
      else if (ch === '/' && regexAllowed()) skipRegex();
      else if (ch === '{') {
        depth++;
        i++;
      } else if (ch === '}') {
        if (depth === 0) return;
        depth--;
        i++;
      } else i++;
    }
  };
  // The backtick at i opens a template literal; leave i after the one that closes it.
  const template = (): void => {
    i++;
    while (i < source.length && source[i] !== '`') {
      if (source[i] === '\\') {
        i += 2;
      } else if (source[i] === '$' && source[i + 1] === '{') {
        const start = i + 2;
        i = start;
        expression();
        collect.push(source.slice(start, i));
        i++;
      } else i++;
    }
    i++;
  };

  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '`') {
      const start = i;
      collect = [];
      template();
      out.push({
        text: source.slice(start, i),
        line: source.slice(0, start).split('\n').length,
        exprs: collect,
      });
    } else if (ch === "'" || ch === '"') skipString(ch);
    else if (comment()) continue;
    else if (ch === '/' && regexAllowed()) skipRegex();
    else i++;
  }
  return out;
}

/** The index of the parenthesis that closes the one at `open`, or -1. Strings are skipped. */
function closeOf(expr: string, open: number): number {
  let depth = 0;
  for (let i = open; i < expr.length; i++) {
    const ch = expr[i] as string;
    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < expr.length && expr[i] !== ch) i += expr[i] === '\\' ? 2 : 1;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Whether the whole expression is one call of `fn(...)`: the call must end the expression. */
export function isCallOf(expr: string, fn: string): boolean {
  const e = expr.trim();
  return e.startsWith(`${fn}(`) && closeOf(e, fn.length) === e.length - 1;
}

/**
 * Whether the expression can only ever print text written in the source: every value it can
 * yield is a string literal (`a ? 'x' : b ? 'y' : 'z'`). What the conditions test does not matter.
 */
export function isStaticChoice(expr: string): boolean {
  let placeholder = '';
  const e = expr.trim();
  for (let i = 0; i < e.length; i++) {
    const ch = e[i] as string;
    if (ch === "'" || ch === '"') {
      i++;
      while (i < e.length && e[i] !== ch) i += e[i] === '\\' ? 2 : 1;
      placeholder += 'S';
    } else placeholder += ch;
  }
  return /^(?:[^?:`]+ \? S : )*S$/.test(placeholder);
}
