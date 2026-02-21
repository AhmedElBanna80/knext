---
description: Root Cause Analysis policy — every deployment bug must produce a preventive framework fix
---

# Root Cause Analysis (RCA) Policy

When any deployment, runtime, or build problem is encountered, follow this process **before** moving on:

## 1. Diagnose — Identify the Root Cause
- Do NOT apply quick workarounds (e.g. manual file patches, ad-hoc kubectl commands)
- Trace the error to its **root cause** (e.g. "K8s sets HOSTNAME to pod name → Next.js binds to it → queue-proxy can't reach 127.0.0.1:3000")
- Document: What failed? Why? What was the trigger?

## 2. Fix — Implement a Preventive Safeguard in the Framework
- The fix must be in the **kn-next framework code** (not in the app code or manual steps)
- The framework must handle this automatically for **all future deployments**
- If the fix is in a generator (manifest, entrypoint, Dockerfile), all generated outputs must include it
- If the fix is a post-build patch, add it to `deploy.ts` pipeline

## 3. Verify — Ensure the Fix Works
- Run `npx tsc --noEmit` to verify TypeScript compiles
- Run `bun test` to verify existing tests still pass
- Add a test for the new safeguard if applicable
- Verify the fix works end-to-end in a real deployment

## 4. Document — Update the Walkthrough
- Add the bug, root cause, and fix to the walkthrough artifact
- Include the table format:

| Bug | Root Cause | Preventive Fix |
|-----|-----------|----------------|
| Description | Why it happened | What was added to the framework |

## Examples of Past RCAs

| Bug | Root Cause | Preventive Fix |
|-----|-----------|----------------|
| `MODULE_NOT_FOUND: babel/code-frame` | Next.js 16 standalone trace omits redirect file in pnpm monorepos | `patchStandaloneOutput()` in `deploy.ts` auto-creates missing redirects |
| Server binds to pod hostname | K8s sets `HOSTNAME` to pod name; Next.js uses it as bind address | `HOSTNAME=0.0.0.0` injected in both manifest generator and entrypoint generator |
| Missing assets in GCS after upload | `gsutil cp -r` silently misses files | Post-upload verification in `uploadAssets()` detects and retries missing files |
