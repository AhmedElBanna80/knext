# Kubelet ceiling test: runbook

**Status: prepared, not executed.** Founder-approved on 2026-11-04 as a **measurement, not a shipped
default**, on these terms: **one existing worker is patched (call it P), the other (S) is the untouched
control**, and the founder applies a host log reader on request. Nothing here has touched a cluster. The
agent that wrote it had no cluster access, ran no kubectl, ssh or node command, and pushed no image.
Every cluster step needs the founder's explicit go. The steps are for a human operator.

Background: `docs/benchmarks/cold-start-node-diagnosis-oke-2026-11-02.md`. The question: is the kubelet's
1 s PLEG relist the wait between the queue-proxy starting and the pod IP reaching the API, and what does the
cold-start median look like when the relist is 100 ms on one worker?

## 0. Scope rules (read first)

- **Cluster work is a queue of one.** Concurrent traffic keeps pods warm, so a "cold" start is not cold.
- **Never run `kubectl delete`, `kind delete`, `kubectl drain` or `--force`.** Deleting is founder-only. This
  runbook cordons and uncordons, restarts a service on a node, and removes files on a node. It never removes
  a pod, node, namespace or cluster.
- **Cordon only, no drain.** P keeps the pods it already runs (Knative components, CoreDNS and the like).
  Section 2 says what a kubelet restart does to them, and what is claimed from memory.
- **Node names are never assumed.** Record the name, UID and versions of P and S from the cluster first.
- **The host log reader is a separate, founder-applied step** (section 12). Nothing here applies it.
- **Claims marked "(from memory, verify)" have not been checked** against a running system. The kind
  rehearsal (section 3) is where they get checked, and it is a required step.

## 1. Decisions, and what needs founder approval beyond one patched worker

