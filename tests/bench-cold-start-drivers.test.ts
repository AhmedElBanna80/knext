import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Cold-start bench drivers that run inside a pod or on the operator's workstation. They
 * cannot be exercised against a cluster here, so each is run for real against a stand-in:
 *
 *   - baseline-stability-drive.py against a fake `kubectl` on PATH (the same technique
 *     bench-cold-start-harness.test.ts uses for drive.py), with the cluster-facing calls
 *     of drive.py replaced where the test is about the driver's own scheduling logic;
 *   - the in-pod JavaScript probes (dns-probe.js, first-request.mjs, warm-entry.mjs,
 *     bc-check.mjs, instrumentation-stub.js) under node and bun, with a preload that
 *     stands in for the one external thing each touches (the resolver, port 3000, the
 *     knext server package, a compiled executable).
 *
 * Nothing here names a cluster, an address or a secret.
 */

const ROOT = resolve(import.meta.dir, '..');

// Repo-relative paths are written out in full on purpose: the directory-scan guard in
// bench-cold-start-analyzers.test.ts treats a quoted occurrence of a script's path in a
// test file as "this script has a test".
const SCRIPT_DIR = 'scripts/bench-cold-start-phases';
const STABILITY_DRIVE = 'scripts/bench-cold-start-phases/baseline-stability-drive.py';
const DNS_PROBE = 'scripts/bench-cold-start-phases/dns-probe.js';
const FIRST_REQUEST = 'scripts/bench-cold-start-phases/gke/first-request.mjs';
const BC_CHECK = 'scripts/bench-cold-start-phases/gke/variants/bc-check.mjs';
const WARM_ENTRY = 'scripts/bench-cold-start-phases/gke/variants/warm-entry.mjs';
const STUB = 'scripts/bench-cold-start-phases/gke/variants/instrumentation-stub.js';
const VERIFIER = 'packages/kn-next/src/adapters/bytecode-exec-verify.mjs';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'bench-drivers-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = net.createServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => ok(port));
    });
  });
}

// ---------------------------------------------------------------------------------------
// baseline-stability-drive.py
// ---------------------------------------------------------------------------------------

/** A kubectl that answers the two read-only calls snap() makes, and can be made to fail. */
const FAKE_KUBECTL = `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_KUBECTL_LOG"], "a") as f:
    f.write(json.dumps(args) + "\\n")
joined = " ".join(args)
if "--raw" in args:
    if "/nodes/n3/" in joined:
        sys.stderr.write("boom: forbidden\\n")
        sys.exit(1)
    print(json.dumps({
        "node": {"cpu": {"usageNanoCores": 1234, "psi": {"some": {"avg10": 0.5}}},
                 "memory": {"workingSetBytes": 999}},
        "pods": [
            {"podRef": {"namespace": "bench-cells", "name": "z-pod"}, "cpu": {"usageNanoCores": 500}},
            {"podRef": {"namespace": "kube-system", "name": "dns"}, "cpu": {"usageNanoCores": 900}},
            {"podRef": {"namespace": "bench-cells", "name": "a-pod"}, "cpu": {"usageNanoCores": 100}},
            {"podRef": {"namespace": "bench-cells", "name": "no-cpu"}},
        ],
    }))
elif "pods" in args:
    def pod(ns, name, phase):
        return {"metadata": {"namespace": ns, "name": name}, "status": {"phase": phase}}
    print(json.dumps({"items": [
        pod("bench-cells", "z-pod", "Running"), pod("bench-cells", "a-pod", "Running"),
        pod("kube-system", "dns", "Running"), pod("bench-cells", "pending-pod", "Pending"),
    ]}))
`;

