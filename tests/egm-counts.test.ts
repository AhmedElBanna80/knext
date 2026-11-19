import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const SCRIPT = join(REPO, 'scripts/egm-counts.mjs');

function run(args: string[]) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const MANIFEST = {
  counts: {
    'fx.provers': { kind: 'entries', dir: 'tools', type: 'file', name: '^prove-.*\\.mjs$' },
    'fx.users': { kind: 'grep', dir: 'tools', name: '^prove-.*\\.mjs$', pattern: 'lib/x' },
  },
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'egm-counts-'));
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools/prove-a.mjs'), "import 'lib/x';\n");
  writeFileSync(join(root, 'tools/prove-b.mjs'), 'nothing\n');
  writeFileSync(
    join(root, 'tools/EGM.md'),
    'There are two<!--egm:fx.provers--> provers, 1<!--egm:fx.users--> imports lib. Port 9464 stays.\n',
  );
  const manifest = join(root, 'manifest.json');
  writeFileSync(manifest, JSON.stringify(MANIFEST));
  return { root, manifest, args: (m: string) => [m, '--root', root, '--manifest', manifest] };
}

describe('EGM.md counts are derived', () => {
  it('every count in the repo matches the computed number', () => {
    const r = run(['--check']);
    expect(r.out).toContain('all match');
    expect(r.code).toBe(0);
  });

  it('the repo docs actually carry markers (guard against an empty pass)', () => {
    expect(readFileSync(join(REPO, 'scripts/EGM.md'), 'utf8')).toMatch(
      /<!--egm:scripts\.provers-->/,
    );
    expect(run(['--check']).out).toMatch(/\b[1-9]\d* derived counts/);
  });

  it('check reds on a changed count, naming the line; write fixes it', () => {
    const f = fixture();
    try {
      expect(run(f.args('--check')).code).toBe(0);
      const doc = join(f.root, 'tools/EGM.md');
      writeFileSync(doc, readFileSync(doc, 'utf8').replace('two<!--', 'three<!--'));
      const bad = run(f.args('--check'));
      expect(bad.code).toBe(1);
      expect(bad.out).toContain('tools/EGM.md:1: fx.provers says three, computed 2');
      expect(run(f.args('--write')).code).toBe(0);
      expect(readFileSync(doc, 'utf8')).toContain('two<!--egm:fx.provers-->');
      expect(readFileSync(doc, 'utf8')).toContain('Port 9464 stays');
      expect(run(f.args('--check')).code).toBe(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('adding a prover file reds check until write runs', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, 'tools/prove-c.mjs'), "import 'lib/x';\n");
      const bad = run(f.args('--check'));
      expect(bad.code).toBe(1);
      expect(bad.out).toContain('fx.provers says two, computed 3');
      expect(bad.out).toContain('fx.users says 1, computed 2');
      run(f.args('--write'));
      const doc = readFileSync(join(f.root, 'tools/EGM.md'), 'utf8');
      expect(doc).toContain('three<!--egm:fx.provers-->');
      expect(doc).toContain('2<!--egm:fx.users-->');
      expect(run(f.args('--check')).code).toBe(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('reds on an unknown marker key and on a manifest key no doc cites', () => {
    const f = fixture();
    try {
      const doc = join(f.root, 'tools/EGM.md');
      writeFileSync(doc, 'Seven<!--egm:nope--> and 2<!--egm:fx.provers-->\n'.replace('Seven', '7'));
      const r = run(f.args('--check'));
      expect(r.code).toBe(1);
      expect(r.out).toContain('unknown count key "nope"');
      expect(r.out).toContain('manifest key "fx.users" is cited by no EGM.md');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  describe('fails closed on malformed markers and broken rules', () => {
    const cases: Array<[string, string, string]> = [
      [
        'no number before the marker',
        'provers <!--egm:fx.provers--> here\n',
        'malformed count marker',
      ],
      [
        'an unsupported number word',
        'thirteen<!--egm:fx.provers--> here\n',
        'malformed count marker',
      ],
      ['a number glued to a word', 'x2<!--egm:fx.provers--> here\n', 'malformed count marker'],
      ['a decimal before the marker', '1.5<!--egm:fx.provers--> here\n', 'malformed count marker'],
      ['an invalid key', '2<!--egm:bad key--> here\n', 'malformed count marker'],
      ['an empty key', '2<!--egm:--> here\n', 'malformed count marker'],
      ['an unterminated comment', '2<!--egm:fx.provers here\n', 'malformed count marker'],
      [
        'a spaced marker-like comment',
        '2 <!-- egm:fx.provers --> here\n',
        'malformed count marker',
      ],
    ];
    for (const [name, line, msg] of cases) {
      it(`reds on ${name}, naming file:line`, () => {
        const f = fixture();
        try {
          const doc = join(f.root, 'tools/EGM.md');
          writeFileSync(doc, `ok 2<!--egm:fx.provers--> 1<!--egm:fx.users-->\n${line}`);
          const r = run(f.args('--check'));
          expect(r.code).toBe(1);
          expect(r.out).toContain(msg);
          expect(r.out).toContain('tools/EGM.md:2:');
          expect(run(f.args('--write')).code).toBe(1);
        } finally {
          rmSync(f.root, { recursive: true, force: true });
        }
      });
    }

    it('reds when a rule matches nothing, unless it declares allowZero', () => {
      const f = fixture();
      try {
        const m = structuredClone(MANIFEST) as typeof MANIFEST & { counts: Record<string, object> };
        m.counts['fx.none'] = { kind: 'entries', dir: 'tools', type: 'file', name: '^nope$' };
        writeFileSync(f.manifest, JSON.stringify(m));
        const doc = join(f.root, 'tools/EGM.md');
        writeFileSync(doc, 'two<!--egm:fx.provers--> 1<!--egm:fx.users--> 0<!--egm:fx.none-->\n');
        const bad = run(f.args('--check'));
        expect(bad.code).toBe(1);
        expect(bad.out).toContain('"fx.none" matched 0');
        m.counts['fx.none'] = {
          kind: 'entries',
          dir: 'tools',
          type: 'file',
          name: '^nope$',
          allowZero: true,
        };
        writeFileSync(f.manifest, JSON.stringify(m));
        expect(run(f.args('--check')).code).toBe(0);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });

    it('counts regex-count matches inside the `within` region only', () => {
      const f = fixture();
      try {
        writeFileSync(
          join(f.root, 'cfg.ts'),
          "x: 'out',\nentry: {\n  a: 'a',\n  b: 'b',\n},\ny: 'z',\n",
        );
        const m = {
          counts: {
            'fx.entries': {
              kind: 'regex-count',
              file: 'cfg.ts',
              within: 'entry:\\s*\\{([^}]*)\\}',
              pattern: '^\\s*\\w+:\\s*[\'"]',
            },
          },
        };
        writeFileSync(f.manifest, JSON.stringify(m));
        const doc = join(f.root, 'tools/EGM.md');
        writeFileSync(doc, 'two<!--egm:fx.entries-->\n');
        expect(run(f.args('--check')).code).toBe(0);
        writeFileSync(join(f.root, 'cfg.ts'), "entry: {\n  a: 'a',\n  b: 'b',\n  c: 'c',\n},\n");
        const bad = run(f.args('--check'));
        expect(bad.code).toBe(1);
        expect(bad.out).toContain('fx.entries says two, computed 3');
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });
  });
});
