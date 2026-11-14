---
'@getknext/core': minor
---

A zone built on the default or Bun standalone target now wakes its bound functions when it starts (not yet a vinext-target zone). Before Next.js boots, the runtime sends one `GET /healthz` to each function listed in `KNEXT_WAKE_FUNCTIONS`, so a function scaled to zero starts waking while the zone boots. The calls never delay the zone's health check or its shutdown drain, give up after one second, and are switched off for a whole zone with `KNEXT_WAKE_AHEAD=0` (or per function with `wakeAhead: false`).