/** Loads the hyphenated driver module, then runs one of two scenarios against it. */
const HARNESS = `
import importlib.util, json, os, sys
scripts = sys.argv[1]
sys.path.insert(0, scripts)
spec = importlib.util.spec_from_file_location("bsd", sys.argv[2])
bsd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bsd)
mode = sys.argv[3]
if mode == "snap":
    print(json.dumps({"nodes": bsd.NODES, "ns": bsd.NS, "n1": bsd.snap("n1"), "n3": bsd.snap("n3"),
                      "snaps": sorted(bsd.snaps())}))
else:
    drive = bsd.drive
    sleeps = []
    bsd.time.sleep = sleeps.append
    drive.install_harness = lambda: None
    drive.wait_zero = lambda arms: 42
    drive.wake = lambda arm, dns, tag: {"arm": arm, "node": "n1", "watch": {"resp_end": 1}}
    bsd.snap = lambda node: {"node": node}
    sys.argv = ["baseline-stability-drive.py"] + sys.argv[4:]
    bsd.main()
    print(json.dumps({"sleeps": sleeps}))
`;

function runDriver(
  mode: 'snap' | 'main',
  extra: string[] = [],
): { out: Record<string, unknown>; rows: Record<string, unknown>[]; calls: string[][] } {
  return withTmp((dir) => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'kubectl'), FAKE_KUBECTL);
    chmodSync(join(bin, 'kubectl'), 0o755);
    const log = join(dir, 'kubectl.log');
    writeFileSync(log, '');
    const cfg = join(dir, 'config.json');
    writeFileSync(cfg, '{}');
    const harness = join(dir, 'harness.py');
    writeFileSync(harness, HARNESS);
    const outFile = join(dir, 'rows.jsonl');
    const r = spawnSync(
      'python3',
      [
        harness,
        join(ROOT, SCRIPT_DIR),
        join(ROOT, STABILITY_DRIVE),
        mode,
        ...extra.map((a) => a.replace('$OUT', outFile)),
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: dir,
          PYTHONDONTWRITEBYTECODE: '1',
          FAKE_KUBECTL_LOG: log,
          KNEXT_BENCH_CONFIG: cfg,
          KNEXT_BENCH_NAMESPACE: 'bench-cells',
          KNEXT_BENCH_AGENT_PODS: JSON.stringify({ n2: 'agent-2', n1: 'agent-1' }),
        },
      },
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const rows = readRows(outFile);
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
    return { out: JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}'), rows, calls };
  });
}

