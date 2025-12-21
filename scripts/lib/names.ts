/**
 * Converts an input string to a valid Kubernetes DNS-1123 label.
 * - Lowercase alphanumeric or '-'
 * - Must start/end with alphanumeric
 * - Max 63 characters
 */
export function toDns1123Label(input: string): string {
  // Kubernetes DNS-1123 label: lowercase alphanumeric or '-', must start/end alnum, max 63 chars.
  const lower = input.toLowerCase();
  const replaced = lower.replace(/[^a-z0-9-]+/g, '-');
  const trimmed = replaced.replace(/^-+/, '').replace(/-+$/, '');
  return trimmed.slice(0, 63) || 'default';
}
