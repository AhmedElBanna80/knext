#!/usr/bin/env python3
"""Summarise paired A/B cold-start JSONL (stdlib only). Usage: analyze_ab.py run.jsonl A B"""
import json
import statistics
import sys

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import stats  # noqa: E402  (repo helper: exact Mann-Whitney, bootstrap CI)

"""Usage: bunexec-ab-analyze.py run.jsonl <armA> <armB>"""
path, A, B = sys.argv[1], sys.argv[2], sys.argv[3]
rows = [json.loads(l) for l in open(path) if l.strip()]
invalid = []
valid = {A: {}, B: {}}
for r in rows:
    arm, rnd = r["arm"], r["round"]
    reason = None
    if "error" in r and "cold" not in r:
        reason = r["error"][:120]
    elif r.get("cold", {}).get("code") != 200:
        reason = f"cold code {r.get('cold', {}).get('code')} {r.get('cold', {}).get('error', '')}"
    elif "error" in r.get("cold", {}):
        reason = "cold error: " + r["cold"]["error"]
    elif any(w.get("code") != 200 for w in r.get("warm", [])):
        reason = "warm non-200"
    elif not r.get("evidence", {}).get("pod"):
        reason = "no pod evidence"
    elif r.get("evidence", {}).get("events_invalid"):
        reason = "events fetch failed (pull unknown)"
    if reason:
        invalid.append((rnd, arm, reason))
        continue
    warm = sorted(w["ms"] for w in r["warm"])
    valid[arm][rnd] = dict(cold=r["cold"]["ms"], warm=statistics.median(warm), ev=r["evidence"], order=r["order"],
                           node=r["evidence"]["node"], image=r["evidence"]["image_id"], build=r["evidence"]["build_id"],
                           pulled=any(p.startswith("Successfully pulled") or ("Pulling image" in p) for p in r["evidence"]["pull_events"]),
                           created=r["evidence"]["created"], started=r["evidence"]["container_started"], ready=r["evidence"]["ready"])


def q(xs, p):
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def hl(a, b):
    d = sorted(x - y for x in a for y in b)
    return statistics.median(d)


def summary(name, xs):
    print(f"{name}: n={len(xs)} median={statistics.median(xs):.0f} IQR=[{q(xs,.25):.0f},{q(xs,.75):.0f}] "
          f"p95={q(xs,.95):.0f} range=[{min(xs):.0f},{max(xs):.0f}] mean={statistics.mean(xs):.0f}")


print(f"rows={len(rows)} invalid={len(invalid)}")
for rnd, arm, reason in invalid:
    print(f"  INVALID round {rnd} {arm}: {reason}")
for arm in (A, B):
    d = valid[arm]
    print(f"{arm}: valid pairs-per-arm n={len(d)}")
    print("  images:", sorted({v['image'] for v in d.values()}), "build ids:", len({v['build'] for v in d.values()}))
    print("  pulls inside cycle:", sum(1 for v in d.values() if v['pulled']))

ra = sorted(set(valid[A]) & set(valid[B]))
print(f"complete rounds (both arms valid): {len(ra)}")
for metric in ("cold", "warm"):
    xa = [valid[A][r][metric] for r in ra]
    xb = [valid[B][r][metric] for r in ra]
    summary(f"{metric} {A}", xa)
    summary(f"{metric} {B}", xb)
    c = stats.compare(xa, xb)
    print(f"  {metric} diff(A-B) median={c['diff']:+.0f} ms  HL={hl(xa, xb):+.0f} ms  "
          f"bootstrap95 CI=[{c['ci'][0]:+.0f},{c['ci'][1]:+.0f}]  MW p={c['p']:.3g}")
# unpaired (all valid) comparison as well
xa_all = [v["cold"] for v in valid[A].values()]
xb_all = [v["cold"] for v in valid[B].values()]
c = stats.compare(xa_all, xb_all)
print(f"cold all-valid: {A} n={c['nA']} med={c['medA']:.0f}  {B} n={c['nB']} med={c['medB']:.0f}  "
      f"diff={c['diff']:+.0f} HL={hl(xa_all, xb_all):+.0f} CI=[{c['ci'][0]:+.0f},{c['ci'][1]:+.0f}] p={c['p']:.3g}")
for arm in (A, B):
    nodes = {}
    for v in valid[arm].values():
        nodes.setdefault(v["node"], []).append(v["cold"])
    for n, xs in sorted(nodes.items()):
        print(f"  {arm} node {n}: n={len(xs)} median={statistics.median(xs):.0f}")
    ordf = {}
    for v in valid[arm].values():
        ordf.setdefault(v["order"], []).append(v["cold"])
    for o, xs in sorted(ordf.items()):
        print(f"  {arm} slot {o}: n={len(xs)} median={statistics.median(xs):.0f}")