function readRows(file: string): Record<string, unknown>[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('baseline-stability-drive.py: read-only node snapshots', () => {
  const { out, calls } = runDriver('snap');
  const n1 = out.n1 as Record<string, unknown>;

  it('takes its node list and namespace from the bench settings, sorted', () => {
    expect(out.nodes).toEqual(['n1', 'n2']);
    expect(out.ns).toBe('bench-cells');
    expect(out.snaps).toEqual(['n1', 'n2']);
  });

  it('turns the kubelet summary and the pod list into one snapshot', () => {
    expect(n1).toMatchObject({
      node_cpu_nc: 1234,
      psi_cpu_some_avg10: 0.5,
      node_mem_ws: 999,
      // 3 Running pods on the node (the Pending one is not counted), 2 of them in bench-cells.
      n_running: 3,
      n_running_bench_cells: 2,
      running_bench_cells: ['a-pod', 'z-pod'],
    });
    expect(typeof n1.t).toBe('number');
  });

  it('lists the busiest pods first and skips a pod with no cpu block', () => {
    expect(n1.top_cpu).toEqual([
      ['kube-system/dns', 900],
      ['bench-cells/z-pod', 500],
      ['bench-cells/a-pod', 100],
    ]);
  });

  it('records a failed read as an error entry instead of aborting the run', () => {
    const n3 = out.n3 as Record<string, string>;
    expect(Object.keys(n3)).toEqual(['error']);
    expect(n3.error.length).toBeGreaterThan(0);
    expect(n3.error.length).toBeLessThanOrEqual(120);
  });

  it('only reads: the calls are a summary GET and a pod list scoped to the node', () => {
    const verbs = new Set(
      calls.map((c) =>
        c.find((a) =>
          ['get', 'create', 'patch', 'delete', 'apply', 'scale', 'exec', 'cordon'].includes(a),
        ),
      ),
    );
    expect([...verbs]).toEqual(['get']);
    expect(calls.some((c) => c.includes('/api/v1/nodes/n1/proxy/stats/summary'))).toBe(true);
    expect(
      calls.some((c) => c.includes('spec.nodeName=n1') && c.includes('--field-selector')),
    ).toBe(true);
  });
});

describe('baseline-stability-drive.py: round schedule', () => {
  // 4 rounds of two arms. Drive's cluster calls are replaced, so this is the driver's own logic.
  const { out, rows } = runDriver('main', ['4', 'tgt,cmp', '$OUT', '--long=150']);

  it('wakes both arms every round and rotates which goes first', () => {
    expect(rows.length).toBe(8);
    const armsByRound = (r: number) => rows.filter((x) => x.round === r).map((x) => x.arm);
    expect(armsByRound(1)).toEqual(['tgt', 'cmp']);
    expect(armsByRound(2)).toEqual(['cmp', 'tgt']);
    expect(armsByRound(3)).toEqual(['tgt', 'cmp']);
    expect(armsByRound(4)).toEqual(['cmp', 'tgt']);
    expect(rows.filter((x) => x.round === 2).map((x) => x.slot)).toEqual([0, 1]);
  });

  it('labels the order fwd on odd rounds and rev on even rounds', () => {
    expect(rows.map((x) => x.order)).toEqual([
      'fwd',
      'fwd',
      'rev',
      'rev',
      'fwd',
      'fwd',
      'rev',
      'rev',
    ]);
  });

  it('alternates wake spacing in blocks of two rounds and idles longer on the long ones', () => {
    expect(rows.map((x) => x.spacing)).toEqual([
      'short',
      'short',
      'short',
      'short',
      'long',
      'long',
      'long',
      'long',
    ]);
    expect(rows.map((x) => x.extra_idle_s)).toEqual([0, 0, 0, 0, 150, 150, 150, 150]);
    // one settle sleep per round: 10 s, or 10 s + the extra idle on a long round.
    expect(out.sleeps).toEqual([10, 10, 160, 160]);
  });

  it('records the zero-pod wait and a before/after snapshot of every node on each wake', () => {
    for (const row of rows) {
      expect(row.waited_s).toBe(42);
      expect(row.treatment).toBe('none');
      expect(row.bg_pre).toEqual({ n1: { node: 'n1' }, n2: { node: 'n2' } });
      expect(row.bg_post).toEqual({ n1: { node: 'n1' }, n2: { node: 'n2' } });
    }
  });
});

// ---------------------------------------------------------------------------------------
// In-pod JavaScript probes
// ---------------------------------------------------------------------------------------

/** The runtimes the images ship: node and bun. */
const RUNTIMES: [string, string][] = [
  ['node', 'node'],
  ['bun', process.execPath],
];

describe('dns-probe.js: resolver timing from inside the app container', () => {
  const PRELOAD = `
const dns = require('node:dns');
dns.lookup = (name, cb) =>
  setImmediate(() =>
    name.startsWith('kubernetes')
      ? cb(null, '10.0.0.1')
      : cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })),
  );
const fs = require('node:fs');
const read = fs.readFileSync;
fs.readFileSync = (p, ...rest) =>
  p === '/etc/resolv.conf'
    ? 'search svc.cluster.local cluster.local\\noptions ndots:5\\nnameserver 10.96.0.10\\n# note\\nunrelated line\\n'
    : read(p, ...rest);
`;

  for (const [name, exe] of RUNTIMES) {
    it(`prints one JSON line of per-name timings under ${name}`, () => {
      withTmp((dir) => {
        const stub = join(dir, 'stub.cjs');
        writeFileSync(stub, PRELOAD);
        const r = spawnSync(exe, ['-r', stub, join(ROOT, DNS_PROBE)], {
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(r.status).toBe(0);
        const lines = r.stdout.trim().split('\n');
        expect(lines.length).toBe(1);
        const out = JSON.parse(lines[0]);
        expect(out.runtime).toBe(name);
        // the unrooted FQDN, the rooted FQDN and the short name resolve; they are timings in ms.
        for (const n of [
          'kubernetes.default.svc.cluster.local.',
          'kubernetes.default.svc.cluster.local',
          'kubernetes.default',
        ]) {
          expect(typeof out[n]).toBe('number');
          expect(out[n]).toBeGreaterThanOrEqual(0);
        }
        // a lookup that fails is recorded with its error code and elapsed ms, not dropped.
        for (const n of ['registry.npmjs.org', 'registry.npmjs.org.'])
          expect(out[n]).toMatch(/^ERR ENOTFOUND \d+ms$/);
        // only the search/options/nameserver lines of resolv.conf are kept.
        expect(out.resolv).toBe(
          'search svc.cluster.local cluster.local | options ndots:5 | nameserver 10.96.0.10',
        );
      });
    });
  }
});

describe('gke/first-request.mjs: first-request micro-trace', () => {
  // Port 3000 is hard-coded in the probe, so a preload points it at a free port instead of
  // touching whatever a developer has on 3000.
  const PRELOAD = `
const net = require('node:net');
const connect = net.connect;
net.connect = (port, ...rest) => connect(port === 3000 ? Number(process.env.FAKE_PORT) : port, ...rest);
const f = globalThis.fetch;
globalThis.fetch = (u, ...rest) => f(String(u).replace(':3000', ':' + process.env.FAKE_PORT), ...rest);
`;
  const SERVER = `
import http from 'node:http';
console.log('[compile cache] a.js was accepted');
console.log('[compile cache] b.js was accepted');
console.log('[compile cache] c.js was rejected');
console.log('[compile cache] d.js version mismatch');
http
  .createServer((req, res) => {
    res.statusCode = req.url === '/missing' ? 404 : 200;
    res.end('ok');
  })
  .listen(Number(process.env.FAKE_PORT), '127.0.0.1');
process.on('SIGINT', () => process.exit(0));
`;

  for (const [name, exe] of RUNTIMES) {
    it(`times /api/health and / twice each, and counts compile-cache log lines, under ${name}`, async () => {
      const port = await freePort();
      withTmp((dir) => {
        writeFileSync(join(dir, 'stub.cjs'), PRELOAD);
        writeFileSync(join(dir, 'server.mjs'), SERVER);
        const r = spawnSync(
          exe,
          [
            '-r',
            join(dir, 'stub.cjs'),
            join(ROOT, FIRST_REQUEST),
            '--gap=50',
            'node',
            join(dir, 'server.mjs'),
          ],
          { encoding: 'utf8', timeout: 60_000, env: { ...process.env, FAKE_PORT: String(port) } },
        );
        expect(r.status).toBe(0);
        const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
        // --gap is consumed by the probe and is not part of the server command.
        expect(out.cmd).toBe(`node ${join(dir, 'server.mjs')}`);
        expect(out.listen_ms).toBeGreaterThanOrEqual(0);
        for (const k of ['health1', 'health2', 'root1', 'root2']) {
          expect(out[k].status).toBe(200);
          expect(out[k].ms).toBeGreaterThanOrEqual(0);
        }
        // four log lines mention the compile cache; two were accepted; "rejected" and
        // "mismatch" are the two failures counted.
        expect(out.compile_cache_lines).toBe(4);
        expect(out.cc_accepted).toBe(2);
        expect(out.cc_rejected).toBe(2);
      });
    }, 60_000);
  }
});

describe('gke/variants/warm-entry.mjs: warm-before-ready prototype', () => {
  /** A stand-in for the knext server package: it starts listening 200 ms after import. */
  const NODE_SERVER = `
import http from 'node:http';
setTimeout(() => {
  http
    .createServer((req, res) => {
      res.statusCode = req.url === '/health' ? 200 : 404;
      res.end('ok');
    })
    .listen(Number(process.env.PORT), '127.0.0.1');
}, 200);
setTimeout(() => process.exit(0), 1200);
`;

  function run(exe: string, port: number, env: Record<string, string>) {
    return withTmp((dir) => {
      const pkg = join(dir, 'node_modules/@getknext/core');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, 'package.json'),
        JSON.stringify({
          name: '@getknext/core',
          type: 'module',
          exports: { './internal/node-server': './node-server.mjs' },
        }),
      );
      writeFileSync(join(pkg, 'node-server.mjs'), NODE_SERVER);
      copyFileSync(join(ROOT, WARM_ENTRY), join(dir, 'entry.mjs'));
      const r = spawnSync(exe, [join(dir, 'entry.mjs')], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, PORT: String(port), ...env },
      });
      return r;
    });
  }

  for (const [name, exe] of RUNTIMES) {
    it(`polls the health path until the first 200 and logs how long that took, under ${name}`, async () => {
      const r = run(exe, await freePort(), { KNEXT_WARM_PATH: '/health' });
      expect(r.status).toBe(0);
      const line = r.stdout.split('\n').find((l) => l.includes('knext-bench warm-up 200'));
      expect(line).toBeDefined();
      const out = JSON.parse(line ?? '{}');
      expect(out.path).toBe('/health');
      // the server only starts listening 200 ms after the import, so the loop had to retry.
      expect(out.tries).toBeGreaterThan(1);
      expect(out.ms).toBeGreaterThanOrEqual(150);
      expect(out.ms).toBeLessThan(1200);
    });

    it(`keeps polling, and reports nothing, while the path never returns 2xx, under ${name}`, async () => {
      const r = run(exe, await freePort(), { KNEXT_WARM_PATH: '/missing' });
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('warm-up 200');
    });
  }
});

