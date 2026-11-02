/**
 * Responsive-layout guard for the public docs site (apps/docs).
 *
 * Bug class: a grid column sized with a bare `1fr` track is `minmax(auto, 1fr)`,
 * so its minimum is the min-content width of its contents. A `pre` code block
 * (white-space: pre, 881px of YAML) inside such a column widens the column past
 * the viewport, and the whole page scrolls sideways. Reproduced at 320-980px on
 * the landing page by `scripts/viewport-overflow-crawl.mjs`.
 *
 * The fix is `minmax(0, 1fr)` on every grid track inside a narrow-viewport
 * (`max-width`) media block. The desktop base templates are deliberately NOT
 * changed (the brief keeps the 1280px layout identical); they are pinned below
 * as a known list so any NEW bare track fails review.
 *
 * What this cannot catch: a layout that is wide for another reason (a fixed-px
 * width, an unbroken URL outside a grid, a flex child missing `min-width: 0`).
 * The rendered crawler catches those; this static guard does not.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOME_CSS = resolve(import.meta.dirname, 'app/(home)/home.module.css');
const GLOBAL_CSS = resolve(import.meta.dirname, 'app/global.css');

/** Bodies of every `@media (... max-width ...) { ... }` block (brace-matched). */
export function maxWidthMediaBodies(css: string): string[] {
  const bodies: string[] = [];
  for (const m of css.matchAll(/@media[^{]*max-width[^{]*\{/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    bodies.push(css.slice(start, i - 1));
  }
  return bodies;
}

/** `grid-template*` declarations whose value has a bare `1fr` track (not minmax(0, ...)). */
export function bareFrTracks(text: string): string[] {
  const offenders: string[] = [];
  for (const m of text.matchAll(/grid-template(?:-columns)?\s*:\s*([^;}]*)[;}]/g)) {
    const stripped = m[1].replace(/minmax\(\s*0\s*,[^)]*\)/g, '');
    if (/\b\d*fr\b/.test(stripped)) offenders.push(m[0].trim());
  }
  return offenders;
}

/** Bare tracks inside narrow-viewport media blocks: the reader's bug, must be empty. */
export function narrowBareFrTracks(css: string): string[] {
  return maxWidthMediaBodies(css).flatMap(bareFrTracks);
}

describe('docs stylesheets: narrow-viewport grids never use a bare 1fr track', () => {
  it('home.module.css has no bare 1fr track inside any max-width media block', () => {
    expect(narrowBareFrTracks(readFileSync(HOME_CSS, 'utf8'))).toEqual([]);
  });

  it('global.css has no bare 1fr track inside any max-width media block', () => {
    expect(narrowBareFrTracks(readFileSync(GLOBAL_CSS, 'utf8'))).toEqual([]);
  });

  it('the desktop base bare tracks are exactly the known, reviewed list', () => {
    // Known and deliberately left at 1fr so the 1280px layout is unchanged
    // (see header). A NEW bare track in the base layout fails here on purpose.
    const base = readFileSync(HOME_CSS, 'utf8').replace(/@media[^{]*\{[\s\S]*?\n\}/g, '');
    expect(bareFrTracks(base)).toEqual([
      'grid-template-columns: repeat(2, 1fr);',
      'grid-template-columns: 1fr 1fr;',
    ]);
  });

  it('the detector flags a planted bare-1fr track inside a max-width block (negative case)', () => {
    const planted = '@media (max-width: 820px) { .codewrap { grid-template-columns: 1fr; } }';
    expect(narrowBareFrTracks(planted)).toEqual(['grid-template-columns: 1fr;']);
  });

  it('the detector accepts minmax(0, 1fr) inside a max-width block (positive case)', () => {
    const safe =
      '@media (max-width: 1000px) { .codewrap { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }';
    expect(narrowBareFrTracks(safe)).toEqual([]);
  });

  it('the detector flags a planted repeat(2, 1fr) inside nested media (negative case)', () => {
    const planted =
      '@media (max-width: 1000px) { @supports (display: grid) { .grid { grid-template-columns: repeat(2, 1fr); } } }';
    expect(narrowBareFrTracks(planted)).toEqual(['grid-template-columns: repeat(2, 1fr);']);
  });
});
