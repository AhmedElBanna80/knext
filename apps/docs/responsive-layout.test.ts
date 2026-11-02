/**
 * Responsive-layout guard for the public docs site (apps/docs).
 *
 * Bug class: a grid track sized with a bare `1fr` is `minmax(auto, 1fr)`, so its
 * minimum is the min-content width of its contents. A `pre` code block
 * (white-space: pre, 881px of YAML) inside such a track widens the track past the
 * viewport, and the whole page scrolls sideways. Reproduced on the landing page at
 * 320-980px by `scripts/viewport-overflow-crawl.mjs`.
 *
 * Rule: no grid track in the shared docs stylesheets is a bare `1fr`. Every
 * fr track is written `minmax(0, 1fr)`, at every width, so the guard needs no
 * breakpoint scoping and no exception list.
 *
 * Covered properties: grid-template, grid-template-columns, grid-template-rows,
 * grid-auto-columns, grid-auto-rows. Not covered: the `grid` shorthand (it does
 * not appear in these files).
 *
 * What this cannot catch: a layout that is wide for another reason (a fixed-px
 * width, an unbroken string outside a grid, a flex child missing `min-width: 0`).
 * The rendered crawler catches those; this static guard does not.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STYLESHEETS = [
  resolve(import.meta.dirname, 'app/(home)/home.module.css'),
  resolve(import.meta.dirname, 'app/global.css'),
];

const TRACK_DECL =
  /grid-(?:template(?:-columns|-rows)?|auto-columns|auto-rows)\s*:\s*([^;}]*)[;}]/g;

/** Every grid-track declaration whose value has a bare `fr` track (not minmax(0, ...)). */
export function bareFrTracks(css: string): string[] {
  const offenders: string[] = [];
  for (const m of css.matchAll(TRACK_DECL)) {
    const stripped = m[1].replace(/minmax\(\s*0\s*,[^)]*\)/g, '');
    if (/\b\d*fr\b/.test(stripped)) offenders.push(m[0].trim());
  }
  return offenders;
}

describe('docs stylesheets: no bare fr grid track anywhere', () => {
  for (const file of STYLESHEETS) {
    it(`${file.split('/').slice(-2).join('/')} has no bare fr track`, () => {
      expect(bareFrTracks(readFileSync(file, 'utf8'))).toEqual([]);
    });
  }

  it('flags a bare fr in grid-template-columns (negative case)', () => {
    expect(bareFrTracks('.a { grid-template-columns: 1fr 1fr; }')).toEqual([
      'grid-template-columns: 1fr 1fr;',
    ]);
  });

  it('flags a bare fr in repeat() (negative case)', () => {
    expect(bareFrTracks('.a { grid-template-columns: repeat(2, 1fr); }')).toEqual([
      'grid-template-columns: repeat(2, 1fr);',
    ]);
  });

  it('flags a bare fr in grid-auto-columns (negative case)', () => {
    expect(bareFrTracks('.a { grid-auto-columns: 1fr; }')).toEqual(['grid-auto-columns: 1fr;']);
  });

  it('flags a bare fr in grid-auto-rows (negative case)', () => {
    expect(bareFrTracks('.a { grid-auto-rows: 1fr; }')).toEqual(['grid-auto-rows: 1fr;']);
  });

  it('flags a bare fr in the grid-template shorthand (negative case)', () => {
    expect(bareFrTracks('.a { grid-template: auto / 1fr 1fr; }')).toEqual([
      'grid-template: auto / 1fr 1fr;',
    ]);
  });

  it('flags a bare fr inside a media block (negative case)', () => {
    const planted = '@media (max-width: 820px) { .codewrap { grid-template-columns: 1fr; } }';
    expect(bareFrTracks(planted)).toEqual(['grid-template-columns: 1fr;']);
  });

  it('accepts minmax(0, 1fr) in every grid-track property (positive case)', () => {
    const safe = [
      '.a { grid-template-columns: repeat(2, minmax(0, 1fr)); }',
      '.b { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }',
      '.c { grid-auto-columns: minmax(0, 1fr); }',
      '.d { grid-template: auto / minmax(0, 1fr); }',
    ].join('\n');
    expect(bareFrTracks(safe)).toEqual([]);
  });
});
