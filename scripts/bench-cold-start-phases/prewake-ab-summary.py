"""Summarise a prewake-ab.sh run: per-arm medians against the cold arm. Usage: prewake-ab-summary.py <jsonl>."""
import json, statistics, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ok = [r for r in rows if r["status"] == "200"]
bad = len(rows) - len(ok)
by = {}
for r in ok:
    by.setdefault(r["arm"], []).append(r["request_ms"])
if "cold" not in by:
    sys.exit("no successful cold cycles; cannot compute relative deltas")
cold = statistics.median(by["cold"])
cmin, cmax = min(by["cold"]), max(by["cold"])
print("arm               n  median_ms  min-max_ms     delta_vs_cold_ms  relative  verdict")
def key(a):
    if a == "cold":
        return (-1, 0)
    kind, lead = a.split("@")
    return (0 if kind == "get" else 1, int(lead))
for arm in sorted(by, key=key):
    v = by[arm]
    m = statistics.median(v)
    # An arm whose whole range overlaps the cold range is not shown to differ from cold.
    verdict = "" if arm == "cold" else ("not distinguishable from cold" if min(v) <= cmax and max(v) >= cmin else "separated from cold")
    print(f"{arm:<16}{len(v):>3}  {m:>9.0f}  {min(v):>5.0f}-{max(v):<5.0f}  {m - cold:>16.0f}  {m / cold:>8.2f}  {verdict}")
if bad:
    print(f"non-200 cycles excluded: {bad}")
print("kind absolute numbers are not OKE numbers; read the relative column.")
