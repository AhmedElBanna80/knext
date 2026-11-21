# Scale-from-zero cold start across the build-tool axis, on kind (2026-11-20 and 2026-11-21)

**Question.** Does the build tool (Turbopack vs vinext) or the runtime (Node vs Bun) move a
knext wake's cold start, and how much of the wake is the build's to change? The same four
scaffold apps were measured on two days, so the day-to-day spread is part of the answer.

**Setup.** Native amd64 kind cluster on a GitHub-hosted runner. Four arms, each a fresh
`knext create` scaffold app, each capped at 1000m CPU, n = 12 wakes per arm per day. Request to
first byte is the total. Run IDs: day 1 `44808959901` (an earlier round of the workflow, no
live-process checks); day 2 `44841667176` (the final merged workflow, with live-process
evidence).

**Answer.**

1. **The runtime is the larger lever at this build.** Bun wakes faster than Node within each
   build tool, by about 0.24 s on vinext and about 0.40 s on Turbopack (day-2 medians).
2. **vinext is the faster build tool on both runtimes.** Bun × vinext is the fastest arm on
   both days (523 ms median on day 2); Node × Turbopack is the slowest (1507 ms).
3. **Day to day, the medians moved by at most 32 ms in either direction, but p95 moved by
   up to 83 ms.** The ordering of the four arms is identical on both days.
4. **Most of the wake is not the build's to change.** Sandbox and container start is
   342–395 ms on every arm. On Turbopack the routable step (listening to ready) is about
   480 ms on Bun and about 565 ms on Node. The vinext arms do not split that middle step in the
   analysis, so the gap is shown as unsplit.

## Totals

Request to first byte, median and p95, in ms. n = 12 per arm per day.

| arm | day 1 (2026-11-20) median · p95 | day 2 (2026-11-21) median · p95 | delta median (d2 − d1) | delta p95 |
|---|---|---|---|---|
| bun × vinext | 502 · 532 | 523 · 601 | +21 | +69 |
| node × vinext | 790 · 871 | 766 · 838 | −24 | −33 |
| bun × turbopack | 1088 · 1153 | 1104 · 1236 | +16 | +83 |
| node × turbopack | 1539 · 1613 | 1507 · 1604 | −32 | −9 |

Day 1 and day 2 totals reproduce from the phase files (request time to first byte, per wake)
exactly as the analysis files report them.

## Per-arm phase tables

Phases follow the analysis definitions. Medians are not additive, so the phase medians do not
sum to the total median. Phases 4 and 5 are not split for the vinext arms in the analysis.

### bun × vinext

| phase | day 1 median · p95 | day 2 median · p95 |
|---|---|---|
| 1 activation: request → Pod object | 35 · 40 | 36 · 50 |
| 2 scheduling: Pod → bound | 12 · 17 | 11 · 17 |
| 3 sandbox + containers start: bound → first log | 327 · 365 | 342 · 402 |
| 4–5 runtime boot and routable | not split | not split |
| 6 forward + render: ready → first byte | 0 · 3 | 0 · 3 |
| total: request → first byte | 502 · 532 | 523 · 601 |

### node × vinext

| phase | day 1 median · p95 | day 2 median · p95 |
|---|---|---|
| 1 activation | 37 · 62 | 36 · 44 |
| 2 scheduling | 12 · 26 | 8 · 20 |
| 3 sandbox + containers start | 396 · 446 | 395 · 449 |
| 4–5 runtime boot and routable | not split | not split |
| 6 forward + render | 30 · 123 | 31 · 46 |
| total | 790 · 871 | 766 · 838 |

### bun × turbopack

| phase | day 1 median · p95 | day 2 median · p95 |
|---|---|---|
| 1 activation | 35 · 40 | 36 · 48 |
| 2 scheduling | 11 · 17 | 10 · 25 |
| 3 sandbox + containers start | 366 · 404 | 371 · 469 |
| 4 runtime boot: first log → Next listening | 155 · 166 | 165 · 180 |
| 5 routable: listening → ready | 488 · 548 | 478 · 516 |
| 6 forward + render | 2 · 117 | 68 · 120 |
| total | 1088 · 1153 | 1104 · 1236 |

### node × turbopack

