import test from "node:test";
import assert from "node:assert/strict";
import { buildRoutePlan } from "../lib/routing.mjs";
import { HUMAN_GATES } from "../lib/runstate.mjs";
import { assessmentFixture, assessedMaterial, registryFixture, baseState, approvedPrdFixture, NOW } from "./fixtures.mjs";

function plan({ materials = [], registry = registryFixture(), reuse = {}, approvedPrd = null, state = baseState(), conflicts = [], intakeQuestions = [] } = {}) {
  return buildRoutePlan({ state, assessment: assessmentFixture({ materials, conflicts, intakeQuestions }), registry, reuse, approvedPrd, nowIso: NOW });
}

function stageOf(p, id) {
  return p.stages.find((s) => s.id === id);
}

test("no materials: full normal path, human gates only at answers/prd/concept approval", () => {
  const p = plan();
  for (const id of ["prd_interview", "prd_revise", "research", "wireframe", "concepts"]) {
    assert.equal(stageOf(p, id).decision, "run", id);
  }
  // Four human boundaries: interview answers, PRD approval, the client's
  // aesthetic answers (the lane refuses to generate without them), and the
  // concept approval. Research and wireframes have none.
  assert.deepEqual([...HUMAN_GATES].sort(), ["concept_answers", "concept_approval", "prd_answers", "prd_approval"]);
  assert.equal(stageOf(p, "research").humanGate, false);
  assert.equal(stageOf(p, "wireframe").humanGate, false);
  assert.equal(stageOf(p, "concept_elicit").humanGate, false);
  assert.equal(stageOf(p, "concept_elicit").decision, "run");
  assert.equal(stageOf(p, "concept_answers").humanGate, true);
  assert.equal(p.pendingQuestions.length, 0);
});

test("a fully adopted template skips elicitation because nothing is generated to steer", () => {
  const p = plan({
    materials: [assessedMaterial("mat-01", "concept_output", { adoptionIntent: { declared: true, quote: "adopt as final concept", coverage: "adequate" } })],
  });
  assert.equal(stageOf(p, "concept_elicit").decision, "reuse");
  assert.equal(stageOf(p, "concept_answers").decision, "reuse");
});

test("a partial template still elicits client aesthetics before generating the gaps", () => {
  const p = plan({
    materials: [assessedMaterial("mat-01", "html_template", { adoptionIntent: { declared: true, quote: "use this", coverage: "partial" } })],
  });
  assert.equal(stageOf(p, "concept_elicit").decision, "run");
  assert.equal(stageOf(p, "concept_answers").decision, "run");
});

test("brand-only materials carry constraints but never skip research/wireframes/concepts", () => {
  const p = plan({ materials: [assessedMaterial("mat-01", "brand_tokens")] });
  assert.equal(stageOf(p, "research").decision, "run");
  assert.equal(stageOf(p, "wireframe").decision, "run");
  assert.equal(stageOf(p, "concepts").decision, "run");
  assert.ok(stageOf(p, "wireframe").evidence.some((e) => e.check === "brand_carried"));
});

test("screenshot-only: treated as visual reference, nothing skipped", () => {
  const p = plan({ materials: [assessedMaterial("mat-01", "screenshot")] });
  assert.equal(stageOf(p, "research").decision, "run");
  assert.ok(stageOf(p, "research").evidence.some((e) => e.check === "visual_reference"));
  assert.equal(stageOf(p, "wireframe").decision, "run");
  assert.equal(stageOf(p, "concepts").decision, "run");
});

test("template alone never proves competitor research", () => {
  const p = plan({ materials: [assessedMaterial("mat-01", "html_template")] });
  assert.equal(stageOf(p, "research").decision, "run");
  assert.ok(stageOf(p, "research").evidence.some((e) => e.check === "template_not_research"));
});

test("partial adopted template routes concepts to repair, approval stays human", () => {
  const p = plan({
    materials: [assessedMaterial("mat-01", "html_template", { adoptionIntent: { declared: true, quote: "use this", coverage: "partial", coverageNote: "landing page only" } })],
  });
  assert.equal(stageOf(p, "concepts").decision, "repair");
  assert.ok(stageOf(p, "concepts").unmetChecks.includes("template_coverage:partial"));
  assert.equal(stageOf(p, "concept_approval").decision, "run");
});

test("explicitly adopted template with adequate coverage bypasses ideation but keeps the approval boundary", () => {
  const p = plan({
    materials: [assessedMaterial("mat-01", "concept_output", { adoptionIntent: { declared: true, quote: "adopt as final concept", coverage: "adequate" } })],
  });
  assert.equal(stageOf(p, "concepts").decision, "reuse");
  assert.ok(stageOf(p, "concepts").evidence.some((e) => e.check === "adoption_intent"));
  assert.equal(stageOf(p, "concept_approval").decision, "run");
  assert.ok(stageOf(p, "concept_approval").rationale.includes("mere attachment is not approval"));
});

