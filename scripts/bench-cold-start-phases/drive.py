#!/usr/bin/env python3
"""Interleaved per-phase cold-start driver (runs on the operator's workstation).

    python3 drive.py <rounds> <arm1,arm2,...> <out.jsonl> [--dns] [--heal=<arm>] [settings]

Each round: wait until EVERY arm has zero pods (+10 s for endpoints to settle),
then wake each arm once, serially, rotating the order by one each round (AB BA
for two arms, ABC BCA CAB for three). One wake = one `cold-cycle.mjs` run inside
the in-cluster harness pod (all timing happens there; the kubectl exec
round trip is outside every timed interval). With --dns, right after the wake
the driver also execs a DNS timing script inside the freshly started app
container (dns-probe.js) — that happens AFTER the measured request completed,
so it never perturbs the cold-start numbers.

With --heal=<arm>, on EVEN rounds that arm gets the "early outbound packet"
treatment: as soon as its new pod reports user-container running, the harness
execs a one-shot DNS lookup inside the container (HEAL=1, see cold-cycle.mjs). The lookup's UDP packet makes
the pod ARP for its gateway, which refreshes the node's neighbour entry for the
pod IP (the stale-ARP hypothesis in the benchmark doc). Odd rounds are the
untreated control, so the treatment alternates ABAB on the same Knative Service.

An arm written `arm@pool` is placed on that node pool: every other pool's nodes
are cordoned for the wake (running pods are untouched; DaemonSets tolerate
cordons) and everything is uncordoned when the run ends. The pool is read from
the node label named by --pool-label.

Settings (cluster-specific; nothing is hard-coded). Precedence: flag, then
KNEXT_BENCH_* environment variable, then the JSON config file, then default.
See benchconfig.py and bench-config.example.json.

    --config=<file>        JSON config file
    --context=<name>       kubectl context (default: kubectl's current context)
    --namespace=<name>     namespace of the arms and the harness pod (default: kubectl's)
    --pod=<name>           harness pod (default phase-bench; PHASE_POD also works)
    --container=<name>     harness container (default harness)
    --scratch-dir=<dir>    scratch directory on the harness pod (default /tmp)
    --agent-pods=<json>    node name -> node-agent pod; default: find the pod
                           labelled --agent-label that runs on the woken pod's node
    --agent-label=<k=v>    node-agent pod label (default app=phase-agent)
    --pool-label=<key>     node label naming the pool, for arm@pool
    --settle=<s>           idle seconds after the zero-pod wait (default 10)
    --poll-interval=<s>    polling interval while waiting (default 3)

Cluster work is a queue of one: never run two drivers at once.
"""
import argparse
import json
import pathlib
import shlex
import subprocess
import sys
import time

import benchconfig

HERE = pathlib.Path(__file__).resolve().parent
DNS_JS = (HERE / "dns-probe.js").read_text()

TRANSIENT = ("Unable to connect", "context deadline exceeded", "i/o timeout", "EOF", "connection reset")

# Resolved from the environment and config file at import so other drivers can
# `import drive` and reuse kc()/wake(); main() re-resolves with the command-line flags.
CFG = {}
BASE = ["kubectl"]  # kubectl + --context (node-level calls)
CTX = ["kubectl"]  # kubectl + --context + -n (namespaced calls)
POD = "phase-bench"
SETTLE = 10
POLL = 3


def configure(cli=None, config_path=None):
    global CFG, BASE, CTX, POD
    CFG = benchconfig.resolve(cli, config_path=config_path)
    BASE = ["kubectl"] + (["--context", CFG["context"]] if CFG["context"] else [])
    CTX = BASE + (["-n", CFG["namespace"]] if CFG["namespace"] else [])
    POD = CFG["pod"]


configure()


def scratch(name):
    return f"{CFG['scratch_dir'].rstrip('/')}/{name}"


