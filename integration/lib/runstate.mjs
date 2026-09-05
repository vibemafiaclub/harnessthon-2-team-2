import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sha256, stableStringify } from "../../research/lib/canonical.mjs";
import { DEFAULT_LIMITS } from "../../research/lib/limits.mjs";

// Persisted JSON run state for an integration run. Human approvals bind to
// exact revisions; when upstream inputs change, dependent stage outputs and
// approvals are invalidated (kept in history, never silently reused).

export const STAGES = [
  { id: "intake", dependsOn: [], humanGate: false, workflow: "intake-assess" },
  { id: "prd_interview", dependsOn: ["intake"], humanGate: false, workflow: "prd-interview" },
  // The visual-concept lane refuses to generate before the client has answered
  // its aesthetic questionnaire. That questionnaire only needs the product's
  // domain and brand context, so it is produced right after intake and asked
  // during the PRD review — it does NOT become a third human touchpoint.
  { id: "concept_elicit", dependsOn: ["intake"], humanGate: false, workflow: "visual-concept-elicit" },
  { id: "prd_answers", dependsOn: ["prd_interview"], humanGate: true, touchpoint: "prd_review", workflow: null },
  { id: "concept_answers", dependsOn: ["concept_elicit"], humanGate: true, touchpoint: "prd_review", workflow: null },
  { id: "prd_revise", dependsOn: ["prd_answers"], humanGate: false, workflow: "prd-interview-revise" },
  { id: "prd_approval", dependsOn: ["prd_revise"], humanGate: true, touchpoint: "prd_review", workflow: null },
  { id: "research", dependsOn: ["prd_approval"], humanGate: false, workflow: "competitor-reference" },
  { id: "wireframe", dependsOn: ["research"], humanGate: false, workflow: "wireframe-lane" },
  { id: "concepts", dependsOn: ["wireframe", "concept_answers"], humanGate: false, workflow: "visual-concept-lane" },
  { id: "concept_approval", dependsOn: ["concepts"], humanGate: true, touchpoint: "concept_review", workflow: null },
  { id: "production", dependsOn: ["concept_approval"], humanGate: false, workflow: "post-approval-prototype" },
];

// Exactly two moments interrupt the human (user directive 2026-09-05):
// the PRD review and the concept (시안) review. Every human gate belongs to one
// of them; research, wireframes and concept generation run without any gate.
export const TOUCHPOINTS = [
  {
    id: "prd_review",
    title: "PRD 리뷰",
    gates: ["prd_answers", "concept_answers", "prd_approval"],
    description: "인터뷰 미결 질문 + 클라이언트 미감 질문지를 한자리에서 묻고, 반영된 PRD-v2를 승인받는다.",
  },
  {
    id: "concept_review",
    title: "시안 리뷰",
    gates: ["concept_approval"],
    description: "세 가지 시안 중 하나를 클라이언트가 고른다. 파이프라인의 마지막 사람 결정.",
  },
];

// The 시안 리뷰 can repeat, but not forever: the project-wide loop contract
// (research/lib/limits.mjs) allows five human-directed rounds before
// escalation. Round 1 is the first generated batch, so the fifth is the last
// round a client instruction may ask for.
export const MAX_CONCEPT_ROUNDS = DEFAULT_LIMITS.maxHumanRounds;

export function touchpointOf(stageId) {
  return TOUCHPOINTS.find((t) => t.gates.includes(stageId)) ?? null;
}

// Human gates in the same touchpoint whose dependencies are already satisfied,
// so the session can ask them together instead of interrupting twice.
export function readyGatesInTouchpoint(state, touchpointId) {
  const touchpoint = TOUCHPOINTS.find((t) => t.id === touchpointId);
  if (!touchpoint) return [];
  return touchpoint.gates.filter((gateId) => {
    const stage = state.stages[gateId];
    if (!stage || stage.status === "done") return false;
    return stageDef(gateId).dependsOn.every((dep) => state.stages[dep]?.status === "done");
  });
}

export const STAGE_ORDER = STAGES.map((s) => s.id);
export const HUMAN_GATES = new Set(STAGES.filter((s) => s.humanGate).map((s) => s.id));

export function stageDef(stageId) {
  const def = STAGES.find((s) => s.id === stageId);
  if (!def) throw new Error(`unknown stage: ${stageId}`);
  return def;
}

export async function createRun(runsDir, runId, { request, materials, materialsHash, nowIso }) {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{1,120}$/.test(String(runId || ""))) throw new Error("invalid runId");
  const runDir = resolve(runsDir, runId);
  await mkdir(runDir, { recursive: true });
  const state = {
    runId,
    createdAt: nowIso,
    request,
    materialsHash,
    stages: Object.fromEntries(STAGE_ORDER.map((id) => [id, { status: "pending" }])),
    approvals: {},
    approvalsHistory: [],
    intakeAnswers: {},
    events: [{ at: nowIso, event: "run_created" }],
  };
  await writeFile(join(runDir, "materials.json"), `${JSON.stringify(materials, null, 2)}\n`);
  await saveRun(runDir, state);
  return { runDir, state };
}

