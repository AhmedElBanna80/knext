# `unstable_cache` key across artifact shapes (kind, 2026-11-14)

Measurement record behind the "`unstable_cache` entries are not shared with Node" limitation on the
Bun runtime docs page. Local kind cluster, next 16.4.3, one fixture app (`cdn-kind-app`, route
`/rb-stamp`), three artifact shapes deployed in turn against one shared Redis. All three are the default
(standalone, not vinext) build target:

- `sc`: `runtime: 'bun'`, `selfContained: true`: the standalone server compiled into one executable
  that embeds `.next/server`; the operator renders no container command.
- `disk`: `runtime: 'bun'`, `selfContained: false`: the standalone tree, run as `bun run server.js`.
- `node`: `runtime: 'node'`: the image default command.

## 1. Redis keys per shape

After the self-contained Bun executable, the Node image and the Bun standalone (disk) image each
served `/rb-stamp`, Redis held **two** keys for the one `unstable_cache` call:

| key written by | later read by |
|---|---|
| self-contained Bun executable | Node |
| Bun standalone (disk) | a later Bun standalone build |

Node and the self-contained executable agree; the Bun standalone target uses a different key.

## 2. The chunk text is the same

The route chunk under `.next/server` is byte-identical in the Bun standalone and Node images, so
the difference is introduced at load time, not at build time.

## 3. `Function.prototype.toString` differs at load

Next derives the key from `${cb.toString()}-${keyParts}` (`unstable-cache.js`, line 54 in 16.4.3).
Loading the same minified chunk line and printing the callback:

- Node returns the chunk's exact text (`async()=>…`).
- Bun returns re-printed text (`async () => …`, spaces added by the runtime transpiler).
- With a `// @bun` first line (which skips Bun's transform) Bun returns the exact text.

## 4. ISR pages are shared

The ISR page `/tagged` carries the mark of the build that stored it. After each shape switch the
new shape served the HTML the previous shape had stored (the mark did not change until
revalidation), so ISR entries, keyed by path, were read across all three shapes. This is why the
lane uses a per-request route, not the ISR page, as its serving signal.

## What was not measured

The repro in section 3 loads the chunk with `bun` directly rather than inside the `disk` image; it
is the same loader `bun run server.js` uses.

The refill cost after a shape switch was not timed; the docs state only that the entries are
computed and stored again under the new key, which follows from a key miss.
