/**
 * Classification: every finding for a set of changed files. Path triggers need
 * only the paths; the manifest surface and credential workflows read content
 * through `repo` (`{ show(side, path), listHead(prefix) }`).
 */

import { credentialWorkflowFindings } from './credential-workflows.mjs';
import { classifyPaths } from './paths.mjs';
import { publicSurfaceFindings } from './public-surface.mjs';
import { mergeFired } from './report.mjs';

/** Path-only triggers. Pure. */
export const classify = classifyPaths;

/** Triggers that need file content: the manifest surface and credential workflows. */
export function classifyContent(changes, repo) {
  return [...publicSurfaceFindings(changes, repo), ...credentialWorkflowFindings(changes, repo)];
}

/** Every finding, one entry per trigger id. */
export function classifyAll(changes, repo) {
  return mergeFired(classify(changes), classifyContent(changes, repo));
}
