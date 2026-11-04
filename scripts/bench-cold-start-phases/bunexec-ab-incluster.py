#!/usr/bin/env python3
"""Paired, interleaved (ABBA) scale-from-zero A/B for two NextApps, timed in-cluster.

    python3 bunexec-ab-incluster.py <rounds> <armA> <armB> <out.jsonl>

Each round: wait until BOTH arms have zero pods (+10 s for endpoints to settle), then
wake each arm once with a single in-cluster HTTP GET (`cold`), followed by 5 warm GETs
(`warm`, median reported). Order alternates per round (A,B then B,A), so every arm takes
each slot equally often.

Timing happens inside a long-lived node process in the `agent-<node>` pod that already
runs in the bench namespace (kubectl exec, pods/exec RBAC only; no harness pod is created for
the timed request). `kubectl exec` round trip is outside the timed interval: the node
process measures request-sent -> response-body-complete with process.hrtime.

Per-cycle pod evidence is read back after the cold request: pod name, node, image digest
actually running, creation / container-start / Ready timestamps (apiserver, 1 s
resolution), and the image-pull event text (proves no pull inside the cycle).

Cluster work is a queue of one: never run two drivers at once.
"""
import json
import statistics
import subprocess
import sys
import time

import benchconfig

# Cluster settings come from benchconfig (flag-free here: KNEXT_BENCH_* env or bench-config.json).
CFG = benchconfig.resolve()
NS = CFG["namespace"]
CTX = ["kubectl"] + (["--context", CFG["context"]] if CFG["context"] else []) + (["-n", NS] if NS else [])
AGENTS = CFG["agent_pods"]  # node name -> node-agent pod name
TRANSIENT = ("Unable to connect", "context deadline exceeded", "i/o timeout", "EOF", "connection reset", "TLS handshake")

PROBE_JS = r"""
const http = require('http');
const url = process.env.TARGET;
function get() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const req = http.get(url, { timeout: 120000 }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ code: res.statusCode, ms: ms(), bytes: n }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ error: String(e.message), ms: ms() }));
  });
}
(async () => {
  const cold = await get();
  const warm = [];
  for (let i = 0; i < 5; i++) warm.push(await get());
  console.log(JSON.stringify({ cold, warm }));
})();
"""


def kc(args, check=True, timeout=240, tries=5):
    p = None
    for i in range(tries):
        p = subprocess.run(CTX + args, capture_output=True, text=True, timeout=timeout)
        if p.returncode == 0 or not any(m in p.stderr for m in TRANSIENT):
            break
        time.sleep(3 * (i + 1))
    if check and p.returncode != 0:
        raise subprocess.CalledProcessError(p.returncode, args, p.stdout, p.stderr)
    return p


def pods(arm):
    j = json.loads(kc(["get", "pods", "-l", f"serving.knative.dev/service={arm}", "-o", "json"]).stdout)
    return j["items"]


def wait_zero(arms, timeout=900):
    t = time.time()
    while time.time() - t < timeout:
        if all(len(pods(a)) == 0 for a in arms):
            return round(time.time() - t)
        time.sleep(3)
    raise SystemExit("timeout waiting for zero pods")


def agent_for_node_ip(ip):
    return AGENTS[ip]


def pick_agent():
    """Alternate the probing source across the configured node agents."""
    if not AGENTS:
        raise SystemExit("no node agents configured: set agentPods in the bench config or KNEXT_BENCH_AGENT_PODS")
    agents = [AGENTS[k] for k in sorted(AGENTS)]
    return agents[int(time.time()) % len(agents)]


def probe(arm):
    """Run one cold+warm probe from an in-cluster node agent. Returns (row, t_req_wall)."""
    # spread the probing source across both nodes to avoid a single-node source bias
    agent = pick_agent()
    target = f"http://{arm}.{NS}.svc.cluster.local/"
    t_req = time.time()
    p = kc(["exec", agent, "--", "env", f"TARGET={target}", "node", "-e", PROBE_JS], check=False, timeout=300)
    out = [l for l in p.stdout.splitlines() if l.startswith("{")]
    if not out:
        return {"error": (p.stderr or p.stdout)[-300:], "agent": agent}, t_req
    row = json.loads(out[-1])
    row["agent"] = agent
    return row, t_req


def pod_evidence(arm, t_req):
    items = pods(arm)
    if not items:
        return {"pod": None}
    # the newest pod for the arm (the one this cycle created)
    pod = max(items, key=lambda p: p["metadata"]["creationTimestamp"])
    st = pod["status"]
    conds = {c["type"]: c.get("lastTransitionTime") for c in st.get("conditions", [])}
    cs = (st.get("containerStatuses") or [{}])
    user = next((c for c in cs if c.get("name") == "user-container"), cs[0] if cs else {})
    started = (user.get("state", {}).get("running") or {}).get("startedAt")
    image_id = user.get("imageID", "")
    ev = kc(["get", "events", "--field-selector", f"involvedObject.name={pod['metadata']['name']}", "-o", "json"], check=False)
    pulls = []
    events_invalid = ev.returncode != 0
    events_n = 0
    try:
        items = json.loads(ev.stdout).get("items", [])
        events_n = len(items)
        for e in items:
            if e.get("reason", "").startswith("Pull"):
                pulls.append(e.get("message", "")[:160])
    except json.JSONDecodeError:
        events_invalid = True
    return {
        "pod": pod["metadata"]["name"],
        "node": pod["spec"].get("nodeName"),
        "image_id": image_id,
        "build_id": pod["metadata"].get("labels", {}).get("apps.kn-next.dev/build-id"),
        "created": pod["metadata"]["creationTimestamp"],
        "container_started": started,
        "ready": conds.get("Ready"),
        "pull_events": pulls,
        "events_n": events_n,
        "events_invalid": events_invalid,
    }


def main():
    rounds, arm_a, arm_b, out = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
    arms = [arm_a, arm_b]
    with open(out, "a") as f:
        for r in range(rounds):
            order = arms if r % 2 == 0 else arms[::-1]
            waited = wait_zero(arms)
            time.sleep(10)
            for arm in order:
                if pods(arm):
                    row = {"arm": arm, "round": r + 1, "error": "not at zero before cold request"}
                else:
                    res, t_req = probe(arm)
                    row = {"arm": arm, "round": r + 1, "order": "AB" if order == arms else "BA",
                           "waited_s": waited, "t_req_epoch": round(t_req, 3), **res}
                    row["evidence"] = pod_evidence(arm, t_req)
                f.write(json.dumps(row) + "\n")
                f.flush()
                c = row.get("cold", {})
                print(r + 1, arm, c.get("code"), round(c.get("ms", -1)), row.get("evidence", {}).get("node"),
                      row.get("error", "")[:120], flush=True)


if __name__ == "__main__":
    main()
