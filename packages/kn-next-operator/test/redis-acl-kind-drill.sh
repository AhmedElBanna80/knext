#!/usr/bin/env bash
# Per-app Redis ACL user: the kind exit drill.
#
# Stands up a throwaway kind cluster with ONE Redis, the real operator image
# (built from this tree) under the SHIPPED ClusterRole and the SHIPPED
# Secret/ConfigMap write policy, and two NextApps (zone-a, zone-b) on that Redis.
# It then asserts, by exit code, what an object assertion cannot:
#
#   L1. Before the shared credential is closed, the operator reports
#       "isolation not in force: shared credential live" and never says isolated.
#   L2. App A's own credential works on A's keys and is refused (NOPERM) on B's
#       keys, and on KEYS / FLUSHALL / INFO / ACL. B is the mirror image.
#   L3. The password is only in the operator-owned Secret: it is in no NextApp
#       field, status, or Event.
#   L4. The old shared URL still reads zone A's keys (the hole being closed).
#   L5. After `ACL SETUSER default off`, a pod using the old shared URL gets
#       NOAUTH/WRONGPASS on zone A's keys, `AUTH default` is refused, and the
#       operator then reports CacheCredentialsReady=Provisioned (isolation observed).
#   L6. spec.cache.isolation=acl on an unregistered endpoint fails closed:
#       EndpointUnregistered, no Secret.
#   L7. A prefix that nests inside another app's fails closed: PrefixConflict, no
#       Secret, no user.
#   L8. Deleting an app sweeps its keys as its own user and removes its ACL user.
#
# What this drill does NOT cover: the Next.js cache handler's ISR and 'use cache'
# paths, including the outage replay. Those run under the same rule set in
# scripts/redis-acl-spike.mjs (the live Redis lane in CI). Knative Serving is
# not installed (only its CRDs), so no app pod runs; probe pods stand in for the
# app and read REDIS_URL from the operator-owned Secret exactly as the rendered
# Knative Service does.
#
# Usage: packages/kn-next-operator/test/redis-acl-kind-drill.sh
#   KEEP=1 keeps the cluster; CLUSTER=name overrides it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OP="$(cd "$HERE/.." && pwd)"
CLUSTER="${CLUSTER:-knext-acl-2396}"
WORK="$(mktemp -d)"
export KUBECONFIG="$WORK/kubeconfig"
REDIS_IMAGE="mirror.gcr.io/library/redis:7-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2"
OP_IMAGE="knext-operator:acl-drill"
BASE_IMAGE="ubuntu:24.04"
SERVING="$(ls -d "$HOME"/go/pkg/mod/knative.dev/serving@v0.48.0/config/core/300-resources)"
PASS=0
FAILED=0

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  else
    echo "kept cluster $CLUSTER, kubeconfig $KUBECONFIG"
  fi
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); echo "  PASS  $*"; }
bad() { FAILED=$((FAILED + 1)); echo "  FAIL  $*"; }
expect_contains() { # label haystack needle
  case "$2" in *"$3"*) ok "$1" ;; *) bad "$1: wanted [$3] in [$2]" ;; esac
}
expect_not_contains() {
  case "$2" in *"$3"*) bad "$1: found [$3] in [$2]" ;; *) ok "$1" ;; esac
}
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got [$2] want [$3]"; fi; }

k() { kubectl "$@"; }
ADMIN_PW="adm-$(head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
ADMIN_READY=0
# The drill's own full-rights user: needed once the default user is switched off.
rcli_admin() {
  if [ "$ADMIN_READY" = "1" ]; then
    k -n cache exec deploy/redis -- redis-cli --no-auth-warning --user drilladmin --pass "$ADMIN_PW" "$@"
  else
    k -n cache exec deploy/redis -- redis-cli "$@"
  fi
}
cond_field() { # ns app field -> CacheCredentialsReady field
  k -n "$1" get nextapp "$2" -o jsonpath="{.status.conditions[?(@.type=='CacheCredentialsReady')].$3}" 2>/dev/null || true
}
wait_reason() { # ns app reason
  for _ in $(seq 1 90); do
    [ "$(cond_field "$1" "$2" reason)" = "$3" ] && return 0
    sleep 2
  done
  echo "timeout: $1/$2 reason is [$(cond_field "$1" "$2" reason)], wanted [$3]"
  k -n system logs deploy/controller-manager --tail=40 || true
  return 1
}
probe() { # ns pod args... -> redis-cli output (stderr merged), never fails the script
  local ns="$1" pod="$2"; shift 2
  k -n "$ns" exec "$pod" -- sh -c 'redis-cli --no-auth-warning -u "$REDIS_URL" "$@" 2>&1' sh "$@" || true
}
shared_probe() { # args... -> redis-cli against the OLD shared URL, from zone-b
  k -n zone-b exec probe -- sh -c 'redis-cli --no-auth-warning -u "$SHARED_URL" "$@" 2>&1' sh "$@" || true
}

