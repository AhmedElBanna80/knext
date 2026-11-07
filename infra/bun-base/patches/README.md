# Patches applied on top of `../UPSTREAM_SHA`

Empty on purpose unless an upstream fix needs verifying ahead of a Bun release. Current:

- `001-bun-45007-const-assign.patch` — oven-sh/bun#45010 (fixes oven-sh/bun#45007), backported
  onto `bun-v1.4.2`: an assignment to a `const` in code that never runs is a runtime TypeError, not a
  load-time error. Verifies the Turbopack module-fragments chunks load on the compat bun lane.
  Retires the `turbopack-fragments-guard` refusal once a stock Bun release carries it.

- Format: `git format-patch` output against `UPSTREAM_SHA`, applied with `git am` in filename order.
- One patch per upstream issue: `<nnn>-<upstream-issue>-<slug>.patch`,
  e.g. `001-bun-44059-compile-include.patch`.
- The patch header (the commit message `git format-patch` writes) MUST name the upstream issue or PR
  (`oven-sh/bun#NNNNN`) and the F1 shim-registry id it retires (`knext-shim: <id>`).
  `infra/bun-base/build.sh` refuses a patch missing either line.
- Delete the patch in the same PR that bumps `UPSTREAM_SHA` past the upstream merge.
