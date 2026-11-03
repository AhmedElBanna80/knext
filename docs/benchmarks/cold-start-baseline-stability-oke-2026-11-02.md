# Why the OKE cold-start baseline moved, and a protocol to judge future fixes (2026-11-02)

**Question:** the same app, image and CPU settings (`cpu-base`) measured a median of 1276 ms in a three-arm run and 1806 ms in a later single-arm run. What moved it, and how should future A/B runs be designed so a fix can be judged?

**Short answer:** the shift is partly associated with how often a wake lands in a **slower cluster** of start times; by this study's numbers that accounts for about half of the same-node difference, not all of it. In the slower cluster the segment from pod bound to the app's first log is about 886 ms instead of about 445 ms, and the whole wake is about 590 ms slower. That cluster held 21% of wakes on node 10.0.1.169 in the three-arm run and 58–60% on the same node in the two later runs; with the multiple tests run, that change in share is suggestive, not established. The node, the wake spacing, a time trend and visible background load were not detected as factors, which is not the same as excluded. Why the share changed is **not identified**.

## Conditions

- OKE, two workers (10.0.1.118, 10.0.1.169), Knative Serving 1.16.0. App `cpu-base` (bun runtime, default resources, minScale 0, maxScale 1), same image digest as the earlier runs.
- Instrument: the existing `drive.py` and in-cluster harness (`cold-cycle.mjs`), unchanged; a thin wrapper (`baseline-stability-drive.py`) records background readings around each wake.
- Metric: request to response end, in ms.
- Balanced run, 2026-11-02, 18:05 to 20:43 UTC: **35 rounds, 70 wakes**; 35 are `cpu-base`, 35 are a companion app (`cpu-boost2req`) woken in the same round to steer natural placement. Planned 36 rounds; the driver stopped after round 35. Only `cpu-base` wakes are analysed as the target. All 35 returned HTTP 200.
- Placement used the scheduler's natural spreading only (the CRD has no node field, so nothing was pinned). Target wakes: 15 on .118, 20 on .169.
- Spacing: two levels in blocks of two rounds. Short = the harness's shortest cycle (wait for zero pods, median 84 s, plus 10 s). Long = the same plus 150 s.
- Background: before and after every wake, both nodes' kubelet summary (node CPU, CPU pressure-stall average, memory, per-pod CPU of the busiest pods) and the pods bound to each node, read through the API. Nothing was created, patched, scaled or deleted.

## Measured

### Offline: the two committed runs (cpu-base only)

| Run | n | Median ms | Node split |
|---|---|---|---|
| Three-arm | 20 | 1276 | .118: 6 (1208), .169: 14 (1409) |
| Single-arm | 25 | 1806 | all .169 |

- **Same node, different day:** .169 single-arm minus .169 three-arm = **+397 ms**, 95% CI [+165, +666], permutation p = 0.007. The node is therefore not sufficient on its own.
- Node within the three-arm run: .169 minus .118 = +201 ms, CI [-41, +403], p = 0.25 (n = 6 on .118).
- Spacing was about the same in both runs: gap between consecutive cpu-base wakes 2.1 min (three-arm) and 1.9 min (single-arm); zero-pod wait median 92 s and 90 s. Seconds since the previous wake on the same node vs total: Spearman rho = +0.12, p = 0.62.
- Within each run no time trend: three-arm -382 ms/h, CI [-996, +261]; single-arm -96 ms/h, CI [-597, +388].
- Order (forward vs reversed): +182 ms, CI [-177, +503], p = 0.29.
- Segment on .169: bound→first user log median 865 ms (single) vs 462 ms (three-arm); bound→pod IP in API 1507 vs 1162 ms; pod IP→response end 150 vs 157 ms.
- In the three-arm run the first-woken arm of a round always landed on .169, so node and slot are confounded there.

### Balanced run (35 target wakes)

Overall median 1645 ms, mean 1653, sd 342.

| Factor | Effect on total | 95% CI | p |
|---|---|---|---|
| Node .169 minus .118 (15 / 20 wakes) | +182 ms | [-45, +503] | 0.10 |
| Long minus short spacing | -20 ms | [-301, +304] | 0.62 |
| Time trend over 2.6 h | -20 ms/h | [-161, +93] | 0.79 (rank) |
| Slot (first vs second in the round) | +62 ms | [-152, +397] | 0.28 |

**The node and slot rows are one contrast.** In this run all 15 target wakes on .118 were at slot 1 and 18 of the 20 on .169 were at slot 0, so the data cannot separate a node effect from a slot effect; the two rows measure nearly the same split of the wakes.

