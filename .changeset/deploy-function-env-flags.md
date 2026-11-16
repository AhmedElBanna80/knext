---
"@getknext/grpc": minor
---

`knext deploy function` now sets a function's environment and mounts: repeatable `--env NAME=value`, `--env-secret NAME=<secret>/<key>`, `--env-configmap NAME=<configmap>/<key>`, `--env-from secret:<name>|configmap:<name>`, `--volume` and `--image-pull-secret <name>`. Secrets are passed by reference only: a plain `--env` whose name looks like a secret is refused, and a refused value is never echoed.
