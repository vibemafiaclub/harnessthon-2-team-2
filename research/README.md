# Competitor Research + Reference Checking Workflow

Stage 2+3 of the AI design process: consumes an **approved PRD** and produces a
human-approved, hash-sealed **research package** for the downstream flow/wireframe
and visual/design-system lanes. It does not implement PRD refinement or any later
design stage.

## Layout

```
research/
  lib/         evidence, review, limits, verification, persistence contracts (no deps)
  schemas/     approved-prd/v1 (input) and competitor-research-package/v1 (output) schemas
  samples/     example approved PRDs (wedding invitation + habit tracker fixture domain)
  workflow/    the Claude Dynamic Workflow script (run via the Workflow tool)
  bin/         assemble-run.mjs — seal a run + live quote verification
  ui/          Korean human-review interface (review-server.mjs + review.html)
  tests/       deterministic fixture tests (node --test), two domains
  runs/        run artifacts: package/manifest/verification revisions, decisions, state
```

## Pipeline

1. **Dynamic workflow run** (requires a Claude Code session with the Workflow
   tool and OAuth login; workflows are disabled under `--safe-mode` and OAuth
   under `--bare`): invoke the Workflow tool with
   `scriptPath: research/workflow/competitor-reference.workflow.mjs` and
   `args: { prd: <approved-prd JSON>, nowIso: <ISO UTC now> }`.
   Phases (restructured per team feedback 2026-09-05 + `decisions/qa-round-2.json`):
   Scope (classify 3 competitors with rationale) → Research (parallel
   competitor-observation lanes, autonomous; free public HTTPS sources only,
   exact-quote proofs, no paywall bypass) → Converge (status/contradiction
   audit, feature matrix, holistic top-3 ranking with recorded rationale) →
   Distill (three reference categories — style / layout / interaction —
   derived from the top-3 evidence; reference selection depends on the
   ranking). Client brandConstraints from the PRD are fixed constraints the
   style direction must respect. Save the returned draft JSON.
   `workflow/rank-distill.workflow.mjs` retrofits ranking+distillation onto an
   existing draft; `workflow/competitor-replacement.workflow.mjs` swaps a
   defunct competitor.
2. **Assemble + verify** (plain Node, deterministic):
   ```sh
   node research/bin/assemble-run.mjs \
     --prd research/samples/approved-prd.wedding-invitation.json \
     --draft <draft.json> --run-id <run-id>
   ```
   Every quote proof is re-fetched from its live source; unconfirmed quotes are
   downgraded to `unknown` (never silently promoted) and matrix cells lose the
   stale citation. `--skip-live-verify` exists for offline fixture runs only.
3. **Review (optional inspection since qa-round-2/qa6)** — stages 2-3 are
   fully autonomous: once live verification passes, `state.json` reads
   `verified_autonomous` and the package is downstream-consumable without a
   human receipt. The UI below remains available for inspection, rejection,
   and feedback (which starts a repair round); pass `--require-review` to
   assemble-run to restore the blocking gate:
   ```sh
   node research/ui/review-server.mjs research/runs/<run-id> [port]
   ```
   Open `http://127.0.0.1:4173/`. The Korean UI shows the competitor comparison
   matrix, evidence cards (source/date/context/claim/proof/limitations),
   verification results, unknown/contradiction summary, and references. The
   reviewer takes per-card accept / reject / request-more actions and answers
   the five batch questions. Approval requires all-yes + all-accept and binds
   the exact manifest hash; decisions, revisions, and control-loop state are
   persisted under the run directory.
   The page also carries free-text feedback inputs (per card + overall) with a
   save button; feedback is persisted as
   `runs/<id>/feedback/round-NN-feedback-NN.json` (bound to the manifest hash,
   `status: "pending"`) for the agent to read and apply in the next repair
   round — see `decisions/qa-round-1.json` for the reviewer decisions that
   shaped this workflow.
4. **Handoff**: downstream lanes consume `runs/<id>/package.json` when
   `state.json` shows `verified_autonomous` and its `packageHash` matches the
   package `payloadHash` (an `approve` decision receipt is optional extra
   assurance). `competitorRanking` + `referenceDistillation` route the two
   lanes; `brandConstraints` (client colors/fonts from the PRD) override
   design-system defaults downstream — see
   `schemas/research-package.schema.json` `downstream` and
   `decisions/team-rule-brand-constraints.json`.

## Screenshot capture (Aside browser required)

Real screenshot evidence is captured through the Aside browser (install the
Aside app + CLI/MCP; treat it as a required base tool for this workflow):

```sh
node research/bin/aside-capture.mjs https://example.com runs/<id>/shots/example.jpg
```

It opens a dedicated tab (never the user's tabs), captures a real render,
saves the JPEG, and prints a capture record (sha256, capturedAt,
captureMethod `browser_capture`) to embed in a screenshot-proof evidence
card. Generated or reconstructed images are rejected by the evidence schema.

## Evidence rules (enforced in `lib/evidence.mjs`)

- Status taxonomy: `observed` / `explicit_absence` / `unknown` /
  `contradictory`. Not-found is `unknown`, never absence; absence needs an
  explicit supporting quote.
- Proofs are exact quotes (machine-verified against a re-fetch) or real
  screenshot captures with method/time/hash; generated reconstructions are
  rejected at the schema level.
- Reliability, claim support, relevance, task-based UX heuristics, and visual
  preference are separate axes; aggregate/universal UX scores are rejected.
- Loop control: 3 automatic repairs, 5 human rounds (configurable, always
  visible), then escalation.

## Tests

```sh
node --test research/tests/
```

Fixture tests cover two domains (wedding invitation and habit tracking) to
avoid single-domain overfitting: package sealing/tamper detection, status
taxonomy enforcement, quote verification + downgrade, limits/escalation, and a
review-server end-to-end decision round. Fixture success does **not** prove
live web collection or model execution; see `docs/completion-report.md` for
what was demonstrated live.