export async function loadRun(runDir) {
  return JSON.parse(await readFile(join(runDir, "state.json"), "utf8"));
}

export async function saveRun(runDir, state) {
  state.updatedAt = new Date().toISOString();
  await writeFile(join(runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export async function readRunJson(runDir, name) {
  return JSON.parse(await readFile(join(runDir, `${name}.json`), "utf8"));
}

export async function writeRunJson(runDir, name, value) {
  await writeFile(join(runDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  return sha256(stableStringify(value));
}

// Fingerprint of everything a stage's output depends on. Recomputed on every
// pass; a mismatch with the recorded fingerprint marks the stage stale.
export function stageFingerprint(state, stageId) {
  const def = stageDef(stageId);
  const parts = { stageId };
  if (stageId === "intake") {
    parts.materialsHash = state.materialsHash;
    parts.prdSource = state.request?.prd?.sha256 ?? null;
  } else {
    parts.materialsHash = state.materialsHash;
    for (const dep of def.dependsOn) {
      parts[`dep:${dep}`] = state.stages[dep]?.output?.sha256 ?? state.stages[dep]?.satisfiedBy ?? null;
    }
    if (["research", "wireframe", "concepts"].includes(stageId)) {
      parts.approvedPrd = state.approvals.prd_approval?.revision ?? null;
    }
    if (stageId === "concepts") {
      parts.clientPreferences = state.clientPreferences ? sha256(stableStringify(state.clientPreferences)) : null;
    }
    // A revise/recolor round is different work over the same inputs; without
    // these the new round would silently reuse the previous round's output.
    if (stageId === "wireframe" || stageId === "concepts") {
      const stage = state.stages[stageId] ?? {};
      parts.round = stage.round ?? 1;
      parts.feedback = stage.feedback ? sha256(stableStringify(stage.feedback)) : null;
      parts.recolor = stage.recolor ? sha256(stableStringify(stage.recolor)) : null;
    }
    if (stageId === "production") {
      parts.conceptApproval = state.approvals.concept_approval?.revision ?? null;
    }
  }
  return sha256(stableStringify(parts));
}

export function recordStageOutput(state, stageId, { path, sha256: digest, actor, summary, nowIso, decision }) {
  const stage = state.stages[stageId];
  stage.status = "done";
  stage.actor = actor;
  stage.decision = decision ?? stage.decision ?? "run";
  stage.output = { path: path ?? null, sha256: digest ?? null, recordedAt: nowIso, summary: summary ?? null };
  stage.fingerprint = stageFingerprint(state, stageId);
  state.events.push({ at: nowIso, event: "stage_recorded", stageId, actor, sha256: digest ?? null });
  return state;
}

// Walks stages in order; any done stage whose recorded fingerprint no longer
// matches the current inputs becomes stale, its output kept only in history.
// Approvals bound to a revision that no longer matches are dropped too.
export function refreshStaleness(state, nowIso = new Date().toISOString()) {
  const invalidated = [];
  const stale = new Set();
  for (const id of STAGE_ORDER) {
    const stage = state.stages[id];
    if (stage.status !== "done") {
      if (stage.status === "stale") stale.add(id);
      continue;
    }
    const current = stageFingerprint(state, id);
    // A stale dependency invalidates this stage even when its own fingerprint
    // still matches: the dependency keeps its now-superseded output hash.
    const upstreamStale = stageDef(id).dependsOn.some((dep) => stale.has(dep));
    if (upstreamStale || (stage.fingerprint && stage.fingerprint !== current)) {
      stale.add(id);
      stage.status = "stale";
      stage.staleSince = nowIso;
      invalidated.push(id);
      // Downstream approvals bound to this stage's (now invalid) output chain.
      for (const [gate, approval] of Object.entries(state.approvals)) {
        const gateIndex = STAGE_ORDER.indexOf(gate);
        if (gateIndex >= STAGE_ORDER.indexOf(id)) {
          state.approvalsHistory.push({ ...approval, gate, invalidatedAt: nowIso, reason: `upstream_changed:${id}` });
          delete state.approvals[gate];
        }
      }
    }
  }
  if (invalidated.length) state.events.push({ at: nowIso, event: "stages_invalidated", stages: invalidated });
  return invalidated;
}

export function recordAnswers(state, { answers, at }) {
  if (!Array.isArray(answers) || !answers.length) throw new Error("answers must be a non-empty array of {id, answer}");
  state.answers = answers;
  const digest = sha256(stableStringify(answers));
  const stage = state.stages.prd_answers;
  stage.status = "done";
  stage.actor = "human_input";
  stage.satisfiedBy = digest;
  stage.fingerprint = stageFingerprint(state, "prd_answers");
  state.events.push({ at, event: "answers_recorded", count: answers.length, sha256: digest });
  return state;
}

export function recordClientPreferences(state, { preferences, at }) {
  if (!preferences || typeof preferences !== "object") throw new Error("clientPreferences must be an object of {questionId: optionId|text}");
  if (!Object.keys(preferences).length) throw new Error("clientPreferences must not be empty");
  state.clientPreferences = preferences;
  const digest = sha256(stableStringify(preferences));
  const stage = state.stages.concept_answers;
  stage.status = "done";
  stage.actor = "human_input";
  stage.satisfiedBy = digest;
  stage.fingerprint = stageFingerprint(state, "concept_answers");
  state.events.push({ at, event: "client_preferences_recorded", keys: Object.keys(preferences), sha256: digest });
  return state;
}

export function recordApproval(state, gate, { by, at, revision, note, actor = "human_approved", evidence }) {
  if (!HUMAN_GATES.has(gate)) throw new Error(`not a human gate: ${gate}`);
  if (actor !== "human_approved") throw new Error("approvals must be human_approved; AI confirmations are stage outputs, never approvals");
  state.approvals[gate] = { by, at, revision, note: note ?? null, actor, evidence: evidence ?? null };
  state.stages[gate].status = "done";
  state.stages[gate].actor = actor;
  state.stages[gate].satisfiedBy = revision;
  state.stages[gate].fingerprint = stageFingerprint(state, gate);
  state.events.push({ at, event: "approval_recorded", gate, by, revision });
  return state;
}

// A concept approval that no longer reflects what the client is looking at
// must not survive as an approval; it is kept in history with why it went.
export function invalidateConceptApproval(state, at, reason) {
  const approval = state.approvals.concept_approval;
  if (!approval) return false;
  state.approvalsHistory.push({ ...approval, gate: "concept_approval", invalidatedAt: at, reason });
  delete state.approvals.concept_approval;
  const stage = state.stages.concept_approval;
  stage.status = "pending";
  stage.satisfiedBy = null;
  stage.fingerprint = null;
  state.stages.concepts.approvedConceptId = null;
  state.events.push({ at, event: "approval_invalidated", gate: "concept_approval", reason });
  return true;
}

// The client's "이건 아니다, 다시" at the 시안 리뷰. It is an instruction, never
// an approval: recorded with actor "client_instruction", it drops any standing
// concept approval and bumps the round the lane will run with, so the previous
// output cannot be reused. Structural feedback additionally reopens the
// wireframe stage (docs/lane-workflows.md D4) — the concept lane holds the
// structure fixed and therefore cannot answer a structural complaint.
export function recordConceptReviewRound(state, { decision, scope = null, feedback = null, request = null, by, at }) {
  if (!["revise", "recolor"].includes(decision)) throw new Error(`not a revision decision: ${decision}`);
  if (!by) throw new Error("a review round must record who asked for it");
  if (decision === "revise") {
    if (!["style", "structure"].includes(scope)) throw new Error("revise requires scope style|structure");
    if (!feedback) throw new Error("revise requires the client's feedback text");
  }
  if (decision === "recolor" && !request) throw new Error("recolor requires the client's request text");
  const concepts = state.stages.concepts;
  if (decision === "recolor" && !concepts.output?.path) throw new Error("recolor needs a previous concepts round to recolor");
  const review = state.conceptReview ?? (state.conceptReview = { rounds: [], blocked: null });
  if (review.blocked) throw new Error(`concept review is blocked: ${review.blocked.reason}`);

  const round = (concepts.round ?? 1) + 1;
  const entry = { round, decision, scope, by, at, actor: "client_instruction", feedback, request };
  if (round > MAX_CONCEPT_ROUNDS) {
    review.blocked = {
      reason: `시안 리뷰 라운드 상한(${MAX_CONCEPT_ROUNDS}회)을 모두 소진했습니다. 사람이 범위를 다시 정하기 전에는 추가 라운드를 자동 진행하지 않습니다.`,
      at,
      requested: entry,
    };
    state.events.push({ at, event: "concept_review_blocked", round, decision, by });
    return { blocked: true, round: concepts.round ?? 1, reason: review.blocked.reason };
  }

  invalidateConceptApproval(state, at, `concept_review_${decision}:${scope ?? "recolor"}`);
  review.rounds.push(entry);
  concepts.round = round;
  if (decision === "recolor") {
    // The lane copies the previous round's files, so the source round dir is
    // pinned here instead of being guessed later.
    concepts.recolor = { fromRunDir: dirname(concepts.output.path), request };
    concepts.feedback = null;
  } else {
    concepts.recolor = null;
    concepts.feedback = feedback;
  }
  if (scope === "structure") {
    const wireframe = state.stages.wireframe;
    wireframe.round = (wireframe.round ?? 1) + 1;
    wireframe.feedback = feedback;
  }
  state.events.push({ at, event: "concept_review_round", round, decision, scope, by });
  refreshStaleness(state, at);
  return { blocked: false, round };
}
