#!/usr/bin/env python3
"""Scale-OUT burst A/B: does a pod that the autoscaler adds on a node without the image pay a pull?

    python3 burst-ab-incluster.py <total_rounds> <out.jsonl>

Arms (NextApps in the bench namespace, same fresh unique-top-layer image per trial, both `build: vinext`):
  pb-off  BEFORE  scaling.imagePrewarm=false  (kubelet pulls on whichever node a pod lands)
  pb-on   AFTER   scaling.imagePrewarm=true   (operator DaemonSet <app>-imgcache pins the image on
                                               every node; the burst waits for ImageCacheReady=True)

Each trial: fresh image pushed -> NextApp patched (image only) -> Ready -> ImageCacheReady (AFTER)
-> zero pods -> one concurrent burst of N requests from an in-cluster node agent. containerConcurrency=1
and maxScale=4 so the burst forces scale-out; the requests queue in the activator while pods start.
Per pod (created during the burst): node, real pull (Pulling event + Pulled duration), PodScheduled
and Ready timestamps (apiserver, 1 s resolution). Per request: client-side latency. Requests cannot be
mapped to pods, so per-pod first-request latency is not reported; the burst latency distribution is.

ABBA: arm order alternates per round. Cluster writes: NextApp CRs, pushes to GHCR, pull pods (from the
prepull driver, used for nothing here). No ksvc patches, no node cordon, no deletes.
Resumable: rounds already present in out.jsonl are skipped.
"""
import importlib.util
import json
import os
import sys
import time

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("prepull_ab", os.path.join(_here, "prepull-ab-incluster.py"))
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)
H = P.H  # bunexec helper: pods, wait_zero, kc

NS = H.NS
ARMS = {"off": "pb-off", "on": "pb-on"}
N_BURST = int(os.environ.get("BURST_N", "12"))
MAX_SCALE = 4
ORDERS = [("off", "on"), ("on", "off")]

BURST_JS = r"""
const http = require('http');
const url = process.env.TARGET; const N = +process.env.N;
function get() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const req = http.get(url, { timeout: 300000 }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ code: res.statusCode, ms: ms(), bytes: n }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ error: String(e.message), ms: ms() }));
  });
}
(async () => {
  const start = Date.now();
  const res = await Promise.all(Array.from({ length: N }, () => get()));
  console.log(JSON.stringify({ start_epoch_ms: start, res }));
})();
"""


def nextapp_body(digest, bid, prewarm):
    return {"spec": {"build": "vinext", "buildId": bid, "env": {"NEXT_DEPLOYMENT_ID": bid},
                     "image": f"{P.REPO}@{digest}", "imagePullSecrets": [{"name": "ghcr-bench"}],
                     "scaling": {"maxScale": MAX_SCALE, "containerConcurrency": 1, "imagePrewarm": prewarm},
                     "selfContained": False}}


def setup():
    for arm, name in ARMS.items():
        obj = {"apiVersion": "apps.kn-next.dev/v1alpha1", "kind": "NextApp",
               "metadata": {"name": name, "namespace": NS, "labels": {"bench": "burst-ab-2026-11-02"}},
               **nextapp_body(P.BASE_DIGEST, "base", arm == "on")}
        P.kube(["apply", "--validate=strict", "-f", "-"], stdin=json.dumps(obj))
    for name in ARMS.values():
        P.wait_ready(name)


def patch(name, digest, bid, prewarm):
    P.kube(["patch", "nextapp", name, "--type", "merge", "-p", json.dumps(nextapp_body(digest, bid, prewarm))])


def wait_imgcache(name, timeout=900):
    t = time.time()
    while time.time() - t < timeout:
        o = P.json.loads(P.kube(["get", "nextapp", name, "-o", "json"]).stdout)
        gen = o["metadata"]["generation"]
        conds = {c["type"]: c for c in o.get("status", {}).get("conditions", [])}
        c = conds.get("ImageCacheReady", {})
        if c.get("status") == "True" and c.get("observedGeneration") == gen:
            return round(time.time() - t)
        time.sleep(3)
    raise RuntimeError(f"{name} ImageCacheReady not True in {timeout}s")


