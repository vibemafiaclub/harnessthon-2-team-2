import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { advance } from "../lib/next.mjs";
import { buildRoutePlan } from "../lib/routing.mjs";
import { loadRun, recordStageOutput, recordApproval, recordAnswers, recordClientPreferences } from "../lib/runstate.mjs";
import { baseState, assessmentFixture, assessedMaterial, acquiredMaterial, registryFixture, approvedPrdFixture, makeRunDir, tempDir, NOW } from "./fixtures.mjs";

const REPO_ROOT = "/fixture-root";

async function makeContext({ state, materials = [], assessmentMaterials = [], approvedPrd = null, reuse = {}, registry = registryFixture() }) {
  const assessment = assessmentFixture({ materials: assessmentMaterials });
  const runDir = await makeRunDir({ state, materials, assessment });
  const context = () => ({
    state,
    materials,
    assessment,
    registry,
    reuse,
    approvedPrd,
    plan: buildRoutePlan({ state, assessment, registry, reuse, approvedPrd, nowIso: NOW }),
    nowIso: NOW,
  });
  return { runDir, context };
}

function suppliedApprovedPrd(path) {
  const json = approvedPrdFixture();
  return { json, sha256: "sha256:" + "d".repeat(64), source: "user_supplied", materialId: "mat-01", path };
}

