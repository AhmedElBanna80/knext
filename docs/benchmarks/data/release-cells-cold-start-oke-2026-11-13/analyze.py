#!/usr/bin/env python3
"""Summarise cells_bench.py JSONL: per-arm median/IQR/range, pairwise exact
Mann-Whitney (two-sided, Holm-corrected), factor-level pooled tests, and a
bootstrap 95% CI for each median difference."""
import json, sys, itertools, statistics, random
from collections import defaultdict

rows = [json.loads(l) for f in sys.argv[1:] for l in open(f) if l.strip()]
valid = [r for r in rows if r["cold"]["code"] == 200 and r["cold"]["marker"] >= 1
         and not any("Pulling" in p or "Successfully pulled" in p for p in r["ev"].get("pulls", []))]
excluded = [r for r in rows if r not in valid]
by = defaultdict(list)
for r in valid:
    by[r["arm"]].append(r)


def q(xs):
    s = sorted(xs)
    n = len(s)
    h = n // 2
    lo, hi = s[:h], s[n - h:]
    return statistics.median(lo), statistics.median(s), statistics.median(hi)


def mw_exact(a, b):
    # exact two-sided p for U via full enumeration of label assignments
    allv = a + b
    n = len(a)
    def U(x, y):
        return sum((1 if xi > yi else 0.5 if xi == yi else 0) for xi in x for yi in y)
    u_obs = U(a, b)
    mu = len(a) * len(b) / 2
    d_obs = abs(u_obs - mu)
    cnt = tot = 0
    idx = range(len(allv))
    for comb in itertools.combinations(idx, n):
        cs = set(comb)
        x = [allv[i] for i in comb]
        y = [allv[i] for i in idx if i not in cs]
        tot += 1
        if abs(U(x, y) - mu) >= d_obs - 1e-9:
            cnt += 1
    return cnt / tot


def boot_ci(a, b, n=4000):
    rnd = random.Random(1)
    ds = sorted(statistics.median(rnd.choices(a, k=len(a))) - statistics.median(rnd.choices(b, k=len(b))) for _ in range(n))
    return ds[int(0.025 * n)], ds[int(0.975 * n)]


print(f"rows={len(rows)} valid={len(valid)} excluded={len(excluded)}")
for r in excluded:
    print("  EXCLUDED", r["round"], r["arm"], r["cold"], r["ev"].get("pulls"))
print("\narm | n | cold median | Q1 | Q3 | IQR | min | max | warm median | ttfb median | nodes | created/started/ready median s")
arms = list(by)
for a in arms:
    xs = [r["cold"]["total_ms"] for r in by[a]]
    q1, m, q3 = q(xs)
    warm = statistics.median(r["warm_median_ms"] for r in by[a])
    ttfb = statistics.median(r["cold"]["ttfb_ms"] for r in by[a])
    nodes = defaultdict(int)
    for r in by[a]:
        nodes[r["ev"].get("node")] += 1
    dec = [statistics.median([r["ev"].get(k) for r in by[a] if r["ev"].get(k) is not None]) for k in ("created_s", "started_s", "ready_s")]
    print(f"{a} | {len(xs)} | {m} | {q1} | {q3} | {q3-q1} | {min(xs)} | {max(xs)} | {warm} | {ttfb} | {dict(nodes)} | {dec}")

print("\nper-cycle (round, order, arm, cold ms, warm median, node):")
for r in rows:
    print(r["round"], r["order"], r["arm"], r["cold"]["total_ms"], r["warm_median_ms"], r["ev"].get("node"), r["ev"].get("created_s"), r["ev"].get("started_s"), r["ev"].get("ready_s"), r["ev"].get("ready_log"))

print("\npairwise (median diff A-B ms, exact MW p, Holm-adjusted, bootstrap 95% CI of diff):")
pairs = list(itertools.combinations(arms, 2))
ps = []
for a, b in pairs:
    xa = [r["cold"]["total_ms"] for r in by[a]]
    xb = [r["cold"]["total_ms"] for r in by[b]]
    ps.append((a, b, statistics.median(xa) - statistics.median(xb), mw_exact(xa, xb), boot_ci(xa, xb)))
order = sorted(range(len(ps)), key=lambda i: ps[i][3])
adj = [0] * len(ps)
run = 0
for k, i in enumerate(order):
    run = max(run, min(1, ps[i][3] * (len(ps) - k)))
    adj[i] = run
for i, (a, b, d, p, ci) in enumerate(ps):
    print(f"{a} vs {b}: diff {d:+.0f} ms, p={p:.4f}, holm={adj[i]:.4f}, CI [{ci[0]:+.0f}, {ci[1]:+.0f}]")


def pooled(pred, label):
    x = [r["cold"]["total_ms"] for r in valid if pred(r["arm"])]
    y = [r["cold"]["total_ms"] for r in valid if not pred(r["arm"])]
    # normal-approx MW for pooled (n up to 20 each)
    import math
    U = sum((1 if xi > yi else 0.5 if xi == yi else 0) for xi in x for yi in y)
    mu = len(x) * len(y) / 2
    sd = math.sqrt(len(x) * len(y) * (len(x) + len(y) + 1) / 12)
    z = (U - mu) / sd
    p = math.erfc(abs(z) / math.sqrt(2))
    print(f"{label}: median {statistics.median(x)} vs {statistics.median(y)} (diff {statistics.median(x)-statistics.median(y):+.0f}), n={len(x)}/{len(y)}, MW normal-approx p={p:.4f}, CI {boot_ci(x, y)}")


print("\nfactor level:")
pooled(lambda a: "node" in a, "runtime node vs bun")
pooled(lambda a: "turbopack" in a, "builder turbopack vs webpack")
