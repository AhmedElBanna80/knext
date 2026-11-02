import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Engine for the image half of the R8 supply-chain guard (#2044): every
 * workflow that PUBLISHES an image (discovered by what it does, under any
 * trigger) and every function-template image. The npm half lives in
 * `publish-lane-supply-chain.ts`.
 *
 * Everything is DERIVED by scanning `.github/workflows`, local composite
 * actions and `templates/`. A workflow, reusable workflow or local action that
 * cannot be read, parsed or resolved is a FINDING or a throw, never a pass.
 *
 * WHAT IS TIED TO THE IMAGE, and what cannot be: see `tieFindings`. YAML cannot
 * prove two steps handle the same bytes; the guard ties by name (the layout
 * directory `crane push` publishes must be the one Trivy scans, or be derived
 * from it by a script that names both; a cosign command must address a
 * digest). It cannot tie the SBOM to the image, nor prove a derived layout is
 * byte-equal to the scanned one.
 */

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

export type Step = Record<string, unknown>;
export type Job = Record<string, unknown>;
export interface Workflow {
  file: string;
  doc: Record<string, unknown>;
}
export interface Finding {
  subject: string;
  check: string;
  detail: string;
}

// ───────────────────────── reading ─────────────────────────

/** Read and parse every workflow. Throws (fail closed) on anything unreadable. */
export function loadWorkflows(dir = resolve(REPO_ROOT, '.github/workflows')): Workflow[] {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  if (files.length === 0) throw new Error(`no workflows found in ${dir}`);
  return files.sort().map((file) => {
    const doc = parse(readFileSync(resolve(dir, file), 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc))
      throw new Error(`${file}: workflow did not parse to a mapping`);
    return { file, doc: doc as Record<string, unknown> };
  });
}

export function jobsOf(wf: Workflow): Record<string, Job> {
  const j = wf.doc.jobs;
  if (j === undefined) return {};
  if (!j || typeof j !== 'object' || Array.isArray(j))
    throw new Error(`${wf.file}: \`jobs\` is not a mapping`);
  return j as Record<string, Job>;
}

export function stepsOf(file: string, id: string, job: Job): Step[] {
  const s = job.steps;
  if (s === undefined) return [];
  if (!Array.isArray(s)) throw new Error(`${file}#${id}: \`steps\` is not a list`);
  return s as Step[];
}

/** Resolves a local `./path` composite action to its steps, or null when it cannot. */
export type ActionResolver = (path: string) => Step[] | null;

export const fsActionResolver: ActionResolver = (path) => {
  for (const name of ['action.yml', 'action.yaml']) {
    const p = resolve(REPO_ROOT, path, name);
    if (!existsSync(p)) continue;
    const doc = parse(readFileSync(p, 'utf8')) as { runs?: { steps?: Step[] } } | null;
    if (!doc || typeof doc !== 'object') throw new Error(`${path}: action did not parse`);
    return doc.runs?.steps ?? [];
  }
  return null;
};

function needsOf(job: Job): string[] {
  const n = job.needs;
  if (n === undefined) return [];
  if (typeof n === 'string') return [n];
  if (Array.isArray(n)) return n.map(String);
  throw new Error('`needs` is neither a string nor a list');
}

/** Jobs reachable from `id` through `needs` (upstream) or through who needs it (downstream), plus itself. */
function reach(jobs: Record<string, Job>, id: string, dir: 'upstream' | 'downstream'): Set<string> {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.pop() as string;
    const next =
      dir === 'upstream'
        ? needsOf(jobs[cur] ?? {})
        : Object.keys(jobs).filter((o) => needsOf(jobs[o]).includes(cur));
    for (const n of next) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

// ───────────────────────── step classification ─────────────────────────

/** Run text with comment lines removed and continuations joined. */
function code(step: Step): string {
  const run = typeof step.run === 'string' ? step.run : '';
  return run
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .replace(/\\\n/g, ' ');
}
const uses = (s: Step) => (typeof s.uses === 'string' ? s.uses : '');
const withOf = (s: Step): Record<string, unknown> =>
  s.with && typeof s.with === 'object' ? (s.with as Record<string, unknown>) : {};

export const isSbom = (s: Step) =>
  /^anchore\/sbom-action@/.test(uses(s)) || /\b(syft|cyclonedx-npm)\b/.test(code(s));
export const isTrivy = (s: Step) =>
  /^aquasecurity\/trivy-action@/.test(uses(s)) || /\btrivy\s+(image|fs|config)\b/.test(code(s));
export const isCosign = (s: Step) => /\bcosign\s+(sign|attest)\b/.test(code(s));

const PUSH_RUN =
  /\b(?:docker|podman)\s+push\b|\bcrane\s+(?:push|copy|cp)\b|\bdocker\s+(?:buildx\s+)?build\b[^\n]*--push\b|\bimagetools\s+create\b|\bskopeo\s+copy\b|\boras\s+push\b/;
const PUSH_ACTION =
  /(?:^|\/)(?:push-to-registry|ko-action|kaniko|buildah-build)\b|\/(?:push|publish)[\w-]*@/;

/** Does this step publish an image to a registry? */
export function pushesImage(s: Step): boolean {
  if (/^docker\/build-push-action@/.test(uses(s))) {
    const w = withOf(s);
    const out = String(w.outputs ?? '');
    if (/type=registry|push=true/.test(out)) return true;
    const p = w.push;
    return p !== undefined && p !== false && String(p).trim().toLowerCase() !== 'false';
  }
  if (uses(s) && !uses(s).startsWith('./') && PUSH_ACTION.test(uses(s))) return true;
  return PUSH_RUN.test(code(s));
}

/** Severities Trivy reports. Absent = Trivy's own default, which is all of them. */
function trivySeverity(s: Step): string[] | null {
  const raw = uses(s) ? withOf(s).severity : /--severity[ =](\S+)/.exec(code(s))?.[1];
  if (raw === undefined || raw === null) return null;
  return String(raw)
    .toUpperCase()
    .split(/[\s,]+/)
    .filter(Boolean);
}

// ───────────────────────── expression evaluator ─────────────────────────

/**
 * A deliberately small GitHub-expression evaluator, three-valued: true, false,
 * or UNKNOWN. It exists so a ref-gated `continue-on-error` or `if` can be
 * judged on the refs a lane publishes from. Anything it does not understand is
 * UNKNOWN, and every caller treats UNKNOWN as "cannot prove it is safe".
 */
export const UNKNOWN = Symbol('unknown');
type Val = string | boolean | typeof UNKNOWN;
export interface Ctx {
  ref: string;
  event: string;
  /** extra dotted lookups, e.g. `steps.channel.outputs.publish` */
  vars: Record<string, string>;
}

function tokenize(src: string): string[] | null {
  const toks: string[] = [];
  const re = /\s*(?:('(?:[^']|'')*')|(&&|\|\||==|!=|[()!,])|([A-Za-z_][\w.-]*\(?|\d+))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) return null;
    toks.push(m[1] ?? m[2] ?? m[3]);
    i = re.lastIndex;
  }
  return toks;
}

const truthy = (v: Val): boolean | typeof UNKNOWN =>
  v === UNKNOWN ? UNKNOWN : typeof v === 'boolean' ? v : v !== '';

export function evalExpr(input: unknown, ctx: Ctx): boolean | typeof UNKNOWN {
  if (typeof input === 'boolean') return input;
  if (typeof input !== 'string') return UNKNOWN;
  let src = input.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(src);
  if (wrapped) src = wrapped[1].trim();
  const toks = tokenize(src);
  if (!toks) return UNKNOWN;
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  const lookup = (path: string): Val => {
    if (path === 'github.ref') return ctx.ref;
    if (path === 'github.ref_name') return ctx.ref.replace(/^refs\/(heads|tags)\//, '');
    if (path === 'github.ref_type') return ctx.ref.startsWith('refs/tags/') ? 'tag' : 'branch';
    if (path === 'github.event_name') return ctx.event;
    if (path === 'github.repository') return 'getknext-dev/knext';
    if (path in ctx.vars) return ctx.vars[path];
    return UNKNOWN;
  };
  const eq = (a: Val, b: Val): Val =>
    a === UNKNOWN || b === UNKNOWN ? UNKNOWN : String(a).toLowerCase() === String(b).toLowerCase();
  const or = (a: Val, b: Val): Val => {
    const x = truthy(a);
    const y = truthy(b);
    if (x === true || y === true) return true;
    if (x === UNKNOWN || y === UNKNOWN) return UNKNOWN;
    return false;
  };
  const and = (a: Val, b: Val): Val => {
    const x = truthy(a);
    const y = truthy(b);
    if (x === false || y === false) return false;
    if (x === UNKNOWN || y === UNKNOWN) return UNKNOWN;
    return true;
  };

  function primary(): Val {
    const t = next();
    if (t === undefined) throw new Error('eof');
    if (t === '(') {
      const v = orExpr();
      if (next() !== ')') throw new Error('paren');
      return v;
    }
    if (t === '!') {
      const v = truthy(primary());
      return v === UNKNOWN ? UNKNOWN : !v;
    }
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t.endsWith('(')) {
      const name = t.slice(0, -1);
      const args: Val[] = [];
      if (peek() !== ')') {
        args.push(orExpr());
        while (peek() === ',') {
          next();
          args.push(orExpr());
        }
      }
      if (next() !== ')') throw new Error('call');
      const [a, b] = args;
      switch (name) {
        case 'always':
        case 'success':
          return true;
        case 'failure':
        case 'cancelled':
          return false;
        case 'startsWith':
          return a === UNKNOWN || b === UNKNOWN
            ? UNKNOWN
            : String(a).toLowerCase().startsWith(String(b).toLowerCase());
        case 'endsWith':
          return a === UNKNOWN || b === UNKNOWN
            ? UNKNOWN
            : String(a).toLowerCase().endsWith(String(b).toLowerCase());
        case 'contains':
          return a === UNKNOWN || b === UNKNOWN
            ? UNKNOWN
            : String(a).toLowerCase().includes(String(b).toLowerCase());
        default:
          return UNKNOWN;
      }
    }
    if (/^[A-Za-z_]/.test(t)) return lookup(t);
    return UNKNOWN;
  }
  function cmp(): Val {
    let v = primary();
    while (peek() === '==' || peek() === '!=') {
      const op = next();
      const r = eq(v, primary());
      v = op === '==' ? r : r === UNKNOWN ? UNKNOWN : !r;
    }
    return v;
  }
  function andExpr(): Val {
    let v = cmp();
    while (peek() === '&&') {
      next();
      v = and(v, cmp());
    }
    return v;
  }
  function orExpr(): Val {
    let v = andExpr();
    while (peek() === '||') {
      next();
      v = or(v, andExpr());
    }
    return v;
  }
  try {
    const v = orExpr();
    if (p !== toks.length) return UNKNOWN;
    return truthy(v);
  } catch {
    return UNKNOWN;
  }
}

// ───────────────────────── publishing contexts ─────────────────────────

/** Output of hack/release-channel.sh for a ref, as `steps.channel.outputs.*` lookups. */
export function channelVars(ref: string): Record<string, string> {
  const script = resolve(REPO_ROOT, 'packages/kn-next-operator/hack/release-channel.sh');
  if (!existsSync(script)) return {};
  const r = spawnSync('bash', [script, ref, ref.replace(/^refs\/(heads|tags)\//, '')], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return {};
  const vars: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(line);
    if (m) vars[`steps.channel.outputs.${m[1]}`] = m[2];
  }
  return vars;
}

function onOf(wf: Workflow): Record<string, unknown> | null {
  const on = wf.doc.on ?? (wf.doc as Record<string, unknown>).true;
  return on && typeof on === 'object' && !Array.isArray(on)
    ? (on as Record<string, unknown>)
    : null;
}

/** Refs a workflow can publish from: main, each branch pattern it names, each tag pattern (sampled). */
export function candidateContexts(
  wf: Workflow,
  varsFor: (ref: string) => Record<string, string> = channelVars,
): Ctx[] {
  const refs = new Set<string>(['refs/heads/main']);
  const push = onOf(wf)?.push as Record<string, unknown> | undefined;
  if (push && typeof push === 'object') {
    for (const b of (push.branches as string[] | undefined) ?? [])
      refs.add(`refs/heads/${String(b).replace(/\*+/g, 'x')}`);
    for (const t of (push.tags as string[] | undefined) ?? [])
      refs.add(`refs/tags/${String(t).replace(/\*+/g, '1.0.0')}`);
  }
  const ctxs: Ctx[] = [...refs].map((ref) => ({ ref, event: 'push', vars: varsFor(ref) }));
  ctxs.push({
    ref: 'refs/heads/main',
    event: 'workflow_dispatch',
    vars: varsFor('refs/heads/main'),
  });
  return ctxs;
}

// ───────────────────────── publish lanes ─────────────────────────

interface Located {
  id: string;
  job: Job;
  step: Step;
}

/** Steps of a job with local composite actions expanded; throws on an unresolvable local action. */
function expandedSteps(
  file: string,
  id: string,
  job: Job,
  resolveAction: ActionResolver,
  problems: Finding[],
): Step[] {
  const out: Step[] = [];
  const walk = (steps: Step[], depth: number) => {
    for (const s of steps) {
      out.push(s);
      const u = uses(s);
      if (u.startsWith('./') && !u.includes('/.github/workflows/')) {
        const inner = resolveAction(u);
        if (inner === null)
          problems.push({
            subject: `${file}#${id}`,
            check: 'unresolved',
            detail: `local action \`${u}\` cannot be resolved, so its steps cannot be scanned`,
          });
        else if (depth < 5) walk(inner, depth + 1);
      }
    }
  };
  walk(stepsOf(file, id, job), 0);
  return out;
}

/**
 * Reviewed jobs that run a push-shaped command but do not publish a release
 * image. Keyed by workflow + job and carrying a reason; the audit reds on an
 * entry that matches no discovered lane, so this cannot outlive its job.
 */
export interface NonImageLane {
  file: string;
  job: string;
  reason: string;
}

export interface LaneAuditOptions {
  resolveAction?: ActionResolver;
  varsFor?: (ref: string) => Record<string, string>;
  nonLanes?: readonly NonImageLane[];
}

export function discoverImageLanes(
  wfs: Workflow[],
  opts: LaneAuditOptions = {},
): { lanes: Array<{ wf: Workflow; id: string }>; findings: Finding[] } {
  const resolveAction = opts.resolveAction ?? fsActionResolver;
  const findings: Finding[] = [];
  const lanes: Array<{ wf: Workflow; id: string }> = [];
  for (const wf of wfs) {
    for (const [id, job] of Object.entries(jobsOf(wf))) {
      const ju = typeof job.uses === 'string' ? job.uses : '';
      if (ju) {
        const local = /^\.\/\.github\/workflows\/([^@]+\.ya?ml)$/.exec(ju);
        if (!local || !wfs.some((w) => w.file === local[1]))
          findings.push({
            subject: `${wf.file}#${id}`,
            check: 'unresolved',
            detail: `reusable workflow \`${ju}\` cannot be resolved to a local workflow, so what it publishes cannot be scanned`,
          });
        continue; // a resolvable callee is scanned as a workflow in its own right
      }
      const steps = expandedSteps(wf.file, id, job, resolveAction, findings);
      if (steps.some(pushesImage)) lanes.push({ wf, id });
    }
  }
  return { lanes, findings };
}

/** Why a gate step would not actually gate on the given publishing contexts (empty = it does). */
function gateProblems(
  kind: 'trivy' | 'sbom' | 'cosign',
  step: Step,
  job: Job,
  ctxs: Ctx[],
): string[] {
  const out: string[] = [];
  for (const [label, coe] of [
    ['step', step['continue-on-error']],
    ['job', job['continue-on-error']],
  ] as const) {
    if (coe === undefined) continue;
    for (const ctx of ctxs) {
      const v = evalExpr(coe, ctx);
      if (v !== false) {
        out.push(
          `${label}-level continue-on-error is ${v === true ? 'true' : 'unprovable'} on ${ctx.event} ${ctx.ref}`,
        );
        break;
      }
    }
  }
  if (step.if !== undefined) {
    for (const ctx of ctxs) {
      if (evalExpr(step.if, ctx) !== true) {
        out.push(`step \`if\` is not provably true on ${ctx.event} ${ctx.ref}`);
        break;
      }
    }
  }
  if (job.if !== undefined) {
    for (const ctx of ctxs) {
      if (evalExpr(job.if, ctx) === false) {
        out.push(`job \`if\` is false on ${ctx.event} ${ctx.ref}`);
        break;
      }
    }
  }
  if (kind === 'trivy') {
    const sev = trivySeverity(step);
    if (sev && !(sev.includes('HIGH') && sev.includes('CRITICAL')))
      out.push(`severity ${sev.join(',')} does not cover both HIGH and CRITICAL`);
    const enforced = uses(step)
      ? String(withOf(step)['exit-code']) === '1'
      : /--exit-code[ =]1\b/.test(code(step));
    if (!enforced) out.push('Trivy does not enforce exit-code 1');
  }
  return out;
}

/** Layout/ref a push step publishes, when it can be read off the command. */
function pushSource(step: Step): string | null {
  const m = /\bcrane\s+(?:push|copy|cp)\s+(?:--?\S+\s+)*([^\s"')]+)/.exec(code(step));
  return m ? m[1].replace(/^"|"$/g, '') : null;
}

/**
 * Audit every discovered publish lane. A lane is a job with a push step.
 * Needs, in the lane's own workflow: an enforcing Trivy gate in or upstream of
 * the push job; an SBOM step in, upstream or downstream of it; a cosign step in
 * or downstream of it and (in the same job) after the push. Gate steps must be
 * unable to be disabled on the lane's publishing contexts.
 */
export function auditImageLanes(wfs: Workflow[], opts: LaneAuditOptions = {}): Finding[] {
  const resolveAction = opts.resolveAction ?? fsActionResolver;
  const { lanes, findings } = discoverImageLanes(wfs, opts);
  const out: Finding[] = [...findings];
  const nonLanes = opts.nonLanes ?? [];
  for (const nl of nonLanes) {
    if (!lanes.some((l) => l.wf.file === nl.file && l.id === nl.job))
      out.push({
        subject: `${nl.file}#${nl.job}`,
        check: 'stale-non-lane',
        detail: 'allowlisted non-lane matches no discovered push job',
      });
  }
  for (const { wf, id } of lanes) {
    if (nonLanes.some((n) => n.file === wf.file && n.job === id)) continue;
    const subject = `${wf.file}#${id}`;
    const f = (check: string, detail: string) => out.push({ subject, check, detail });
    const jobs = jobsOf(wf);
    const ctxsAll = candidateContexts(wf, opts.varsFor);
    const lanePushStep = expandedSteps(wf.file, id, jobs[id], resolveAction, []).filter(
      pushesImage,
    )[0];
    // Contexts on which this push can run (UNKNOWN counts as can-run).
    const ctxs = ctxsAll.filter(
      (c) =>
        evalExpr(jobs[id].if ?? true, c) !== false &&
        evalExpr(lanePushStep.if ?? true, c) !== false,
    );
    if (!ctxs.length) {
      f('never-runs', 'the push step is disabled on every ref this workflow can publish from');
      continue;
    }
    const collect = (ids: Set<string>) =>
      [...ids].flatMap((jid) =>
        expandedSteps(wf.file, jid, jobs[jid], resolveAction, []).map(
          (step): Located => ({ id: jid, job: jobs[jid], step }),
        ),
      );
    const up = collect(reach(jobs, id, 'upstream'));
    const down = collect(reach(jobs, id, 'downstream'));
    const gate = (
      kind: 'trivy' | 'sbom' | 'cosign',
      pool: Located[],
      match: (s: Step) => boolean,
    ): Located[] => {
      const cands = pool.filter((x) => match(x.step));
      if (!cands.length) {
        f(
          kind,
          kind === 'cosign'
            ? 'no `cosign sign`/`cosign attest` in or after the push job'
            : `no ${kind} step in or around the push job`,
        );
        return [];
      }
      const valid = cands.filter((x) => gateProblems(kind, x.step, x.job, ctxs).length === 0);
      if (!valid.length) {
        const x = cands[0];
        f(kind, `\`${x.id}\`: ${gateProblems(kind, x.step, x.job, ctxs).join('; ')}`);
      }
      return valid;
    };
    const trivy = gate('trivy', up, isTrivy);
    gate('sbom', [...up, ...down], isSbom);
    const sign = gate('cosign', [...collect(new Set([id])), ...down], isCosign);

    // Ordering inside the push job: a cosign step in the same job runs after the push.
    const own = expandedSteps(wf.file, id, jobs[id], resolveAction, []);
    const pushAt = own.findIndex(pushesImage);
    const signAt = own.findIndex(isCosign);
    if (signAt !== -1 && signAt < pushAt) f('cosign-order', 'cosign runs before the push step');

    // ── ties ──
    const src = pushSource(lanePushStep);
    if (src && trivy.length) {
      const scanned = trivy
        .map((x) =>
          uses(x.step)
            ? String(withOf(x.step).input ?? withOf(x.step)['image-ref'] ?? '')
            : (/\btrivy\s+image\b.*\s(\S+)\s*$/m.exec(code(x.step))?.[1] ?? ''),
        )
        .filter(Boolean);
      const runs = collect(new Set([...reach(jobs, id, 'upstream')]))
        .map((x) => code(x.step))
        .join('\n');
      const derived = scanned.some(
        (s) => s && new RegExp(`${escapeRe(s)}\\b[^\\n]*\\b${escapeRe(src)}\\b`).test(runs),
      );
      // An unreadable scan target (variable, expression) is NOT tied: stated, not failed.
      if (scanned.length > 0 && !scanned.includes(src) && !derived)
        f(
          'tie-trivy',
          `pushes \`${src}\` but Trivy scans ${scanned.map((s) => `\`${s}\``).join(', ')} and no step derives \`${src}\` from it`,
        );
    }
    for (const x of sign) {
      if (!isCosign(x.step)) continue;
      const cmds = code(x.step)
        .split('\n')
        .filter((l) => /\bcosign\s+(sign|attest)\b/.test(l));
      if (cmds.some((l) => !/@\S*(?:digest|DIGEST|sha256)/i.test(l)))
        f('tie-cosign', 'a cosign command does not address the image by digest (`ref@digest`)');
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ───────────────────────── operator tag trigger ─────────────────────────

export function operatorTagWorkflows(wfs: Workflow[]): Workflow[] {
  return wfs.filter((wf) => {
    const push = onOf(wf)?.push;
    if (!push || typeof push !== 'object') return false;
    const tags = (push as Record<string, unknown>).tags;
    return Array.isArray(tags) && tags.some((t) => /^operator-v/.test(String(t)));
  });
}

/**
 * The operator-v* tag trigger must fire for a tag cut from ANY branch, and the
 * lane it starts must still publish on that tag. Gate content (Trivy, SBOM,
 * cosign) is `auditImageLanes`' job, discovered by behaviour.
 */
export function auditOperatorTags(wfs: Workflow[], opts: LaneAuditOptions = {}): Finding[] {
  const lanes = operatorTagWorkflows(wfs);
  if (lanes.length === 0)
    return [
      {
        subject: 'operator',
        check: 'discovered',
        detail: 'no workflow publishes operator-v* tags',
      },
    ];
  const resolveAction = opts.resolveAction ?? fsActionResolver;
  const out: Finding[] = [];
  for (const wf of lanes) {
    const f = (check: string, detail: string) => out.push({ subject: wf.file, check, detail });
    const push = (onOf(wf) as Record<string, unknown>).push as Record<string, unknown>;
    for (const k of ['paths', 'paths-ignore', 'branches-ignore', 'tags-ignore']) {
      if (k in push)
        f('any-branch', `push trigger carries \`${k}\`, so a tag from some branch may not fire`);
    }
    const tagCtx = candidateContexts(wf, opts.varsFor).find((c) => c.ref.startsWith('refs/tags/'));
    const jobs = jobsOf(wf);
    const pushJobs = Object.entries(jobs).filter(([jid, job]) =>
      expandedSteps(wf.file, jid, job, resolveAction, []).some(pushesImage),
    );
    if (!pushJobs.length) f('no-publish', 'the operator-v* workflow has no image push step');
    for (const [jid, job] of pushJobs) {
      if (tagCtx && evalExpr(job.if ?? true, tagCtx) === false)
        f(
          'any-branch',
          `\`${jid}\` is disabled on ${tagCtx.ref} (a tag from another branch is not published)`,
        );
    }
  }
  return out;
}

// ───────────────────────── function template images ─────────────────────────

/** Template dirs that have a Dockerfile, derived from the filesystem. */
export function templateDirs(root = resolve(REPO_ROOT, 'templates')): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(root, d.name, 'Dockerfile')))
    .map((d) => d.name)
    .sort();
}

const BUILD_CMD = /\bdocker\s+(?:buildx\s+)?build\b[^\n]*?\btemplates\/([\w.-]+)/;

function builtTemplate(step: Step): string | null {
  const ctx = withOf(step).context;
  if (/^docker\/build-push-action@/.test(uses(step)) && typeof ctx === 'string') {
    const m = ctx.match(/^\.?\/?templates\/([\w.-]+)/);
    if (m) return m[1];
  }
  const m = code(step).match(BUILD_CMD);
  return m ? m[1] : null;
}

export function auditTemplateImages(
  wfs: Workflow[],
  templates: string[],
  opts: LaneAuditOptions = {},
): Finding[] {
  const out: Finding[] = [];
  const built = new Map<string, Array<{ wf: Workflow; id: string }>>();
  for (const wf of wfs) {
    for (const [id, job] of Object.entries(jobsOf(wf))) {
      for (const step of stepsOf(wf.file, id, job)) {
        const t = builtTemplate(step);
        if (t) built.set(t, [...(built.get(t) ?? []), { wf, id }]);
      }
    }
  }
  for (const t of templates) {
    const subject = `template:${t}`;
    const builders = built.get(t) ?? [];
    if (!builders.length) {
      out.push({ subject, check: 'built', detail: 'no workflow job builds this template image' });
      continue;
    }
    // The image job itself plus every job downstream of it (a separate publish job).
    const located = builders.flatMap((b) => {
      const jobs = jobsOf(b.wf);
      const ctxs = candidateContexts(b.wf, opts.varsFor);
      return [...reach(jobs, b.id, 'downstream')].flatMap((jid) =>
        stepsOf(b.wf.file, jid, jobs[jid]).map((step) => ({ id: jid, job: jobs[jid], step, ctxs })),
      );
    });
    for (const [kind, match] of [
      ['sbom', isSbom],
      ['cosign', isCosign],
    ] as const) {
      const cands = located.filter((x) => match(x.step));
      const valid = cands.filter((x) => gateProblems(kind, x.step, x.job, x.ctxs).length === 0);
      if (valid.length) continue;
      out.push({
        subject,
        check: kind,
        detail: cands.length
          ? `\`${cands[0].id}\`: ${gateProblems(kind, cands[0].step, cands[0].job, cands[0].ctxs).join('; ')}`
          : kind === 'cosign'
            ? 'no `cosign sign`/`cosign attest` in or after the image job'
            : 'no SBOM step in or after the image job',
      });
    }
  }
  return out;
}
