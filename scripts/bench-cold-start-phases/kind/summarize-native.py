#!/usr/bin/env python3
"""Markdown summary of a native-amd64 kind cold-start run (stdlib only).

    python3 summarize-native.py run.jsonl [arm,arm,...]

One row per arm: wakes written, valid wakes (code 200, no error), wakes whose pod Ready condition
was recorded (`watch.cond_Ready`), wakes with a `Pulling` event (image pull observed, so not 0), and
the median/max request-to-first-byte. Exits 1 when a requested arm has no row, so a lane that woke
nothing cannot print a green-looking table.
"""
import json
import statistics
import sys


def main(argv):
    rows = [json.loads(l) for l in open(argv[1]) if l.strip()]
    arms = argv[2].split(",") if len(argv) > 2 and argv[2] else sorted({r["arm"] for r in rows})
    print("| arm | wakes | valid | Ready recorded | image pulled | first byte median ms | first byte max ms |")
    print("|---|---|---|---|---|---|---|")
    missing = []
    for arm in arms:
        mine = [r for r in rows if r.get("arm") == arm]
        if not mine:
            missing.append(arm)
            print(f"| {arm} | 0 | 0 | 0 | 0 | n/a | n/a |")
            continue
        valid = [r for r in mine if "error" not in r and r.get("code") == 200]
        ready = [r for r in valid if (r.get("watch") or {}).get("cond_Ready") is not None]
        pulled = [r for r in valid if any(e.get("reason") == "Pulling" for e in r.get("events") or [])]
        fb = [r["watch"]["first_byte"] for r in valid if (r.get("watch") or {}).get("first_byte") is not None]
        med = f"{statistics.median(fb):.0f}" if fb else "n/a"
        mx = f"{max(fb):.0f}" if fb else "n/a"
        print(f"| {arm} | {len(mine)} | {len(valid)} | {len(ready)} | {len(pulled)} | {med} | {mx} |")
    if missing:
        print(f"\nno rows for arm(s): {', '.join(missing)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: summarize-native.py run.jsonl [arm,arm,...]")
    sys.exit(main(sys.argv))