echo "== build the operator image from this tree"
ARCH="$(go env GOARCH)"
mkdir -p "$WORK/img"
(cd "$OP" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -o "$WORK/img/manager" ./cmd)
printf 'FROM %s\nCOPY manager /manager\nENTRYPOINT ["/manager"]\n' "$BASE_IMAGE" >"$WORK/img/Dockerfile"
docker build -q -t "$OP_IMAGE" "$WORK/img" >/dev/null
docker image inspect "$REDIS_IMAGE" >/dev/null 2>&1 || docker pull -q "$REDIS_IMAGE" >/dev/null

echo "== kind cluster $CLUSTER"
kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
kind create cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG" --wait 180s >/dev/null
kind load docker-image "$OP_IMAGE" "$REDIS_IMAGE" --name "$CLUSTER" >/dev/null

echo "== CRDs (knext + Knative Serving CRDs only), Redis, operator"
k apply -f "$OP/config/crd/bases" >/dev/null
for f in service revision route configuration domain-mapping; do k apply -f "$SERVING/$f.yaml" >/dev/null; done
k create ns cache >/dev/null
k create ns system >/dev/null
k create ns zone-a >/dev/null
k create ns zone-b >/dev/null

cat <<YAML | k apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: { name: redis, namespace: cache }
spec:
  replicas: 1
  selector: { matchLabels: { app: redis } }
  template:
    metadata: { labels: { app: redis } }
    spec:
      containers:
      - name: redis
        image: $REDIS_IMAGE
        args: ["redis-server", "--save", "", "--appendonly", "no"]
        ports: [{ containerPort: 6379 }]
---
apiVersion: v1
kind: Service
metadata: { name: redis, namespace: cache }
spec:
  selector: { app: redis }
  ports: [{ port: 6379 }]
YAML
k -n cache rollout status deploy/redis --timeout=120s >/dev/null

rcli_admin ACL SETUSER drilladmin on ">$ADMIN_PW" '~*' '&*' +@all >/dev/null
ADMIN_READY=1

# The provisioner user, exactly the rule set the docs ship.
PROV_PW="prov-$(head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
rcli_admin ACL SETUSER provisioner on ">$PROV_PW" '~*' resetchannels -@all \
  +acl\|setuser +acl\|deluser +acl\|getuser +acl\|users +acl\|whoami +scan +del +ping +info\|server +client\|setinfo >/dev/null
k -n system create secret generic redis-provisioner \
  --from-literal=url="redis://provisioner:${PROV_PW}@redis.cache.svc.cluster.local:6379" >/dev/null

# The operator under the SHIPPED role and the SHIPPED write policy.
k apply -f "$OP/config/admission/secret-configmap-writes.yaml" -f "$OP/config/admission/secret-configmap-writes-binding.yaml" >/dev/null
cat <<YAML | k apply -f - >/dev/null
apiVersion: v1
kind: ServiceAccount
metadata: { name: controller-manager, namespace: system }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: controller-manager }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: manager-role }
subjects: [{ kind: ServiceAccount, name: controller-manager, namespace: system }]
YAML
k apply -f "$OP/config/rbac/role.yaml" >/dev/null
cat <<YAML | k apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: { name: controller-manager, namespace: system }
spec:
  replicas: 1
  selector: { matchLabels: { app: controller-manager } }
  template:
    metadata: { labels: { app: controller-manager } }
    spec:
      serviceAccountName: controller-manager
      containers:
      - name: manager
        image: $OP_IMAGE
        imagePullPolicy: Never
        args: ["--leader-elect=false", "--metrics-bind-address=0"]
        env:
        - name: POD_NAMESPACE
          valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
        - name: WRITE_POLICY_NAME
          value: secret-configmap-writes