- The node comparison by segment: bound→first user log .169 870 vs .118 435 ms (+435); wake→bound +40 ms; pod IP→end +4 ms.
- Compared with the earlier runs on the same node: .169 live minus three-arm +255 ms, CI [+55, +571]; .169 live minus single-arm -142 ms, CI [-320, +99]; .118 live minus three-arm +274 ms, CI [-3, +517].
- Background: node CPU use before the wake (about 75 to 159 millicores), memory, pod counts and the CPU pressure-stall average showed no rank correlation with the total that reached p < 0.05, but with 34 to 35 wakes the intervals cannot exclude moderate correlations. The largest were within .169, memory before the wake +0.43 (p = 0.063) and memory after the wake +0.39 (p = 0.081), the bench-cells running-pod count after the wake -0.32 (p = 0.059), and on .118 pre-wake memory -0.46 (p = 0.082). The pressure-stall average and the total running-pod count were constant, so they could not explain anything. Memory differs by node only as a node label (about 5.5 GB on .169, 6.8 GB on .118). These are many uncorrected looks and are leads at most.

### The start mode

`bound → first user log` falls into **two clusters with a few wakes between them**; it is not a clean bimodal split. Across all 79 target wakes (three runs), a **faster cluster** has median 445 ms (range 409–643, n = 46) and a **slower cluster** has median 886 ms (range 659–915, n = 33). The difference of the two medians is 441 ms, but that is not a gap in the data: at the 650 ms cut the highest faster value is 643 and the lowest slower value is 659, 15 ms apart. The largest gap between adjacent sorted values is 191 ms (664 to 855), and the 650 cut splits a tight group of four values at 643, 659, 662 and 664. A Silverman critical-bandwidth test rejects a single mode (bandwidth 169 ms, p = 0.005, smoothed bootstrap); no Hartigan dip test was run. This study does not show that the two clusters are two distinct mechanisms.

- Share of wakes in the slower cluster depends on the cut: 47% (37 of 79) at 500 ms, 42% (33 of 79) at 650 ms, 38% (30 of 79) at 760 ms. The pattern by run and node holds at all three cuts. On .169: 29%, 21%, 14% (three-arm), 63%, 58%, 54% (single-arm), 65%, 60%, 55% (balanced). On .118: 33%, 17%, 17% (three-arm) and 20% at every cut (balanced).
- Total, slower minus faster (650 cut): **+590 ms**, CI [+363, +792].
- Share at the 650 cut (Wilson 95% interval):

| Run / node | Slower cluster | Share |
|---|---|---|
| Three-arm / .118 | 1 of 6 | 17% [3, 56] |
| Three-arm / .169 | 3 of 14 | 21% [8, 48] |
| Single-arm / .169 | 14 of 24 | 58% [39, 76] |
| Balanced / .118 | 3 of 15 | 20% [7, 45] |
| Balanced / .169 | 12 of 20 | 60% [39, 78] |

- Three-arm .169 vs single-arm .169: Fisher exact p = 0.043; vs balanced .169: p = 0.038. On .118 the share did not change between days (p = 1.0). Within the balanced run, .169 vs .118: p = 0.037 (confounded with slot, see above). **These p-values are uncorrected.** About 4 mode tests and about 15 other tests were run, and two of the mode tests share the same reference group. Bonferroni over 4 turns 0.043 into about 0.17 (0.038 and 0.037 into about 0.15); over all 19 it is about 0.8. The change in share is suggestive, not established.
- Regression of total on node, spacing and hours: the node coefficient is +200 ms, CI [-34, +422], R² = 0.09. Adding the slower-cluster indicator: node -9 ms, CI [-204, +188]; slower cluster +507 ms, CI [+309, +704]; R² = 0.53; residual sd 254 ms (from 348). Spacing +2 ms, hours -34 ms/h, both with intervals spanning zero. **Read this as a decomposition, not an explanation:** the indicator is built from a component of the total itself (the segment is 38% of the mean total, 627 of 1645 ms), so it must absorb variance. The continuous segment alone gives R² = 0.51 and the indicator alone 0.55, in the same range as the full model.
- Within the same cluster, the earlier runs also differ somewhat (faster cluster: single-arm minus three-arm +277 ms, CI [+107, +547]; balanced minus three-arm +127 ms, CI [-7, +374]), so the share is not the whole story.
- Inside the balanced run the cluster is not predicted by spacing (rank corr -0.03), hours into the run (+0.02), zero-pod wait (+0.04) or pre-wake node CPU. Consecutive wakes on a node were no more alike than chance (.118: 10 of 14 consecutive pairs the same, 9.5 expected; .169: 10 of 19, 9.9 expected). Node .169 (rank corr +0.40, p = 0.041) is not separable from slot (-0.26).

## What explains the shift, and what is left

