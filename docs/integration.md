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
      └─ post-approval-prototype ....... workflows/post-approval-product.mjs
```

Research, wireframes and concept generation run with **no human gate**. Their
results are recorded as `ai_confirmed`; `recordApproval` throws if anything
tries to record an AI confirmation as a human approval.

## The two touchpoints

The UI labels these "PRD 리뷰" and "시안 리뷰".

| # | Touchpoint | What the human does | Gates bundled |
|---|---|---|---|
| 1 | **PRD review** | Answers the interview's open questions *and* the client aesthetic questionnaire in one sitting, then approves the resulting PRD-v2 | `prd_answers`, `concept_answers`, `prd_approval` |
| 2 | **Concept review** | Picks one of the three concepts, or sends them back | `concept_approval` |

The visual-concept lane refuses to generate anything before the client has
answered its aesthetic questionnaire. That questionnaire only needs the
product's domain and brand context, so the pipeline produces it right after
intake (off a provisional lane PRD) and asks it during the PRD review — it does
not become a third interruption.

## The concept review can repeat

Approving is only one of three things a client does when they see the concepts.
All three go through one command, and only the first is an approval:

```sh
integrate review <runDir> concept_review --decision approve --by "<name>" --concept <id>
integrate review <runDir> concept_review --decision revise  --by "<name>" --scope style|structure --feedback "<text>"
integrate review <runDir> concept_review --decision recolor --by "<name>" --request "보라색으로 변경해 줘"
```

| Decision | What it does |
|---|---|
| `approve` | Records `concept_approval`, bound to the sha256 of the exact file shown; refuses a file that changed after packaging. |
| `revise --scope style` | Bumps the concept round, records the feedback, and `next` returns a `visual-concept-lane` invocation carrying `feedback` and the new `round`. The round writes to `concepts-r<N>/`, so the reviewed artifacts stay intact. |
| `revise --scope structure` | The concept lane holds the structure fixed and cannot answer a structural complaint, so the **wireframe** stage reopens with its own round + feedback (`docs/lane-workflows.md` D4). The concepts stage re-runs afterwards because its input changed. |
| `recolor` | Routes the concepts stage to the lane's recolor pass (`visual-concept-recolor`): `recolor = { fromRunDir, request }`, a hue-only change to `--primary-h` over the existing files, no regeneration. |

A revise or a recolor is recorded as a **client instruction** (`client_instruction`),
never as an approval, and it moves any standing concept approval to
`approvalsHistory` with the reason. Rounds and feedback participate in the stage
fingerprint, so a new round cannot be satisfied by the previous round's output.

This is not a third touchpoint: it is the same 시안 리뷰 happening again. It is
also finite — `MAX_CONCEPT_ROUNDS` (5, from `research/lib/limits.mjs`
`maxHumanRounds`). A request beyond it is refused: nothing is re-run, and the
route plan blocks the concept review with the exhaustion reason so a human
re-scopes the work instead of the loop continuing.

## Running it

```sh
# 1. describe the inputs
npm ci --prefix product  # browser dependency; installed Google Chrome is also required
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
node integration/bin/integrate.mjs review  <runDir> concept_review --decision approve|revise|recolor --by "<name>" …
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
node --test research/tests/       # 74 pre-existing research tests
node --test integration/tests/    # 66 integration tests
node scripts/checks/run-checks.mjs  # lane contract checks
```

Fixture-based routing tests and real-execution evidence are kept separate; see
`docs/integration-evidence.md` for what has actually been executed live.
