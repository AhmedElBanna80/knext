# CPU limit and cold start (design note)

Status: **advisory.** No code, no default change. Any change to the built-in default needs an ADR (see Recommendation).
Date: 2026-11-20. Base: `integration/v2` at 3fb53a918. Evidence lives in `docs/benchmarks/`.

Every file reference below was checked against that tree.

## The question

Should the default CPU limit for a `NextApp` container (1000m today) change, and if so, to what, and by which path?

**Short answer: not the built-in default yet.** The evidence conflicts. Kind and GKE show a gain when the limit goes
above one CPU. OKE, the target platform, shows none at two CPUs, and its interval excludes gains above 88 ms. A
platform-level setting that an OKE admin can trial is the cheapest option to try, and it needs no knext default change.
Its gain on OKE is not established.

## 1. Current state

- **Operator default.** `CPURequest = "250m"` and `CPULimit = "1000m"` in
  `packages/kn-next-operator/internal/defaults/defaults.go:44-45`. The comment at `:42-43` gives the reason: a larger
  limit against the 250m request trips a `LimitRange` `maxLimitRequestRatio`.
- **Precedence.** The effective limit is app > platform > built-in:
  `pick("spec.resources.cpuLimit", appRes.CPULimit, resourceDefaults.CPULimit, defaults.CPULimit)` in
  `packages/kn-next-operator/internal/controller/platform_defaults.go:159`. The platform layer is the cluster-scoped
  `KnextPlatform`. Its resource defaults are `PlatformResourceDefaults`
  (`packages/kn-next-operator/api/platform/v1alpha1/knextplatform_types.go:178`), with `cpuRequest` and `cpuLimit`.
- **Where it is stamped.** The merged value goes into the Knative Service container's limits at
  `packages/kn-next-operator/internal/controller/nextapp_ksvc.go:409-411`.
- **The CRD has no default.** `cpuLimit` is a plain string in
  `packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml:693`. The value lives in code.
- **The CLI has its own copy, and this matters for any change.** `packages/kn-next/src/cli/cr-builder.ts:152-168`.
  If any one of the four `scaling` resource fields is set, the CLI emits all four and fills the unset ones with its
  own constants: `cpuRequest` 250m, `memoryRequest` 512Mi, `cpuLimit` 1000m, `memoryLimit` 1Gi. The operator then
  reads the CLI's 1000m as an app value, so the platform and built-in defaults no longer apply to that field
  (`platform_defaults.go:159`).
  **Consequence:** a platform default reaches only apps whose config sets none of the four resource fields. A change
  to the built-in default reaches the same set. Any built-in change must move `defaults.go`, `cr-builder.ts`, and the
  `cpuLimit` default in the `config.ts` doc comment (`packages/kn-next/src/config.ts:114`) in one change.
- **The reverted 4000m default.** `nextapp_ksvc.go:355-372` records that a 4000m default was tried and reverted. With
  the 250m request, 4000m is a 16:1 limit-to-request ratio. A cluster whose `LimitRange` caps
  `maxLimitRequestRatio` (a common value is 4), or whose `max.cpu` is below 4, rejects the pod at admission
  (`FailedCreate`). The revert was a jev pick over keep-1000m, raise-to-2000m, and raise-to-4000m, scored 0.89, 0.10
  and 0.01 in that comment. The stated reason: a silently broken default deploy is worse than the cold start it targets.
- **The opt-in recipe.** `docs/operator/scaling-cold-start.md:118-154` ("CPU limit at boot"). Raise
  `spec.resources.cpuLimit` per app, sized to the cluster's `LimitRange`, or use a startup CPU-boost mechanism. The
  same section records a known gap: the operator does not surface a `LimitRange` or quota `FailedCreate` on the
  `NextApp` status, so the failure shows up in `kubectl describe pod`.
- **The ratio check is not built.** ADR-0064 lists a `maxLimitRequestRatio` check as a phase 2 `doctor` check
  (`docs/adr/0064-knext-platform-layer.md`, the doctor-checks list). The only match in `packages/kn-next/src` is the
  comment at `cr-builder.ts:163`.

## 2. Evidence

