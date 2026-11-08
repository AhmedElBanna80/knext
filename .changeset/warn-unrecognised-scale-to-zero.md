---
"@getknext/lib": patch
---

An unrecognised `KNEXT_DB_SCALE_TO_ZERO` value (a typo such as `ture`) now logs one warning per distinct value per process naming the value and the fallback to the `DATABASE_URL` host. A value that looks like a connection string is shown only by its length. Recognised values, empty values and an unset variable stay silent, and the fallback itself is unchanged.
