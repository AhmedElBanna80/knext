# Bun cold start on OKE: patched Bun, phase split, and self-warm (2026-11-09)

Three measurements, run one at a time on the same cluster on the same day. The founder approved
running them on OKE and asked for one improvement at a time, each measured.

**Setup, common to all three.**
- Cluster: OKE, context `knext-oke-sa`, namespace `bench-cells`, two worker nodes (`10.0.1.118`, `10.0.1.169`), CRI-O 1.34.
- App: the default scaffold built from main `14de65d23`, a `GET /` SSR page, with `maxScale: 1`.
- Images were pre-pulled on both nodes by a throwaway pod per image and node.
- Times are in ms, from the request to the first response byte.

## 1. Patched Bun, three arms (n=66 per arm)

The driver was `bench3-incluster.py`: an in-pod `node` probe from `agent-118`, with the arm order permuted each round. 198 cold starts, 0 excluded.

| Arm | Image | Median | IQR | p95 |
|---|---|---|---|---|
| A | vinext build, self-contained single executable, stock Bun | 1821 | 1598–2013 | 2307 |
| B | Next standalone build, Bun; the supervisor spawns the compiled executable (exec mode) | 1610 | 1312–1854 | 2160 |
| C | vinext build, self-contained single executable, patched Bun (`bun-patched-1.4.4-knext.3`) | 1623 | 1348–1979 | 2371 |

Paired by round, as the median difference with a 95% bootstrap CI:
- C − A: −113 [−323, +77] (the patch alone, same build pipeline);
- B − A: −226 [−328, +3] (different build pipelines as well as images, so not a runtime comparison);
- C − B: +87 [−59, +254].

**No arm wins**: every CI includes 0.

**Flaw.** Node placement was not balanced. C ran 55 of 66 rounds on `.118`, while A and B ran mostly on `.169`. The next two runs used the phase harness, which records the node of every cycle.

## 2. Phase split of arm B (n=30)

The harness was `scripts/bench-cold-start-phases/drive.py` with the harness pod on `.118`.

The harness's page marker (`items:50`) belongs to another test app, so every row was marked valid by hand. All 30 rows answered 200, and none was excluded on any other ground.

| Phase | Median | IQR |
|---|---|---|
| 1 activation: request → Pod object | 103 | 88–133 |
| 2 scheduling | 12 | 10–18 |
| 3 sandbox + containers start: bound → first log line | 489 | 455–884 |
| 4 runtime boot: first log → listening | **147** | 140–156 |
| 5 routable: listening → ready | **568** | 432–744 |
| 6 ready → first byte (first render) | 106 | 100–111 |
| total | 1656 | 1464–1828 |
| 5x first log → pod IP visible in the API | 680 | 534–857 |
| 5z listening → `/api/health` 200, same node, direct | 585 | 444–746 |

Bun reaches "listening" 147 ms after its first log line. The server then waits about 550 ms before the cluster can route to it: the pod's IP reaches the API about 680 ms after the first log line, which is kubelet status latency on these nodes (EventedPLEG is off; kubelet relists about once a second). **The runtime is not the bottleneck; phases 3 and 5 are platform time.** Phase 6, the first render, is the one term inside knext's reach that this split exposes.

## 3. Self-warm A/B (n=30 per arm, interleaved)

| | bp-b (control) | bp-w (self-warm) |
|---|---|---|
| Image | arm B above (Next standalone, Bun, exec mode) | the same build with one change: the supervisor's first deferred step requests `/` on loopback once the child is serving |

All 60 cycles answered 200, and the harness was the same as in run 2.

| Metric | bp-b median | bp-w median | Paired diff, 95% CI | Hodges–Lehmann | Mann–Whitney p | bp-w faster |
|---|---|---|---|---|---|---|
| ready → first byte | 94 | **16** | **−69 [−85, −54]** | −72 | < 0.001 | 27/30 |
| total | 1604 | 1533 | −72 [−360, +173] | −64 | 0.32 | 17/30 |
| bound → ready (phases 3–5) | 1411 | 1368 | −7 [−238, +238] | −22 | 0.76 | 16/30 |

By node (total median):

| Node | bp-b | bp-w |
|---|---|---|
| `.118` | 1589 | 1411 |
| `.169` | 1618 | 1679 |

**Reading.** Self-warm removes the first render from the critical path: about −70 ms on that phase, significant and consistent (27 of 30 rounds). The total cold start was **not** shown to improve: its paired CI spans 0 and on node `.169` its median rose (1618 → 1679), within the roughly 400 ms spread of the platform phases. The phase result is the claim; a total-time claim needs a larger sample.

**What shipped.** ADR-0042 promotes a boot warm in the supervisor only above a 200 ms first-request cost, and keeps `/` out of the defaults (the warm request has no cookies and writes the shared page cache). 94 ms is below that bar, so the supervisor warm ships **opt-in**, on ADR-0042's `KNEXT_WARM_PATH` / `KNEXT_EAGER_WARM` surface, and the benchmark warmed the same `/` it then requested (the best case).

**What would move the median further**, in order:

1. **Kubelet status latency (phase 5, about 550 ms).** Enabling EventedPLEG and CRI-O pod events on the node pool is a node configuration change and a founder decision.
2. **Sandbox and container start (phase 3, about 490 ms).** This is platform time.

Neither is in knext's code.

## Data

- `docs/benchmarks/data/bun-patch-3arm-oke-2026-11-09.jsonl`
- `docs/benchmarks/data/bun-phase-split-oke-2026-11-09.jsonl`
- `docs/benchmarks/data/bun-self-warm-ab-oke-2026-11-09.jsonl`

## Limitations

- One app, a small SSR page. A heavier `/` gains more from self-warm, and a page whose cost is in data fetching gains less.
- Self-warm warms `/`, and the benchmark requests `/`. A first visitor to another path gets only the shared part of the warm-up: Next's render pipeline and the shared chunks.
- Run 1's node placement was unbalanced (see its Flaw note).
