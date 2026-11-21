/**
 * The two directories a vinext image's close line names are defined once, in one module of the
 * package (`VINEXT_DIRS`). Four things are built from them and must move together when they change:
 * the line itself (and the scaffolded COPY it goes after), the generated module's test of which
 * failing directories the line fixes, the hint's reading of which COPY is the app's `native/`, and
 * every word the hint prints about them. This runs the package's own sources, copied, with the pair
 * changed in the copy and nowhere else (the module that defines it is found by what it holds, not by
 * its name, and there must be exactly one), and checks all four follow; a place that typed `/app`
 * again would stay where it was and fail here.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyDir, PKG_DIR, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

const PAIR_LINE = "export const VINEXT_DIRS = ['/app', '/app/native'] as const;";

interface Seen {
  closeLine: string;
  nativeCopy: string;
  /** The array the generated module tests a failing directory against, as written in it. */
  moduleTest: string | undefined;
  /** The module's vinext sentence, as far as the line it names. */
  moduleSentence: string | undefined;
  /** The hint for a Dockerfile that copies native/ to the first destination, then the second. */
  hintForNew: string;
  hintForOld: string;
  /** The other two messages: the line is there and something after it is not confirmed, and the file cannot be read. */
  hintUnconfirmed: string;
  hintUnreadable: string;
}

/** The sources of the package, copied with `pair` in place of the real one, and what they then say. */
function seenWith(pair: readonly [string, string] | undefined): Seen {
  const root = emptyDir('vinext-pair');
  const src = join(root, 'src');
  mkdirSync(src);
  for (const name of readdirSync(join(PKG_DIR, 'src'))) {
    if (name.endsWith('.ts')) copyFileSync(join(PKG_DIR, 'src', name), join(src, name));
  }
  // The one file that defines the pair, found by what it holds: a second definition would be a second
  // source, which is the thing this guards against.
  const definers = readdirSync(src).filter((name) =>
    readFileSync(join(src, name), 'utf8').includes(PAIR_LINE),
  );
  expect(definers, 'exactly one file defines the pair').toHaveLength(1);
  if (pair !== undefined) {
    const path = join(src, definers[0] as string);
    const text = readFileSync(path, 'utf8');
    expect(text.split(PAIR_LINE).length - 1, 'the pair moved').toBe(1);
    writeFileSync(
      path,
      text.replace(PAIR_LINE, `export const VINEXT_DIRS = ${JSON.stringify(pair)} as const;`),
    );
  }
  const probe = join(root, 'probe.ts');
  writeFileSync(
    probe,
    `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blob, KITCHEN_SINK } from ${JSON.stringify(join(PKG_DIR, 'src', '__tests__', 'helpers.ts'))};
import { dockerfileHint, VINEXT_CLOSE_LINE, VINEXT_NATIVE_COPY } from './src/init.ts';
import { renderModule } from './src/render.ts';
import { scanManifest } from './src/manifest.ts';

const mod = renderModule(scanManifest(blob(KITCHEN_SINK)), { libName: 'fixture', crate: 'rust' });
const hint = (dest: string, ...more: string[]) => {
  const cwd = join(${JSON.stringify(root)}, 'df-' + dest.replace(/\\W/g, '_') + more.length);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'Dockerfile'), ['FROM alpine', 'COPY native ' + dest, ...more, 'USER 1', ''].join('\\n'));
  return dockerfileHint(cwd);
};
console.log(JSON.stringify({
  closeLine: VINEXT_CLOSE_LINE,
  nativeCopy: VINEXT_NATIVE_COPY,
  moduleTest: /\\[[^\\]]*\\]\\.includes\\(dir\\)/.exec(mod)?.[0],
  moduleSentence: new RegExp('put exactly \`([^\`]*)\`').exec(mod)?.[1],
  hintForNew: hint(${JSON.stringify(pair?.[1] ?? '/app/native')}),
  hintForOld: hint('/app/native'),
  hintUnconfirmed: hint(${JSON.stringify(pair?.[1] ?? '/app/native')}, VINEXT_CLOSE_LINE, 'RUN echo hi'),
  hintUnreadable: hint(${JSON.stringify(pair?.[1] ?? '/app/native')}, 'RUN cat <<EOF', 'x', 'EOF'),
}));
`,
  );
  const r = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Seen;
}

describe('the vinext directory pair is defined once and everything that names it follows it', () => {
  it('as shipped: the line, the COPY, the generated module and the hint all say /app and /app/native', () => {
    const seen = seenWith(undefined);
    expect(seen.closeLine).toBe('RUN chmod go-w /app /app/native');
    expect(seen.nativeCopy).toBe('COPY --chown=0:0 --chmod=a-w native /app/native');
    expect(seen.moduleTest).toBe("['/app', '/app/native'].includes(dir)");
    expect(seen.moduleSentence).toBe(seen.closeLine);
    expect(seen.hintForNew).toContain(`  ${seen.closeLine}\n`);
    expect(seen.hintUnconfirmed).toContain('cannot confirm');
    expect(seen.hintUnreadable).toContain('cannot confirm');
  });

  it('with the pair changed in one place, the line, the COPY, the module test and the hint all move, and nothing is left saying /app', () => {
    const seen = seenWith(['/srv/app', '/srv/app/lib']);
    expect(seen.closeLine).toBe('RUN chmod go-w /srv/app /srv/app/lib');
    expect(seen.nativeCopy).toBe('COPY --chown=0:0 --chmod=a-w native /srv/app/lib');
    // The generated module: the directories the line fixes, and the line it tells the app to add.
    expect(seen.moduleTest).toBe("['/srv/app', '/srv/app/lib'].includes(dir)");
    expect(seen.moduleSentence).toBe(seen.closeLine);
    // The hint: a COPY to the new destination is the app's native/, and the old one no longer is.
    expect(seen.hintForNew).toContain(`  ${seen.closeLine}\n`);
    expect(seen.hintForOld).toBe('');
    // Every message the hint prints, not only the one that names the line: no /app that is not a part of
    // the new directories is left in any of them (`/srv/app` has /app inside it, after a word character).
    for (const [name, text] of Object.entries({
      add: seen.hintForNew,
      unconfirmed: seen.hintUnconfirmed,
      unreadable: seen.hintUnreadable,
    })) {
      expect(text, name).toContain('/srv/app/lib');
      expect(text, name).not.toMatch(/(?<![\w/])\/app\b/);
    }
  });
});
