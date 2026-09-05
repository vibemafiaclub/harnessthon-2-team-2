# Design lane workflows: wireframe + visual concept

Two separate Claude Dynamic Workflow scripts turn a structured PRD into reviewable design artifacts. Per team feedback (2026-09-05 15:49, decisions D12-D15) they now run in sequence around a lightweight designer gate:

```
PRD (contracts/prd-input.schema.json)
  └── workflows/wireframe-lane.mjs      → runs/<id>/wireframe-<variant>.html ×3 (INTERNAL: designer inspection only,
      │                                    never shown to clients) + AI representative recommendation
      └── designer gate: pick the representative structure (no response → AI recommendation proceeds, recorded)
          └── workflows/visual-concept-lane.mjs → runs/<id>/concept-{shadcn,seed,wanted-montage}.html
                                                  (CLIENT-facing: client proposes requirements; structure held fixed
                                                   so preference isolates style)
```

Wanted is applied via its official web implementation (github.com/wanteddev/montage-web, @wanteddev/wds) — never a converted iOS library. Stages 5-6 (simulated UT, UI/quality evaluation) continue under the original plan downstream.

## Running a lane round

Launch via the native Workflow tool with `scriptPath` pointing at the lane script and these args:

```json
{
  "prdPath": "samples/wedding-invitation.prd.json",
  "runDir": "runs/wf-wedding-r1",
  "runId": "wf-wedding-r1",
  "round": 1,
  "startedAt": "<ISO timestamp>",
  "feedback": "<optional: human revision feedback for rounds >= 2>"
}
```

Create `runDir` first. Timestamps are passed in because workflow scripts cannot call `Date.now()`. The visual-concept lane additionally requires `representativeWireframePath` (the gate-selected wireframe variant file) and accepts `representativeVariant` metadata; it must run after the designer gate.

### Lane stages

Both lanes follow plan → generate → check & repair → package:

- **Auto-repair** runs at most 3 attempts per artifact and covers mechanical defects *and* AI quality judgments (decision D9). Every repair is logged to `repairHistory` so the human sees what changed before review.
- **Quality checks** are reported on separate axes — ux-task, spec-fidelity, accessibility, aesthetic, mechanical — never one combined score. `not-verified` is an honest status, not a pass.
- **Package** writes `lane-output.json` (contracts/lane-output.schema.json) and self-validates by running the review-sheet renderer.

Lane specifics: the wireframe lane produces one self-contained clickable low-fi HTML (flow-map view + hash-routed screens, grayscale only). The visual lane produces exactly three concepts per batch, each a representative screen + style tile, on a fixed SEED-based skeleton (spacing/type-scale/states) with only color/radius/mood overlaid per concept (decision D3). Default viewport is 390x844 unless the PRD overrides it (D5).

## Human review loop

The review sheet is designed to sit next to a live Claude session: the reviewer writes feedback as text inside the sheet, and the session reads it back (decision D7, amended).

1. `node scripts/render-review-sheet.mjs runs/<id>` — renders `review-sheet.html` and **fails if any artifact changed after packaging** (approval must bind the shown revision).
2. `node scripts/review-server.mjs runs/<id> [port]` — serves the sheet on `127.0.0.1` only. Open `http://127.0.0.1:<port>/` in a browser.
3. The sheet has a feedback textarea under every artifact plus a general comment box. Submitting POSTs to the local server, which appends to `runs/<id>/feedback.json` together with the artifact revision hashes. Opened via `file://` instead, submission falls back to copying the feedback to the clipboard for pasting into the terminal.
4. The Claude session reads `feedback.json`, and the final decision is still confirmed in the terminal: `node scripts/record-review.mjs runs/<id> --decision approved|revise|rejected --decided-at <iso> [--feedback "..."] [--concept <id>]` — appends to `runs/<id>/reviews.json`, re-verifying revision hashes. `--concept` records the selected concept on visual-lane approval.
5. On `revise`, launch the next round with a new `runDir`, `round + 1`, and the collected feedback. Structural changes reopen wireframe approval; style changes reopen concept approval (D4). Up to 5 human rounds before escalation, but the human decides acceptance — rounds are never forced.

## Testing

`node scripts/checks/run-checks.mjs` covers: sample PRD contract conformance, lane-output validation + sheet rendering, tamper detection on render and on review recording, revise-round recording, and validator edge cases. Live workflow runs under `runs/` are the execution evidence; fixtures used by checks are generated in temp dirs.
