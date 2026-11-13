# Four release cells, cold start on OKE — re-run on 1.3.1 (2026-11-13)

A re-run of [`release-cells-cold-start-2026-09-30.md`](release-cells-cold-start-2026-09-30.md) with the
current published CLI. Same cluster, same instrument, same interleaving, same analysis. What changed is
the app (scaffolded by `@getknext/core` 1.3.1 instead of 1.0.0-rc.2) and Next.js (16.3.8 instead of 16.3.5).

## Result

n = 10 per cell, 40 attempted cold cycles, **40 valid, none excluded, no image pull in any cycle**
(every cycle's pod events read `already present on machine`). Cold = request sent → full page received,
measured with `curl` `time_total` inside the cluster.

| cell | cold median | IQR | min–max | warm median |
|---|---|---|---|---|
| Bun × turbopack (default) | **1577.5 ms** | 1477–1666 | 1368–1811 | 21 ms |
| Bun × webpack | **1629 ms** | 1480–1955 | 1147–2211 | 21.5 ms |
| Node × turbopack | **1720.5 ms** | 1520–1976 | 1445–2077 | 25 ms |
| Node × webpack | **1987.5 ms** | 1693–2142 | 1499–2363 | 25 ms |

- **No wake reached 3 s.** The slowest of the 40 was 2363 ms.
- **One pair differs after correction:** Node × webpack is slower than Bun × turbopack by 410 ms at the
  median (exact Mann-Whitney p = 0.0029, Holm 0.017, bootstrap 95% CI +92 to +633 ms). The other five
  pairs do not (Holm ≥ 0.52; every CI spans zero).
- **By factor**, Node is 290 ms slower than Bun pooled over builders (normal-approx p = 0.03) but the
  bootstrap CI of that difference (−12 to +472 ms) touches zero, so this run does not establish a runtime
  effect on its own. Turbopack vs webpack: −176 ms, p = 0.08, CI spans zero.
- **Warm requests:** Bun 21 ms, Node 25 ms. On 2026-09-30 the order was reversed (Node 24 ms, Bun 31 ms),
  so treat warm-request differences of a few milliseconds as noise between builds, not a runtime property.
- **Coarse timeline (Kubernetes 1 s timestamps, medians):** pod created ~0 s, container started ~1 s,
  pod Ready 1–2 s after the request, the same shape for all four cells.

### Against 2026-09-30

Medians moved from 2056–2425 ms to 1577–1988 ms, about 0.4–0.6 s lower per cell, and the tail is gone
(max 2363 ms vs 3216–10 375 ms). These are two separate sittings with different app builds, so the
comparison is descriptive: the knext release (1.0.0-rc.2 → 1.3.1), the operator and Next.js
(16.3.5 → 16.3.8) all differ between them, and the cause of the shift was not isolated.

## Conditions

- **Cluster:** OKE `knext-oke` (context `knext-oke-sa`), Kubernetes 1.34.10, CRI-O 1.34.8, runc,
  2 × VM.Standard.E4.Flex (4 vCPU / 16 GB), Knative Serving with Kourier. Other pods running at the time
  were idle helpers only (image-cache holders, clock and agent pods); every app in the cluster had
  `minScale: 0`.
- **App:** four scaffolds from `npx -p @getknext/core@1.3.1 knext create bc13-<cell> --runtime <rt>
  --builder <bd> --yes` (core and lib 1.3.1, `next` 16.3.8, React Compiler on, the scaffold's defaults).
  Each gets the same `force-dynamic` page ([`page.tsx`](data/release-cells-cold-start-oke-2026-11-13/page.tsx))
  that fetches 50 items from its own `/api/items` route ([`items-route.ts`](data/release-cells-cold-start-oke-2026-11-13/items-route.ts))
  over loopback. Bench-only deltas, identical across cells: `maxScale: 1`, the scaffold's
  `scaleDownDelay: "5m"` removed, `registry` and `imagePullSecrets` set.
- **Build:** Cloud Build `1f91587c-c458-4c65-81f5-431f2c5e5dc1` (`E2_HIGHCPU_8`): per cell `npm install`,
  `knext build`, then the published `Dockerfile.standalone` with the target `knext deploy` selects
  (`standalone-bun`, or `standalone-node` with the compile-cache bake). The Bun cells logged
  `Standalone executable compiled (bytecode verified)`; the Node cells baked 1 352 848 bytes in 470 files
  (turbopack) and 1 373 484 bytes in 451 files (webpack). Scripts: [`cloudbuild.yaml`](data/release-cells-cold-start-oke-2026-11-13/cloudbuild.yaml),
  [`build-cells.sh`](data/release-cells-cold-start-oke-2026-11-13/build-cells.sh),
  [`image-cells.sh`](data/release-cells-cold-start-oke-2026-11-13/image-cells.sh).
- **Images** (copied by digest to GHCR, digests verified identical on both sides):

  | cell | image | digest |
  |---|---|---|
  | Node × turbopack | `ghcr.io/getknext-dev/bench13-node-turbopack` | `sha256:a0be45cb50e50b78b4aa9af3dc56df8c62737f7b3e5502f5a3d60b518e582d63` |
  | Node × webpack | `ghcr.io/getknext-dev/bench13-node-webpack` | `sha256:e8b37e20e6df41d5e11d8174916ea107cddbc2bbf014b982cb53499128cc1c6a` |
  | Bun × turbopack | `ghcr.io/getknext-dev/bench13-bun-turbopack` | `sha256:1477152f4db2a27b86b11468f2c47749e3727c0cac00576eafae02eb7d36eec2` |
  | Bun × webpack | `ghcr.io/getknext-dev/bench13-bun-webpack` | `sha256:bb86e20f7ba7aeb88b259555ed5e49f183a2bb967b2d65232c55447594479625` |

- **Deploy:** `knext deploy --context knext-oke-sa -n bench-cells --image <ref>@<digest>` (CLI 1.3.1),
  i.e. a `NextApp` CR reconciled by the operator. Read back from the Knative Services: `min-scale 0`,
  `max-scale 1`, requests 250m / 512Mi, limits 1 CPU / 1Gi, readiness probe `GET /api/health`; Bun cells
  run `bun run server.js`, Node cells the image entrypoint.
- **Pre-pull:** every image pulled onto both nodes before the sitting.
- **Instrument and interleaving:** as on 2026-09-30 — an in-cluster `curlimages/curl:8.10.1` pod
  (`bench-timer13`, node 10.0.1.118); 10 rounds, each waiting until all four cells are at zero pods, then
  waking each once, forward order on odd rounds and reverse on even. Each cell landed on each node 5 of
  10 times. Driver: [`cells_bench.py`](data/release-cells-cold-start-oke-2026-11-13/cells_bench.py),
  identical to the 2026-09-30 Appendix B except the timer pod's name and a marker check that records a
  failed response instead of aborting. Sitting: 2026-11-13, 22:16–22:42 UTC.
- **An earlier attempt** at 22:12 aborted on its first cycle, before writing any row: the original
  driver's marker check exited non-zero and stopped the run. A manual cold request immediately after
  returned 200 with the marker in 1584 ms. No row from that attempt exists, so none was discarded.

Raw rows: [`run.jsonl`](data/release-cells-cold-start-oke-2026-11-13/run.jsonl). Every number above is
the output of [`analyze.py`](data/release-cells-cold-start-oke-2026-11-13/analyze.py)
([`analysis.txt`](data/release-cells-cold-start-oke-2026-11-13/analysis.txt)).

## Caveats

- One app, light first render, no database, cache or object storage, images pre-pulled, a quiet two-node
  cluster. A heavier first render, a dependency that must wake, an image pull or a busy cluster all add.
- n = 10 per cell. Differences under a few hundred milliseconds are inside the noise at this size.

## Found in passing

The Node images log at every start that `@getknext/lib/clients` is not present in the runtime image, so
DB-pool drain and image-cache sync are disabled. That is the published 1.3.1 template's current
behaviour, unrelated to the timings; tracked separately.

## Left in the cluster

Namespace `bench-cells`: NextApps `bc13-node-turbopack`, `bc13-node-webpack`, `bc13-bun-turbopack`,
`bc13-bun-webpack` (all at zero), the eight `pp13-*` pre-pull pods (Completed), and `bench-timer13`
(a `sleep 21600` that completes on its own). Nothing serves traffic.