def pods_detail(arm):
    out = []
    for pod in H.pods(arm):
        name = pod["metadata"]["name"]
        st = pod["status"]
        conds = {c["type"]: c.get("lastTransitionTime") for c in st.get("conditions", [])}
        ev = P.kube(["get", "events", "--field-selector", f"involvedObject.name={name}", "-o", "json"], check=False)
        events_invalid = ev.returncode != 0
        try:
            evs = json.loads(ev.stdout or '{"items":[]}')
        except json.JSONDecodeError:
            evs, events_invalid = {"items": []}, True
        pulling = [e.get("firstTimestamp") or e.get("eventTime") for e in evs.get("items", [])
                   if e.get("reason") == "Pulling"]
        dur = None
        for e in evs.get("items", []):
            if e.get("reason") == "Pulled":
                m = P.PULL_DUR.search(e.get("message", ""))
                if m:
                    dur = float(m.group(1)) * (0.001 if m.group(2) == "ms" else 1.0)
        out.append({"pod": name, "node": st.get("hostIP"), "created": pod["metadata"]["creationTimestamp"],
                    "scheduled": conds.get("PodScheduled"), "ready": conds.get("Ready"),
                    "pulled_in_cycle": bool(pulling), "pulling_event": pulling[0] if pulling else None,
                    "pull_duration_s": dur, "events_n": len(evs.get("items", [])),
                    # a failed fetch is not "no pull": the row is marked invalid and the analyzer drops it
                    "events_invalid": events_invalid})
    return out


def burst(arm):
    agent = H.pick_agent()
    target = f"http://{ARMS[arm]}.{NS}.svc.cluster.local/"
    p = H.kc(["exec", agent, "--", "env", f"TARGET={target}", f"N={N_BURST}", "node", "-e", BURST_JS],
             check=False, timeout=900)
    lines = [l for l in p.stdout.splitlines() if l.startswith("{")]
    if not lines:
        return {"error": (p.stderr or p.stdout)[-300:], "agent": agent}
    j = json.loads(lines[-1])
    return {"agent": agent, "start_epoch_ms": j["start_epoch_ms"], "res": j["res"]}


def done_rounds(out):
    if not os.path.exists(out):
        return 0
    return max((json.loads(l).get("round", 0) for l in open(out) if l.strip()), default=0)


def main(total, out):
    setup()
    start = done_rounds(out)
    with open(out, "a") as f:
        for r in range(start + 1, total + 1):
            tag = f"b{r:03d}-{int(time.time()) % 100000}"
            digests = {arm: P.push_tiny(f"pb-{arm}-{tag}", f"B-{arm}-{tag}") for arm in ARMS}
            for order in (ORDERS[0] if r % 2 else ORDERS[1],):
                for arm in order:
                    name = ARMS[arm]
                    patch(name, digests[arm], tag, arm == "on")
                    P.wait_ready(name)
                    img = wait_imgcache(name) if arm == "on" else None
                    H.wait_zero([name])
                    time.sleep(10)
                    res = burst(arm)
                    time.sleep(20)  # let kubelet post the Pulled events of the burst pods
                    row = {"round": r, "tag": tag, "arm": arm, "nextapp": name, "digest": digests[arm],
                           "order": "AB" if order[0] == "off" else "BA", "imgcache_wait_s": img,
                           "burst": res, "pods": pods_detail(name)}
                    f.write(json.dumps(row) + "\n")
                    f.flush()
                    print(r, arm, "codes", [x.get("code") for x in res.get("res", [])][:3], "pods",
                          [(p["node"], p["pulled_in_cycle"], p["pull_duration_s"]) for p in row["pods"]],
                          flush=True)


if __name__ == "__main__":
    main(int(sys.argv[1]), sys.argv[2])
