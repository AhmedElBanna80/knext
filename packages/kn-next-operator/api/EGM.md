# api

## Overview
The operator's CRD Go types, split by API group. Controller-gen markers in these packages produce the CRD manifests and deepcopy code (`make manifests generate`).

## Subdirectories & Boundaries
- v1alpha1: [./v1alpha1/EGM.md](./v1alpha1/EGM.md) - `apps.kn-next.dev/v1alpha1`: the namespaced `NextApp` (a zone) and `BackendService` (a zone function) kinds, their CEL validation rules, and `BackendServiceCRDInstalled`.
- platform: [./platform/EGM.md](./platform/EGM.md) - `platform.kn-next.dev`: the cluster-scoped `KnextPlatform` singleton that supplies defaults for fields a NextApp leaves unset.
