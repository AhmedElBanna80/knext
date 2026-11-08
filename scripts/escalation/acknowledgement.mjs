/**
 * How a PR records that a fired trigger was consciously noted
 * (.claude/rules/workflow.md, 2026-09-22 amendment): a label, or a line in the
 * PR body, which also says which trigger and why, where sprint close reads it.
 */

/** The label that records "a human/agent consciously noted this trigger". */
export const ACK_LABEL = 'trigger:acknowledged';

/** The older label from when this was a design gate; still accepted. */
export const LEGACY_ACK_LABEL = 'design-gate:cleared';

/** The PR-body line: `Escalation trigger acknowledged: <trigger> — <reason>`. */
export const ACK_BODY_PATTERN = /Escalation trigger acknowledged:/i;

export function isAcknowledged(labels, body) {
  const labelHit = labels.some((l) => {
    const normalized = l.trim().toLowerCase();
    return normalized === ACK_LABEL || normalized === LEGACY_ACK_LABEL;
  });
  if (labelHit) return true;
  return typeof body === 'string' && ACK_BODY_PATTERN.test(body);
}
