# Implement competitor research and reference checking

You own implementation in this worktree. User explicitly requested Claude Fable 5, medium effort, Claude OAuth, and an actual Claude Dynamic Workflow. Read `docs/meeting-2026-09-05.md` first. Respond Korean; write repository documentation in English. Never push, commit, publish externally, access Figma, or change global auth/settings. Do not substitute a model or API-key provider. Preserve other worktrees.

Build a usable, narrowly scoped workflow feature for competitor research plus reference checking, including a human evidence-review interface. It consumes an approved PRD from another developer and produces a structured, approved research package for downstream design. Do not implement PRD refinement or the entire design pipeline.

First inspect the shared artifact read-only: https://claude.ai/public/artifacts/58d6199a-7021-4af0-9261-3dfd8e31a315 . Compare its relevant steps against the meeting and record discrepancies. If inaccessible, explicitly preserve that limitation and use the supplied meeting decisions without inventing artifact content.

Inspect reusable modules read-only at `/Users/simon/orca/workspaces/harnessthon-2-team-2/team2-harness-lab`, especially `.claude/skills/evidence-researcher/SKILL.md`, research-evidence.mjs, research-snapshot-store.mjs, research-verifier-receipt.mjs, evidence-review-manifest.mjs, and human-review-receipt.mjs under workbench. The separate SEED research report is at `/Users/simon/orca/workspaces/harnessthon-2-team-2/seed-design-foundations-research/docs/research/seed-design-foundations.md`. Prefer minimal portable implementation over importing the whole existing framework.

Verify current official Claude Dynamic Workflow documentation and installed runtime support before choosing workflow syntax. Research official sources or the local runtime; do not invent a workflow schema. Do not use --safe-mode (disables workflows) or --bare (disables OAuth). Keep native workflow execution distinct from any lightweight UI/JSON persistence adapter. If runtime support is unavailable, implement independently useful contracts/UI and report the exact execution blocker honestly.

Required behavior:

- Confirm research scope, classify competitors by shared problem/audience, research free app-screen/flow evidence sources, and record access limitations. No paywall bypasses or purchases.
- Parallel competitor observation and reference discovery; convergence and evidence verification before review. Distinguish observed implementation, explicitly supported absence, unknown, and contradictory evidence. Not found is not absent.
- Separate source reliability, claim support, relevance, task-based UX heuristics, and visual preference. Evidence cards show source/date/context/claim/proof/limitations. Screenshots must be actually captured, not generated reconstructions presented as evidence.
- A readable Korean HTML/client review interface showing competitor comparison, references, evidence strength, unknowns, and accept/reject/request-more actions. Persist JSON outputs, revisions, and decisions; approval binds the exact reviewed content. Human feedback is conversational, roughly five questions per batch.
- Three automatic repair attempts; five human-directed rounds before escalation, configurable with visible limits. No silent promotion of unverified claims or fake universal UX scores. Include concise decision rationales and lessons, not private chain of thought.
- Research output supports both downstream flow/wireframe and visual/design-system lanes. Provide concrete integration schema and an example approved-PRD input.
- Keep runtime bounded and display elapsed time/progress. Failure states include unavailable source, app-only evidence, contradiction, interruption/resume, and rejected review.

Deliver actual code/workflow files, minimal run instructions, review UI, schemas/sample data clearly labeled, and meaningful tests. Demonstrate one real OAuth-backed dynamic workflow run on a small PRD with genuine public evidence if tools permit. Separate deterministic fixture tests from live proof; do not claim fixture success proves web collection or model execution. Run at least one different-domain fixture to prevent wedding-invitation overfitting. Save a concise completion report with verified capabilities and remaining gaps. Update the Orca worktree comment at milestones. No need to wait for another planning approval; implementation is authorized.
