import { describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  acquireFailureObserverCount,
  isConnectionRefused,
  isScaleToZeroDatabase,
  observeAcquireFailures,
  reportAcquireFailure,
} from '../db/reachability';

/**
 * Runs `run` and returns every line it wrote through `console.warn`. The warning is a
 * single JSON line written directly, not through the shared logger: the logger builds
 * its pino instance at module load, and importing it from `reachability` would pull it
 * into `clients.ts`'s static graph (see the import-graph guard below).
 */
const captureWarnings = (run: () => void): string[] => {
  const lines: string[] = [];
  const spy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return lines;
};

describe('isConnectionRefused — only a definitive refusal', () => {
  it('recognises the node pg code and the Bun.SQL code', () => {
    expect(isConnectionRefused(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(
      isConnectionRefused(
        Object.assign(new Error('Failed to connect'), { code: 'ERR_POSTGRES_CONNECTION_REFUSED' }),
      ),
    ).toBe(true);
  });

  it('recognises a multi-address connect failure whose every attempt was refused', () => {
    const refused = (code: string) => Object.assign(new Error('x'), { code });
    const all = new AggregateError([refused('ECONNREFUSED'), refused('ECONNREFUSED')], 'connect');
    expect(isConnectionRefused(Object.assign(all, { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isConnectionRefused(all)).toBe(true);
    const mixed = new AggregateError([refused('ECONNREFUSED'), refused('ETIMEDOUT')], 'connect');
    expect(isConnectionRefused(mixed)).toBe(false);
  });

  it('is a CONNECT-phase verdict: message text alone never counts', () => {
    // The observer sees every failure on the writer pool, application queries
    // included, so prose that merely contains the words is not evidence.
    expect(isConnectionRefused(new Error('connect ECONNREFUSED 10.0.0.1:5432'))).toBe(false);
    expect(isConnectionRefused(new Error('Connection refused'))).toBe(false);
  });

  it('ignores a server-originated error even when it says "connection refused"', () => {
    // dblink / postgres_fdw: the DATABASE answered, and the failure it reports is
    // about a different server it tried to reach (SQLSTATE 08001).
    const serverSide = Object.assign(
      new Error('could not connect to server: Connection refused (ECONNREFUSED)'),
      { code: '08001', severity: 'ERROR' },
    );
    expect(isConnectionRefused(serverSide)).toBe(false);
    // Even an error that carries a refusal code is server-originated if the
    // driver marked it with a severity.
    expect(
      isConnectionRefused(
        Object.assign(new Error('x'), { code: 'ECONNREFUSED', severity: 'FATAL' }),
      ),
    ).toBe(false);
  });

  it('does not treat resets, DNS failures, timeouts or auth errors as a refusal', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', '28P01']) {
      expect(isConnectionRefused(Object.assign(new Error('boom'), { code }))).toBe(false);
    }
    expect(isConnectionRefused(undefined)).toBe(false);
    expect(isConnectionRefused(null)).toBe(false);
    expect(isConnectionRefused('ECONNREFUSED')).toBe(false);
  });
});

describe('isScaleToZeroDatabase — the gateway, however it is spelled', () => {
  const dsn = (host: string) => `postgres://u:p@${host}:55432/postgres`;

  it('matches any DNS label equal to scale-zero-pg, short or fully qualified', () => {
    for (const host of [
      'pggw-apps.scale-zero-pg.svc.cluster.local.',
      'pggw.scale-zero-pg.svc',
      'pggw-apps.scale-zero-pg',
      'pggw-apps.scale-zero-pg.svc.corp.example',
      'scale-zero-pg',
    ]) {
      expect(isScaleToZeroDatabase(dsn(host), undefined)).toBe(true);
    }
  });

  it('matches the bare in-namespace gateway service names', () => {
    expect(isScaleToZeroDatabase(dsn('pggw'), undefined)).toBe(true);
    expect(isScaleToZeroDatabase(dsn('pggw-apps'), undefined)).toBe(true);
  });

  it('never matches a bring-your-own host, a lookalike, or a path/userinfo mention', () => {
    for (const host of [
      'db.example.com',
      'pggw.example.com',
      'evilscale-zero-pg.svc.example.com',
    ]) {
      expect(isScaleToZeroDatabase(dsn(host), undefined)).toBe(false);
    }
    expect(
      isScaleToZeroDatabase('postgres://u:p@db.example.com:5432/scale-zero-pg', undefined),
    ).toBe(false);
    expect(
      isScaleToZeroDatabase('postgres://scale-zero-pg.svc@db.example.com/app', undefined),
    ).toBe(false);
    expect(isScaleToZeroDatabase('not a url', undefined)).toBe(false);
    expect(isScaleToZeroDatabase(undefined, undefined)).toBe(false);
  });

  it('an explicit declaration wins over the host: true forces scale-to-zero', () => {
    // An IP, a pooler or an ExternalName alias in front of the gateway.
    for (const flag of ['true', 'TRUE', '1', 'yes', ' true ']) {
      expect(isScaleToZeroDatabase(dsn('10.0.0.7'), flag)).toBe(true);
      expect(isScaleToZeroDatabase(dsn('db.example.com'), flag)).toBe(true);
    }
  });

  it('an explicit declaration wins over the host: false forces bring-your-own', () => {
    for (const flag of ['false', 'FALSE', '0', 'no']) {
      expect(isScaleToZeroDatabase(dsn('pggw-apps.scale-zero-pg.svc'), flag)).toBe(false);
    }
  });

  it('an empty or unrecognised declaration falls back to the host', () => {
    const lines = captureWarnings(() => {
      for (const flag of [undefined, '', 'maybe']) {
        expect(isScaleToZeroDatabase(dsn('pggw.scale-zero-pg.svc'), flag)).toBe(true);
        expect(isScaleToZeroDatabase(dsn('db.example.com'), flag)).toBe(false);
      }
    });
    // Only the unrecognised 'maybe' warns; undefined and '' are silent.
    expect(lines).toHaveLength(1);
  });

  it('reads KNEXT_DB_SCALE_TO_ZERO from the environment by default', () => {
    const before = process.env.KNEXT_DB_SCALE_TO_ZERO;
    try {
      process.env.KNEXT_DB_SCALE_TO_ZERO = 'true';
      expect(isScaleToZeroDatabase(dsn('db.example.com'))).toBe(true);
      process.env.KNEXT_DB_SCALE_TO_ZERO = 'false';
      expect(isScaleToZeroDatabase(dsn('pggw.scale-zero-pg.svc'))).toBe(false);
    } finally {
      if (before === undefined) delete process.env.KNEXT_DB_SCALE_TO_ZERO;
      else process.env.KNEXT_DB_SCALE_TO_ZERO = before;
    }
  });
});

describe('acquire-failure observers', () => {
  it('delivers a report to every subscriber and stops after unsubscribe', () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const stopA = observeAcquireFailures((e) => a.push(e));
    const stopB = observeAcquireFailures((e) => b.push(e));
    const err = new Error('x');
    reportAcquireFailure(err);
    stopA();
    reportAcquireFailure(err);
    stopB();
    expect(a).toEqual([err]);
    expect(b).toEqual([err, err]);
  });

  it('survives a second bundle copy of the module (state is anchored on globalThis)', async () => {
    // A query-string import evaluates the module body afresh — a separate copy
    // with its own module scope, as the standalone build produces.
    const copy = (await import(
      `../db/reachability.ts?copy=${Date.now()}`
    )) as typeof import('../db/reachability');
    const seen: unknown[] = [];
    const stop = observeAcquireFailures((e) => seen.push(e));
    const err = new Error('from the other copy');
    copy.reportAcquireFailure(err);
    stop();
    expect(seen).toEqual([err]);
    expect(copy.acquireFailureObserverCount()).toBe(acquireFailureObserverCount());
  });
});

describe('isScaleToZeroDatabase — an unrecognised KNEXT_DB_SCALE_TO_ZERO warns once', () => {
  const dsn = (host: string) => `postgres://u:p@${host}:55432/postgres`;

  // Each test uses its own bad value: the once-per-process guard is process state,
  // so a value another test already reported would hide the warning under test.
  it('names the bad value and the host fallback, and warns once per process', () => {
    const lines = captureWarnings(() => {
      expect(isScaleToZeroDatabase(dsn('db.example.com'), 'ture-once-typo')).toBe(false);
      expect(isScaleToZeroDatabase(dsn('db.example.com'), 'ture-once-typo')).toBe(false);
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('KNEXT_DB_SCALE_TO_ZERO');
    expect(lines[0]).toContain('"ture-once-typo"');
    expect(lines[0]).toContain('host');
  });

  it('writes exactly one parseable JSON record per warning', () => {
    const lines = captureWarnings(() => {
      isScaleToZeroDatabase(dsn('db.example.com'), 'json-shape-typo');
    });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record.level).toBe('warn');
    expect(record.variable).toBe('KNEXT_DB_SCALE_TO_ZERO');
    expect(record.value).toBe('json-shape-typo');
    expect(String(record.msg)).toContain('host');
  });

  it('keeps reachability off the shared logger import graph', () => {
    // clients.ts imports this module statically. A static import of ../logger here
    // builds the pino singleton as a side effect of loading clients, so a suite that
    // mocks pino after importing clients captures nothing (logger.test.ts,
    // correlation.test.ts). Guard the import, not the behaviour.
    const source = readFileSync(new URL('../db/reachability.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\.\/logger['"]/);
  });

  it('never logs a connection string: a DSN-shaped value shows only its length', () => {
    const secret = 'postgres://svc:hunter2pw@db.example.com/postgres';
    expect(secret.length).toBeLessThan(64);
    const lines = captureWarnings(() => {
      expect(isScaleToZeroDatabase(dsn('db.example.com'), secret)).toBe(false);
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`<redacted, ${secret.length} characters>`);
    expect(lines[0]).not.toContain('hunter2pw');
    expect(lines[0]).not.toContain('svc:');
  });

  it('truncates a long plain value to 64 characters', () => {
    const lines = captureWarnings(() => {
      isScaleToZeroDatabase(dsn('db.example.com'), 'z'.repeat(100));
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"${'z'.repeat(64)}"`);
    expect(lines[0]).not.toContain('z'.repeat(65));
  });

  it('dedupes on the full value, so two values sharing a 64-character prefix both warn', () => {
    const prefix = 'p'.repeat(64);
    const lines = captureWarnings(() => {
      isScaleToZeroDatabase(dsn('db.example.com'), `${prefix}a`);
      isScaleToZeroDatabase(dsn('db.example.com'), `${prefix}b`);
    });
    expect(lines).toHaveLength(2);
  });

  it('a duplicated module copy shares the once-set (state is anchored on globalThis)', async () => {
    // A query-string import evaluates the module body afresh, as the standalone
    // build's second copy does. The copy warns first; the original must stay silent.
    const copy = (await import(
      `../db/reachability.ts?copy=${Date.now()}`
    )) as typeof import('../db/reachability');
    const value = 'copy-dedupe-typo';
    const first = captureWarnings(() => {
      copy.isScaleToZeroDatabase(dsn('db.example.com'), value);
    });
    const second = captureWarnings(() => {
      isScaleToZeroDatabase(dsn('db.example.com'), value);
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('the fallback still follows the host when the value is unrecognised', () => {
    const lines = captureWarnings(() => {
      expect(isScaleToZeroDatabase(dsn('pggw.scale-zero-pg.svc'), 'mayb-host-typo')).toBe(true);
    });
    expect(lines).toHaveLength(1);
  });

  it('stays silent for recognised values, empty values and an unset variable', () => {
    const lines = captureWarnings(() => {
      for (const flag of ['true', ' YES ', 'false', '0', 'no', '', '   ', undefined]) {
        isScaleToZeroDatabase(dsn('db.example.com'), flag);
      }
    });
    expect(lines).toHaveLength(0);
  });
});
