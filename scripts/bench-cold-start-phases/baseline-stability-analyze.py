#!/usr/bin/env python3
"""Analysis for the baseline-stability study (stdlib only, seeded, prints every number it uses).

    python3 baseline-stability-analyze.py [--json out.json]

Reads, from docs/benchmarks/data/:
  cpu-boost-oke-2026-11-02.jsonl                  three-arm run (committed earlier)
  cold-start-node-diagnosis-oke-2026-11-02.jsonl  single-arm run (committed earlier)
  cold-start-baseline-stability-oke-2026-11-02.jsonl  this study (balanced run)

Metric = request -> response end (watch.resp_end, ms), the instrument's total.
Only wakes with HTTP 200 and no harness error count. Only the `cpu-base` arm is a
target everywhere; the companion arm in this study is a placement primer.
"""
import json
import math
import pathlib
import random
import statistics as st
import sys
from datetime import datetime

DATA = pathlib.Path(__file__).resolve().parents[2] / "docs" / "benchmarks" / "data"
FILES = {
    "three-arm": "cpu-boost-oke-2026-11-02.jsonl",
    "single-arm": "cold-start-node-diagnosis-oke-2026-11-02.jsonl",
    "balanced": "cold-start-baseline-stability-oke-2026-11-02.jsonl",
}
N_BOOT = 4000
MODE_SPLIT = 650.0  # ms; bound -> first user log is bimodal (modes near 440 and 880 ms)
OUT = {}


def ts(r):
    return datetime.fromisoformat(r["wall_start"].replace("Z", "+00:00")).timestamp()