test("adoption with exact-revision approval evidence satisfies concept approval", () => {
  const p = plan({
    materials: [assessedMaterial("mat-01", "concept_output", { adoptionIntent: { declared: true, quote: "adopt as final", coverage: "adequate" }, approvedRevisionMatch: "c".repeat(64) })],
  });
  assert.equal(stageOf(p, "concept_approval").decision, "reuse");
  assert.ok(stageOf(p, "concept_approval").evidence.some((e) => e.check === "explicit_revision_approval"));
});

test("verified design system is reused for tokens/components while screens still run", () => {
  const p = plan({ materials: [assessedMaterial("mat-01", "design_system")] });
  const concepts = stageOf(p, "concepts");
  assert.equal(concepts.decision, "run");
  assert.ok(concepts.evidence.some((e) => e.check === "design_system_reuse"));
  assert.deepEqual(concepts.selectedArtifacts, ["mat-01"]);
});

test("user-supplied approved PRD replaces interview stages as recorded reuse", () => {
  const prd = approvedPrdFixture();
  const p = plan({ approvedPrd: { json: prd, sha256: "d".repeat(64), source: "user_supplied", materialId: "mat-01", path: "/fixture/approved.json" } });
  for (const id of ["prd_interview", "prd_answers", "prd_revise", "prd_approval"]) {
    assert.equal(stageOf(p, id).decision, "reuse", id);
  }
});

test("valid research package reuse is evidence-backed; failing checks force a run", () => {
  const okPlan = plan({ reuse: { research: { ok: true, evidence: [{ check: "seal_verified", detail: "x" }], failures: [], candidate: "/r/package.json", packageHash: "e".repeat(64) } } });
  assert.equal(stageOf(okPlan, "research").decision, "reuse");
  const tampered = plan({ reuse: { research: { ok: false, evidence: [], failures: ["seal:payload_hash_mismatch"], candidate: "/r/package.json" } } });
  assert.equal(stageOf(tampered, "research").decision, "run");
  assert.ok(stageOf(tampered, "research").unmetChecks.includes("research_reuse:seal:payload_hash_mismatch"));
});

test("missing workflow adapter blocks the stage explicitly", () => {
  const registry = registryFixture();
  registry["wireframe-lane"] = { ...registry["wireframe-lane"], status: "unregistered", scriptPath: null };
  const p = plan({ registry });
  assert.equal(stageOf(p, "wireframe").decision, "blocked");
  assert.ok(stageOf(p, "wireframe").unmetChecks.includes("adapter:unregistered"));
  assert.equal(stageOf(p, "production").decision, "blocked");
});

test("hash-drifted external adapter is unavailable, not silently used", () => {
  const registry = registryFixture();
  registry["visual-concept-lane"] = { ...registry["visual-concept-lane"], status: "hash_mismatch" };
  const p = plan({ registry });
  assert.equal(stageOf(p, "concepts").decision, "blocked");
  assert.ok(stageOf(p, "concepts").unmetChecks.includes("adapter:hash_mismatch"));
});

test("blocking intake questions and unresolved conflicts surface as pending questions only", () => {
  const p = plan({
    conflicts: [{ kind: "brand_conflict", detail: "primary #111111 vs #222222", materialIds: ["mat-01", "mat-02"] }],
    intakeQuestions: [
      { id: "q-adopt", question: "Adopt the template or reference only?", why: "ambiguous", options: [], blocking: true },
      { id: "q-nice", question: "optional", why: "curiosity", options: [], blocking: false },
    ],
  });
  assert.equal(p.pendingQuestions.length, 2);
  assert.ok(p.pendingQuestions.some((q) => q.id === "q-adopt"));
  assert.ok(p.pendingQuestions.some((q) => q.id.startsWith("conflict:")));
  // answered questions disappear
  const state = baseState();
  state.intakeAnswers = { "q-adopt": { answer: "adopt" }, "conflict:brand_conflict:mat-01+mat-02": { answer: "#111111" } };
  const p2 = plan({ state, conflicts: [{ kind: "brand_conflict", detail: "primary #111111 vs #222222", materialIds: ["mat-01", "mat-02"] }], intakeQuestions: [{ id: "q-adopt", question: "?", why: "", options: [], blocking: true }] });
  assert.equal(p2.pendingQuestions.length, 0);
});
