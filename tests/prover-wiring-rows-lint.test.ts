import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  auditWiringLabels,
  declaredWiringSubjects,
  isTextOnlyPair,
  rowsBySubject,
  textOnlySubjects,
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
