#!/usr/bin/env python3
"""Segment analysis for the cold-start node diagnosis (API + container-log data only).

    python3 node-diagnosis-analyze.py <rows.jsonl> [--json out.json]

Reads the rows written by drive.py / cold-cycle.mjs. Every timestamp here is on the
harness clock (ms after the request), as cold-cycle.mjs writes it. What it does NOT
have: kubelet, CRI-O or journal logs (no host-level access was granted in the run
that produced docs/benchmarks/data/cold-start-node-diagnosis-oke-2026-11-02.jsonl),
so sandbox/CNI/image/container-create sub-splits are not computed here.
"""
import json
import math
import statistics
import sys


def pct(xs, p):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * p / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def summ(name, xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return {"name": name, "n": 0}
    return {
        "name": name,
        "n": len(xs),
        "median": round(statistics.median(xs), 1),
        "p10": round(pct(xs, 10), 1),
        "p90": round(pct(xs, 90), 1),
        "min": round(min(xs), 1),
        "max": round(max(xs), 1),
        "mean": round(statistics.fmean(xs), 1),
    }


def ks_uniform(xs, lo, hi):
    """Two-sided KS statistic of xs against Uniform(lo, hi) and its asymptotic p-value."""
    xs = sorted(x for x in xs if x is not None)
    n = len(xs)
    if n == 0:
        return None
    d = 0.0
    for i, x in enumerate(xs):
        f = min(max((x - lo) / (hi - lo), 0.0), 1.0)
        d = max(d, abs((i + 1) / n - f), abs(f - i / n))
    lam = (math.sqrt(n) + 0.12 + 0.11 / math.sqrt(n)) * d
    p = 2 * sum((-1) ** (k - 1) * math.exp(-2 * k * k * lam * lam) for k in range(1, 101))
    return {"n": n, "D": round(d, 3), "p": round(min(max(p, 0.0), 1.0), 3)}


def ready_in_t(row):
    for e in row.get("logs", {}).get("user-container", []) or []:
        if isinstance(e, dict) and "line" in e and "Ready in" in str(e["line"]):
            return e["t"]
    return None


def first_t(row, container):
    xs = row.get("logs", {}).get(container, []) or []
    for e in xs:
        if isinstance(e, dict) and "t" in e:
            return e["t"]
    return None


def event_count(row, reason, needle=""):
    return sum(
        1
        for e in row.get("events", []) or []
        if isinstance(e, dict) and e.get("reason") == reason and needle in str(e.get("msg", ""))
    )


def main():
    path = sys.argv[1]
    rows = [json.loads(l) for l in open(path) if l.strip()]
    ok = [r for r in rows if "error" not in r and "watch" in r and r.get("code") == 200]

    seg = {k: [] for k in [
        "wake_to_bound", "bound_to_user_log", "bound_to_ready_in", "bound_to_qp_log",
        "ready_in_to_podip", "qp_log_to_podip", "podip_to_ready", "ready_to_first_byte",
        "ready_in_to_ready", "total_first_byte", "bound_to_podip", "user_log_to_qp_log",
        "started_at_to_podip", "bound_to_started_at", "podip_to_app_tcp3000",
    ]}
    ready_in_lines = []
    lag_ready_in_podip, lag_qp_podip = [], []
    readiness_fail_events = []
    for r in ok:
        w = r["watch"]
        bound = w.get("pod_bound")
        ri = ready_in_t(r)
        ul = first_t(r, "user-container")
        ql = first_t(r, "queue-proxy")
        podip = w.get("pod_ip")
        ready = w.get("cond_Ready")
        fb = w.get("first_byte")
        seg["wake_to_bound"].append(bound)
        # startedAt is the container status startedAt (RFC3339, 1 s resolution), re-based.
        sa = (r.get("status") or {}).get("startedAt_user")
        if sa is not None and podip is not None:
            seg["started_at_to_podip"].append(podip - sa)
        if sa is not None and bound is not None:
            seg["bound_to_started_at"].append(sa - bound)
        if w.get("app_tcp_3000") is not None and podip is not None:
            seg["podip_to_app_tcp3000"].append(w["app_tcp_3000"] - podip)
        for e in r.get("logs", {}).get("user-container", []) or []:
            if isinstance(e, dict) and "Ready in" in str(e.get("line", "")):
                ready_in_lines.append(str(e["line"]).strip())
                break
        seg["total_first_byte"].append(fb)
        if bound is not None:
            seg["bound_to_user_log"].append(ul - bound if ul is not None else None)
            seg["bound_to_ready_in"].append(ri - bound if ri is not None else None)
            seg["bound_to_qp_log"].append(ql - bound if ql is not None else None)
        if bound is not None and podip is not None:
            seg["bound_to_podip"].append(podip - bound)
        if ul is not None and ql is not None:
            seg["user_log_to_qp_log"].append(ql - ul)
        if ri is not None and podip is not None:
            seg["ready_in_to_podip"].append(podip - ri)
            lag_ready_in_podip.append(podip - ri)
        if ql is not None and podip is not None:
            seg["qp_log_to_podip"].append(podip - ql)
            lag_qp_podip.append(podip - ql)
        if podip is not None and ready is not None:
            seg["podip_to_ready"].append(ready - podip)
        if ready is not None and fb is not None:
            seg["ready_to_first_byte"].append(fb - ready)
        if ri is not None and ready is not None:
            seg["ready_in_to_ready"].append(ready - ri)
        readiness_fail_events.append(event_count(r, "Unhealthy", "Readiness"))

    ready_in_ms = {}
    for l in ready_in_lines:
        ready_in_ms[l] = ready_in_ms.get(l, 0) + 1
    probe_first_try = sum(1 for r in ok if (r.get("probe_attempts") or {}).get("tcp3000") == 1)
    # Re-basing: every t in the rows is ms after the harness request; container-log times
    # are runtime timestamps shifted by the harness-measured clock offset (row["clock"]).
    out = {
        "ready_in_lines_count": ready_in_ms,
        "harness_tcp3000_first_try": [probe_first_try, len(ok)],
        "clock_offset_ms": summ("clock_offset", [(r.get("clock") or {}).get("offset_ms") for r in ok]),
        "clock_rtt_ms": summ("clock_rtt", [(r.get("clock") or {}).get("rtt_ms") for r in ok]),
        "file": path,
        "rows": len(rows),
        "valid": len(ok),
        "segments": [summ(k, v) for k, v in seg.items()],
        "uniform_test_ready_in_to_podip_U0_1000": ks_uniform(lag_ready_in_podip, 0, 1000),
        "uniform_test_qp_log_to_podip_U0_1000": ks_uniform(lag_qp_podip, 0, 1000),
        "readiness_unhealthy_events_per_wake": summ("unhealthy", readiness_fail_events),
        "wakes_with_readiness_unhealthy": sum(1 for x in readiness_fail_events if x > 0),
    }
    if "--json" in sys.argv:
        json.dump(out, open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=1)
    for s in out["segments"]:
        print(s)
    print("ready_in lines", out["ready_in_lines_count"])
    print("harness tcp3000 first try", out["harness_tcp3000_first_try"])
    print("clock", out["clock_offset_ms"], out["clock_rtt_ms"])
    print("ks ready_in->podIP", out["uniform_test_ready_in_to_podip_U0_1000"])
    print("ks qp_log->podIP", out["uniform_test_qp_log_to_podip_U0_1000"])
    print("unhealthy", out["readiness_unhealthy_events_per_wake"], "wakes with any:", out["wakes_with_readiness_unhealthy"])


if __name__ == "__main__":
    main()
