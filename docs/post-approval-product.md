# Post-approval HTML product prototype

The user's latest scope replaces the original brief's Storybook, component-docs and separate IA deliverables. This lane produces a portable working HTML product and an all-screen/state canvas for final human inspection. It does not publish or transfer anything to Figma.

## Coordinator contract

Invoke Claude's **native Workflow tool** with `scriptPath: "workflows/post-approval-product.mjs"` and `args: {inputPath, outDir, specPath?}`. Paths resolve in this worktree. Use the existing Claude OAuth session; do not use `--bare` (disables OAuth) or `--safe-mode` (disables workflows). Native globals were inspected using installed Claude Code 2.1.259: `agent`, `phase`, `log`, `parallel`, `pipeline`, `workflow`, `args`. The script itself has no filesystem/Node APIs; its agents run the deterministic CLI. The CLI alone is not a native Workflow execution.

Input schema: `contracts/post-approval-input.schema.json`. PRD, selected wireframe and concept, their manifests and an optional normalized spec are relative paths with SHA-256 pins, resolved under `input.root`. Each selected artifact must agree with its lane manifest and PRD ID. Compatibility explicitly binds the PRD and both artifact hashes, representative screen and ordered content blocks. Newest HTML is not presumed valid. Missing or stale metadata is an error, never repaired by fabricating upstream manifests.

Approval is either the most recent matching revision-bound human record for each lane or `user-authorized-scenario` with an explicit authorization and assumption. The demo uses the latter; it does not overwrite existing reviews. No initial review gate is repeated. Contradictory approved branding/structure returns `needs-concept-resolution`; ordinary defects may be repaired three times.

The integrated coordinator now selects the built-in `post-approval-prototype` stage. It first runs `product/integration.mjs` to pin the selected lane artifacts and an immutable coordinator approval snapshot, then supplies `{inputPath, outDir}` to the native workflow. `coordinator-approval` preserves the actual human concept approval and AI-selected wireframe provenance without inventing lane review receipts. When upstream manifests omit block IDs, `normalize-pinned-structure` requires the normalization agent to derive and disclose `spec.sourceEvidence` from the pinned HTML. Production recording requires the matching revision's ready-for-review handoff. Legacy external registrations remain available.

Final coordinator integration changes were not re-tested: the user explicitly stopped further testing and requested immediate merge. Earlier fixture/browser results apply only to their recorded revisions; the full native execution was interrupted rather than reported complete.

The normalization agent reads the pinned sources and creates `contracts/product-spec.schema.json`: screens, states, fields, actions, task paths, tokens, capabilities and exact viewports. PRD brand constraints take priority over client constraints and system defaults; contradictory client/PRD requests are reported. System font fallback is explicit. Actions use stable IDs and target existing screens/states. Unsupported native/backend capabilities are visible explanations, not dead controls. This is a declarative frontend renderer; a product needing a new interaction type must extend and test that renderer rather than claim the unsupported interaction works.

## Representative demo

```sh
node product/fixtures/create-demo.mjs
node product/cli.mjs validate --input product/examples/wedding-input.json
node product/cli.mjs run --input product/examples/wedding-input.json --out product/runs/wedding
node product/browser-check.mjs --out product/runs/wedding
```

The demo pins committed `wf-wedding-r3` wizard and `vc-wedding-r3` shadcn concept. `vc-wedding-r5` has no lane manifest and is deliberately not used. Its assumed approval is authorized by the user's instruction in this session. The attached scheduling screenshots guide the inspection canvas presentation, not a replacement domain or an invented upstream approval.

## Outputs, verification and resume

`state.json` records the current immutable revision, source/spec/input hashes, criterion-specific checks and repair history. Each revision includes HTML/JS/CSS, normalized spec, exact screen/state/viewport matrix, pinned source copies, browser evidence and `handoff.json`. The app opens as an inspection board and can navigate into the working prototype. Local review notes and decisions are exported separately; generation never forges a human acceptance.

`ready-for-review` means frontend checks passed and the output is ready for human inspection, **not human approval or a deployed production service**. Hard failures, subjective feedback and unverified capabilities are distinct. Runtime backend operations are local mocks, explicitly labeled. Hashes alone are not usability evidence.

Resume reuses an unchanged generated revision. Changed inputs/generator source create another revision and invalidate old checks; changed output bytes reject evidence reuse. Interrupted partial generation is rebuilt before being promoted. A repair cannot silently remove required screen/state coverage. Exhausted repairs remain blocked. The coordinator can inspect `node product/cli.mjs status --out DIR` and consume `state.revision/handoff.json`. Keep all paths relative when moving the output package; no absolute reference to another worktree is required.

Documentation presentation research was performed before the scope change: [shadcn Button documentation](https://ui.shadcn.com/docs/components/base/button) and [Storybook React/Vite documentation](https://storybook.js.org/docs/get-started/frameworks/react-vite). Storybook is intentionally excluded from this lane's final output.
