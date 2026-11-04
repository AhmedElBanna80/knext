# Kubelet ceiling test: runbook

**Status: prepared, not executed.** Founder-approved on 2026-11-04 as a **measurement, not a shipped
default**, on these terms: **one existing worker is patched (call it P), the other (S) is the untouched
control**, and the founder applies a host log reader on request. Nothing here has touched a cluster. The
agent that wrote it had no cluster access, ran no kubectl, ssh or node command, and pushed no image.
Every cluster step needs the founder's explicit go, and section 1 lists every approval it needs. The steps
are for a human operator.

Background: `docs/benchmarks/cold-start-node-diagnosis-oke-2026-11-02.md`. The question: is the kubelet's
1 s PLEG relist the wait between the queue-proxy starting and the pod IP reaching the API, and what does the
cold-start median look like when the relist is 100 ms on one worker?

## 0. Scope rules (read first)

- **Cluster work is a queue of one.** Concurrent traffic keeps pods warm, so a "cold" start is not cold.
- **Never run `kubectl delete`, `kind delete`, `kubectl drain` or `--force`.** Deleting is founder-only. This
  runbook cordons and uncordons, restarts a service on a node, and removes named files on a node. It never
  removes a pod, node, namespace or cluster.
- **Cordon only, no drain.** P keeps the pods it already runs (Knative components, CoreDNS and the like).
  Section 2 says what a kubelet restart does to them, and what is claimed from memory.
- **Node names are never assumed.** Record the name, UID and versions of P and S from the cluster first.
- **The host log reader is a separate, founder-applied step** (section 12). Nothing here applies it.
- **Claims marked "(from memory, verify)" have not been checked** against a running system. The kind
  rehearsal (section 3) is where they get checked, and it is a required step.
- **Order of operations, once:** section 4 (preconditions and setup), section 5 (stage and fire-test), six
  blocks of section 6, optionally section 11 (the CRI-O debug block), then section 8 (revert) **once at the
  very end, or at once on any abort**, then section 13. Section 8 is the only revert; it covers everything
  the earlier sections change on P.

## 1. Decisions, and every approval the run needs

