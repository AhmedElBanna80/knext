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
});
