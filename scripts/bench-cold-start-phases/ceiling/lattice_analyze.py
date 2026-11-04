#!/usr/bin/env python3
"""Analyzer for the kubelet ceiling test: does a 100 ms relist remove the cycle lock, move the median,
and change the slower cluster?

Offline and read-only: it reads harness JSONL (drive.py rows) and makes no cluster call. The input is a
paired run: one `patched` wake and one `control` wake per `round`. Usage:

  python3 lattice_analyze.py paired.jsonl [--patched-arm=patched] [--control-arm=control]
                                          [--perms=100] [--boot=2000] [--seed=1]

Exit codes: 0 analysis printed (whatever the verdict); 2 unreadable or malformed input, or a bad flag;
3 sample too small to judge, refused with nothing judged from it.

The pre-registered reading that this file implements is in RUNBOOK.md beside it. Every number printed
comes with a bootstrap interval or a permutation null; nothing is judged from a single wake.
"""
import argparse
import json
import math
import random
import statistics
import sys
from datetime import datetime

MIN_PAIRS = 30  # protocol: at least 30 wakes per arm
MIN_PER_NODE = 15  # protocol: at least 15 wakes per arm per node
GOAL_MS = 1000.0  # the sub-second median goal
SLOW_CUT_MS = 650.0  # bound -> user first log; the cut that split the 2026-11-02 clusters
BAND_1S = (0.990, 1.020)  # stock relist: measured cycle 1.0031-1.0038 s
BAND_100MS = (0.095, 0.110)  # patched relist: 100 ms period plus a few ms of relist work
ALPHA = 0.05
MIN_PERMS = 20  # p < 0.05 is unreachable with fewer shuffles


class InputError(Exception):
    pass


class SampleError(Exception):
    pass


def pct(values, p):
    v = sorted(values)
    k = (len(v) - 1) * p
    f = int(k)
    c = min(f + 1, len(v) - 1)
    return v[f] + (v[c] - v[f]) * (k - f)


