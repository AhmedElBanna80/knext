import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * GUARD for the Redis ACL kind drill lane
 * (.github/workflows/redis-acl-kind-drill.yml running
 * packages/kn-next-operator/test/redis-acl-kind-drill.sh).
 *
 * The drill was written but nothing ran it. Three halves, each asserted both ways:
 * 1. the workflow exists and actually invokes the drill script (and the script exists);
 * 2. the path filter matches every non-generated redis_acl*.go on disk (scanned),
 *    the drill itself and the workflow, on pull_request and push alike;
 * 3. the job is as safe as the rest of CI: read-only token, SHA-pinned actions with
 *    a version comment, no secrets, no continue-on-error, a bounded timeout.
 * It also pins that the script still has every leg L1-L9, so a deleted leg reds here.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = resolve(ROOT, '.github/workflows/redis-acl-kind-drill.yml');
const DRILL_REL = 'packages/kn-next-operator/test/redis-acl-kind-drill.sh';
const CTRL = 'packages/kn-next-operator/internal/controller';

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  'continue-on-error'?: unknown;
}
interface Job {
  steps: Step[];
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  'continue-on-error'?: unknown;
}
interface Workflow {
  on: {
    pull_request: { paths: string[] };
    push: { paths: string[]; branches: string[] };
  };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const wfText = readFileSync(WORKFLOW, 'utf8');
const wf = parse(wfText) as Workflow;
const wfCode = wfText
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');
const jobs = Object.values(wf.jobs);
const steps = jobs.flatMap((j) => j.steps);

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i++;
      }
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
function filtered(paths: string[], file: string): boolean {
  let hit = false;
  for (const p of paths) {
    const neg = p.startsWith('!');
    if (globToRegExp(neg ? p.slice(1) : p).test(file)) hit = !neg;
  }
  return hit;
}

describe('the drill runs in CI', () => {
  it('the drill script exists and the workflow runs it in a step', () => {
    expect(existsSync(resolve(ROOT, DRILL_REL))).toBe(true);
    expect(steps.some((s) => (s.run ?? '').includes(DRILL_REL))).toBe(true);
  });

  it('the script still carries every leg L1-L9 (a deleted leg reds)', () => {
    const drill = readFileSync(resolve(ROOT, DRILL_REL), 'utf8');
    for (const leg of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9']) {
      expect(drill, `leg ${leg} missing from the drill header`).toMatch(
        new RegExp(`^#\\s+${leg}\\. `, 'm'),
      );
    }
  });
});

describe('the path filter', () => {
  const pr = wf.on.pull_request.paths;
  const push = wf.on.push.paths;

  it('pull_request and push filter the same list, and push covers main and integration lines', () => {
    expect(push).toEqual(pr);
    expect(wf.on.push.branches).toContain('main');
    expect(wf.on.push.branches).toContain('integration/**');
  });

  it('matches every redis_acl*.go file on disk (scanned, tests included)', () => {
    const files = readdirSync(resolve(ROOT, CTRL)).filter((f) => /^redis_acl.*\.go$/.test(f));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      expect(filtered(pr, `${CTRL}/${f}`), `${f} is not matched by the path filter`).toBe(true);
    }
  });

  it('matches the drill, its workflow and this guard, but not unrelated operator code', () => {
    for (const f of [
      DRILL_REL,
      '.github/workflows/redis-acl-kind-drill.yml',
      'tests/redis-acl-kind-drill-lane.test.ts',
    ]) {
      expect(filtered(pr, f), `${f} is not matched`).toBe(true);
    }
    expect(filtered(pr, `${CTRL}/zone_signing_key.go`)).toBe(false);
  });
});

describe('the job is as safe as the rest of CI', () => {
  it('read-only token, no job-level widening', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const j of jobs) expect(j.permissions).toBeUndefined();
  });

  it('pins every action to a full commit SHA with a version comment', () => {
    const uses = [...wfText.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)].filter(
      (m) => !(m[1] as string).startsWith('./'),
    );
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const m of uses) {
      expect(m[1], `${m[1]} is not SHA-pinned`).toMatch(/@[0-9a-f]{40}$/);
      expect(m[2], `${m[1]} lacks a # vX comment`).toMatch(/#\s*v\d/);
    }
  });

  it('no secrets, no continue-on-error, bounded timeout', () => {
    expect(wfCode).not.toMatch(/secrets\./);
    expect(wfCode).not.toMatch(/continue-on-error/);
    for (const j of jobs) {
      expect(j['timeout-minutes']).toBeGreaterThan(0);
      expect(j['timeout-minutes']).toBeLessThanOrEqual(60);
    }
  });
});
