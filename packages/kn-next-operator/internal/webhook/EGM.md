# internal/webhook

## Overview
Groups the operator's admission webhooks by API version.

## Subdirectories & Boundaries
- v1alpha1: [./v1alpha1/EGM.md](./v1alpha1/EGM.md) - The `NextApp` validating webhook (`failurePolicy=fail`, create and update). It delegates to `internal/validation` and applies the KnextPlatform connection budget, falling back to the built-in budget.
