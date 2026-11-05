#!/usr/bin/env python3
"""Balanced cold-start driver for the baseline-stability study.

    python3 baseline-stability-drive.py <rounds> <target,companion> <out.jsonl> [--long=<extra idle s>]

Reuses drive.py's wake()/wait_zero() unchanged (same in-cluster instrument).
Each round wakes the two arms serially, order rotating every round, so the
scheduler's natural spreading puts the target on either node. Wake spacing
alternates in blocks of two rounds between SHORT (the shortest cycle the harness
allows: zero-pod wait + 10 s) and LONG (the same plus --long extra idle seconds),
which keeps spacing orthogonal to the order rotation.

Around every wake it records, from the API only (read-only): a pre-wake and a
post-wake snapshot of both workers from the kubelet summary endpoint (node CPU
usage, CPU/memory pressure-stall averages, per-pod CPU of the busiest pods) and
the pods bound to each node. Nothing is created, patched, scaled or deleted.
"""
import json
import sys
import time

import drive

NODES = sorted(drive.CFG["agent_pods"])  # node names from the configured agent map
NS = drive.CFG["namespace"]


def snap(node):
    try:
        s = json.loads(drive.kc(["get", "--raw", f"/api/v1/nodes/{node}/proxy/stats/summary"], check=False))
        p = json.loads(drive.kc(["get", "pods", "-A", "--field-selector", f"spec.nodeName={node}", "-o", "json"], check=False))
    except Exception as e:  # noqa: BLE001 - record the failure, keep the run going
        return {"error": str(e)[:120]}
    cpu = s["node"]["cpu"]
    running = [(i["metadata"]["namespace"], i["metadata"]["name"]) for i in p["items"]
               if i["status"].get("phase") == "Running"]
    per_pod = sorted(((pp["cpu"].get("usageNanoCores", 0), pp["podRef"]["namespace"] + "/" + pp["podRef"]["name"])
                      for pp in s.get("pods", []) if "cpu" in pp), reverse=True)
    return {
        "t": time.time(),
        "node_cpu_nc": cpu.get("usageNanoCores"),
        "psi_cpu_some_avg10": cpu.get("psi", {}).get("some", {}).get("avg10"),
        "node_mem_ws": s["node"]["memory"].get("workingSetBytes"),
        "n_running": len(running),
        "n_running_bench_cells": sum(1 for ns, _ in running if ns == NS),
        "running_bench_cells": sorted(n for ns, n in running if ns == NS),
        "top_cpu": [[n, c] for c, n in per_pod[:5]],
    }


def snaps():
    return {n: snap(n) for n in NODES}


def main():
    rounds, arms, out = int(sys.argv[1]), sys.argv[2].split(","), sys.argv[3]
    long_extra = int(next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--long=")), "150"))
    drive.install_harness()
    with open(out, "a") as f:
        for r in range(rounds):
            k = r % len(arms)
            order = arms[k:] + arms[:k]
            spacing = "short" if (r // 2) % 2 == 0 else "long"
            waited = drive.wait_zero(arms)
            time.sleep(10 + (long_extra if spacing == "long" else 0))
            for slot, arm in enumerate(order):
                pre = snaps()
                row = drive.wake(arm, False, f"{int(time.time())}-{arm}")
                post = snaps()
                row.update(round=r + 1, slot=slot, order="fwd" if r % 2 == 0 else "rev", waited_s=waited,
                           spacing=spacing, extra_idle_s=long_extra if spacing == "long" else 0,
                           bg_pre=pre, bg_post=post, treatment="none")
                f.write(json.dumps(row) + "\n")
                f.flush()
                w = row.get("watch", {})
                print(r + 1, arm, spacing, row.get("node"), "end", w.get("resp_end"), row.get("error", "")[:80], flush=True)


if __name__ == "__main__":
    main()
