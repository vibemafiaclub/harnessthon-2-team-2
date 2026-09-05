import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256, stableStringify } from "../../research/lib/canonical.mjs";

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
  { id: "production", dependsOn: ["concept_approval"], humanGate: false, workflow: "production-outputs" },
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
  for (const id of STAGE_ORDER) {
    const stage = state.stages[id];
    if (stage.status !== "done") continue;
    const current = stageFingerprint(state, id);
    if (stage.fingerprint && stage.fingerprint !== current) {
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
