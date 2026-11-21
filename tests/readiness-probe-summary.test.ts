import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Pins scripts/bench-cold-start-phases/readiness-probe-summary.py on a hand-derived fixture.
 *
 * Arm "a", four wakes (request at 2026-11-21T00:00:00Z, so t_ready = ready/1000 + 1 s of stamp slack):
 *   p0 first byte 1000, Ready 1100, one `deadline exceeded` event x2 at +1 s      -> 2 failures, 2 timeouts
 *   p1 first byte 2000, Ready 2100, no events                                      -> 0
 *   p2 first byte 3000, Ready 3100, a 503 event x5 stamped +1 s..+30 s (straddles
 *      Ready: it keeps counting through the scale-down)                            -> counts once, 1 failure
 *   p3 first byte 4000, Ready 11000, timeout x3 at +1..+3 s, and a 503 x3 at
 *      +21..+41 s (scale-down, after Ready)                                        -> 3 failures, 3 timeouts
 * First byte 1000/2000/3000/4000: median 2500, p95 at rank 0.95*3 = 2.85 -> 3000 + 0.85*1000 = 3850.
 * Ready 1100/2100/3100/11000: median 2600, p95 -> 3100 + 0.85*7900 = 9815.
 * Ready minus first byte: 100, 100, 100, 7000 -> median 100.
 * Failures 2+0+1+3 = 6 over 4 wakes = 1.50 per wake; timeouts 2+0+0+3 = 5 -> 1.25; 3 of 4 pods failed.
 * Arm "b": one wake whose Ready was never seen -> Ready columns "-", no failure statistics.
 */
const ROOT = resolve(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts/bench-cold-start-phases/readiness-probe-summary.py');
const T0 = '2026-11-21T00:00:00.000Z';

function row(arm: string, pod: string, firstByte: number, ready: number | null) {
  const watch: Record<string, number> = { first_byte: firstByte };
  if (ready !== null) watch.cond_Ready = ready;
  return { arm, pod, code: 200, wall_start: T0, watch };
}

function ev(
  uid: string,
  pod: string,
  message: string,
  count: number,
  firstSec: number,
  lastSec: number,
) {
  const at = (s: number) =>
    `2026-11-21T00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}Z`;
  return {
    metadata: { uid },
    reason: 'Unhealthy',
    involvedObject: { name: pod },
    message,
    count,
    firstTimestamp: at(firstSec),
    lastTimestamp: at(lastSec),
  };
}

const TIMEOUT = 'Readiness probe failed: Get "http://10.0.0.1:8012/": context deadline exceeded';
const R503 = 'Readiness probe failed: HTTP probe failed with statuscode: 503';

function run(rows: unknown[], eventFiles: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rps-'));
  try {
    const phases = join(dir, 'phases.jsonl');
    writeFileSync(phases, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const files = eventFiles.map((e, i) => {
      const f = join(dir, `events-${i}.json`);
      writeFileSync(f, JSON.stringify(e));
      return f;
    });
    const r = spawnSync('python3', ['-I', SCRIPT, phases, ...files], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ROWS = [
  row('a', 'p0', 1000, 1100),
  row('a', 'p1', 2000, 2100),
  row('a', 'p2', 3000, 3100),
  row('a', 'p3', 4000, 11000),
  row('b', 'q0', 500, null),
  row('c', 'r0', 1500, 2000),
];

const EVENTS = {
  kind: 'List',
  items: [
    ev('u0', 'p0', TIMEOUT, 2, 1, 1),
    ev('u2', 'p2', R503, 5, 1, 30),
    ev('u3a', 'p3', TIMEOUT, 3, 1, 3),
    ev('u3b', 'p3', R503, 3, 21, 41),
    // stamped exactly 1 s after Ready: still before Ready in real time, kubelet stamps are 1 s coarse
    ev('u4', 'r0', TIMEOUT, 2, 3, 3),
  ],
};

function line(out: string, arm: string): string[] {
  const l = out.split('\n').find((x) => x.startsWith(`${arm} `));
  expect(l).toBeDefined();
  return (l as string).trim().split(/\s+/);
}

describe('readiness-probe-summary.py', () => {
  it('prints first byte / Ready median, interpolated p95 and max per arm', () => {
    const t = line(run(ROWS, [EVENTS]), 'a');
    // arm n | fb med p95 max | Ready med p95 max seen | Ready-fb med | pods-with-fail fails timeouts
    expect(t.slice(0, 13)).toEqual([
      'a',
      '4',
      '|',
      '2500',
      '3850',
      '4000',
      '|',
      '2600',
      '9815',
      '11000',
      '4/4',
      '|',
      '100',
    ]);
  });

  it('counts failed probes up to Ready, counting a straddling event once', () => {
    const t = line(run(ROWS, [EVENTS]), 'a');
    expect(t.slice(14)).toEqual(['3/4', '1.50', '1.25']);
  });

  it('keeps the highest count when a watch stream re-sends an event, across files', () => {
    const lower = {
      type: 'MODIFIED',
      object: ev('u0', 'p0', TIMEOUT, 1, 1, 1),
    };
    const t = line(run(ROWS, [EVENTS, lower]), 'a');
    // u0 stays at count 2 (not overwritten by the later, lower count): same totals as above
    expect(t.slice(14)).toEqual(['3/4', '1.50', '1.25']);
  });

  it('reports "-" for Ready when it was never seen and excludes that wake from failure stats', () => {
    const t = line(run(ROWS, [EVENTS]), 'b');
    expect(t.slice(0, 12)).toEqual([
      'b',
      '1',
      '|',
      '500',
      '500',
      '500',
      '|',
      '-',
      '-',
      '-',
      '0/1',
      '|',
    ]);
    expect(t.slice(12)).toEqual(['-', '|', '0/0', '0.00', '0.00']);
  });

  it('allows one second of stamp resolution after Ready', () => {
    const t = line(run(ROWS, [EVENTS]), 'c');
    expect(t.slice(14)).toEqual(['1/1', '2.00', '2.00']);
  });

  it('exits non-zero with a usage line when no events file is given', () => {
    const r = spawnSync('python3', ['-I', SCRIPT, '/nonexistent.jsonl'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('usage: readiness-probe-summary.py');
  });
});