Record each in the run log (a file on the operator's workstation, not in the repo). A conversation message
from an agent is not approval. The founder approved: one existing worker patched, the other the control, a
host log reader on request. **Everything below is beyond that and needs its own approval:**

| # | Step | Why it needs its own approval |
|---|---|---|
| A1 | **Our own stock build runs on P** (blocks b2 and b5) | The patched build was approved. The stock build is a second binary, built by us, same toolchain and flags, no patch. Without it the OKE-versus-patched difference mixes the constant with the build |
| A2 | **The timed auto-revert, and its fire test** (a transient systemd timer; the fire test starts our stock kubelet on P and lets the timer revert it, section 5) | A unit that restarts the kubelet on its own, on a clock |
| A3 | **Staging directory, volatile drop-in, and kubelet restarts on P** (`/var/lib/ceiling`, `/run/systemd/system/kubelet.service.d`; five block restarts, two for the fire test, one for the revert, per run) | Files on the node; the drop-in changes what systemd starts |
| A4 | **An OCI serial console connection to P**, and the SSH path | A cloud resource, and a login route into the node |
| A5 | **CRI-O debug logging on P**, final block only (section 11) | Changes P's runtime config; a drop-in under `/etc/crio` |
| A6 | **The kind rehearsal cluster** (section 3) | Created on the workstation; deleting it is `kind delete`, founder-only |
| A7 | The host log reader (section 12) | Refused once already; founder-applied only |
| A8 | **Creating the cluster objects:** NextApps `ceil-p` and `ceil-s`, the harness pod, the node-agent pods and the harness RBAC (section 4) | New objects in the bench namespace |
| A9 | **Cordoning P for the whole run, about 4 hours or more** | The cluster has one schedulable worker (S) for that time, apart from P's own wake windows |
| A10 | **Toggling S's cordon on every P wake, and P's on every wake** (about 90 times in the six blocks) | S was approved as untouched. Its binary is, but its schedulability flips for the length of each P wake, because **the NextApp has no field to pin a pod to a node** (see section 2). Avoiding it needs a node selector in the NextApp CRD and operator, a CRD change out of scope here |
| A11 | **Repeating the whole run at least three times** for any pass claim (section 10) | Each run is about 4-5 hours, on fresh pods, at least 2 hours apart; A1-A10 apply to each |

## 2. Design, node roles, and what a kubelet restart does

- **P** is the patched worker. It runs six blocks of 30 pairs, **in ABBA order**: `b1` OKE original, `b2` our
  stock build, `b3` relist100, `b4` relist100, `b5` our stock build, `b6` OKE original. Stock versus
  relist100 isolates the constant. OKE versus our stock build measures the build. The final OKE block checks
  carryover from the swaps. The middle four blocks are ABBA, not ABAB, **so a linear drift on P alone cancels
  in the stock-versus-relist100 difference** (stock sits at positions 1 and 4, relist100 at 2 and 3, of the
  four); an ABAB order would leave one block's worth of drift in it, which the carryover check could miss
  (about 330 ms of drift would pass it at 30 pairs, against an effect of about 450 ms). **Every block starts
  with a kubelet restart, including `b4` (the same binary again)**, so each block is equally "freshly
  restarted"; only `b1` follows no restart.
- **S** stays on its OKE binary, untouched, with no debug logging, in every block. It is the concurrent drift
  control. A pair is one wake on P and one on S in the same round, **back to back** (the driver wakes the two
  arms serially, with no wait between them, and waits for zero pods only at the start of a round).
- **Primary hypothesis: the wait.** The wait is the pod IP time minus the queue-proxy's first log, per wake.
  Under the stock relist it is spread over about 0-1000 ms. With a 100 ms relist it should fall to about
  150 ms or less. It is judged as a **difference in differences against S**. The cycle lock is secondary.
- **How the wait is timed.** `pod_ip` is **the harness's own watch time** (its clock), not a node timestamp.
  The queue-proxy's first log is a CRI-O log timestamp on the **node's** clock, re-based onto the harness
  clock by an offset the harness measures against a node-agent pod on that node (`clock.offset_ms`, with its
  round trip `clock.rtt_ms`, whose half bounds the error). `cold-cycle.mjs` falls back to offset 0 if it
  finds no agent on the node, which would put raw clock skew into P's wait against a 150 ms limit. **The
  analyzer therefore treats a row with no offset, or with a round trip over 50 ms, as unusable and counts
  it, and prints the median and max round trip per arm.**
- **Placement.** The harness pod runs on **S**, not P: P's kubelet is restarted five times and a harness on
  it would be disturbed. `ceiling-setup.example.yaml` pins it to S by `nodeName` (which also bypasses the
  cordon); confirm with `kubectl get pod ceil-harness -o wide`. If it is on P, **stop**: moving it needs a
  delete, which is founder-only. **Network asymmetry, stated:** harness-to-pod traffic is same-node for S
  wakes and cross-node for P wakes, so first byte carries a small constant offset between arms. It is the
  same in every block, so it cancels in the difference in differences; it does not affect the wait.
- **The two arms are two NextApps** (`ceil-p`, `ceil-s`) with identical specs, because one app cannot be woken
  twice in a round without waiting for zero pods between. Arm identity is therefore aliased with node. That
  is acceptable: the contrast that matters, relist100 against stock, is within P.
- **Pinning uses cordons, because the NextApp cannot pin.** Checked in `api/v1alpha1/nextapp_types.go`: the
  NextApp spec has no `nodeSelector`, `affinity`, `tolerations` or pod-template field, and the operator is
  the single source of truth for cluster objects, so there is no node-level placement in the CR, and the
  harness writes no Knative objects. Pinning by selector would need a CRD and operator change, which is out
  of scope (and a CRD change is an escalation trigger). A wake is therefore placed by cordoning the other
  node for its duration.
- **How the cordons are protected** (`drive.py --place-mode=restore`, tested):
  - It snapshots every managed node's cordon first and works only on the nodes of the pools the arms name.
    It refuses to start if any other node is schedulable (a wake could land there), and it aborts on any
    refused cordon.
  - **It reads the live node, never a cache.** Before each placement, after each change and after each wake it
    reads the node back. If a node's live state is not what **this run** last set (someone else cordoned S, or
    uncordoned P), it **stops, leaves that node as the other party left it**, and says so. A cordon whose
    response was lost but which took effect counts as done; one that reported success but did not take effect
    is an error.
  - After every wake and at exit it puts each node back to the snapshot, **unless that node was changed by
    someone else**, in which case it reports and exits 1. P is cordoned by the founder before the run, so P
    stays cordoned except during its own wake.
  - SIGTERM and SIGHUP run the restore. **SIGKILL cannot be caught**, so a killed driver leaves P open and S
    closed, and the next block's fresh snapshot would take that for the rest state. `--expect-state` is the
    guard: each block's command states the rest state (P cordoned, S open) and the driver refuses to start
    from any other.
  - A **lock file** allows one restore-mode driver per workstation. It does not span workstations; the
    section 4 check of the cluster covers that.
- **What this cannot guarantee.** During a P wake, S is cordoned, so any pod scheduled anywhere in the cluster
  in that window lands on P. The harness lists, after each wake, pods that appeared on the woken node and are
  not the arm, a DaemonSet pod or already there (`foreign_new_pods`), **prints `FOREIGN POD on pool ...` at
  once, and with `--abort-on-foreign=<P pool>` stops the run** after restoring the cordons. Detection, not
  prevention.
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