| Source | Platform, runtime | Comparison | n per arm | Effect on total | Notes |
|---|---|---|---|---|---|
| Kind native, run 1 (`coldstart-phases-kind-native-2026-11-20.md`) | kind on GitHub amd64, node | 1000m vs no limit | 12 | −224 ms (934 to 710) | One run, shared VM |
| Kind ladder (`coldstart-phases-kind-native-ladder-2026-11-20.md`) | same, node | 1000m vs 2000m / 4000m / no limit | 12 | −324 / −335 / −320 ms | One run. Flat above 2 CPUs. Runner vCPU count not logged |
| GKE `e2-standard-4` (`cold-start-gke-runtime-and-minimisation-2026-10-01.md`, Run B) | GKE, **Bun** | 1000m vs 4000m | 10 | **−675 ms** (3156 to 2482); Holm p = 0.0005; CI [−850, −553] | The strongest total-level number off kind. Four vCPU is the whole node |
| OKE phase breakdown (`cold-start-phase-breakdown-2026-10-01.md`, E2) | OKE, Bun | 1 vs 4 CPU | 9 (baseline) | Runtime boot −37 ms (p = 0.0006). First-request leg +258 ms (not significant). Total not usable | The report's verdict: "not worth it". The total was dominated by a roughly 10 s ready-gap artifact |
| OKE 2026-11-02 (`cpu-boost-and-ready-gap-oke-2026-11-02.md`) | OKE, Bun bench image | 1000m vs limit 2000m, request 250m | 20 | Hodges-Lehmann +141 ms; difference of medians +223 ms, 95% CI [−88, +488]; p = 0.18 | Underpowered. Node placement moves the arm medians by 200 to 360 ms (section 4). The interval excludes gains above 88 ms |

**Sign convention.** Every "difference" here is treatment minus baseline. For the OKE 2026-11-02 run, the treatment is
the 2000m arm and the baseline is the 1000m arm (`cpu-base`). So +223 ms means the 2000m arm's median was 223 ms
*slower*, and a negative number would be a gain. The interval [−88, +488] is for that same difference.

The same report's `cpu-boost2req` arm (request 1000m, limit 2000m) gave Hodges-Lehmann +35 ms, difference of medians
+172 ms, CI [−199, +438]. The report's own wording: "no benefit detected", not "no effect".

**The conflict, stated plainly.**

- **Kind and GKE show a gain** of roughly 300 to 700 ms when the limit goes above one CPU.
- **OKE shows none at two CPUs.** The Nov 2 interval excludes a gain larger than 88 ms at 95%. At face value, the
  kind (−324 ms) and GKE (−675 ms) effects do not reproduce on OKE at two CPUs. A 95% interval from one underpowered
  run is not proof of no effect, but it is evidence against the size seen elsewhere.
- **The comparisons are confounded, so the split cannot be attributed to runtime or platform.** The four
  comparisons differ in three things at once:
  - **CPU step:** GKE went 1 to 4 CPU. OKE Nov 2 went 1 to 2. OKE Oct 1 went 1 to 4. Kind went 1 to 2 and 1 to 4,
    on one node.
  - **Platform:** GKE, OKE and kind.
  - **Runtime:** GKE and both OKE runs used Bun. Kind used node.

  The closest like-for-like pair is GKE and OKE Oct 1: both Bun at 4 CPU. GKE reports −675 ms on the total. OKE Oct 1
  reports −37 ms on runtime boot only, because its total is unusable. So the one comparable phase is runtime boot, and
  on OKE it moved 37 ms at 4 CPU, while kind moved it 137 ms at 2 CPU (495 to 358). Neither the runtime nor the
  platform is ruled in or out by this data.
- **Neither OKE total is clean.** The Nov 2 medians are node-dominated (section 4). The Oct 1 totals were
  blackhole-dominated.

The GKE report attributes its gain to CFS throttling of the whole container on shared-core vCPUs. This note does not
reproduce that. No throttling counter was read on OKE (the Nov 2 report says `nr_throttled` was not readable), and no
throttling counter was read on kind. Treat the mechanism as open.

## 3. Options

Each row is a candidate. Admission risk means what a ResourceQuota or LimitRange does to a new pod. Noisy-neighbour
risk means what a cold-starting pod can take from its neighbours. Expected gain is what the evidence supports for the
cold-start metric (request to first byte).

