#!/usr/bin/env python3
"""Per-arm first byte / pod Ready / probe-failure summary for a readiness-probe A/B.

Usage: python3 -I readiness-probe-summary.py [--baseline=ARM] [--effect-ms=N] [--reps=N]
           <phases.jsonl> <events.json> [<events.json> ...]

phases.jsonl is drive.py output. The events files are
`kubectl get events -n <ns> --watch --output-watch-events -o json` captured while the run was in
progress and/or a `kubectl get events -n <ns> -o json` snapshot (the apiserver keeps events for an
hour, so a snapshot only covers the last hour of a run). They supply the kubelet `Unhealthy`
(readiness probe failed) events with their `count`, which cold-cycle.mjs does not keep (it records
one stamp per event, no count), and, through any other event naming the pod (every pod gets a
`Scheduled`), the proof that the capture saw that pod at all.

A pod the capture never mentions has UNKNOWN failures, not zero: it is left out of the failure
columns and counted in `no events`. An empty capture, or one that mentions none of the pods, is an
error, because "no failures" and "no capture" must not look the same. Every input error (a bad
option, a missing file, an empty or malformed input) prints its message to stderr and exits 2.

Table 1, per arm: n, median / p95 / max of first byte and of pod Ready (ms after the request), how
many rows saw Ready inside the harness window, and the failed readiness probes per wake counted up
to the pod's Ready. That count is a lower bound: kubelet stamps events at 1 s resolution and its
503 event keeps counting through the scale-down, so an event that straddles Ready counts once.
`timeouts` is the kubelet's own 1 s probe timeout. p95 is linear interpolation between order
statistics (the same rule as analyze.py --p95); at small n read it as a tail bound.

Ready timing, per arm (every "k/m" is counted by this tool, so a write-up quotes it instead of
recounting by hand): `Ready>fb` rows whose pod Ready condition came strictly after the first byte;
`eps>fb` rows whose endpoint became ready strictly after the first byte; `Ready>fb+5s` rows where Ready
trailed the first byte by more than 5 s; `qp-fb` the range of the harness's own queue-proxy probe minus
the first byte (ms); `timeout stamp` the range, in seconds after the request, of each pod's first
kubelet probe timeout; `timeout pods`, how many pods have one; and for those pods the gap from that
first timeout to Ready, split at 9 s (`gap>=9s`, what a 10 s kubelet period predicts, vs `gap<9s`).

Table 2, per metric (first byte, Ready), each arm against the baseline arm (default: the first arm
in the file): the difference of medians, the Hodges-Lehmann shift (median of all pairwise
differences), a percentile-bootstrap 95% CI for the difference of medians (seeded, --reps resamples,
default 10000), the two-sided Mann-Whitney p (exact without ties; tie-corrected normal approximation with them), and
whether the CI excludes a shift of +-`--effect-ms` (default 1200, the size the operator's readiness
probe comment cites). The p-values are unadjusted: with several arms and two metrics there are
several tests, so read them as descriptive; a CI that includes zero means "no difference detected
at this n", never "no difference".
"""

import json
import math
import os
import random
import statistics
import sys
from collections import Counter
from datetime import datetime
from functools import lru_cache

REQUIRED_ROW_KEYS = ("arm", "pod", "wall_start", "watch")
EXIT_INPUT_ERROR = 2


def fail(msg):
    """Report an input error on stderr and exit 2 (never 0, and not Python's default 1)."""
    print(msg, file=sys.stderr)
    sys.exit(EXIT_INPUT_ERROR)


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


def hodges_lehmann(a, b):
    """Median of every pairwise b - a: the shift estimate that goes with the Mann-Whitney test."""
    return statistics.median(y - x for x in a for y in b)


def bootstrap_median_diff_ci(a, b, reps=10000, seed=7, level=0.95):
    """(median(b) - median(a), lo, hi): percentile bootstrap CI of the difference of medians.

    Each of a and b is resampled with replacement at its own size; the CI is the (1-level)/2 and
    (1+level)/2 percentiles of the resampled differences. Seeded, so a rerun gives the same CI.
    """
    if not a or not b:
        raise ValueError("bootstrap needs at least one value in each sample")
    rnd = random.Random(seed)
    diffs = sorted(
        statistics.median(rnd.choices(b, k=len(b))) - statistics.median(rnd.choices(a, k=len(a)))
        for _ in range(reps)
    )
    lo = diffs[int(((1 - level) / 2) * reps)]
    hi = diffs[min(reps - 1, int(((1 + level) / 2) * reps))]
    return statistics.median(b) - statistics.median(a), lo, hi


