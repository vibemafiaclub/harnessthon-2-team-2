# Rendered visual quality gate

Visual concept generation now includes seven task-relative anti-slop criteria, defined in `workflows/visual-quality-rubric.md`. The generator receives the rubric; a separate check agent captures the actual HTML through Aside, inspects the PNG, records region-specific observations and repairs, and runs a deterministic evidence gate. Three repair attempts are allowed. Failed or unverified results block the whole concept batch rather than leaking into a client review sheet.

Every capture serves frozen HTML on a temporary loopback-only server, blocks external assets/requests, uses the requested CSS viewport, waits for fonts, and stores PNG bytes plus a capture receipt. The check agent writes a report tied to the HTML and PNG hashes. Source inspection alone cannot satisfy the rendered rubric. Self-contained HTML with embedded assets is required by the existing workflow; external custom fonts must be embedded, not silently substituted.

Recolor invalidates earlier reports and requires fresh capture/review. `render-review-sheet`, `record-review --decision approved`, and the review server enforce matching evidence. Historical visual runs without evidence remain available on disk for archival inspection but cannot be served/approved through this updated review path. Wireframe review contracts are unchanged. Directly opening an archived HTML file cannot be prevented by this local workflow gate.

Example capture (Aside app/CLI must be running):

```sh
node scripts/capture-concept.mjs runs/example concept-seed.html seed-a0 390 844
```

The reviewer reads the returned PNG and writes a report with `schemaVersion:1`, `artifactId`, `revisionHash`, `capturePath`, `screenshotHash`, and all seven `checks` (`criterionId`, `status`, `observed`, `reason`, `remediation`, `evidenceRefs`). Paths are run-relative. Validate before packaging:

```sh
node scripts/check-visual-report.mjs runs/example concept-seed concept-seed.html 390 844 visual-evidence/seed-a0.report.json
node --test scripts/checks/visual-quality.test.mjs
node scripts/checks/run-checks.mjs
```

`lane-output.json` must include `visualQuality: {version:1,reports:[{artifactId,path}]}` for each concept. No reported overall score replaces criterion-level passes. General mechanical, specification, accessibility and aesthetic axes also need passing checks for each concept.

Limits: this checks traceability and expected evidence, not cryptographic attestation of a trusted remote browser or an objective proof of taste. Local writers can fabricate reports; hashes establish consistency, not truth. The image reviewer must actually inspect the screenshot and keep an observation trail. Browser `fontsReady` only establishes loading readiness, not that the intended family rendered; the brand-fidelity reviewer must check that separately. Mocked backend behavior and synthetic personas are not real-user research. Fixture test success must not be called a live visual-quality pass.

The capture uses Aside's target-scoped CDP API (not Playwright's unavailable `setViewportSize`) at device scale 1. It records the initial viewport, not every offscreen/scroll state. A multi-screen or scrolling deliverable needs additional captures before claiming coverage beyond that viewport. The initial viewport is the minimum visual evidence for these representative concepts.

## Execution status

The contract tests passed before the request to minimize testing. The full Claude workflow has not been executed. Live capture in the current Aside environment returned PNG dimensions different from the requested viewport, including with an explicit CDP clip. Capture now rejects that mismatch before saving evidence. This browser integration remains a release blocker: the gate is implemented, but an end-to-end passing concept is not yet demonstrated. Do not bypass the dimension check or reuse the diagnostic screenshot as passing evidence.
