import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/**
 * The in-cluster A/B drivers (bunexec-ab-incluster.py, prepull-ab-incluster.py,
 * burst-ab-incluster.py) write the JSONL that the matching analyzers read, so what they
 * record is the contract a benchmark claim rests on: which pod counts as "the cold pod",
 * whether a pull happened inside the cycle, how a failed events fetch is marked, how long
 * a pull took. They shell out to kubectl at import time, so they cannot run here against a
 * cluster; each function is run for real instead, against a scripted `kubectl` on PATH
 * that replays recorded-shape API responses and logs every call it receives.
 *
 * Cluster facts (namespace, node-agent pods) arrive through the same KNEXT_BENCH_*
 * settings the real drivers use. Nothing here names a real cluster or address.
 */

const ROOT = resolve(import.meta.dir, '..');

// Repo-relative paths are written out in full on purpose: the directory-scan guard in
// bench-cold-start-analyzers.test.ts treats a quoted occurrence of a script's path in a
// test file as "this script has a test".
const SCRIPT_DIR = 'scripts/bench-cold-start-phases';
const BUNEXEC = 'scripts/bench-cold-start-phases/bunexec-ab-incluster.py';
const PREPULL = 'scripts/bench-cold-start-phases/prepull-ab-incluster.py';
const BURST = 'scripts/bench-cold-start-phases/burst-ab-incluster.py';

/** Replays the first rule whose `match` is a substring of the argv; each rule can list a
 * sequence of responses (the last repeats). Logs argv. Fails loudly on an unscripted call. */
const FAKE_KUBECTL = `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
joined = " ".join(args)
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(json.dumps(args) + "\\n")
rules = json.load(open(os.environ["FAKE_RULES"]))
state_path = os.environ["FAKE_STATE"]
state = json.load(open(state_path)) if os.path.exists(state_path) else {}
for i, rule in enumerate(rules):
    if rule["match"] in joined:
        seq = rule["responses"]
        n = state.get(str(i), 0)
        state[str(i)] = n + 1
        json.dump(state, open(state_path, "w"))
        r = seq[min(n, len(seq) - 1)]
        sys.stdout.write(r.get("stdout", ""))
        sys.stderr.write(r.get("stderr", ""))
        sys.exit(r.get("rc", 0))
sys.stderr.write("fake kubectl: no rule for: " + joined + "\\n")
sys.exit(2)
`;

/** Loads one driver by path, runs a snippet with the module bound to \`m\`, prints \`result\`. */
const HARNESS = `
import importlib.util, json, os, sys, time
scripts = sys.argv[1]
sys.path.insert(0, scripts)
time.sleep = lambda s: None  # nothing in a test may actually wait
spec = importlib.util.spec_from_file_location("m", os.path.join(scripts, sys.argv[2]))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
ns = {"m": m, "json": json, "time": time, "os": os, "sys": sys}
exec(sys.argv[3], ns)
print("RESULT:" + json.dumps(ns.get("result"), default=str))
`;

type Resp = { rc?: number; stdout?: string; stderr?: string };
type Rule = { match: string; responses: Resp[] };

const json = (o: unknown): Resp => ({ stdout: JSON.stringify(o) });
const rule = (match: string, ...responses: Resp[]): Rule => ({ match, responses });

interface Run {
  // biome-ignore lint/suspicious/noExplicitAny: the snippet decides the shape
  result: any;
  calls: string[][];
  err: string;
  status: number;
}