def mann_whitney_p(a, b):
    """Two-sided Mann-Whitney U p-value: exact without ties, tie-corrected normal approximation with them."""
    n, m = len(a), len(b)
    u = sum(1.0 if x > y else 0.5 if x == y else 0.0 for x in a for y in b)
    if len(set(a + b)) < n + m:
        # normal approximation with the standard tie correction to the variance
        N = n + m
        ties = sum(t**3 - t for t in Counter(a + b).values())
        mu, sd = n * m / 2, math.sqrt(n * m / 12 * ((N + 1) - ties / (N * (N - 1))))
        if sd == 0:  # every value equal: no evidence of a difference
            return 1.0
        z = (abs(u - mu) - 0.5) / sd
        return math.erfc(max(z, 0) / math.sqrt(2))

    @lru_cache(maxsize=None)
    def count(i, j, k):  # arrangements of i a's and j b's with U == k
        if k < 0:
            return 0
        if i == 0 or j == 0:
            return 1 if k == 0 else 0
        return count(i - 1, j, k - j) + count(i, j - 1, k)

    low = min(u, n * m - u)
    tail = sum(count(n, m, k) for k in range(int(low) + 1)) / math.comb(n + m, n)
    return min(1.0, 2 * tail)


def load_events(paths):
    """(pod -> [(first_ts, last_ts, count, message)] of Unhealthy events, set of pods seen at all).

    kubelet emits one event per distinct message and bumps its count; stamps have 1 s resolution.
    A watch re-sends an event on every count bump, so the highest count per uid wins.
    """
    dec = json.JSONDecoder()
    latest = {}
    for path in paths:
        try:
            text = open(path).read()
        except OSError as e:
            fail(f"{path}: cannot read ({e.strerror})")
        i = 0
        while i < len(text):
            while i < len(text) and text[i].isspace():
                i += 1
            if i >= len(text):
                break
            try:
                obj, i = dec.raw_decode(text, i)
            except json.JSONDecodeError as e:
                fail(f"{path}: not a JSON events capture ({e})")
            # a watch stream (one {type, object} per change), a core/v1 List, or one event
            evs = obj["items"] if isinstance(obj, dict) and "items" in obj else [obj.get("object", obj)]
            for ev in evs:
                if not (isinstance(ev, dict) and "uid" in ev.get("metadata", {}) and "involvedObject" in ev):
                    continue  # not an event object (e.g. an empty {}): contributes nothing
                uid = ev["metadata"]["uid"]
                if uid not in latest or (ev.get("count") or 1) >= (latest[uid].get("count") or 1):
                    latest[uid] = ev
    seen, out = set(), {}
    for ev in latest.values():
        pod = ev["involvedObject"]["name"]
        seen.add(pod)
        if ev.get("reason") != "Unhealthy":
            continue
        first = ev.get("firstTimestamp") or ev.get("eventTime")
        last = ev.get("lastTimestamp") or first
        out.setdefault(pod, []).append((iso(first), iso(last), ev.get("count") or 1, ev.get("message", "")))
    return out, seen


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
        if "deadline exceeded" in msg or "Timeout exceeded" in msg:
            timeouts += n
    return fails, timeouts


def first_timeout_stamp(events):
    """Earliest stamp (epoch s) among a pod's kubelet probe timeouts, or None."""
    ts = [f for f, _l, _c, msg in events if "deadline exceeded" in msg or "Timeout exceeded" in msg]
    return min(ts) if ts else None


