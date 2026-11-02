#!/usr/bin/env node
/**
 * Rendered responsive-overflow crawl for the docs site.
 *
 * Loads EVERY docs page (derived from content/docs, plus the landing page) at
 * each viewport width and fails a check if EITHER:
 *   (a) `document.documentElement.scrollWidth > window.innerWidth` (the page
 *       scrolls sideways), OR
 *   (b) an element's right edge is past the viewport and it is not inside a
 *       horizontal scroller (overflow-x auto/scroll, such as a `pre` or table
 *       wrapper, which scroll on purpose). (b) catches content CLIPPED by an
 *       overflow:hidden ancestor, which (a) cannot see.
 * On failure it prints the outermost offending elements.
 * Default widths: 320,360,375,390,414,600,768,820,900,1000,1024,1100,1200,1280.
 *
 * This is NOT run in CI: it needs a real browser and a built site, and that
 * would slow Lint & Test materially. The static guard
 * `apps/docs/responsive-layout.test.ts` runs in CI instead; it cannot see
 * layouts that are wide for reasons other than a bare `1fr` track, which this
 * crawl does.
 *
 * Setup (once, not committed to the lockfile):
 *   cd apps/docs && bun add --no-save playwright && bunx playwright install chromium
 * Run against a production build:
 *   cd apps/docs && bun run build && PORT=3100 bun .output/server/index.mjs &
 *   bun scripts/viewport-overflow-crawl.mjs http://localhost:3100
 * Options: --widths=320,375,414,768,1280   --json=out.json
 *          CHROME=/path/to/chrome   (optional: use an existing Chromium binary)
 */

// biome-ignore-all lint/suspicious/noConsole: a CLI that reports to stdout by design
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith('--'));
if (!base) {
  console.error('usage: viewport-overflow-crawl.mjs <baseUrl> [--widths=a,b,c] [--json=path]');
  process.exit(2);
}
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DEFAULT_WIDTHS = [320, 360, 375, 390, 414, 600, 768, 820, 900, 1000, 1024, 1100, 1200, 1280];
const widths = opt('widths', DEFAULT_WIDTHS.join(',')).split(',').map(Number);
const jsonOut = opt('json', '');

const CONTENT_DIR = resolve(import.meta.dirname, '../content/docs');

function mdxFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return mdxFiles(full);
    return full.endsWith('.mdx') ? [full] : [];
  });
}

// Route table from the content tree: index.mdx -> /docs, foo/index.mdx -> /docs/foo.
const routes = new Set(['/']);
for (const file of mdxFiles(CONTENT_DIR)) {
  let rel = relative(CONTENT_DIR, file).replace(/\.mdx$/, '');
  rel = rel === 'index' ? '' : rel.replace(/\/index$/, '');
  routes.add(rel ? `/docs/${rel}` : '/docs');
}

// Runs inside the page. Returns outermost offending elements past the viewport.
const probe = () => {
  const iw = window.innerWidth;
  const sw = document.documentElement.scrollWidth;
  const label = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const insideOwnScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };
  const offenders = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.right <= iw + 0.5) continue;
    if (insideOwnScroller(el)) continue;
    const parent = el.parentElement;
    if (parent && parent !== document.body && parent.getBoundingClientRect().right > iw + 0.5) {
      continue; // report the outermost offender only
    }
    offenders.push({ el: label(el), right: Math.round(r.right), width: Math.round(r.width) });
  }
  return {
    iw,
    sw,
    overflow: sw > iw,
    offenders: offenders.slice(0, 15),
    offenderCount: offenders.length,
  };
};

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const results = [];
for (const width of widths) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  for (const route of routes) {
    const url = base.replace(/\/$/, '') + route;
    let res;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(400);
      res = { route, width, ...(await page.evaluate(probe)) };
    } catch (err) {
      res = { route, width, error: String(err).slice(0, 200) };
    }
    results.push(res);
    const bad = res.error || res.overflow || res.offenderCount > 0;
    const tag = res.error ? 'ERR' : bad ? 'OVERFLOW' : 'ok';
    console.log(
      `${tag}\t${width}\t${route}\t${res.sw ?? ''}/${res.iw ?? ''}\t${res.offenderCount ?? ''}`,
    );
  }
  await context.close();
}
await browser.close();

// A check fails on ANY of: a navigation error, a page that scrolls sideways
// (scrollWidth), or an element past the viewport that no horizontal scroller
// contains. The third catches content CLIPPED by an overflow:hidden ancestor,
// which scrollWidth alone cannot see.
const failing = results.filter((r) => r.error || r.overflow || r.offenderCount > 0);
console.log(
  `\nSUMMARY pages=${routes.size} widths=${widths.join(',')} checks=${results.length} failing=${failing.length}`,
);
for (const r of failing) {
  console.log(`  ${r.route} @${r.width}: ${r.error ?? JSON.stringify(r.offenders)}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
process.exit(failing.length ? 1 : 0);
