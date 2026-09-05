# Ground truth: what each flow consumes and produces

One file per pipeline stage, each holding the stage's **input contract**, a
**representative example** of that input, the **output contract**, a
representative example of the output, and the **handoff** that turns this
stage's output into the next stage's input.

These files are not documentation prose — `integration/tests/groundtruth.test.mjs`
loads every one of them and asserts:

1. the declared `workflow` exists in the adapter registry and its `inputContract.required`
   equals the registry's required-arg list, which is itself checked against the
   real workflow source;
2. each `inputExample` satisfies its own `inputContract`;
3. each `outputExample` satisfies its own `outputContract`;
4. the `handoff` actually derives the next stage's input example from this
   stage's output example, using the real adapter code (no hand-copied values).

So a contract drift in any workflow script, adapter, or converter fails the
tests instead of failing mid-run.

Examples marked `"fromLiveRun"` were extracted from real workflow runs committed
under `runs/` and `research/runs/`; the rest are minimal fixtures. Fixture-based
routing evidence and real-execution evidence are kept separate on purpose —
see `docs/integration.md`.
