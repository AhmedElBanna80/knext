#!/usr/bin/env python3
"""Summarise the scale-out burst A/B JSONL (burst-ab-incluster.py). stdlib only.

    python3 burst-ab-analyze.py <run.jsonl>

BEFORE = imagePrewarm false, AFTER = imagePrewarm true (ImageCacheReady awaited).
Trial metrics: pods started, pods that paid a real kubelet pull, per-pod bound->Ready (apiserver,
1 s resolution), per-pod pull duration, burst request latency (median, p95, max). Paired ABBA
differences per round (AFTER minus BEFORE) with Hodges-Lehmann shift, bootstrap 95% CI and a
Wilcoxon signed-rank p (normal approximation).
"""
import importlib.util
import json
import os
import statistics
import sys
from datetime import datetime

_d = os.path.dirname(os.path.abspath(__file__))
_s = importlib.util.spec_from_file_location("pre", os.path.join(_d, "prepull-ab-analyze.py"))
A = importlib.util.module_from_spec(_s)
_s.loader.exec_module(A)  # q, summary, hodges_lehmann, boot_hl_ci, wilcoxon_p


def t(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def main():
    rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
    trials = {}
    for r in rows:
        ok = ("error" not in r["burst"] and all(x.get("code") == 200 for x in r["burst"]["res"]) and r["pods"]
              and not any(p.get("events_invalid") for p in r["pods"]))
        trials.setdefault(r["arm"], {})[r["round"]] = (r, ok)
    for arm in ("off", "on"):
        tr = trials.get(arm, {})
        print(f"\n== {arm} ({'BEFORE, imagePrewarm off' if arm == 'off' else 'AFTER, imagePrewarm on'}): trials={len(tr)} valid={sum(1 for _, ok in tr.values() if ok)}")
    print("\n== per trial ==")
    print("arm round pods nodes pulled(in-cycle) pull_s[] burst_median_ms burst_max_ms")
    for arm in ("off", "on"):
        for rnd, (r, ok) in sorted(trials.get(arm, {}).items()):
            ms = [x["ms"] for x in r["burst"]["res"] if "ms" in x]
            pods = r["pods"]
            print(arm, rnd, len(pods), sorted(p["node"] for p in pods),
                  sum(p["pulled_in_cycle"] for p in pods),
                  [round(p["pull_duration_s"], 2) for p in pods if p["pull_duration_s"] is not None],
                  round(statistics.median(ms)) if ms else None, round(max(ms)) if ms else None,
                  "" if ok else "INVALID")

    no_count = sum(1 for arm in trials.values() for r, _ in arm.values() for p in r["pods"] if "events_n" not in p)
    if no_count:
        print(f"\nNOTE: {no_count} pod rows carry no events_n; a failed events fetch cannot be ruled out for them.")

    print("\n== pulls by node, and first vs later pod per node (creation order within a trial) ==")
    for arm in ("off", "on"):
        by_node = {}
        first, later, first_rd, later_rd = [], [], [], []
        for rnd, (r, ok) in trials.get(arm, {}).items():
            seen = {}
            for p in sorted(r["pods"], key=lambda p: (p["created"], p["pod"])):
                idx = seen.get(p["node"], 0)
                seen[p["node"]] = idx + 1
                d = by_node.setdefault(p["node"], [0, 0])
                d[1] += 1
                if p["pulled_in_cycle"]:
                    d[0] += 1
                    if p["pull_duration_s"] is not None:
                        (first if idx == 0 else later).append(p["pull_duration_s"] * 1000)
                    b, rd = t(p["scheduled"]), t(p["ready"])
                    if b and rd:
                        (first_rd if idx == 0 else later_rd).append((rd - b).total_seconds())
        print(f"{arm}: pulled/pods by node: " + ", ".join(f"{n}: {a}/{b}" for n, (a, b) in sorted(by_node.items())))
        A.summary(f"  {arm} Pulled event, first pod per node ms", first)
        A.summary(f"  {arm} Pulled event, later pod per node ms", later)
        for lab, xs in (("first", first_rd), ("later", later_rd)):
            if xs:
                print(f"  {arm} bound->Ready, {lab} pulling pod per node: median={statistics.median(xs):.1f} s (n={len(xs)})")

    print("\n== per pod (bound -> Ready, apiserver 1 s resolution) ==")
    per = {"off": {"pulled": [], "cached": []}, "on": {"pulled": [], "cached": []}}
    pulls = {"off": [], "on": []}
    for arm in ("off", "on"):
        for rnd, (r, ok) in trials.get(arm, {}).items():
            for p in r["pods"]:
                b, rd = t(p["scheduled"]), t(p["ready"])
                if b and rd:
                    key = "pulled" if p["pulled_in_cycle"] else "cached"
                    per[arm][key].append((rd - b).total_seconds())
                if p["pull_duration_s"] is not None:
                    pulls[arm].append(p["pull_duration_s"] * 1000)
    for arm in ("off", "on"):
        for key in ("pulled", "cached"):
            xs = per[arm][key]
            if xs:
                print(f"{arm} {key}: n={len(xs)} bound->Ready median={statistics.median(xs):.1f} s "
                      f"p95={A.q(xs, .95):.1f} s")
            else:
                print(f"{arm} {key}: n=0")
    for arm in ("off", "on"):
        A.summary(f"{arm} kubelet pull duration ms", pulls[arm])

    print("\n== arm medians over trials ==")
    for arm in ("off", "on"):
        meds, p95s, maxs, pods = [], [], [], []
        for rnd, (r, ok) in trials.get(arm, {}).items():
            if not ok:
                continue
            ms = [x["ms"] for x in r["burst"]["res"] if "ms" in x]
            meds.append(statistics.median(ms))
            p95s.append(A.q(ms, .95))
            maxs.append(max(ms))
            pods.append(len(r["pods"]))
        if meds:
            A.summary(f"{arm} burst request median ms", meds)
            print(f"  {arm} burst request p95 median={statistics.median(p95s):.0f} ms, "
                  f"max median={statistics.median(maxs):.0f} ms, pods/trial median={statistics.median(pods):.0f}")

    rounds = sorted(set(k for k, (_, ok) in trials.get("off", {}).items() if ok)
                    & set(k for k, (_, ok) in trials.get("on", {}).items() if ok))
    if rounds:
        def med(rnd, arm):
            ms = [x["ms"] for x in trials[arm][rnd][0]["burst"]["res"] if "ms" in x]
            return statistics.median(ms)

        def mx(rnd, arm):
            return max(x["ms"] for x in trials[arm][rnd][0]["burst"]["res"] if "ms" in x)

        for label, fn in (("burst request median", med), ("burst request max", mx)):
            d = [fn(k, "on") - fn(k, "off") for k in rounds]
            lo, hi = A.boot_hl_ci(d)
            print(f"\npaired (n={len(rounds)} rounds) AFTER-BEFORE, {label}: median diff={statistics.median(d):+.0f} ms "
                  f"HL={A.hodges_lehmann(d):+.0f} ms 95% CI(HL)=[{lo:+.0f},{hi:+.0f}] Wilcoxon p={A.wilcoxon_p(d):.3g}")


if __name__ == "__main__":
    main()