**How the rehearsal differs from production, so it is not read as proving more than it does:**
- kind runs the kubelet from kubeadm's layout: `ExecStart` is set in `/etc/systemd/system/kubelet.service.d/10-kubeadm.conf`.
  A later-sorting drop-in (`99-ceiling.conf`) with an `ExecStart=` reset should override it, and the
  rehearsal is where that is checked. Production's section 5 stop condition is written for the same case.
- The runtime is containerd, not CRI-O; there is no SELinux enforcement to speak of, no OCI console, and
  `docker exec` stands in for SSH. `/run` is a tmpfs in the node container, which is what the reboot drill
  needs. The architecture may be arm64.

1. Create a throwaway kind cluster with a name that cannot be mistaken for another (A6). Build for the
   cluster's architecture **into its own output directory** (an arm64 build refuses the default one, which
   holds the amd64 `SHA256SUMS`):
   `KUBELET_CEILING_GOARCH=arm64 scripts/bench-cold-start-phases/ceiling/build.sh /path/to/rehearsal-build`
   on Apple Silicon, or use an amd64 node image. **Starting the CGO-off binary is the first thing to
   check: it has never been started.** Record whether it starts and reports Ready on a kind node, and which
   kubelet version the node image runs (it must be v1.34.x for the comparison to mean anything).
2. Deploy a small workload on the kind worker. Record container IDs and `restartCount`.
3. Do the section 5-6 procedure inside the kind node with `docker exec` standing in for SSH: stage the
   binaries with `install`, write the volatile drop-in, restart, hash `/proc/<pid>/exe` and compare the
   `cmdline` hash, then revert and hash again. Confirm the workload's container IDs and `restartCount` did
   not change across a restart, and record how long the node took to return to Ready.
4. **Failure drills.** (a) Point the drop-in at a binary that exits at once; confirm the node goes NotReady
   and `/var/lib/ceiling/revert.sh` brings it back with no kubelet. (b) Fire the timed auto-revert (section
   5's fire test) and confirm it reverts. (c) Restart the kind node container (`docker restart`) with the
   drop-in in place and confirm the stock kubelet starts: `/run` is memory, so the drop-in is gone.
5. Read `kubelet_pleg_relist_interval_seconds` before and after, confirming mean 1.0 s versus 0.1 s.
6. Dry-run the driver against the kind cluster with `--place-mode=restore`, then kill it with SIGKILL during
   a wake and confirm `--expect-state` refuses the next start.
7. **Not rehearsable on kind, so unverified until a real node:** CRI-O (kind uses containerd), SELinux labels
   and the OKE unit file, the OKE kubelet being a plain upstream build, a real reboot, the OCI console.

## 4. Preconditions and setup

1. Section 1 approvals (A1-A11) and the rehearsal (section 3) recorded, with dates.
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
4. **Create the cluster objects (A8), with no hard-coded node.** The repo manifests under
   `scripts/bench-cold-start-phases/` carry node names from an older cluster (`nodeName: 10.0.1.118` and
   `10.0.1.169`); **do not apply them as they are.** Work from copies in a scratch directory:
   - `harness-rbac.yaml`: keep only its **first three documents** (ServiceAccount, Role, RoleBinding) and
     replace `bench-cells` with `<NS>`. Delete the pod documents (`phase-bench`, the `clock-*` pods).
   - `node-agents.yaml`: replace the two `nodeName:` values with P's and S's names, and `bench-cells` with
     `<NS>`. The harness finds the agent as the pod labelled `app=phase-agent` on the woken pod's node, so
     the pod names do not matter.
   - `ceiling/ceiling-setup.example.yaml`: fill `<NS>`, `<S node>` (the harness pod's `nodeName`, which pins
     it to S) and `<IMAGE>` (pinned by digest, never `:latest`).
   Then verify before applying: `grep -n 'nodeName' <the copies>` lists only P's and S's names, and
   `grep -n '10\.0\.1\.' <the copies>` finds nothing. Apply with `kubectl apply --validate=strict -f`, then
   `kubectl get pods -n <NS> -o wide`: the harness on S, one agent on each node, `ceil-p` and `ceil-s` Ready
   at zero pods (`minScale: 0`).
5. **Harness on S** (section 2): `kubectl get pod ceil-harness -n <NS> -o wide`.
6. **The image is on both nodes.** The first wake after a missing image includes a pull. Check on each node
   over SSH (authoritative): `sudo crictl images --digests | grep <digest from the NextApp spec.image>`.
   The API view `kubectl get node <n> -o jsonpath='{.status.images[*].names}'` is a quick look only: the
   kubelet reports at most 50 images by default (from memory), so absence there proves nothing. If missing,
   do two unrecorded wakes per arm first and re-check.
7. Nothing else is benching:
   ```
   kubectl get pods -A -o wide | grep -Ei 'bench|phase|harness|loadtest|k6' || true
   kubectl get nextapp -A
   pgrep -fl 'drive.py|baseline-stability|prepull|burst-ab|bunexec|cpu-boost' || true   # on the workstation
   ```
   Expected: the harness pod, `ceil-p`, `ceil-s` and the node agents. Ask the founder about anything else.
   The driver's lock covers this workstation only; a driver on another workstation is covered only by this
   check and by the live-cordon abort.
8. **A tested access path to P before any swap (A4).** All of these, recorded:
   - SSH to P with sudo: `ssh <user>@<P address> 'sudo -n true && echo ok'`. Keep **a second SSH session open**
     for the whole run.
   - An **OCI serial console connection to P is created and a login prompt reached** (the route that works
     when the network or sshd is down). The OCI steps are per the OCI documentation; verify them, they were
     not run.
   - **The recovery route does not rely on the kubelet.** `kubectl debug node` needs a working kubelet and
     leaves a pod behind that only the founder can delete, so it is not used.
9. **Build equivalence, off the node.** Copy the OKE kubelet off P and inspect the copy on the workstation,
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
10. Record the start time. Six blocks need about 4-5 hours of cluster time, plus the restarts.

## 5. On P: variables, staging, the revert script, the timer and its fire test (founder-run, over SSH)

Run the whole section in one shell on P. Define the variables and helpers first; every later command uses
them.

```
sudo systemctl cat kubelet                        # the whole unit including drop-ins; read it
sudo systemctl show kubelet -p ExecStart -p FragmentPath -p DropInPaths
KP=<the path= value of ExecStart, the real binary>
sudo head -c 4 "$KP" | od -An -c                  # expect: 177   E   L   F
kpid()     { systemctl show -p MainPID --value kubelet; }
exe_sum()  { sudo sha256sum /proc/"$(kpid)"/exe | cut -d' ' -f1; }
args_sum() { sudo cat /proc/"$(kpid)"/cmdline | tr '\0' '\n' | tail -n +2 | sha256sum | cut -d' ' -f1; }
OKE_EXE=$(exe_sum); OKE_ARGS=$(args_sum); echo "$OKE_EXE $OKE_ARGS"      # record both
sudo sha256sum "$KP"                              # the file; must equal the off-node copy's sum
```
`exe_sum` hashes the **running process's** executable and `args_sum` hashes its **arguments** (everything
after argv[0]). Both are recorded for the OKE kubelet now; every later restart must reproduce `OKE_ARGS`, so
flag equality between the arms is checked, not assumed.

