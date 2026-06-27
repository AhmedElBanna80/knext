# ADR-0017: NextApp CRD stays v1alpha1; conversion webhook deferred

- Status: Accepted
- Date: 2026-06-27
- Deciders: knext architect
- Related: ADR-0001 (operator = single source of truth), ADR-0008 (finalizer + reconcile predicate),
  ADR-0016 (status-condition deferral pattern), issue #145 (honest Ready + printcolumns),
  the production-hardening scorecard ("no v1alpha1 stability story") and operator-robustness GAP 3

## Context

The NextApp CRD is served at **`apps.kn-next.dev/v1alpha1`**
(`packages/kn-next-operator/api/v1alpha1/groupversion_info.go:29` →
`GroupVersion = schema.GroupVersion{Group: "apps.kn-next.dev", Version: "v1alpha1"}`;
`+groupName=apps.kn-next.dev` on the package). It is the **only** served version. **No conversion
webhook exists** — there is no second API version to convert between, and none is wired into the
manager.

Two reviews flagged the same gap from opposite angles:

- the **production-hardening scorecard** records "no v1alpha1 stability story" — nothing tells a
  user what is or is not safe to depend on across releases;
- **operator-robustness GAP 3** asks whether the CRD should graduate (v1beta1/v1 + conversion
  webhook) before adopters arrive.

knext is **fame-first, pre-1.0, and pre-external-adoption** (no npm publish yet; verified-adapter
status is the north star). The honest question is not "is the schema perfect" but "what stability do
we actually owe today, and to whom." Right now: nobody external depends on the API version.

What users *do* rely on today is not an API-version guarantee — it is the operator's **honest status
contract**: `.status.conditions[Ready]` is now gated on the **child Knative Service's own** real
readiness (issue #145; `nextapp_controller.go` "Honest Ready" gate, ~L615), and the CRD exposes
`URL` / `Ready` / `Age` **printcolumns** (#145; `nextapp_types.go:287-289`). That is the surface a
deployer reads to know whether their app is actually up.

## Decision

**Stay at `v1alpha1` for now. Do NOT build a conversion webhook yet.**

- The CRD remains single-version `apps.kn-next.dev/v1alpha1`. No `v1beta1`/`v1`, no
  `+kubebuilder:storageversion`/conversion machinery added.
- **Breaking CRD changes are acceptable at alpha** and will be **called out in release notes**.
  Kubernetes API convention is explicit that `vNalphaM` carries no compatibility guarantee; we honor
  that contract honestly rather than implying stability we do not provide.
- The **interim stability surface** users may rely on is the **status contract**, not the API
  version: honest `Ready` gating (#145) and the `URL`/`Ready`/`Age` printcolumns (#145). Those are
  what observability and CI/CD glue should key off.
- **Revisit trigger:** build the conversion webhook and graduate to `v1beta1`/`v1` **when real
  external adopters depend on API stability** — i.e. **after** verified-adapter status / npm publish,
  not before.

## Options considered

| Option | What | Pros | Cons | Verdict |
| --- | --- | --- | --- | --- |
| (a) Stay v1alpha1, no webhook | Keep single-version CRD; breaking changes allowed + noted in release notes; status contract is the interim stability surface | Honest about the (lack of) guarantee; zero build cost; keeps scope narrow/fame-first; matches the no-adopters reality | No cross-version migration safety net (acceptable: nothing to migrate, no one depends on it) | **Chosen** |
| (b) Graduate to v1beta1 + conversion webhook now | Add a 2nd version + conversion webhook, cert wiring, storage-version handling | Signals maturity; future-proofs migrations | Premature: real build + TLS/webhook ops cost with **no adopters** whose stability it would protect; couples to webhook cert infra before it's needed | Rejected (now) |
| (c) Freeze the schema as-is informally | Stop making breaking changes but add no versioning machinery | Cheap | **Worst** — implies a stability guarantee we do not actually provide or test; pins design mistakes pre-adoption with no upgrade path | Rejected |

**Recommendation: (a).** It is the only option that is honest about today's reality (no external
adopters, alpha API) while leaving a clean, well-understood upgrade path (option b) for the moment
real adopters need it.

## Consequences

- **Scope stays narrow / fame-first.** No webhook cert plumbing, no second API version to maintain,
  no `make manifests` churn — the operator keeps reconciling one version.
- **We are honest about no API-stability guarantee yet.** Release notes own breaking CRD changes;
  users are told the API is alpha and the *status contract* (Ready gating + printcolumns) is the
  surface to build on.
- **A clean graduation path remains.** When adopters depend on API stability, option (b) is the
  understood next step: add `v1beta1`, mark a storage version, ship a conversion webhook, and
  deprecate `v1alpha1` on the standard Kubernetes timeline.
- **Trade-off accepted:** if we ship a breaking schema change before graduation, existing CRs may
  need a hand-edit; acceptable at alpha and documented in the release notes, vs. paying webhook cost
  now for adopters who don't exist.

## Action items

- [x] Record the deferral: CRD stays `apps.kn-next.dev/v1alpha1`, no conversion webhook (this ADR).
- [x] Interim stability surface documented as the **status contract** — honest `Ready` gating and
      `URL`/`Ready`/`Age` printcolumns (#145) — not the API version.
- [ ] Revisit (post-adoption): add `v1beta1`/`v1` + a conversion webhook and a deprecation timeline
      **when real external adopters depend on API stability** (after verified-adapter / npm publish).
- [ ] Until then: call out any breaking CRD schema change in release notes.
