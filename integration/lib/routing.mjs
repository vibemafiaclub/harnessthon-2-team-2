import { STAGES, STAGE_ORDER, touchpointOf } from "./runstate.mjs";

// Route planning: maps recognized materials + evidence-based reuse checks to
// per-stage decisions (run | reuse | repair | blocked) with rationale,
// evidence, and unmet checks. Pure function — all filesystem checks happen
// before this and arrive via `reuse` results.
//
// Direction (2026-09-05, local-archive/feedback-autonomous-design.md):
// research and wireframe stages have NO human gate; concept approval is the
// human decision boundary. ai_confirmed is never translated to human_approved.

function assessedByType(assessment) {
  const map = new Map();
  for (const item of assessment?.materials || []) {
    if (!map.has(item.type)) map.set(item.type, []);
    map.get(item.type).push(item);
  }
  return map;
}

export function buildRoutePlan(context) {
  const { state, assessment, registry, reuse = {}, approvedPrd = null, nowIso } = context;
  const byType = assessedByType(assessment);
  const has = (type) => (byType.get(type) || []).some((m) => m.verified);
  const verifiedOf = (type) => (byType.get(type) || []).filter((m) => m.verified);

  const stages = [];
  const add = (id, entry) => {
    const def = STAGES.find((s) => s.id === id);
    stages.push({
      id,
      dependsOn: def.dependsOn,
      humanGate: def.humanGate,
      touchpoint: touchpointOf(id)?.id ?? null,
      workflow: def.workflow,
      decision: "run",
      rationale: "",
      evidence: [],
      unmetChecks: [],
      selectedArtifacts: [],
      ...entry,
    });
  };

  add("intake", {
    decision: "run",
    rationale: assessment ? "Materials acquired and assessed." : "Awaiting intake assessment workflow.",
    evidence: assessment ? [{ check: "assessment_recorded", detail: `${assessment.materials.length} materials assessed` }] : [],
  });

  // --- PRD stages ---
  const suppliedApproved = approvedPrd && approvedPrd.source === "user_supplied" ? approvedPrd : null;
  if (suppliedApproved) {
    const prdEvidence = [
      { check: "schema", detail: "user-supplied document validates as approved-prd/v1" },
      { check: "declared_role", detail: `material ${suppliedApproved.materialId} declared as approved-prd` },
      { check: "approval_field", detail: `approvedBy ${suppliedApproved.json.approval.approvedBy} at ${suppliedApproved.json.approval.approvedAt}` },
    ];
    add("prd_interview", { decision: "reuse", rationale: "User supplied an already-approved normalized PRD; interview replaced by that document.", evidence: prdEvidence, selectedArtifacts: [suppliedApproved.materialId] });
    add("prd_answers", { decision: "reuse", rationale: "No open interview questions — approved PRD supplied.", evidence: prdEvidence });
    add("prd_revise", { decision: "reuse", rationale: "Revision unnecessary — approved PRD supplied.", evidence: prdEvidence });
    add("prd_approval", { decision: "reuse", rationale: "Approval carried by the supplied document and the user's explicit declaration.", evidence: prdEvidence, selectedArtifacts: [suppliedApproved.materialId] });
  } else {
    add("prd_interview", { rationale: "PRD text requires the interview workflow (journey walk + persona interview + open questions)." });
    add("prd_answers", { rationale: "Human boundary: answer the interview's open questions." });
    add("prd_revise", { rationale: "Revise the PRD with the recorded answers (PRD-v2)." });
    add("prd_approval", { rationale: "Human boundary: approve the normalized PRD (approved-prd/v1 JSON)." });
  }

  // --- Research ---
  const researchCandidate = reuse.research;
  if (researchCandidate?.ok) {
    add("research", {
      decision: "reuse",
      rationale: "Existing research package passed seal, provenance, PRD identity, freshness, and coverage checks.",
      evidence: researchCandidate.evidence,
      selectedArtifacts: [researchCandidate.candidate],
    });
  } else {
    const evidence = [];
    const unmet = researchCandidate ? researchCandidate.failures.map((f) => `research_reuse:${f}`) : [];
    if (has("html_template") || has("concept_output") || has("design_system")) {
      evidence.push({ check: "template_not_research", detail: "A supplied template/design system does not prove competitor research was done; research still runs." });
    }
    if (has("screenshot") || has("mockup")) {
      evidence.push({ check: "visual_reference", detail: "Screenshots/mockups are visual references passed to research as inspiration, not research results." });
    }
    add("research", {
      rationale: researchCandidate
        ? "A research package candidate exists but failed reuse checks; regenerating."
        : "No valid prior research package; run the competitor-reference workflow (autonomous, no human gate).",
      evidence,
      unmetChecks: unmet,
    });
  }

  // --- Wireframe (autonomous, representative auto-selected, ai_confirmed) ---
  const wfAdapter = registry["wireframe-lane"];
  const wireframeCandidate = reuse.wireframe;
  if (wireframeCandidate?.ok) {
    add("wireframe", {
      decision: "reuse",
      rationale: "Existing wireframe lane output passed integrity, quality-check, and freshness checks.",
      evidence: wireframeCandidate.evidence,
      selectedArtifacts: [wireframeCandidate.candidate],
    });
  } else if (wfAdapter.status !== "available") {
    add("wireframe", {
      decision: "blocked",
      rationale: "Wireframe lane workflow is not registered/available in this worktree (downstream source not merged).",
      unmetChecks: [`adapter:${wfAdapter.status}`],
      evidence: wireframeCandidate ? wireframeCandidate.failures.map((f) => ({ check: "reuse_failed", detail: f })) : [],
    });
  } else {
    const evidence = [{ check: "no_human_gate", detail: "Wireframes are AI-evaluated and the representative is auto-selected (ai_confirmed); no designer gate." }];
    if (has("brand_tokens")) evidence.push({ check: "brand_carried", detail: "Brand palette/fonts are carried as constraints; structure and wireframes are still generated." });
    add("wireframe", {
      rationale: "Run the wireframe lane; AI checks + auto-repair, representative selected from the lane's recorded recommendation.",
      evidence,
      unmetChecks: wireframeCandidate ? wireframeCandidate.failures.map((f) => `wireframe_reuse:${f}`) : [],
    });
  }

  // --- Concepts ---
  const vcAdapter = registry["visual-concept-lane"];
  const adopted = (assessment?.materials || []).find((m) => m.adoptionIntent?.declared && m.verified);
  const adoptedCoverage = adopted?.adoptionIntent?.coverage ?? "unknown";
  // The lane will not generate before the client answers its aesthetic
  // questionnaire, so elicitation + answers precede generation — unless no
  // concept is generated at all (a fully adopted template).
  const bypassIdeation = Boolean(adopted && adoptedCoverage === "adequate");
  if (bypassIdeation) {
    const why = "No concept is generated (template fully adopted), so the aesthetic questionnaire has nothing to steer.";
    add("concept_elicit", { decision: "reuse", rationale: why, evidence: [{ check: "adoption_intent", detail: `"${adopted.adoptionIntent.quote}"` }], selectedArtifacts: [adopted.materialId] });
    add("concept_answers", { decision: "reuse", rationale: why, evidence: [{ check: "adoption_intent", detail: `"${adopted.adoptionIntent.quote}"` }] });
  } else if (registry["visual-concept-elicit"].status !== "available") {
    add("concept_elicit", { decision: "blocked", rationale: "Visual-concept lane workflow unavailable, so the client questionnaire cannot be produced.", unmetChecks: [`adapter:${registry["visual-concept-elicit"].status}`] });
    add("concept_answers", { decision: "blocked", rationale: "No questionnaire to answer.", unmetChecks: [`adapter:${registry["visual-concept-elicit"].status}`] });
  } else {
    add("concept_elicit", {
      rationale: "Run the visual-concept lane in elicitation mode: it returns the client aesthetic questionnaire (colour first) and stops before generation.",
      evidence: [{ check: "mandatory_elicitation", detail: "The lane refuses to generate any concept without clientPreferences." }],
    });
    add("concept_answers", {
      rationale: "Human boundary: the client answers the aesthetic questionnaire. These answers drive tone and manner for all three concepts.",
    });
  }
  const conceptsBase = {};
  if (has("design_system")) {
    conceptsBase.evidence = [{ check: "design_system_reuse", detail: `Verified design-system material reused for tokens/components (${verifiedOf("design_system").map((m) => m.materialId).join(", ")}); required screens/flows still evaluated separately.` }];
    conceptsBase.selectedArtifacts = verifiedOf("design_system").map((m) => m.materialId);
  }
  if (adopted && adoptedCoverage === "adequate") {
    add("concepts", {
      ...conceptsBase,
      decision: "reuse",
      rationale: "User explicitly adopted a concept/template with adequate visual coverage; concept ideation bypassed.",
      evidence: [
        ...(conceptsBase.evidence || []),
        { check: "adoption_intent", detail: `User declaration: "${adopted.adoptionIntent.quote}"` },
        { check: "coverage", detail: adopted.adoptionIntent.coverageNote ?? "assessed adequate for required screens/flows" },
      ],
      selectedArtifacts: [...(conceptsBase.selectedArtifacts || []), adopted.materialId],
    });
  } else if (adopted && adoptedCoverage !== "adequate") {
    add("concepts", {
      ...conceptsBase,
      decision: vcAdapter.status === "available" ? "repair" : "blocked",
      rationale: "Adopted/partial template covers only part of the product; reuse compatible portions and generate the gaps (one landing page does not cover all flows).",
      evidence: [...(conceptsBase.evidence || []), { check: "partial_coverage", detail: adopted.adoptionIntent.coverageNote ?? `coverage=${adoptedCoverage}` }],
      unmetChecks: vcAdapter.status === "available" ? [`template_coverage:${adoptedCoverage}`] : [`adapter:${vcAdapter.status}`],
      selectedArtifacts: [...(conceptsBase.selectedArtifacts || []), adopted.materialId],
    });
  } else if (vcAdapter.status !== "available") {
    add("concepts", {
      ...conceptsBase,
      decision: "blocked",
      rationale: "Visual-concept lane workflow is not registered/available in this worktree (downstream source not merged).",
      unmetChecks: [`adapter:${vcAdapter.status}`],
    });
  } else {
    add("concepts", {
      ...conceptsBase,
      rationale: "Generate three client-facing concepts (1-2 representative pages each) on the auto-selected wireframe structure.",
    });
  }

  // --- Concept approval (THE human boundary) ---
  const conceptStage = stages.find((s) => s.id === "concepts");
  if (adopted && adopted.approvedRevisionMatch) {
    add("concept_approval", {
      decision: "reuse",
      rationale: "User's declaration explicitly approved this exact template revision; concept review satisfied by that evidence.",
      evidence: [
        { check: "explicit_revision_approval", detail: `declared approvedRevision matches material sha256 ${adopted.approvedRevisionMatch.slice(0, 12)}…` },
        { check: "adoption_intent", detail: `"${adopted.adoptionIntent.quote}"` },
      ],
      selectedArtifacts: [adopted.materialId],
    });
  } else {
    add("concept_approval", {
      rationale: conceptStage.decision === "reuse"
        ? "Human boundary preserved: adoption bypassed ideation, but the concept must still be approved (mere attachment is not approval)."
        : "Human boundary: the client picks/approves one of the three concepts.",
    });
  }

  // --- Production (post-approval outputs) ---
  const prodAdapter = registry["post-approval-prototype"] ?? registry["production-outputs"];
  add("production", prodAdapter.status === "available"
    ? { rationale: "Produce full frontend pages, component documentation, IA, user flow, and browser prototype from the approved concept." }
    : { decision: "blocked", rationale: "Post-approval production workflow not yet implemented/registered (downstream work not merged).", unmetChecks: [`adapter:${prodAdapter.status}`] });

  // --- Focused intake questions (only adoption/conflict ambiguity) ---
  const pendingQuestions = [];
  for (const q of assessment?.intakeQuestions || []) {
    if (q.blocking && !(state.intakeAnswers || {})[q.id]) pendingQuestions.push(q);
  }
  for (const conflict of assessment?.conflicts || []) {
    const id = `conflict:${conflict.kind}:${(conflict.materialIds || []).join("+")}`;
    if (!(state.intakeAnswers || {})[id]) {
      pendingQuestions.push({ id, question: `Conflicting source claims: ${conflict.detail}. Which should apply?`, why: "Contradictory requirements must be resolved by the user, never silently.", options: [], blocking: true });
    }
  }

  return { builtAt: nowIso, stages, pendingQuestions, stageOrder: STAGE_ORDER };
}
