#!/usr/bin/env python3
"""Pre-pull vs not-pre-pulled scale-from-zero wake, paired per round, timed in-cluster.

    python3 prepull-ab-incluster.py rounds <total_rounds> <out.jsonl>   # main P/U arms
    python3 prepull-ab-incluster.py worst  <total_rounds> <out.jsonl>   # all-layers-new arm W

Arms (NextApps in the bench namespace, all `build: vinext`, same app shape as bx-a):
  pp-p  PULLED    the new image is pulled onto BOTH nodes (throwaway pull pods) before the
                  NextApp is patched to it, so the wake never pulls.
  pp-u  UNPULLED  a fresh image (the known base layers + one tiny unique top layer) is
                  patched in with no pre-pull. The revision's own initial pod pulls it onto
                  ONE node; the scheduler then decides where a wake lands. A wake counts as
                  an unpulled sample only if the kubelet emitted a `Pulling` event for that
                  pod (in-cycle pull). Wakes that land on the node that already has the
                  layer are kept in the JSONL with pulled_in_cycle=false and not used.
  pp-w  WORST     (worst mode) a fresh single flattened layer (every layer new), same
                  retry rule as pp-u.

Each round: build + push images -> pre-pull P -> patch P and U -> wait for NextApp Ready and
zero pods -> wake the arms in ABBA order (U wakes retry up to 3 times until a pull is seen).
Cluster writes are NextApp CRs and pull pods only; nothing is deleted.
Resumable: rounds already present in out.jsonl are skipped.
"""
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import time

import importlib.util

# probe / pods / wait_zero live in the sibling bunexec-ab-incluster.py (hyphenated, so load by path)
_helper_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bunexec-ab-incluster.py")
_spec = importlib.util.spec_from_file_location("bunexec_ab_incluster", _helper_path)
H = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(H)

NS = H.NS
KCTX = H.CTX
REPO = "ghcr.io/getknext-dev/bench-bunexec"
BASE_DIGEST = "sha256:89352fe217ad6ea8597b80607f1fa3f68f4c7c163ce6bc048acc6d382d40acab"
BASE = f"{REPO}@{BASE_DIGEST}"
NODES = sorted(H.AGENTS)  # node names from the configured agent map
SCRATCH = os.environ.get("PREPULL_SCRATCH", H.CFG["scratch_dir"].rstrip("/") + "/prepull")
LABEL_ARGS = ["--label", "dev.knext.app.id=bench-bunexec-e92fcf1e3"]
DEPLOY_ORDER = ["pp-p", "pp-u"]


def sh(cmd, timeout=600, check=True):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f"{cmd[0]} rc={p.returncode}: {p.stderr[-400:]}")
    return p.stdout.strip()


def kube(args, stdin=None, check=True, timeout=240, tries=6):
    for i in range(tries):
        p = subprocess.run(KCTX + args, input=stdin, capture_output=True, text=True, timeout=timeout)
        if p.returncode == 0 or not any(m in p.stderr for m in H.TRANSIENT):
            break
        time.sleep(3 * (i + 1))
    if check and p.returncode != 0:
        raise RuntimeError(f"kubectl {args[:2]} rc={p.returncode}: {p.stderr[-400:]}")
    return p


# ---------- images ----------

def push_tiny(tag, unique):
    """Base layers unchanged; one new top layer with a unique marker file."""
    os.makedirs(SCRATCH, exist_ok=True)
    path = os.path.join(SCRATCH, f"{tag}.tar")
    data = f"prepull bench marker {unique}\n".encode()
    with tarfile.open(path, "w") as t:
        ti = tarfile.TarInfo("app/.prepull-marker")
        ti.size, ti.mode, ti.mtime = len(data), 0o644, int(time.time())
        t.addfile(ti, io.BytesIO(data))
    ref = f"{REPO}:{tag}"
    sh(["crane", "append", "-b", BASE, "-f", path, "-t", ref], timeout=900)
    os.remove(path)
    return sh(["crane", "digest", ref])


