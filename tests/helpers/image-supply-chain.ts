import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Engine for the image half of the R8 supply-chain guard (#2044): operator tags
 * and function-template images. The npm half lives in
 * `publish-lane-supply-chain.ts`.
 *
 * Everything is DERIVED by scanning `.github/workflows` and `templates/`, never
 * enumerated. A workflow that cannot be read or parsed THROWS, so an
 * unparseable construct fails the guard instead of passing it.
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

function needsOf(job: Job): string[] {
  const n = job.needs;
  if (n === undefined) return [];
  if (typeof n === 'string') return [n];
  if (Array.isArray(n)) return n.map(String);
  throw new Error('`needs` is neither a string nor a list');
}

/** Run text with comment lines removed (prose must not satisfy a matcher). */
function code(step: Step): string {
  const run = typeof step.run === 'string' ? step.run : '';
  return run
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
}
const uses = (s: Step) => (typeof s.uses === 'string' ? s.uses : '');
const withOf = (s: Step): Record<string, unknown> =>
  s.with && typeof s.with === 'object' ? (s.with as Record<string, unknown>) : {};

export const isSbom = (s: Step) =>
  /^anchore\/sbom-action@/.test(uses(s)) || /\b(syft|cyclonedx-npm)\b/.test(code(s));
export const isTrivy = (s: Step) =>
  /^aquasecurity\/trivy-action@/.test(uses(s)) || /\btrivy\s+(image|fs|config)\b/.test(code(s));
export const isCosign = (s: Step) => /\bcosign\s+(sign|attest)\b/.test(code(s));

/** Trivy must fail the build on findings, i.e. `exit-code: "1"` (or a CLI flag). */
function trivyEnforces(s: Step): boolean {
  if (uses(s)) return String(withOf(s)['exit-code']) === '1';
  return /--exit-code[ =]1\b/.test(code(s));
}

/** Jobs reachable from `id` through `needs` (upstream) or through who needs it (downstream). */
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

/** Does an `if` confine a step/job to a branch, excluding tags? */
export function branchOnly(cond: unknown): boolean {
  if (typeof cond !== 'string') return false;
  return /refs\/heads\//.test(cond) && !/refs\/tags\/|github\.ref_type/.test(cond);
}

// ───────────────────────── operator tags ─────────────────────────

function onOf(wf: Workflow): Record<string, unknown> | null {
  const on = wf.doc.on ?? (wf.doc as Record<string, unknown>).true;
  return on && typeof on === 'object' && !Array.isArray(on)
    ? (on as Record<string, unknown>)
    : null;
}

export function operatorTagWorkflows(wfs: Workflow[]): Workflow[] {
  return wfs.filter((wf) => {
    const push = onOf(wf)?.push;
    if (!push || typeof push !== 'object') return false;
    const tags = (push as Record<string, unknown>).tags;
    return Array.isArray(tags) && tags.some((t) => /^operator-v/.test(String(t)));
  });
}

export function auditOperatorTags(wfs: Workflow[]): Finding[] {
  const lanes = operatorTagWorkflows(wfs);
  if (lanes.length === 0)
    return [
      {
        subject: 'operator',
        check: 'discovered',
        detail: 'no workflow publishes operator-v* tags',
      },
    ];
  const out: Finding[] = [];
  for (const wf of lanes) {
    const f = (check: string, detail: string) => out.push({ subject: wf.file, check, detail });
    const push = (onOf(wf) as Record<string, unknown>).push as Record<string, unknown>;
    for (const k of ['paths', 'paths-ignore', 'branches-ignore', 'tags-ignore']) {
      if (k in push)
        f('any-branch', `push trigger carries \`${k}\`, so a tag from some branch may not fire`);
    }
    const jobs = jobsOf(wf);
    const all = Object.entries(jobs).flatMap(([id, job]) =>
      stepsOf(wf.file, id, job).map((step) => ({ id, job, step })),
    );
    const trivy = all.filter((x) => isTrivy(x.step));
    const sbom = all.filter((x) => isSbom(x.step));
    const cosign = all.filter((x) => isCosign(x.step));
    if (!trivy.length) f('trivy', 'no Trivy scan step');
    else if (!trivy.some((x) => trivyEnforces(x.step)))
      f('trivy', 'Trivy does not enforce exit-code 1');
    if (!sbom.length) f('sbom', 'no SBOM step');
    if (!cosign.length) f('cosign', 'no `cosign sign`/`cosign attest` step');
    // Ordering: a signing job is, or runs after, a Trivy job and an SBOM job.
    for (const c of cosign) {
      const before = reach(jobs, c.id, 'upstream');
      if (trivy.length && !trivy.some((t) => before.has(t.id)))
        f('trivy-before-cosign', `cosign in \`${c.id}\` does not run after the Trivy job`);
      if (sbom.length && !sbom.some((t) => before.has(t.id)))
        f('sbom-before-cosign', `cosign in \`${c.id}\` does not run after the SBOM job`);
    }
    // A branch-only condition on any of these would skip a tag push.
    for (const x of [...trivy, ...sbom, ...cosign]) {
      if (branchOnly(x.step.if) || branchOnly(x.job.if))
        f(
          'any-branch',
          `\`${x.id}\` is confined to a branch (\`if\` names refs/heads/ but not tags)`,
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

/** Which template does this step build an image from, if any? */
function builtTemplate(step: Step): string | null {
  const ctx = withOf(step).context;
  if (/^docker\/build-push-action@/.test(uses(step)) && typeof ctx === 'string') {
    const m = ctx.match(/^\.?\/?templates\/([\w.-]+)/);
    if (m) return m[1];
  }
  const m = code(step).replace(/\\\n/g, ' ').match(BUILD_CMD);
  return m ? m[1] : null;
}

export function auditTemplateImages(wfs: Workflow[], templates: string[]): Finding[] {
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
    const steps = builders.flatMap((b) => {
      const jobs = jobsOf(b.wf);
      return [...reach(jobs, b.id, 'downstream')].flatMap((id) => stepsOf(b.wf.file, id, jobs[id]));
    });
    if (!steps.some(isSbom))
      out.push({ subject, check: 'sbom', detail: 'no SBOM step in or after the image job' });
    if (!steps.some(isCosign))
      out.push({
        subject,
        check: 'cosign',
        detail: 'no `cosign sign`/`cosign attest` in or after the image job',
      });
  }
  return out;
}