Record each in the run log (a file on the operator's workstation, not in the repo). A conversation message
from an agent is not approval.

| # | Step | Why it needs its own approval |
|---|---|---|
| A1 | **Our own stock build runs on P** (blocks b2 and b4) | The founder approved the patched build on P. The stock build is a second binary, built by us, with the same toolchain and flags and no patch. Without it the OKE-versus-patched difference mixes the constant with the build |
| A2 | **The timed auto-revert** (a transient systemd timer, section 4) | A unit that restarts the kubelet on its own, on a clock |
| A3 | **Staging directory and the volatile drop-in on P** (`/var/lib/ceiling`, `/run/systemd/system/kubelet.service.d`) | Files on the node; the drop-in changes what systemd starts |
| A4 | **An OCI serial console connection to P**, and the SSH path | A cloud resource, and a login route into the node |
| A5 | **CRI-O debug logging on P**, final block only (section 11) | Changes P's runtime config; a drop-in under `/etc/crio` |
| A6 | **The kind rehearsal cluster** (section 3) | Created on the workstation; deleting it is `kind delete`, founder-only |
| A7 | The host log reader (section 12) | Refused once already; founder-applied only |

## 2. Design, node roles, and what a kubelet restart does

- **P** is the patched worker. It runs six blocks of 30 pairs, **in this order**: `b1` OKE original, `b2` our
  stock build, `b3` relist100, `b4` our stock build, `b5` relist100, `b6` OKE original. Stock versus
  relist100 isolates the constant. OKE versus our stock build measures the build. The final OKE block checks
  carryover from the swaps. Node and treatment are no longer aliased: P sees all three.
- **S** stays on its OKE binary, untouched, with no debug logging, in every block. It is the concurrent drift
  control. A pair is one wake on P and one on S in the same round, 60 s apart.
- **Primary hypothesis: the wait.** The wait is the pod IP time minus the queue-proxy's first log, per wake.
  Under the stock relist it is spread over about 0-1000 ms. With a 100 ms relist it should fall to about
  150 ms or less. It is judged as a **difference in differences against S**. The cycle lock is secondary.
- **Placement.** The harness pod runs on **S**, not P: P's kubelet is restarted four times and a harness on
  it would be disturbed. Confirm with `kubectl get pod <harness> -o wide`. If it is on P, **stop**: moving it
  needs a delete, which is founder-only. **Network asymmetry, stated:** harness-to-pod traffic is same-node
  for S wakes and cross-node for P wakes, so first byte carries a small constant offset between arms. It is
  the same in every block, so it cancels in the difference in differences; it does not affect the wait,
  which is read from timestamps taken on the pod's own node and rebased by the clock offset.
- **The two arms are two NextApps** (`ceil-p`, `ceil-s`) with identical specs, because one app cannot be woken
  twice in a round without waiting for zero pods between. Arm identity is therefore aliased with node. That
  is acceptable: the contrast that matters, relist100 against stock, is within P.
- **Pinning uses cordons, restored exactly.** The operator's NextApp has no node selector, so a wake is placed
  by cordoning the other node for the duration of the wake. `drive.py --place-mode=restore` does this and
  never leaves a cordon changed: it snapshots every cordon first, closes the other node, opens the woken
  one, and after every wake and at the end puts every node **back to the snapshot**. P is cordoned by the
  founder before the run, so P stays cordoned except during its own wake. It refuses to start if any node
  outside the two pools is schedulable, and it aborts on any refused cordon.
- **What this cannot guarantee.** During a P wake, S is cordoned, so any pod scheduled anywhere in the cluster
  in that window lands on P. Nothing in the NextApp lets us avoid that. The harness lists, after each wake,
  pods that appeared on the woken node and are not the arm, a DaemonSet pod or already there
  (`foreign_new_pods`). **Any entry on P is an abort.** A hard guarantee would need a node selector in the
  operator, which is out of scope here.
- **What a kubelet restart does to running pods (from memory, verify in the rehearsal).** The container
  runtime owns the containers, so they keep running; the kubelet re-adopts them on start. Pods are not
  restarted unless the kubelet computes a different container hash, which is why the version must match and
  the rehearsal compares `restartCount` and container IDs before and after. While the kubelet is down, no
  status is reported; a restart of a few seconds is under the node-monitor grace period (about 40-50 s), so
  the node should not go NotReady. If it did, pods without their own tolerations would be evicted after 300 s
  (the default not-ready toleration), which is why section 7 reverts after 2 minutes, not 5.
  The 100 ms relist costs about ten times the kubelet CPU (about 25% of a core instead of 2.5%).
- **p95 is descriptive.** At 60 pairs per treatment the tail is too thin to judge; the analyzer prints it
  with that sentence and gives no interval for it.

## 3. Kind rehearsal of swap, revert and the CGO-off binary (REQUIRED, NOT YET DONE)

No cluster step runs before this is done and recorded. Nothing in this section has been executed.

1. Create a throwaway kind cluster with a name that cannot be mistaken for another (A6). Build for the
   cluster's architecture: `KUBELET_CEILING_GOARCH=arm64 scripts/bench-cold-start-phases/ceiling/build.sh`
   on Apple Silicon, or use an amd64 node image. **Starting the CGO-off binary is the first thing to
   check: it has never been started.** Record whether it starts and reports Ready on a kind node, and on
   which kubelet version the node image runs (it must be v1.34.x for the comparison to mean anything).
2. Deploy a small workload on the kind worker. Record container IDs and `restartCount`.
3. Do the exact production procedure (sections 5 and 8) inside the kind node with `docker exec` standing in
   for SSH: stage the binaries with `install`, write the volatile drop-in, restart, hash
   `/proc/<pid>/exe`, revert, hash again. Confirm the workload's container IDs and `restartCount` did not
   change across a restart, and record how long the node took to return to Ready.
4. **Failure drills.** (a) Point the drop-in at a binary that exits at once; confirm the node goes NotReady and
   `/var/lib/ceiling/revert.sh` brings it back with no kubelet. (b) Arm the timed auto-revert for 60 s and
   confirm it fires and the node is stock again. (c) Restart the kind node container (`docker restart`) with
   the drop-in in place and confirm the stock kubelet starts: `/run` is memory, so the drop-in is gone.
5. Read `kubelet_pleg_relist_interval_seconds` before and after, confirming mean 1.0 s versus 0.1 s.
6. **Not rehearsable on kind, so unverified until a real node:** CRI-O (kind uses containerd), SELinux labels
   and the OKE unit file, the OKE kubelet being a plain upstream build, a real reboot, the OCI console.

## 4. Preconditions

1. Section 1 approvals (A1-A6) and the rehearsal (section 3) recorded, with dates.
2. Builds exist and match. From the build output directory:
   ```
   shasum -a 256 -c SHA256SUMS
   ```
   Recorded from the 2026-11-04 local build with go1.25.12: `kubelet-v1.34.10-stock-linux-amd64` =
   `e4b218a2eb2c52ba157c0cd2c8157efec2a4a2723ade149dec4b937e55a1acdc`,
   `kubelet-v1.34.10-relist100ms-linux-amd64` =
   `e8d9fa854e5383685abe9690f4634a5a1645a788db3d5c55519ef523ae1446e0`. A rebuild must match, or the new sum is
   recorded before anything else. Not re-verified by the agent that wrote this.
3. Nodes, from the cluster (read-only):
   ```
   kubectl get nodes -o wide
   kubectl get node <P> -o jsonpath='{.metadata.uid} {.status.nodeInfo.kubeletVersion} {.status.nodeInfo.containerRuntimeVersion}{"\n"}'
   kubectl get node <S> -o jsonpath='{.metadata.uid} {.status.nodeInfo.kubeletVersion} {.status.nodeInfo.containerRuntimeVersion}{"\n"}'
   kubectl get nodes -o custom-columns=NAME:.metadata.name,UNSCHEDULABLE:.spec.unschedulable
   ```
   Expect `v1.34.10` on both and a CRI-O 1.34.x. Record each node's current **UNSCHEDULABLE** state: that is
   the state the revert restores. **Stop if any node other than P and S exists and is schedulable**
   (`drive.py` would refuse, correctly). The founder names P and S; never infer them from name patterns.
4. Harness pod on S (section 2): `kubectl get pod <harness> -o wide`. The node-agent pods that give the clock
   offset must exist on both nodes (`kubectl get pods -A -o wide | grep agent`).
5. **The image is on both nodes.** The first wake after a missing image includes a pull. Check on each node
   over SSH (authoritative): `sudo crictl images --digests | grep <digest from the NextApp spec.image>`.
   The API view `kubectl get node <n> -o jsonpath='{.status.images[*].names}'` is a quick look only: the
   kubelet reports at most 50 images, so absence there proves nothing. If missing, do two unrecorded wakes
   per arm first and re-check.
6. Nothing else is benching:
   ```
   kubectl get pods -A -o wide | grep -Ei 'bench|phase|harness|loadtest|k6' || true
   kubectl get nextapp -A
   pgrep -fl 'drive.py|baseline-stability|prepull|burst-ab|bunexec|cpu-boost' || true   # on the workstation
   ```
   Expected: the harness pod, `ceil-p`, `ceil-s` and the node agents. Ask the founder about anything else.
7. **A tested access path to P before any swap (A4).** All of these, recorded:
   - SSH to P with sudo: `ssh <user>@<P address> 'sudo -n true && echo ok'`. Keep **a second SSH session open**
     for the whole run.
   - An **OCI serial console connection to P is created and a login prompt reached** (the route that works
     when the network or sshd is down). The OCI steps are per the OCI documentation; verify them, they were
     not run.
   - **The recovery route does not rely on the kubelet.** `kubectl debug node` needs a working kubelet and
     leaves a pod behind that only the founder can delete, so it is not used.
8. **Build equivalence, off the node.** Copy the OKE kubelet off P and inspect the copy on the workstation,
   which has Go (a node has none, so `go version -m` is not run there):
   ```
   ssh <user>@<P address> 'systemctl show kubelet -p ExecStart'      # read the real binary path
   scp <user>@<P address>:<path from ExecStart> ./oke-kubelet         # read-only copy; also an off-node backup
   shasum -a 256 ./oke-kubelet
   go version -m ./oke-kubelet                                         # build flags, -X version values, CGO setting
   go version -m <build dir>/kubelet-v1.34.10-stock-linux-amd64
   file ./oke-kubelet                                                  # statically or dynamically linked
   ./oke-kubelet --version                                             # on a linux host; expect Kubernetes v1.34.10
   ```
   Any difference beyond the relist constant (CGO, flags, `-X` values, a vendor patch) is named as a confound
   in the result. The `oke` blocks and the `stock` blocks exist to measure it.
9. Record the start time. Six blocks need about 4 hours of cluster time, plus the restarts.

## 5. On P: define the variables, stage the binaries, arm the net (founder-run, over SSH)

Define the variables first; every later command uses them. Run the whole section in one shell on P.

```
sudo systemctl cat kubelet                        # the whole unit including drop-ins; read it
sudo systemctl show kubelet -p ExecStart -p FragmentPath -p DropInPaths
KP=<the path= value of ExecStart, the real binary>
sudo head -c 4 "$KP" | od -An -c                  # expect: 177   E   L   F
sudo sha256sum "$KP"                              # the original; must equal the off-node copy's sum. Record it
```
**Stop conditions.** Stop and report if any is true: `ExecStart` is a shell script or wrapper (the first four
bytes are not `ELF`); `ExecStart` runs more than one command; the unit already has a drop-in that sets
`ExecStart`; `findmnt -T /var/lib -o OPTIONS` shows `noexec`; SELinux is enforcing (`getenforce`) and the
staged binary's label (`ls -Z`) differs from `$KP`'s (fix with `restorecon`, founder's call).

Stage (copy by the founder's approved means; the sums are the control):
```
sudo install -d -m 0700 /var/lib/ceiling
sudo install -m 0755 <stock file>     /var/lib/ceiling/kubelet-stock
sudo install -m 0755 <relist100 file> /var/lib/ceiling/kubelet-relist100
sudo sha256sum /var/lib/ceiling/kubelet-stock /var/lib/ceiling/kubelet-relist100   # equal the SHA256SUMS values
```
**No file at `$KP` is ever overwritten.** The test binaries live under `/var/lib/ceiling`, and a block is
selected by a **volatile drop-in under `/run`**, which is memory. This avoids two traps: `cp` over a running
binary fails with ETXTBSY, and a replaced `$KP` would survive a reboot as a bad binary. Here a reboot, or
removing the drop-in, gives back the untouched OKE binary.

The drop-in repeats `ExecStart` with the binary replaced and the arguments verbatim (copy them from
`systemctl cat`, do not retype):
```
# /run/systemd/system/kubelet.service.d/99-ceiling.conf
[Service]
ExecStart=
ExecStart=/var/lib/ceiling/kubelet-<stock|relist100> <every argument of the original ExecStart, unchanged>
```
Write it with `sudo install -d /run/systemd/system/kubelet.service.d` and `sudo tee`; the `oke` blocks have
**no** drop-in.

The revert script, also staged now (it works with the kubelet down, and is safe to run twice):
```
sudo tee /var/lib/ceiling/revert.sh >/dev/null <<'EOF'
#!/bin/sh
rm -f /run/systemd/system/kubelet.service.d/99-ceiling.conf
systemctl daemon-reload
systemctl restart kubelet
EOF
sudo chmod 0700 /var/lib/ceiling/revert.sh
```

**Timed auto-revert (A2), armed before the first swap and re-armed at the start of every block.** If the
operator or the workstation vanishes, P returns to the OKE binary by itself:
```
sudo systemctl stop ceiling-revert.timer 2>/dev/null || true
sudo systemd-run --unit=ceiling-revert --on-active=60m /var/lib/ceiling/revert.sh
systemctl list-timers ceiling-revert.timer
```
A block is about 35 minutes, so 60 minutes covers a block plus its checks. The timer is transient (memory), so
it does not survive a reboot, and does not need to: the drop-in does not either. **If the timer fires during
a block, the rest of that block ran on the OKE kubelet.** Check `systemctl list-timers` and the exe hash
(step 3 below) at the end of every block; a block where it fired is discarded.

## 6. The block loop (founder-run on P; the workstation runs the harness)

Before block 1: the founder cordons P (`kubectl cordon <P>`; verify `SchedulingDisabled`). Do not drain.

For each block `bK` with its kubelet `X` (oke, stock, relist100, stock, relist100, oke):

1. **Re-arm the auto-revert** (section 5).
2. **Select X.** `oke`: remove the drop-in if present. `stock`/`relist100`: write it. Then
   ```
   sudo systemctl daemon-reload
   sudo systemctl restart kubelet
   kubectl wait --for=condition=Ready node/<P> --timeout=120s
   ```
   The first block (`b1`, OKE) needs no restart. If P is not Ready after 120 s, **revert at once** (section 8).
3. **Prove which binary is running** (the file on disk proves nothing; the running process does):
   ```
   sudo sha256sum /proc/$(systemctl show -p MainPID --value kubelet)/exe
   ```
   It must equal the OKE sum (`oke`), the stock sum or the relist100 sum. A mismatch is an abort.
4. **Prove the relist period** with the metric, not the assumption. The histogram is cumulative since the
   kubelet started, so read twice, 60 s apart, and use the delta:
   ```
   kubectl get --raw "/api/v1/nodes/<P>/proxy/metrics" | grep -E '^kubelet_pleg_relist_interval_seconds_(sum|count)'
   ```
   mean = (sum2 - sum1) / (count2 - count1). Pass: `oke` and `stock` about 1.00 s; `relist100` between 0.095
   and 0.110 s. Do the same for S: about 1.00 s. A mismatch is an abort.
5. **Settle 5 minutes** after the restart, then two unrecorded warm-up wakes (a throwaway output file).
6. **Run the block** from the workstation, 30 rounds, with the block label:
   ```
   PHASE_POD=<harness pod> python3 scripts/bench-cold-start-phases/drive.py 30 \
     'ceil-p@<P hostname>,ceil-s@<S hostname>' ceiling-rows.jsonl \
     --place-mode=restore --pool-label=kubernetes.io/hostname --namespace=<NS> --block=b1
   ```
   `--block=b1` for the first block, then `--block=b2` ... `--block=b6`. All blocks append to the **same**
   file. Check the first two rows: `node` equals P for `ceil-p@...` and S for `ceil-s@...`, and the arm
   strings are the ones passed to the analyzer. Do not continue if they differ. The wakes take about 35
   minutes. **If the driver dies**, run `kubectl get nodes` and set the cordons by hand to the state recorded
   in section 4 step 3 (P cordoned, S as it was), then decide whether to continue.
7. **After the block:** repeat steps 3 and 4 (the exe hash and the relist mean, which must be unchanged),
   check `systemctl list-timers ceiling-revert.timer` still shows the timer, and `systemctl is-active kubelet`.
   Read the kubelet's CPU from the same metrics endpoint (`process_cpu_seconds_total`, two reads).

## 7. Abort criteria (stop, then section 8; section 9 if a node is affected)

Stop the run and report if any of these holds:
- P is not Ready **2 minutes** after a kubelet restart, or S is ever not Ready.
- A pod outside the bench namespace is evicted, restarted, or fails to schedule, or any `foreign_new_pods`
  entry appears on P (the analyzer prints a WARNING).
- The kubelet crash-loops (more than 2 restarts in 10 minutes), or its CPU stays above half a core for 10 min.
- More than 10% of the wakes in any block fail or lack a first byte (the analyzer exits 4).
- The exe hash or the relist mean is not the expected one for the block, or the auto-revert fired.
- Another benchmark appears on the cluster.
- A step seems to need `kubectl delete`, `--force`, a drain, or a namespace outside the bench namespace.

## 8. Revert (always run, even after an abort)

All of it works with the kubelet dead, over SSH:
1. Cancel the timer and revert:
   ```
   sudo systemctl stop ceiling-revert.timer 2>/dev/null || true
   sudo /var/lib/ceiling/revert.sh
   ```
   This removes the volatile drop-in and restarts the kubelet: the original `$KP` was never touched.
2. Prove it: `sudo sha256sum /proc/$(systemctl show -p MainPID --value kubelet)/exe` equals the original sum
   recorded in section 5, and `kubectl wait --for=condition=Ready node/<P> --timeout=120s`.
3. Verify the relist is back: the section 6 step 4 query on P gives about 1.00 s.
4. Remove the CRI-O debug drop-in if it was created (section 11): `sudo rm -f /etc/crio/crio.conf.d/99-ceiling-debug.conf`,
   `sudo systemctl reload crio`, and confirm the daemon's level is back (section 11).
5. **Uncordon P only now, and only if it was schedulable before the run:** `kubectl uncordon <P>`, then
   `kubectl get nodes -o custom-columns=NAME:.metadata.name,UNSCHEDULABLE:.spec.unschedulable` equals the
   state recorded in section 4 step 3. Leave `/var/lib/ceiling` in place until the analysis is done; removing
   a named file there is a node file removal, not a cluster delete.

## 9. Recover a NotReady node (no step relies on the kubelet)

Do not delete the node, the pod or the namespace. Do not use `kubectl debug node`.
1. SSH to P, run `sudo /var/lib/ceiling/revert.sh`, then `systemctl status kubelet` and
   `journalctl -u kubelet -n 200 --no-pager`.
2. SSH down: log in on the **OCI serial console** and do the same.
3. Neither works: a **founder-only** OCI soft reset of the instance. The drop-in lives in `/run`, so the
   original kubelet starts on boot (from memory, verify in the rehearsal's `docker restart` drill). The timer
   does not survive the reboot and does not need to.
4. Keep P cordoned until it is Ready and the exe hash is the original. If it is still not Ready after
   10 minutes, node replacement through the OKE console is the founder's decision.
5. Record every action in the run log with the time and the hash at each step.

## 10. Pre-registration: hypotheses, sample, and what each result means

Fixed before any data. Do not revise after the run.

**Hypotheses.**
- **H1 (baseline lock).** On P under the stock build, in every stock block, the 1 s cycle lock is present:
  the Rayleigh statistic in the 1 s band exceeds the 95th percentile of its per-group shuffled null with
  p < 0.05. (The analyzer tests each block and arm on its own: a kubelet restart resets the phase, and a
  drifting period smears a pooled peak.) The 2026-11-02 data showed it on two nodes with about 25 wakes
  each; whether 30 wakes per block is enough power is unverified.
- **H2 (primary, the wait).** Under relist100 the wait on P collapses from about 0-1000 ms to about 150 ms or
  less. Two conditions, both required: P's median wait under relist100 has a 95% bootstrap upper bound of
  150 ms or less, **and** the difference in differences (the P-minus-S median wait difference under
  relist100 minus the same under stock) has an interval entirely below 0.
- **H2b (secondary, the lock).** In the relist100 blocks the 1 s lock on P is gone and a 100 ms lock is
  present. The 1 s lattice has an exact tenth sub-harmonic inside the 100 ms band; a 100 ms lock counts as
  that sub-harmonic only if its period matches a tenth of the 1 s period to within the measured resolution
  (about period squared over span, not a fixed percentage).
- **H3 (goal).** The relist should move P's median first byte by about the wait it removes, 450-550 ms
  against the control. From a stock median of about 1640 ms that predicts about **1090 ms (1640 - 550), not
  below 1000**; the sprint plan's own estimate is 1077 ms. So **the goal is not expected to be met by this
  change alone**, and the pre-registered expectation is a floor near 1.08 s. The goal criterion the analyzer
  applies is that the 95% upper bound of P's relist100 median first byte is under 1000 ms.
- **One run cannot pass.** First-byte medians vary between 1276 and 1806 ms from run to run with no change
  at all. The analyzer has no PASS verdict: the best it prints is `RELIST_IS_WAIT_GOAL_MET_ONCE`. A pass
  claim needs the goal criterion met in at least three independent runs, each on fresh pods and at least
  two hours apart.

**Sample.** 6 blocks x 30 pairs = 360 wakes; 60 pairs per stock and per relist100 treatment, 60 for oke.
Gate: every block needs at least 24 complete pairs and at most 10% unusable wakes (error rows, no node, no
first byte or IP, no logs are skipped and counted, not fatal). Intervals are 2000-resample bootstraps,
resampled within each block; the lock null uses 100 permutations.

**Reading (fixed in advance).** The analyzer's `VERDICT` is the first row that matches, top to bottom. The
old table had two rows that overlapped (the 1 s lock persists; the median moves 300 ms but the 1 s lock
persists). They are one row now (row 2), and the precedence is this order.

| # | Verdict | Condition | Report as |
|---|---|---|---|
| 1 | `INVALID_NODES` | P rows on more than one node, S rows on more than one, or P and S on the same node | **Invalid.** The arms are not what the design says. Nothing is judged |
| 2 | `INVALID_LOCK_PERSISTS` | the 1 s lock persists on P in any relist100 block | **Invalid** for H2: the binary did not run or the relist is not the lock's source. Check the relist metric. Any move in the wait or median (even 300 ms or more) is **reported, not attributed to the relist** |
| 3 | `NO_BASELINE_LOCK` | no 1 s lock on P in some stock block | **Nothing to remove.** Wait results reported, not attributed |
| 4 | `CARRYOVER` | blocks of one treatment differ (a 99% interval on last minus first block's P-S wait delta excludes 0) | **Order-confounded.** No attribution; repeat |
| 5 | `WAIT_WORSE` | difference in differences interval above 0 | **Unexpected.** Reported as measured |
| 6 | `FLOOR_WAIT_UNMOVED` | 1 s lock gone, difference in differences interval includes 0 | **Floor, wait unattributed:** the wait is elsewhere in the pod path |
| 7 | `FLOOR_WAIT_PARTIAL` | difference in differences below 0, but P's relist100 wait upper bound is over 150 ms | **Floor.** Part of the wait is not the relist |
| 8 | `WAIT_REMOVED_LOCK_UNSEEN` | wait collapsed and 1 s lock gone, **no 100 ms lock detected** | **Wait attributed to the relist constant; the lock mechanism is not confirmed** ("1 s lock gone, 100 ms lock undetected") |
| 9 | `RELIST_IS_WAIT_GOAL_MET_ONCE` | row 8's conditions plus a 100 ms lock, and the goal criterion met | **Goal met once.** Not a pass (needs three independent runs). Founder decides on a custom node image, an upstream push, or the early announcer |
| 10 | `RELIST_IS_WAIT_FLOOR` | row 8's conditions plus a 100 ms lock, goal criterion not met | **Floor.** The relist is the wait; removing it does not reach the goal on OKE |

Any valid result that does not meet the goal is reported as a **floor**, not as a shipped default; a
non-pass reads as a floor. Nothing here changes what ships.

Secondary reading, never a verdict row: the slower-cluster share (bound to user first log of 650 ms or more)
as a difference in differences. An interval excluding 0 means the slow cluster moved with the treatment;
including 0 is **not resolved at this n** and cannot show the shares are equal.

**Known confounds, stated in advance.**
- Build: oke blocks run the OKE binary, stock and relist100 run ours (CGO off, `-trimpath`). The oke-versus-
  stock comparison (`wait build effect`) measures it; the section 4 step 8 check names any other difference.
- Node and app: P and S are different nodes and different NextApps with identical specs; the difference in
  differences removes what is constant between them.
- Harness placement: same-node for S, cross-node for P (section 2).
- Restarts: `b1` follows no restart; the others follow one. Carryover compares same-treatment blocks.
- Cordon-only: P keeps its existing pods, and takes any new pod scheduled during a P wake window.
- Timestamps: the wait uses the queue-proxy first log (not a listen event) and the clock offset to P, whose
  error bound is the offset RTT recorded by the harness; it is not subtracted.

## 11. Final attribution block, CRI-O debug (P only, after the six blocks and their analysis)

Not part of the design above and not analyzed with it. S carries **no** debug logging, ever.
1. P is on the OKE kubelet after `b6`. Write the drop-in (A5) and reload:
   ```
   sudo tee /etc/crio/crio.conf.d/99-ceiling-debug.conf >/dev/null <<'EOF'
   [crio.runtime]
   log_level = "debug"
   EOF
   sudo systemctl reload crio
   ```
2. **Verify the live daemon, not the files.** `crio config` prints what the files say, not what the running
   daemon uses. Check the daemon: `sudo crio-status config | grep log_level` (it queries the daemon over its
   socket; from memory, verify) and `sudo journalctl -u crio -n 100 --no-pager | grep -c 'level=debug'`
   must be above 0 and growing. Whether `log_level` reloads on SIGHUP is from memory (crio.conf(5)); verify.
3. Run 30 pairs with `--block=b7` into a **separate** file (`ceiling-b7-debug.jsonl`); the analyzer rejects
   unknown labels. Compare with `b6` by eye, descriptively, to see what debug logging costs.
4. Revert it in section 8 step 4.

## 12. Host log reader (separate, founder-applied step; read-only queries only)

Not created or applied by this runbook. After the window, on P and S:
```
sudo journalctl -u kubelet --since "<start ISO>" --until "<end ISO>" --no-pager -o short-iso
sudo journalctl -u kubelet --since "<start ISO>" --until "<end ISO>" --no-pager | grep -E 'pleg|SyncPod|Pod status|generic'
sudo journalctl -u crio --since "<start ISO>" --until "<end ISO>" --no-pager
sudo sha256sum /proc/$(systemctl show -p MainPID --value kubelet)/exe
```

## 13. After the run

1. Section 8 done: P and S Ready, P's exe hash the original, cordons as recorded.
2. Analyze the six blocks:
   ```
   python3 scripts/bench-cold-start-phases/ceiling/lattice_analyze.py ceiling-rows.jsonl \
     --p-arm='ceil-p@<P hostname>' --s-arm='ceil-s@<S hostname>' --perms=100 --boot=2000
   ```
   Use the arm strings exactly as the harness wrote them. Exit 3 means a block is missing or short; exit 4
   means more than 10% of a block's wakes were unusable; both judge nothing.
3. Report the `VERDICT` line and its `reading`, the per-block lock table, the wait difference in differences,
   the build and carryover lines, and the descriptive p95 with its caveat. Report a missed goal as a floor.

## 14. What only a real node can answer (unverified)

- Whether the CGO-off kubelet starts and behaves on OKE at all (also first checked on kind).
- Whether the OKE kubelet is a plain upstream build, and whether the volatile drop-in, SELinux labels and the
  OKE unit layout behave as described; whether `ExecStart` is a wrapper.
- What a kubelet restart does to P's existing pods and to node Ready on OKE (the rehearsal covers kind only).
- A reboot reverting to the OKE binary on a real instance, and the OCI console route.
- Whether CRI-O reloads `log_level` on SIGHUP and `crio-status config` reports the live level.
- Whether 30 wakes per block is enough power for the 1 s lock test, and the real size of carryover.
- That no foreign pod lands on P during the P wake windows.