def ready_timing(rs, unhealthy, seen):
    """Counts and ranges behind the "Ready vs first byte" and mechanism statements for one arm.

    Returns a dict; "k/m" pairs are (k, m) tuples. Rows missing a field are left out of that
    field's m, not counted as k.
    """
    w = [r["watch"] for r in rs]

    def after(key):
        both = [x for x in w if x.get(key) is not None and x.get("first_byte") is not None]
        return sum(1 for x in both if x[key] > x["first_byte"]), len(both)

    both = [x for x in w if x.get("cond_Ready") is not None and x.get("first_byte") is not None]
    qp = [x["qp_probe_ok"] - x["first_byte"] for x in w if x.get("qp_probe_ok") is not None and x.get("first_byte") is not None]
    stamps, gaps = [], []
    for r in rs:
        if r["pod"] not in seen:
            continue
        t = first_timeout_stamp(unhealthy.get(r["pod"], []))
        if t is None:
            continue
        t0 = iso(r["wall_start"])
        stamps.append(t - t0)
        if r["watch"].get("cond_Ready") is not None:
            gaps.append(t0 + r["watch"]["cond_Ready"] / 1000 - t)
    return {
        "ready_after_fb": after("cond_Ready"),
        "eps_after_fb": after("eps_ready"),
        "ready_late": (sum(1 for x in both if x["cond_Ready"] - x["first_byte"] > 5000), len(both)),
        "qp": (min(qp), max(qp)) if qp else None,
        "stamps": (min(stamps), max(stamps)) if stamps else None,
        "timeout_pods": len(stamps),
        "gap_ge9": sum(1 for g in gaps if g >= 9),
        "gap_lt9": sum(1 for g in gaps if g < 9),
    }


def fmt(v):
    return "-" if v is None else f"{v:.0f}"


def load_rows(path):
    rows = []
    try:
        f = open(path)
    except OSError as e:
        fail(f"{path}: cannot read ({e.strerror})")
    with f:
        for lineno, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError as e:
                fail(f"{path}:{lineno}: not JSON ({e})")
            missing = [k for k in REQUIRED_ROW_KEYS if k not in r]
            if missing:
                fail(f"{path}:{lineno}: row is missing {', '.join(missing)} (is this drive.py output?)")
            rows.append(r)
    if not rows:
        fail(f"{path}: no rows; an empty phases file is not a result")
    return rows


def usable(rows, arm):
    return [r for r in rows if r["arm"] == arm and not r.get("error") and r.get("code") == 200]


def parse_args(argv):
    opts = {"baseline": None, "effect-ms": 1200.0, "reps": 10000}
    pos = []
    for a in argv:
        if a.startswith("--"):
            k, _, v = a[2:].partition("=")
            if k not in opts or not v:
                fail(f"unknown or valueless option {a}")
            opts[k] = v if k == "baseline" else float(v)
        else:
            pos.append(a)
    if len(pos) < 2:
        fail(
            "usage: readiness-probe-summary.py [--baseline=ARM] [--effect-ms=N] [--reps=N] "
            "<phases.jsonl> <events.json> [<events.json> ...]"
        )
    opts["reps"] = int(opts["reps"])
    return opts, pos


