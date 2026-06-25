# Learnings from `coollabsio/coolify` (for knext)

> Source: github.com/coollabsio/coolify (v4.x, ~57k★, Laravel/PHP). Fetched 2026-06-18 — README +
> repo structure. Feature-UX specifics live in coolify.io/docs (not fetched); treat those as
> "Coolify's general capabilities", not verified detail. knext strategy (CLAUDE.md §1): **borrow the
> business model, reject the product category.**

## What Coolify IS (so we know what NOT to copy)
A self-hostable, **general Docker/Compose PaaS over SSH** — Heroku/Netlify/Vercel alternative that
deploys static sites, DBs, full-stack apps, and **280+ one-click services** to any VPS/bare-metal/RPi.
**Always-on containers**, SSH-orchestrated, Laravel/PHP + queues. This is the **opposite** of knext's
narrow **Knative + scale-to-zero + official Next.js adapter** focus. Do NOT become "Coolify for k8s" —
the breadth (any app, any service, multi-server SSH) is exactly the scope drift to resist.

## BORROW — the business model (CLAUDE.md says so)
- **Open-core / sponsorware, no feature paywall.** 100% open source; *nothing* gated. Monetize a
  **managed Cloud** (app.coolify.io) that sells **operational value** — HA, notifications, support,
  "less maintenance for you" — not features. Plus **donations + sponsor logos**. → knext's later
  path: core (adapter + operator) fully open; monetize a hosted/managed control plane + support,
  never gate adapter capabilities.
- **"No vendor lock-in" as a headline trust lever** — "your configs are saved to your server; stop
  using us and your resources still run, you just lose the magic." → knext's analog: CRs/manifests
  are yours, operator-managed but portable (ties to **ADR-0005 cloud-agnostic**). Make portability a
  marketing feature, not just an architecture note.
- **Fame flywheel** (matches knext's fame-first thesis): HN / Product Hunt / Trendshift launches +
  visible sponsor wall + a named maintainer persona. Social proof compounds adoption.

## BORROW — DX patterns (feature-level, map to the maturity backlog) — not the category
- **One-command onboarding** (`curl | bash`). → knext: frictionless `npx kn-next` + a one-command
  operator install (backlog **P1-2**, **A6** install). Lowest-friction first-run is a growth lever.
- **Templates / one-click services** (280+). → knext's narrow analog: **zone/service templates** (the
  SCS `generate zone` end-goal), not a general service catalog.
- **Previews · rollback · env/secrets · git-push-to-deploy** are Coolify table-stakes — they validate
  the demand + UX bar for knext's **Tier-B B3** (previews/rollback/skew) and **B1** (secrets/auth).
  Study Coolify's UX as the target, deliver it on the Knative/revision primitive (rollback = revision
  traffic split, previews = ephemeral `NextApp` CR) — a *better* substrate than Compose.

## NOTE — repo/process patterns worth copying
- **In-repo AI-agent harness:** Coolify ships `.claude/skills`, `.agents/skills`, `.cursor`, `.codex`
  — a 57k★ project invests in multi-tool agent harness. Validates knext's own `.claude/` harness
  bet; consider multi-tool parity if contributors use other agents.
- **In-repo `backlog/` + `changelogs/` dirs** — structured planning + release notes live in the repo.
  knext already has `docs/maturity/BACKLOG.md`; add a `changelogs/` discipline when wiring changesets
  (**P1-2**).

## The one-line synthesis
Coolify is the **proof that open-core + managed-cloud + no-lock-in + fame-funnel works at scale** —
copy that *motion*. Its *product* (general always-on PaaS) is the anti-pattern for knext: our wedge is
the **verified, scale-to-zero Next.js-on-Knative adapter**, and breadth would dilute it. Borrow the
go-to-market and the DX bar; keep the narrow technical moat.