| # | Option | Admission risk | Noisy-neighbour risk | Expected gain on the cold-start metric | Verdict |
|---|---|---|---|---|---|
| 1 | **Keep 1000m / 250m built-in; document the opt-in.** | None new. | None new. | None by default. Opt-in users get what they measure: kind −324 ms at 2 CPUs; GKE −675 ms at 4 CPUs (Bun). OKE: none detected at 2 CPUs. | Lowest risk, reversible. This is today's state. |
| 2 | **Built-in default limit 2000m, request 250m.** | 8:1 ratio. Fails a ratio-4 `LimitRange` (2000 / 250 = 8, above 4). Also fails a `max.cpu` below 2. Every pod adds 1000m to any `limits.cpu` quota. Changes every fleet that falls through to the built-in. | Each concurrent cold start can burst to 2 cores. Moderate. | Kind −324 ms. OKE: none detected; the interval excludes gains above 88 ms. Plausible range 0 to about 300 ms. The OKE evidence argues against the top of that range. | Not as is. It breaks the ratio-4 clusters that the 4000m revert protected, at half the size. |
| 3 | **Built-in default: 500m request, 2000m limit (ratio 4).** | Passes a ratio-4 `LimitRange`. Each pod reserves 500m instead of 250m, so any `requests.cpu` quota and node packing halve in density. The risk moves from the ratio to the quota. | Same burst as option 2, plus more reserved CPU. | Not measured at 500m / 2000m. The OKE request-1000m arm is a different shape and was underpowered. | A candidate to test. It needs its own A/B and an ADR before it becomes the built-in. |
| 4 | **No limit by default.** | A ResourceQuota on `limits.cpu` rejects any pod without a limit. A `LimitRange` default re-injects a limit, so "no limit" silently becomes that limit. The operator always renders a limit (`scripts/bench-cold-start-phases/kind/arms.sh:14-16`), so this changes the operator contract, not just the number. | Highest. A cold-starting pod can take every free core on the node, and nothing caps a misbehaving app. | Kind −320 ms (ladder) and −224 ms (run 1). Not measured on OKE. | Reject as a default. The largest kind gain carries the largest risk. |
| 5 | **In-place resize after the first request is served.** | Create-time admission is unchanged if the starting limit stays at 1000m. The sprint-16 close note says the pod "must still be admitted with the high limit". That assumes the `LimitRange` ratio also runs on the resize; this was not verified. Needs `InPlacePodVerticalScaling` on OKE (not verified). Knative does not own a pod-level patch, so a Service reconcile can revert it. | Bounded by the resized limit, but only from the first request onward. | Near zero on the metric this note tracks. Cold start is request to first byte, and the resize happens after that request is served, so it cannot shorten the wake that triggered it. It helps later requests on a warm pod. | Not a cold-start fix as specified. Needs its own measurement. |
| 6 | **Platform default set by an OKE admin: `KnextPlatform` `resources.defaults` `cpuRequest` 500m, `cpuLimit` 2000m.** | Admin-owned, per cluster. The admin checks `kubectl get limitrange -A` first. With the 500m request it passes a ratio-4 `LimitRange`. Each pod reserves 500m. No ResourceQuota is changed by knext. | Same burst as option 3, on the clusters that opt in only. | Same plausible range as option 3 (0 to about 300 ms), unmeasured on OKE at 500m / 2000m. Only apps with none of the four resource fields set get it (the CLI back-fill shadows it otherwise). | **An admin opt-in trial, not an established gain.** It needs no knext default change, no CLI change, and no ADR, because it sets an existing field on one cluster, and it is reversible. On OKE, no gain is detected at 2000m, and the 500m / 2000m shape has not been measured anywhere. The admin's own A/B is the only test of it. |
| 7 | **CLI default for new scaffolds only:** the emitter writes `scaling.cpuRequest` 500m and `cpuLimit` 2000m into new `knext.config.ts`. | New apps only. A 500m request passes a ratio-4 `LimitRange`. Each new pod reserves 500m. The emitter in `packages/kn-next/src/cli/create-options.ts` writes no resource field today, so this is a new emitted field. | Same as option 3, for new apps. | Only for apps created after the change. Existing apps keep 1000m. Same plausible range as option 3, unmeasured. | Low admission risk, but it splits the fleet (new apps differ from old) and makes any later measurement harder. Changes user-visible scaffold output, so it needs docs and a changeset. Decide after the OKE result. |

Notes on the table:

