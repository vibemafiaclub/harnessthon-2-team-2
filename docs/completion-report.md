# Completion report: competitor research + reference checking workflow

Date: 2026-09-05. Owner: Simon's worktree `competitor-reference-workflow`
(branch `simon/competitor-reference-workflow`). Implements stages 2+3 of the
six-stage process from the shared artifact (see `docs/artifact-gap-review.md`),
per `docs/implementation-brief.md` and `docs/meeting-2026-09-05.md`.

## Verified capabilities (each demonstrated in this session)

- **Native Claude Dynamic Workflow runtime confirmed and used.** The installed
  Claude Code session exposes the Workflow tool; the schema was taken from the
  official `workflow-authoring` reference, not invented. Two real OAuth-backed
  runs completed on `claude-fable-5`:
  - `wf_440a1c7d-bbf` — main workflow (`research/workflow/competitor-reference.workflow.mjs`),
    wedding-invitation PRD: 5 agents (scope → 2 parallel competitor lanes +
    reference lane → convergence), 289,656 tokens, 58 tool calls, 6.7 minutes.
  - `wf_9db8b23b-c93` — replacement workflow after the reviewer's decision to
    swap the defunct competitor: 3 agents, 155,764 tokens, 3.0 minutes.
- **Genuine public evidence.** Competitors: Barunson Mcard, Theirmood, Yeonseo
  (DDD Project was researched, found dead — domain listed for sale — and
  replaced per reviewer decision; its investigation is preserved in
  `package.v1` revision history). Evidence cards carry exact verbatim quotes
  with URL/fetch-time/context, separated reliability/support/relevance axes,
  task-based UX heuristic notes, and visual-preference notes.
- **Independent verification before review.** `assemble-run.mjs` re-fetched
  every quoted source live: 21 of 22 quotes confirmed; 1 unconfirmed quote
  (Theirmood template count, JS-rendered) was automatically downgraded to
  `unknown` with the downgrade recorded — no silent promotion. Matrix cells
  losing their citation flip to `unknown` automatically.
- **Real screenshot capture.** `research/bin/aside-capture.mjs` drives the
  Aside browser (dedicated tab, never user tabs), producing hashed JPEG
  captures of all three competitor homepages, attached as screenshot-proof
  cards (`captureMethod: browser_capture`). Generated images are rejected by
  the schema. Aside app + CLI/MCP is a required base tool for this step.
- **Korean human-review UI** (`research/ui/`): competitor comparison matrix
  with the four-status taxonomy, evidence cards, verification badges,
  unknown/contradiction summary, references, per-card accept/reject/
  request-more, five batch questions, and free-text feedback inputs saved as
  JSON (`feedback/round-NN-*.json`) for the agent to ingest — per the
  reviewer's qa4 decision. Approval requires all-yes + all-accept and binds
  the exact manifest hash; decisions and revisions are persisted with history.
- **Limits and failure states.** 3 automatic repairs / 5 human rounds
  (configurable, shown in the UI), escalation beyond either; failure kinds
  `source_unavailable`, `app_only_evidence`, `paywalled_source`,
  `contradiction`, `interrupted`, `review_rejected` are recorded in the
  package (11 real failure records in the live run).
- **Tests: 27/27 pass** (`node --test research/tests/`), covering two domains
  (wedding + habit tracker) to prevent overfitting: sealing/tamper detection,
  status taxonomy (not-found ≠ absence; screenshots need real capture
  records; aggregate UX scores rejected), quote verification + downgrade,
  limits/escalation, review binding, and server end-to-end decision +
  feedback rounds. Fixture success is not claimed as proof of live web
  collection; the live runs above are that proof.
- **Reviewer Q&A loop.** Ambiguities were put to the user in-session
  (`research/decisions/qa-round-1.json`): replace dead competitor; add
  browser auto-capture; 3 competitors per run; free-text feedback loop
  instead of partial approval. All four decisions are implemented.

## Live run artifacts

`research/runs/run-wedding-live/`: sealed `package.json`
(`sha256:8e3cdc82…`), `manifest.json` (round 1, awaiting review),
`verification.json`, `shots/` (3 real captures), revision history. Review UI:
`node research/ui/review-server.mjs research/runs/run-wedding-live` →
http://127.0.0.1:4173/ (was left running and opened in an Orca tab).

## Addendum: team-feedback restructure (same day, later)

Team feedback (`local-archive/feedback-2026-09-05-1549.md`) restructured
stages 2-3; open points were resolved with the user in-session
(`research/decisions/qa-round-2.json`, `team-rule-brand-constraints.json`):

- **Stage 2 autonomous + top-3 ranking.** Converge now produces a holistic
  `competitorRanking` with a mandatory per-rank rationale (qa7). Live
  retrofit run `wf_4941e27a-5e6` ranked Yeonseo > Theirmood > Barunson Mcard.
- **Stage 3 distills from the top 3** — no longer an independent parallel
  lane. Three categories per qa5: style / layout / interaction, each with a
  direction synthesis, cited references, and evidence-card ids (validated at
  seal time). Two new verified references (NN/g mobile carousels, MDN Web
  Share API) were added in the live retrofit.
- **Stage-3 human gate removed (qa6).** Runs reach `verified_autonomous`
  when live quote verification passes; the review UI/feedback channel stays
  as optional inspection (`--require-review` restores the gate).
- **Client brand constraints rule.** `prd.brandConstraints` (colors/fonts)
  pass through verbatim as `package.brandConstraints` with precedence
  `client_values_override_design_system_defaults`; the distillation prompts
  forbid overriding them, and the downstream schema documents the rule.
- Re-sealed live package `sha256:818d75e6…` (round 2 revision history kept):
  3 competitors ranked, 7 references, 27 cards (23 quotes live-verified, 1
  downgraded, 3 screenshots), distillation present. Tests now 33/33.

## Remaining gaps (honest)

- The live run is **awaiting human review**; no approval receipt exists yet —
  approval is the reviewer's act, not the agent's.
- Quote verification uses normalized-substring matching on the re-fetched
  HTML; JS-rendered quotes can fail verification even when visible in a
  browser (that is what downgraded the one Theirmood card). A browser-render
  verification path (via Aside) would close this gap.
- Screenshot capture is homepage-level; per-feature screen capture and the
  feedback-ingestion repair round (`status: pending → applied`) are wired but
  were not exercised end-to-end with real reviewer feedback in this session.
- The shared artifact could not be fetched by this session's tools (SPA
  shell); its content was taken from `docs/artifact-gap-review.md`, produced
  by a prior Aside-based inspection.
- Paid libraries (Mobbin 등) untouched; free alternatives verified: Collect UI
  reachable; UX Archive returned 403, Page Flows effectively paywalled — all
  recorded as limitations in the package.
- Lab/SEED sources now live at
  `/Users/simon/code/harnessthon-2-team-2/local-archive/` (read-only
  reference); this implementation is a minimal portable port, not an import.
