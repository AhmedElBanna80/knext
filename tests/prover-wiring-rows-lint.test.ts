import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import * as LINT_MODULE from '../scripts/lib/prover-wiring-lint.mjs';
import {
  auditWiringLabels,
  baselineRaises,
  classifyPair,
  declaredBaselineRaises,
  declaredWiringSubjects,
  isTextOnlyPair,
  namesSubject,
  rowsBySubject,
  summarizeProverRows,
  textOnlySubjects,
  unattributedRatchet,
} from '../scripts/lib/prover-wiring-lint.mjs';

const ROOT = resolve(import.meta.dir, '..');
const readSpec = (rel: string) => {
  const p = resolve(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
};
const provers = readdirSync(resolve(ROOT, 'scripts'))
  .filter((f) => /^mutation-prove-.*\.mjs$/.test(f))
  .map((f) => `scripts/${f}`);

/**
 * LINT: a prover row whose catching spec only substring/regex-matches the subject's SOURCE TEXT is
 * a WIRING row (it proves a call is present, not what the code does) and must be labelled
 * `kind: 'wiring'` (or built by a `wiring*` helper, or its subject listed in WIRING_SUBJECTS).
 * The heuristic and its limits are documented in scripts/lib/prover-wiring-lint.mjs.
 */
describe('every text-only prover row is labelled as a wiring row', () => {
  it('no prover has an unlabelled source-text row', () => {
    const findings = provers.flatMap((p) =>
      auditWiringLabels(readFileSync(resolve(ROOT, p), 'utf8'), readSpec).map((f) => `${p}: ${f}`),
    );
    expect(findings).toEqual([]);
  });

  it('is not vacuous: the z11 answering-pod run.sh rows are detected and labelled, the lib rows are not text-only', () => {
    const src = readFileSync(
      resolve(ROOT, 'scripts/mutation-prove-s11-1-z11-answering-pod.mjs'),
      'utf8',
    );
    const textOnly = textOnlySubjects(src, readSpec);
    expect([...textOnly.keys()]).toEqual(['run']);
    const rows = rowsBySubject(src);
    const run = rows.get('run');
    expect(run?.total).toBe(18);
    expect(run?.labelled).toBe(18);
    expect(rows.get('lib')?.labelled).toBe(0);
  });
});

const SPEC_TEXT = `
import { readFileSync } from 'node:fs';
const src = readFileSync(resolve(ROOT, 'scripts/thing.sh'), 'utf8');
it('x', () => { expect(src).toContain('foo'); });
`;
const proverWith = (rows: string, extra = '') => `
const SPEC = 'tests/thing.test.ts';
${extra}
const PROOF = { subjects: { thing: 'scripts/thing.sh' } };
const MUTATIONS = [${rows}];
`;
const audit = (prover: string, spec = SPEC_TEXT) => auditWiringLabels(prover, () => spec);

describe('the lint heuristic', () => {
  it('flags an unlabelled row over a substring-only spec', () => {
    const f = audit(proverWith(`{ subject: 'thing', anchor: 'a', replacement: 'b' }`));
    expect(f.length).toBe(1);
    expect(f[0]).toContain("'thing'");
  });
  it('accepts kind: wiring on every row, a wiring helper, and WIRING_SUBJECTS', () => {
    expect(
      audit(proverWith(`{ subject: 'thing', kind: 'wiring', anchor: 'a', replacement: 'b' }`)),
    ).toEqual([]);
    expect(
      audit(
        proverWith(
          `wiringRow('W1', 'thing', 'claim', 'a', 'b')`,
          `const wiringRow = (...a) => ({ ...row(...a), kind: 'wiring' });`,
        ),
      ),
    ).toEqual([]);
    // a helper merely NAMED wiring* that does not set the kind labels nothing
    expect(
      audit(
        proverWith(
          `wiringRow('W1', 'thing', 'claim', 'a', 'b')`,
          `const wiringRow = (...a) => row(...a);`,
        ),
      ).length,
    ).toBe(1);
    expect(
      audit(
        proverWith(
          `{ subject: 'thing', anchor: 'a', replacement: 'b' }`,
          `const WIRING_SUBJECTS = ['thing'];`,
        ),
      ),
    ).toEqual([]);
  });
  it('requires EVERY row of the subject to be labelled (one unlabelled row reds)', () => {
    const rows = `{ subject: 'thing', kind: 'wiring', anchor: 'a', replacement: 'b' }, { subject: 'thing', anchor: 'c', replacement: 'd' }`;
    expect(audit(proverWith(rows)).length).toBe(1);
  });
  it('a kind other than wiring does not count', () => {
    expect(
      audit(proverWith(`{ subject: 'thing', kind: 'behavioural', anchor: 'a', replacement: 'b' }`))
        .length,
    ).toBe(1);
  });
  it('does not flag a spec that EXECUTES the subject', () => {
    const spec = `
      const p = resolve(ROOT, 'scripts/thing.sh');
      spawnSync('bash', [p]);
      const src = readFileSync(p, 'utf8'); expect(src).toContain('foo');`;
    expect(audit(proverWith(`{ subject: 'thing', anchor: 'a', replacement: 'b' }`), spec)).toEqual(
      [],
    );
  });
  it('does not flag a spec that imports the subject under any extension spelling', () => {
    const spec = `
      const src = readFileSync(resolve(ROOT, 'scripts/thing.sh'), 'utf8'); expect(src).toContain('foo');
      const mod = await import('../scripts/thing');`;
    expect(isTextOnlyPair(spec, 'scripts/thing.sh')).toBe(false);
  });
  it('does not flag text that is parsed or handed to a helper (not a substring match)', () => {
    const spec = `const src = readFileSync(resolve(ROOT, 'scripts/thing.sh'), 'utf8'); const t = parseIt(src); expect(t).toBeTruthy();`;
    expect(isTextOnlyPair(spec, 'scripts/thing.sh')).toBe(false);
  });
  it('treats string-method text analysis (indexOf/slice/split) as text-only, and describe titles as neutral', () => {
    const spec = `
      const src = readFileSync(resolve(ROOT, 'scripts/thing.sh'), 'utf8');
      describe('wiring: thing.sh calls it', () => { const i = src.indexOf('x'); expect(src.slice(i)).toBeTruthy(); });`;
    expect(isTextOnlyPair(spec, 'scripts/thing.sh')).toBe(true);
  });
  it('reads the label from the prover source, not from a row claim or a comment', () => {
    const rows = `{ subject: 'thing', claim: "kind: 'wiring'", anchor: 'a', replacement: 'b' } // kind: 'wiring'`;
    expect(audit(proverWith(rows)).length).toBe(1);
    expect(declaredWiringSubjects(`// const WIRING_SUBJECTS = ['thing'];\n`).size).toBe(0);
  });
  it('a text read whose text is never asserted on is not a substring check (no judged use)', () => {
    const spec = `const src = readFileSync(resolve(ROOT, 'scripts/thing.sh'), 'utf8');`;
    expect(isTextOnlyPair(spec, 'scripts/thing.sh')).toBe(false);
  });
  it('a subject only named in a describe title is not text-only (no read at all)', () => {
    expect(isTextOnlyPair(`describe('scripts/thing.sh', () => {});`, 'scripts/thing.sh')).toBe(
      false,
    );
  });
  it('an exact-path describe title is neutral, it neither reads nor executes the subject', () => {
    const spec = `
      const src = readFileSync(resolve(ROOT, 'scripts/thing.sh'), 'utf8');
      describe('scripts/thing.sh', () => { it('x', () => { expect(src).toContain('foo'); }); });`;
    expect(isTextOnlyPair(spec, 'scripts/thing.sh')).toBe(true);
  });
  it('EVERY referencing spec must be text-only: one executing spec clears the subject', () => {
    const prover = `
      const A = 'tests/thing.test.ts';
      const B = 'tests/thing2.test.ts';
      const PROOF = { subjects: { thing: 'scripts/thing.sh' } };
      const MUTATIONS = [{ subject: 'thing', anchor: 'a', replacement: 'b' }];`;
    const execSpec = `const p = resolve(ROOT, 'scripts/thing.sh'); spawnSync('bash', [p]);`;
    const specs: Record<string, string> = {
      'tests/thing.test.ts': SPEC_TEXT,
      'tests/thing2.test.ts': execSpec,
    };
    expect(auditWiringLabels(prover, (s: string) => specs[s])).toEqual([]);
    specs['tests/thing2.test.ts'] = SPEC_TEXT;
    expect(auditWiringLabels(prover, (s: string) => specs[s]).length).toBe(1);
  });
});

// TD-S12-5a (F6): the evasions the per-subject lint let through. Each is a text-only check
// that the lint must now flag, and each `bash -n` case is a syntax check that must NOT count as
// executing the subject.
describe('F6 evasions: text reads and chained string methods are still text-only', () => {
  const P = 'scripts/thing.sh';
  it('flags Bun.file(p).text() followed by a substring check (not an execution)', () => {
    const spec = `const src = await Bun.file(resolve(ROOT, '${P}')).text(); expect(src).toContain('foo');`;
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
  it('flags a path variable read through Bun.file(p).text()', () => {
    const spec = `const p = resolve(ROOT, '${P}'); const src = await Bun.file(p).text(); expect(src).toMatch(/foo/);`;
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
  it('flags an inline Bun.file(p).text() read asserted in place', () => {
    const spec = `expect(await Bun.file(resolve(ROOT, '${P}')).text()).toContain('foo');`;
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
  it('flags a chained string method ending in includes', () => {
    const spec = `const src = readFileSync(resolve(ROOT, '${P}'), 'utf8'); expect(src.toLowerCase().includes('foo')).toBe(true);`;
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
  it('flags src.replace(...) as a text-only rewrite', () => {
    const spec = `const src = readFileSync(resolve(ROOT, '${P}'), 'utf8'); const out = src.replace('a', 'b'); expect(out).toContain('b');`;
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
  it('flags src.replaceAll(...) as a text-only rewrite too', () => {
    const spec = `const src = readFileSync(resolve(ROOT, '${P}'), 'utf8'); const out = src.replaceAll('a', 'b'); expect(out).toContain('b');`;
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
  it('a chained method that ends in neither a substring check nor an assertion is not flagged', () => {
    const spec = `const src = readFileSync(resolve(ROOT, '${P}'), 'utf8'); const n = src.toLowerCase().length;`;
    expect(isTextOnlyPair(spec, P)).toBe(false);
  });
  it('a bash -n syntax check of the subject does NOT clear it (literal path)', () => {
    const spec = `const src = readFileSync(resolve(ROOT, '${P}'), 'utf8'); expect(src).toContain('foo');
      spawnSync('bash', ['-n', resolve(ROOT, '${P}')]);`;
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
  it('a bash -n syntax check through a path variable does NOT clear it', () => {
    const spec = `const p = resolve(ROOT, '${P}'); spawnSync('bash', ['-n', p]);
      const src = readFileSync(p, 'utf8'); expect(src).toContain('foo');`;
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
  it('a spawn WITHOUT -n still executes the subject (the exclusion is exact)', () => {
    const spec = `const p = resolve(ROOT, '${P}'); spawnSync('bash', ['-x', p]);
      const src = readFileSync(p, 'utf8'); expect(src).toContain('foo');`;
    expect(isTextOnlyPair(spec, P)).toBe(false);
  });
  it('a -n argument to a command that is not a shell still executes the subject', () => {
    const spec = `const p = resolve(ROOT, '${P}'); spawnSync(TOOL, ['-n', p]);
      const src = readFileSync(p, 'utf8'); expect(src).toContain('foo');`;
    expect(isTextOnlyPair(spec, P)).toBe(false);
  });
  it('one spec doing bash -n on subject A does not clear unrelated rows on subject B', () => {
    const prover = `
      const SPEC = 'tests/thing.test.ts';
      const PROOF = { subjects: { thing: 'scripts/thing.sh' } };
      const MUTATIONS = [{ subject: 'thing', anchor: 'a', replacement: 'b' }];`;
    const specs: Record<string, string> = {
      'tests/thing.test.ts': `const src = readFileSync(resolve(ROOT, 'scripts/thing.sh'), 'utf8'); expect(src).toContain('x');
        spawnSync('bash', ['-n', resolve(ROOT, 'scripts/thing.sh')]);`,
    };
    expect(auditWiringLabels(prover, (s: string) => specs[s]).length).toBe(1);
  });
});

describe('row-level wiring vs behavioural counts', () => {
  // `thing` is text-only: BOTH its rows are wiring, labelled or not (the unlabelled one is a finding,
  // the count does not depend on the label). `beh` is executed by its own spec: its labelled row is
  // wiring (a self-declared label only ever moves a row to wiring), its other row is behavioural.
  const prover = `
    const SPEC = 'tests/thing.test.ts';
    const SPEC_B = 'tests/beh.test.ts';
    const PROOF = { subjects: { thing: 'scripts/thing.sh', beh: 'scripts/beh.sh' } };
    const MUTATIONS = [
      { subject: 'thing', anchor: 'a', replacement: 'b' },
      { subject: 'thing', kind: 'wiring', anchor: 'g', replacement: 'h' },
      { subject: 'beh', anchor: 'c', replacement: 'd' },
      { subject: 'beh', kind: 'wiring', anchor: 'e', replacement: 'f' },
    ];`;
  const specs: Record<string, string> = {
    'tests/thing.test.ts': SPEC_TEXT,
    'tests/beh.test.ts': `const p = resolve(ROOT, 'scripts/beh.sh'); spawnSync('bash', [p]);`,
  };
  it('reports the wiring, behavioural and unattributed totals separately', () => {
    expect(summarizeProverRows(prover, (s: string) => specs[s])).toEqual({
      total: 4,
      wiring: 3,
      behavioural: 1,
      unattributed: 0,
    });
  });
});

// ITEM 1 (attribution). A row carries no spec field, so a row cannot be tied to the spec that catches
// it. A row is therefore BEHAVIOURAL only when every spec naming its subject executes the subject.
// If any naming spec only reads the text, or the subject is named by no spec, the row is UNATTRIBUTED
// (reported apart, never counted as behavioural). The old count called these behavioural.
describe('attribution: a row is behavioural only when every spec naming its subject executes it', () => {
  const proverFor = (subjectPath: string, specA: string, specB?: string) => `
    const A = 'tests/a.test.ts';
    ${specB === undefined ? '' : "const B = 'tests/b.test.ts';"}
    const PROOF = { subjects: { thing: '${subjectPath}' } };
    const MUTATIONS = [{ subject: 'thing', anchor: 'a', replacement: 'b' }];`;
  const TEXT_SPEC = `const src = readFileSync(resolve(ROOT, 'scripts/thing.sh'), 'utf8'); expect(src).toContain('foo');`;
  const EXEC_SPEC = `const p = resolve(ROOT, 'scripts/thing.sh'); spawnSync('bash', [p]);`;

  it('a subject that a text-only spec AND an executing spec both name is UNATTRIBUTED, not behavioural', () => {
    const specs: Record<string, string> = {
      'tests/a.test.ts': TEXT_SPEC,
      'tests/b.test.ts': EXEC_SPEC,
    };
    expect(
      summarizeProverRows(proverFor('scripts/thing.sh', 'A', 'B'), (s: string) => specs[s]),
    ).toEqual({ total: 1, wiring: 0, behavioural: 0, unattributed: 1 });
  });

  it('a subject that only an executing spec names is behavioural', () => {
    const specs: Record<string, string> = { 'tests/a.test.ts': EXEC_SPEC };
    expect(
      summarizeProverRows(proverFor('scripts/thing.sh', 'A'), (s: string) => specs[s]),
    ).toEqual({
      total: 1,
      wiring: 0,
      behavioural: 1,
      unattributed: 0,
    });
  });

  it('a subject that no referenced spec names is UNATTRIBUTED, never behavioural', () => {
    const specs: Record<string, string> = { 'tests/a.test.ts': `expect(1).toBe(1);` };
    expect(
      summarizeProverRows(proverFor('scripts/thing.sh', 'A'), (s: string) => specs[s]),
    ).toEqual({
      total: 1,
      wiring: 0,
      behavioural: 0,
      unattributed: 1,
    });
  });

  it('a spec that reads the text and hands it to a parser is UNATTRIBUTED (neither text-only nor executed)', () => {
    const specs: Record<string, string> = {
      'tests/a.test.ts': `const src = readFileSync(resolve(ROOT, 'scripts/thing.sh'), 'utf8'); parseIt(src);`,
    };
    expect(
      summarizeProverRows(proverFor('scripts/thing.sh', 'A'), (s: string) => specs[s]),
    ).toEqual({
      total: 1,
      wiring: 0,
      behavioural: 0,
      unattributed: 1,
    });
  });

  it('a labelled row is wiring even when its subject is unattributed', () => {
    const specs: Record<string, string> = { 'tests/a.test.ts': `expect(1).toBe(1);` };
    const p = `
      const A = 'tests/a.test.ts';
      const PROOF = { subjects: { thing: 'scripts/thing.sh' } };
      const MUTATIONS = [{ subject: 'thing', kind: 'wiring', anchor: 'a', replacement: 'b' }];`;
    expect(summarizeProverRows(p, (s: string) => specs[s])).toEqual({
      total: 1,
      wiring: 1,
      behavioural: 0,
      unattributed: 0,
    });
  });
});

// ITEM 2. `bash -n <subject>` is a syntax check only when `-n` (or a flag cluster containing n) comes
// BEFORE the subject. After the subject, `-n` is an argument to the script, and the script runs.
describe('bash -n is a syntax check only when -n precedes the subject', () => {
  const P = 'scripts/thing.sh';
  const tail = `const src = readFileSync(p, 'utf8'); expect(src).toContain('foo');`;
  it('bash <subject> -n runs the subject: NOT a syntax check, so it does not clear the row', () => {
    const spec = `const p = resolve(ROOT, '${P}'); spawnSync('bash', [p, '-n']); ${tail}`;
    expect(isTextOnlyPair(spec, P)).toBe(false);
  });
  it('bash run.sh -n <subject>: a non-flag before the subject means the subject is not the syntax-checked file', () => {
    const spec = `const p = resolve(ROOT, '${P}'); spawnSync('bash', ['run.sh', '-n', p]); ${tail}`;
    expect(isTextOnlyPair(spec, P)).toBe(false);
  });
  it('bash -ne <subject> (a cluster containing n, before the subject) IS a syntax check', () => {
    const spec = `const p = resolve(ROOT, '${P}'); spawnSync('bash', ['-ne', p]); ${tail}`;
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
  it('the Bun.spawn array form: [bash, -n, subject] is a syntax check, [bash, subject, -n] is not', () => {
    expect(
      isTextOnlyPair(`const p = resolve(ROOT, '${P}'); Bun.spawn(['bash', '-n', p]); ${tail}`, P),
    ).toBe(true);
    expect(
      isTextOnlyPair(`const p = resolve(ROOT, '${P}'); Bun.spawn(['bash', p, '-n']); ${tail}`, P),
    ).toBe(false);
  });
});

// ITEM 3. A string method whose RESULT reaches an executing consumer (JSON.parse, a spawn argument,
// eval, a helper) is not a substring check, whatever method produced it.
describe('a slice/split/replace result that reaches an executing consumer is not substring-only', () => {
  const P = 'scripts/thing.sh';
  it('JSON.parse(src.slice(..)) is not text-only', () => {
    const spec = `const src = readFileSync(resolve(ROOT, '${P}'), 'utf8'); const cfg = JSON.parse(src.slice(1)); expect(src).toContain('foo');`;
    expect(isTextOnlyPair(spec, P)).toBe(false);
  });
  it('a spawn argument built with src.replace(...) is not text-only', () => {
    const spec = `const src = readFileSync(resolve(ROOT, '${P}'), 'utf8'); spawnSync('bash', ['-c', src.replace('a', 'b')]); expect(src).toContain('foo');`;
    expect(isTextOnlyPair(spec, P)).toBe(false);
  });
  it('the same result routed through a variable into JSON.parse is not text-only', () => {
    const spec = `const src = readFileSync(resolve(ROOT, '${P}'), 'utf8'); const part = src.split('\\n'); const cfg = JSON.parse(part[0]); expect(src).toContain('foo');`;
    expect(isTextOnlyPair(spec, P)).toBe(false);
  });
  it('a result stored in an object literal (an unrecognised consumer) is not text-only, conservatively', () => {
    const spec = `const src = readFileSync(resolve(ROOT, '${P}'), 'utf8'); const holder = { part: src.slice(1) }; expect(holder.part).toContain('foo');`;
    expect(isTextOnlyPair(spec, P)).toBe(false);
  });
  it('a comparison of a result is a boolean, not an escape: still text-only', () => {
    const spec = `const src = readFileSync(resolve(ROOT, '${P}'), 'utf8'); const same = src.slice(0) === 'x'; expect(same).toBe(true); expect(src).toContain('foo');`;
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
  it('the result asserted on (expect(out).toContain) is still text-only', () => {
    const spec = `const src = readFileSync(resolve(ROOT, '${P}'), 'utf8'); const out = src.replace('a', 'b'); expect(out).toContain('b');`;
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
});

// ITEM 4. A Bun.file handle held in a variable, and a read function aliased to a variable, are text
// reads too.
describe('a Bun.file handle held in a variable, and an aliased read function, are text reads', () => {
  const P = 'scripts/thing.sh';
  it('const f = Bun.file(p); await f.text(); expect(src).toContain(..) is text-only', () => {
    const spec = `const p = resolve(ROOT, '${P}'); const f = Bun.file(p); const src = await f.text(); expect(src).toContain('foo');`;
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
  it('a handle used for anything other than reading its text is not text-only', () => {
    const spec = `const p = resolve(ROOT, '${P}'); const f = Bun.file(p); const n = f.size; expect(n).toBe(3);`;
    expect(isTextOnlyPair(spec, P)).toBe(false);
  });
  it('const rf = readFileSync; rf(p) is a text read', () => {
    const spec = `const rf = readFileSync; const src = rf(resolve(ROOT, '${P}'), 'utf8'); expect(src).toContain('foo');`;
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
});

// ROUND 2 item 1. classifyPair used to return at the FIRST use it judged, so a spec that spawned the subject
// and also substring-checked it was "executed" and its text check was never looked at. Every use is
// classified; a spec with two kinds of use is "mixed", which subjectAttribution leaves unattributed.
describe('a spec that both executes the subject and substring-checks it is mixed (ROUND 2 item 1)', () => {
  const P = 'scripts/thing.sh';
  it('spawnSync(bash, [subject]) plus readFileSync + expect(src).toContain is mixed, not executed', () => {
    const spec = `spawnSync('bash', ['${P}']); const src = readFileSync('${P}', 'utf8'); expect(src).toContain('foo');`;
    expect(classifyPair(spec, P)).toBe('mixed');
  });
  it('an import of the subject plus a substring check is mixed', () => {
    const spec = `import '../${P}'; const src = readFileSync('${P}', 'utf8'); expect(src).toContain('foo');`;
    expect(classifyPair(spec, P)).toBe('mixed');
  });
  it('a spec that ONLY spawns the subject is still executed (no regression)', () => {
    const spec = `spawnSync('bash', ['${P}']);`;
    expect(classifyPair(spec, P)).toBe('executed');
  });
  it('a spec that ONLY substring-checks the subject is still text (no regression)', () => {
    const spec = `const src = readFileSync('${P}', 'utf8'); expect(src).toContain('foo');`;
    expect(classifyPair(spec, P)).toBe('text');
  });
  it('a mixed pair is not text-only, so its rows are not labelled wiring', () => {
    const spec = `spawnSync('bash', ['${P}']); const src = readFileSync('${P}', 'utf8'); expect(src).toContain('foo');`;
    expect(isTextOnlyPair(spec, P)).toBe(false);
  });
});

// ROUND 2 item 2. A bash option that takes an argument (-o pipefail, -O extglob, +o, --rcfile X) must be
// consumed with its argument, so the -n after it still counts as a syntax check. An option this lint cannot
// read makes the use unattributed ('other'), never 'executed'.
describe('bash option arguments are consumed; an unknown option is unattributed (ROUND 2 item 2)', () => {
  const P = 'scripts/thing.sh';
  it('bash -o pipefail -n <subject> is a syntax check: no use, so not executed', () => {
    expect(classifyPair(`spawnSync('bash', ['-o', 'pipefail', '-n', '${P}']);`, P)).not.toBe(
      'executed',
    );
  });
  it('bash -O extglob -n <subject> is a syntax check too', () => {
    expect(classifyPair(`spawnSync('bash', ['-O', 'extglob', '-n', '${P}']);`, P)).not.toBe(
      'executed',
    );
  });
  it('bash +o posix -n <subject> is a syntax check too', () => {
    expect(classifyPair(`spawnSync('bash', ['+o', 'posix', '-n', '${P}']);`, P)).not.toBe(
      'executed',
    );
  });
  it('bash --rcfile X -n <subject> is a syntax check too', () => {
    expect(classifyPair(`spawnSync('bash', ['--rcfile', 'rc', '-n', '${P}']);`, P)).not.toBe(
      'executed',
    );
  });
  it('bash -o pipefail <subject> (no -n) RUNS the subject: executed', () => {
    expect(classifyPair(`spawnSync('bash', ['-o', 'pipefail', '${P}']);`, P)).toBe('executed');
  });
  it('an unknown option before the subject makes the use unattributed, never executed', () => {
    expect(classifyPair(`spawnSync('bash', ['-Z', '${P}']);`, P)).toBe('other');
    expect(classifyPair(`spawnSync('bash', ['--frobnicate', '-n', '${P}']);`, P)).toBe('other');
  });
  it('bash <script> -n <subject>: the first non-option ends the options, so the subject is RUN (executed)', () => {
    expect(classifyPair(`spawnSync('bash', ['x.sh', '-n', '${P}']);`, P)).toBe('executed');
  });
  it('a path handed to a call that neither runs nor reads it is other, not executed', () => {
    expect(classifyPair(`const p = resolve(ROOT, '${P}'); keep(p);`, P)).toBe('other');
  });
  it('a dangling option argument (-o with nothing before the subject) is unattributed, not a silent skip', () => {
    expect(classifyPair(`spawnSync('bash', ['-n', '-o', '${P}']);`, P)).toBe('other');
  });
});

// ROUND 2 item 3. A subject that is read as text and whose text goes only into a LOCAL helper that asserts
// on it (`assertHas(src)` where the helper does `expect(s).toContain(..)`) is a text check, so its rows are
// wiring and an unlabelled row on it is flagged. A helper that does anything else with the text is not.
describe('a text read passed only to a local assert helper is text (ROUND 2 item 3)', () => {
  const P = 'scripts/thing.sh';
  it('a function declaration helper that only expects its argument is text', () => {
    const spec = `const src = readFileSync('${P}', 'utf8'); assertHas(src); function assertHas(s) { expect(s).toContain('x'); }`;
    expect(classifyPair(spec, P)).toBe('text');
    expect(isTextOnlyPair(spec, P)).toBe(true);
  });
  it('an arrow helper that only expects its argument is text', () => {
    const spec = `const src = readFileSync('${P}', 'utf8'); const assertHas = (s) => expect(s).toContain('x'); assertHas(src);`;
    expect(classifyPair(spec, P)).toBe('text');
  });
  it('a text-result (src.split(..)) passed to an asserting helper is still text', () => {
    const spec = `const src = readFileSync('${P}', 'utf8'); assertHas(src.split('\\n')); function assertHas(s) { expect(s).toContain('x'); }`;
    expect(classifyPair(spec, P)).toBe('text');
  });
  it('a helper that parses the text (JSON.parse) is not a text check', () => {
    const spec = `const src = readFileSync('${P}', 'utf8'); parseIt(src); function parseIt(s) { return JSON.parse(s); }`;
    expect(classifyPair(spec, P)).toBe('other');
  });
  it('a helper that stores the text somewhere is not a text check', () => {
    const spec = `const src = readFileSync('${P}', 'utf8'); keep(src); const store = []; function keep(s) { store.push(s); }`;
    expect(classifyPair(spec, P)).toBe('other');
  });
  it('two helpers that call each other are not followed forever (a cycle is refused, not looped)', () => {
    const spec = `const src = readFileSync('${P}', 'utf8'); a(src); function a(s) { b(s); } function b(s) { a(s); }`;
    expect(() => classifyPair(spec, P)).not.toThrow();
    expect(classifyPair(spec, P)).toBe('other');
  });
});

// ROUND 3 item 1. Attribution resolves a relative module specifier against the spec's own directory and
// compares the result to the subject's repo path. A basename match is not enough.
describe('attribution resolves module paths; a basename or another directory does not attribute (ROUND 3 item 1)', () => {
  const SUBJ = 'scripts/lib/render.mjs';
  const SPEC = 'scripts/x/spec.test.ts';
  it("a spec importing '../other/render' does NOT name scripts/lib/render.mjs", () => {
    expect(namesSubject("import { r } from '../other/render';", SUBJ, SPEC)).toBe(false);
  });
  it("a spec importing '../lib/render' DOES name scripts/lib/render.mjs (extension resolved)", () => {
    expect(namesSubject("import { r } from '../lib/render';", SUBJ, SPEC)).toBe(true);
  });
  it('a.mjs is not named by a data.mjs literal (no substring match)', () => {
    expect(namesSubject("const f = 'data.mjs';", 'scripts/a.mjs', SPEC)).toBe(false);
    expect(namesSubject("const f = 'a.mjs';", 'scripts/a.mjs', SPEC)).toBe(true);
  });
  it("a spawned '../other/render.mjs' is not an execution of scripts/lib/render.mjs", () => {
    expect(classifyPair("spawnSync('bash', ['../other/render.mjs']);", SUBJ, SPEC)).not.toBe(
      'executed',
    );
  });
  it("an import of '../other/render' is not an execution of scripts/lib/render.mjs", () => {
    expect(
      classifyPair("import { r } from '../other/render'; expect(1).toBe(1);", SUBJ, SPEC),
    ).not.toBe('executed');
  });
  it('a relative import that resolves to the subject IS an execution', () => {
    expect(classifyPair("import { r } from '../lib/render';", SUBJ, SPEC)).toBe('executed');
  });
});

// ROUND 4 item 1. TS ESM imports name a .js or .mjs file that is really the .ts or .mts source: a specifier
// './helpers/blocking-gate.js' names blocking-gate.ts.
describe('a .js/.mjs specifier names its .ts/.mts source (ROUND 4 item 1)', () => {
  const SPEC = 'scripts/lib/spec.test.ts';
  it("import './helpers/blocking-gate.js' names helpers/blocking-gate.ts and executes it", () => {
    const subj = 'scripts/lib/helpers/blocking-gate.ts';
    const spec = "import { g } from './helpers/blocking-gate.js'; expect(g).toBe(1);";
    expect(namesSubject(spec, subj, SPEC)).toBe(true);
    expect(classifyPair(spec, subj, SPEC)).toBe('executed');
  });
  it("import './a.mjs' names a.mts", () => {
    expect(namesSubject("import './a.mjs';", 'scripts/lib/a.mts', SPEC)).toBe(true);
  });
  it("import './a.js' does NOT name a.mts (the mapping is .js to .ts, .mjs to .mts only)", () => {
    expect(namesSubject("import './a.js';", 'scripts/lib/a.mts', SPEC)).toBe(false);
  });
});

// ROUND 4 item 2. -o noexec means the same as -n (the last of +o/-o noexec wins). Any other -o value is neutral.
describe('bash -o noexec is a syntax check; other -o values are neutral (ROUND 4 item 2)', () => {
  const P = 'scripts/thing.sh';
  it('bash -o noexec <subject> is a syntax check, not a run', () => {
    expect(classifyPair(`spawnSync('bash', ['-o', 'noexec', '${P}']);`, P)).not.toBe('executed');
  });
  it('bash -o noexec +o noexec <subject> runs the subject (+o noexec turns the check off)', () => {
    expect(classifyPair(`spawnSync('bash', ['-o', 'noexec', '+o', 'noexec', '${P}']);`, P)).toBe(
      'executed',
    );
  });
  it('bash -o pipefail <subject> is neutral: it runs the subject', () => {
    expect(classifyPair(`spawnSync('bash', ['-o', 'pipefail', '${P}']);`, P)).toBe('executed');
  });
  it('bash -n -o pipefail <subject> is still a check (a neutral -o does not reset -n)', () => {
    expect(classifyPair(`spawnSync('bash', ['-n', '-o', 'pipefail', '${P}']);`, P)).not.toBe(
      'executed',
    );
  });
  it('bash -o noexec -o pipefail <subject> is still a check (the neutral -o changes nothing)', () => {
    expect(
      classifyPair(`spawnSync('bash', ['-o', 'noexec', '-o', 'pipefail', '${P}']);`, P),
    ).not.toBe('executed');
  });
});

// ROUND 4 item 3. The module's exports are documented in scripts/lib/EGM.md, and the EGM does not overstate the heuristic.
describe('the lint module exports are documented, and the EGM states the heuristic (ROUND 4 item 3)', () => {
  it('every export of prover-wiring-lint.mjs is named in scripts/lib/EGM.md', () => {
    const egm = readFileSync(resolve(ROOT, 'scripts/lib/EGM.md'), 'utf8');
    const exported = Object.keys(LINT_MODULE).sort();
    expect(exported.length).toBeGreaterThan(0);
    const missing = exported.filter((name) => !egm.includes(name));
    expect(missing).toEqual([]);
  });
  it('the EGM does not say a flagged row is "genuinely" text-only (it is classified so by the heuristic)', () => {
    const egm = readFileSync(resolve(ROOT, 'scripts/lib/EGM.md'), 'utf8');
    expect(egm).not.toMatch(/genuinely text-only/);
  });
});

// ROUND 3 item 3a. The LAST n-setting wins: '+n' turns the syntax check off again.
describe('shell -n is turned off by a later +n (ROUND 3 item 3a)', () => {
  const P = 'scripts/thing.sh';
  it('bash -n +n <subject> RUNS the subject (executed): the last setting is +n', () => {
    expect(classifyPair(`spawnSync('bash', ['-n', '+n', '${P}']);`, P)).toBe('executed');
  });
  it('bash +n -n <subject> is a syntax check: the last setting is -n', () => {
    expect(classifyPair(`spawnSync('bash', ['+n', '-n', '${P}']);`, P)).not.toBe('executed');
  });
});

describe('the lint CLI prints each prover total split into wiring and behavioural', () => {
  it('z11 answering-pod: its 18 run.sh WR rows are wiring, the lib rows are not', () => {
    // `--base HEAD`: this test is about the row split, not the base-branch rule (tested below)
    const r = spawnSync(
      process.execPath,
      [resolve(ROOT, 'scripts/lib/prover-wiring-lint.mjs'), '--base', 'HEAD'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    );
    const line = r.stdout
      .split('\n')
      .find((l) => l.startsWith('scripts/mutation-prove-s11-1-z11-answering-pod.mjs:'));
    expect(line).toBeDefined();
    expect(line).toMatch(/total \d+, wiring 18, behavioural \d+/);
    expect(r.status).toBe(0);
    // spawns the lint over every prover under scripts/: it scales with the fleet, so it gets a
    // budget of its own rather than bun's 5 s default
  }, 60_000);
});

describe('unattributedRatchet: a prover may not gain unattributed rows', () => {
  const P = 'scripts/mutation-prove-a.mjs';
  it('fails a count above its baseline, naming prover, count and baseline', () => {
    expect(unattributedRatchet({ [P]: 5 }, { [P]: 4 }).grew).toEqual([
      { prover: P, count: 5, baseline: 4 },
    ]);
  });
  it('passes an equal count, and a lower one is a shrink hint, not a failure', () => {
    expect(unattributedRatchet({ [P]: 4 }, { [P]: 4 })).toEqual({ grew: [], shrank: [] });
    const r = unattributedRatchet({ [P]: 2 }, { [P]: 4 });
    expect(r.grew).toEqual([]);
    expect(r.shrank).toEqual([{ prover: P, count: 2, baseline: 4 }]);
  });
  it('a new prover (absent from the baseline) starts at 0', () => {
    expect(unattributedRatchet({ [P]: 1 }, {}).grew).toEqual([
      { prover: P, count: 1, baseline: 0 },
    ]);
    expect(unattributedRatchet({ [P]: 0 }, {})).toEqual({ grew: [], shrank: [] });
  });
  it('a baseline entry for a prover that no longer exists is a shrink hint', () => {
    expect(unattributedRatchet({}, { [P]: 3 }).shrank).toEqual([
      { prover: P, count: 0, baseline: 3 },
    ]);
  });
});

describe('the lint CLI enforces the unattributed ratchet on a fixture repo', () => {
  const lint = (root: string) =>
    spawnSync(
      process.execPath,
      [resolve(ROOT, 'scripts/lib/prover-wiring-lint.mjs'), '--root', root],
      {
        encoding: 'utf8',
      },
    );
  const fixture = (baseline: Record<string, number>, spec: string) => {
    const root = mkdtempSync(resolve(tmpdir(), 'wiring-ratchet-'));
    mkdirSync(resolve(root, 'scripts/lib'), { recursive: true });
    mkdirSync(resolve(root, 'tests'));
    writeFileSync(
      resolve(root, 'scripts/mutation-prove-fx.mjs'),
      `const SPEC = 'tests/fx.test.ts';
const PROOF = { subjects: { thing: 'scripts/thing.sh' } };
const MUTATIONS = [{ subject: 'thing', anchor: 'a', replacement: 'b' }];`,
    );
    writeFileSync(resolve(root, 'tests/fx.test.ts'), spec);
    writeFileSync(
      resolve(root, 'scripts/lib/prover-unattributed-baseline.json'),
      JSON.stringify(baseline),
    );
    return root;
  };
  const EXECUTES = `const p = resolve(ROOT, 'scripts/thing.sh'); spawnSync('bash', [p]);`;
  const ESCAPES = `${EXECUTES}
    const src = readFileSync(resolve(ROOT, 'scripts/thing.sh'), 'utf8'); JSON.parse(src.slice(0, 4));`;
  const P = 'scripts/mutation-prove-fx.mjs';

  it('is green while the subject is executed, RED when a JSON.parse(src.slice()) use makes it unattributed', () => {
    const root = fixture({}, EXECUTES);
    try {
      const ok = lint(root);
      expect(ok.stdout).toContain('behavioural 1, unattributed 0');
      expect(ok.status).toBe(0);
      writeFileSync(resolve(root, 'tests/fx.test.ts'), ESCAPES);
      const red = lint(root);
      expect(red.stdout).toContain('unattributed 1');
      expect(red.stderr).toContain(`${P}: unattributed 1 is above its baseline 0`);
      expect(red.status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('passes at its recorded baseline, and prints a lower-it hint when the count shrinks', () => {
    const root = fixture({ [P]: 1 }, ESCAPES);
    try {
      expect(lint(root).status).toBe(0);
      writeFileSync(resolve(root, 'tests/fx.test.ts'), EXECUTES);
      const r = lint(root);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`HINT ${P}: unattributed fell to 0 (baseline 1)`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('fails when the baseline file is missing', () => {
    const root = fixture({}, EXECUTES);
    try {
      rmSync(resolve(root, 'scripts/lib/prover-unattributed-baseline.json'));
      const r = lint(root);
      expect(r.status).toBe(1);
      // a whole line of its own: a crash's source excerpt (bun prints one) must not satisfy this
      expect(r.stderr).toMatch(
        /^scripts\/lib\/prover-unattributed-baseline\.json: missing; the unattributed ratchet has no baseline$/m,
      );
      expect(r.stderr).not.toContain('ENOENT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the committed baseline', () => {
  it('covers real provers only, with positive integer counts, and the real CLI is green on it', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(ROOT, 'scripts/lib/prover-unattributed-baseline.json'), 'utf8'),
    ) as Record<string, number>;
    for (const [prover, n] of Object.entries(baseline)) {
      expect(provers).toContain(prover);
      expect(Number.isInteger(n) && n > 0).toBe(true);
    }
  });
});

describe('baselineRaises / declaredBaselineRaises (pure)', () => {
  const P = 'scripts/mutation-prove-a.mjs';
  it('a working baseline above the base (absent = 0) is a raise; equal or lower is not', () => {
    expect(baselineRaises({ [P]: 3 }, { [P]: 2 })).toEqual([{ prover: P, from: 2, to: 3 }]);
    expect(baselineRaises({ [P]: 1 }, {})).toEqual([{ prover: P, from: 0, to: 1 }]);
    expect(baselineRaises({ [P]: 2 }, { [P]: 2 })).toEqual([]);
    expect(baselineRaises({}, { [P]: 2 })).toEqual([]);
    expect(baselineRaises({ [P]: 1 }, { [P]: 2 })).toEqual([]);
  });
  it('reads `Baseline-raise: <prover> <reason>` from visible text only, and needs a reason', () => {
    const body = `Baseline-raise: ${P} eleven new rows on a shared spec`;
    expect([...declaredBaselineRaises(body)]).toEqual([P]);
    expect([...declaredBaselineRaises(`baseline-raise: ${P} why`)]).toEqual([P]);
    expect([...declaredBaselineRaises(`Baseline-raise: ${P}`)]).toEqual([]);
    expect([...declaredBaselineRaises(`<!-- ${body} -->`)]).toEqual([]);
    expect([...declaredBaselineRaises(`\`\`\`\n${body}\n\`\`\``)]).toEqual([]);
  });
});

describe('the baseline cannot be raised by the PR that grows past it (git fixture)', () => {
  const P = 'scripts/mutation-prove-fx.mjs';
  const EXECUTES = `const p = resolve(ROOT, 'scripts/thing.sh'); spawnSync('bash', [p]);`;
  const ESCAPES = `${EXECUTES}
    const src = readFileSync(resolve(ROOT, 'scripts/thing.sh'), 'utf8'); JSON.parse(src.slice(0, 4));`;
  const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  const write = (root: string, rel: string, text: string) => {
    mkdirSync(resolve(root, rel, '..'), { recursive: true });
    writeFileSync(resolve(root, rel), text);
  };
  /** main holds `baseBaseline` (null = no file); the branch holds `workBaseline` and `spec`. */
  const repo = (
    baseBaseline: Record<string, number> | null,
    workBaseline: object,
    spec: string,
  ) => {
    const root = mkdtempSync(resolve(tmpdir(), 'wiring-base-'));
    sh(root, 'init', '-q', '-b', 'main');
    sh(root, 'config', 'user.email', 't@t');
    sh(root, 'config', 'user.name', 't');
    sh(root, 'config', 'commit.gpgsign', 'false');
    write(
      root,
      P,
      `const SPEC = 'tests/fx.test.ts';
const PROOF = { subjects: { thing: 'scripts/thing.sh' } };
const MUTATIONS = [{ subject: 'thing', anchor: 'a', replacement: 'b' }];`,
    );
    write(root, 'tests/fx.test.ts', EXECUTES);
    if (baseBaseline)
      write(root, 'scripts/lib/prover-unattributed-baseline.json', JSON.stringify(baseBaseline));
    else write(root, 'README.md', 'x');
    sh(root, 'add', '-A');
    sh(root, 'commit', '-qm', 'base');
    sh(root, 'switch', '-qc', 'work');
    sh(root, 'update-ref', 'refs/remotes/origin/main', 'main');
    write(root, 'tests/fx.test.ts', spec);
    write(root, 'scripts/lib/prover-unattributed-baseline.json', JSON.stringify(workBaseline));
    sh(root, 'add', '-A');
    return root;
  };
  const commit = (root: string, msg: string) => {
    sh(root, 'commit', '-qm', msg);
  };
  const lint = (
    root: string,
    env: Record<string, string> = {},
    base: string[] = ['--base', 'main'],
  ) =>
    spawnSync(
      process.execPath,
      [resolve(ROOT, 'scripts/lib/prover-wiring-lint.mjs'), '--root', root, ...base],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } },
    );
  const withRepo = (
    base: Record<string, number> | null,
    work: object,
    spec: string,
    msg: string,
    fn: (root: string) => void,
  ) => {
    const root = repo(base, work, spec);
    try {
      commit(root, msg);
      fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('FAILS a raised baseline with no Baseline-raise line, even though the count fits the new baseline', () => {
    withRepo({}, { [P]: 1 }, ESCAPES, 'grow', (root) => {
      const r = lint(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${P}: baseline raised 0 -> 1 without a Baseline-raise line`);
    });
  });
  it('PASSES a raise declared in the PR body (CI) with a reason', () => {
    withRepo({}, { [P]: 1 }, ESCAPES, 'grow', (root) => {
      const body = `Baseline-raise: ${P} shared spec cannot be attributed`;
      const r = lint(root, { GITHUB_ACTIONS: 'true', PR_BODY: body });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`NOTICE ${P}: baseline raised 0 -> 1`);
    });
  });
  it('FAILS a raise declared only in a comment or fence of the PR body', () => {
    withRepo({}, { [P]: 1 }, ESCAPES, 'grow', (root) => {
      const hidden = `<!-- Baseline-raise: ${P} reason -->`;
      expect(lint(root, { PR_BODY: hidden }).status).toBe(1);
    });
  });
  it('in CI a commit message cannot declare the raise (it can be rewritten); locally it can', () => {
    withRepo({}, { [P]: 1 }, ESCAPES, `grow\n\nBaseline-raise: ${P} reason here`, (root) => {
      expect(lint(root, { GITHUB_ACTIONS: 'true' }).status).toBe(1);
      expect(lint(root).status).toBe(0);
    });
  });
  it('a raise for another prover does not excuse this one', () => {
    withRepo({}, { [P]: 1 }, ESCAPES, 'grow', (root) => {
      const r = lint(root, { PR_BODY: 'Baseline-raise: scripts/mutation-prove-other.mjs reason' });
      expect(r.status).toBe(1);
    });
  });
  it('lowering the baseline is always allowed', () => {
    withRepo({ [P]: 1 }, {}, EXECUTES, 'shrink', (root) => {
      const r = lint(root);
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('baseline raised');
    });
  });
  it('a base with no baseline file falls back to the working tree with a NOTICE', () => {
    withRepo(null, { [P]: 1 }, ESCAPES, 'add', (root) => {
      const r = lint(root);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('NOTICE no baseline on main');
    });
  });
  it('in CI the base is GITHUB_BASE_REF as origin/<ref> when --base is not given', () => {
    withRepo({}, { [P]: 1 }, ESCAPES, 'grow', (root) => {
      const r = lint(root, { GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: 'main' }, []);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('baseline raised 0 -> 1');
    });
  });
  it('reads the base baseline at the MERGE-BASE, not at the base branch tip', () => {
    withRepo({}, { [P]: 1 }, ESCAPES, 'grow', (root) => {
      sh(root, 'switch', '-q', 'main');
      write(root, 'scripts/lib/prover-unattributed-baseline.json', JSON.stringify({ [P]: 5 }));
      sh(root, 'commit', '-qam', 'base moves on');
      sh(root, 'switch', '-q', 'work');
      const r = lint(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('baseline raised 0 -> 1');
    });
  });
  it('still fails growth past the working baseline', () => {
    withRepo({}, {}, ESCAPES, 'grow', (root) => {
      expect(lint(root).status).toBe(1);
    });
  });
});

describe('a CI job runs the lint with the base fetched and the PR body in env', () => {
  const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const start = ci.indexOf('\n  prover-unattributed-ratchet:');
  const job = start === -1 ? '' : ci.slice(start + 1, ci.indexOf('\n  compat-smoke:', start));
  it('the job exists and runs on pull requests only', () => {
    expect(job).not.toBe('');
    expect(job).toContain("if: github.event_name == 'pull_request'");
  });
  it('fetches full history (the base is read at the merge-base)', () => {
    expect(job).toMatch(/fetch-depth: 0/);
  });
  it('passes the PR body through env, never interpolated into the script', () => {
    expect(job).toContain('PR_BODY: ${{ github.event.pull_request.body }}');
    const run = job.match(/run: (node scripts\/lib\/prover-wiring-lint\.mjs.*)/)?.[1];
    expect(run).toBeDefined();
    expect(run).not.toContain('${{');
  });
});