**Stop conditions.** Stop and report if any is true: `ExecStart` is a shell script or wrapper (the first four
bytes are not `ELF`); `ExecStart` runs more than one command; an existing drop-in sets `ExecStart` and sorts
**after** `99-ceiling.conf` (ours would not win; one that sorts before is expected and is what the `ExecStart=`
reset overrides, see section 3); `findmnt -T /var/lib -o OPTIONS` shows `noexec`; the unit uses a
`ExecStartPre` that touches the binary path.

**SELinux, for the binaries and for the revert script.** `getenforce`. If it prints `Enforcing`, the staged
files must be executable by systemd under the node's policy: compare `ls -Z "$KP" /var/lib/ceiling/*` and
make each staged binary match `$KP` with `sudo chcon --reference="$KP" <file>` (`restorecon` would keep
`var_lib_t`, which an enforcing node may refuse to exec). The revert script is never exec'd directly: the
timer runs it as **`/bin/sh /var/lib/ceiling/revert.sh`**, so only `/bin/sh` needs to be executable and the
script only readable. Whether that holds on the real node is proved by the fire test below, not assumed. If
it fails, look for the denial (`sudo ausearch -m avc -ts recent`), stop, and report.

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

The revert script, also staged now (it works with the kubelet down, and is safe to run twice). It also
removes the CRI-O debug drop-in, which lives in `/etc` and would otherwise survive a reboot:
```
sudo tee /var/lib/ceiling/revert.sh >/dev/null <<'EOF'
#!/bin/sh
rm -f /run/systemd/system/kubelet.service.d/99-ceiling.conf
if [ -e /etc/crio/crio.conf.d/99-ceiling-debug.conf ]; then
  rm -f /etc/crio/crio.conf.d/99-ceiling-debug.conf
  systemctl reload crio
fi
systemctl daemon-reload
systemctl restart kubelet
EOF
sudo chmod 0600 /var/lib/ceiling/revert.sh
```

