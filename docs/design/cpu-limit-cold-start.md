# CPU limit and cold start (design note)

Status: **advisory.** No code, no default change. Any default change needs an ADR (see Recommendation).
Date: 2026-11-20. Base: `integration/v2` at 3fb53a918. Evidence lives in `docs/benchmarks/`.

Every file reference below was checked against that tree.

## The question

Should the default CPU limit for a `NextApp` container (1000m today) change, and if so, to what?

**Short answer: not yet.** The evidence conflicts. Kind and GKE show a gain when the limit goes above one CPU. OKE,
the target platform, shows none at two CPUs. The OKE evidence is thin, but it is not zero, and it points the other way.

## 1. Current state

- **Operator default.** `CPURequest = "250m"` and `CPULimit = "1000m"` in
  `packages/kn-next-operator/internal/defaults/defaults.go:44-45`. The comment at `:42-43` gives the reason: a larger
  limit against the 250m request trips a `LimitRange` `maxLimitRequestRatio`.
- **Precedence.** The effective limit is app > platform > built-in:
  `pick("spec.resources.cpuLimit", appRes.CPULimit, resourceDefaults.CPULimit, defaults.CPULimit)` in
  `packages/kn-next-operator/internal/controller/platform_defaults.go:159`. The platform layer is the cluster-scoped
  `KnextPlatform` of ADR-0064.
- **Where it is stamped.** The merged value goes into the Knative Service container's limits at
  `packages/kn-next-operator/internal/controller/nextapp_ksvc.go:409-411`.
- **The CRD has no default.** `cpuLimit` is a plain string in
  `packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml:693`. The value lives in code.
- **The CLI has its own copy, and this matters for any change.**
  `packages/kn-next/src/cli/cr-builder.ts:155-166`. If any one of the four `scaling` resource fields is set, the CLI
  emits all four and fills the unset ones with its own constants: `cpuRequest` 250m, `memoryRequest` 512Mi,
  `cpuLimit` 1000m, `memoryLimit` 1Gi. The operator then reads the CLI's 1000m as an app value, so the platform and
  built-in defaults no longer apply to that field (`platform_defaults.go:159`).
  **Consequence:** changing `defaults.go` alone reaches only apps that set no resource field through the CLI. Any
  default change must move `defaults.go`, `cr-builder.ts`, and the `cpuLimit` default in the `config.ts` doc comment
  (`packages/kn-next/src/config.ts:114`) in the same change.
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
| OKE 2026-11-02 (`cpu-boost-and-ready-gap-oke-2026-11-02.md`) | OKE, Bun bench image | 1000m vs limit 2000m, request 250m | 20 | Hodges-Lehmann +141 ms; difference of medians +223 ms, 95% CI [−88, +488]; p = 0.18 | Underpowered. Node placement moves medians by several hundred ms. The interval excludes gains above 88 ms |

The same report's `cpu-boost2req` arm (request 1000m, limit 2000m) gave Hodges-Lehmann +35 ms, difference of medians
+172 ms, CI [−199, +438]. The report's own wording: "no benefit detected", not "no effect".

**The conflict, stated plainly.**

- **Kind and GKE show a gain** of roughly 300 to 700 ms when the limit goes above one CPU.
- **OKE shows none at two CPUs.** The Nov 2 interval excludes a gain larger than 88 ms at 95%. At face value, the
  kind (−324 ms) and GKE (−675 ms) effects do not reproduce on OKE at two CPUs. A 95% interval from one underpowered
  run is not proof of no effect, but it is evidence against the size seen elsewhere.
- **The phase that moved on kind did not move on OKE.** On kind, going from 1 to 2 CPUs cut runtime boot by 137 ms
  (495 to 358). On OKE at four CPUs, runtime boot moved 37 ms.
- **Runtime does not explain the split.** The GKE result and both OKE runs used Bun. Kind used node. The conflict is
  a platform or sample effect, and the data cannot say which.
- **Neither OKE total is clean.** The Nov 2 medians are node-dominated. The Oct 1 totals were blackhole-dominated.

The GKE report attributes its gain to CFS throttling of the whole container on shared-core vCPUs. This note does not
reproduce that. No throttling counter was read on OKE (the Nov 2 report says `nr_throttled` was not readable), and no
throttling counter was read on kind. Treat the mechanism as open.

## 3. Options

Each row is a candidate default, or the non-default alternative. Admission risk means what a ResourceQuota or
LimitRange does to a new pod. Noisy-neighbour risk means what a cold-starting pod can take from its neighbours.