| phase | day 1 median · p95 | day 2 median · p95 |
|---|---|---|
| 1 activation | 37 · 50 | 34 · 40 |
| 2 scheduling | 14 · 21 | 11 · 20 |
| 3 sandbox + containers start | 403 · 453 | 395 · 442 |
| 4 runtime boot: first log → Next listening | 489 · 511 | 486 · 521 |
| 5 routable: listening → ready | 576 · 611 | 564 · 602 |
| 6 forward + render | 12 · 16 | 14 · 35 |
| total | 1539 · 1613 | 1507 · 1604 |

## Bytecode evidence per arm

Evidence files: `data/coldstart-buildtool-kind-native-2026-11-20/evidence-*.json` and
`data/coldstart-buildtool-kind-native-2026-11-21/evidence-*.json`.

| arm | kind | build-time evidence (day 2) | live evidence (day 2) |
|---|---|---|---|
| node × vinext | V8 compile cache at `/app/.compile-cache` | 1,462,428 bytes in 103 files (day 1: 1,462,500 bytes, 103 files) | `NODE_COMPILE_CACHE=/app/.compile-cache` set in the live main process (pid 6180) |
| node × turbopack | V8 compile cache at `/app/.next/standalone/.next/compile-cache` | 1,433,804 bytes in 465 files (day 1: 1,433,780 bytes, 465 files) | `NODE_COMPILE_CACHE` matches the cache dir in the live supervisor child (pid 5494) |
| bun × vinext | Bun bytecode, `/app/server`, 84,678,192 bytes | method `pragma-differential`: `@bytecode` pragma count app=2, baseline=1 | none (no build-time marker verification) |
| bun × turbopack | Bun bytecode, `/app/.next/standalone/knext-standalone-exec`, 92,411,440 bytes | method `marker`: verified, the binary sits under a `@bytecode` pragma with a constant-pool copy | live child pid 5819 matched by `argv0` to the executable |

Compile-cache byte totals differ by 24–72 bytes between days. That is expected for this
layer, which is not bit-reproducible, so the byte counts are evidence of a cache that was baked,
not of identical builds.

## Day-to-day delta

The four arms kept their order across both days. The largest median move is bun × vinext
(+21 ms) and the largest p95 move is bun × turbopack (+83 ms). Phase by phase, the sandbox step
moved by at most 15 ms on the vinext arms and by 8 ms on the turbopack arms. Bun × turbopack's
p95 movement (+83 ms) is mostly its sandbox step's p95 (404 → 469 ms). Its forward-and-render
median also swung from 2 ms to 68 ms between days, a bimodal step that the median alone hides.
Day 2 had
the live-process checks; day 1 did not, so day-1 bytecode evidence is the build-time record only.

## Caveats

- **bun × vinext has no build-time marker verification.** It has only a pragma differential
  (`app=2`, baseline `1`). A fix that adds marker verification for this arm is in flight, so
  its bytecode claim is weaker than the other three arms'.
- **`spec_runtime` is empty in both vinext arms' evidence** on both days. The arm names carry the
  runtime, but the evidence does not record it for the vinext builds.
- **Day 1 had no live checks.** Its bytecode evidence is build-time only. Day 2 is the only day
  that confirmed the running process uses the cache or the executable.
- **kind on a GitHub-hosted runner is not OKE.** These numbers are not comparable to the OKE
  cold-start numbers in the user docs, and not to the spike-zone kind numbers in
  [`zone-functions-coldstart-kind-2026-10-09.md`](../benchmarks/zone-functions-coldstart-kind-2026-10-09.md)
  (a different cluster and a different apparatus).
- **Which phase dominates.** The sandbox and container start is 342–395 ms on every arm, and it
  is the only large split phase on the vinext arms, whose runtime and routable steps are not
  split. On Turbopack, the routable step (listening to
  ready) is about 480 ms on Bun and about 565 ms on Node. That step is the Turbopack-specific
  target, not the sandbox.
- **Phase 3 is definition-sensitive for the Node arms.** The analysis measures this phase from a
  start event that is not reproducible from the committed files (the analysis script was not
  part of the artifacts). Re-deriving phase 3 as "bound → first user-container log line" from
  the phase files gives 342 and 371 ms for the bun arms (day 2), matching the analysis, but
  454–528 ms for the Node arms across both days. The total is unaffected, because it is measured independently.
  Read the Node sandbox figure as 395 ms per the analysis, with this caveat.
- **Medians are not additive**, so the phase medians do not sum to the total median.