**Timed auto-revert (A2), armed before the first swap and re-armed at the start of every block.** If the
operator or the workstation vanishes, P returns to the OKE binary by itself:
```
sudo systemctl stop ceiling-revert.timer 2>/dev/null || true
sudo systemd-run --unit=ceiling-revert --on-active=60m /bin/sh /var/lib/ceiling/revert.sh
systemctl list-timers ceiling-revert.timer
```
A block is about 35 minutes, so 60 minutes covers a block plus its checks. The timer is transient (memory), so
it does not survive a reboot, and does not need to for the kubelet (the `/run` drop-in does not either); the
CRI-O drop-in is the exception, handled in section 9. **If the timer fires during a block, the rest of that
block ran on the OKE kubelet.** Check `systemctl list-timers` and `exe_sum` at the end of every block; a
block where it fired is discarded.

**Fire test: the net is proved before anything relies on it. Do not start block 1 without it.**
1. Write the **stock** drop-in, `sudo systemctl daemon-reload`, `sudo systemctl restart kubelet`,
   `kubectl wait --for=condition=Ready node/<P> --timeout=120s`. `exe_sum` must equal the stock sum and
   `args_sum` must equal `$OKE_ARGS`. (This is also the first time our stock build runs on the node.)
2. Fire the timer on a short delay, through the same explicit interpreter:
   ```
   sudo systemd-run --unit=ceiling-revert-test --on-active=30s /bin/sh /var/lib/ceiling/revert.sh
   sleep 75
   sudo journalctl -u ceiling-revert-test.service --no-pager | tail -n 5
   test ! -e /run/systemd/system/kubelet.service.d/99-ceiling.conf && echo drop-in-gone
   exe_sum; args_sum
   kubectl wait --for=condition=Ready node/<P> --timeout=120s
   ```
3. **The proof is the effect, not the unit's state** (a successful transient service is collected): the
   drop-in is gone, `exe_sum` equals `$OKE_EXE`, `args_sum` equals `$OKE_ARGS`, and P is Ready. **If any of
   these is not so, stop the run**: run `sudo /bin/sh /var/lib/ceiling/revert.sh` by hand, confirm the same
   three things, and report. The run does not start on an untested net.

## 6. The block loop (founder-run on P; the workstation runs the harness)

Before block 1: the founder cordons P (`kubectl cordon <P>`; verify `SchedulingDisabled`). Do not drain.

For each block `bK` with its kubelet `X`, in this order: `b1` oke, `b2` stock, `b3` relist100, `b4`
relist100, `b5` stock, `b6` oke:

1. **Re-arm the auto-revert** (section 5).
2. **Select X and restart, in every block but `b1`** (`b4` restarts onto the same binary as `b3`, so each
   block is freshly restarted). `oke`: remove the drop-in if present. `stock`/`relist100`: write it. Then
   ```
   sudo systemctl daemon-reload
   sudo systemctl restart kubelet
   kubectl wait --for=condition=Ready node/<P> --timeout=120s
   ```
   If P is not Ready after 120 s, **revert at once** (section 8).
3. **Prove which binary and which flags are running** (the file on disk proves nothing; the running process
   does): `exe_sum` must equal the OKE sum (`oke`), the stock sum or the relist100 sum, and **`args_sum` must
   equal `$OKE_ARGS` in every block**. A mismatch is an abort.
4. **Prove the relist period** with the metric, not the assumption. The histogram is cumulative since the
   kubelet started, so read twice, 60 s apart, and use the delta:
   ```
   kubectl get --raw "/api/v1/nodes/<P>/proxy/metrics" | grep -E '^kubelet_pleg_relist_interval_seconds_(sum|count)'
   ```
   mean = (sum2 - sum1) / (count2 - count1). Pass: `oke` and `stock` about 1.00 s; `relist100` between 0.095
   and 0.110 s. Do the same for S: about 1.00 s. A mismatch is an abort.
5. **Settle 5 minutes** after the restart, then two unrecorded warm-up wakes (a throwaway output file).
6. **Run the block** from the workstation, 30 rounds, with the block label. `<P node>` and `<S node>` are node
   names; `<P pool>` is the value of the `kubernetes.io/hostname` label on P (the same as the node name on
   many clusters, but check):
   ```
   PHASE_POD=ceil-harness python3 scripts/bench-cold-start-phases/drive.py 30 \
     'ceil-p@<P pool>,ceil-s@<S pool>' ceiling-rows.jsonl \
     --place-mode=restore --pool-label=kubernetes.io/hostname --namespace=<NS> \
     --expect-state='<P node>:cordoned,<S node>:open' \
     --abort-on-foreign='<P pool>' --abort-failed-fraction=0.10 --block=b1
   ```
   `--block=b1` for the first block, then `--block=b2` ... `--block=b6`. All blocks append to the **same**
   file. Check the first two rows: `node` equals P for `ceil-p@...` and S for `ceil-s@...`, and the arm
   strings are the ones passed to the analyzer. Do not continue if they differ. The wakes take about 35
   minutes. **The driver exits non-zero, and says why, on:** a cordon changed by someone else, a refused
   cordon, a foreign pod on P (`FOREIGN POD on pool ...`), failed wakes past 10% of the planned ones
   (`stopping: N failed wakes of M planned`, observable mid-run), a held lock, or an unexpected rest state.
   **Treat every non-zero exit as a stop.** Run `kubectl get nodes -o custom-columns=NAME:.metadata.name,UNSCHEDULABLE:.spec.unschedulable`
   and compare with section 4 step 3 (P cordoned, S as it was) before deciding anything. If the driver was
   SIGKILLed, P may be open and S closed: set them by hand, and `--expect-state` will refuse the next start
   until they are right.
