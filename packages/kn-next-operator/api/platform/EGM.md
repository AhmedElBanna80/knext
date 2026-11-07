# api/platform

## Overview
Groups the versioned Go API for the cluster-scoped `platform.kn-next.dev` group.

## Subdirectories & Boundaries
- v1alpha1: [./v1alpha1/EGM.md](./v1alpha1/EGM.md) - The `KnextPlatform` singleton (`SingletonName = "default"`): cluster-wide scaling, resource, limit, database connection-budget and rollout defaults, plus the `CRDInstalled` discovery probe.