def load(name, arm="cpu-base"):
    p = DATA / FILES[name]
    if not p.exists():
        return []
    rows = [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
    rows = [r for r in rows if r.get("arm") == arm and r.get("code") == 200 and "error" not in r]
    for r in rows:
        r["_y"] = r["watch"]["resp_end"]
        r["_t"] = ts(r)
        r["_n"] = r["node"].split(".")[-1]
        f = segs(r).get("bound_to_first_user_log")
        if f is not None:
            r["_hi"] = f > MODE_SPLIT
    rows.sort(key=lambda r: r["_t"])
    return rows


def segs(r):
    w = r["watch"]
    out = {"total": w.get("resp_end"), "wake_to_bound": w.get("pod_bound")}
    b = w.get("pod_bound")
    ip = w.get("pod_ip")
    uc = [e for e in ((r.get("logs") or {}).get("user-container") or []) if isinstance(e, dict) and "t" in e]
    if b is not None and uc:
        out["bound_to_first_user_log"] = uc[0]["t"] - b
    if b is not None and ip is not None:
        out["bound_to_podip"] = ip - b
    if ip is not None and w.get("resp_end") is not None:
        out["podip_to_end"] = w["resp_end"] - ip
    return out


def med(v):
    return st.median(v)


def boot_ci(f, a, b=None, seed=7):
    rnd = random.Random(seed)
    xs = []
    for _ in range(N_BOOT):
        ra = [rnd.choice(a) for _ in a]
        if b is None:
            xs.append(f(ra))
        else:
            rb = [rnd.choice(b) for _ in b]
            xs.append(f(ra, rb))
    xs.sort()
    return xs[int(0.025 * N_BOOT)], xs[int(0.975 * N_BOOT) - 1]


def perm_p(a, b, seed=11, n=10000):
    rnd = random.Random(seed)
    obs = abs(med(a) - med(b))
    pool = list(a) + list(b)
    k = len(a)
    hit = 0
    for _ in range(n):
        rnd.shuffle(pool)
        if abs(med(pool[:k]) - med(pool[k:])) >= obs:
            hit += 1
    return (hit + 1) / (n + 1)


def ranks(v):
    o = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v)
    i = 0
    while i < len(o):
        j = i
        while j + 1 < len(o) and v[o[j + 1]] == v[o[i]]:
            j += 1
        for k in range(i, j + 1):
            r[o[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def spearman(x, y):
    if len(x) < 4 or len(set(x)) < 2 or len(set(y)) < 2:
        return None, None
    rx, ry = ranks(x), ranks(y)
    mx, my = st.mean(rx), st.mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    rho = num / den
    # permutation p (seeded)
    rnd = random.Random(5)
    ys = list(ry)
    hit = 0
    for _ in range(4000):
        rnd.shuffle(ys)
        m2 = st.mean(ys)
        c = sum((a - mx) * (b - m2) for a, b in zip(rx, ys)) / den
        if abs(c) >= abs(rho):
            hit += 1
    return rho, (hit + 1) / 4001


def solve(A, b):
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        if abs(M[c][c]) < 1e-12:
            return None
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                M[r] = [x - f * y for x, y in zip(M[r], M[c])]
    return [M[i][n] / M[i][i] for i in range(n)]


def ols(X, y):
    k = len(X[0])
    A = [[sum(r[i] * r[j] for r in X) for j in range(k)] for i in range(k)]
    b = [sum(r[i] * yy for r, yy in zip(X, y)) for i in range(k)]
    return solve(A, b)


def cmp(label, a, b, la="A", lb="B"):
    """median(a)-median(b) with bootstrap CI and permutation p."""
    if len(a) < 3 or len(b) < 3:
        print(f"  {label}: n({la})={len(a)} n({lb})={len(b)} too few")
        return
    d = med(a) - med(b)
    lo, hi = boot_ci(lambda x, y: med(x) - med(y), a, b)
    p = perm_p(a, b)
    print(f"  {label}: median {la}={med(a):.0f} (n={len(a)}, mean {st.mean(a):.0f}, sd {st.pstdev(a):.0f}) "
          f"{lb}={med(b):.0f} (n={len(b)}, mean {st.mean(b):.0f}, sd {st.pstdev(b):.0f}) "
          f"diff={d:+.0f} ms  95% CI [{lo:+.0f}, {hi:+.0f}]  perm p={p:.3f}")
    OUT[label] = {"diff_ms": d, "ci": [lo, hi], "p": p, "n_a": len(a), "n_b": len(b)}


def describe(name, rows):
    y = [r["_y"] for r in rows]
    print(f"\n== {name}: n={len(rows)} median={med(y):.0f} mean={st.mean(y):.0f} sd={st.pstdev(y):.0f} "
          f"min={min(y):.0f} max={max(y):.0f}")
    for n in sorted({r["_n"] for r in rows}):
        v = [r["_y"] for r in rows if r["_n"] == n]
        print(f"   node .{n}: n={len(v)} median={med(v):.0f} mean={st.mean(v):.0f} sd={st.pstdev(v):.0f}")


def trend(name, rows):
    if len(rows) < 6:
        return
    t0 = rows[0]["_t"]
    x = [(r["_t"] - t0) / 3600 for r in rows]
    y = [r["_y"] for r in rows]
    rho, p = spearman(x, y)
    xm, ym = st.mean(x), st.mean(y)
    slope = sum((a - xm) * (b - ym) for a, b in zip(x, y)) / sum((a - xm) ** 2 for a in x)
    lo, hi = boot_ci(lambda idx: 0, list(range(len(x))))  # placeholder, replaced below
    rnd = random.Random(3)
    sl = []
    for _ in range(2000):
        idx = [rnd.randrange(len(x)) for _ in x]
        xs = [x[i] for i in idx]
        ys = [y[i] for i in idx]
        mx, my = st.mean(xs), st.mean(ys)
        den = sum((a - mx) ** 2 for a in xs)
        if den:
            sl.append(sum((a - mx) * (b - my) for a, b in zip(xs, ys)) / den)
    sl.sort()
    print(f"  time trend [{name}]: span={x[-1]:.2f} h, Spearman rho={rho:+.2f} (perm p={p:.3f}), "
          f"OLS slope={slope:+.0f} ms/h  95% CI [{sl[int(.025 * len(sl))]:+.0f}, {sl[int(.975 * len(sl)) - 1]:+.0f}]")


def offline():
    print("##### A. OFFLINE: committed data only #####")
    three = load("three-arm")
    single = load("single-arm")
    describe("three-arm run, cpu-base only", three)
    describe("single-arm run, cpu-base only", single)
    allthree = [r["_y"] for r in three]
    print(f"\n  headline check: the 1276 ms figure is the median of cpu-base in the three-arm run: {med(allthree):.0f} ms "
          f"(n={len(allthree)}); the 1806 ms figure is the single-arm median: {med([r['_y'] for r in single]):.0f} ms")
    print("\n  -- Is it the node? (same node .169, three-arm vs single-arm) --")
    a = [r["_y"] for r in single]
    b = [r["_y"] for r in three if r["_n"] == "169"]
    cmp("offline: single-arm@169 minus three-arm@169", a, b, "single@169", "three@169")
    c = [r["_y"] for r in three if r["_n"] == "118"]
    cmp("offline: three-arm@169 minus three-arm@118", b, c, "169", "118")
    cmp("offline: single-arm@169 minus three-arm@118", a, c, "single@169", "three@118")
    print("\n  -- Segments, same node .169 (median ms) --")
    sa = [segs(r) for r in single]
    sb = [segs(r) for r in three if r["_n"] == "169"]
    for k in ["wake_to_bound", "bound_to_first_user_log", "bound_to_podip", "podip_to_end", "total"]:
        va = [s[k] for s in sa if k in s]
        vb = [s[k] for s in sb if k in s]
        if len(va) >= 3 and len(vb) >= 3:
            cmp(f"offline segment {k}: single@169 minus three@169", va, vb, "single", "three")
    print("\n  -- Wake spacing --")
    for name, rows in [("three-arm", three), ("single-arm", single)]:
        w = [r["waited_s"] for r in rows[1:]]
        gaps = [(rows[i]["_t"] - rows[i - 1]["_t"]) for i in range(1, len(rows))]
        print(f"  [{name}] zero-pod wait: median {med(w):.0f} s (min {min(w)}, max {max(w)}); "
              f"gap between consecutive cpu-base wakes: median {med(gaps) / 60:.1f} min")
    # gap since previous wake on the same node (any arm) in the three-arm run
    allrows = [json.loads(l) for l in (DATA / FILES["three-arm"]).read_text().splitlines()]
    allrows = [r for r in allrows if r.get("code") == 200 and "error" not in r]
    for r in allrows:
        r["_t"] = ts(r)
    allrows.sort(key=lambda r: r["_t"])
    last = {}
    for r in allrows:
        r["_since_node"] = r["_t"] - last[r["node"]] if r["node"] in last else None
        last[r["node"]] = r["_t"]
    g = [(r["_since_node"], r["watch"]["resp_end"]) for r in allrows if r["arm"] == "cpu-base" and r["_since_node"]]
    rho, p = spearman([x for x, _ in g], [y for _, y in g])
    print(f"  three-arm: seconds since the previous wake on the same node vs cpu-base total: n={len(g)}, "
          f"gap median {med([x for x, _ in g]):.0f} s, Spearman rho={rho:+.2f} (p={p:.3f})")
    print("\n  -- Arm order / round position (three-arm, cpu-base) --")
    cmp("offline: fwd order minus rev order", [r["_y"] for r in three if r["order"] == "fwd"],
        [r["_y"] for r in three if r["order"] == "rev"], "fwd", "rev")
    print("\n  -- Time trend --")
    trend("three-arm cpu-base", three)
    trend("single-arm cpu-base", single)
    # which node did cpu-base land on in rounds, to show confounding of node with slot
    print("\n  -- Placement in the three-arm run (cpu-base): node by round slot --")
    slot = {}
    rnds = {}
    for r in allrows:
        rnds.setdefault(r["round"], []).append(r)
    for k, v in rnds.items():
        v.sort(key=lambda r: r["_t"])
        for i, r in enumerate(v):
            if r["arm"] == "cpu-base":
                slot.setdefault((i, r["node"].split(".")[-1]), 0)
                slot[(i, r["node"].split(".")[-1])] += 1
    print("  (slot, node): count  ->", dict(sorted(slot.items())))
    print("  Note: in the three-arm run the first-woken arm of a round lands on .169 and later arms alternate, "
          "so node and slot are confounded there; the single-arm run is all .169.")


def bg_vals(r, which, key):
    n = r["node"]
    d = (r.get(which) or {}).get(n) or {}
    return d.get(key)


def live():
    print("\n\n##### B. LIVE: balanced run (this study) #####")
    rows = load("balanced")
    if not rows:
        print("  no balanced data present")
        return
    describe("balanced run, cpu-base target", rows)
    t = {n: [r for r in rows if r["_n"] == n] for n in ("118", "169")}
    print(f"\n  wakes per node (target): .118={len(t['118'])}  .169={len(t['169'])}  (requirement: >=15 each)")
    for sp in ("short", "long"):
        for n in ("118", "169"):
            print(f"   cell node .{n} / {sp}: n={sum(1 for r in t[n] if r['spacing'] == sp)}")
    print("\n  -- Node effect --")
    cmp("live: node .169 minus .118", [r["_y"] for r in t["169"]], [r["_y"] for r in t["118"]], "169", "118")
    print("\n  -- Node effect by segment (median ms) --")
    for k in ["wake_to_bound", "bound_to_first_user_log", "bound_to_podip", "podip_to_end", "total"]:
        va = [segs(r)[k] for r in t["169"] if k in segs(r)]
        vb = [segs(r)[k] for r in t["118"] if k in segs(r)]
        cmp(f"live segment {k}: .169 minus .118", va, vb, "169", "118")
    print("\n  -- Wake spacing effect --")
    cmp("live: long minus short (all)", [r["_y"] for r in rows if r["spacing"] == "long"],
        [r["_y"] for r in rows if r["spacing"] == "short"], "long", "short")
    for n in ("118", "169"):
        cmp(f"live: long minus short on .{n}", [r["_y"] for r in t[n] if r["spacing"] == "long"],
            [r["_y"] for r in t[n] if r["spacing"] == "short"], "long", "short")
    gaps = [(r["extra_idle_s"], r["waited_s"]) for r in rows]
    print(f"  harness zero-pod wait: median {med([w for _, w in gaps]):.0f} s; long-level extra idle {max(e for e, _ in gaps)} s")
    print("\n  -- Slot (position in the round) --")
    cmp("live: slot0 minus slot1", [r["_y"] for r in rows if r["slot"] == 0], [r["_y"] for r in rows if r["slot"] == 1],
        "slot0", "slot1")
    print("\n  -- Time trend --")
    trend("balanced cpu-base", rows)
    for n in ("118", "169"):
        trend(f"balanced cpu-base .{n}", t[n])
    print("\n  -- Background load (Spearman, per wake, target total vs reading on the node it landed on) --")
    for which in ("bg_pre", "bg_post"):
        for key in ("node_cpu_nc", "psi_cpu_some_avg10", "node_mem_ws", "n_running", "n_running_bench_cells"):
            for scope, grp in (("both", rows), (".118", t["118"]), (".169", t["169"])):
                x = [(bg_vals(r, which, key), r["_y"]) for r in grp if bg_vals(r, which, key) is not None]
                if len(x) < 8:
                    continue
                rho, p = spearman([a for a, _ in x], [b for _, b in x])
                if rho is None:
                    print(f"   {which}.{key} [{scope}]: n={len(x)} constant, no correlation computable")
                    continue
                print(f"   {which}.{key} [{scope}]: n={len(x)} rho={rho:+.2f} p={p:.3f}  "
                      f"(range {min(a for a, _ in x):.4g}..{max(a for a, _ in x):.4g})")
    print("\n  -- Per-node background level (median over wakes) --")
    for n in ("118", "169"):
        for key in ("node_cpu_nc", "psi_cpu_some_avg10", "n_running", "n_running_bench_cells"):
            v = [bg_vals(r, "bg_pre", key) for r in t[n]]
            v = [x for x in v if x is not None]
            if v:
                print(f"   .{n} pre-wake {key}: median {med(v):.4g} (min {min(v):.4g}, max {max(v):.4g}, n={len(v)})")
    print("\n  -- Slot is confounded with node for the target arm --")
    for n in ("118", "169"):
        for sl in (0, 1):
            print(f"   target on .{n} at slot {sl}: n={sum(1 for r in t[n] if r['slot'] == sl)}")
    print("   (the target never lands on .118 at slot 0, so slot cannot be separated from node and is left out of the model)")
    print("\n  -- Multi-factor model: total ~ intercept + node169 + long + hours (OLS, case-bootstrap 95% CI) --")
    t0 = rows[0]["_t"]

    def fit(rs, extra, names, title):
        X = [[1.0, 1.0 if r["_n"] == "169" else 0.0, 1.0 if r["spacing"] == "long" else 0.0, (r["_t"] - t0) / 3600]
             + [f(r) for f in extra] for r in rs]
        y = [r["_y"] for r in rs]
        beta = ols(X, y)
        rnd = random.Random(9)
        bs = []
        for _ in range(2000):
            idx = [rnd.randrange(len(rs)) for _ in rs]
            b = ols([X[i] for i in idx], [y[i] for i in idx])
            if b:
                bs.append(b)
        print(f"   [{title}] n={len(y)}")
        res = [y[i] - sum(c * v for c, v in zip(beta, X[i])) for i in range(len(y))]
        for i, nme in enumerate(names):
            col = sorted(b[i] for b in bs)
            print(f"     {nme}: {beta[i]:+.0f} ms  95% CI [{col[int(.025 * len(col))]:+.0f}, {col[int(.975 * len(col)) - 1]:+.0f}]")
        ssr = sum(e * e for e in res)
        sst = sum((v - st.mean(y)) ** 2 for v in y)
        print(f"     R^2={1 - ssr / sst:.2f}  residual sd={math.sqrt(ssr / (len(y) - len(beta))):.0f} ms")
        OUT["model_" + title] = dict(zip(names, beta))

    base_names = ["intercept", "node .169 (vs .118)", "long spacing (vs short)", "per hour of run"]
    fit(rows, [], base_names, "without start mode")
    fit([r for r in rows if "_hi" in r], [lambda r: 1.0 if r["_hi"] else 0.0],
        base_names + ["slow start mode (vs fast)"], "with start mode")

    print("\n  -- Cross-day check: this study's cpu-base vs the earlier runs, same node --")
    three, single = load("three-arm"), load("single-arm")
    for n in ("118", "169"):
        cur = [r["_y"] for r in t[n]]
        cmp(f"live@{n} minus three-arm@{n}", cur, [r["_y"] for r in three if r["_n"] == n], "live", "three")
    cmp("live@169 minus single-arm@169", [r["_y"] for r in t["169"]], [r["_y"] for r in single], "live", "single")
    cmp("live all minus three-arm all", [r["_y"] for r in rows], [r["_y"] for r in three], "live", "three")

    print("\n  -- Variance and protocol sizing --")
    y = [r["_y"] for r in rows]
    sd = st.stdev(y)
    # residual sd after node stratification
    resid = []
    for n in ("118", "169"):
        m = med([r["_y"] for r in t[n]])
        resid += [r["_y"] - m for r in t[n]]
    sd_strat = st.stdev(resid)
    mad = med([abs(e) for e in resid]) * 1.4826
    print(f"  total sd={sd:.0f} ms; within-node sd={sd_strat:.0f} ms; robust within-node sd (1.4826*MAD)={mad:.0f} ms")
    # paired: same round, target minus companion (different config, so only the NOISE is informative)
    allp = DATA / FILES["balanced"]
    rr = [json.loads(l) for l in allp.read_text().splitlines()]
    byr = {}
    for r in rr:
        if r.get("code") == 200 and "error" not in r:
            byr.setdefault(r["round"], {})[r["arm"]] = r
    same, diff = [], []
    for k, d in byr.items():
        if len(d) == 2:
            a, b = d["cpu-base"], d["cpu-boost2req"]
            e = a["watch"]["resp_end"] - b["watch"]["resp_end"]
            (same if a["node"] == b["node"] else diff).append(e)
    print(f"  within-round target minus companion (config differs; use only for noise): "
          f"n={len(same) + len(diff)} sd={st.stdev(same + diff):.0f} ms")
    # adjacent-pair sd on same node, consecutive target wakes
    adj = []
    for n in ("118", "169"):
        v = t[n]
        adj += [v[i]["_y"] - v[i - 1]["_y"] for i in range(1, len(v))]
    sd_adj = st.stdev(adj) if len(adj) > 2 else float("nan")
    print(f"  consecutive same-node target wakes, difference sd={sd_adj:.0f} ms (n={len(adj)}); "
          f"implied per-wake sd if independent={sd_adj / math.sqrt(2):.0f} ms")
    z = 1.96 + 0.84
    for n_per in (15, 20, 30, 40):
        print(f"   MDE (80% power, alpha .05, unpaired, per arm n={n_per}, sd={sd_strat:.0f}): {z * sd_strat * math.sqrt(2 / n_per):.0f} ms; "
              f"paired on sd_diff={sd_adj:.0f}: {z * sd_adj / math.sqrt(n_per):.0f} ms")
    if "--json" in sys.argv:
        pathlib.Path(sys.argv[sys.argv.index("--json") + 1]).write_text(json.dumps(OUT, indent=1, default=str))


def wilson(k, n, z=1.96):
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return p, c - h, c + h


def fisher(a, b, c, d):
    """two-sided Fisher exact for [[a,b],[c,d]]"""
    n1, n2, k = a + b, c + d, a + c
    tot = n1 + n2

    def pr(x):
        return math.comb(n1, x) * math.comb(n2, k - x) / math.comb(tot, k)

    p0 = pr(a)
    return sum(pr(x) for x in range(max(0, k - n2), min(n1, k) + 1) if pr(x) <= p0 * (1 + 1e-9))


def modes():
    print("\n\n##### C. START MODE: bound -> first user log is bimodal #####")
    sets = {"three-arm": load("three-arm"), "single-arm": load("single-arm"), "balanced": load("balanced")}
    groups = []
    for name, rows in sets.items():
        for n in ("118", "169"):
            g = [r for r in rows if r["_n"] == n and "_hi" in r]
            if g:
                groups.append((f"{name}@{n}", g))
    print(f"  split at {MODE_SPLIT:.0f} ms. Fast-mode and slow-mode medians (ms) of bound->first user log, then share of slow-mode wakes (Wilson 95%):")
    allg = [r for g in sets.values() for r in g if "_hi" in r]
    fast = [segs(r)["bound_to_first_user_log"] for r in allg if not r["_hi"]]
    slow = [segs(r)["bound_to_first_user_log"] for r in allg if r["_hi"]]
    print(f"  all target wakes: fast mode median {med(fast):.0f} (n={len(fast)}, range {min(fast):.0f}-{max(fast):.0f}); "
          f"slow mode median {med(slow):.0f} (n={len(slow)}, range {min(slow):.0f}-{max(slow):.0f}); gap between modes {med(slow) - med(fast):.0f} ms")
    for name, g in groups:
        k = sum(1 for r in g if r["_hi"])
        p, lo, hi = wilson(k, len(g))
        ty = [r["_y"] for r in g]
        print(f"   {name}: slow {k}/{len(g)} = {p:.0%} [{lo:.0%}, {hi:.0%}]; total median {med(ty):.0f} ms")
        OUT["share_slow_" + name] = [k, len(g), p, lo, hi]
    fastt = [r["_y"] for r in allg if not r["_hi"]]
    slowt = [r["_y"] for r in allg if r["_hi"]]
    cmp("modes: total, slow minus fast (all target wakes)", slowt, fastt, "slow", "fast")
    # does the mixture explain the cross-run shift? re-weight
    pf, ps = med(fastt), med(slowt)
    print(f"  mixture check: fast-mode total median {pf:.0f}, slow-mode {ps:.0f}. Within each mode, compare the runs:")
    for label, hi in (("fast", False), ("slow", True)):
        a = [r["_y"] for r in sets["single-arm"] if r.get("_hi") is hi]
        b = [r["_y"] for r in sets["three-arm"] if r.get("_hi") is hi]
        c = [r["_y"] for r in sets["balanced"] if r.get("_hi") is hi]
        cmp(f"modes: {label}-mode single-arm minus three-arm", a, b, "single", "three")
        cmp(f"modes: {label}-mode balanced minus three-arm", c, b, "balanced", "three")
    print("\n  -- Node and slow-mode share (balanced run) --")
    bal = sets["balanced"]
    cnt = {n: (sum(1 for r in bal if r["_n"] == n and r.get("_hi")), sum(1 for r in bal if r["_n"] == n and r.get("_hi") is False)) for n in ("118", "169")}
    print(f"  slow/fast .118={cnt['118']}  .169={cnt['169']}  Fisher exact p={fisher(*cnt['118'], *cnt['169']):.3f}")
    allc = {}
    for name, rows in sets.items():
        for n in ("118", "169"):
            allc[(name, n)] = (sum(1 for r in rows if r["_n"] == n and r.get("_hi")), sum(1 for r in rows if r["_n"] == n and r.get("_hi") is False))
    print(f"  three-arm@169 slow/fast={allc[('three-arm', '169')]} vs single-arm@169={allc[('single-arm', '169')]}: "
          f"Fisher p={fisher(*allc[('three-arm', '169')], *allc[('single-arm', '169')]):.4f}")
    print(f"  three-arm@169 vs balanced@169={allc[('balanced', '169')]}: Fisher p={fisher(*allc[('three-arm', '169')], *allc[('balanced', '169')]):.4f}")
    print(f"  three-arm@118={allc[('three-arm', '118')]} vs balanced@118={allc[('balanced', '118')]}: Fisher p={fisher(*allc[('three-arm', '118')], *allc[('balanced', '118')]):.4f}")
    print("\n  -- What predicts slow mode in the balanced run? (slow-mode vs fast-mode wakes) --")
    hi = [r for r in bal if r.get("_hi")]
    lo = [r for r in bal if r.get("_hi") is False]
    for label, f in (("spacing long", lambda r: 1.0 if r["spacing"] == "long" else 0.0),
                     ("hours into run", lambda r: (r["_t"] - bal[0]["_t"]) / 3600),
                     ("slot", lambda r: float(r["slot"])),
                     ("node .169", lambda r: 1.0 if r["_n"] == "169" else 0.0),
                     ("harness zero-pod wait s", lambda r: float(r["waited_s"]))):
        x = [f(r) for r in hi + lo]
        yv = [1.0] * len(hi) + [0.0] * len(lo)
        rho, p = spearman(x, yv)
        print(f"   {label}: slow-mode mean {st.mean(f(r) for r in hi):.2f} vs fast-mode mean {st.mean(f(r) for r in lo):.2f}; "
              f"rank corr {rho:+.2f} (p={p:.3f})")
    for key in ("node_cpu_nc", "node_mem_ws"):
        a = [bg_vals(r, "bg_pre", key) for r in hi if bg_vals(r, "bg_pre", key) is not None]
        b = [bg_vals(r, "bg_pre", key) for r in lo if bg_vals(r, "bg_pre", key) is not None]
        if a and b:
            print(f"   pre-wake {key}: slow-mode median {med(a):.4g} (n={len(a)}) vs fast-mode {med(b):.4g} (n={len(b)})")
    # runs of the same mode on a node: autocorrelation of mode in time order
    for n in ("118", "169"):
        seq = [1 if r["_hi"] else 0 for r in bal if r["_n"] == n and "_hi" in r]
        same = sum(1 for i in range(1, len(seq)) if seq[i] == seq[i - 1])
        k = sum(seq)
        pe = (k / len(seq)) ** 2 + (1 - k / len(seq)) ** 2
        print(f"   .{n}: sequence {''.join('H' if v else 'l' for v in seq)}; consecutive same-mode {same}/{len(seq) - 1} "
              f"(expected {pe * (len(seq) - 1):.1f} if independent)")

def n_modes(xs, h, grid):
    dens = [sum(math.exp(-0.5 * ((g - x) / h) ** 2) for x in xs) for g in grid]
    return sum(1 for i in range(1, len(dens) - 1) if dens[i] > dens[i - 1] and dens[i] >= dens[i + 1])


def crit_bw(xs, grid):
    lo, hi = 1.0, (max(xs) - min(xs))
    for _ in range(12):
        mid = (lo + hi) / 2
        if n_modes(xs, mid, grid) <= 1:
            hi = mid
        else:
            lo = mid
    return hi


def silverman(xs, nboot=200, seed=21):
    """Silverman (1981) critical-bandwidth test of H0: one mode, smoothed bootstrap."""
    grid = [min(xs) - 50 + i * (max(xs) - min(xs) + 100) / 149 for i in range(150)]
    h0 = crit_bw(xs, grid)
    rnd = random.Random(seed)
    m, v = st.mean(xs), st.pvariance(xs)
    hit = 0
    for _ in range(nboot):
        b = [m + (rnd.choice(xs) - m + h0 * rnd.gauss(0, 1)) / math.sqrt(1 + h0 * h0 / v) for _ in xs]
        if crit_bw(b, grid) > h0:
            hit += 1
    return h0, (hit + 1) / (nboot + 1)


def shape():
    print("\n\n##### D. SHAPE OF bound -> first user log, decomposition, multiplicity, pairing #####")
    sets = {"three-arm": load("three-arm"), "single-arm": load("single-arm"), "balanced": load("balanced")}
    allg = [r for g in sets.values() for r in g if "_hi" in r]
    v = sorted(segs(r)["bound_to_first_user_log"] for r in allg)
    fast_max = max(x for x in v if x <= MODE_SPLIT)
    slow_min = min(x for x in v if x > MODE_SPLIT)
    gaps = sorted(((v[i + 1] - v[i], v[i], v[i + 1]) for i in range(len(v) - 1)), reverse=True)
    print(f"  n={len(v)} target wakes. Empirical gap at the {MODE_SPLIT:.0f} ms cut: fast max {fast_max:.0f}, slow min {slow_min:.0f} "
          f"({slow_min - fast_max:.0f} ms). (Difference of the two medians is {med([x for x in v if x > MODE_SPLIT]) - med([x for x in v if x <= MODE_SPLIT]):.0f} ms; that is not a gap.)")
    print("  three largest gaps between adjacent sorted values: " + "; ".join(f"{g:.0f} ms ({a:.0f}->{b:.0f})" for g, a, b in gaps[:3]))
    print(f"  values between 600 and 700 ms: {[round(x) for x in v if 600 <= x <= 700]}  (n={sum(1 for x in v if 600 <= x <= 700)}); "
          f"values 643-664 inclusive: {sum(1 for x in v if 643 <= x <= 664)}")
    print("  share of 'slower cluster' wakes under three cuts:")
    for cut in (500, 650, 760):
        k = sum(1 for x in v if x > cut)
        print(f"   cut {cut}: all {k}/{len(v)} = {k / len(v):.0%}", end="")
        for name in ("three-arm", "single-arm", "balanced"):
            for n in ("118", "169"):
                g = [segs(r)["bound_to_first_user_log"] for r in sets[name] if r["_n"] == n and "_hi" in r]
                if g:
                    print(f"; {name}@{n} {sum(1 for x in g if x > cut)}/{len(g)}", end="")
        print()
    h0, p = silverman(v)
    print(f"  Silverman critical-bandwidth test of one mode vs more (smoothed bootstrap, 200 resamples, seed 21): h_crit={h0:.1f} ms, p={p:.3f}. "
          f"No Hartigan dip test was run.")
    seg = [segs(r)["bound_to_first_user_log"] for r in allg]
    tot = [r["_y"] for r in allg]
    ssx = sum((a - st.mean(seg)) ** 2 for a in seg)
    sxy = sum((a - st.mean(seg)) * (b - st.mean(tot)) for a, b in zip(seg, tot))
    sst = sum((b - st.mean(tot)) ** 2 for b in tot)
    ind = [1.0 if r["_hi"] else 0.0 for r in allg]
    mi = st.mean(ind)
    sxi = sum((a - mi) ** 2 for a in ind)
    sxyi = sum((a - mi) * (b - st.mean(tot)) for a, b in zip(ind, tot))
    print(f"\n  decomposition (all {len(allg)} target wakes): the segment is part of the total. mean segment {st.mean(seg):.0f} ms of mean total "
          f"{st.mean(tot):.0f} ms = {st.mean(seg) / st.mean(tot):.0%}; R^2 of total on the continuous segment alone = {sxy * sxy / (ssx * sst):.2f}; "
          f"R^2 of total on the slower-cluster indicator alone = {sxyi * sxyi / (sxi * sst):.2f}")
    print("\n  multiplicity: the share tests (three-arm@169 vs single-arm@169; vs balanced@169; balanced .169 vs .118) are "
          "uncorrected; about 4 mode tests and about 15 other tests were run, two mode tests share the three-arm@169 reference.")
    for pv in (0.0432, 0.0382, 0.037):
        print(f"   p={pv}: Bonferroni(4) = {min(1.0, 4 * pv):.2f}, Bonferroni(19) = {min(1.0, 19 * pv):.2f}")
    ps = [r for r in sets["single-arm"] if "_hi" in r]
    pt = [r for r in sets["three-arm"] if r["_n"] == "169" and "_hi" in r]
    shs = sum(1 for r in ps if r["_hi"]) / len(ps)
    sht = sum(1 for r in pt if r["_hi"]) / len(pt)
    dsh = shs - sht
    same_node = med([r["_y"] for r in sets["single-arm"]]) - med([r["_y"] for r in sets["three-arm"] if r["_n"] == "169"])
    print(f"\n  attribution on .169, single-arm vs three-arm: share {sht:.3f} -> {shs:.3f}, change {dsh:.3f}; same-node median difference {same_node:.0f} ms")
    for lab, eff in (("590 (slower minus faster, total)", 590.0), ("507 (regression coefficient)", 507.0)):
        print(f"   change x {lab} = {dsh * eff:.0f} ms = {dsh * eff / same_node:.0%} of {same_node:.0f}")
    print(f"   the 1276 vs 1806 comparison also mixes nodes: three-arm has {sum(1 for r in sets['three-arm'] if r['_n'] == '118')} of "
          f"{len(sets['three-arm'])} wakes on .118, single-arm is all .169")
    bal = sets["balanced"]
    c = {(n, s_): sum(1 for r in bal if r["_n"] == n and r["slot"] == s_) for n in ("118", "169") for s_ in (0, 1)}
    print(f"\n  balanced run node x slot counts: {c}; the node row and the slot row of the balanced table are one contrast "
          f"(.118 at slot 1: {c[('118', 1)]} of {c[('118', 0)] + c[('118', 1)]}; .169 at slot 0: {c[('169', 0)]} of {c[('169', 0)] + c[('169', 1)]})")
    rr = [json.loads(l) for l in (DATA / FILES["balanced"]).read_text().splitlines()]
    byr = {}
    for r in rr:
        if r.get("code") == 200 and "error" not in r:
            byr.setdefault(r["round"], {})[r["arm"]] = r
    pr = [(d["cpu-base"]["watch"]["resp_end"], d["cpu-boost2req"]["watch"]["resp_end"], d["cpu-base"]["node"] == d["cpu-boost2req"]["node"])
          for d in byr.values() if len(d) == 2]
    a = [x for x, _, _ in pr]
    b = [y for _, y, _ in pr]
    rho, p = spearman(a, b)
    diffs = [x - y for x, y in zip(a, b)]
    mx, my = st.mean(a), st.mean(b)
    pear = sum((x - mx) * (y - my) for x, y in zip(a, b)) / math.sqrt(sum((x - mx) ** 2 for x in a) * sum((y - my) ** 2 for y in b))
    print(f"\n  within-round pairs (target cpu-base vs companion cpu-boost2req, different config, so a proxy for noise only): n={len(pr)}, "
          f"both on same node in {sum(1 for *_, s in pr if s)} rounds; sd target {st.stdev(a):.0f}, sd companion {st.stdev(b):.0f}, "
          f"sd of within-round difference {st.stdev(diffs):.0f}; Pearson r={pear:+.2f}, Spearman rho={rho:+.2f} (p={p:.3f}); "
          f"sqrt(sd_a^2+sd_b^2)={math.sqrt(st.stdev(a) ** 2 + st.stdev(b) ** 2):.0f} is the difference sd if the two were independent")
    print("  same-config within-round pairs, which are what the recommended protocol uses, were never collected: paired variance for that design is unmeasured.")
    z = 1.96 + 0.84
    sdd = st.stdev(diffs)
    for n_per in (15, 20, 30, 40):
        print(f"   proxy paired MDE (sd of within-round difference {sdd:.0f}, n pairs={n_per}): {z * sdd / math.sqrt(n_per):.0f} ms")


offline()
live()
modes()
shape()
