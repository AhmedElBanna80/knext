#!/usr/bin/env python3
"""4-arm interleaved scale-from-zero bench, in-cluster timing.

Each round: wait until every arm has zero pods, then wake each arm once
(order alternates forward / reverse -> ABCD DCBA ...), timing the first GET /
inside the cluster with curl's own %{time_total} (the exec round trip is not
inside the timed interval: the arm is at zero before curl starts, and curl
itself triggers the wake). After each cold request: 5 warm GETs (median).
Then per-pod evidence: node, image-pull event, condition timestamps, and the
Next "Ready in" log line.
"""
import json, subprocess, sys, time, statistics, datetime

CTX = ["kubectl", "--context", "knext-oke-sa", "-n", "bench-cells"]
ARMS = sys.argv[2].split(",")
ROUNDS = int(sys.argv[1])
OUT = sys.argv[3]
PATH = "/"


def kc(args, check=True):
    return subprocess.run(CTX + args, capture_output=True, text=True, check=check).stdout


def pods(arm):
    j = json.loads(kc(["get", "pods", "-l", f"serving.knative.dev/service={arm}", "-o", "json"]))
    return j["items"]


def wait_zero(arms, timeout=900):
    t = time.time()
    while time.time() - t < timeout:
        if all(len(pods(a)) == 0 for a in arms):
            return time.time() - t
        time.sleep(5)
    raise SystemExit("timeout waiting for zero pods")


CURL = ('s=$(date +%s); r=$(curl -s -o /tmp/b -w "%{http_code} %{time_connect} %{time_starttransfer} %{time_total} %{size_download}" '
        'http://{arm}.bench-cells.svc.cluster.local' + PATH + '); e=$(date +%s); m=$(grep -c "items:<!-- -->50\|items:50" /tmp/b || true); echo "$s $e $r ${m:-0}"; head -c 300 /tmp/b > /tmp/head')


def curl(arm):
    out = kc(["exec", "bench-timer13", "--", "sh", "-c", CURL.replace("{arm}", arm)]).split()
    s, e, code, tconn, ttfb, ttot, size, marker = out[:8]
    return dict(start_s=int(s), end_s=int(e), code=int(code), ttfb_ms=round(float(ttfb) * 1000),
                total_ms=round(float(ttot) * 1000), size=int(size), marker=int(marker))


def ts(x):
    return datetime.datetime.strptime(x, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()


def evidence(arm, start_s):
    ps = pods(arm)
    if not ps:
        return {}
    p = ps[0]
    name = p["metadata"]["name"]
    cond = {c["type"]: ts(c["lastTransitionTime"]) for c in p["status"].get("conditions", [])}
    cs = {c["name"]: c for c in p["status"].get("containerStatuses", [])}
    started = cs.get("user-container", {}).get("state", {}).get("running", {}).get("startedAt")
    ev = json.loads(kc(["get", "events", "--field-selector", f"involvedObject.name={name}", "-o", "json"]))
    pulls = [e["message"] for e in ev["items"] if e["reason"] in ("Pulled", "Pulling")]
    logs = kc(["logs", name, "-c", "user-container", "--tail", "80"], check=False)
    ready_line = next((l.strip() for l in logs.splitlines() if "Ready in" in l), "")
    created = ts(p["metadata"]["creationTimestamp"])
    rel = lambda v: None if v is None else round(v - start_s)
    return dict(pod=name, node=p["spec"].get("nodeName"), pulls=pulls, ready_log=ready_line,
                created_s=rel(created), scheduled_s=rel(cond.get("PodScheduled")),
                started_s=rel(ts(started) if started else None), ready_s=rel(cond.get("Ready")))


def main():
    res = []
    with open(OUT, "a") as f:
        for r in range(ROUNDS):
            order = ARMS if r % 2 == 0 else ARMS[::-1]
            waited = wait_zero(ARMS)
            time.sleep(10)  # pods gone; let endpoints settle
            for arm in order:
                if pods(arm):
                    raise SystemExit(f"{arm} not at zero before its cold request")
                cold = curl(arm)
                warm = [curl(arm)["total_ms"] for _ in range(5)]
                row = dict(round=r + 1, arm=arm, order="fwd" if r % 2 == 0 else "rev", waited_s=round(waited),
                           cold=cold, warm_ms=warm, warm_median_ms=statistics.median(warm),
                           ev=evidence(arm, cold["start_s"]))
                res.append(row)
                f.write(json.dumps(row) + "\n"); f.flush()
                print(r + 1, arm, cold["code"], cold["total_ms"], row["warm_median_ms"], row["ev"].get("node"),
                      row["ev"].get("pulls"), cold["marker"], flush=True)


main()
