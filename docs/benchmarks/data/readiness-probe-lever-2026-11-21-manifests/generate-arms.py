"""Regenerate the candidate arms of the readiness-probe study from the operator's own render.

    python3 -I generate-arms.py operator-ksvc.json operator-netpol.json <outdir>

operator-ksvc.json is `kubectl get ksvc probe-cur -o json` and operator-netpol.json is
`kubectl get netpol probe-cur-allow-ingress -o json`, both captured from the operator-managed
NextApp. Each arm is that Service's template with a renamed Service and an edited readiness probe,
plus a copy of the operator's ingress NetworkPolicy whose podSelector targets the new Service. The
`fast-*` arms swap the app container for a one-line node:24-alpine HTTP server.

The outputs are the committed `<arm>.json` / `<arm>-netpol.json` files (compare them as parsed
JSON: the committed copies were reformatted by the repo formatter).
"""

import copy
import json
import sys

ksvc_path, netpol_path, out = sys.argv[1:4]
src = json.load(open(ksvc_path))
netpol_src = json.load(open(netpol_path))

PROBES = {"cur": {}, "p1": {"periodSeconds": 1}, "p1t2": {"periodSeconds": 1, "timeoutSeconds": 2}}
ARMS = {
    "pr-clone": ("real", {}),
    "pr-p1": ("real", PROBES["p1"]),
    "pr-p1t2": ("real", PROBES["p1t2"]),
    "fast-cur": ("fast", {}),
    "fast-p1": ("fast", PROBES["p1"]),
    "fast-p1t2": ("fast", PROBES["p1t2"]),
}
FAST_JS = "require('http').createServer((q,s)=>s.end('ok')).listen(3000,'0.0.0.0')"

for name, (kind, probe) in ARMS.items():
    d = copy.deepcopy(src)
    d["metadata"] = {
        "name": name,
        "namespace": "z2",
        "labels": {"app": name, "bench": "readiness-probe-lever"},
    }
    d.pop("status", None)
    tmpl = d["spec"]["template"]
    tmpl["spec"]["serviceAccountName"] = "probe-cur-sa"
    tmpl["metadata"].pop("name", None)
    c = tmpl["spec"]["containers"][0]
    if kind == "fast":
        c["image"] = "node:24-alpine"
        c["command"] = ["node", "-e", FAST_JS]
        c["securityContext"]["runAsUser"] = 1000
        c["resources"] = {
            "limits": {"cpu": "1", "memory": "512Mi"},
            "requests": {"cpu": "250m", "memory": "256Mi"},
        }
    c["readinessProbe"].update(probe)
    json.dump(d, open(f"{out}/{name}.json", "w"), indent=1)
    np = {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": {"name": f"{name}-allow-ingress", "namespace": "z2"},
        "spec": copy.deepcopy(netpol_src["spec"]),
    }
    np["spec"]["podSelector"] = {"matchLabels": {"serving.knative.dev/service": name}}
    json.dump(np, open(f"{out}/{name}-netpol.json", "w"), indent=1)
print("ok", list(ARMS))