| # | Option | Admission risk | Noisy-neighbour risk | Expected gain on the cold-start metric | Verdict |
|---|---|---|---|---|---|
| 1 | **Keep 1000m / 250m, document the opt-in.** | None new. | None new. | None by default. Opt-in users get what they measure: kind −324 ms at 2 CPUs; GKE −675 ms at 4 CPUs (Bun). OKE: none detected at 2 CPUs. | Lowest risk, reversible. This is today's state. |
| 2 | **Default limit 2000m, request 250m.** | 8:1 ratio. Fails a ratio-4 `LimitRange` (2000 / 250 = 8, above 4). Also fails a `max.cpu` below 2. Every pod adds 1000m to any `limits.cpu` quota. | Each concurrent cold start can burst to 2 cores. Moderate. | Kind −324 ms. OKE: none detected; the interval excludes gains above 88 ms. Plausible range 0 to about 300 ms. The OKE evidence argues against the top of that range. | Not as is. It breaks the ratio-4 clusters that the 4000m revert protected, at half the size. |
| 3 | **Raise the request with the limit: 500m request, 2000m limit (ratio 4).** | Passes a ratio-4 `LimitRange`. Each pod reserves 500m instead of 250m, so any `requests.cpu` quota and node packing halve in density. The risk moves from the ratio to the quota. | Same burst as option 2, plus more reserved CPU. | Not measured at 500m / 2000m. The OKE request-1000m arm is a different shape and was underpowered. | A candidate to test. It needs its own A/B before it is worth an ADR. |
| 4 | **No limit by default.** | A ResourceQuota on `limits.cpu` rejects any pod without a limit. A `LimitRange` default re-injects a limit, so "no limit" silently becomes that limit. The operator always renders a limit (`scripts/bench-cold-start-phases/kind/arms.sh:14-16`), so this changes the operator contract, not just the number. | Highest. A cold-starting pod can take every free core on the node, and nothing caps a misbehaving app. | Kind −320 ms (ladder) and −224 ms (run 1). Not measured on OKE. | Reject as a default. The largest kind gain carries the largest risk. |
| 5 | **In-place resize after the first request is served.** | Create-time admission is unchanged if the starting limit stays at 1000m. The sprint-16 close note says the pod "must still be admitted with the high limit". That assumes the `LimitRange` ratio also runs on the resize; this was not verified. Needs `InPlacePodVerticalScaling` on OKE (not verified). Knative does not own a pod-level patch, so a Service reconcile can revert it. | Bounded by the resized limit, but only from the first request onward. | Near zero on the metric this note tracks. Cold start is request to first byte, and the resize happens after that request is served, so it cannot shorten the wake that triggered it. It helps later requests on a warm pod. | Not a cold-start fix as specified. Needs its own measurement. |

Notes on the table:

- Options 2 and 3 are the only ones that change the default and keep a ratio-safe admission story. Option 3 is the only
  one that passes a ratio-4 `LimitRange` at a 2-core limit.
- A ratio check that runs at admission on a kind cluster with `maxLimitRequestRatio: 4` would show the failure mode
  for options 2 and 4 without OKE access. That test does not exist yet.

## 4. Recommendation

Suggested, for review against the evidence above:

1. **No default change now.** Keep 1000m / 250m.
2. **Make the opt-in more prominent, as docs only.** Link the CPU-limit section of `scaling-cold-start.md` from the
   cold-start and per-app reference pages, and state the kind 1-to-2 CPU number with its caveats. Under `apps/docs`,
   keep issue and PR numbers out.
3. **Run an OKE A/B before any default change, at a larger n than the working suggestion.** A working N ≥ 20 per
   arm. That is the n of the Nov 2 run, whose difference-of-medians interval is 576 ms wide (half-width about 288 ms).
   The half-width shrinks roughly with the square root of n. For a half-width near 150 ms, n is about 75 per arm.
   The run should use pinned nodes, interleaved arms, the watch-based harness of the Nov 2 run, and a pre-registered
   effect size and test. Do not use the blackhole-prone Oct 1 totals.
4. **Test the admission failure locally first.** On kind, install a `LimitRange` with `maxLimitRequestRatio: 4` and
   apply a 2000m limit against the 250m request. This needs no OKE access and would show the rejection the 4000m
   revert was based on.
5. **Any default change needs an ADR.** It changes the resource contract in ADR-0064 (the CLI back-fill rule, which
   the default feeds). The same PR must move `defaults.go`, `cr-builder.ts`, and the `config.ts` doc comment together.
6. **Founder access is required for the OKE run.** It is not in this sprint's scope and this note does not assume it.
7. **Drop option 4.** Option 5 needs a measurement of resize admission before it is worth an ADR.

## 5. Open questions

- Does a `LimitRange` ratio check run on the pod resize subresource? The sprint-16 close note assumes it does without
  citing a source. A kind test would settle this.
- What is the OKE node shape? The Nov 2 report records 3815m allocatable CPU per node, and nothing else in the
  reviewed notes.
- How many cores does the kind runner have? The ladder run did not log it. The next run should.
- Does the OKE gap in runtime boot (−37 ms at 4 CPUs) and the kind gap (−137 ms at 2 CPUs) reflect the same effect at
  different sizes, or a different effect? The data cannot say.