def main():
    opts, pos = parse_args(sys.argv[1:])
    rows = load_rows(pos[0])
    for p in pos[1:]:
        if not os.path.isfile(p):
            fail(f"{p}: events file not found")
    unhealthy, seen = load_events(pos[1:])
    if not seen:
        fail("events capture is empty: no event objects in " + ", ".join(pos[1:]))
    pods = {r["pod"] for r in rows}
    if not pods & seen:
        fail("events capture mentions none of the pods in the phases file; refusing to report 0 failures")
    arms = list(dict.fromkeys(r["arm"] for r in rows))
    print(
        f"{'arm':<12}{'n':>3} | {'first byte med':>14}{'p95':>7}{'max':>7} | "
        f"{'Ready med':>10}{'p95':>7}{'max':>7}{'seen':>6} | {'Ready-fb med':>12} | "
        f"{'pods w/ pre-Ready fail':>23}{'fails/wake':>11}{'timeouts/wake':>14}{'no events':>10}"
    )
    for arm in arms:
        rs = usable(rows, arm)
        fb = [r["watch"]["first_byte"] for r in rs if r["watch"].get("first_byte") is not None]
        rdy = [r["watch"]["cond_Ready"] for r in rs if r["watch"].get("cond_Ready") is not None]
        gap = [
            r["watch"]["cond_Ready"] - r["watch"]["first_byte"]
            for r in rs
            if r["watch"].get("cond_Ready") is not None and r["watch"].get("first_byte") is not None
        ]
        covered = [r for r in rs if r["pod"] in seen]
        pre = [pre_ready_failures(r, unhealthy.get(r["pod"], [])) for r in covered]
        pre = [p for p in pre if p is not None]
        fails = [p[0] for p in pre]
        to = [p[1] for p in pre]
        if pre:
            fcols = (
                f"{sum(1 for f in fails if f):>19}/{len(pre):<3}{sum(fails) / len(pre):>7.2f}"
                f"{sum(to) / len(pre):>14.2f}"
            )
        else:
            fcols = f"{'unknown':>23}{'unknown':>11}{'unknown':>14}"
        print(
            f"{arm:<12}{len(rs):>3} | {fmt(statistics.median(fb) if fb else None):>14}"
            f"{fmt(pct(fb, 0.95)):>7}{fmt(max(fb) if fb else None):>7} | "
            f"{fmt(statistics.median(rdy) if rdy else None):>10}{fmt(pct(rdy, 0.95)):>7}"
            f"{fmt(max(rdy) if rdy else None):>7}{len(rdy):>4}/{len(rs):<2}| "
            f"{fmt(statistics.median(gap) if gap else None):>12} | {fcols}{len(rs) - len(covered):>10}"
        )

    print(
        "\nReady timing per arm "
        "(Ready>fb = pod Ready strictly after first byte; eps>fb = endpoint ready strictly after first byte)"
    )
    print(
        f"{'arm':<12}{'Ready>fb':>9}{'eps>fb':>8}{'Ready>fb+5s':>12}{'qp-fb ms':>16}"
        f"{'timeout stamp s':>17}{'timeout pods':>13}{'gap>=9s':>8}{'gap<9s':>7}"
    )
    for arm in arms:
        t = ready_timing(usable(rows, arm), unhealthy, seen)
        pair = lambda kv: f"{kv[0]}/{kv[1]}"
        rng = lambda x, f: "-" if x is None else f"{f(x[0])}..{f(x[1])}"
        print(
            f"{arm:<12}{pair(t['ready_after_fb']):>9}{pair(t['eps_after_fb']):>8}{pair(t['ready_late']):>12}"
            f"{rng(t['qp'], lambda v: f'{v:.0f}'):>16}{rng(t['stamps'], lambda v: f'{v:.1f}'):>17}"
            f"{t['timeout_pods']:>13}{t['gap_ge9']:>8}{t['gap_lt9']:>7}"
        )
    print(
        "note: `fails/wake` counts an event that straddles Ready once, so a period-1 arm whose 503 event spans "
        "boot and scale-down shows 1.00 with 0 timeouts; that is a counting artefact, not a measured failure."
    )

    base = opts["baseline"] or arms[0]
    if base not in arms:
        fail(f"--baseline={base}: no such arm (arms: {', '.join(arms)})")
    eff = opts["effect-ms"]
    print(
        f"\nvs baseline {base}: candidate minus baseline, ms. CI = {opts['reps']}-resample percentile "
        f"bootstrap 95% of the difference of medians; p = two-sided Mann-Whitney, unadjusted for "
        f"{2 * (len(arms) - 1)} comparisons."
    )
    print(
        f"{'metric':<11}{'arm':<12}{'n':>3}{'median diff':>12}{'HL shift':>9}{'95% CI':>20}{'p':>8}"
        f"  excludes +-{eff:.0f} ms?"
    )
    for key, label in (("first_byte", "first byte"), ("cond_Ready", "Ready")):
        a = [r["watch"][key] for r in usable(rows, base) if r["watch"].get(key) is not None]
        for arm in arms:
            if arm == base:
                continue
            b = [r["watch"][key] for r in usable(rows, arm) if r["watch"].get(key) is not None]
            if not a or not b:
                print(f"{label:<11}{arm:<12}{len(b):>3}  (no values in one of the arms)")
                continue
            d, lo, hi = bootstrap_median_diff_ci(a, b, opts["reps"])
            hl = hodges_lehmann(a, b)
            slower = "slowdown excluded" if hi < eff else "slowdown NOT excluded"
            faster = "speedup excluded" if lo > -eff else "speedup NOT excluded"
            print(
                f"{label:<11}{arm:<12}{len(b):>3}{d:>12.0f}{hl:>9.0f}{f'[{lo:.0f}, {hi:.0f}]':>20}"
                f"{mann_whitney_p(a, b):>8.4f}  {slower}; {faster}"
            )


if __name__ == "__main__":
    main()
