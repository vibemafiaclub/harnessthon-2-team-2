import test from "node:test";
import assert from "node:assert/strict";
import { baseState, NOW } from "./fixtures.mjs";
import { recordStageOutput, recordApproval, recordAnswers, refreshStaleness, stageFingerprint } from "../lib/runstate.mjs";

test("changed upstream inputs invalidate later stages and drop bound approvals", () => {
  const state = baseState();
  recordStageOutput(state, "intake", { path: "/a", sha256: "1".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  recordStageOutput(state, "prd_interview", { path: "/q", sha256: "2".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  recordAnswers(state, { answers: [{ id: "Q1", answer: "yes" }], at: NOW });
  recordStageOutput(state, "prd_revise", { path: "/v2", sha256: "3".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  recordApproval(state, "prd_approval", { by: "owner", at: NOW, revision: "4".repeat(64) });
  recordStageOutput(state, "research", { path: "/r", sha256: "5".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  assert.equal(refreshStaleness(state, NOW).length, 0, "nothing stale before inputs change");

  // The PRD source (and thus the materials fingerprint context) changes.
  state.materialsHash = "f".repeat(64);
  const invalidated = refreshStaleness(state, NOW);
  assert.ok(invalidated.includes("intake"));
  assert.ok(invalidated.includes("research"));
  assert.equal(state.stages.research.status, "stale");
  assert.equal(state.approvals.prd_approval, undefined, "approval invalidated");
  assert.equal(state.approvalsHistory.length, 1);
  assert.equal(state.approvalsHistory[0].reason, "upstream_changed:intake");
});

test("ai confirmations can never be recorded as human approvals", () => {
  const state = baseState();
  assert.throws(() => recordApproval(state, "concept_approval", { by: "ai", at: NOW, revision: "1".repeat(64), actor: "ai_confirmed" }), /never approvals/);
  assert.throws(() => recordApproval(state, "research", { by: "x", at: NOW, revision: "1".repeat(64) }), /not a human gate/);
});

test("fingerprints depend on dependency outputs", () => {
  const state = baseState();
  recordStageOutput(state, "prd_interview", { path: "/q", sha256: "2".repeat(64), actor: "ai_confirmed", nowIso: NOW });
  const before = stageFingerprint(state, "prd_answers");
  state.stages.prd_interview.output.sha256 = "9".repeat(64);
  assert.notEqual(stageFingerprint(state, "prd_answers"), before);
});
