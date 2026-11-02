#!/usr/bin/env python3
"""Analysis for the 2026-11-02 startup-CPU-boost run (Measurement A) and the
listening->Ready gap (Measurement B). Reads the drive.py JSONL; prints tables.

    python3 cpu-boost-analyze.py docs/benchmarks/data/cpu-boost-oke-2026-11-02.jsonl

Validity (a wake is excluded, and the exclusion is reported, if):
  - the harness reported an error, or the HTTP code is not 200;
  - the pod list before the request was not empty (cold-cycle.mjs throws in that
    case, so this is a belt-and-braces check on the row itself);
  - no pod was ADDED after t0 (the request did not create the pod).
"""
import json
import random
import statistics
import sys

path = sys.argv[1]
rows = [json.loads(l) for l in open(path) if l.startswith("{")]
ARMS = ["cpu-base", "cpu-boost2", "cpu-boost2req"]

def valid(r):
    if "error" in r or r.get("code") != 200:
        return False, "error/non-200"
    w = r.get("watch", {})
    if "pod_added" not in w or w["pod_added"] <= 0:
        return False, "no pod added after t0"
    return True, ""

def pct(xs, p):
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)

def boot_ci_diff(a, b, n=10000, seed=1):
    """95% percentile bootstrap CI for median(a) - median(b)."""
    rng = random.Random(seed)
    diffs = []
    for _ in range(n):
        sa = [rng.choice(a) for _ in a]
        sb = [rng.choice(b) for _ in b]
        diffs.append(statistics.median(sa) - statistics.median(sb))
    diffs.sort()
    return diffs[int(0.025 * n)], diffs[int(0.975 * n)]

def hl_shift(a, b):
    """Hodges-Lehmann shift estimate: median of all pairwise differences a_i - b_j."""
    return statistics.median([x - y for x in a for y in b])

def mann_whitney_p(a, b):
    """Two-sided Mann-Whitney U p-value, normal approximation, midranks for ties."""
    import math
    pooled = sorted([(v, 0) for v in a] + [(v, 1) for v in b])
    n1, n2 = len(a), len(b)
    rank_sum_a = 0.0
    i = 0
    while i < len(pooled):
        j = i
        while j < len(pooled) and pooled[j][0] == pooled[i][0]:
            j += 1
        midrank = (i + 1 + j) / 2  # ranks i+1..j, averaged
        rank_sum_a += midrank * sum(1 for k in range(i, j) if pooled[k][1] == 0)
        i = j
    u = rank_sum_a - n1 * (n1 + 1) / 2
    mu = n1 * n2 / 2
    sigma = math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12)
    z = (u - mu) / sigma
    return math.erfc(abs(z) / math.sqrt(2))

def summarise(name, xs):
    if not xs:
        return f"{name}: n=0"
    return (f"{name}: n={len(xs)} median={statistics.median(xs):.0f} "
            f"p95={pct(xs, 0.95):.0f} mean={statistics.mean(xs):.0f} "
            f"min={min(xs):.0f} max={max(xs):.0f}")

# ---- partition ----
kept, excluded = {a: [] for a in ARMS}, []
for r in rows:
    ok, why = valid(r)
    if ok:
        kept[r["arm"]].append(r)
    else:
        excluded.append((r.get("arm"), r.get("round"), why))

print("== wakes: total", len(rows), "excluded", len(excluded))
for e in excluded:
    print("   excluded", e)
for a in ARMS:
    print(f"   {a}: kept {len(kept[a])}, nodes "
          f"{sorted(set(r['node'] for r in kept[a]))}")

def total(r):
    return r["watch"]["first_byte"]

def col(arm, f, node=None):
    return [f(r) for r in kept[arm] if node is None or r["node"] == node]

print("\n== Measurement A: total cold start = first byte (ms after request)")
for a in ARMS:
    print(" ", summarise(a, col(a, total)))
base = col("cpu-base", total)
for a in ARMS[1:]:
    xs = col(a, total)
    lo, hi = boot_ci_diff(xs, base)
    print(f"  {a} - cpu-base: HL shift={hl_shift(xs, base):.0f} ms, "
          f"median diff CI95=[{lo:.0f}, {hi:.0f}], MWU p={mann_whitney_p(xs, base):.2g}")

print("\n== stratified by node (same comparisons within each node)")
for node in sorted(set(r["node"] for r in rows)):
    for a in ARMS:
        print(" ", node, summarise(a, col(a, total, node)))

# ---- Measurement B: phase gaps ----
PHASES = [
    ("pod_added", "watch: pod ADDED after request"),
    ("pod_bound", "scheduler bound nodeName"),
    ("pod_ip", "status.podIP visible (kubelet sync, sandbox up)"),
    ("user-container_running", "user container running"),
    ("app_tcp_3000", "app TCP :3000 accepting (listening)"),
    ("qp_tcp_8012", "queue-proxy TCP :8012 accepting"),
    ("cond_Ready", "pod Ready condition"),
    ("eps_present", "EndpointSlice lists pod"),
    ("eps_ready", "EndpointSlice marks pod ready"),
    ("first_byte", "first response byte"),
]
print("\n== Measurement B: phase timestamps (ms after request), all kept wakes")
for key, label in PHASES:
    vals = [r["watch"][key] for r in rows if valid(r)[0] and key in r["watch"]]
    if vals:
        print(f"  {key:24s} median={statistics.median(vals):7.0f} p95={pct(vals, 0.95):7.0f}  {label}")

print("\n== Measurement B: successive gaps (median ms, all kept wakes)")
ORDER = [k for k, _ in PHASES]
kept_all = [r for r in rows if valid(r)[0]]
for i in range(1, len(ORDER)):
    a, b = ORDER[i - 1], ORDER[i]
    gaps = [r["watch"][b] - r["watch"][a] for r in kept_all
            if a in r["watch"] and b in r["watch"]]
    if gaps:
        print(f"  {a:24s} -> {b:24s} median={statistics.median(gaps):7.0f} "
              f"p95={pct(gaps, 0.95):7.0f} n={len(gaps)}")

# ---- Measurement B, log-anchored: app "Ready in" line vs pod status ----
import re


def ready_in_ms(r):
    """CRI stamp (ms after request) of the app's "Ready in" line (harness clock)."""
    for x in r["logs"].get("user-container", []):
        if isinstance(x, dict) and re.search(r"Ready in", x.get("line", "")):
            return x["t"]
    return None


print("\n== Measurement B, log-anchored (per arm; ms)")
print("  bound->'Ready in' = app startup inside the container;")
print("  'Ready in'->cond_Ready = status lag (podIP + Ready reach the API after the app is up)")
for arm in ARMS:
    seg1, seg2, fb = [], [], []
    for r in kept[arm]:
        t = ready_in_ms(r)
        w = r["watch"]
        if t is None or "cond_Ready" not in w:
            continue
        seg1.append(t - w["pod_bound"])
        seg2.append(w["cond_Ready"] - t)
        fb.append(w["first_byte"])
    if seg1:
        print(f"  {arm:14s} n={len(seg1):2d} bound->Ready-in median={statistics.median(seg1):.0f} "
              f"p95={pct(seg1, 0.95):.0f} | Ready-in->cond_Ready median={statistics.median(seg2):.0f} "
              f"p95={pct(seg2, 0.95):.0f} | first_byte median={statistics.median(fb):.0f}")
