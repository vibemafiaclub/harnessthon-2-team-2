# Runtime verification — 2026-09-05

Main was synchronized before these execution fixes. No Figma access or publication was performed.

## Verified

- `npm ci --prefix product --ignore-scripts` installed the pinned browser dependency.
- `node --test integration/tests/ product/tests/ scripts/checks/visual-quality.test.mjs`: 89 passed, zero failed.
- `node integration/bin/integrate.mjs init --request integration/examples/request.wedding-scheduler.json --run-id main-execution-check`: created a persisted run and a real intake Workflow invocation.
- `node scripts/capture-concept.mjs runs/vc-wedding-r3 concept-seed.html chromium-smoke 390 844`: actual Chromium PNG and browser viewport both 390x844; fonts ready, no horizontal overflow or broken images.
- The committed wedding scenario generated through `product/cli.mjs` and reached `ready-for-review` after `product/browser-check.mjs`: 30 screen/state/viewport combinations, 16 controls, two task journeys with eight clicks, form recovery, keyboard focus, portable HTML and inspection board checks passed.

The wedding scenario uses its existing explicit assumed approval. These results are not a new human approval or an aesthetic evaluation of the concept.

## Fixed

- Isolated Chromium capture replaces the dimension-mismatched Aside capture path; dimensions and evidence hashes remain enforced.
- Production ground truth now names the implemented native workflow.
- Reused wireframes retain their representative revision hash; external lane sources are snapshotted inside the production input root without changing source bytes.
- Invalid specifications route to normalization; broken input pins still block.
- Deferred structure normalization uses its derived section order instead of requiring an empty upstream order.

## Not claimed

Claude OAuth reported authenticated. A native intake Workflow invocation was requested, but the user requested immediate push without waiting for its response. Native Workflow completion and a fresh end-to-end PRD-to-concepts-to-product run therefore remain unverified. The three-concept aesthetic evaluation loop and final Figma transfer were not run.
