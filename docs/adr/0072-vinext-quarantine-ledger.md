# ADR-0072: The vinext quarantine ledger's cap is frozen at its entry count and only ratchets down

- **Status:** **Proposed (2026-11-17).** Design only. Nothing in code, tests, workflows or docs changes
  when this ADR merges. Acceptance is a founder/sprint-close decision, and it **amends ADR-0007**
  (see Consequences), so it cannot take effect by merging this file.
- **Task:** v2 Sprint 7, S7-9, v2 GA exit V0a.
- **Relates to:** ADR-0007 (the per-file ledger's 15-file bound is a founder constraint there), ADR-0070
  (the Bun single-executable Stable bar; it names the two bounded ledgers), ADR-0048 (vinext single
  executable as the only vinext target), ADR-0051 (vinext lanes are ESM-only),
  [`docs/compat/bar-vinext-axis.md`](../compat/bar-vinext-axis.md) (the vinext Stable bar, V-C1 to V-C3).
- **Trigger class:** ADR (a new Proposed ADR that changes a ledger bound).

## Context

The vinext × Bun lane (`compat-vinext.yml`) runs the official corpus unchanged. Its denominator never
narrows. `scripts/compat-vinext-ledger.mjs` reclassifies failing **cases** after the run: a failing
case in a quarantined file moves to `quarantined`, and a new failing case in such a file stays a real
failure. Two bounds apply to that per-file ledger (`test/compat-vinext-ledger.json`):

- a **file cap**: `LEDGER_FILE_CAP = 15` in `scripts/compat-vinext-ledger.mjs`, asserted at
  `tests/compat-vinext-ledger.test.ts:129` and `tests/compat-vinext-structural-gaps.test.ts:931-939`;
- a **30-day expiry** per entry (`MAX_EXPIRY_DAYS = 30`).

The measured state at the commit that adds this ADR (2026-11-17), counted by parsing the JSON:
**8 entries**, all `class: unsupported`, all with `expires: 2026-11-26`. The cap of 15 is therefore a
ceiling with **7 unused slots**. Today an entry can be added to the JSON with no decision record beyond
its review. The only brake is the constant, and the constant can move without an ADR. The cap is a
number that moves, not a count that is tied to evidence.

ADR-0007 already rejected widening a bound to absorb a gap: it says that "a quarantine that can absorb
a whole architectural gap by raising a number is not a quarantine". The **structural-gap ledger** that
ADR-0007 added to hold 49 client-router files uses the pattern this ADR proposes for the per-file
ledger: a cap **frozen at the number first recorded, which only goes down**. Raising it needs an
amendment. The per-file ledger has no such rule, so its cap can rise by a constant change alone.

## Decision

1. **The per-file vinext ledger's cap is frozen at 8**, the number of entries in
   `test/compat-vinext-ledger.json` at the commit that adopts this ADR. The number is the **actual
   count**, not the 15-file ceiling.
2. **The cap ratchets DOWN only.** Lowering it is routine, as entries are fixed, removed or expire.
   Raising it, or adding an entry beyond the cap, requires a new amendment to this ADR, and that
   amendment requires the ADR-0007 amendment described under Consequences.
3. **The cap applies to vinext lanes only.** `LANES` stays `['bun-vinext']`. The four stable credential
   cells (node/bun × turbopack/webpack) never read or freeze this ledger. The structural-gap ledger
   (`test/compat-vinext-structural-gaps.json`, cap 41) is a separate ledger, governed by ADR-0007 and
   not by this ADR.
4. **Until this ADR is accepted, nothing changes.** The 15 in `LEDGER_FILE_CAP`, the 15-file text in
   ADR-0007 and ADR-0070, and `bar-vinext-axis.md` stay as they are. On acceptance they are replaced by
   8, as Action items 2 to 4 describe.

## Options considered

| Option | Cap | Ratchet | Gain | Cost |
|---|---|---|---|---|
| **A. Freeze at the current count (8), ratchet down only** (recommended) | 8 | down only | The count cannot grow without an amendment, which matches the structural-gap ledger and ADR-0007's own rule. The cap is tied to evidence. | 7 slots lost. A new unsupported file in the next 9 days needs an amendment. Contradicts the founder's 15 in ADR-0007, so acceptance needs an ADR-0007 amendment. |
| B. Keep 15 (status quo) | 15 | none | No change, no amendment. | 7 silent additions possible through a constant change. The number is not tied to evidence. |
| C. Freeze at 15, ratchet down only | 15 | down only | Keeps the founder number and adds the ratchet. | The ceiling still allows 7 additions with no amendment, so this is not a freeze. |
| D. Drop the count cap, keep the 30-day expiry | none | none | Simplest. | Expiry bounds each entry's time, not the total. Entries can be renewed indefinitely, so the quarantine can grow without limit. |

Option A is recommended because it is the only one where the count can change only with a recorded
decision. Its cost is real and visible: 7 slots go, and the first new quarantine needs an amendment.

**Known residual:** a count freeze does not stop a swap, where one entry is removed and another added.
Each entry still needs its per-entry evidence (two failing runs, a named unsupported feature, an
upstream issue). The guard cannot see intent, so the reviewer of any ledger change checks the swap
against this ADR.

## Consequences

- **Good:** the vinext quarantine cannot grow in count without a recorded decision. The bound is the
  same kind as the structural-gap bound.
- **Cost:** on acceptance, `LEDGER_FILE_CAP` drops from 15 to 8. The 15-file text in ADR-0007,
  ADR-0070 and `bar-vinext-axis.md` (line 41) is wrong and must be amended too. The existing assertions
  that pin 15 (`tests/compat-vinext-ledger.test.ts:129` and `tests/compat-vinext-structural-gaps.test.ts:931-939`)
  red on the change and must be updated in the same PR.
- **Amendment:** acceptance **amends ADR-0007**, whose per-file 15-file cap is recorded there as a
  founder constraint that "stay[s] exactly as they are". That amendment is a founder decision.
- **Not changed:** the structural-gap ledger (cap 41), the 30-day expiry, the case-level matching, and
  the four stable credential cells.
- **Documentation:** no user-facing surface changes. The ADR is internal. The user docs cite the
  vinext numbers only through `bar-vinext-axis.md`, which is updated on acceptance.

## Action items

1. **Founder / sprint-close review:** accept, amend or reject this ADR. The review also rules on the
   ADR-0007 amendment (Option A needs it, and Option C does not).
2. **On acceptance, credential-frozen change (needs the founder marker):** set `LEDGER_FILE_CAP` to 8
   in `scripts/compat-vinext-ledger.mjs`. That file is in `frozenFileSet` through the vinext cell's
   transitive import, so it cannot be edited inside an agent PR.
3. **On acceptance, guard link (needs the founder marker):** `scripts/compat-vinext-ledger.mjs` and
   `test/compat-vinext-ledger.json` are credential-frozen. The guard link requires the founder marker.
   Once it lands, `tests/compat-vinext-ledger.test.ts` gets a comment that cites ADR-0072 and an
   assertion that `LEDGER_FILE_CAP` equals the number in this ADR. It is mutation-proved by changing the
   constant and checking the test goes red. The pins at `tests/compat-vinext-ledger.test.ts:129` and
   `tests/compat-vinext-structural-gaps.test.ts:931-939` move with it.
4. **On acceptance:** replace the "at most 15 files" text in `docs/compat/bar-vinext-axis.md` (line 41),
   `docs/adr/0070-bun-single-exec-stable-bar.md` (the two-ledgers bullet), and ADR-0007 (by amendment).
5. **Ongoing:** lower the cap when entries are fixed or removed, and record each change in the ledger's
   own comment. Raising it is never done by a constant change alone.
