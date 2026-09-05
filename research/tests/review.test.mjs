import test from "node:test";
import assert from "node:assert/strict";
import { sealLegacyPackage as sealResearchPackage } from "./fixtures.mjs";
import { buildReviewManifest, createReviewDecision, verifyReviewDecision, REVIEW_QUESTIONS } from "../lib/review.mjs";
import { createControlState, recordAutoRepair, recordHumanRound, remaining } from "../lib/limits.mjs";
import { sha256 } from "../lib/canonical.mjs";
import { draftFor, NOW } from "./fixtures.mjs";

function sealedPackage(domain = "wedding") {
  return sealResearchPackage({
    runId: `run-${domain}`,
    prd: { prdId: `prd.${domain}`, title: "t", domain, payloadHash: sha256("prd") },
    ...draftFor(domain),
  });
}

function answers(value) {
  return REVIEW_QUESTIONS.map((question) => ({ questionId: question.id, answer: value }));
}

function acceptAll(pkg) {
  return pkg.cards.map((card) => ({ cardId: card.cardId, action: "accept" }));
}

test("manifest binds package hash and exposes five Korean questions and limits", () => {
  const pkg = sealedPackage();
  const control = createControlState();
  const manifest = buildReviewManifest({ researchPackage: pkg, round: 1, controlState: control, generatedAt: NOW });
  assert.equal(manifest.packageHash, pkg.payloadHash);
  assert.equal(manifest.questions.length, 5);
  assert.deepEqual(manifest.limits, { maxAutoRepairs: 3, maxHumanRounds: 5 });
  assert.equal(manifest.cardPins.length, pkg.cards.length);
});

test("approve requires all-yes answers", () => {
  const pkg = sealedPackage();
  const manifest = buildReviewManifest({ researchPackage: pkg, round: 1, controlState: createControlState(), generatedAt: NOW });
  const responses = answers("yes");
  responses[2].answer = "no";
  assert.throws(
    () => createReviewDecision({ manifest, decision: "approve", responses, cardActions: acceptAll(pkg), reviewer: { identity: "simon", role: "reviewer" }, decidedAt: NOW }),
    { code: "approve_negative_response" },
  );
});

test("approve requires every card accepted; reject/request_more need notes", () => {
  const pkg = sealedPackage("habit");
  const manifest = buildReviewManifest({ researchPackage: pkg, round: 1, controlState: createControlState(), generatedAt: NOW });
  const actions = acceptAll(pkg);
  actions[0] = { cardId: actions[0].cardId, action: "request_more", note: "need a second source" };
  assert.throws(
    () => createReviewDecision({ manifest, decision: "approve", responses: answers("yes"), cardActions: actions, reviewer: { identity: "simon", role: "reviewer" }, decidedAt: NOW }),
    { code: "approve_rejected_cards" },
  );
  assert.throws(
    () => createReviewDecision({ manifest, decision: "revision", responses: answers("yes"), cardActions: [{ cardId: actions[0].cardId, action: "reject" }, ...acceptAll(pkg).slice(1)], reviewer: { identity: "simon", role: "reviewer" }, decidedAt: NOW }),
    { code: "card_action_note_required" },
  );
  const revision = createReviewDecision({ manifest, decision: "revision", responses: answers("yes"), cardActions: actions, reviewer: { identity: "simon", role: "reviewer" }, decidedAt: NOW });
  assert.equal(revision.decision, "revision");
});

test("approval binds the exact reviewed manifest; verification catches tampering", () => {
  const pkg = sealedPackage();
  const manifest = buildReviewManifest({ researchPackage: pkg, round: 1, controlState: createControlState(), generatedAt: NOW });
  const receipt = createReviewDecision({ manifest, decision: "approve", responses: answers("yes"), cardActions: acceptAll(pkg), reviewer: { identity: "simon", role: "reviewer" }, decidedAt: NOW });
  assert.equal(receipt.manifestHash, manifest.manifestHash);
  assert.equal(receipt.packageHash, pkg.payloadHash);
  assert.deepEqual(verifyReviewDecision(receipt, { manifest }), { ok: true, failures: [] });

  const tampered = { ...receipt, decision: "approve", note: "edited after signing" };
  const check = verifyReviewDecision(tampered, { manifest });
  assert.equal(check.ok, false);
  assert.ok(check.failures.includes("decision_hash_mismatch"));

  const otherManifest = buildReviewManifest({ researchPackage: sealedPackage("habit"), round: 1, controlState: createControlState(), generatedAt: NOW });
  const cross = verifyReviewDecision(receipt, { manifest: otherManifest });
  assert.equal(cross.ok, false);
  assert.ok(cross.failures.includes("manifest_binding_mismatch"));
});

test("limits: three auto repairs then escalation; five human rounds then escalation; limits configurable", () => {
  const state = createControlState();
  for (let i = 0; i < 3; i += 1) recordAutoRepair(state, `repair ${i + 1}`);
  assert.equal(state.escalated, false);
  recordAutoRepair(state, "over the limit");
  assert.equal(state.escalated, true);
  assert.match(state.escalationReason, /Automatic repair limit/);

  const humanState = createControlState({ maxHumanRounds: 2 });
  recordHumanRound(humanState, "round 1");
  recordHumanRound(humanState, "round 2");
  assert.deepEqual(remaining(humanState), { autoRepairs: 3, humanRounds: 0, escalated: false });
  recordHumanRound(humanState, "round 3");
  assert.equal(humanState.escalated, true);
  assert.throws(() => recordHumanRound(humanState, "after escalation"), { code: "already_escalated" });
});
