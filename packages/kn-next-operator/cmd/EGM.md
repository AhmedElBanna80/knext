# cmd

## Overview
The operator's controller-manager entry point. It builds the scheme, parses flags, configures the metrics, webhook and health servers, and registers the controllers, the NextApp admission webhook and the write-policy self-check on a controller-runtime manager.

## Interface
- `main.go:main`, with these flags: `--metrics-bind-address` (default `0`), `--health-probe-bind-address` (`:8081`), `--leader-elect` (default `false`), `--metrics-secure` (default `true`), `--webhook-cert-path` (default empty) / `--webhook-cert-name` (`tls.crt`) / `--webhook-cert-key` (`tls.key`), `--metrics-cert-path` / `--metrics-cert-name` (`tls.crt`) / `--metrics-cert-key` (`tls.key`), `--enable-http2` (default `false`), `--zone-signing-key-propagation-bound` (default `controller.DefaultZoneKeyPropagationBound`), `--zone-signing-key-rotation-interval` (default `0`), `--write-policy-name` and `--write-policy-check-interval` (default `writepolicy.DefaultInterval`).
- `main.go:init`: registers the client-go, `apps.kn-next.dev/v1alpha1`, `platform.kn-next.dev/v1alpha1`, Knative `serving/v1` and `serving/v1beta1` schemes.
- `main.go:configuredRestConfig`: copies the rest config and sets `UserAgent = controller.OperatorFieldManager`.
- `main.go:buildManagerOptions`: sets `LeaderElectionID = leaderElectionID` (`2dd0b3e2.kn-next.dev`) and `LeaderElectionReleaseOnCancel: true`.
- `main.go:setupHealthChecks(mgr, webhookEnabled)`: `/readyz` also gates on `webhook-started` when the webhook is enabled.
- `main.go:writePolicyNameDefault`: uses `$WRITE_POLICY_NAME`, else `secret-configmap-writes`.
- `main.go:addWritePolicyMonitor`: adds a `writepolicy.Monitor` backed by `writepolicy.NewClientSource`.
- Subdirectory: policygen: [./policygen/EGM.md](./policygen/EGM.md) - renders the operator's NetworkPolicy and function objects for the enforcement drill.

## Invariants
- `main.go:leaderElectionID` must stay stable across releases. A changed ID would let an old and a new revision each hold a lease and reconcile at the same time (single writer).
- `main.go:main` registers the NextApp webhook (`webhookv1alpha1.SetupNextAppWebhookWithManager`) only when `--webhook-cert-path` is set. `setupHealthChecks`'s `webhookEnabled` must mirror that same condition.
- `main.go:buildManagerOptions`: `LeaderElectionReleaseOnCancel` is safe only because `main` does no work after `mgr.Start` returns.
- `main.go:main`: controller wiring goes through `controller.SetupControllers`, which is the single place that decides which reconcilers run, with `controller.WithZoneSigningKeyConfig`.
- `main.go:addWritePolicyMonitor`: a failed or negative write-policy check never blocks start-up. Only a failure to build the reader (`writepolicy.NewClientSource`) exits.
- `main.go:main`: unless `--enable-http2` is set, the metrics and webhook TLS servers are limited to `http/1.1` (HTTP/2 Rapid Reset mitigation).
- `main.go:main`: with `--metrics-secure`, the metrics endpoint is wrapped in `filters.WithAuthenticationAndAuthorization`.
- `main.go:setupHealthChecks`: `/healthz` is always a plain ping, so a pod waiting for its webhook certificate stays alive but NotReady.

## Side Effects
- Binds the metrics, health-probe and (with certs) webhook TLS listeners. Contends for a coordination.k8s.io Lease when `--leader-elect` is set.
- Every API write the process makes is attributed to the `OperatorFieldManager` UserAgent in `managedFields`.
- Exits 1 on any setup failure.

## Verification
- Run: `make test` (in `packages/kn-next-operator`), or `go test ./cmd/...`.
