# Pre-wake A/B on OKE — founder runbook

**Who runs this:** the founder. Agents do not touch OKE.
**What it measures:** cold-start latency of one scale-to-zero Knative Service with and without a
pre-wake fired a fixed lead before the request, interleaved. The pre-wake is a plain GET through the
activator, sent from a client pod: the mechanism ADR-0073 recommends. It feeds
[ADR-0073](../adr/0073-opt-in-predictive-prewake.md) (`0073-opt-in-predictive-prewake.md`), which
holds the kind-relative result this run replaces with an OKE number.
**Harness:** `scripts/bench-cold-start-phases/prewake-ab.sh` (`--help` lists every flag).

## What the run changes on the cluster

- It creates one client pod in the target's namespace (you create it, step 2) and deletes nothing.
- The default GET arm writes nothing to the cluster: it sends a plain GET, then the measured GET
  `<lead>` ms later, both from the client pod.
- Only if you pass `--minscale-leads` (a secondary arm, a different scale-up path from the GET,
  reported separately) does it set `autoscaling.knative.dev/min-scale=1` on the target revision's
  PodAutoscaler for a cycle and remove it after. If the script is interrupted, its exit trap removes
  the annotation; step 6 checks it.
- It does **not** change node settings, the Knative config, or the NextApp. `--setup` is refused on
  a non-kind context.

## What this does not measure

This runbook measures an **app's** pre-wake GET. It does **not** measure Z9's zone-to-function primer
(a zone's process-start GET to its bound functions), and there is no zone-to-function leg here yet:
the Z9 chained-cold firing lead is unmeasured on OKE. That leg needs a zone and a bound function on
the cluster and is a named gap (ADR-0004, Z9 action item), not a step below.

## 1. Preconditions

```sh
export CTX=knext-oke-sa          # the OKE context; nothing else on the cluster benchmarking
export NS=bench-cells            # the namespace of an existing scale-to-zero ksvc
export KSVC=bp-b                 # ledger rows 15-16 used this one (Next standalone + Bun exec)
kubectl --context "$CTX" -n "$NS" get ksvc "$KSVC"
kubectl --context "$CTX" -n "$NS" get ksvc "$KSVC" -o jsonpath='{.status.latestReadyRevisionName}{"\n"}'
```

The image must already be cached on both nodes (as in ledger rows 15-16), or every arm pays the pull.

## 2. Client pod (in the target's namespace)

The client times the request inside the cluster, so `kubectl exec` latency is not in the number. Use
a multi-arch image pinned by digest; check that the digest has an `amd64` entry first:

```sh
export IMG='docker.io/library/node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a'
docker buildx imagetools inspect "$IMG" | grep -q 'linux/amd64' && echo amd64-ok
kubectl --context "$CTX" -n "$NS" run prewake-client --image="$IMG" --restart=Never -- sleep infinity
kubectl --context "$CTX" -n "$NS" wait --for=condition=Ready pod/prewake-client --timeout=300s
```

If the app's NetworkPolicy is on (the default), the client reaches the app through the cluster-local
gateway, which the policy admits. Check once before the run, with the app warm:

```sh
kubectl --context "$CTX" -n "$NS" exec prewake-client -- node -e \
  "fetch('http://$KSVC.$NS.svc.cluster.local/').then(r=>console.log(r.status))"
```

## 3. Dry run

```sh
scripts/bench-cold-start-phases/prewake-ab.sh --context "$CTX" --allow-non-kind \
  --namespace "$NS" --ksvc "$KSVC" --image "$IMG" --rounds 10 --leads 500,1000,1500,2500 --dry-run
```

## 4. The run

Ten rounds by four GET leads plus cold is 50 cycles. Each waits for zero pods first, so allow about an
hour with the default scale-to-zero settings.

```sh
scripts/bench-cold-start-phases/prewake-ab.sh --context "$CTX" --allow-non-kind \
  --namespace "$NS" --ksvc "$KSVC" --image "$IMG" --rounds 10 --leads 500,1000,1500,2500 \
  --zero-timeout 600 --out "docs/benchmarks/data/prewake-ab-oke-$(date +%F).jsonl"
```

The summary prints each arm's median, range, its delta against `cold` and the ratio, and marks an
arm whose range overlaps cold as "not distinguishable from cold"; report it that way. Note which node each
cold wake landed on if the nodes differ, as rows 15-16 do; this harness does not place pods.

## 5. Record the result

Append a row to [`cold-start-ledger.md`](cold-start-ledger.md) with the JSONL path, n per arm, the
medians and the deltas, and update the evidence section of ADR-0073.

## 6. Restore

Only needed if you ran `--minscale-leads`; the GET arm leaves nothing behind except the client pod.

```sh
kubectl --context "$CTX" -n "$NS" get podautoscaler \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.annotations.autoscaling\.knative\.dev/min-scale}{"\n"}{end}'
# Every line must end with no value. If one shows 1, remove it:
#   kubectl --context "$CTX" -n "$NS" annotate podautoscaler <name> autoscaling.knative.dev/min-scale-
kubectl --context "$CTX" -n "$NS" delete pod prewake-client
```
