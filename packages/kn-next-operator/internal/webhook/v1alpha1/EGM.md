# internal/webhook/v1alpha1

## Overview
The validating admission webhook for `NextApp`. It rejects invalid specs before the API server persists them, delegating to `internal/validation`, and applies the KnextPlatform's connection budget when the platform layer is installed.

## Interface
- `nextapp_webhook.go:SetupNextAppWebhookWithManager(mgr) error`: registers the validator. It sets `Platform = mgr.GetAPIReader()` only when `platformv1alpha1.CRDInstalled` reports the CRD as installed.
- `nextapp_webhook.go:NextAppCustomValidator{Platform client.Reader}` implements `admission.Validator[*NextApp]`:
  - `ValidateCreate` calls `validation.ValidateNextAppSpecCreateWithBudget`;
  - `ValidateUpdate` calls `validation.ValidateNextAppSpecUpdateWithBudget`;
  - `ValidateDelete` is a no-op.
- Webhook marker: path `/validate-apps-kn-next-dev-v1alpha1-nextapp`, `mutating=false`, `failurePolicy=fail`, `sideEffects=None`, verbs `create;update`, name `vnextapp-v1alpha1.kb.io`.
- `budget_fallback_metric.go:budgetFallbackTotal`: the counter `knext_platform_budget_fallback_total{cause}`, where `cause` is `read_error` or `platform_invalid`.

## Invariants
- `nextapp_webhook.go:connectionBudget` returns `validation.MaxAppConnections` when any of these is true:
  - `Platform` is nil;
  - the KnextPlatform is missing (NotFound or NoMatch);
  - it cannot be read;
  - it fails `ValidatePlatformSpec`;
  - it sets no positive `database.connectionBudget`.

  Only the read-error and invalid-platform cases are counted on the metric.
- `nextapp_webhook.go:ValidateUpdate` admits any object with a `deletionTimestamp`, so finalizer-removal patches can never wedge it in Terminating. It also admits metadata-only updates where the specs are `equality.Semantic.DeepEqual`.
- `nextapp_webhook.go:SetupNextAppWebhookWithManager` fails setup on a discovery error other than no-match.
- `NextAppCustomValidator.Platform` is an uncached reader: one GET of the singleton per admission and no KnextPlatform informer.

## Side Effects
- One uncached GET of the cluster-scoped `KnextPlatform` named `default` per admission (when installed).
- Logs through `nextapp-webhook` and increments `knext_platform_budget_fallback_total`. Both causes are pre-initialized to 0 in `init`.

## Verification
- Run: `make test` (in `packages/kn-next-operator`). The webhook suite uses envtest. Unit tests also run via `go test ./internal/webhook/...`.