def kc(args, check=True, timeout=180, tries=5):
    """kubectl with retries: the workstation's path to the apiserver drops
    connections intermittently. Only the idempotent calls go through here; the
    timed harness exec does not retry (see wake)."""
    for i in range(tries):
        p = subprocess.run(CTX + args, capture_output=True, text=True, timeout=timeout)
        if p.returncode == 0 or not any(m in p.stderr for m in TRANSIENT):
            break
        time.sleep(3 * (i + 1))
    if check and p.returncode != 0:
        raise subprocess.CalledProcessError(p.returncode, args, p.stdout, p.stderr)
    return p.stdout


def install_harness():
    """Copy cold-cycle.mjs onto the harness pod."""
    kc(["cp", str(HERE / "cold-cycle.mjs"), f"{POD}:{scratch('cold-cycle.mjs')}", "-c", CFG["container"]])


def pod_count(arm):
    for _ in range(5):  # tolerate a transient apiserver/kubectl failure
        try:
            j = json.loads(kc(["get", "pods", "-l", f"serving.knative.dev/service={arm}", "-o", "json"]))
            return len(j["items"])
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            time.sleep(2)
    raise SystemExit(f"cannot list pods for {arm}")


def wait_zero(arms, timeout=900):
    t = time.time()
    while time.time() - t < timeout:
        if all(pod_count(a) == 0 for a in arms):
            return round(time.time() - t)
        time.sleep(POLL)
    raise SystemExit("timeout waiting for zero pods")


def wait_zero_or_bound(arm):
    """After a placed wake the pod is already bound (the harness returns after the
    first byte), so the cordon can be changed for the next arm right away; this
    only double-checks that no pod of `arm` is still Pending."""
    j = json.loads(kc(["get", "pods", "-l", f"serving.knative.dev/service={arm}", "-o", "json"]))
    if any(not p["spec"].get("nodeName") for p in j["items"]):
        time.sleep(5)


