# The operator write policy on a pre-1.30 server (kind, 2026-11-15)

What the install bundle and the operator actually do on Kubernetes 1.29, where
`admissionregistration.k8s.io/v1` does not serve `ValidatingAdmissionPolicy`
(it is v1beta1 there, behind a feature gate that is off by default). Measured,
not inferred, for #2486 item 2. Items 1 (the bundle on OKE refusing a
foreign-name write) and 3 (Argo CD / Flux diffing of the two cluster-scoped
objects) are not covered here.

## Setup

- kind v0.29.0, node image `kindest/node:v1.29.14`
  (`sha256:8703bd94ee24e51b778d5556ae310c6c0fa67d761fae6379c8e0bb480e6fea29`),
  server `v1.29.14`.
- Bundle: `kubectl kustomize packages/kn-next-operator/config/default` from
  integration/v2 at `1aad0e2c8` (28 objects, including one
  `ValidatingAdmissionPolicy` and one `ValidatingAdmissionPolicyBinding`).
- Prerequisites installed first, as the install docs require:
  cert-manager (`scripts/kind-manifests/apply-cert-manager.sh`, webhook rolled
  out) and Knative Serving + Kourier
  (`scripts/kind-manifests/apply-knative-kourier.sh knative-v1.16.0`).
- Operator image: the one the Z7 kind lane builds from the same tree
  (`example.com/kn-next-operator:z7-build`), loaded into the cluster.

## Results

1. `kubectl api-resources --api-group=admissionregistration.k8s.io | grep validatingadmissionpolicies`
   prints nothing and exits 1. The upgrade page's preflight line is right.
2. `kubectl apply -f install.yaml` **exits 1**. Its stderr holds exactly two errors:

   ```text
   resource mapping not found for name: "kn-next-operator-secret-configmap-writes" namespace: "" from "install.yaml": no matches for kind "ValidatingAdmissionPolicy" in version "admissionregistration.k8s.io/v1"
   ensure CRDs are installed first
   resource mapping not found for name: "kn-next-operator-secret-configmap-writes" namespace: "" from "install.yaml": no matches for kind "ValidatingAdmissionPolicyBinding" in version "admissionregistration.k8s.io/v1"
   ensure CRDs are installed first
   ```

   Every other object applies: the three CRDs, the RBAC, the Deployment, the
   webhook configuration and the cert-manager objects.
3. `kubectl apply --server-side` behaves the same way: exit 1, with the same two
   `no matches for kind` errors.
4. The operator starts and serves. It logs that the restriction is off:

   ```text
   INFO write-policy WARNING: the operator write policy is NOT in force; the operator can write any Secret or ConfigMap its RBAC allows {"policy": "kn-next-operator-secret-configmap-writes", "reason": "PolicyMissing", ...}
   ```

## What changed in the docs

The pages said the apply "reports `no matches for kind "ValidatingAdmissionPolicy"`
for the two policy objects", naming only the policy's error. The binding's
error names `ValidatingAdmissionPolicyBinding`, and none of the pages
said the apply exits with status 1, which stops any install script that fails
on the first error. `security.mdx`, `support-matrix.mdx` and
`operator-upgrade.mdx` now say both, and the security page names the
operator's `PolicyMissing` warning.

## Reproduce

```sh
kind create cluster --name knext-pre130 --image kindest/node:v1.29.14
scripts/kind-manifests/apply-cert-manager.sh
scripts/kind-manifests/apply-knative-kourier.sh knative-v1.16.0
kubectl -n cert-manager rollout status deploy/cert-manager-webhook
kubectl kustomize packages/kn-next-operator/config/default > install.yaml
kubectl apply -f install.yaml; echo "exit=$?"
```