def push_flat(tag, unique):
    """Every layer new: the base filesystem flattened into one fresh layer, built with docker
    so the config (cmd, env, user, workdir, labels) and linux/amd64 platform are set."""
    d = os.path.join(SCRATCH, tag)
    os.makedirs(d, exist_ok=True)
    flat = os.path.join(d, "rootfs.tar")
    if not os.path.exists(flat):
        sh(["crane", "export", BASE, flat], timeout=900)
    data = f"prepull worst-case marker {unique}\n".encode()
    with tarfile.open(flat, "a") as t:
        ti = tarfile.TarInfo(f"app/.prepull-marker-{unique}")
        ti.size, ti.mode, ti.mtime = len(data), 0o644, int(time.time())
        t.addfile(ti, io.BytesIO(data))
    with open(os.path.join(d, "Dockerfile"), "w") as f:
        f.write(
            "FROM scratch\nADD rootfs.tar /\n"
            "ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production\n"
            "WORKDIR /app\nUSER 65532:65532\nCMD [\"/app/server\"]\n"
            "LABEL dev.knext.app.id=bench-bunexec-e92fcf1e3 org.opencontainers.image.revision=e92fcf1e3\n"
        )
    sh(["docker", "buildx", "build", "--platform", "linux/amd64", "--provenance=false", "--sbom=false",
        "--push", "-t", f"{REPO}:{tag}", d], timeout=1500)
    os.remove(flat)
    return sh(["crane", "digest", f"{REPO}:{tag}"])


# ---------- pulls ----------

def pull_pod_name(tag, node):
    return f"pp-pull-{tag}-{node.split('.')[-1]}".lower()[:63]


def prepull_on_all_nodes(tag, digest):
    """One pull pod per node, nodeName pinned, command `true` (exits at once)."""
    ref = f"{REPO}@{digest}"
    names = []
    for node in NODES:
        name = pull_pod_name(tag, node)
        pod = {"apiVersion": "v1", "kind": "Pod",
               "metadata": {"name": name, "namespace": NS, "labels": {"bench": "prepull-ab-2026-11-02"}},
               "spec": {"nodeName": node, "restartPolicy": "Never",
                        "imagePullSecrets": [{"name": "ghcr-bench"}],
                        "containers": [{"name": "pull", "image": ref, "command": ["true"]}]}}
        kube(["create", "-f", "-"], stdin=json.dumps(pod))
        names.append(name)
    deadline = time.time() + 600
    phases = {}
    while time.time() < deadline and len(phases) < len(names):
        for n in names:
            if n in phases:
                continue
            ph = json.loads(kube(["get", "pod", n, "-o", "json"]).stdout)["status"].get("phase")
            if ph in ("Succeeded", "Failed"):
                phases[n] = ph
        time.sleep(2)
    bad = {n: p for n, p in phases.items() if p != "Succeeded"}
    if bad or len(phases) < len(names):
        raise RuntimeError(f"pre-pull incomplete: {bad or 'timeout'}")
    return names


# ---------- nextapps ----------

def nextapp_spec(digest, bid):
    return {"build": "vinext", "buildId": bid, "env": {"NEXT_DEPLOYMENT_ID": bid},
            "image": f"{REPO}@{digest}", "imagePullSecrets": [{"name": "ghcr-bench"}],
            "scaling": {"maxScale": 1}, "selfContained": False}


def ensure_nextapp(name, digest, bid):
    obj = {"apiVersion": "apps.kn-next.dev/v1alpha1", "kind": "NextApp",
           "metadata": {"name": name, "namespace": NS, "labels": {"bench": "prepull-ab-2026-11-02"}},
           "spec": nextapp_spec(digest, bid)}
    kube(["apply", "--validate=strict", "-f", "-"], stdin=json.dumps(obj))


def patch_nextapp(name, digest, bid):
    body = json.dumps({"spec": nextapp_spec(digest, bid)})
    kube(["patch", "nextapp", name, "--type", "merge", "-p", body])