def dns_probe(arm, runtime):
    j = json.loads(kc(["get", "pods", "-l", f"serving.knative.dev/service={arm}", "-o", "json"]))
    if not j["items"]:
        return {"error": "pod gone"}
    name = j["items"][0]["metadata"]["name"]
    binary = "bun" if runtime == "bun" else "node"
    out = kc(["exec", name, "-c", "user-container", "--", binary, "-e", DNS_JS], check=False)
    try:
        return json.loads(out.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001 - record whatever came back
        return {"error": out[-300:]}


def harness_env(treat, arm):
    """`KEY=value ` prefix for the in-cluster harness command."""
    env = {}
    if treat:
        env["HEAL"] = "1"
        env["HEAL_BIN"] = "bun" if "bun" in arm else "node"
    if CFG["namespace"]:
        env["NS"] = CFG["namespace"]
    if CFG["agent_pods"]:
        env["AGENT_PODS"] = json.dumps(CFG["agent_pods"], separators=(",", ":"))
    env["AGENT_LABEL"] = CFG["agent_label"]
    return "".join(f"{k}={shlex.quote(v)} " for k, v in env.items())


def wake(arm, treat, seq):
    """One harness run, DETACHED inside the harness pod so a dropped
    workstation->apiserver connection cannot lose the cycle: start it with
    nohup, then poll its output file until the JSON line is complete. With
    treat=True the harness itself execs the heal (HEAL=1) — in-cluster, so its
    timing does not depend on the workstation link."""
    out = scratch(f"run-{seq}.json")
    env = harness_env(treat, arm)
    script = scratch("cold-cycle.mjs")
    launch = ["exec", POD, "-c", CFG["container"], "--", "sh", "-c",
              f"[ -e {out} ] || {{ {env}nohup node {script} {arm} > {out} 2>&1 & }}"]
    kc(launch, check=False)  # idempotent: the [ -e ] guard never starts a second run
    t = time.time()
    while time.time() - t < 240:
        time.sleep(POLL)
        raw = kc(["exec", POD, "-c", CFG["container"], "--", "sh", "-c", f"cat {out} 2>/dev/null || echo MISSING"],
                 check=False)
        if "MISSING" in raw and time.time() - t < 30:
            kc(launch, check=False)  # the first launch never reached the pod: re-issue
        lines = [l for l in raw.strip().splitlines() if l.startswith("{")]
        if lines:
            try:
                return json.loads(lines[-1])
            except json.JSONDecodeError:
                pass  # still being written
    return {"arm": arm, "error": "harness produced no result in 240 s"}


POOLS = {}  # pool label value -> node names, filled lazily for `arm@pool` specs


def nodes_by_pool():
    if not POOLS:
        j = json.loads(subprocess.run(BASE + ["get", "nodes", "-o", "json"],
                                      capture_output=True, text=True, check=True).stdout)
        for n in j["items"]:
            pool = n["metadata"]["labels"].get(CFG["pool_label"], "?")
            POOLS.setdefault(pool, []).append(n["metadata"]["name"])
    return POOLS


def place(pool):
    """Make ONLY `pool`'s nodes schedulable for the next wake by cordoning every
    other pool's nodes. `pool=None` uncordons everything."""
    for p, names in nodes_by_pool().items():
        verb = "uncordon" if pool is None or p == pool else "cordon"
        for n in names:
            subprocess.run(BASE + [verb, n], capture_output=True, text=True)


def parse_args(argv):
    ap = argparse.ArgumentParser(prog="drive.py", description="Interleaved per-phase cold-start driver.")
    ap.add_argument("rounds", type=int)
    ap.add_argument("arms", help="comma-separated arms; arm@pool pins an arm to a node pool")
    ap.add_argument("out", help="JSONL output file (appended)")
    ap.add_argument("--dns", action="store_true")
    ap.add_argument("--heal", metavar="ARM")
    ap.add_argument("--config")
    ap.add_argument("--context")
    ap.add_argument("--namespace")
    ap.add_argument("--pod")
    ap.add_argument("--container")
    ap.add_argument("--scratch-dir", dest="scratch_dir")
    ap.add_argument("--agent-pods", dest="agent_pods")
    ap.add_argument("--agent-label", dest="agent_label")
    ap.add_argument("--pool-label", dest="pool_label")
    ap.add_argument("--settle", type=float, default=10)
    ap.add_argument("--poll-interval", dest="poll", type=float, default=3)
    return ap.parse_args(argv)


def main(argv=None):
    global SETTLE, POLL
    a = parse_args(sys.argv[1:] if argv is None else argv)
    cli = {k: getattr(a, k) for k in ("context", "namespace", "pod", "container", "scratch_dir",
                                      "agent_pods", "agent_label", "pool_label")}
    configure(cli, config_path=a.config)
    SETTLE, POLL = a.settle, a.poll
    arms = a.arms.split(",")
    try:
        run(a.rounds, arms, a.out, a.dns, a.heal)
    finally:
        if any("@" in x for x in arms):
            place(None)


def run(rounds, arms, out, do_dns=False, heal_arm=None):
    install_harness()
    with open(out, "a") as f:
        for r in range(rounds):
            # Rotate the order each round (AB BA for two arms; ABC BCA CAB for
            # three), so every arm takes every wake slot equally often. The slot
            # matters: the scheduler places successive wakes on alternating nodes.
            k = r % len(arms)
            order = arms[k:] + arms[:k]
            waited = wait_zero(sorted({x.split("@")[0] for x in arms}))
            time.sleep(SETTLE)
            for spec in order:
                arm, _, pool = spec.partition("@")
                if pool:
                    place(pool)
                treat = arm == heal_arm and r % 2 == 1
                row = wake(arm, treat, f"{int(time.time())}-{arm}")
                if pool:
                    row["arm"] = spec
                    row["pool"] = pool
                    wait_zero_or_bound(arm)
                row.update(round=r + 1, order="fwd" if r % 2 == 0 else "rev", waited_s=waited,
                           treatment="heal" if treat else "none")
                if do_dns and "error" not in row:
                    row["dns"] = dns_probe(arm, "bun" if "bun" in arm else "node")
                f.write(json.dumps(row) + "\n")
                f.flush()
                w = row.get("watch", {})
                print(r + 1, arm, row.get("code"), row.get("node"), "end", w.get("resp_end"),
                      "ready", w.get("cond_Ready"), "qp_ok", w.get("qp_probe_ok"), row.get("error", "")[:120], flush=True)


if __name__ == "__main__":
    main()