def parse_wall(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()


def load_rows(path, patched, control):
    rows = []
    skipped = {"no_first_byte_or_ip": 0, "no_user_or_queue_proxy_log": 0}
    try:
        fh = open(path, encoding="utf-8")
    except OSError as e:
        raise InputError(f"cannot read {path}: {e.strerror}")
    with fh:
        for n, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError as e:
                raise InputError(f"{path}:{n}: not JSON ({e.msg})")
            arm = r.get("arm")
            if arm not in (patched, control):
                raise InputError(f"{path}:{n}: arm {arm!r} is neither {patched!r} nor {control!r}")
            if not isinstance(r.get("round"), int):
                raise InputError(f"{path}:{n}: missing integer round")
            node = r.get("node")
            if not node:
                raise InputError(f"{path}:{n}: missing node")
            try:
                wall = parse_wall(r["wall_start"])
            except (KeyError, TypeError, ValueError):
                raise InputError(f"{path}:{n}: missing or bad wall_start")
            w = r.get("watch") or {}
            if any(w.get(k) is None for k in ("pod_bound", "pod_ip", "first_byte")):
                skipped["no_first_byte_or_ip"] += 1
                continue
            logs = r.get("logs") or {}
            user = [x for x in (logs.get("user-container") or []) if "t" in x]
            qp = [x for x in (logs.get("queue-proxy") or []) if "t" in x]
            if not user or not qp:
                skipped["no_user_or_queue_proxy_log"] += 1
                continue
            rows.append({
                "arm": arm, "node": node, "round": r["round"], "wall": wall,
                "bound": float(w["pod_bound"]), "uf": float(user[0]["t"]),
                "ip": float(w["pod_ip"]), "fb": float(w["first_byte"]),
            })
    return rows, skipped


def pair_rows(rows, patched, control):
    by_round = {}
    for r in rows:
        by_round.setdefault(r["round"], {}).setdefault(r["arm"], []).append(r)
    pairs, unpaired = [], 0
    for rnd in sorted(by_round):
        p = by_round[rnd].get(patched, [])
        c = by_round[rnd].get(control, [])
        if len(p) == 1 and len(c) == 1:
            pairs.append((p[0], c[0]))
        else:
            unpaired += 1
    return pairs, unpaired


def gate(pairs):
    if len(pairs) < MIN_PAIRS:
        raise SampleError(f"{len(pairs)} complete pairs; the protocol needs at least {MIN_PAIRS}")
    counts = {}
    for p, c in pairs:
        for r in (p, c):
            counts[(r["arm"], r["node"])] = counts.get((r["arm"], r["node"]), 0) + 1
    short = {k: v for k, v in counts.items() if v < MIN_PER_NODE}
    if short:
        worst = min(short, key=short.get)
        raise SampleError(f"{worst[0]} on {worst[1]} has {short[worst]} wakes; need {MIN_PER_NODE} per node")


def lock_scan(ts, lo, hi, steps=2000, refine=100):
    """Best Rayleigh statistic R (0..1) for arrival times ts over periods in [lo, hi], and its period."""
    t0 = min(ts)
    xs = [t - t0 for t in ts]
    n = len(xs)

    def r_at(period):
        w = 2 * math.pi / period
        c = s = 0.0
        for x in xs:
            a = w * x
            c += math.cos(a)
            s += math.sin(a)
        return math.hypot(c, s) / n

    best_r, best_p = -1.0, lo
    for i in range(steps + 1):
        p = lo + (hi - lo) * i / steps
        r = r_at(p)
        if r > best_r:
            best_r, best_p = r, p
    step = (hi - lo) / steps
    for i in range(refine + 1):
        p = best_p - step + 2 * step * i / refine
        r = r_at(p)
        if r > best_r:
            best_r, best_p = r, p
    return best_r, best_p


def lock_test(rows, band, perms, seed):
    """Is there a cycle lock in one group's pod-IP arrivals? Compared with a per-group shuffled null."""
    walls = [r["wall"] for r in rows]
    offs = [r["ip"] / 1000.0 for r in rows]
    obs, period = lock_scan([w + o for w, o in zip(walls, offs)], *band)
    rng = random.Random(seed)
    null = []
    for _ in range(perms):
        sh = offs[:]
        rng.shuffle(sh)
        null.append(lock_scan([w + o for w, o in zip(walls, sh)], *band)[0])
    p95 = pct(null, 0.95)
    p = (1 + sum(1 for v in null if v >= obs)) / (1 + len(null))
    return {"R": obs, "period": period, "null_p95": p95, "p": p, "locked": obs > p95 and p < ALPHA}


def boot_ci(stat, n, boot, seed):
    rng = random.Random(seed)
    vals = [stat([rng.randrange(n) for _ in range(n)]) for _ in range(boot)]
    return pct(vals, 0.025), pct(vals, 0.975)


def fmt_ci(ci):
    return f"[{ci[0]:.0f}, {ci[1]:.0f}]"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("jsonl")
    ap.add_argument("--patched-arm", default="patched")
    ap.add_argument("--control-arm", default="control")
    ap.add_argument("--perms", type=int, default=100)
    ap.add_argument("--boot", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args(argv)
    if args.perms < MIN_PERMS:
        ap.error(f"--perms must be at least {MIN_PERMS} (p < 0.05 is unreachable below that)")
    if args.boot < 100:
        ap.error("--boot must be at least 100")

    try:
        rows, skipped = load_rows(args.jsonl, args.patched_arm, args.control_arm)
    except InputError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    pairs, unpaired = pair_rows(rows, args.patched_arm, args.control_arm)
    try:
        gate(pairs)
    except SampleError as e:
        print(f"refused: {e}. Nothing is judged from this sample.", file=sys.stderr)
        return 3

    pr = [p for p, _ in pairs]
    cr = [c for _, c in pairs]
    pf = [p["fb"] for p in pr]
    cf = [c["fb"] for c in cr]
    n = len(pairs)
    print(f"ceiling analysis: {args.jsonl}")
    print(f"rows read {len(rows)}, skipped {skipped}; pairs {n}, unpaired rounds {unpaired}")
    print(f"gate: pairs >= {MIN_PAIRS} and >= {MIN_PER_NODE} wakes per arm per node, passed")

    groups = {}
    for r in pr + cr:
        groups.setdefault((r["arm"], r["node"]), []).append(r)
    print("\n== cycle lock (arrival = wall_start + pod_ip; per-group shuffled null, "
          f"perms={args.perms}, alpha={ALPHA})")
    print(f"{'arm':9s}{'node':18s}{'band':8s}{'R':>7s}{'period':>10s}{'null_p95':>10s}{'p':>8s}  locked")
    lock_summary = {}
    for (arm, node), rs in sorted(groups.items()):
        t1 = lock_test(rs, BAND_1S, args.perms, args.seed)
        t100 = lock_test(rs, BAND_100MS, args.perms, args.seed)
        # A 1 s lattice has exact sub-harmonics at P/k, and P/10 falls inside the 100 ms band. A
        # 100 ms "lock" that is such a sub-harmonic of a locked 1 s lock is the same lattice, not a new one.
        alias = False
        if t1["locked"] and t100["locked"] and t100["period"] > 0:
            k = round(t1["period"] / t100["period"])
            alias = k >= 1 and abs(t100["period"] * k / t1["period"] - 1) < 0.01
        t100_locked = t100["locked"] and not alias
        for label, t, locked in (("1s", t1, t1["locked"]), ("100ms", t100, t100_locked)):
            lock_summary[(arm, label)] = locked
            note = " (sub-harmonic of the 1s lock)" if (label == "100ms" and alias) else ""
            print(f"{arm:9s}{node:18s}{label:8s}{t['R']:7.3f}{t['period']:10.5f}"
                  f"{t['null_p95']:10.3f}{t['p']:8.3f}  {'yes' if locked else 'no'}{note}")

    print(f"\n== first byte, paired (ms; intervals are {args.boot}-resample bootstraps over pairs)")
    med_p = pct(pf, 0.5)
    med_c = pct(cf, 0.5)
    deltas = [a - b for a, b in zip(pf, cf)]
    ci_med_p = boot_ci(lambda idx: statistics.median(pf[i] for i in idx), n, args.boot, args.seed)
    ci_delta = boot_ci(lambda idx: statistics.median(deltas[i] for i in idx), n, args.boot, args.seed + 1)
    ci_d95 = boot_ci(
        lambda idx: pct([pf[i] for i in idx], 0.95) - pct([cf[i] for i in idx], 0.95),
        n, args.boot, args.seed + 2)
    print(f"{args.patched_arm:9s} median {med_p:7.0f} {fmt_ci(ci_med_p)}   p95 {pct(pf, 0.95):7.0f}")
    print(f"{args.control_arm:9s} median {med_c:7.0f}               p95 {pct(cf, 0.95):7.0f}")
    print(f"paired median delta ({args.patched_arm} - {args.control_arm}): "
          f"{statistics.median(deltas):.0f} {fmt_ci(ci_delta)}")
    print(f"paired p95 delta: {pct(pf, 0.95) - pct(cf, 0.95):.0f} {fmt_ci(ci_d95)}")

    slow_p = [(p["uf"] - p["bound"]) >= SLOW_CUT_MS for p in pr]
    slow_c = [(c["uf"] - c["bound"]) >= SLOW_CUT_MS for c in cr]
    sh_p = sum(slow_p) / n
    sh_c = sum(slow_c) / n
    diff = sh_p - sh_c
    ci_share = boot_ci(
        lambda idx: sum(slow_p[i] for i in idx) / len(idx) - sum(slow_c[i] for i in idx) / len(idx),
        n, args.boot, args.seed + 3)
    if ci_share[0] > 0 or ci_share[1] < 0:
        share_reading = "changed (interval excludes 0)"
    else:
        share_reading = "no detectable change (interval includes 0; this n cannot show equality)"
    print(f"\n== slower cluster (bound -> user first log >= {SLOW_CUT_MS:.0f} ms)")
    print(f"share slow: {args.patched_arm} {sh_p:.3f}, {args.control_arm} {sh_c:.3f}, "
          f"difference {diff:+.3f} [{ci_share[0]:+.3f}, {ci_share[1]:+.3f}] -> {share_reading}")

    print("\n== verdict")
    print(f"goal: median first byte under {GOAL_MS:.0f} ms, judged on the {args.patched_arm} median's "
          "bootstrap 95% interval")
    if ci_med_p[1] < GOAL_MS:
        verdict = "PASS"
    elif ci_med_p[0] > GOAL_MS:
        verdict = "FAIL"
    else:
        verdict = "INCONCLUSIVE"
    print(f"lock: 1s band on {args.control_arm} {'present' if lock_summary.get((args.control_arm, '1s')) else 'absent'}; "
          f"1s band on {args.patched_arm} {'present' if lock_summary.get((args.patched_arm, '1s')) else 'absent'}; "
          f"100ms band on {args.patched_arm} {'present' if lock_summary.get((args.patched_arm, '100ms')) else 'absent'}")
    print(f"VERDICT: {verdict} (patched median {med_p:.0f} ms, interval {fmt_ci(ci_med_p)})")
    if verdict == "FAIL":
        print("report as a floor: under this change the goal is not met on this node; "
              "the patched median is the floor, not a shipped default.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
