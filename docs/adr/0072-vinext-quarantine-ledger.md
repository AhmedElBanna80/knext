# ADR-0072: The vinext quarantine ledgers' caps are frozen at their actual counts and only ratchet down

- **Status:** **Proposed (2026-11-17).** Design only. Nothing in code, tests, workflows or docs changes
  when this ADR merges. Acceptance is a founder/sprint-close decision, and it **amends ADR-0007**
  (see Consequences), so it cannot take effect by merging this file.
- **Task:** v2 Sprint 7, S7-9, v2 GA exit V0a.
- **Relates to:** ADR-0007 (§g and its 2026-10-09 amendment define both ledgers), ADR-0048 (vinext
  single executable as the only vinext target), ADR-0051 (vinext lanes are ESM-only),
  [`docs/compat/bar-vinext-axis.md`](../compat/bar-vinext-axis.md) (the vinext Stable bar, V-C1 to V-C3,
  which names both ledgers at lines 40-43).
- **Trigger class:** ADR (a new Proposed ADR that changes ledger bounds).

## Context

The vinext x Bun lane (`compat-vinext.yml`) runs the official corpus unchanged. Its denominator never
narrows. `scripts/compat-vinext-ledger.mjs apply` reclassifies failing **cases** after the run. Two
ledgers bound what may be reclassified, and both are vinext-only (`lane: bun-vinext`):

| Ledger | Data | Cap constant | Current actual count | Time bound |
|---|---|---|---|---|
| **Per-file** | `test/compat-vinext-ledger.json` | `LEDGER_FILE_CAP = 15` (`scripts/compat-vinext-ledger.mjs:193`) | **8 files** (8 entries, 8 distinct tests, all `class: unsupported`) | `MAX_EXPIRY_DAYS = 30` per entry (`:194`); all 8 entries expire 2026-11-26 |
| **Structural-gap** | `test/compat-vinext-structural-gaps.json` | `STRUCTURAL_FILE_CAP = 41` (`scripts/compat-vinext-structural-gaps.mjs:61`) | **39 files** | `STRUCTURAL_MAX_REVIEW_DAYS = 92` (`:121`); `gap.reviewBy` is 2027-01-08, `recorded` 2026-10-09 |