describe('gke/variants/instrumentation-stub.js: no-op instrumentation entry', () => {
  it('exports an async register() that resolves to nothing', async () => {
    const stub = await import(join(ROOT, STUB));
    const register = (stub.default ?? stub).register;
    expect(register.constructor.name).toBe('AsyncFunction');
    expect(await register()).toBeUndefined();
  });
});

describe('gke/variants/bc-check.mjs: bytecode proof for a compiled executable', () => {
  const MARKER = `knext-standalone-exec:${'0123456789abcdef01234567'}`;

  function check(binary: Buffer): { stdout: string; status: number } {
    return withTmp((dir) => {
      // the image copies the verifier next to bc-check.mjs, so the test does the same.
      copyFileSync(join(ROOT, BC_CHECK), join(dir, 'bc-check.mjs'));
      copyFileSync(join(ROOT, VERIFIER), join(dir, 'bytecode-exec-verify.mjs'));
      const exe = join(dir, 'exec');
      writeFileSync(exe, binary);
      const r = spawnSync('node', [join(dir, 'bc-check.mjs'), exe], { encoding: 'utf8' });
      return { stdout: r.stdout, status: r.status ?? -1 };
    });
  }

  const pad = Buffer.alloc(64, 0);
  // The constant-pool copy of the marker sits well outside the 4096-character window under
  // the module pragma, as it does in a real compile; inside it, it would read as a second source.
  const farPad = Buffer.alloc(8192, 0);
  const bytecodeBinary = Buffer.concat([
    pad,
    Buffer.from(`// @bun @bytecode @bun-cjs\n(function(){/* ${MARKER} */})\n`, 'latin1'),
    farPad,
    Buffer.from(`const pool=["${MARKER}"]`, 'latin1'),
    pad,
  ]);
  const plainBinary = Buffer.concat([
    pad,
    Buffer.from(`// @bun @bun-cjs\n(function(){/* ${MARKER} */})\n`, 'latin1'),
    pad,
  ]);

  it('passes a binary whose entry sits under an @bytecode pragma and has a constant-pool copy', () => {
    const r = check(bytecodeBinary);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.bytes).toBe(bytecodeBinary.length);
    expect(out.sha256).toBe(createHash('sha256').update(bytecodeBinary).digest('hex'));
    expect(out.markers).toEqual([MARKER]);
    expect(out.pragma_bytecode).toBe(1);
    expect(out.pragma_plain).toBe(0);
    expect(out.verdicts).toEqual([{ marker: MARKER, ok: true }]);
  });

  it('fails a binary compiled without bytecode, naming the pragma it found', () => {
    const out = JSON.parse(check(plainBinary).stdout);
    expect(out.pragma_bytecode).toBe(0);
    expect(out.pragma_plain).toBe(1);
    expect(out.verdicts[0].ok).toBe(false);
    expect(out.verdicts[0].reason).toContain('no @bytecode');
  });

  it('reports no marker, and no verdict, for an executable knext did not compile', () => {
    const out = JSON.parse(check(Buffer.from('just some other binary')).stdout);
    expect(out.markers).toEqual([]);
    expect(out.verdicts).toEqual([]);
  });
});