- Options 2 and 3 change the built-in default, so they reach every app that falls through to it. Option 3 is the only
  one that passes a ratio-4 `LimitRange` at a 2-core limit. Option 6 is the same setting made by an admin, on
  clusters the admin has checked.
- A ratio check that runs at admission on a kind cluster with `maxLimitRequestRatio: 4` would show the failure mode
  for options 2 and 4 without OKE access. That test does not exist yet.

## 4. Sample size for an OKE A/B

The reviewer's question was whether the planned N ≥ 20 per arm is enough. It is not, and the numbers below say how
many wakes are needed.

**Inputs and where they come from.**

- **Outcome:** total, request to first byte, median per arm (the Nov 2 measure).
- **Minimum effect that matters: δ = 150 ms.** That is about 12% of the OKE baseline median (1276 ms). It is the
  smallest gain I would accept as worth a higher default's admission and tenancy cost. It is a judgement; the founder
  sets it. 300 ms is shown as well.
- **SD: σ = 345 ms.** Pooled within-arm sample SD of the total, from
  `docs/benchmarks/data/cpu-boost-oke-2026-11-02.jsonl`: 60 wakes, 3 arms, residuals about each arm's mean, n − 3
  degrees of freedom. Per arm: 315 ms (`cpu-base`), 324 ms (`cpu-boost2`), 390 ms (`cpu-boost2req`). A robust
  cross-check: the `cpu-base` IQR of 376 ms gives σ ≈ 279 ms, so 280 ms is the low case.
- **Consistency check.** With σ = 345 ms and n = 20, the predicted 95% half-width of the difference of medians is
  about 268 ms. The Nov 2 report's bootstrap gave 288 ms. So σ = 345 ms reproduces the report.
- **α = 0.05** two-sided; **power = 0.80**.
- **Estimator: the median.** For roughly normal data the median's variance is π/2 ≈ 1.57 times the mean's. Cold-start
  totals are right-skewed, so this is an approximation.

**Formula.** With equal n per arm:

n = 2 × (z₁₋α/₂ + z₁₋β)² × (π/2) × σ² / δ²  ≈  24.7 × σ² / δ²

where z₁₋α/₂ = 1.960 and z₁₋β = 0.842, so (z sum)² = 7.85.

**Results.** Wakes are 2 × n.

| δ (ms) | σ (ms) | n per arm | Total wakes |
|---|---|---|---|
| 150 | 345 | **131** | 262 |
| 150 | 280 | 86 | 172 |
| 300 | 345 | **33** | 66 |
| 300 | 280 | 22 | 44 |
| 100 | 345 | 294 | 588 |

**What the planned N = 20 buys.** The standard error of a difference of medians at n = 20 is about 137 ms (σ = 345 ms).
Power is about 19% at δ = 150 ms and about 59% at δ = 300 ms. So N = 20 cannot reliably detect a 150 ms effect.

**Corrections to the earlier version of this note.** A 95% half-width of 150 ms means SE ≈ 76.5 ms, which gives about
50% power at δ = 150 ms, not 80%. For 80% power the standard error must be about δ / 2.80 ≈ 54 ms. That is a 95% half-width of about
105 ms, not 54 ms. The "hundreds of wakes" figure holds for δ = 100 ms (294 per arm), not for δ = 150 ms (131 per arm).

**Pinning nodes.** Two effects, one large and one small.

- **Bias (large).** The Nov 2 arms were unbalanced across two nodes (6 and 14 wakes for `cpu-base`; 13 and 7 for
  `cpu-boost2`; 7 and 13 for `cpu-boost2req`). Within one arm, the median differs by 200 to 360 ms between the two
  nodes. That confounds the arm comparison. Pinning all arms to one node, or balancing them across two identical
  nodes, removes this bias. This is the main reason to pin.
- **Variance (small).** The within-arm SD is 336 ms; the within-arm-by-node SD is 322 ms. So the node component is
  about sqrt(336² − 322²) ≈ 96 ms of SD, under 10% of the variance. Pinning would cut n by about 8% (131 to about 120
  at δ = 150 ms). **Low confidence:** 60 wakes across two nodes, with cells of 6 to 14.

**Paired or interleaved on one pinned node.** The reviewer suggested this to remove the node effect. It removes the
node effect, but that effect is small in variance terms (above), so it does not cut n. Pairing by round does not help
either: there are 20 rounds of about three wakes, and the SD of round means is 170 ms, against about 194 ms expected
if wakes were independent (336 / √3). No shared round component is visible, so the within-pair correlation is about
zero, and the paired variance equals the unpaired variance. Interleaving still guards against drift over time, which
this data cannot test.