function runDriver(
  script: string,
  snippet: string,
  rules: Rule[] = [],
  env: Record<string, string> = {},
  files: Record<string, string> = {},
): Run {
  const dir = mkdtempSync(join(tmpdir(), 'bench-incluster-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'kubectl'), FAKE_KUBECTL);
    chmodSync(join(bin, 'kubectl'), 0o755);
    const log = join(dir, 'kubectl.log');
    writeFileSync(log, '');
    writeFileSync(join(dir, 'rules.json'), JSON.stringify(rules));
    writeFileSync(join(dir, 'config.json'), '{}');
    writeFileSync(join(dir, 'harness.py'), HARNESS);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const r = spawnSync(
      'python3',
      [
        join(dir, 'harness.py'),
        join(ROOT, SCRIPT_DIR),
        basename(script),
        snippet.replaceAll('$DIR', dir),
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: dir,
          PYTHONDONTWRITEBYTECODE: '1',
          FAKE_LOG: log,
          FAKE_RULES: join(dir, 'rules.json'),
          FAKE_STATE: join(dir, 'state.json'),
          KNEXT_BENCH_CONFIG: join(dir, 'config.json'),
          KNEXT_BENCH_NAMESPACE: 'bench-cells',
          KNEXT_BENCH_AGENT_PODS: JSON.stringify({ n2: 'agent-2', n1: 'agent-1' }),
          ...env,
        },
      },
    );
    // A snippet that fails is a broken test, not a result: surface Python's own message.
    if (r.status !== 0) throw new Error(`harness exited ${r.status}: ${r.stderr.slice(-1500)}`);
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT:'));
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
    return {
      result: line ? JSON.parse(line.slice('RESULT:'.length)) : undefined,
      calls,
      err: r.stderr,
      status: r.status ?? -1,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------- recorded-shape objects

const pod = (
  name: string,
  created: string,
  over: { host?: string; node?: string; ready?: string } = {},
) => ({
  metadata: {
    name,
    creationTimestamp: created,
    labels: {
      'apps.kn-next.dev/build-id': 'b7',
      'serving.knative.dev/revision': 'rev-1',
    },
  },
  spec: { nodeName: over.node ?? 'n1' },
  status: {
    hostIP: over.host ?? '10.0.0.5',
    conditions: [
      { type: 'PodScheduled', lastTransitionTime: '2026-01-01T00:00:01Z' },
      { type: 'Ready', lastTransitionTime: over.ready ?? '2026-01-01T00:00:09Z' },
    ],
    containerStatuses: [
      { name: 'queue-proxy', imageID: 'qp@sha256:qp', state: { running: { startedAt: 'x' } } },
      {
        name: 'user-container',
        imageID: 'img@sha256:abc',
        state: { running: { startedAt: '2026-01-01T00:00:05Z' } },
      },
    ],
  },
});

const events = [
  { reason: 'Scheduled', message: 'Successfully assigned bench-cells/new to n1' },
  {
    reason: 'Pulling',
    message: 'Pulling image "ghcr.io/x@sha256:abc"',
    firstTimestamp: '2026-01-01T00:00:02Z',
  },
  {
    reason: 'Pulled',
    message: 'Successfully pulled image "ghcr.io/x@sha256:abc" in 1.5s (1.5s including waiting)',
  },
];

const POD_RULES = (arm: string, items: unknown[]): Rule =>
  rule(`get pods -l serving.knative.dev/service=${arm}`, json({ items }));

// ---------------------------------------------------------------------------------------
// bunexec-ab-incluster.py
// ---------------------------------------------------------------------------------------

describe('bunexec-ab-incluster.py: evidence for one cold cycle', () => {
  const OLD = pod('old', '2026-01-01T00:00:00Z');
  const NEW = pod('new', '2026-01-01T00:00:01Z', { ready: '2026-01-01T00:00:09Z' });

  it('records the newest pod, its image, build, timestamps and pull events', () => {
    const r = runDriver(BUNEXEC, 'result = m.pod_evidence("arm-a", 0)', [
      POD_RULES('arm-a', [OLD, NEW]),
      rule('involvedObject.name=new', json({ items: events })),
    ]);
    expect(r.status).toBe(0);
    expect(r.result).toEqual({
      pod: 'new',
      node: 'n1',
      image_id: 'img@sha256:abc',
      build_id: 'b7',
      created: '2026-01-01T00:00:01Z',
      container_started: '2026-01-01T00:00:05Z',
      ready: '2026-01-01T00:00:09Z',
      // only events whose reason starts with "Pull" are kept, message cut at 160 chars
      pull_events: [
        'Pulling image "ghcr.io/x@sha256:abc"',
        'Successfully pulled image "ghcr.io/x@sha256:abc" in 1.5s (1.5s including waiting)',
      ],
      events_n: 3,
      events_invalid: false,
    });
    // the events query is scoped to the newest pod, never the old one
    expect(r.calls.some((c) => c.join(' ').includes('involvedObject.name=new'))).toBe(true);
    expect(r.calls.some((c) => c.join(' ').includes('involvedObject.name=old'))).toBe(false);
  });

  it('reads the user container, not the queue-proxy, when the sidecar is listed first', () => {
    const r = runDriver(BUNEXEC, 'result = m.pod_evidence("arm-a", 0)', [
      POD_RULES('arm-a', [NEW]),
      rule('involvedObject.name=new', json({ items: [] })),
    ]);
    expect(r.result.image_id).toBe('img@sha256:abc');
    expect(r.result.events_n).toBe(0);
    expect(r.result.pull_events).toEqual([]);
  });

  it('marks the row events_invalid when the events fetch fails: a failed fetch is not "no pull"', () => {
    const r = runDriver(BUNEXEC, 'result = m.pod_evidence("arm-a", 0)', [
      POD_RULES('arm-a', [NEW]),
      rule('involvedObject.name=new', { rc: 1, stderr: 'forbidden' }),
    ]);
    expect(r.result).toMatchObject({
      pod: 'new',
      events_invalid: true,
      events_n: 0,
      pull_events: [],
    });
  });

  it('marks the row events_invalid when the events reply is not JSON', () => {
    const r = runDriver(BUNEXEC, 'result = m.pod_evidence("arm-a", 0)', [
      POD_RULES('arm-a', [NEW]),
      rule('involvedObject.name=new', { stdout: 'not json' }),
    ]);
    expect(r.result.events_invalid).toBe(true);
  });

  it('returns {pod: None} when the arm has no pod', () => {
    const r = runDriver(BUNEXEC, 'result = m.pod_evidence("arm-a", 0)', [POD_RULES('arm-a', [])]);
    expect(r.result).toEqual({ pod: null });
  });

  it('writes exactly the evidence fields bunexec-ab-analyze.py reads', () => {
    const r = runDriver(BUNEXEC, 'result = sorted(m.pod_evidence("arm-a", 0))', [
      POD_RULES('arm-a', [NEW]),
      rule('involvedObject.name=new', json({ items: events })),
    ]);
    for (const k of [
      'pod',
      'node',
      'image_id',
      'build_id',
      'pull_events',
      'created',
      'container_started',
      'ready',
      'events_invalid',
    ])
      expect(r.result).toContain(k);
  });
});

describe('bunexec-ab-incluster.py: kubectl retries', () => {
  it('retries a transient apiserver failure and returns the first good answer', () => {
    const r = runDriver(BUNEXEC, 'result = len(m.pods("arm-a"))', [
      rule(
        'get pods',
        { rc: 1, stderr: 'Unable to connect to the server: EOF' },
        { rc: 1, stderr: 'dial tcp: i/o timeout' },
        json({ items: [{ a: 1 }] }),
      ),
    ]);
    expect(r.result).toBe(1);
    expect(r.calls.length).toBe(3);
  });

  it('does not retry a failure that is not transient, and raises when checked', () => {
    const r = runDriver(
      BUNEXEC,
      `
import subprocess
try:
    m.kc(["get", "pods"])
    result = "no error"
except subprocess.CalledProcessError as e:
    result = e.returncode
`,
      [rule('get pods', { rc: 1, stderr: 'forbidden' }, json({ items: [] }))],
    );
    expect(r.result).toBe(1);
    expect(r.calls.length).toBe(1);
  });

  it('gives up after five transient failures and hands the failure back when unchecked', () => {
    const r = runDriver(BUNEXEC, 'result = m.kc(["get", "pods"], check=False).returncode', [
      rule('get pods', { rc: 1, stderr: 'TLS handshake timeout' }),
    ]);
    expect(r.result).toBe(1);
    expect(r.calls.length).toBe(5);
  });
});

describe('bunexec-ab-incluster.py: waiting, probing, and the round loop', () => {
  it('wait_zero gives up loudly when the deadline passes', () => {
    const r = runDriver(
      BUNEXEC,
      `
try:
    m.wait_zero(["arm-a"], timeout=-1)
    result = "returned"
except SystemExit as e:
    result = str(e)
`,
      [],
    );
    expect(r.result).toBe('timeout waiting for zero pods');
  });

  it('wait_zero polls until the pods are gone', () => {
    const one = json({ items: [{}] });
    const none = json({ items: [] });
    const r = runDriver(BUNEXEC, 'result = m.wait_zero(["arm-a"])', [
      rule('get pods -l serving.knative.dev/service=arm-a', one, one, none),
    ]);
    expect(r.result).toBe(0);
    expect(r.calls.length).toBe(3);
  });

  it('alternates the probing source across the node agents, sorted by node name', () => {
    const at = (t: number) =>
      runDriver(BUNEXEC, `m.time.time = lambda: ${t}\nresult = m.pick_agent()`).result;
    expect(at(100)).toBe('agent-1');
    expect(at(101)).toBe('agent-2');
  });

  it('refuses to probe when no node agents are configured', () => {
    const r = runDriver(
      BUNEXEC,
      `
try:
    m.pick_agent()
    result = "returned"
except SystemExit as e:
    result = str(e)
`,
      [],
      { KNEXT_BENCH_AGENT_PODS: '{}' },
    );
    expect(r.result).toContain('no node agents configured');
  });

  it('probe execs the timer inside an agent against the in-cluster service name', () => {
    const row = { cold: { code: 200, ms: 812.4, bytes: 5 }, warm: [{ code: 200, ms: 3 }] };
    const r = runDriver(BUNEXEC, 'm.time.time = lambda: 100\nresult = list(m.probe("arm-a"))', [
      rule('exec', { stdout: `noise line\n${JSON.stringify(row)}\n` }),
    ]);
    expect(r.result[0]).toEqual({ ...row, agent: 'agent-1' });
    expect(r.result[1]).toBe(100);
    const exec = r.calls.find((c) => c.includes('exec')) ?? [];
    expect(exec).toContain('agent-1');
    expect(exec).toContain('TARGET=http://arm-a.bench-cells.svc.cluster.local/');
  });

  it('probe returns the tail of stderr as an error row when the timer printed nothing', () => {
    const r = runDriver(BUNEXEC, 'm.time.time = lambda: 101\nresult = list(m.probe("arm-a"))', [
      rule('exec', { rc: 1, stderr: `${'x'.repeat(400)}tail-of-the-error` }),
    ]);
    expect(r.result[0].agent).toBe('agent-2');
    expect(r.result[0].error.length).toBe(300);
    expect(r.result[0].error.endsWith('tail-of-the-error')).toBe(true);
  });

  it('main alternates arm order per round and records AB/BA, the wait and the evidence', () => {
    const r = runDriver(
      BUNEXEC,
      `
m.wait_zero = lambda arms: 7
m.pods = lambda arm: []
m.probe = lambda arm: ({"cold": {"code": 200, "ms": 10.0}, "warm": [], "agent": "a"}, 1700000000.12345)
m.pod_evidence = lambda arm, t: {"pod": "p-" + arm}
sys.argv = ["x", "2", "arm-a", "arm-b", "$DIR/out.jsonl"]
m.main()
result = [json.loads(l) for l in open("$DIR/out.jsonl")]
`,
    );
    expect(r.status).toBe(0);
    expect(
      r.result.map((x: { arm: string; round: number; order: string }) => [x.round, x.arm, x.order]),
    ).toEqual([
      [1, 'arm-a', 'AB'],
      [1, 'arm-b', 'AB'],
      [2, 'arm-b', 'BA'],
      [2, 'arm-a', 'BA'],
    ]);
    expect(r.result[0]).toMatchObject({
      waited_s: 7,
      t_req_epoch: 1700000000.123,
      evidence: { pod: 'p-arm-a' },
    });
  });

  it('main refuses to take a cold measurement from an arm that has not scaled to zero', () => {
    const r = runDriver(
      BUNEXEC,
      `
m.wait_zero = lambda arms: 0
m.pods = lambda arm: [{}] if arm == "arm-b" else []
m.probe = lambda arm: ({"cold": {"code": 200, "ms": 1.0}, "warm": []}, 1.0)
m.pod_evidence = lambda arm, t: {"pod": "p"}
sys.argv = ["x", "1", "arm-a", "arm-b", "$DIR/out.jsonl"]
m.main()
result = [json.loads(l) for l in open("$DIR/out.jsonl")]
`,
    );
    expect(r.result[0]).toMatchObject({ arm: 'arm-a', evidence: { pod: 'p' } });
    expect(r.result[1]).toEqual({
      arm: 'arm-b',
      round: 1,
      error: 'not at zero before cold request',
    });
  });
});

// ---------------------------------------------------------------------------------------
// prepull-ab-incluster.py
// ---------------------------------------------------------------------------------------

describe('prepull-ab-incluster.py: evidence and kubelet pull durations', () => {
  const NEW = pod('new', '2026-01-01T00:00:01Z', { host: '10.0.0.9' });

  it('records pull timing from the Pulling and Pulled events, in seconds', () => {
    const r = runDriver(PREPULL, 'result = m.evidence("pp-u")', [
      POD_RULES('pp-u', [NEW]),
      rule('involvedObject.name=new', json({ items: events })),
    ]);
    expect(r.result).toMatchObject({
      pod: 'new',
      node: '10.0.0.9',
      revision: 'rev-1',
      image_id: 'img@sha256:abc',
      scheduled: '2026-01-01T00:00:01Z',
      container_started: '2026-01-01T00:00:05Z',
      ready: '2026-01-01T00:00:09Z',
      pulling_event: '2026-01-01T00:00:02Z',
      pulled_in_cycle: true,
      pull_duration_s: 1.5,
      events_n: 3,
      events_invalid: false,
    });
  });

  it('converts a millisecond pull time to seconds', () => {
    const ms = [
      { reason: 'Pulling', message: 'Pulling image "x"', firstTimestamp: 't' },
      {
        reason: 'Pulled',
        message: 'Successfully pulled image "x" in 800ms (800ms including waiting)',
      },
    ];
    const r = runDriver(PREPULL, 'result = m.evidence("pp-u")', [
      POD_RULES('pp-u', [NEW]),
      rule('involvedObject.name=new', json({ items: ms })),
    ]);
    expect(r.result.pull_duration_s).toBeCloseTo(0.8, 10);
  });

  it('reports a cache hit as not pulled in the cycle, with no pull duration', () => {
    const hit = [{ reason: 'Pulled', message: 'Container image "x" already present on machine' }];
    const r = runDriver(PREPULL, 'result = m.evidence("pp-u")', [
      POD_RULES('pp-u', [NEW]),
      rule('involvedObject.name=new', json({ items: hit })),
    ]);
    expect(r.result).toMatchObject({
      pulled_in_cycle: false,
      pull_duration_s: null,
      pulling_event: null,
    });
  });

  it('cuts event messages at 220 characters and flags a failed fetch as invalid', () => {
    const long = [{ reason: 'Other', message: 'm'.repeat(300) }];
    const a = runDriver(PREPULL, 'result = m.evidence("pp-u")', [
      POD_RULES('pp-u', [NEW]),
      rule('involvedObject.name=new', json({ items: long })),
    ]);
    expect(a.result.pull_events[0].msg.length).toBe(220);
    const b = runDriver(PREPULL, 'result = m.evidence("pp-u")', [
      POD_RULES('pp-u', [NEW]),
      rule('involvedObject.name=new', { rc: 1, stderr: 'forbidden' }),
    ]);
    expect(b.result).toMatchObject({ events_invalid: true, pulled_in_cycle: false, events_n: 0 });
  });

  it('deploy_pulls attributes each pull to its pod and node by digest', () => {
    const r = runDriver(PREPULL, 'result = m.deploy_pulls("sha256:abc", timeout=0)', [
      rule(
        'reason=Pulling',
        json({
          items: [
            {
              involvedObject: { name: 'pod-a' },
              message: 'Pulling image "ghcr.io/x@sha256:abc"',
              source: { host: 'n1' },
              firstTimestamp: '2026-01-01T00:00:02Z',
            },
            {
              involvedObject: { name: 'pod-other' },
              message: 'Pulling image "ghcr.io/x@sha256:zzz"',
              source: { host: 'n2' },
              firstTimestamp: '2026-01-01T00:00:03Z',
            },
          ],
        }),
      ),
      rule(
        'involvedObject.name=pod-a,reason=Pulled',
        json({ items: [{ message: 'Successfully pulled image "ghcr.io/x@sha256:abc" in 2.25s' }] }),
      ),
    ]);
    expect(r.result).toEqual([
      {
        pod: 'pod-a',
        node: 'n1',
        pull_started: '2026-01-01T00:00:02Z',
        pull_duration_s: 2.25,
      },
    ]);
  });

  it('deploy_pulls returns nothing, after its deadline, when no pull matches', () => {
    const r = runDriver(PREPULL, 'result = m.deploy_pulls("sha256:abc", timeout=0)', [
      rule('reason=Pulling', json({ items: [] })),
    ]);
    expect(r.result).toEqual([]);
  });

  it('names pre-pull pods by tag and node, lower-cased and cut to 63 characters', () => {
    const r = runDriver(
      PREPULL,
      'result = [m.pull_pod_name("R001-X", "10.0.1.169"), m.pull_pod_name("T" * 80, "10.0.1.7")]',
    );
    expect(r.result[0]).toBe('pp-pull-r001-x-169');
    expect(r.result[1].length).toBe(63);
    expect(r.result[1]).toBe(r.result[1].toLowerCase());
  });

  it('resumes after the highest round already in the output file', () => {
    const rows = [{ round: 1 }, { round: 3 }, { round: 2 }, {}]
      .map((x) => JSON.stringify(x))
      .join('\n');
    const r = runDriver(
      PREPULL,
      'result = [m.done_rounds("$DIR/out.jsonl"), m.done_rounds("$DIR/missing.jsonl")]',
      [],
      {},
      { 'out.jsonl': `${rows}\n` },
    );
    expect(r.result).toEqual([3, 0]);
  });

  it('wait_ready needs the Ready condition to have observed the current generation', () => {
    const app = (observed: number, status: string) =>
      json({
        metadata: { generation: 2 },
        status: { conditions: [{ type: 'Ready', status, observedGeneration: observed }] },
      });
    const r = runDriver(PREPULL, 'result = m.wait_ready("pp-p")', [
      // Ready=True but for the previous generation, then not ready yet, then ready for generation 2
      rule('get nextapp pp-p', app(1, 'True'), app(2, 'False'), app(2, 'True')),
    ]);
    expect(r.result).toBe(0);
    expect(r.calls.length).toBe(3);
    const t = runDriver(
      PREPULL,
      `
try:
    m.wait_ready("pp-p", timeout=-1)
    result = "returned"
except RuntimeError as e:
    result = str(e)
`,
    );
    expect(t.result).toBe('pp-p not Ready in -1s');
  });

  it('kube retries a transient failure and raises with the failing verb otherwise', () => {
    const r = runDriver(PREPULL, 'result = m.kube(["get", "x"]).stdout', [
      rule('get x', { rc: 1, stderr: 'connection reset by peer' }, { stdout: 'ok' }),
    ]);
    expect(r.result).toBe('ok');
    expect(r.calls.length).toBe(2);
    const e = runDriver(
      PREPULL,
      `
try:
    m.kube(["get", "x"])
    result = "returned"
except RuntimeError as ex:
    result = str(ex)
`,
      [rule('get x', { rc: 3, stderr: 'forbidden' })],
    );
    expect(e.result).toBe("kubectl ['get', 'x'] rc=3: forbidden");
    expect(e.calls.length).toBe(1);
  });

  it('applies and patches NextApps with strict validation and a digest-pinned image', () => {
    const r = runDriver(
      PREPULL,
      'm.ensure_nextapp("pp-p", "sha256:abc", "t1"); m.patch_nextapp("pp-p", "sha256:def", "t2"); result = 1',
      [rule('apply', { stdout: '' }), rule('patch', { stdout: '' })],
    );
    const apply = r.calls.find((c) => c.includes('apply')) ?? [];
    expect(apply).toContain('--validate=strict');
    const patch = r.calls.find((c) => c.includes('patch')) ?? [];
    const body = JSON.parse(patch[patch.indexOf('-p') + 1]);
    expect(body.spec.image).toMatch(/@sha256:def$/);
    expect(body.spec).toMatchObject({ buildId: 't2', scaling: { maxScale: 1 } });
    // never an unpinned or :latest image
    expect(body.spec.image).not.toContain(':latest');
  });
});

// ---------------------------------------------------------------------------------------
// burst-ab-incluster.py
// ---------------------------------------------------------------------------------------

describe('burst-ab-incluster.py: scale-out burst driver', () => {
  it('builds the NextApp spec: digest-pinned, concurrency 1, imagePrewarm per arm', () => {
    const r = runDriver(
      BURST,
      'result = [m.nextapp_body("sha256:abc", "b1", True), m.nextapp_body("sha256:abc", "b1", False)]',
    );
    const [on, off] = r.result;
    expect(on.spec.image).toMatch(/@sha256:abc$/);
    expect(on.spec.scaling).toEqual({ maxScale: 4, containerConcurrency: 1, imagePrewarm: true });
    expect(off.spec.scaling.imagePrewarm).toBe(false);
    expect(on.spec.env).toEqual({ NEXT_DEPLOYMENT_ID: 'b1' });
  });

  it('pods_detail records, per pod, whether it pulled in the cycle and how long the pull took', () => {
    const pulled = pod('pa', '2026-01-01T00:00:01Z', { host: '10.0.0.5' });
    const cached = pod('pb', '2026-01-01T00:00:02Z', { host: '10.0.0.6' });
    const r = runDriver(BURST, 'result = m.pods_detail("pb-on")', [
      POD_RULES('pb-on', [pulled, cached]),
      rule('involvedObject.name=pa', json({ items: events })),
      rule(
        'involvedObject.name=pb',
        json({
          items: [{ reason: 'Pulled', message: 'Container image "x" already present on machine' }],
        }),
      ),
    ]);
    expect(r.result).toEqual([
      {
        pod: 'pa',
        node: '10.0.0.5',
        created: '2026-01-01T00:00:01Z',
        scheduled: '2026-01-01T00:00:01Z',
        ready: '2026-01-01T00:00:09Z',
        pulled_in_cycle: true,
        pulling_event: '2026-01-01T00:00:02Z',
        pull_duration_s: 1.5,
        events_n: 3,
        events_invalid: false,
      },
      {
        pod: 'pb',
        node: '10.0.0.6',
        created: '2026-01-01T00:00:02Z',
        scheduled: '2026-01-01T00:00:01Z',
        ready: '2026-01-01T00:00:09Z',
        pulled_in_cycle: false,
        pulling_event: null,
        pull_duration_s: null,
        events_n: 1,
        events_invalid: false,
      },
    ]);
  });

  it('pods_detail marks a pod invalid when its events cannot be read, instead of calling it cached', () => {
    const r = runDriver(BURST, 'result = m.pods_detail("pb-on")', [
      POD_RULES('pb-on', [pod('pa', '2026-01-01T00:00:01Z')]),
      rule('involvedObject.name=pa', { rc: 1, stderr: 'forbidden' }),
    ]);
    expect(r.result[0]).toMatchObject({
      pulled_in_cycle: false,
      events_n: 0,
      events_invalid: true,
    });
  });

  it('wait_imgcache waits for ImageCacheReady at the current generation', () => {
    const app = (observed: number, status: string) =>
      json({
        metadata: { generation: 3 },
        status: {
          conditions: [
            { type: 'Ready', status: 'True', observedGeneration: 3 },
            { type: 'ImageCacheReady', status, observedGeneration: observed },
          ],
        },
      });
    const r = runDriver(BURST, 'result = m.wait_imgcache("pb-on")', [
      rule('get nextapp pb-on', app(2, 'True'), app(3, 'False'), app(3, 'True')),
    ]);
    expect(r.result).toBe(0);
    expect(r.calls.length).toBe(3);
  });

  it('burst fires BURST_N concurrent requests from an agent and records the result array', () => {
    const res = [
      { code: 200, ms: 120, bytes: 5 },
      { code: 200, ms: 340, bytes: 5 },
    ];
    const r = runDriver(
      BURST,
      'result = m.burst("on")',
      [rule('exec', { stdout: `${JSON.stringify({ start_epoch_ms: 1700000000000, res })}\n` })],
      { BURST_N: '2' },
    );
    expect(r.result).toMatchObject({ start_epoch_ms: 1700000000000, res });
    const exec = r.calls.find((c) => c.includes('exec')) ?? [];
    expect(exec).toContain('N=2');
    expect(exec).toContain('TARGET=http://pb-on.bench-cells.svc.cluster.local/');
  });

  it('burst returns an error row, with the agent, when the burst printed nothing', () => {
    const r = runDriver(BURST, 'result = m.burst("off")', [
      rule('exec', { rc: 1, stderr: 'exec failed' }),
    ]);
    expect(r.result.error).toBe('exec failed');
    expect(['agent-1', 'agent-2']).toContain(r.result.agent);
  });

  it('resumes after the rounds already recorded', () => {
    const r = runDriver(
      BURST,
      'result = [m.done_rounds("$DIR/out.jsonl"), m.done_rounds("$DIR/nope.jsonl")]',
      [],
      {},
      { 'out.jsonl': `${JSON.stringify({ round: 2 })}\n${JSON.stringify({ round: 5 })}\n` },
    );
    expect(r.result).toEqual([5, 0]);
    expect(existsSync(join(ROOT, SCRIPT_DIR, '__pycache__'))).toBe(false);
  });
});
