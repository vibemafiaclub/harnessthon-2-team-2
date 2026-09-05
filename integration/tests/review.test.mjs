import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { sha256 } from "../../research/lib/canonical.mjs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { advance } from "../lib/next.mjs";
import { buildRoutePlan } from "../lib/routing.mjs";
import {
  loadRun,
  recordStageOutput,
  recordApproval,
  recordClientPreferences,
  recordConceptReviewRound,
  MAX_CONCEPT_ROUNDS,
} from "../lib/runstate.mjs";
import { loadRegistry, validateArgsAgainstSource, buildInvocation } from "../lib/registry.mjs";
import { renderStatusHtml } from "../lib/statushtml.mjs";
import { baseState, assessmentFixture, registryFixture, makeRunDir, NOW } from "./fixtures.mjs";

// The 시안 리뷰 is the pipeline's one remaining human decision, and it can end
// three ways. These tests pin what each one does to the run: which lane runs
// next, with which round and which feedback, and what happens to a standing
// approval. No workflow is executed here — only the invocation that would be.

const REPO_ROOT = "/fixture-root";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LATER = "2026-09-05T14:00:00.000Z";

// A run that has reached the concept review: concepts generated, nothing
// approved yet.
async function runAtConceptReview({ registry = registryFixture() } = {}) {
  const state = baseState();
  const assessment = assessmentFixture({});
  const runDir = await makeRunDir({ state, materials: [], assessment });
  const approvedPrd = { json: approvedPrdJson(), sha256: "sha256:" + "d".repeat(64), source: "pipeline", path: join(runDir, "approved-prd.json") };
  await writeFile(approvedPrd.path, JSON.stringify(approvedPrd.json));

  recordStageOutput(state, "intake", { path: "/a.json", sha256: "sha256:" + "5".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  recordStageOutput(state, "prd_interview", { path: "/q.json", sha256: "sha256:" + "6".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  state.answers = [{ id: "Q1", answer: "yes" }];
  state.stages.prd_answers = { status: "done", actor: "human_input", satisfiedBy: "x" };
  recordStageOutput(state, "prd_revise", { path: "/v2", sha256: "sha256:" + "8".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  recordApproval(state, "prd_approval", { by: "owner", at: NOW, revision: approvedPrd.sha256 });
  recordStageOutput(state, "research", { path: join(runDir, "research-runs/x/package.json"), sha256: "sha256:" + "9".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  recordStageOutput(state, "concept_elicit", { path: "/qq.json", sha256: "sha256:" + "7".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  state.questionnaire = [{ id: "q-color", kind: "color", question: "어떤 색깔?", options: [] }];
  recordClientPreferences(state, { preferences: { "q-color": "opt-sage" }, at: NOW });
  recordStageOutput(state, "wireframe", { path: join(runDir, "wireframe/lane-output.json"), sha256: "sha256:" + "1".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  state.stages.wireframe.representative = { variantId: "hub", path: join(runDir, "wireframe/wireframe-hub.html"), actor: "ai_confirmed", reason: "clearest" };
  recordStageOutput(state, "concepts", { path: join(runDir, "concepts/lane-output.json"), sha256: "sha256:" + "2".repeat(64), actor: "ai_confirmed", nowIso: NOW });

  const context = (nowIso = LATER) => ({
    state,
    materials: [],
    assessment,
    registry,
    reuse: {},
    approvedPrd,
    plan: buildRoutePlan({ state, assessment, registry, reuse: {}, approvedPrd, nowIso }),
    nowIso,
  });
  return { state, runDir, context };
}

function approvedPrdJson() {
  return {
    $schema: "approved-prd/v1",
    prdId: "prd.fixture.v1",
    title: "Fixture product",
    domain: "fixture domain",
    problem: "People need a fixture.",
    audience: "Fixture users",
    coreTasks: ["do the fixture task"],
    features: [{ featureId: "feat.one", name: "Feature one", description: "First feature." }],
    constraints: [],
    approval: { approvedBy: "owner", approvedAt: NOW },
  };
}

test("style revise: the concept lane runs again with round 2 and the client's feedback", async () => {
  const { state, runDir, context } = await runAtConceptReview();
  const outcome = recordConceptReviewRound(state, { decision: "revise", scope: "style", feedback: "카드가 답답해요, 여백을 더 주세요", by: "client", at: LATER });
  assert.deepEqual(outcome, { blocked: false, round: 2 });

  const action = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(action.type, "invoke_workflow");
  assert.equal(action.stage, "concepts");
  assert.equal(action.workflow, "visual-concept-lane");
  assert.equal(action.input.args.round, 2);
  assert.equal(action.input.args.feedback, "카드가 답답해요, 여백을 더 주세요");
  // A new round writes to its own directory; the reviewed artifacts stay put.
  assert.ok(action.input.args.runDir.endsWith("concepts-r2"));
  // Same touchpoint, not a new one.
  assert.equal(state.conceptReview.rounds.at(-1).actor, "client_instruction");
  assert.equal(state.stages.wireframe.status, "done", "style feedback must not disturb the structure");
});

test("structure revise: routes back to the wireframe lane, and the concepts re-run after it", async () => {
  const { state, runDir, context } = await runAtConceptReview();
  recordConceptReviewRound(state, { decision: "revise", scope: "structure", feedback: "단계가 너무 많아요", by: "client", at: LATER });

  const action = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(action.stage, "wireframe");
  assert.equal(action.workflow, "wireframe-lane");
  assert.equal(action.input.args.round, 2);
  assert.equal(action.input.args.feedback, "단계가 너무 많아요");

  const saved = await loadRun(runDir);
  assert.equal(saved.stages.wireframe.status, "stale");
  assert.equal(saved.stages.concepts.status, "stale", "the concepts stage must re-run because its input changed");
  const plan = buildRoutePlan({ state, assessment: assessmentFixture({}), registry: registryFixture(), reuse: {}, approvedPrd: null, nowIso: LATER });
  assert.ok(plan.stages.find((s) => s.id === "wireframe").evidence.some((e) => e.check === "structural_feedback"));
});

test("recolor: the lane is invoked in its recolor mode, with exactly the args that mode requires", async () => {
  const { state, runDir, context } = await runAtConceptReview();
  recordConceptReviewRound(state, { decision: "recolor", request: "보라색으로 변경해 줘", by: "client", at: LATER });

  const action = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(action.stage, "concepts");
  assert.equal(action.workflow, "visual-concept-recolor");
  assert.deepEqual(Object.keys(action.input.args).sort(), ["prdPath", "recolor", "round", "runDir", "runId", "startedAt"]);
  assert.deepEqual(action.input.args.recolor, { fromRunDir: join(runDir, "concepts"), request: "보라색으로 변경해 줘" });
  assert.equal(action.input.args.recolor.fromRunDir === action.input.args.runDir, false, "recolor copies from the previous round's directory");
  // Recolor is a pass over the existing concepts: it must not re-generate.
  assert.equal(action.input.args.representativeWireframePath, undefined);
  assert.equal(action.input.args.clientPreferences, undefined);
});

test("the recolor adapter's contract matches the real lane source and the ground truth", async () => {
  const registry = loadRegistry(repoRoot);
  const entry = registry["visual-concept-recolor"];
  assert.equal(entry.status, "available");
  assert.equal(entry.scriptPath, registry["visual-concept-lane"].scriptPath, "recolor is another pass over the same lane script");
  assert.deepEqual(await validateArgsAgainstSource(entry), { ok: true, failures: [] });

  const truth = JSON.parse(await readFile(join(repoRoot, "integration/groundtruth/10-concepts.json"), "utf8"));
  assert.deepEqual([...truth.recolorPass.inputContract.required].sort(), [...entry.requiredArgs].sort());
  assert.equal(buildInvocation(registry, "visual-concept-recolor", truth.recolorPass.inputExample).ok, true);
  // The recolor pass must not carry the generation-only args.
  for (const arg of ["representativeWireframePath", "clientPreferences"]) {
    assert.equal(entry.requiredArgs.includes(arg), false, `${arg} is not part of the recolor contract`);
  }
});

test("a revise invalidates a standing concept approval instead of keeping it", async () => {
  const { state, runDir } = await runAtConceptReview();
  recordApproval(state, "concept_approval", { by: "client", at: NOW, revision: "sha256:" + "3".repeat(64), note: "shadcn" });
  assert.ok(state.approvals.concept_approval);

  recordConceptReviewRound(state, { decision: "revise", scope: "style", feedback: "다시", by: "client", at: LATER });
  assert.equal(state.approvals.concept_approval, undefined);
  const dropped = state.approvalsHistory.at(-1);
  assert.equal(dropped.gate, "concept_approval");
  assert.equal(dropped.reason, "concept_review_revise:style");
  assert.equal(dropped.actor, "human_approved", "the history keeps what it actually was");
  assert.notEqual(state.stages.concept_approval.status, "done");
  // The client instruction itself is never recorded as an approval.
  assert.equal(state.conceptReview.rounds.at(-1).actor, "client_instruction");
  assert.ok(!Object.values(state.approvals).some((a) => a.note === "다시"));
  assert.ok(runDir);
});

test("the round budget is finite: an exhausted concept review blocks with a reason", async () => {
  const { state, runDir, context } = await runAtConceptReview();
  for (let round = 2; round <= MAX_CONCEPT_ROUNDS; round += 1) {
    const outcome = recordConceptReviewRound(state, { decision: "revise", scope: "style", feedback: `round ${round}`, by: "client", at: LATER });
    assert.deepEqual(outcome, { blocked: false, round });
    // Each round has to actually produce concepts before the next request.
    recordStageOutput(state, "concepts", { path: join(runDir, `concepts-r${round}/lane-output.json`), sha256: "sha256:" + String(round).repeat(64).slice(0, 64), actor: "ai_confirmed", nowIso: LATER });
  }
  const blocked = recordConceptReviewRound(state, { decision: "revise", scope: "style", feedback: "한 번 더", by: "client", at: LATER });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.round, MAX_CONCEPT_ROUNDS, "a refused request does not bump the round");
  assert.match(blocked.reason, /상한/);
  assert.equal(state.conceptReview.rounds.length, MAX_CONCEPT_ROUNDS - 1);

  // The last round's concepts exist, so the block surfaces at the touchpoint
  // itself: the client is not asked to approve work they already rejected.
  const action = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(action.type, "blocked");
  assert.equal(action.stage, "concept_approval");
  assert.equal(action.reason, state.conceptReview.blocked.reason);
  assert.deepEqual(action.unmetChecks, [`concept_rounds_exhausted:${MAX_CONCEPT_ROUNDS}`]);
  // Further instructions are refused rather than silently queued.
  assert.throws(() => recordConceptReviewRound(state, { decision: "recolor", request: "파란색", by: "client", at: LATER }), /blocked/);
});

test("approve still binds to the exact reviewed revision, including after a revise round", async () => {
  const { state, runDir, context } = await runAtConceptReview();
  const laneDir = join(runDir, "concepts-r2");
  await mkdir(laneDir, { recursive: true });
  recordConceptReviewRound(state, { decision: "revise", scope: "style", feedback: "다시", by: "client", at: LATER });
  recordStageOutput(state, "concepts", { path: join(laneDir, "lane-output.json"), sha256: "sha256:" + "b".repeat(64), actor: "ai_confirmed", nowIso: LATER });
  await writeFile(join(laneDir, "lane-output.json"), JSON.stringify({
    laneId: "visual-concept",
    artifacts: [{ id: "concept-seed", conceptId: "seed", path: "concept-seed.html", revisionHash: "c".repeat(64) }],
  }));

  const action = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(action.type, "user_decision");
  assert.equal(action.kind, "concept_approval");
  const ask = action.asks[0];
  assert.equal(ask.payload.round, 2);
  assert.equal(ask.payload.rounds.at(-1).decision, "revise");
  assert.deepEqual(ask.payload.concepts, [{ conceptId: "seed", path: join(laneDir, "concept-seed.html"), revisionHash: "c".repeat(64) }]);
  assert.match(action.how, /--decision revise/);

  recordApproval(state, "concept_approval", { by: "client", at: LATER, revision: "c".repeat(64), note: "seed" });
  const after = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(after.type, "blocked");
  assert.equal(after.stage, "production", "an approved second round carries on to production like any other");
});

test("a review round refuses to masquerade as an approval, and validates its own arguments", async () => {
  const { state } = await runAtConceptReview();
  assert.throws(() => recordConceptReviewRound(state, { decision: "approve", by: "client", at: LATER }), /not a revision decision/);
  assert.throws(() => recordConceptReviewRound(state, { decision: "revise", scope: "colour", feedback: "x", by: "client", at: LATER }), /scope style\|structure/);
  assert.throws(() => recordConceptReviewRound(state, { decision: "revise", scope: "style", by: "client", at: LATER }), /feedback/);
  assert.throws(() => recordConceptReviewRound(state, { decision: "recolor", by: "client", at: LATER }), /request/);
  assert.throws(() => recordConceptReviewRound(state, { decision: "revise", scope: "style", feedback: "x", at: LATER }), /who asked/);
  assert.equal(state.conceptReview ?? null, null, "nothing is recorded when the request is rejected");
});

test("the CLI records all three decisions, and only approve produces an approval", async () => {
  const { state, runDir } = await runAtConceptReview();
  const laneDir = join(runDir, "concepts");
  await mkdir(laneDir, { recursive: true });
  await writeFile(join(laneDir, "concept-seed.html"), "<!doctype html><html lang=\"ko\"></html>");
  const revisionHash = sha256(await readFile(join(laneDir, "concept-seed.html")));
  await writeFile(join(laneDir, "lane-output.json"), JSON.stringify({
    laneId: "visual-concept",
    artifacts: [{ id: "concept-seed", conceptId: "seed", path: "concept-seed.html", revisionHash }],
  }));
  await writeFile(join(runDir, "state.json"), JSON.stringify(state, null, 2));

  const cli = (...argv) => spawnSync(process.execPath, [join(repoRoot, "integration/bin/integrate.mjs"), "review", runDir, "concept_review", ...argv], { encoding: "utf8" });

  const recolor = cli("--decision", "recolor", "--by", "client", "--request", "보라색으로 변경해 줘");
  assert.equal(recolor.status, 0, recolor.stderr);
  assert.match(recolor.stdout, /concept round 2/);
  let saved = await loadRun(runDir);
  assert.equal(saved.approvals.concept_approval, undefined);
  assert.equal(saved.stages.concepts.recolor.request, "보라색으로 변경해 줘");

  const revise = cli("--decision", "revise", "--by", "client", "--scope", "structure", "--feedback", "단계가 너무 많아요");
  assert.equal(revise.status, 0, revise.stderr);
  saved = await loadRun(runDir);
  assert.equal(saved.stages.wireframe.feedback, "단계가 너무 많아요");
  assert.equal(saved.stages.concepts.recolor, null, "a revise supersedes a pending recolor");
  assert.equal(saved.conceptReview.rounds.length, 2);
  assert.ok(saved.conceptReview.rounds.every((r) => r.actor === "client_instruction"));

  const badScope = cli("--decision", "revise", "--by", "client", "--scope", "vibes", "--feedback", "x");
  assert.equal(badScope.status, 1);
  assert.match(badScope.stderr, /scope style\|structure/);

  // approve is still the same revision-bound, tamper-checked approval.
  const approve = cli("--decision", "approve", "--by", "client", "--concept", "seed");
  assert.equal(approve.status, 0, approve.stderr);
  saved = await loadRun(runDir);
  assert.equal(saved.approvals.concept_approval.actor, "human_approved");
  assert.equal(saved.approvals.concept_approval.revision, revisionHash);
  assert.equal(saved.approvals.concept_approval.note, "seed");

  // The legacy approve subcommand keeps working, and still refuses a tampered file.
  await writeFile(join(laneDir, "concept-seed.html"), "<!doctype html><html lang=\"ko\"><!-- edited --></html>");
  const tampered = spawnSync(process.execPath, [join(repoRoot, "integration/bin/integrate.mjs"), "approve", runDir, "concept_approval", "--by", "client", "--concept", "seed"], { encoding: "utf8" });
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /tampered/);
});

test("recolor needs a previous round to recolor, and the status view reports the rounds as instructions", async () => {
  const { state, runDir } = await runAtConceptReview();
  const fresh = baseState();
  assert.throws(() => recordConceptReviewRound(fresh, { decision: "recolor", request: "보라색", by: "client", at: LATER }), /previous concepts round/);

  recordConceptReviewRound(state, { decision: "recolor", request: "보라색으로 변경해 줘", by: "client", at: LATER });
  const html = renderStatusHtml({ state, materials: [], assessment: null, plan: null, nextAction: null });
  assert.ok(html.includes("시안 리뷰 라운드"));
  assert.ok(html.includes("메인 컬러 변경 요청"));
  assert.ok(html.includes("client_instruction"));
  assert.ok(html.includes("보라색으로 변경해 줘"));
  assert.ok(runDir);
});