YAML
k -n system rollout status deploy/controller-manager --timeout=180s >/dev/null

cat <<YAML | k apply -f - >/dev/null
apiVersion: platform.kn-next.dev/v1alpha1
kind: KnextPlatform
metadata: { name: default }
spec:
  cache:
    redisEndpoints:
    - endpoint: redis.cache.svc.cluster.local:6379
      provisionerSecretRef: { name: redis-provisioner, key: url }
YAML

DIGEST="sha256:$(printf '0%.0s' $(seq 1 64))"
app() { # ns name prefix [extra spec lines]
  cat <<YAML
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata: { name: $2, namespace: $1 }
spec:
  image: registry.example.com/app@$DIGEST
  cache:
    provider: redis
    url: ${URL_OVERRIDE:-redis://redis.cache.svc.cluster.local:6379}
    keyPrefix: $3
${4:-}
YAML
}
echo "== two apps on one Redis"
app zone-a web zone-a | k apply -f - >/dev/null
app zone-b web zone-b | k apply -f - >/dev/null
wait_reason zone-a web SharedCredentialLive
wait_reason zone-b web SharedCredentialLive

echo "== L1: no isolation claim while the shared credential is live"
MSG="$(cond_field zone-a web message)"
expect_contains "L1 message says isolation is not in force" "$MSG" "isolation not in force: shared credential live"
expect_not_contains "L1 message never claims 'isolated'" "$MSG" "isolated"

# Probe pods read REDIS_URL from the operator-owned Secret, as the app pod does.
for z in a b; do
  cat <<YAML | k apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: { name: probe, namespace: zone-$z }
spec:
  containers:
  - name: probe
    image: $REDIS_IMAGE
    command: ["sleep", "3600"]
    env:
    - name: REDIS_URL
      valueFrom: { secretKeyRef: { name: web-redis-credentials, key: REDIS_URL } }
    - name: SHARED_URL
      value: redis://redis.cache.svc.cluster.local:6379
YAML
done
k -n zone-a wait --for=condition=Ready pod/probe --timeout=120s >/dev/null
k -n zone-b wait --for=condition=Ready pod/probe --timeout=120s >/dev/null

echo "== L2: each app reaches only its own keyspace"
expect_eq "L2 A can SET its key" "$(probe zone-a probe SET zone-a:k va)" "OK"
expect_eq "L2 B can SET its key" "$(probe zone-b probe SET zone-b:k vb)" "OK"
expect_eq "L2 A can GET its key" "$(probe zone-a probe GET zone-a:k)" "va"
expect_contains "L2 A is refused on B's key (GET)" "$(probe zone-a probe GET zone-b:k)" "NOPERM"
expect_contains "L2 A is refused on B's key (SET)" "$(probe zone-a probe SET zone-b:k x)" "NOPERM"
expect_contains "L2 A is refused on B's key (DEL)" "$(probe zone-a probe DEL zone-b:k)" "NOPERM"
expect_contains "L2 B is refused on A's key (GET)" "$(probe zone-b probe GET zone-a:k)" "NOPERM"
expect_contains "L2 A is refused KEYS" "$(probe zone-a probe KEYS '*')" "NOPERM"
expect_contains "L2 A is refused FLUSHALL" "$(probe zone-a probe FLUSHALL)" "NOPERM"
expect_contains "L2 A is refused INFO" "$(probe zone-a probe INFO)" "NOPERM"
expect_contains "L2 A is refused ACL" "$(probe zone-a probe ACL LIST)" "NOPERM"
expect_eq "L2 B's key survived A's attempts" "$(rcli_admin GET zone-b:k)" "vb"

echo "== L3: the password lives only in the operator-owned Secret"
PW="$(k -n zone-a get secret web-redis-credentials -o jsonpath='{.data.REDIS_URL}' | base64 -d | sed -E 's#^redis://[^:]+:([^@]+)@.*#\1#')"
[ -n "$PW" ] && ok "L3 read the app password from the Secret" || bad "L3 no password"
SURFACE="$(k -n zone-a get nextapp web -o yaml; k -n zone-a get events -o yaml)"
expect_not_contains "L3 password absent from NextApp and Events" "$SURFACE" "$PW"
expect_eq "L3 Secret is Opaque" "$(k -n zone-a get secret web-redis-credentials -o jsonpath='{.type}')" "Opaque"
expect_eq "L3 Secret is owned by the NextApp" "$(k -n zone-a get secret web-redis-credentials -o jsonpath='{.metadata.ownerReferences[0].kind}')" "NextApp"
SPEC_URL="$(k -n zone-a get nextapp web -o jsonpath='{.spec.cache.url}')"
expect_not_contains "L3 spec.cache.url carries no credential" "$SPEC_URL" "@"

echo "== L4: the old shared URL still reads A's keys (the hole)"
expect_eq "L4 shared URL reads zone-a:k" "$(shared_probe GET zone-a:k)" "va"

echo "== L5: close the shared credential, then observe it refused"
rcli_admin ACL SETUSER default off >/dev/null
OUT="$(shared_probe GET zone-a:k)"
case "$OUT" in *NOAUTH*|*WRONGPASS*|*NOPERM*) ok "L5 shared URL refused on zone A's keys: $OUT" ;; *) bad "L5 shared URL not refused: $OUT" ;; esac
OUT="$(shared_probe --user default --pass nope GET zone-a:k)"
case "$OUT" in *WRONGPASS*|*NOAUTH*|*NOPERM*) ok "L5 AUTH default refused: $OUT" ;; *) bad "L5 AUTH default not refused: $OUT" ;; esac
expect_eq "L5 app A still works under its own user" "$(probe zone-a probe GET zone-a:k)" "va"
# Nudge a reconcile (a spec change; the operator re-probes on every pass).
k -n zone-a patch nextapp web --type=merge -p '{"spec":{"env":{"DRILL_NUDGE":"1"}}}' >/dev/null
k -n zone-b patch nextapp web --type=merge -p '{"spec":{"env":{"DRILL_NUDGE":"1"}}}' >/dev/null
wait_reason zone-a web Provisioned
wait_reason zone-b web Provisioned
expect_not_contains "L5 observed-refused message" "$(cond_field zone-a web message)" "not in force"

