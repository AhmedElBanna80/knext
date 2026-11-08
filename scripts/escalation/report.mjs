/** Combining findings and reporting them: text, JSON and the job summary. */

import { appendFileSync } from 'node:fs';
import { ACK_LABEL, LEGACY_ACK_LABEL } from './acknowledgement.mjs';

/** Merge findings into one entry per trigger id, keeping every path once. */
export function mergeFired(a, b) {
  const out = a.map((f) => ({ ...f, paths: [...f.paths] }));
  for (const f of b) {
    const existing = out.find((x) => x.id === f.id);
    if (!existing) out.push({ ...f, paths: [...f.paths] });
    else for (const p of f.paths) if (!existing.paths.includes(p)) existing.paths.push(p);
  }
  return out;
}

/**
 * Append the fired triggers to the job summary, where sprint close collects them.
 * Best-effort: outside Actions `GITHUB_STEP_SUMMARY` is unset, and a failed write
 * must not fail the check it only decorates.
 */
export function writeJobSummary(fired, acked) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || fired.length === 0) return;
  try {
    const lines = [
      '## Escalation triggers acknowledged',
      '',
      `Acknowledgement: ${acked ? 'yes' : 'no'}`,
      '',
      ...fired.flatMap((f) => [
        `- **${f.label}** — ${f.why}`,
        ...f.paths.map((p) => `  - \`${p}\``),
      ]),
      '',
    ];
    appendFileSync(summaryPath, `${lines.join('\n')}\n`);
  } catch {
    // Decoration, not the gate.
  }
}

/** The human report. Returns the exit code: 1 only when triggered and unacknowledged. */
export function printReport(fired, acked) {
  if (fired.length === 0) {
    console.log('No mechanically-detectable escalation trigger in this diff.');
    return 0;
  }
  console.log(`Escalation trigger(s) detected (${fired.length}):\n`);
  for (const f of fired) {
    console.log(`  • ${f.label} — ${f.why}`);
    for (const p of f.paths.slice(0, 8)) console.log(`      ${p}`);
    if (f.paths.length > 8) console.log(`      …and ${f.paths.length - 8} more`);
  }
  if (acked) {
    console.log(
      `\nAcknowledged (\`${ACK_LABEL}\` label, \`${LEGACY_ACK_LABEL}\` label, or a` +
        `\n"Escalation trigger acknowledged: ..." line in the PR body). Passing — logged to` +
        `\nthe job summary for sprint close to collect.`,
    );
    return 0;
  }
  console.error(
    `\nThis PR touches a trigger-class surface and is NOT acknowledged.\n` +
      `\n.claude/rules/workflow.md (2026-09-22 amendment) does not require a design-gate` +
      `\nsign-off per PR for this — it requires that the trigger was CONSCIOUSLY NOTED, so` +
      `\nsprint close can pick it up as tech debt. Acknowledge by either:` +
      `\n  - adding the \`${ACK_LABEL}\` label, or` +
      `\n  - adding a line to the PR body: "Escalation trigger acknowledged: <trigger> — <reason>"` +
      `\n\nThis check does not judge the change and does not require a gate to clear it — it` +
      `\nasserts the trigger was not skipped by default. If it fired on something genuinely` +
      `\nroutine, say so on the PR and narrow the rule; a guard that cries wolf gets worked` +
      `\naround, which is worse than no guard.`,
  );
  return 1;
}