**Practical design.**

- Pinned single node, or two identical nodes with arms balanced across them. Randomise arm order within each round.
  Use the watch-based harness from the Nov 2 run.
- **Arms:** a 1000m / 250m control, and a treatment at the shape being recommended: 2000m limit with a 500m request
  (ratio 4). The Nov 2 `cpu-boost2req` arm used a 1000m request and a 2000m limit, so it is a different shape and does
  not test this one. The Nov 2 `cpu-boost2` arm (250m request) is also a different shape.
- Pre-register the primary outcome (total median), δ = 300 ms, α = 0.05, power 0.80, n = 33 per arm (66 wakes).
- **Expect a null result.** The Nov 2 interval already excludes gains above 88 ms, and this A/B is powered only at
  δ = 300 ms. A null at 300 ms is the likely outcome, and it would not rule out 150 ms.
- n = 131 per arm for δ = 150 ms is 262 wakes of cluster time, and each wake takes a founder-approved OKE window.
  I would not start there. If the 300 ms run is null, gains of 150 to 300 ms are not ruled out, and the team must
  then decide whether 131 per arm is worth paying for.
- Read the wall-clock cost per wake from the Nov 2 timestamps before committing to either size.

## 5. Recommendation

Suggested, for review against the evidence above:

1. **Near term: option 6 is an admin opt-in trial.** An OKE admin who wants to test 2000m can check
   `kubectl get limitrange -A`, then set `cpuRequest` 500m and `cpuLimit` 2000m on the platform's resource defaults.
   Apps that set any resource field through the CLI keep their own value. The gain on OKE is not established: none was
   detected at 2000m, and the 500m / 2000m shape is unmeasured. knext documents it as a trial, not as a recommended
   setting, and the admin's own A/B is the only test.
2. **The built-in default stays 1000m / 250m** until a powered result exists. The first OKE A/B is the pinned, balanced,
   interleaved design in section 4 at δ = 300 ms, n = 33 per arm, with the 500m / 2000m shape as the treatment.
   - If it confirms a gain of about 300 ms or more, option 3 becomes a serious candidate for the built-in default, and
     that change needs an ADR, because it changes the resource contract in ADR-0064.
   - If it is null, keep 1000m and close the item. A null at 300 ms is the likely outcome given the Nov 2 interval.
     The null does not rule out 150 to 300 ms gains, and it does not justify the 131 per arm that 150 ms would need.
3. **Option 7 (scaffold default) waits for step 2.** It splits the fleet, so it is not worth doing before the evidence is
   in.
4. **Make the opt-in more prominent, as docs only.** Link the CPU-limit section of `scaling-cold-start.md` from the
   cold-start and per-app reference pages, and state the kind 1-to-2 CPU number with its caveats. Under `apps/docs`,
   keep issue and PR numbers out. Document option 6 for OKE admins, with the ratio warning.
5. **Test the admission failure locally.** On kind, install a `LimitRange` with `maxLimitRequestRatio: 4` and apply a
   2000m limit against the 250m request. This needs no OKE access and would show the rejection the 4000m revert was
   based on.
6. **Any built-in default change needs an ADR.** The same PR must move `defaults.go`, `cr-builder.ts`, and the
   `config.ts` doc comment together.
7. **Founder access is required for any OKE run.** It is not in this sprint's scope and this note does not assume it.
8. **Drop option 4.** Option 5 needs a measurement of resize admission before it is worth an ADR.

## 6. Open questions

- Does a `LimitRange` ratio check run on the pod resize subresource? The sprint-16 close note assumes it does without
  citing a source. A kind test would settle this.
- What is the OKE node shape? The Nov 2 report records 3815m allocatable CPU per node, and nothing else in the
  reviewed notes.
- Does OKE have a `KnextPlatform` installed, and what does its `resources.defaults` hold? Not checked.
- How many cores does the kind runner have? The ladder run did not log it. The next run should.
- Does the OKE gap in runtime boot (−37 ms at 4 CPUs) and the kind gap (−137 ms at 2 CPUs) reflect the same effect at
  different sizes, or a different effect? The data cannot say.
