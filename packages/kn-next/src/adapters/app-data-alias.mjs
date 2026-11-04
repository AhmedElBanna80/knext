/**
 * Runtime half of the embedded app data files (see `app-data-embed.mjs`).
 *
 * A file imported `with { type: "file" }` is readable with `fs` at
 * `/$bunfs/root/<path relative to the app root>`, but the app asks for it by
 * the path it has on disk: `join(process.cwd(), "data/a.json")`, a relative
 * `"data/a.json"`, or the build machine's absolute path. This points exactly
 * those paths — and only the embedded files' paths — at the embedded copy.
 *
 * THE REAL DISK WINS. A read goes to the embedded copy only when nothing exists
 * at the path on the real filesystem, so a file the app writes at runtime over
 * an embedded name is read back as written, and the build machine's absolute
 * path (aliased as a fallback, for code that baked it in) can never shadow a
 * file that exists there at runtime. Deleting a file that was embedded at build
 * time therefore uncovers the embedded copy.
 *
 * READ operations only: `readFile`, `access`, `stat`, `lstat`, `existsSync` and
 * the source of `copyFile`, in their sync, callback and promise forms, plus a
 * `file:` URL argument. NOT aliased: `readdir`, `opendir`, `open`,
 * `createReadStream` (Bun cannot stream from `$bunfs` either), `Bun.file()`,
 * and anything that writes — a write to the same path goes to the real disk as
 * it always did. A file that is not embedded is untouched, so it is still a
 * real ENOENT.
 *
 * Patching the module object reaches `import fs from "node:fs"` and
 * `require("fs")`, but NOT `import { readFileSync } from "node:fs"`: Bun gives
 * ESM named imports of a builtin a snapshot of its exports. The compile script
 * therefore routes the bundle's `fs` imports through a facade that re-exports
 * the patched functions by name (`ALIASED_FS`).
 *
 * No upstream fix replaces this: Bun maps no real directory onto `$bunfs`, so a
 * `process.cwd()`-relative read of an embedded file needs a path alias.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** fs entry points whose FIRST argument is only ever READ. */
export const ALIASED_FS = {
  fs: [
    'readFile',
    'readFileSync',
    'access',
    'accessSync',
    'stat',
    'statSync',
    'lstat',
    'lstatSync',
    'existsSync',
    'copyFile',
    'copyFileSync',
  ],
  promises: ['readFile', 'access', 'stat', 'lstat', 'copyFile'],
};

/**
 * @param {{ rel: string, path: string }[]} files `rel`: posix path under the app root (an alias of a link is its own row); `path`: the embedded copy
 * @param {{ appRoot: string, cwd?: string }} where the build machine's app root, and the runtime cwd
 * @returns {(p: unknown) => unknown} the path mapper (identity for anything not embedded, or present on disk)
 */
export function installEmbeddedDataAlias(files, { appRoot, cwd = process.cwd() }) {
  // The unpatched existsSync, whatever number of times this has run before.
  const onDisk = fs.existsSync.__knextDataAliasOrig ?? fs.existsSync;
  const exact = new Map();
  for (const { rel, path } of files) {
    const parts = rel.split('/');
    exact.set(resolve(join(appRoot, ...parts)), path);
    exact.set(resolve(join(cwd, ...parts)), path);
    // Bun embeds a root-level file as `/$bunfs/root/./x.json`; a read of the
    // normalised `/$bunfs/root/x.json` (a `new URL()` against the entry) must find it.
    exact.set(resolve(path), path);
  }
  const map = (p) => {
    if (exact.size === 0) return p;
    let local;
    if (p instanceof URL && p.protocol === 'file:') {
      try {
        local = fileURLToPath(p);
      } catch {
        return p;
      }
    } else if (typeof p === 'string' && p !== '') {
      local = p;
    } else {
      return p;
    }
    const embedded = exact.get(resolve(local));
    if (embedded === undefined) return p;
    return onDisk(local) ? p : embedded;
  };
  const wrap = (obj, name) => {
    const orig = obj?.[name];
    if (typeof orig !== 'function' || orig.__knextDataAlias) return;
    const wrapped = function (...args) {
      args[0] = map(args[0]);
      return orig.apply(this, args);
    };
    wrapped.__knextDataAlias = true;
    wrapped.__knextDataAliasOrig = orig;
    for (const key of Reflect.ownKeys(orig)) {
      if (key === 'length' || key === 'name' || key === 'prototype') continue;
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(orig, key));
      } catch {}
    }
    obj[name] = wrapped;
  };
  for (const name of ALIASED_FS.fs) wrap(fs, name);
  for (const name of ALIASED_FS.promises) {
    wrap(fsp, name);
    if (fs.promises && fs.promises !== fsp) wrap(fs.promises, name);
  }
  return map;
}
