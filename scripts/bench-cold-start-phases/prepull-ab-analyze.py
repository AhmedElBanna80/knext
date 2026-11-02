#!/usr/bin/env python3
"""Summarise the pre-pull scale-from-zero JSONL written by prepull-ab-incluster.py (stdlib only).

    python3 prepull-ab-analyze.py <run.jsonl>

Row kinds:
  role=deploy      one per round: the kubelet pulls observed for the round's images
  role=pulled      wake of pp-p (image pre-pulled on both nodes)
  role=fresh-cached-or-unpulled   wake of pp-u (fresh image; a pull is counted only if the
                   kubelet pulled inside the cycle)
  role=all-layers-new             wake of pp-w (every layer new)

Outputs: deploy-pull (kubelet) durations, wake medians/p95 per group, paired (ABBA, per round)
differences with Hodges-Lehmann shift, bootstrap 95% CI and a Wilcoxon signed-rank p
(normal approximation, continuity-corrected), plus an unpaired Mann-Whitney p.
"""
import json
import math
import statistics
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stats  # noqa: E402  (exact Mann-Whitney, bootstrap helpers)


def q(xs, p):
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def summary(name, xs):
    if not xs:
        print(f"{name}: n=0")
        return
    print(f"{name}: n={len(xs)} median={statistics.median(xs):.0f} IQR=[{q(xs, .25):.0f},{q(xs, .75):.0f}] "
          f"p95={q(xs, .95):.0f} range=[{min(xs):.0f},{max(xs):.0f}] mean={statistics.mean(xs):.0f}")


def hodges_lehmann(d):
    """Median of Walsh averages of paired differences (the HL shift estimator for paired data)."""
    w = [(d[i] + d[j]) / 2 for i in range(len(d)) for j in range(i, len(d))]
    return statistics.median(w)


def boot_hl_ci(d, reps=4000, seed=7):
    import random
    rnd = random.Random(seed)
    est = sorted(hodges_lehmann(rnd.choices(d, k=len(d))) for _ in range(reps))
    return est[int(0.025 * reps)], est[int(0.975 * reps)]


def wilcoxon_p(d):
    """Two-sided signed-rank test, normal approximation with average ranks and continuity correction."""
    nz = [x for x in d if x != 0]
    n = len(nz)
    if n == 0:
        return 1.0
    order = sorted(range(n), key=lambda i: abs(nz[i]))
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and abs(nz[order[j + 1]]) == abs(nz[order[i]]):
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        i = j + 1
    w_plus = sum(r for r, x in zip(ranks, nz) if x > 0)
    mu = n * (n + 1) / 4
    sd = math.sqrt(n * (n + 1) * (2 * n + 1) / 24)
    z = (abs(w_plus - mu) - 0.5) / sd
    return math.erfc(max(z, 0) / math.sqrt(2))


def ok_wake(r):
    return ("error" not in r and r.get("cold", {}).get("code") == 200 and "error" not in r.get("cold", {})
            and all(w.get("code") == 200 for w in r.get("warm", [])) and r.get("evidence", {}).get("pod"))


