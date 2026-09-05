import {
  fail,
  requiredEnum,
  requiredString,
  requiredTime,
  sha256,
  stableStringify,
} from "./canonical.mjs";
import { verifyResearchPackage } from "./evidence.mjs";

export const REVIEW_MANIFEST_SCHEMA = "competitor-research-review-manifest/v1";
export const REVIEW_DECISION_SCHEMA = "competitor-research-review-decision/v1";

// One conversational batch asks exactly these five Korean yes/no questions
// (ported from the lab's `evidence` loop). Approval requires yes to all five.
export const REVIEW_QUESTIONS = Object.freeze([
  { id: "evidence.source", prompt: "표시된 출처·URL·수집 시각이 실제 검토한 자료를 식별하나요?" },
  { id: "evidence.support", prompt: "중요한 주장마다 정확한 인용문 또는 실제 캡처 근거가 연결돼 있나요?" },
  { id: "evidence.conflict", prompt: "충돌하거나 신뢰도가 낮은 근거와 미확인(unknown) 항목이 숨김없이 표시됐나요?" },
  { id: "evidence.currency", prompt: "자료의 시점과 대상 도메인이 이번 결정에 적용하기에 적절한가요?" },
  { id: "evidence.sufficiency", prompt: "이 근거 묶음으로 다음 설계 단계(플로우·비주얼)를 시작해도 안전한가요?" },
].map(Object.freeze));

const DECISIONS = new Set(["approve", "revision", "reject"]);
const CARD_ACTIONS = new Set(["accept", "reject", "request_more"]);

// The manifest is the exact content a person reviews. Approval binds its hash,
// so an approval can never silently cover different content.
export function buildReviewManifest({ researchPackage, round, controlState, generatedAt }) {
  const verification = verifyResearchPackage(researchPackage);
  if (!verification.ok) fail("package_unverified", `Cannot present an unverified package: ${verification.failures.join(", ")}`);
  const body = {
    $schema: REVIEW_MANIFEST_SCHEMA,
    packageHash: researchPackage.payloadHash,
    runId: researchPackage.runId,
    round: boundedRound(round),
    limits: controlState?.limits ? { ...controlState.limits } : null,
    generatedAt: requiredTime(generatedAt, "generatedAt"),
    questions: REVIEW_QUESTIONS.map((question) => ({ ...question })),
    cardPins: researchPackage.cards.map((card) => ({ cardId: card.cardId, cardHash: card.cardHash, status: card.status })),
  };
  return Object.freeze({ ...body, manifestHash: sha256(stableStringify(body)) });
}

export function createReviewDecision({ manifest, decision, responses, cardActions, reviewer, decidedAt, note }) {
  if (!manifest?.manifestHash) fail("manifest_required", "A sealed review manifest is required.");
  const chosen = requiredEnum(decision, DECISIONS, "decision");
  const normalizedResponses = normalizeResponses(responses);
  const normalizedCards = normalizeCardActions(cardActions, manifest);
  if (chosen === "approve") {
    if (normalizedResponses.some((response) => response.answer !== "yes")) {
      fail("approve_negative_response", "Approval requires yes to every review question.");
    }
    if (normalizedCards.some((card) => card.action !== "accept")) {
      fail("approve_rejected_cards", "Approval requires every evidence card to be accepted; use revision or reject instead.");
    }
  }
  const body = {
    $schema: REVIEW_DECISION_SCHEMA,
    decision: chosen,
    manifestHash: manifest.manifestHash,
    packageHash: manifest.packageHash,
    runId: manifest.runId,
    round: manifest.round,
    responses: normalizedResponses,
    cardActions: normalizedCards,
    reviewer: {
      identity: requiredString(reviewer?.identity, 160, "reviewer.identity"),
      role: requiredString(reviewer?.role, 160, "reviewer.role"),
    },
    note: note === undefined || note === null ? null : requiredString(note, 2000, "note"),
    decidedAt: requiredTime(decidedAt, "decidedAt"),
  };
  return Object.freeze({ ...body, decisionHash: sha256(stableStringify(body)) });
}

