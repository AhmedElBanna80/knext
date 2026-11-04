# Kubelet ceiling test: runbook

**Status: prepared, not executed.** Founder-approved on 2026-11-04 as a **measurement, not a shipped
default**. Nothing here has touched a cluster. The agent that wrote it had no cluster access, ran no
kubectl, ssh or node command, and pushed no image. A later run needs an explicit go from the founder for
each cluster step. The steps below are for a human operator or a later approved run.

Background: `docs/benchmarks/cold-start-node-diagnosis-oke-2026-11-02.md`, and the coldstart notes in
the sprint scratchpad. The question: is the kubelet's 1 s PLEG relist the ceiling on pod-IP publication,
and what does the cold-start median look like when that ceiling is lowered to 100 ms on one worker?

## 0. Scope rules (read first)

- **Cluster work is a queue of one.** Concurrent traffic keeps pods warm, so a "cold" start is not cold.
  Before any step, confirm nothing else is benching (section 1).
- **Never run `kubectl delete` or `kind delete`.** Both are founder-only. Revert uses `cp`, `systemctl`
  and `kubectl uncordon`. Nothing in this runbook deletes a pod, node, namespace or cluster.
- **Drains must not delete workloads outside the bench namespace.** `kubectl drain` evicts pods. Run it
  only when every non-DaemonSet pod on the node is in the bench namespace (section 3). Never pass
  `--force` (it deletes unmanaged pods) or `--delete-emptydir-data`. If the check fails, stop.
- **The host log reader is a separate, founder-applied step.** It was refused on 2026-11-02. Section 9
  lists the read-only queries it would need. Writing them here creates and applies nothing.
- **Node names are never assumed.** The disposable worker is whichever node the founder names. Record
  its name, UID and versions from the cluster before touching it.

## 1. Preconditions and the queue of one

