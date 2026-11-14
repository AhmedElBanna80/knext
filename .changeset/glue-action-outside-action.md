---
"@getknext/grpc": patch
---

A generated Server Action called from a Route Handler no longer reports a successful write as a failure. Next.js allows `updateTag` only inside a Server Action, so the action used to throw after the write had committed. It now uses `updateTag` in a Server Action and `revalidateTag(tag, { expire: 0 })` elsewhere, so the cached reads are refreshed either way and the write's result is returned.