echo "== L6: isolation=acl on an unregistered endpoint fails closed"
URL_OVERRIDE=redis://other.cache.svc.cluster.local:6379 app zone-a unreg zone-a-unreg "    isolation: acl" | k apply -f - >/dev/null
wait_reason zone-a unreg EndpointUnregistered
expect_eq "L6 no Secret was created" "$(k -n zone-a get secret unreg-redis-credentials -o name 2>/dev/null || true)" ""

echo "== L7: a nested prefix fails closed"
app zone-a nested "zone-a:sub" | k apply -f - >/dev/null
wait_reason zone-a nested PrefixConflict
expect_eq "L7 no Secret was created" "$(k -n zone-a get secret nested-redis-credentials -o name 2>/dev/null || true)" ""
USERS="$(rcli_admin ACL USERS)"
[ "$(printf '%s\n' "$USERS" | grep -c '^knext-app-')" = "2" ] && ok "L7 only the two real apps have users" || bad "L7 unexpected users: $USERS"

echo "== L8: deleting an app sweeps its keys and removes its user"
USER_A="$(k -n zone-a get nextapp web -o jsonpath='{.status.cache.username}')"
expect_contains "L8 user exists before delete" "$(rcli_admin ACL USERS)" "$USER_A"
k -n zone-a delete nextapp web --wait=true --timeout=120s >/dev/null
expect_not_contains "L8 ACL user removed" "$(rcli_admin ACL USERS)" "$USER_A"
expect_eq "L8 A's keys swept" "$(rcli_admin EXISTS zone-a:k)" "0"
expect_eq "L8 B's keys untouched" "$(rcli_admin EXISTS zone-b:k)" "1"

echo
echo "passed: $PASS  failed: $FAILED"
[ "$FAILED" = "0" ]