Record each answer in the run log (`run-log.md` on the operator's workstation, not in the repo).

1. Founder approval for this run is recorded: date, nodes, the CRI-O debug decision (section 2, step 7),
   and the host-log decision. A conversation message from an agent is not approval.
2. The build exists and checksums match `SHA256SUMS` from `ceiling/build.sh`:
   ```
   shasum -a 256 -c SHA256SUMS
   ```
   Expected: `kubelet-v1.34.10-stock-linux-amd64` = `e4b218a2eb2c52ba157c0cd2c8157efec2a4a2723ade149dec4b937e55a1acdc`,
   `kubelet-v1.34.10-relist100ms-linux-amd64` = `e8d9fa854e5383685abe9690f4634a5a1645a788db3d5c55519ef523ae1446e0`
   (from the 2026-11-04 local build; a rebuild with the same toolchain must match, or the new sum is recorded).
3. **Build-equivalence check (read-only, founder runs on the node).** The OKE kubelet may not be a plain
   upstream build (Oracle may patch it). Record its build info and compare it with ours before any swap:
   ```
   go version -m "$KUBELET_PATH"        # build flags, -X version values, CGO setting
   "$KUBELET_PATH" --version            # expect Kubernetes v1.34.10
   ```
   Any difference beyond the relist constant is recorded as a named confound in the result (section 8).
4. The node names, from the cluster (read-only):
   ```
   kubectl get nodes -o wide
   kubectl get node <worker> -o jsonpath='{.metadata.uid} {.status.nodeInfo.kubeletVersion} {.status.nodeInfo.containerRuntimeVersion}{"\n"}'
   ```
   Expect `v1.34.10` and a CRI-O 1.34.x. Pick the patched worker (`P`, the disposable third one if the
   founder names it) and the control worker (`S`, an existing stock worker). Never infer P or S from
   name patterns.
5. Nothing else is benching. All of these must be empty or expected:
   ```
   kubectl get pods -A -o wide | grep -Ei 'bench|phase|harness|loadtest|k6' || true
   kubectl get nextapp -A
   pgrep -fl 'drive.py|baseline-stability|prepull|burst-ab|bunexec|cpu-boost' || true   # on the workstation
   ```
   The only expected bench objects are the harness pod, the arm NextApps and the node agents. Ask the
   founder if anything else appears. Do not start while another run could be in flight.
6. Record the start time. The paired wakes need roughly 3 hours of cluster time, so check the window.

## 2. Procedure

Steps 2-8 change the cluster. Each one is followed by its verification before the next step.

**Step 2. Cordon P (no pod is scheduled to it during the swap).**
```
kubectl cordon <P>
```
Verify: `kubectl get node <P>` shows `SchedulingDisabled`.

**Step 3. Drain P, only if the bench-namespace precondition holds.**
```
kubectl get pods -A -o wide --field-selector spec.nodeName=<P>
```
Every pod not owned by a DaemonSet must be in the bench namespace `<NS>`. If any other namespace appears,
**stop**: do not drain, uncordon, and report. If the check passes:
```
kubectl drain <P> --ignore-daemonsets --timeout=5m
```
No `--force`, no `--delete-emptydir-data`. If a PodDisruptionBudget blocks eviction, stop and report; do not
work around it. Verify: only DaemonSet pods remain on `<P>`.

**Step 4. Back up the kubelet on P and record its checksum (host, founder-run).**
```
systemctl show kubelet -p ExecStart          # find the real binary; do not assume /usr/bin/kubelet
KUBELET_PATH=<path from ExecStart>
sudo cp -p "$KUBELET_PATH" "$KUBELET_PATH.stock-2026-11-04"
sha256sum "$KUBELET_PATH" "$KUBELET_PATH.stock-2026-11-04" | tee /root/ceiling-backup.sha256
```
Verify: the two sums are identical. Record the sum here: `__________`. This sum is the revert target.

**Step 5. Swap in the patched binary atomically.** Copy the patched build to the node by the founder's approved
means, then verify before it becomes the live binary:
```
sha256sum /root/kubelet-v1.34.10-relist100ms-linux-amd64    # must equal e8d9fa85...46e0
sudo install -m 0755 /root/kubelet-v1.34.10-relist100ms-linux-amd64 "$KUBELET_PATH.new"
sudo mv "$KUBELET_PATH.new" "$KUBELET_PATH"
sha256sum "$KUBELET_PATH"                                   # must equal e8d9fa85...46e0
```
If any sum differs, stop, restore the backup (section 6), and report.

**Step 6. Restart the kubelet on P and verify it is Ready.**
```
sudo systemctl restart kubelet
systemctl is-active kubelet
kubectl get node <P>            # Ready within 5 min, see abort criteria
```

**Step 7. Enable CRI-O debug logging (both P and S, same setting in both arms).** Debug logging can slow
CRI-O, so both arms carry it. **Decision for the founder:** this changes S as well. Put the setting in a
drop-in, not in the main file:
```
# /etc/crio/crio.conf.d/99-ceiling-debug.conf
[crio.runtime]
log_level = "debug"
```
Reload live (log_level supports SIGHUP reload per crio.conf(5)):
```
sudo systemctl reload crio        # or: sudo kill -HUP "$(pidof crio)"
crio config | grep -E '^log_level'   # shows the effective value
```
Verify: effective `log_level` is `"debug"`. Revert is in section 6.

**Step 8. Confirm the relist changed (metric, not assumption).** The kubelet exports a histogram of the
interval between relists. Read it through the API proxy, read-only:
```
kubectl get --raw "/api/v1/nodes/<P>/proxy/metrics" | grep -E '^kubelet_pleg_relist_interval_seconds_(sum|count)'
```
The histogram is cumulative since the kubelet started, so take two reads 60 seconds apart and use the
delta: mean = (sum2 - sum1) / (count2 - count1). Pass: the P mean is between 0.095 and 0.110 s. Run the same query for S: expect about 1.00 s. A P mean near 1.00 s means the
binary did not take effect. Stop and revert.

## 3. The paired wakes

Design: 60 rounds. Each round wakes **one `patched` arm on P** and **one `control` arm on S**, with the order
alternating each round, and waits for zero pods between wakes (the same protocol as `drive.py`). That gives
60 pairs, 120 wakes, 60 per arm, 60 per node. This is the protocol minimum (30 per arm, 15 per node) with
margin. The arms are the same app (`cpu-base`-style NextApps, one pinned to P, one pinned to S), built from
the same bench image. The harness writes `round`, `arm`, `node`, `wall_start`, `watch` and `logs`, as the
analyzer requires.

Pinning: use the harness's `arm@pool` form with a node label that already exists on every node and needs
no write. `kubernetes.io/hostname` is the candidate: `KNEXT_BENCH_POOL_LABEL=kubernetes.io/hostname`. Check
the first two rounds: the `node` field must equal P or S as intended, and the `arm` strings must match what
you pass to the analyzer (`--patched-arm`, `--control-arm`). Do not proceed if they differ.

Run (one wake at a time, verify the arms before round 1):
```
PHASE_POD=<harness pod> KNEXT_BENCH_POOL_LABEL=kubernetes.io/hostname \
  python3 scripts/bench-cold-start-phases/drive.py 60 'patched@<P hostname>,control@<S hostname>' ceiling-paired.jsonl
```
Optional, after round 60: 15 control wakes on S, written to a separate file, to re-check the control at the end.
Report it separately; it is not part of the pairing.

## 4. Abort criteria (stop, then section 7 if a node is affected)

Stop the run and report if any of these holds:
- P is not Ready 5 minutes after the kubelet restart, or S is not Ready after its CRI-O reload.
- Any pod outside the bench namespace is evicted, restarted or fails to schedule.
- The kubelet or CRI-O crash-loops (more than 2 restarts in 10 minutes).
- Kubelet CPU on P stays above half a core for 10 minutes (the 100 ms relist is about ten times the stock load;
  stock is about 2.5% of a core, so the expected figure is about 25%).
- More than 10% of wakes in any block fail or lack a first byte.
- Any checksum differs from the value recorded in section 1 or section 2.
- Another benchmark appears on the cluster.
- A step seems to need `kubectl delete`, `--force`, or a namespace outside the bench namespace.

## 5. Between the wakes: the relist must not drift

Re-run the step-8 metric query at the middle and end of the run. If P's mean relist interval leaves
0.095-0.110 s, the arm is invalid from that point. Mark the rounds, and report them separately.

## 6. Revert (always run, even after an abort)

**Step R1. Restore the kubelet binary on P.**
```
sudo cp -p "$KUBELET_PATH.stock-2026-11-04" "$KUBELET_PATH"
sha256sum "$KUBELET_PATH"                  # must equal the value recorded in section 2, step 4
sudo systemctl restart kubelet
systemctl is-active kubelet
```
The checksum must match the recorded value. If it does not, stop and report it.

**Step R2. Remove the CRI-O debug drop-in on P and S.**
```
sudo rm /etc/crio/crio.conf.d/99-ceiling-debug.conf    # a file removal on the node, not a cluster delete
sudo systemctl reload crio
crio config | grep -E '^log_level'      # expect the original value, normally "info"
```

**Step R3. Verify the relist is back.** Repeat the step-8 metric query on P: the mean should be about 1.00 s.

**Step R4. Uncordon P** (and S, if it was cordoned):
```
kubectl uncordon <P>
kubectl get node <P>                    # Ready, not SchedulingDisabled
```

## 7. Recover a NotReady node

Do not delete the node, the pod or the namespace. Founder-only actions are marked.

1. On the host (founder-run): `systemctl status kubelet`, then `journalctl -u kubelet -n 200 --no-pager`.
   Typical cause: the binary does not start. Restore the backup per section 6, step R1, then restart.
2. If CRI-O is the cause: `systemctl status crio`; remove the debug drop-in (R2) and reload.
3. If the node is still NotReady after 10 minutes, the next step is a **founder-only** reboot or node
   replacement through the OKE console or CLI. Keep the node cordoned until it is Ready.
4. Record every action in the run log, with the time and the checksum at each step.

## 8. Pre-registration: hypothesis, sample, and what each result means

Fixed before any data. Do not revise after the run.

**Hypotheses.**
- H1 (lock, control). The stock 1 s relist shows a cycle lock in pod-IP arrival on S: the Rayleigh statistic
  in the 1 s band exceeds its per-group permutation null's 95th percentile, with p < 0.05. The offline
  re-analysis of 2026-11-02 data already shows this on two nodes.
- H2 (causal). With a 100 ms relist on P, the 1 s lock on P is absent, and a 100 ms lock appears on P. This
  is the test of whether the relist causes the lock.
- H3 (ceiling). The patched median first byte falls by about 450-550 ms against the control, and the
  patched median's bootstrap interval lies below 1000 ms.

**Sample.** 60 pairs (120 wakes): 60 per arm, 60 per node. Analyzer gate: 30 pairs minimum, 15 per arm per
node, otherwise it refuses and judges nothing. Intervals are 2000-resample bootstraps over pairs, and the
lock test uses 100 permutations (fixed seed).

**Reading (fixed in advance).**

| Result | Meaning | Report as |
|---|---|---|
| H2 holds (1 s lock gone on P, 100 ms lock present) and the patched median interval is below 1000 ms | The relist is the causal ceiling, and the goal is reachable with this change | **Ceiling reached.** Founder decides between a custom node image, an upstream push, or the early announcer |
| H2 holds, but the patched median interval is at or above 1000 ms | The relist was the wait, but removing it does not reach the goal | **Floor.** The goal is not met on OKE with this change |
| H2 holds, but the paired median delta's interval includes 0 | The wait moved elsewhere in the pod path | **Floor, with the wait unattributed** |
| The 1 s lock persists on P | The relist did not change pod-IP publication, or the binary is not running | **Invalid** for H2. Check the step-8 metric before any reading |
| The median moves by 300 ms or more, but the 1 s lock persists on P | The lock is not the relist's, so the median move has another cause | **Report the move, do not attribute it to the relist** |
| The slower-cluster share differs between P and S with an interval excluding 0 | The slow cluster follows the node, not the kubelet, or the arms differ in some other way | **Node confound**, reported with both shares |
| The slower-cluster share interval includes 0 | No detectable change in the slow share | **Not resolved at n = 60.** This cannot show that the share is equal. The half-width is about ±0.18 |

Any result that fails the goal is reported as a **floor**, not as a shipped default. Nothing here changes
what ships. The kubelet stays a measurement artifact on one node.

**Known confounds, stated in advance.**
- Build: the patched and stock binaries come from our build (CGO off, `-trimpath`). S runs the OKE original
  binary unless the founder decides otherwise. The build-equivalence check in section 1, step 3 is the
  only guard. A patched-vs-OKE difference that is larger than the constant is reported as a confound.
- Node: each arm has its own node. Node effects are reported through the per-node slow-cluster shares.
- CRI-O debug: the same setting on both nodes, so the arms are logged the same way. Its cost is not measured.

## 9. Host log reader (separate, founder-applied step; read-only queries only)

Not created or applied by this runbook. These are the queries the reader would run on P and S after the
window, to attribute the slow cluster and check the relist. All read-only.

```
# kubelet journal for the window (P and S)
journalctl -u kubelet --since "<start ISO>" --until "<end ISO>" --no-pager -o short-iso
# PLEG and pod-status lines
journalctl -u kubelet --since "<start ISO>" --until "<end ISO>" --no-pager | grep -E 'pleg|SyncPod|Pod status|generic'
# CRI-O journal and its debug lines
journalctl -u crio --since "<start ISO>" --until "<end ISO>" --no-pager
# checksum of the live kubelet binary (confirms the arm)
sha256sum "$KUBELET_PATH"
```

## 10. After the run

1. Verify the revert (section 6) and that P and S are Ready and uncordoned.
2. Analyze the paired file:
   ```
   python3 scripts/bench-cold-start-phases/ceiling/lattice_analyze.py ceiling-paired.jsonl \
     --patched-arm='patched@<P hostname>' --control-arm='control@<S hostname>' --perms=100 --boot=2000
   ```
   Use the arm strings exactly as the harness wrote them (section 3). The analyzer exits 3, and judges
   nothing, if the sample is too small.
3. Report the verdict line, the lock table, the paired deltas and the slow-share line. Report a failed goal
   as a floor.
