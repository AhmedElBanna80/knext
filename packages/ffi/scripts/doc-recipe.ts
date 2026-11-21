// Extracts a recipe from the in-process Rust docs page, verbatim, so the e2e lane
// (.github/workflows/ffi-e2e.yml) builds and runs what the page tells a user to
// copy, not a paraphrase of it. A recipe is one fenced block whose info string
// carries `title="<name>"`; the page must have exactly one block of that title.
//
//   bun doc-recipe.ts dockerfile <out>   the Dockerfile for a root-owned native/
//   bun doc-recipe.ts shell <out>        the commands for a compiled binary run
//                                        outside a container ($APP_DIR is the
//                                        directory holding the executable and native/)
//
// It fails on zero or several matching blocks and on a block that is never
// closed: a renamed or duplicated block must turn the lane red, not into a no-op.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const DOCS_PAGE = resolve(
  dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  '..',
  'apps',
  'docs',
  'content',
  'docs',
  'rust-in-process.mdx',
);

/** Recipe name on the command line -> the title of its block on the page. */
export const RECIPES = { dockerfile: 'Dockerfile', shell: 'own-binary.sh' } as const;

/** The body of the one fenced block titled `title`, dedented by its fence, ending in a newline. */
export function extractRecipe(mdx: string, title: string): string {
  const lines = mdx.split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^( *)```(\S*)\s*(.*)$/.exec(lines[i] as string);
    if (!open || open[2] === '') continue;
    const indent = open[1] as string;
    const closes = (l: string) =>
      l.startsWith(`${indent}\`\`\``) && l.slice(indent.length).trim() === '```';
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !closes(lines[j] as string); j++) {
      const line = lines[j] as string;
      body.push(line.startsWith(indent) ? line.slice(indent.length) : line);
    }
    if (j >= lines.length) {
      if ((open[3] as string).includes(`title="${title}"`)) {
        throw new Error(`the block titled "${title}" is never closed`);
      }
      break;
    }
    if ((open[3] as string).includes(`title="${title}"`)) found.push(`${body.join('\n')}\n`);
    i = j;
  }
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one block titled "${title}" on the docs page, found ${found.length}`,
    );
  }
  return found[0] as string;
}

if (import.meta.main) {
  const [name, out] = process.argv.slice(2);
  if (!name || !out || !(name in RECIPES)) {
    console.error(`usage: bun doc-recipe.ts ${Object.keys(RECIPES).join('|')} <out-file>`);
    process.exit(2);
  }
  try {
    writeFileSync(
      out,
      extractRecipe(readFileSync(DOCS_PAGE, 'utf8'), RECIPES[name as keyof typeof RECIPES]),
    );
  } catch (err) {
    console.error(`doc-recipe: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
