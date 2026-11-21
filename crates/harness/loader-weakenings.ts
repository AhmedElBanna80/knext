// The weakenings of the generated loader that ffi-generated-red.ts applies, one per way the walk
// above the executable's directory can be cut short, and what a run with each must look like.
//
// The harness (ffi-generated.ts) applies one to the rendered module text in memory when
// KNEXT_FFI_HARNESS_MUTATE names it. A test (tests/ffi-harness-red.test.ts) checks every anchor
// against the renderer, so a change to the loader's text that moves an anchor fails there, not
// first in the Rust crates lane. This file has no side effects, so a test can import it.

export interface Weakening {
  readonly claim: string;
  /** Text of the rendered loader, which must occur exactly once. */
  readonly anchor: string;
  readonly replacement: string;
  /** The controls this weakening must turn red, and no others. */
  readonly controls: readonly number[];
  /** Only a run as a user that is not root can see it (the owner of a root-owned tree is root's). */
  readonly nonRoot?: boolean;
}

export const WEAKENINGS: Readonly<Record<string, Weakening>> = {
  W01: {
    claim: 'the directories above the one native/ sits in are never walked',
    anchor: '  dirs.push(...up);\n',
    replacement: '  dirs.push(home);\n',
    controls: [1, 3, 4],
  },
  W02: {
    claim: 'the walk stops one short of the root directory',
    anchor: '    if ($dirname(d) === d) return out;\n',
    replacement: "    if ($dirname(d) === '/') return out;\n",
    controls: [4],
  },
  W03: {
    claim:
      'a path that is not the real path of its directory is let through: the walk follows the link',
    anchor: '  if (real !== home) {\n',
    replacement: '  if (false as boolean) {\n',
    controls: [2],
  },
  W04: {
    claim: 'a sticky, world-writable directory (a /tmp) is let through',
    anchor:
      '  if ((bits & 0o022) !== 0) return `is writable by its group or by everyone (mode ${mode})`;\n',
    replacement:
      '  if ((bits & 0o022) !== 0 && (bits & 0o1000) === 0) return `is writable by its group or by everyone (mode ${mode})`;\n',
    controls: [1],
  },
  W05: {
    claim: 'the owner of a directory is not judged: the walk goes by mode alone',
    anchor:
      '  if (Number(st.uid) !== 0) return `is owned by uid ${st.uid}, but only root may own it`;\n',
    replacement:
      '  if (Number(st.uid) === -1) return `is owned by uid ${st.uid}, but only root may own it`;\n',
    controls: [1],
    nonRoot: true,
  },
};

/** `text` with weakening `id` applied; throws when `id` is unknown or its anchor is not found exactly once. */
export function weaken(text: string, id: string): string {
  const w = WEAKENINGS[id];
  if (w === undefined) throw new Error(`KNEXT_FFI_HARNESS_MUTATE=${id} names no weakening`);
  if (text.split(w.anchor).length !== 2) {
    throw new Error(
      `weakening ${id}: its anchor does not occur exactly once in the rendered loader`,
    );
  }
  return text.replace(w.anchor, () => w.replacement);
}

/** The controls named by the `FAIL: control N` lines of a harness run's stderr, sorted, once each. */
export function failedControls(stderr: string): { controls: number[]; unlabelled: number } {
  const controls = new Set<number>();
  let unlabelled = 0;
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('ffi-generated: FAIL: ')) continue;
    const m = /^ffi-generated: FAIL: control (\d+):/.exec(line);
    if (m) controls.add(Number(m[1]));
    else unlabelled++;
  }
  return { controls: [...controls].sort((a, b) => a - b), unlabelled };
}

/**
 * The problems with one weakened run: none when it exited 1 (a check failed) and failed on exactly
 * the controls the weakening lists, each check carrying a control label.
 */
export function judge(id: string, status: number | null, stderr: string): string[] {
  const w = WEAKENINGS[id];
  if (w === undefined) return [`${id}: no such weakening`];
  if (status !== 1) {
    return [
      `${id}: the harness exited ${status}, want 1 (a check failed): ${status === 0 ? 'the weakened loader passed every control' : 'it could not run'}`,
    ];
  }
  const problems: string[] = [];
  const { controls, unlabelled } = failedControls(stderr);
  if (JSON.stringify(controls) !== JSON.stringify(w.controls)) {
    problems.push(
      `${id}: controls ${JSON.stringify(controls)} went red, want exactly ${JSON.stringify(w.controls)}`,
    );
  }
  if (unlabelled > 0) problems.push(`${id}: ${unlabelled} failing check(s) carry no control label`);
  return problems;
}
