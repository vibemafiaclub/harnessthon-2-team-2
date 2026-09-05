# PRD + materials → design pipeline integration

Connects the four workflows that already exist in this repo into one run with
persisted state, evidence-based reuse routing, and exactly **two human
touchpoints**.

```
PRD + materials
  └─ intake-assess ..................... integration/workflow/intake-assess.workflow.mjs
      ├─ prd-interview ................. .claude/workflows/prd-interview/workflow.js
      └─ visual-concept (elicit pass) .. workflows/visual-concept-lane.mjs   ← questionnaire only
          │
          ▣ TOUCHPOINT 1 — PRD review: interview answers + client aesthetic answers,
          │                 then PRD-v2 approval
          │
      ├─ prd-interview (revise pass) ... .claude/workflows/prd-interview/workflow.js
      ├─ competitor-reference .......... research/workflow/competitor-reference.workflow.mjs
      │   └─ seal + live verify ........ research/bin/assemble-run.mjs
      ├─ wireframe-lane ................ workflows/wireframe-lane.mjs
      └─ visual-concept (generate) ..... workflows/visual-concept-lane.mjs
          │
          ▣ TOUCHPOINT 2 — concept review: the client picks one of three concepts
          │
      └─ production-outputs ............ NOT IMPLEMENTED — routes as `blocked`
```

Research, wireframes and concept generation run with **no human gate**. Their
results are recorded as `ai_confirmed`; `recordApproval` throws if anything
tries to record an AI confirmation as a human approval.

## The two touchpoints

The UI labels these "PRD 리뷰" and "시안 리뷰".

| # | Touchpoint | What the human does | Gates bundled |
|---|---|---|---|
| 1 | **PRD review** | Answers the interview's open questions *and* the client aesthetic questionnaire in one sitting, then approves the resulting PRD-v2 | `prd_answers`, `concept_answers`, `prd_approval` |
| 2 | **Concept review** | Picks one of the three concepts | `concept_approval` |

The visual-concept lane refuses to generate anything before the client has
answered its aesthetic questionnaire. That questionnaire only needs the
product's domain and brand context, so the pipeline produces it right after
intake (off a provisional lane PRD) and asks it during the PRD review — it does
not become a third interruption.

## Running it

```sh
# 1. describe the inputs
cat integration/examples/request.wedding-scheduler.json

# 2. create the run; this prints the first real action
node integration/bin/integrate.mjs init --request integration/examples/request.wedding-scheduler.json

# 3. repeat until done: ask for the next action, do it, record the result
node integration/bin/integrate.mjs next   <runDir>
node integration/bin/integrate.mjs record <runDir> <stage> --result <file>
node integration/bin/integrate.mjs answer <runDir> --file answers.json
node integration/bin/integrate.mjs answer <runDir> --preferences '{"q-color":"opt-sage"}'
node integration/bin/integrate.mjs approve <runDir> prd_approval     --by "<name>" --prd-file <approved-prd.json>
node integration/bin/integrate.mjs approve <runDir> concept_approval --by "<name>" --concept <id>
node integration/bin/integrate.mjs status  <runDir>     # writes status.html
```

`next` never executes a workflow itself. It returns the exact `Workflow` tool
input (scriptPath + args) for the session to run, or the exact shell command,
or the human decision that is due. Nothing is reported as progress that did not
actually happen.

### The request file

```json
{
  "runId": "demo-wedding-scheduler",
  "prd": { "path": "../../examples/wedding-scheduler/PRD.md" },
  "materials": [
    { "id": "mat-brand", "path": "brand-sheet.md", "role": "brand-tokens",
      "description": "client-specified colours and heading font" },
    { "id": "mat-tpl", "path": "/abs/landing.html", "role": "html-template",
      "description": "we want to adopt this as the concept",
      "approvedRevision": "<sha256 of the exact revision the client approved>" }
  ],
  "policy": { "maxResearchAgeDays": 30 }
}
```

Relative paths resolve against the request file. `role` is the user's own
declaration — adoption intent is only honoured when the declaration says so and
the model can quote it (`integration/lib/assess.mjs`). Attaching a file is not
approving it.

## Material-aware routing

| Supplied | Effect |
|---|---|
| nothing | full path |
| brand palette / font only | carried as fixed constraints; research, wireframes and concepts all still run |
| inspiration screenshot | visual reference only; only observable content is extracted |
| reusable design system | verified tokens/components reused; required screens and flows still evaluated |
| partial HTML template | compatible parts reused, gaps generated (`repair`) |
| explicitly adopted concept with adequate coverage | concept ideation bypassed — but the concept review still happens unless the declaration approves that exact revision |
| existing research package | reused only after seal, provenance (`verified_autonomous` or an approval receipt), PRD identity, freshness and feature-coverage checks |
| existing wireframe lane output | reused only after artifact-hash and quality-check verification |

A skipped stage is recorded as **reuse of a checked artifact**, never as a
successful generation. Validation is never skipped because a file exists.

## Invalidation and resume

Every stage records a fingerprint over its dependencies. Change the PRD, swap a
material, or change an aesthetic answer, and the affected stages become `stale`
and any approval bound to that chain moves to `approvalsHistory` with a reason.
Re-running `next` resumes at the first stage that is not done — completed work
is not re-executed.

## Ground truth

`integration/groundtruth/*.json` pins each stage's input contract, output
contract, representative examples, and the handoff to the next stage.
`integration/tests/groundtruth.test.mjs` asserts every declared contract against
the **real workflow source**, and derives each next input from the previous
output using the real adapter code. A contract drift in any workflow fails the
tests rather than a live run.

## Testing

```sh
node --test research/tests/       # 33 pre-existing research tests
node --test integration/tests/    # 55 integration tests
node scripts/checks/run-checks.mjs  # lane contract checks
```

Fixture-based routing tests and real-execution evidence are kept separate; see
`docs/integration-evidence.md` for what has actually been executed live.