7. **After the block:** repeat steps 3 and 4 (`exe_sum`, `args_sum` and the relist mean, which must be
   unchanged), check `systemctl list-timers ceiling-revert.timer` still shows the timer, and
   `systemctl is-active kubelet`. Read the kubelet's CPU from the same metrics endpoint
   (`process_cpu_seconds_total`, two reads).

## 7. Abort criteria (stop, then section 8; section 9 if a node is affected)

Stop the run and report if any of these holds:
- P is not Ready **2 minutes** after a kubelet restart, or S is ever not Ready.
- A pod outside the bench namespace is evicted, restarted, or fails to schedule, or the driver prints
  `FOREIGN POD on pool <P pool>` (it also stops itself with `--abort-on-foreign`).
- The kubelet crash-loops (more than 2 restarts in 10 minutes), or its CPU stays above half a core for 10 min.
- The driver stops with `stopping: N failed wakes of M planned` (more than 10% of a block), or the analyzer
  later exits 4.
- `exe_sum` or `args_sum` or the relist mean is not the expected one for the block, or the auto-revert fired.
- The driver reports a cordon changed by someone else, or the cordons are not in the recorded state.
- Another benchmark appears on the cluster.
- A step seems to need `kubectl delete`, `--force`, a drain, or a namespace outside the bench namespace.

## 8. Revert (always run, once, at the end or at once on an abort)

All of it works with the kubelet dead, over SSH. It covers the kubelet drop-in and the CRI-O debug drop-in
together, because `revert.sh` removes both:
1. Cancel the timer and revert:
   ```
   sudo systemctl stop ceiling-revert.timer 2>/dev/null || true
   sudo /bin/sh /var/lib/ceiling/revert.sh
   ```
   This removes the volatile drop-in (and the CRI-O one, if present) and restarts the kubelet: the original
   `$KP` was never touched.
2. Prove it: `exe_sum` equals `$OKE_EXE`, `args_sum` equals `$OKE_ARGS`, and
   `kubectl wait --for=condition=Ready node/<P> --timeout=120s`.
3. Verify the relist is back: the section 6 step 4 query on P gives about 1.00 s.
4. Verify CRI-O is back if section 11 ran: `test ! -e /etc/crio/crio.conf.d/99-ceiling-debug.conf` and
   `sudo crio-status config | grep log_level` shows the original level (normally `info`).
5. **Uncordon P only now, and only if it was schedulable before the run:** `kubectl uncordon <P>`, then
   `kubectl get nodes -o custom-columns=NAME:.metadata.name,UNSCHEDULABLE:.spec.unschedulable` equals the
   state recorded in section 4 step 3. Leave `/var/lib/ceiling` in place until the analysis is done; removing
   a named file there is a node file removal, not a cluster delete.

## 9. Recover a NotReady node (no step relies on the kubelet)

Do not delete the node, the pod or the namespace. Do not use `kubectl debug node`.
1. SSH to P, run `sudo /bin/sh /var/lib/ceiling/revert.sh`, then `systemctl status kubelet` and
   `journalctl -u kubelet -n 200 --no-pager`.
