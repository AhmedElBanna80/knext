#!/usr/bin/env node
// Keeps every hand-citable count in the repo's EGM.md files derived.
//
// A counted number in a doc is written `N<!--egm:KEY-->` (or a number word
// from zero to twelve in the same place). KEY names a rule in
// `egm-counts.manifest.json`, which defines the quantity as a directory
// listing, a content grep over a file set, or a count of JSON keys. Numbers
// that are not counts (ports, timeouts, limits) carry no marker and are left
// alone.
//
//   node scripts/egm-counts.mjs --check   exit 1, naming each line whose
//                                         number differs from the computed one
//   node scripts/egm-counts.mjs --write   rewrite those numbers in place
//
// Options: --root <dir> (default: the repo root), --manifest <file>.
// Check also fails on a marker whose key is not in the manifest, and on a
// manifest key that no doc cites (a dead rule is as stale as a wrong number).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', '.claude', '.next']);
const MARKER = new RegExp(
  `(\\d[\\d,]*|\\b(?:${WORDS.join('|')}))<!--egm:([A-Za-z0-9._-]+)-->`,
  'g',
);

export function computeCount(rule, root) {
  if (rule.kind === 'entries') {
    const dir = join(root, rule.dir);
    const name = rule.name ? new RegExp(rule.name) : null;
    const exclude = rule.exclude ? new RegExp(rule.exclude) : null;
    return readdirSync(dir, { withFileTypes: true }).filter((e) => {
      const kind = e.isDirectory() ? 'dir' : 'file';
      if (rule.type && rule.type !== 'any' && rule.type !== kind) return false;
      if (name && !name.test(e.name)) return false;
      if (exclude?.test(e.name)) return false;
      return true;
    }).length;
  }
  if (rule.kind === 'grep') {
    const dir = join(root, rule.dir);
    const name = new RegExp(rule.name);
    const pat = new RegExp(rule.pattern);
    return readdirSync(dir, { withFileTypes: true }).filter(
      (e) => e.isFile() && name.test(e.name) && pat.test(readFileSync(join(dir, e.name), 'utf8')),
    ).length;
  }
  if (rule.kind === 'json-keys') {
    let node = JSON.parse(readFileSync(join(root, rule.file), 'utf8'));
    for (const seg of rule.path.split('.')) node = node?.[seg];
    if (!node || typeof node !== 'object')
      throw new Error(`json-keys: no object at ${rule.file}#${rule.path}`);
    return Object.keys(node).filter((k) => k.startsWith(rule.prefix ?? '')).length;
  }
  throw new Error(`unknown rule kind: ${rule.kind}`);
}

function findDocs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) findDocs(join(dir, e.name), out);
    } else if (e.name === 'EGM.md') out.push(join(dir, e.name));
  }
  return out.sort();
}

function parseCited(text) {
  return text === ''
    ? 0
    : WORDS.includes(text)
      ? WORDS.indexOf(text)
      : Number(text.replace(/,/g, ''));
}

function render(n, old) {
  if (WORDS.includes(old) && n <= 12) return WORDS[n];
  return String(n);
}

export function run({ root, manifestPath, write }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const computed = {};
  for (const [key, rule] of Object.entries(manifest.counts))
    computed[key] = computeCount(rule, root);
  const problems = [];
  const used = new Set();
  let derived = 0;
  for (const file of findDocs(root)) {
    const rel = relative(root, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    let changed = false;
    lines.forEach((line, i) => {
      lines[i] = line.replace(MARKER, (whole, cited, key) => {
        derived++;
        used.add(key);
        if (!(key in computed)) {
          problems.push(`${rel}:${i + 1}: unknown count key "${key}"`);
          return whole;
        }
        if (parseCited(cited) === computed[key]) return whole;
        problems.push(`${rel}:${i + 1}: ${key} says ${cited}, computed ${computed[key]}`);
        changed = true;
        return `${render(computed[key], cited)}<!--egm:${key}-->`;
      });
    });
    if (write && changed) writeFileSync(file, lines.join('\n'));
  }
  for (const key of Object.keys(computed)) {
    if (!used.has(key)) problems.push(`manifest key "${key}" is cited by no EGM.md`);
  }
  return { problems, derived, computed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
  const write = args.includes('--write');
  if (write === args.includes('--check')) {
    console.error('usage: egm-counts.mjs (--check | --write) [--root DIR] [--manifest FILE]');
    process.exit(2);
  }
  const root = resolve(opt('--root', join(HERE, '..')));
  const manifestPath = resolve(opt('--manifest', join(HERE, 'egm-counts.manifest.json')));
  if (!existsSync(manifestPath) || !statSync(root).isDirectory()) {
    console.error('egm-counts: manifest or root not found');
    process.exit(2);
  }
  const { problems, derived } = run({ root, manifestPath, write });
  if (write) {
    console.log(
      `egm-counts: ${derived} derived counts; ${problems.filter((p) => p.includes(' says ')).length} rewritten`,
    );
    const fatal = problems.filter((p) => !p.includes(' says '));
    for (const p of fatal) console.error(`egm-counts: ${p}`);
    process.exit(fatal.length ? 1 : 0);
  }
  if (problems.length) {
    for (const p of problems) console.error(`egm-counts: ${p}`);
    console.error('egm-counts: run `node scripts/egm-counts.mjs --write` to fix.');
    process.exit(1);
  }
  console.log(`egm-counts: ${derived} derived counts, all match`);
}