test("approved PRD + verified research reuse: pipeline drives straight to the wireframe workflow, no fake progress", async () => {
  const state = baseState();
  const prdDir = await tempDir();
  const approvedPath = join(prdDir, "approved.json");
  await writeFile(approvedPath, JSON.stringify(approvedPrdFixture()));
  const approvedPrd = suppliedApprovedPrd(approvedPath);
  const reuse = { research: { ok: true, evidence: [{ check: "seal_verified", detail: "x" }], failures: [], candidate: join(prdDir, "package.json"), packageHash: "sha256:" + "e".repeat(64) } };
  const { runDir, context } = await makeContext({
    state,
    materials: [acquiredMaterial("mat-01", { declaredRole: "approved-prd" })],
    assessmentMaterials: [assessedMaterial("mat-01", "approved_prd")],
    approvedPrd,
    reuse,
  });
  state.stages.intake = { status: "done", fingerprint: null };
  // The aesthetic questionnaire is produced and answered during the PRD review,
  // before any generation; here it is already done.
  recordStageOutput(state, "concept_elicit", { path: join(runDir, "concept-questionnaire.json"), sha256: "sha256:" + "7".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  state.questionnaire = [{ id: "q-color", kind: "color", question: "어떤 색깔로 하면 좋을까요?", options: [] }];
  recordClientPreferences(state, { preferences: { "q-color": "opt-sage" }, at: NOW });

  const action = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(action.type, "invoke_workflow");
  assert.equal(action.stage, "wireframe");
  assert.equal(action.workflow, "wireframe-lane");
  // Reuse was applied and recorded as reuse of checked artifacts, not generation.
  const saved = await loadRun(runDir);
  for (const id of ["prd_interview", "prd_answers", "prd_revise"]) {
    assert.equal(saved.stages[id].status, "done");
    assert.equal(saved.stages[id].actor, "reuse_checked");
    assert.equal(saved.stages[id].decision, "reuse");
  }
  assert.equal(saved.approvals.prd_approval.by, "fixture-owner");
  assert.equal(saved.stages.research.actor, "reuse_checked");
  // The lane PRD conversion preserved client brand values verbatim.
  const lanePrd = JSON.parse(await readFile(join(runDir, "lane-prd.json"), "utf8"));
  assert.ok(JSON.stringify(lanePrd.brandHints).includes("#123456"));
  assert.ok(JSON.stringify(lanePrd.brandHints).includes("Fixture Serif"));
  assert.equal(lanePrd.researchHandoff.approvedRevision, reuse.research.packageHash);
  // Wireframe args are the lane's actual contract.
  assert.deepEqual(Object.keys(action.input.args).sort(), ["prdPath", "round", "runDir", "runId", "startedAt"]);

  // Simulate the wireframe workflow having run; auto-selected representative is ai_confirmed.
  recordStageOutput(state, "wireframe", { path: join(runDir, "wireframe/lane-output.json"), sha256: "sha256:" + "1".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  state.stages.wireframe.representative = { variantId: "hub", path: join(runDir, "wireframe/wireframe-hub.html"), actor: "ai_confirmed", reason: "clearest" };

  const action2 = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(action2.stage, "concepts");
  assert.equal(action2.input.args.representativeWireframePath, join(runDir, "wireframe/wireframe-hub.html"));
  assert.equal(action2.input.args.representativeVariant.selectedBy, "ai_confirmed");
  assert.deepEqual(action2.input.args.clientPreferences, { "q-color": "opt-sage" });

  // Concepts recorded → the next step is the HUMAN concept approval, nothing auto-approves.
  recordStageOutput(state, "concepts", { path: join(runDir, "concepts/lane-output.json"), sha256: "sha256:" + "2".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  const action3 = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(action3.type, "user_decision");
  assert.equal(action3.kind, "concept_approval");

  recordApproval(state, "concept_approval", { by: "client", at: NOW, revision: "sha256:" + "3".repeat(64) });
  const action4 = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(action4.type, "blocked");
  assert.equal(action4.stage, "production");

  // Resume: nothing re-executes, same terminal action, stages untouched.
  const before = JSON.stringify((await loadRun(runDir)).stages);
  const resumed = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(resumed.type, "blocked");
  assert.equal(JSON.stringify((await loadRun(runDir)).stages), before);
});

test("the human is interrupted exactly twice: PRD review, then concept review", async () => {
  const state = baseState();
  const { runDir, context } = await makeContext({ state });
  state.stages.intake = { status: "done", fingerprint: null };

  // 1. Interview workflow.
  const a1 = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(a1.type, "invoke_workflow");
  assert.equal(a1.stage, "prd_interview");
  assert.equal(a1.input.args.prdPath, state.request.prd.path);
  assert.ok(a1.input.args.promptsDir.includes(".claude/workflows/prd-interview/prompts"));
  recordStageOutput(state, "prd_interview", { path: "/q.json", sha256: "sha256:" + "4".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  state.questions = [{ id: "Q1", question: "?" }];

  // 2. The aesthetic questionnaire is generated BEFORE the human is called,
  //    so it can be asked in the same sitting. It needs no approved PRD.
  const a2 = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(a2.type, "invoke_workflow");
  assert.equal(a2.stage, "concept_elicit");
  assert.ok(a2.input.args.prdPath.endsWith("lane-prd.draft.json"), "elicitation runs off the provisional lane PRD");
  assert.equal(a2.input.args.clientPreferences, undefined);
  recordStageOutput(state, "concept_elicit", { path: "/qq.json", sha256: "sha256:" + "7".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  state.questionnaire = [{ id: "q-color", kind: "color", question: "어떤 색깔?", options: [] }];

  // TOUCHPOINT 1 — one interruption carrying both question sets.
  const t1 = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(t1.type, "user_decision");
  assert.equal(t1.touchpoint, "prd_review");
  assert.deepEqual(t1.asks.map((a) => a.kind), ["interview_answers", "client_preferences"]);
  assert.deepEqual(t1.remainingInTouchpoint, ["prd_approval"], "approval follows in the same review, after PRD-v2 exists");
  recordAnswers(state, { answers: [{ id: "Q1", answer: "yes" }], at: NOW });
  recordClientPreferences(state, { preferences: { "q-color": "opt-sage" }, at: NOW });

  // 3. Revise, then the approval half of the same PRD review.
  const a3 = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(a3.stage, "prd_revise");
  assert.deepEqual(a3.input.args.answers, [{ id: "Q1", answer: "yes" }]);
  recordStageOutput(state, "prd_revise", { path: "/PRD-v2.md", sha256: "sha256:" + "8".repeat(64), actor: "ai_confirmed", nowIso: NOW });

  const t1b = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(t1b.touchpoint, "prd_review");
  assert.equal(t1b.kind, "prd_approval");
});

test("changed inputs invalidate downstream work and route back to intake", async () => {
  const state = baseState();
  const { runDir, context } = await makeContext({ state });
  recordStageOutput(state, "intake", { path: "/a.json", sha256: "sha256:" + "5".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  recordStageOutput(state, "prd_interview", { path: "/q.json", sha256: "sha256:" + "6".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  // Materials change (e.g. the user swapped the template file).
  state.materialsHash = "sha256:" + "f".repeat(64);
  const action = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(action.stage, "intake");
  const saved = await loadRun(runDir);
  assert.equal(saved.stages.prd_interview.status, "stale");
});

test("unregistered lane adapter blocks with a clear status instead of pretending to execute", async () => {
  const registry = registryFixture();
  registry["wireframe-lane"] = { ...registry["wireframe-lane"], status: "unregistered", scriptPath: null };
  const state = baseState();
  const prdDir = await tempDir();
  const approvedPath = join(prdDir, "approved.json");
  await writeFile(approvedPath, JSON.stringify(approvedPrdFixture()));
  const { runDir, context } = await makeContext({
    state,
    materials: [acquiredMaterial("mat-01", { declaredRole: "approved-prd" })],
    assessmentMaterials: [assessedMaterial("mat-01", "approved_prd")],
    approvedPrd: suppliedApprovedPrd(approvedPath),
    reuse: { research: { ok: true, evidence: [], failures: [], candidate: join(prdDir, "package.json"), packageHash: "sha256:" + "e".repeat(64) } },
    registry,
  });
  state.stages.intake = { status: "done", fingerprint: null };
  recordStageOutput(state, "concept_elicit", { path: "/qq.json", sha256: "sha256:" + "7".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  recordClientPreferences(state, { preferences: { "q-color": "opt-sage" }, at: NOW });
  const action = await advance({ repoRoot: REPO_ROOT, runDir, context: context() });
  assert.equal(action.type, "blocked");
  assert.equal(action.stage, "wireframe");
  assert.deepEqual(action.unmetChecks, ["adapter:unregistered"]);
});