The counts were read by parsing both JSON files at the commit that adds this ADR (2026-11-17). The two
ledgers share no file (0 overlap), so **47 distinct files** are reclassified today. The v2 plan's
"49 expected" (`.claude/plans/v2-plan-rev4.md:260`) is the structural ledger's original count; it was
lowered to 41 after the vinext 1.1.0 measurement (the ledger's own `$comment`) and holds 39 now.

Where the bounds stand today:

- **Structural-gap ledger.** ADR-0007 (lines 717-762) gave it a cap "frozen at the number first
  quarantined", where "adding a file, or raising the cap, requires a new amendment to this ADR"
  (ADR-0007's table). That is the pattern V0a asks for, but the constant sits at 41 while the ledger
  holds 39, so **two slots are free** and a file can be added without an amendment. The guard pins
  only `STRUCTURAL_FILE_CAP <= 49` (`tests/compat-vinext-structural-gaps.test.ts:84`, `:117`), so it
  would not catch the cap rising back to 49.
- **Per-file ledger.** ADR-0007 records its bounds (at most 15 files, 30-day expiry, two runs of
  evidence per entry) as founder constraints that "stay exactly as they are" (lines 730-731). The cap
  of 15 is a ceiling with **7 unused slots**; the constant can move with no decision record.

The two-ledgers summary ("at most 15 files, 30-day expiry" plus "cap 41, only ever lowered") lives in
`docs/compat/bar-vinext-axis.md:40-43`, not in ADR-0070. ADR-0070 does not mention the ledgers.

## Decision

1. **Both caps are frozen at the actual count at the commit that adopts this ADR.** Today that is
   **8 files for the per-file ledger** and **39 files for the structural-gap ledger**. The number is the
   actual count, not the 15 or 41 ceiling. If either count has fallen by acceptance time, the lower
   number is the frozen one.
2. **Both caps ratchet DOWN only.** Lowering is routine as entries are fixed, removed or expire.
   Raising a cap, or adding an entry beyond it, requires a new amendment **of this ADR**. Because
   ADR-0007 owns both ledgers, any such amendment also amends ADR-0007 (the ADR-0007 text is not
   edited by this ADR: see Consequences).
3. **Vinext lanes only.** `LANES` stays `['bun-vinext']`. The four stable credential cells
   (node/bun x turbopack/webpack) never read or freeze either ledger. No third ledger and no stable-lane
   quarantine is created by this ADR; a new ledger needs its own ADR.
4. **Quarterly review.** The structural ledger's review is already enforced: `gap.reviewBy` is at most
   92 days after `gap.recorded`, and past it the run reds. It stays. The per-file ledger is reviewed
   continuously by its 30-day expiry (and 14 days for `flaky`, `FLAKY_MAX_EXPIRY_DAYS`, `:199`). On
   top of both, **a quarterly review of both ledgers is held at sprint close** and records, per ledger,
   the count, the cap, the entries removed since the last review, and the entries that remain with
   their upstream links. The record is a dated note appended to this ADR. A quarter with no entry
   removed is stated, not skipped.
5. **Retirement rules** (the code already reds on these; this ADR makes them the policy):
   - **Per-file, `unsupported`:** an entry is removed the first run in which a quarantined case does not
     fail (`staleEntries`, `scripts/compat-vinext-ledger.mjs:426`, reported at `:1502-1505` as "stale
     quarantine entry"). It is also removed when fixed upstream, which shows as that same run. If it
     is not fixed, it expires 30 days after `added`; renewal needs fresh evidence from runs created on
     or after the new `added` date (`renewalGap`, `:1278`). A renewal is not an addition and does not
     count against the cap.
   - **Per-file, `flaky`:** removed after `FLAKY_WINDOW = 3` consecutive informative runs in which it
     passes (`flakyWindow`, `:591-611`). It is reclassified out of `flaky` if all 3 fail.
   - **Structural:** a file is removed the first run in which it passes in full (`staleStructural`,
     `scripts/compat-vinext-structural-gaps.mjs:341-365`, "stale structural-gap entry"). A partial
     improvement only warns and the file's `cases` snapshot shrinks. The whole ledger retires when
     vinext implements the client-router architecture (the `gap` record's upstream links), which empties
     it through the same stale rule.
   - **After any retirement the cap is lowered** to the new actual count in the same change, so the
     freed slot cannot be reused. This is the one rule the code does not enforce today (see Action 2).
6. **The Stable wording (V7).** When vinext is promoted, the `vinext` sentence in
   `apps/docs/content/docs/stability.mdx` (today at line 59: "stays Beta in every release; it is not on
   the path to Stable") is rewritten by the v2 promotion PR, not before
   (`docs/compat/bar-vinext-axis.md:160-161`). The V7 text in the plan cites `stability.mdx:53`; the
   sentence has since moved to line 59. The new wording is exactly **"Stable on the official suite minus
   N disclosed known-gap files"**, with N read from the ledgers by a guard and never typed. It is never
   "the same bar", "verified" or an unqualified "compatible" (V-C3, `bar-vinext-axis.md:56`). N counts the
   distinct files in **both** ledgers, because a file in either is reclassified and not a pass (47
   today). `bar-vinext-axis.md:56` says "N read from the ledger" about the structural ledger only. The
   promotion PR must resolve that either by adopting the both-ledgers count here or by amending V-C3.
   If it is not resolved, the published N is the structural count alone and would understate the gap
   by the per-file entries.
7. **Until this ADR is accepted, nothing changes.** The constants (15, 41) and the "15 files" and
   "cap 41" text in ADR-0007 and `bar-vinext-axis.md` stay as they are.

## Options considered

| Option | Per-file cap | Structural cap | Ratchet | Gain | Cost |
|---|---|---|---|---|---|
| **A. Freeze both at the actual count, ratchet down only** (recommended; design-review recommendation) | 8 | 39 | down only | No count can grow without a recorded amendment, on either ledger. Caps are tied to evidence. Matches V0a ("the actual quarantined count"). | 7 per-file and 2 structural slots lost. A new unsupported file in the next 9 days needs an amendment. Contradicts the founder's 15 in ADR-0007, so acceptance needs an ADR-0007 amendment. |
| B. Keep 15 and 41 (status quo) | 15 | 41 | none | No change, no amendment. | 9 silent additions possible by changing a constant. Fails V0a. |
| C. Freeze at the ceilings, ratchet down only | 15 | 41 | down only | Keeps the founder number and adds the ratchet. | The ceilings still allow 9 additions with no amendment, so it is not a freeze. It also amends ADR-0007's "stay exactly as they are" (line 731), the same as A does, so it saves no amendment. |
| D. Drop the count caps, keep expiry and review | none | none | none | Simplest. | Expiry and review bound time, not total. Entries can be renewed indefinitely, so the quarantine grows without limit. |

Option A is chosen because it is the only one where each count changes only with a recorded decision.
Its cost is real and visible: nine slots go, and the first new quarantine needs an amendment.

**Known residual:** a count freeze does not stop a swap, where one entry is removed and another
added. Each per-file entry still needs its evidence (two failing runs, a named unsupported feature,
an upstream issue), and the structural ledger needs a manifest-member file that shares no case with
the other ledger. The guards cannot see intent, so the reviewer of any ledger change checks it against
this ADR.

## Consequences

- **Good:** neither vinext quarantine can grow in count without a recorded decision, and the cap
  follows the count down instead of leaving free slots.
- **Amends ADR-0007.** Acceptance amends ADR-0007 in two places: the per-file ledger's 15-file cap,
  recorded there as a founder constraint that "stay[s] exactly as they are" (ADR-0007:730-731), and the
  structural cap's value (41 becomes 39). **Any ratchet of those bounds, including Option C's, amends
  ADR-0007**, because that text says the bounds do not move. That amendment is a founder decision.
- **Cost:** on acceptance, `LEDGER_FILE_CAP` drops from 15 to 8 and `STRUCTURAL_FILE_CAP` from 41 to 39.
  The assertions that pin 15 (`tests/compat-vinext-ledger.test.ts:129`,
  `tests/compat-vinext-structural-gaps.test.ts:931` and `:937`) red on the change and move in the same
  PR. The "at most 15 files" and "cap 41" text (ADR-0007 by amendment, `bar-vinext-axis.md:41` and
  `:43`, the two ledger JSON `$comment` fields, and the "N is 41" figure at `bar-vinext-axis.md:56`)
  is updated with it.
- **Not changed:** the 30-day and 92-day time bounds, the 14-day flaky expiry, case-level matching, the
  vinext-only scope, and the four stable credential cells.
- **Documentation:** no user-facing surface changes now. The user docs change only through the V7
  promotion PR (Decision 6).

## Action items

1. **Founder / sprint-close review:** accept, amend or reject this ADR. The review also rules on the
   ADR-0007 amendment, which every option except B and D needs, and on the V-C3 N definition (Decision 6).
2. **On acceptance, credential-frozen change (needs the founder marker):** set `LEDGER_FILE_CAP` to 8
   in `scripts/compat-vinext-ledger.mjs:193` and `STRUCTURAL_FILE_CAP` to 39 in
   `scripts/compat-vinext-structural-gaps.mjs:61`. Both files are in `frozenFileSet`
   (`scripts/compat-credential-freeze-guard.mjs`, read with `frozenFileSet(repoRoot)`) so they cannot
   be edited inside an agent PR. The same change updates the ledger JSON's own `$comment`:
   `test/compat-vinext-ledger.json:2` ("at most 15 files") is credential-frozen as well and needs the
   marker; `test/compat-vinext-structural-gaps.json` ("at most 41 files") is not frozen.
3. **On acceptance, guard link (needs the founder marker for the frozen files above):** the guard tests
   get a comment citing ADR-0072 and an assertion that each cap equals the number in this ADR (replacing
   the `toBe(15)` pins and the weak `<= 49` check). Each is mutation-proved by changing the constant and
   checking the test goes red. A further guard should red when a ledger holds fewer entries than its cap
   (the "lower the cap after a retirement" rule in Decision 5), which no test enforces today.
4. **On acceptance, docs and ADR text:** amend ADR-0007 (the per-file bounds and the structural cap),
   and update `docs/compat/bar-vinext-axis.md` lines 41, 43 and 56.
5. **Quarterly (sprint close):** append the dated review record in Decision 4. Lower the cap whenever an
   entry retires. Raising a cap is never done by a constant change alone.
6. **At V7 (the promotion PR):** rewrite the `stability.mdx` sentence per Decision 6, add the guard that
   derives N from the ledgers and reds on "same bar" wording, and settle the V-C3 N definition.
