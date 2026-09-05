# Three-competitor, PRD-feature-first correction

Implemented the narrow research correction without Figma, runtime-model, OAuth, or other-worktree changes.

- Native Dynamic Workflows reject oversized, undersized, or duplicate selections before observation dispatch. Replacement requires explicit IDs from the current three-product roster and returns the complete replacement roster plus new cards; merge by replacing the roster, removing replaced cards/cells, and rebuilding ranking/matrix before assembly.
- Cards carry exact PRD feature IDs and distinguish product behavior, product documentation, marketing descriptions, and unknown evidence. Observation prompts no longer cap cards at eight. Convergence audits feature-specific support; matrix rendering leads with approved requirement text and implementation claims, with expandable proof/source links.
- New sealing/assembly requires the approved PRD feature set, exactly three distinct competitors, full matrix coverage, valid per-competitor/feature/status evidence links, and a complete three-product ranking. Missing evidence stays unknown. Insufficient relevant evidence yields an explicit incomplete state, without a success hash.
- Historical v1 packages remain readable with a compatibility notice; they are not newly verified. New sealing requires PRD features. Rank-distill reuse now accepts full `prd`, `competitors`, `cards`, `featureMatrix`, and optional `existingReferences` in args; legacy file-only input is rejected before agent calls. Explicit migration requires collecting missing feature-linked evidence rather than inferring it from old card names.
- Default live-verified auto-confirm, optional human review, brand constraints, native Claude models, quote downgrades, and revision history are preserved.

Verification: `node --test research/tests/*.test.mjs` — **74 passed, 0 failed** (33 existing compatibility/behavior tests, 41 focused tests). `git diff --check` passed. Tests execute the actual workflow scripts with deterministic agent doubles, actual assembly with mocked source fetches, and actual UI render code with a DOM double. No expensive live research run or browser session was used.

Fixture outputs generated from `research/tests/comparison-fixtures.mjs` and sealed with the new contract:

| Output | Competitors | PRD rows | Cells | Exact IDs |
| --- | --- | --- | --- | --- |
| `/tmp/competitor-2-feature-fixture.json` | 3 | 2 | 6 | `feat.requirement-1` through `feat.requirement-2` |
| `/tmp/competitor-10-feature-fixture.json` | 3 | 10 | 30 | `feat.requirement-1` through `feat.requirement-10` |

These are explicitly synthetic fixtures, not live competitor research. Structural validation binds evidence to competitor/feature/status; semantic relevance and absence interpretation remain AI audit judgments, while exact quotes retain independent source verification.
