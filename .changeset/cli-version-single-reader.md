---
"@getknext/core": patch
---

The CLI now reads its own version in one place. If it cannot read its own `package.json`, `knext --version` prints `unknown` instead of `0.0.0`, and `knext doctor` warns that the CLI version is unknown instead of silently skipping the operator pairing check. A build whose CLI version cannot be read now fails with a clear message instead of being stamped as `0.0.0`, which made every CLI version produce the same build stamp and let a stale cached build look fresh.