export function verifyReviewDecision(decisionReceipt, { manifest } = {}) {
  const failures = [];
  try {
    if (!decisionReceipt || decisionReceipt.$schema !== REVIEW_DECISION_SCHEMA) failures.push("invalid_schema");
    const { decisionHash, ...body } = decisionReceipt || {};
    if (decisionHash !== sha256(stableStringify(body))) failures.push("decision_hash_mismatch");
    if (manifest) {
      if (decisionReceipt.manifestHash !== manifest.manifestHash) failures.push("manifest_binding_mismatch");
      if (decisionReceipt.packageHash !== manifest.packageHash) failures.push("package_binding_mismatch");
      const pinned = new Set(manifest.cardPins.map((pin) => pin.cardId));
      const acted = new Set((decisionReceipt.cardActions || []).map((card) => card.cardId));
      if (pinned.size !== acted.size || [...pinned].some((id) => !acted.has(id))) failures.push("card_coverage_mismatch");
    }
    // Re-running normalization enforces the approve invariants (all-yes,
    // all-accept) and canonical shape on verification, not only on creation.
    const reconstructed = createReviewDecision({
      manifest: manifest || { manifestHash: body.manifestHash, packageHash: body.packageHash, runId: body.runId, round: body.round, cardPins: (body.cardActions || []).map((card) => ({ cardId: card.cardId, cardHash: card.cardHash })) },
      decision: body.decision,
      responses: body.responses,
      cardActions: body.cardActions,
      reviewer: body.reviewer,
      decidedAt: body.decidedAt,
      note: body.note,
    });
    if (reconstructed.decisionHash !== decisionHash) failures.push("decision_not_canonical");
  } catch (error) {
    failures.push(error.code || "decision_invalid");
  }
  return { ok: failures.length === 0, failures };
}

function normalizeResponses(value) {
  if (!Array.isArray(value) || value.length !== REVIEW_QUESTIONS.length) {
    fail("response_count", `Exactly ${REVIEW_QUESTIONS.length} responses are required.`);
  }
  const expected = new Set(REVIEW_QUESTIONS.map((question) => question.id));
  const seen = new Set();
  return value
    .map((item) => {
      const questionId = requiredString(item?.questionId, 120, "response.questionId");
      if (!expected.has(questionId) || seen.has(questionId)) fail("response_question", "Responses must match the review questions exactly once.");
      seen.add(questionId);
      return {
        questionId,
        answer: requiredEnum(item?.answer, new Set(["yes", "no"]), "response.answer"),
        note: item?.note ? requiredString(item.note, 1000, "response.note") : null,
      };
    })
    .sort((a, b) => a.questionId.localeCompare(b.questionId));
}

function normalizeCardActions(value, manifest) {
  const pins = new Map((manifest.cardPins || []).map((pin) => [pin.cardId, pin]));
  if (!Array.isArray(value) || value.length !== pins.size) fail("card_action_count", "Every presented card needs exactly one action.");
  const seen = new Set();
  return value
    .map((item) => {
      const cardId = requiredString(item?.cardId, 120, "cardAction.cardId");
      if (!pins.has(cardId) || seen.has(cardId)) fail("card_action_unknown", "Card actions must cover the presented cards exactly once.");
      seen.add(cardId);
      const action = requiredEnum(item?.action, CARD_ACTIONS, "cardAction.action");
      const note = item?.note ? requiredString(item.note, 1000, "cardAction.note") : null;
      if ((action === "reject" || action === "request_more") && !note) {
        fail("card_action_note_required", `Card ${cardId}: reject/request_more requires a note explaining what is needed.`);
      }
      return { cardId, cardHash: pins.get(cardId).cardHash ?? null, action, note };
    })
    .sort((a, b) => a.cardId.localeCompare(b.cardId));
}

function boundedRound(value) {
  const round = Number(value);
  if (!Number.isInteger(round) || round < 1 || round > 50) fail("round_invalid", "round must be an integer between 1 and 50.");
  return round;
}
