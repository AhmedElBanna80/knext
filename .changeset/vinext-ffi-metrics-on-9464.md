---
'@getknext/core': patch
---

On the vinext single-executable build, an app that calls Rust in-process now serves `knext_ffi_slow_calls_total` and `knext_ffi_load_seconds` on the metrics port, as the standalone build already did. Before, the slow-call log line worked but the counters never reached `:9464`. On both builds only those two families pass from the generated module, and an app without in-process Rust serves the same metrics as before.