2. SSH down: log in on the **OCI serial console** and do the same.
3. Neither works: a **founder-only** OCI soft reset of the instance. The kubelet drop-in lives in `/run`, so
   the original kubelet starts on boot (from memory, verify in the rehearsal's `docker restart` drill). The
   timer does not survive the reboot and does not need to. **The CRI-O debug drop-in does survive it**
   (it is in `/etc`): after any reboot, check `/etc/crio/crio.conf.d/99-ceiling-debug.conf` and run
   `revert.sh` if it is there.
4. Keep P cordoned until it is Ready and `exe_sum` is the original. If it is still not Ready after
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
  (about period squared over span, not a fixed percentage). **Multiplicity:** "the 1 s lock persists" is
  judged at alpha 0.05 divided by the two relist100 blocks (0.025) and needs **both** blocks; one block with
  the lock back is `INCONCLUSIVE_LOCK_MIXED`, never a condemned binary. A working patch still gives a mixed
  result about 5% of the time. This needs at least 40 permutations (the analyzer enforces it).
- **H3 (goal).** The relist should move P's median first byte by about the wait it removes, 450-550 ms
  against the control. From a stock median of about 1640 ms that predicts about **1090 ms (1640 - 550), not
  below 1000**; the sprint plan's own estimate is 1077 ms. So **the goal is not expected to be met by this
  change alone**, and the pre-registered expectation is a floor near 1.08 s. The goal criterion the analyzer
  applies is that the 95% upper bound of P's relist100 median first byte is under 1000 ms. **It is not
  evaluated for an invalid or unattributable run** (rows 1-5 below), and the analyzer prints
  `goal criterion: not evaluated` there.
- **One run cannot pass.** First-byte medians vary between 1276 and 1806 ms from run to run with no change
  at all. The analyzer has no PASS verdict: the best it prints is `RELIST_IS_WAIT_GOAL_MET_ONCE`. A pass
  claim needs the goal criterion met in at least three independent runs, each on fresh pods and at least
  two hours apart (A11).

**Sample.** 6 blocks x 30 pairs = 360 wakes; 60 pairs per stock and per relist100 treatment, 60 for oke.
Gate: every block needs at least 24 complete pairs and at most 10% unusable wakes (error rows, no node, no
first byte or IP, no logs, no clock offset or one with a round trip over 50 ms are skipped and counted, not
fatal). The 10% limit is checked on a partial file too, before the missing-block check. Intervals are
2000-resample bootstraps, resampled within each block; the lock null uses 100 permutations.
**The blocks are treated as fixed:** only pairs within a block are resampled, and block-to-block variance
(two blocks per treatment) is not, so the intervals are narrower than a random-block model would give. The
carryover screen is the only guard against block-level shifts.

**Reading (fixed in advance).** The analyzer's `VERDICT` is the first row that matches, top to bottom. The
old table had two rows that overlapped (the 1 s lock persists; the median moves 300 ms but the 1 s lock
persists). They are one row now (row 2), and the precedence is this order.

| # | Verdict | Condition | Report as |
|---|---|---|---|
| 1 | `INVALID_NODES` | P rows on more than one node, S rows on more than one, or P and S on the same node | **Invalid.** The arms are not what the design says. Nothing is judged |
| 2 | `INVALID_LOCK_PERSISTS` | the 1 s lock persists on P in **all** relist100 blocks (each at alpha / 2) | **Invalid** for H2: the binary did not run or the relist is not the lock's source. Check the relist metric. Any move in the wait or median (even 300 ms or more) is **reported, not attributed to the relist** |
| 3 | `NO_BASELINE_LOCK` | no 1 s lock on P in some stock block | **Nothing to remove.** Wait results reported, not attributed |
| 4 | `INCONCLUSIVE_LOCK_MIXED` | the 1 s lock persists in some relist100 blocks but not all | **Inconclusive.** Check the relist metric of each block; repeat |
| 5 | `CARRYOVER` | blocks of one treatment differ (a 99% interval on last minus first block's P-S wait delta excludes 0) | **Order-confounded.** No attribution; repeat |
| 6 | `WAIT_WORSE` | difference in differences interval above 0 | **Unexpected.** Reported as measured |
| 7 | `FLOOR_WAIT_UNMOVED` | 1 s lock gone, difference in differences interval includes 0 | **Floor, wait unattributed:** the wait is elsewhere in the pod path |
| 8 | `FLOOR_WAIT_PARTIAL` | difference in differences below 0, but P's relist100 wait upper bound is over 150 ms | **Floor.** Part of the wait is not the relist |
| 9 | `WAIT_REMOVED_LOCK_UNSEEN` | wait collapsed and 1 s lock gone, **no 100 ms lock detected** | **Wait attributed to the relist constant; the lock mechanism is not confirmed** ("1 s lock gone, 100 ms lock undetected") |
| 10 | `RELIST_IS_WAIT_GOAL_MET_ONCE` | row 9's conditions plus a 100 ms lock, and the goal criterion met | **Goal met once.** Not a pass (needs three independent runs). Founder decides on a custom node image, an upstream push, or the early announcer |
| 11 | `RELIST_IS_WAIT_FLOOR` | row 9's conditions plus a 100 ms lock, goal criterion not met | **Floor.** The relist is the wait; removing it does not reach the goal on OKE |

Any valid result that does not meet the goal is reported as a **floor**, not as a shipped default; a
non-pass reads as a floor. Nothing here changes what ships.

Secondary reading, never a verdict row: the slower-cluster share (bound to user first log of 650 ms or more)
as a difference in differences. An interval excluding 0 means the slow cluster moved with the treatment;
including 0 is **not resolved at this n** and cannot show the shares are equal.

**Known confounds, stated in advance.**
- Build: oke blocks run the OKE binary, stock and relist100 run ours (CGO off, `-trimpath`). The oke-versus-
  stock comparison (`wait build effect`) measures it; the section 4 step 9 check and the per-block
  `args_sum` check name any other difference.
- Node and app: P and S are different nodes and different NextApps with identical specs; the difference in
  differences removes what is constant between them.
- Drift: a linear drift on P alone cancels in the ABBA stock-versus-relist100 contrast; a non-linear one does
  not, and the blocks are fixed effects in the intervals (above).
- Harness placement: same-node for S, cross-node for P (section 2).
- Restarts: `b1` follows no restart; the others follow one. Carryover compares same-treatment blocks.
- Cordon-only: P keeps its existing pods, and takes any new pod scheduled during a P wake window.
- Timestamps: `pod_ip` is the harness's clock and the queue-proxy log is the node's clock re-based by the
  measured offset (section 2); the offset's error bound is half its round trip, not subtracted.

## 11. Final attribution block, CRI-O debug (P only; after the six blocks, before the section 8 revert)

Not part of the design above and not analyzed with it. S carries **no** debug logging, ever.
1. P is on the OKE kubelet after `b6`. **Re-arm the timer** (section 5), so a vanished operator is covered
   for this block too; `revert.sh` also removes the CRI-O drop-in.
2. Write the drop-in (A5) and reload:
   ```
   sudo tee /etc/crio/crio.conf.d/99-ceiling-debug.conf >/dev/null <<'EOF'
   [crio.runtime]
   log_level = "debug"
   EOF
   sudo systemctl reload crio
   ```
3. **Verify the live daemon, not the files.** `crio config` prints what the files say, not what the running
   daemon uses. Check the daemon: `sudo crio-status config | grep log_level` (it queries the daemon over its
   socket; from memory, verify) and `sudo journalctl -u crio -n 100 --no-pager | grep -c 'level=debug'`
   must be above 0 and growing. Whether `log_level` reloads on SIGHUP is from memory (crio.conf(5)); verify.
4. Run 30 pairs with `--block=b7` into a **separate** file (`ceiling-b7-debug.jsonl`); the analyzer rejects
   unknown labels. Use the same command as section 6 step 6. Compare with `b6` by eye, descriptively, to see
   what debug logging costs.
5. Then run section 8, which removes the debug drop-in with the rest.

## 12. Host log reader (separate, founder-applied step; read-only queries only)

Not created or applied by this runbook. After the window, on P and S:
```
sudo journalctl -u kubelet --since "<start ISO>" --until "<end ISO>" --no-pager -o short-iso
sudo journalctl -u kubelet --since "<start ISO>" --until "<end ISO>" --no-pager | grep -E 'pleg|SyncPod|Pod status|generic'
sudo journalctl -u crio --since "<start ISO>" --until "<end ISO>" --no-pager
sudo sha256sum /proc/$(systemctl show -p MainPID --value kubelet)/exe
```

## 13. After the run

1. Section 8 done: P and S Ready, P's exe hash the original, cordons as recorded, CRI-O back.
2. Analyze the six blocks:
   ```
   python3 scripts/bench-cold-start-phases/ceiling/lattice_analyze.py ceiling-rows.jsonl \
     --p-arm='ceil-p@<P pool>' --s-arm='ceil-s@<S pool>' --perms=100 --boot=2000
   ```
   Use the arm strings exactly as the harness wrote them. Exit 3 means a block is missing or short; exit 4
   means more than 10% of a block's wakes were unusable; both judge nothing.
3. Report the `VERDICT` line and its `reading`, the per-block lock table, the wait difference in differences,
   the build and carryover lines, the clock round trips, and the descriptive p95 with its caveat. Report a
   missed goal as a floor.

## 14. What only a real node can answer (unverified)

- Whether the CGO-off kubelet starts and behaves on OKE at all (also first checked on kind).
- Whether the OKE kubelet is a plain upstream build, and whether the volatile drop-in, SELinux labels and the
  OKE unit layout behave as described; whether `ExecStart` is a wrapper; whether the fire test passes under
  the node's SELinux policy.
- What a kubelet restart does to P's existing pods and to node Ready on OKE (the rehearsal covers kind only).
- A reboot reverting to the OKE binary on a real instance, and the OCI console route.
- Whether CRI-O reloads `log_level` on SIGHUP and `crio-status config` reports the live level.
- Whether 30 wakes per block is enough power for the 1 s lock test, and the real size of carryover.
- That no foreign pod lands on P during the P wake windows.
- That a node-agent pod exists and answers on both nodes (otherwise every row is unusable).