def wait_ready(name, timeout=900):
    t = time.time()
    while time.time() - t < timeout:
        o = json.loads(kube(["get", "nextapp", name, "-o", "json"]).stdout)
        gen = o["metadata"]["generation"]
        conds = {c["type"]: c for c in o.get("status", {}).get("conditions", [])}
        r = conds.get("Ready", {})
        if r.get("status") == "True" and r.get("observedGeneration") == gen:
            return round(time.time() - t)
        time.sleep(3)
    raise RuntimeError(f"{name} not Ready in {timeout}s")


# ---------- evidence ----------

PULL_DUR = re.compile(r'"\s+in ([0-9.]+)(ms|s)\b')


def evidence(arm):
    items = H.pods(arm)
    if not items:
        return {"pod": None}
    pod = max(items, key=lambda p: p["metadata"]["creationTimestamp"])
    name = pod["metadata"]["name"]
    st = pod["status"]
    conds = {c["type"]: c.get("lastTransitionTime") for c in st.get("conditions", [])}
    cs = st.get("containerStatuses") or [{}]
    user = next((c for c in cs if c.get("name") == "user-container"), cs[0])
    started = (user.get("state", {}).get("running") or {}).get("startedAt")
    ev = kube(["get", "events", "--field-selector", f"involvedObject.name={name}", "-o", "json"], check=False)
    events_invalid = ev.returncode != 0
    try:
        evs = json.loads(ev.stdout or '{"items":[]}')
    except json.JSONDecodeError:
        evs, events_invalid = {"items": []}, True
    events = [{"reason": e.get("reason"), "msg": e.get("message", "")[:220],
               "first": e.get("firstTimestamp"), "last": e.get("lastTimestamp"), "eventTime": e.get("eventTime")}
              for e in evs.get("items", [])]
    pulling = [e for e in events if e["reason"] == "Pulling"]
    pull_dur = None
    for e in events:
        if e["reason"] == "Pulled":
            m = PULL_DUR.search(e["msg"])
            if m:
                pull_dur = float(m.group(1)) * (0.001 if m.group(2) == "ms" else 1.0)
    return {
        "pod": name,
        "node": st.get("hostIP") or pod["spec"].get("nodeName"),
        "revision": pod["metadata"].get("labels", {}).get("serving.knative.dev/revision"),
        "image_id": user.get("imageID", ""),
        "created": pod["metadata"]["creationTimestamp"],
        "scheduled": conds.get("PodScheduled"),
        "container_started": started,
        "ready": conds.get("Ready"),
        "pulling_event": pulling[0]["first"] if pulling else None,
        "pull_events": events,
        "pulled_in_cycle": bool(pulling),
        "pull_duration_s": pull_dur,
        "events_n": len(events),
        "events_invalid": events_invalid,  # a failed fetch is not "no pull"
    }


def timed_wake(arm, extra):
    row, t_req = H.probe(arm)
    row.update({"arm": arm, "t_req_epoch": round(t_req, 3), **extra})
    row["evidence"] = evidence(arm)
    row["pulled_in_cycle"] = bool(row["evidence"].get("pulled_in_cycle"))
    row["pull_duration_s"] = row["evidence"].get("pull_duration_s")
    return row


def arm_zero(arm):
    H.wait_zero([arm])
    time.sleep(10)


# ---------- rounds ----------

def done_rounds(out):
    if not os.path.exists(out):
        return 0
    rs = [json.loads(l).get("round", 0) for l in open(out) if l.strip()]
    return max(rs, default=0)