- **Partly associated:** the slower-cluster share on node .169 (21% then 58–60%) goes with about half of the same-node difference. By this report's numbers the change in share (0.37) times the 590 ms total cost is about 218 ms of the 397 ms same-node difference (55%), or about 187 ms (47%) using the 507 ms regression coefficient. The 1276 → 1806 comparison also mixes node composition (6 of the 20 three-arm wakes ran on .118; all single-arm wakes ran on .169). The slower cluster costs about 440 ms in the start segment and about 590 ms in the total.
- **Not explained:** *why* that share changed between the three-arm run (15:58–16:40 UTC) and the later runs (17:11 UTC onward), and why .118 stayed at about 20% while .169 did not. The cluster was not tied to anything this study could read: spacing, run time, order, slot, node CPU/memory, running-pod counts (none detected, within the limits above). Residual within-mode differences between days (up to about +277 ms) are also unexplained.
- Earlier reports with another instrument (1.65–1.9 s) were not re-measured here.

## Not shown

- What the slower cluster physically is. Node, kubelet and runtime logs were not read and no host-access pods were used, so the 440 ms step is not attributed to any component.
- Whether the step is partly an artefact of log timestamping: CRI-O stamping container log lines at read time is untested as a source of the step. Clock offsets between the harness and the nodes were about 0.2 ms, which rules out re-basing as an explanation.
- Whether the share changes with the time of day or with something that happened on the cluster between 16:40 and 17:11 UTC. The data cannot separate "a different period" from "a different arm count in the run".
- The companion app was running on the other node during most target wakes. A single-arm balanced run, with no companion, was not done, so a co-resident app's effect is not isolated (the three-arm run also had co-resident apps).
- The kubelet summary gives CPU over a short window; sub-second contention during a start would not show in it. Per-pod throttling was not read.
- One pre-wake reading (round 5) lacked memory, so the pre-wake correlations use 34 wakes.
- Only one app, one image, one day, one cluster.

## Recommended protocol for future A/B runs

1. **Pair and stratify by node.** Wake both arms in the same round, in alternating order, with the cluster otherwise unchanged. Record the node and the start mode of every wake. Natural placement alternates only when a second app is woken first; use the second arm as that app.
2. **Report the start cluster.** Print the slower-cluster share (and the cut used; 500, 650 and 760 ms give different shares) and the faster/slower medians for each arm and node next to the total. A fix that changes the share, not the cost of a wake, will otherwise look like a speed-up.
3. **Spacing:** not detected as a factor here (-20 ms, CI [-301, +304]); that interval cannot exclude effects of the size studied. Use the shortest cycle (about 95 s per round with two arms), keep it identical across arms and record it.
4. **Sample size:** with a within-node sd of 333 ms, unpaired, 80% power, α = 0.05, the smallest detectable effect is about 340 ms at 15 wakes per arm, 295 ms at 20, 241 ms at 30 and 208 ms at 40. Pairing: consecutive same-node wakes (sd of differences 531 ms) are not the within-round pairs this protocol uses, so that figure says nothing about them. The closest available proxy is the within-round target-minus-companion pair, which differs in configuration: the two totals are uncorrelated (Pearson r = +0.01, Spearman rho = -0.05, p = 0.77) and the difference sd is 492 ms, the same as independent draws would give (493), so no variance reduction from pairing was observed (proxy minimum at 30 pairs: 251 ms vs 241 ms unpaired). Paired variance for same-config arms in the same round is **unmeasured**; the first protocol run should record it. The slower cluster accounts for much of the variance (residual sd 254 ms once it is modelled), which lowers these figures only if the share is modelled or held equal across arms.
5. **Do not compare across runs or days** unless both arms are measured in the same run: the baseline moved by about 400 ms with nothing changed. Treat any between-run difference under about 400 ms as uninterpretable.
6. **Minimum:** 30 target wakes per arm (smallest detectable effect about 241 ms unpaired, about 251 ms by the pairing proxy), at least 15 per node per arm, randomised order, and the slower-cluster share with its interval reported. Node and slot were collinear in the balanced run, so also alternate which arm is woken first and verify arm-to-node balance afterwards rather than assuming it. Re-run the control arm at the end to detect a shift during the run.

## Reproducing

- Data: `docs/benchmarks/data/cold-start-baseline-stability-oke-2026-11-02.jsonl` (70 wakes, including per-wake background readings), plus the two earlier JSONL files it is compared with.
- Analysis: `python3 scripts/bench-cold-start-phases/baseline-stability-analyze.py`; its full output for this run is saved as `docs/benchmarks/data/cold-start-baseline-stability-oke-2026-11-02-analysis.txt`. Every figure above is printed there.
- Driver: `PHASE_POD=phase-bench-2 python3 scripts/bench-cold-start-phases/baseline-stability-drive.py 36 cpu-base,cpu-boost2req <out.jsonl> --long=150`.
