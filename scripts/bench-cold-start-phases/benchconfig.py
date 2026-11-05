"""Cluster-specific settings for the cold-start bench harness, in one place.

Nothing here names a cluster. Every value that differs between clusters (kubectl
context, namespace, harness pod, scratch directory, node -> agent-pod map, label
names) is resolved with this precedence, highest first:

    command-line flag  >  KNEXT_BENCH_* environment variable  >  config file  >  default

The config file is JSON. It is looked up at --config, then $KNEXT_BENCH_CONFIG, then
`bench-config.json` next to this file (git-ignored; copy bench-config.example.json).
"""
import json
import os
import pathlib

HERE = pathlib.Path(__file__).resolve().parent

# setting -> (config-file key, environment variable, default)
SETTINGS = {
    "context": ("context", "KNEXT_BENCH_CONTEXT", None),
    "namespace": ("namespace", "KNEXT_BENCH_NAMESPACE", None),
    "pod": ("harnessPod", "KNEXT_BENCH_POD", "phase-bench"),
    "container": ("harnessContainer", "KNEXT_BENCH_CONTAINER", "harness"),
    "scratch_dir": ("scratchDir", "KNEXT_BENCH_SCRATCH_DIR", "/tmp"),
    "agent_pods": ("agentPods", "KNEXT_BENCH_AGENT_PODS", {}),
    "agent_label": ("agentLabel", "KNEXT_BENCH_AGENT_LABEL", "app=phase-agent"),
    "pool_label": ("nodePoolLabel", "KNEXT_BENCH_POOL_LABEL", "cloud.google.com/gke-nodepool"),
}

# Older name for the harness pod, kept so existing invocations still work.
LEGACY_ENV = {"pod": "PHASE_POD"}


def load_file(path):
    with open(path) as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: config must be a JSON object")
    known = {k for k, _, _ in SETTINGS.values()}
    unknown = sorted(set(data) - known - {"$comment"})
    if unknown:
        raise SystemExit(f"{path}: unknown config key(s) {unknown}; known: {sorted(known)}")
    return data


def _coerce(name, value):
    if name == "agent_pods" and isinstance(value, str):
        value = json.loads(value) if value.strip() else {}
    if name == "agent_pods" and not isinstance(value, dict):
        raise SystemExit("agent-pods must be a JSON object of node name -> agent pod name")
    return value


def resolve(cli=None, env=None, config_path=None):
    """Return {setting: value}. `cli` maps setting names to flag values (None = unset)."""
    cli = cli or {}
    env = os.environ if env is None else env
    path = config_path or env.get("KNEXT_BENCH_CONFIG")
    if path:
        file_cfg = load_file(path)
    elif (HERE / "bench-config.json").exists():
        file_cfg = load_file(HERE / "bench-config.json")
    else:
        file_cfg = {}
    out = {}
    for name, (key, env_name, default) in SETTINGS.items():
        if cli.get(name) is not None:
            value = cli[name]
        elif env.get(env_name):
            value = env[env_name]
        elif LEGACY_ENV.get(name) and env.get(LEGACY_ENV[name]):
            value = env[LEGACY_ENV[name]]
        elif key in file_cfg:
            value = file_cfg[key]
        else:
            value = default
        out[name] = _coerce(name, value)
    return out
