---
"@getknext/core": patch
---

A vinext server whose `PORT` is already taken now says so and exits non-zero. The scaffolded `knext-node-entry.mjs` and `knext-bun-entry.mjs` print `[knext] failed to bind the app listener on <host>:<port>` and exit 1, and never exit 0 before the app listener is up, whatever `srvx` version sits underneath. Re-scaffold or copy the new entry file into an existing app to get it; `knext doctor` flags a stale node entry.