def main():
    path = sys.argv[1]
    rows = [json.loads(l) for l in open(path) if l.strip()]
    deploys = [r for r in rows if r.get("role") == "deploy"]
    wakes = [r for r in rows if r.get("role") != "deploy"]
    def usable(r):
        return ok_wake(r) and not r.get("evidence", {}).get("events_invalid")

    invalid = [r for r in wakes if not usable(r)]
    wakes = [r for r in wakes if usable(r)]
    no_count = sum(1 for r in wakes if "events_n" not in r.get("evidence", {}))
    if no_count:
        print(f"NOTE: {no_count} wake rows carry no events_n; a failed events fetch cannot be ruled out for them.")
    print(f"rounds(deploy rows)={len(deploys)} wake rows={len(wakes)} invalid wake rows={len(invalid)}")
    for r in invalid:
        print("  INVALID", r.get("round"), r.get("arm"), (r.get("error") or r.get("cold", {}).get("error") or "")[:120])

    # ---- kubelet pulls ----
    def pulls_for(arm_key, prefix_skip=True):
        out = []
        for d in deploys:
            for p in d.get("deploy_pulls", {}).get(arm_key, []):
                if prefix_skip and p["pod"].startswith("pp-pull-"):
                    continue
                out.append(p)
        return out

    print("\n== pull phase (kubelet 'Successfully pulled ... in Xs', initial revision pod) ==")
    for arm_key, label in (("pp-u", "fresh image, base cached (tiny unique layer)"),
                           ("pp-w", "fresh image, every layer new (53 MiB flattened)")):
        ps = pulls_for(arm_key)
        durs = [p["pull_duration_s"] * 1000 for p in ps if p["pull_duration_s"] is not None]
        print(f"{label}: pulls observed={len(ps)} with duration={len(durs)} nodes={sorted({p['node'] for p in ps})}")
        summary(f"  pull ms", durs)
    pre = []
    for d in deploys:
        for p in d.get("deploy_pulls", {}).get("pp-p", []):
            if p["pod"].startswith("pp-pull-") and p["pull_duration_s"] is not None:
                pre.append(p["pull_duration_s"] * 1000)
    summary("pre-pull pod pulls (pp-p images, both nodes) ms", pre)

    # ---- wakes ----
    def wake_ms(r):
        return r["cold"]["ms"]

    def warm_med(r):
        return statistics.median(w["ms"] for w in r["warm"])

    P = {r["round"]: r for r in wakes if r["role"] == "pulled"}
    U_all = {r["round"]: r for r in wakes if r["role"] == "fresh-cached-or-unpulled"}
    U_pulled = {k: v for k, v in U_all.items() if v["pulled_in_cycle"]}
    U_cached = {k: v for k, v in U_all.items() if not v["pulled_in_cycle"]}
    W = [r for r in wakes if r["role"] == "all-layers-new"]
    print("\n== scale-from-zero wake, cold request ms (client-side, request sent -> body complete) ==")
    summary("pp-p  PRE-PULLED (image pulled onto both nodes before the wake)", [wake_ms(r) for r in P.values()])
    summary("pp-u  fresh revision, wake did NOT pull (cached on the node it landed)",
            [wake_ms(r) for r in U_cached.values()])
    summary("pp-u  wake that DID pull in-cycle (node without layer)", [wake_ms(r) for r in U_pulled.values()])
    summary("pp-w  all layers new, wake pulled in-cycle", [wake_ms(r) for r in W if r["pulled_in_cycle"]])
    print(f"  pp-u wakes landing on node without layer: {len(U_pulled)} of {len(U_all)}")
    print(f"  pp-w wakes pulled in-cycle: {sum(1 for r in W if r['pulled_in_cycle'])} of {len(W)}")
    print("  warm median (of 5 GETs per cycle), ms:")
    summary("    pp-p pre-pulled", [warm_med(r) for r in P.values()])
    summary("    pp-u", [warm_med(r) for r in U_all.values()])

    # ---- paired ABBA comparisons (same round, alternating order) ----
    rounds = sorted(set(P) & set(U_cached))
    if rounds:
        a = [wake_ms(U_cached[k]) for k in rounds]
        b = [wake_ms(P[k]) for k in rounds]
        d = [x - y for x, y in zip(a, b)]
        lo, hi = boot_hl_ci(d)
        print(f"\n== paired (n={len(rounds)} rounds): pp-u fresh-cached minus pp-p pulled ==")
        print(f"  median diff={statistics.median(d):+.0f} ms  HL={hodges_lehmann(d):+.0f} ms  "
              f"95% bootstrap CI(HL)=[{lo:+.0f},{hi:+.0f}]  Wilcoxon p={wilcoxon_p(d):.3g}")
    rounds_u = sorted(set(P) & set(U_pulled))
    if rounds_u:
        a = [wake_ms(U_pulled[k]) for k in rounds_u]
        b = [wake_ms(P[k]) for k in rounds_u]
        d = [x - y for x, y in zip(a, b)]
        print(f"== paired (n={len(rounds_u)}): pp-u wake that pulled minus pp-p pulled: "
              f"median diff={statistics.median(d):+.0f} ms  HL={hodges_lehmann(d):+.0f} ms ==")
    if U_cached and U_pulled == {} and pulls_for("pp-u"):
        # Base the estimate on the arm that actually had the image cached (pp-u, no in-cycle pull),
        # not on the pre-pulled arm.
        pm = statistics.median(wake_ms(r) for r in U_cached.values())
        pull_med = statistics.median(p["pull_duration_s"] * 1000 for p in pulls_for("pp-u")
                                     if p["pull_duration_s"] is not None)
        print(f"\nModel (not a measurement): cached wake median {pm:.0f} ms (pp-u, no in-cycle pull) + "
              f"pull median {pull_med:.0f} ms = {pm + pull_med:.0f} ms for a wake that must pull first.")
    if P and W:
        wl = [wake_ms(r) for r in W if r["pulled_in_cycle"]]
        if wl:
            c = stats.compare([wake_ms(r) for r in W if r["pulled_in_cycle"]], [wake_ms(r) for r in P.values()])
            print(f"unpaired pp-w(pulled) vs pp-p: diff={c['diff']:+.0f} ms, MW p={c['p']:.3g}")

    print("\n== phase timestamps (apiserver, 1 s resolution) for pulled wakes vs cached wakes ==")
    for label, group in (("pp-p pre-pulled", P.values()), ("pp-u cached", U_cached.values())):
        cs, rd = [], []
        for r in group:
            e = r["evidence"]
            if e.get("created") and e.get("container_started") and e.get("ready"):
                from datetime import datetime
                t0 = datetime.fromisoformat(e["created"].replace("Z", "+00:00"))
                cs.append((datetime.fromisoformat(e["container_started"].replace("Z", "+00:00")) - t0).total_seconds())
                rd.append((datetime.fromisoformat(e["ready"].replace("Z", "+00:00")) - t0).total_seconds())
        if cs:
            print(f"  {label}: pod created->container started median {statistics.median(cs):.1f} s; "
                  f"created->Ready median {statistics.median(rd):.1f} s (n={len(cs)})")


if __name__ == "__main__":
    main()
