#!/usr/bin/env python3
"""Per-arm first byte / pod Ready / probe-failure summary for a readiness-probe A/B.

Usage: python3 -I readiness-probe-summary.py <phases.jsonl> <events.json> [<events.json> ...]

phases.jsonl is drive.py output. The events files are
`kubectl get events -n <ns> --watch --output-watch-events -o json` captured while the run was in
progress and/or a `kubectl get events -n <ns> -o json` snapshot (the apiserver keeps events for an
hour, so a snapshot only covers the last hour of a run). Together they supply the kubelet
`Unhealthy` (readiness probe failed) events with their `count`, which cold-cycle.mjs does not
keep (it records one stamp per event, no count).

Per arm it prints n, the median / p95 / max of first byte and of pod Ready (both ms after the
request), how many rows saw Ready inside the harness window, and the failed readiness probes per
wake counted up to the pod's Ready. That count is a lower bound: kubelet stamps events at 1 s
resolution and its 503 event keeps counting through the scale-down, so an event that straddles
Ready counts once. `timeouts` is the kubelet's own 1 s probe timeout. p95 is linear interpolation
between order statistics (the same rule as analyze.py --p95); at small n read it as a tail bound.
"""

import json
import statistics
import sys
from datetime import datetime


def pct(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    if len(xs) == 1:
        return xs[0]
    k = (len(xs) - 1) * q
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def iso(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def load_unhealthy(paths):
    """pod name -> [(first_ts, last_ts, count, message)] for that pod's Unhealthy events.

    kubelet emits one event per distinct message and bumps its count; stamps have 1 s resolution.
    """
    dec = json.JSONDecoder()
    latest = {}
    for path in paths:
        text = open(path).read()
        i = 0
        while i < len(text):
            while i < len(text) and text[i].isspace():
                i += 1
            if i >= len(text):
                break
            obj, i = dec.raw_decode(text, i)
            # a watch stream (one {type, object} per change), a core/v1 List, or one event
            evs = obj["items"] if "items" in obj else [obj.get("object", obj)]
            for ev in evs:
                if ev.get("reason") != "Unhealthy":
                    continue
                uid = ev["metadata"]["uid"]
                # the watch re-sends an event on every count bump: keep the highest count seen
                if uid not in latest or (ev.get("count") or 1) >= (latest[uid].get("count") or 1):
                    latest[uid] = ev
    out = {}
    for ev in latest.values():
        first = ev.get("firstTimestamp") or ev.get("eventTime")
        last = ev.get("lastTimestamp") or first
        out.setdefault(ev["involvedObject"]["name"], []).append(
            (iso(first), iso(last), ev.get("count") or 1, ev.get("message", ""))
        )
    return out


def pre_ready_failures(row, events):
    """(failed probes, kubelet timeouts) up to the pod's Ready; None when Ready was not seen.

    An event whose last stamp is at or before Ready (+1 s for the stamp resolution) counts in
    full. One that straddles Ready counts as 1.
    """
    ready = row["watch"].get("cond_Ready")
    if ready is None:
        return None
    t_ready = iso(row["wall_start"]) + ready / 1000 + 1
    fails = timeouts = 0
    for first, last, count, msg in events:
        n = count if last <= t_ready else (1 if first <= t_ready else 0)
        fails += n
        if "deadline exceeded" in msg:
            timeouts += n
    return fails, timeouts


def fmt(v):
    return "-" if v is None else f"{v:.0f}"


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: readiness-probe-summary.py <phases.jsonl> <events.json> [<events.json> ...]")
    rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
    unhealthy = load_unhealthy(sys.argv[2:])
    arms = list(dict.fromkeys(r["arm"] for r in rows))
    print(
        f"{'arm':<12}{'n':>3} | {'first byte med':>14}{'p95':>7}{'max':>7} | "
        f"{'Ready med':>10}{'p95':>7}{'max':>7}{'seen':>6} | {'Ready-fb med':>12} | "
        f"{'pods w/ pre-Ready fail':>23}{'fails/wake':>11}{'timeouts/wake':>14}"
    )
    for arm in arms:
        rs = [r for r in rows if r["arm"] == arm and not r.get("error") and r.get("code") == 200]
        fb = [r["watch"]["first_byte"] for r in rs if r["watch"].get("first_byte") is not None]
        rdy = [r["watch"]["cond_Ready"] for r in rs if r["watch"].get("cond_Ready") is not None]
        gap = [
            r["watch"]["cond_Ready"] - r["watch"]["first_byte"]
            for r in rs
            if r["watch"].get("cond_Ready") is not None and r["watch"].get("first_byte") is not None
        ]
        pre = [pre_ready_failures(r, unhealthy.get(r["pod"], [])) for r in rs]
        pre = [p for p in pre if p is not None]
        fails = [p[0] for p in pre]
        to = [p[1] for p in pre]
        print(
            f"{arm:<12}{len(rs):>3} | {fmt(statistics.median(fb) if fb else None):>14}"
            f"{fmt(pct(fb, 0.95)):>7}{fmt(max(fb) if fb else None):>7} | "
            f"{fmt(statistics.median(rdy) if rdy else None):>10}{fmt(pct(rdy, 0.95)):>7}"
            f"{fmt(max(rdy) if rdy else None):>7}{len(rdy):>4}/{len(rs):<2}| "
            f"{fmt(statistics.median(gap) if gap else None):>12} | "
            f"{sum(1 for f in fails if f):>19}/{len(pre):<3}{(sum(fails) / len(pre) if pre else 0):>7.2f}"
            f"{(sum(to) / len(pre) if pre else 0):>14.2f}"
        )


if __name__ == "__main__":
    main()
