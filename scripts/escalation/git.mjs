/** The git side of the check: name-status parsing and a two-ref file reader. */

import { execFileSync } from 'node:child_process';

export function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/** Every status letter `git diff --name-status` can emit. */
const GIT_STATUSES = new Set(['A', 'B', 'C', 'D', 'M', 'R', 'T', 'U', 'X']);

/**
 * Parse `git diff --name-status` output into {status, path} records, either the
 * NUL-separated `-z` form (never C-quoted) or the tab/newline form. Unknown input
 * THROWS: a record this parser does not understand must fail the check, not be
 * classified as "nothing to see". A rename or copy yields two records,
 * destination then source: moving a file OUT of a trigger-class path changes that
 * surface too.
 */
export function parseNameStatus(text) {
  const records = [];
  if (text.includes('\0')) {
    const tokens = text.split('\0');
    while (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();
    for (let i = 0; i < tokens.length; ) {
      const status = tokens[i++];
      const n = pathCount(status);
      records.push([status, tokens.slice(i, i + n)]);
      i += n;
    }
  } else {
    for (const l of text.split('\n').map((x) => x.trim())) {
      if (!l) continue;
      const [status, ...rest] = l.split('\t');
      records.push([status, rest]);
    }
  }
  return records.flatMap(([status, paths]) => {
    const n = pathCount(status);
    if (paths.length < n || paths.some((p) => !p)) {
      throw new Error(`name-status record has no path: ${[status, ...paths].join(' ')}`);
    }
    return paths
      .slice(0, n)
      .reverse()
      .map((path) => ({ status: status[0], path }));
  });
}

/** How many paths a status letter carries: two for a rename/copy, else one. */
function pathCount(status) {
  if (!status || !GIT_STATUSES.has(status[0])) {
    throw new Error(`unknown git name-status "${status}"`);
  }
  return status[0] === 'R' || status[0] === 'C' ? 2 : 1;
}

/**
 * A repo reader over two refs: `show(side, path)` returns a blob's text or null
 * (absent, or not a blob); `listHead(prefix)` lists the head tree. A git error
 * other than absence THROWS, so it cannot read as "file absent".
 */
export function gitReader(baseRef, headRef) {
  const refs = { base: baseRef, head: headRef };
  return {
    show(side, path) {
      // `cat-file -t`, not `-e`: `-e` also succeeds for a TREE.
      let type;
      try {
        type = execFileSync('git', ['cat-file', '-t', `${refs[side]}:${path}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return null;
      }
      if (type !== 'blob') return null;
      return git(['show', `${refs[side]}:${path}`]);
    },
    listHead(prefix) {
      return git(['ls-tree', '-r', '-z', '--name-only', headRef, '--', prefix])
        .split('\0')
        .filter(Boolean);
    },
  };
}