def deploy_pulls(digest, timeout=180):
    """Pulls kubelet performed for this digest in this bench namespace. Events outlive the pod
    (they are kept ~1 h), so this works after the revision's initial pod has scaled to zero."""
    deadline = time.time() + timeout
    while True:
        evs = json.loads(kube(["get", "events", "--field-selector", "reason=Pulling", "-o", "json"]).stdout or "{}")
        hits = [e for e in evs.get("items", []) if digest in e.get("message", "")]
        if hits or time.time() > deadline:
            break
        time.sleep(5)
    out = []
    for e in hits:
        pod = e["involvedObject"]["name"]
        pulled = json.loads(kube(["get", "events", "--field-selector",
                                  f"involvedObject.name={pod},reason=Pulled", "-o", "json"]).stdout or "{}")
        dur = None
        for pe in pulled.get("items", []):
            m = PULL_DUR.search(pe.get("message", ""))
            if m:
                dur = float(m.group(1)) * (0.001 if m.group(2) == "ms" else 1.0)
        out.append({"pod": pod, "node": e.get("source", {}).get("host"), "pull_started": e.get("firstTimestamp"),
                    "pull_duration_s": dur})
    return out


def run_main(total, out):
    start = done_rounds(out)
    for name in ("pp-p", "pp-u"):
        ensure_nextapp(name, BASE_DIGEST, "base")
    wait_ready("pp-p")
    wait_ready("pp-u")
    with open(out, "a") as f:
        for r in range(start + 1, total + 1):
            tag = f"r{r:03d}-{int(time.time()) % 100000}"
            p_dig = push_tiny(f"pp-p-{tag}", f"P-{tag}")
            u_dig = push_tiny(f"pp-u-{tag}", f"U-{tag}")
            pre = prepull_on_all_nodes(tag, p_dig)
            patch_nextapp("pp-p", p_dig, tag)
            patch_nextapp("pp-u", u_dig, tag)
            ready_s = [wait_ready("pp-p"), wait_ready("pp-u")]
            dep = {"pp-p": deploy_pulls(p_dig), "pp-u": deploy_pulls(u_dig)}
            f.write(json.dumps({"round": r, "role": "deploy", "tag": tag, "ready_wait_s": ready_s,
                                "prepull_pods": pre, "deploy_pulls": dep}) + "\n")
            f.flush()
            order = DEPLOY_ORDER if r % 2 else DEPLOY_ORDER[::-1]
            rows = []
            for arm in order:
                arm_zero(arm)
                role = "pulled" if arm == "pp-p" else "fresh-cached-or-unpulled"
                rows.append(timed_wake(arm, {"round": r, "role": role, "attempt": 1, "tag": tag,
                                             "digest": p_dig if arm == "pp-p" else u_dig,
                                             "order": "AB" if order[0] == "pp-p" else "BA"}))
            for row in rows:
                f.write(json.dumps(row) + "\n")
            f.flush()
            print(r, [(x["arm"], round(x.get("cold", {}).get("ms", -1)), x["pulled_in_cycle"],
                        x["evidence"].get("node")) for x in rows],
                  "deploy-pull(pp-u):", [(d["node"], d["pull_duration_s"]) for d in dep["pp-u"]], flush=True)


def run_worst(total, out):
    start = done_rounds(out)
    ensure_nextapp("pp-w", BASE_DIGEST, "base")
    wait_ready("pp-w")
    with open(out, "a") as f:
        for r in range(start + 1, total + 1):
            tag = f"w{r:03d}-{int(time.time()) % 100000}"
            dig = push_flat(f"pp-w-{tag}", f"W-{tag}")
            patch_nextapp("pp-w", dig, tag)
            rs = wait_ready("pp-w")
            dep = deploy_pulls(dig)
            f.write(json.dumps({"round": r, "role": "deploy", "tag": tag, "ready_wait_s": [rs],
                                "deploy_pulls": {"pp-w": dep}}) + "\n")
            f.flush()
            arm_zero("pp-w")
            row = timed_wake("pp-w", {"round": r, "role": "all-layers-new", "attempt": 1, "tag": tag,
                                      "digest": dig})
            f.write(json.dumps(row) + "\n")
            f.flush()
            print("w", r, round(row.get("cold", {}).get("ms", -1)), row["pulled_in_cycle"],
                  row["evidence"].get("node"), [(d["node"], d["pull_duration_s"]) for d in dep], flush=True)


if __name__ == "__main__":
    mode, total, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    {"rounds": run_main, "worst": run_worst}[mode](total, out)
