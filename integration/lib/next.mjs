import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join, dirname, relative } from "node:path";
import { sha256, stableStringify } from "../../research/lib/canonical.mjs";
import { STAGE_ORDER, stageDef, stageFingerprint, recordStageOutput, recordApproval, refreshStaleness, saveRun, touchpointOf, readyGatesInTouchpoint } from "./runstate.mjs";
import { buildInvocation } from "./registry.mjs";
import { approvedPrdToLaneInput, briefToLaneInput } from "./laneprd.mjs";

// Drives execution off the route plan. Applies evidence-checked reuse
// decisions automatically (recorded as reuse of a checked artifact, never as
// generation), then returns the first concrete action:
//   invoke_workflow — the host Claude session runs the Workflow tool with
//                     these exact inputs and records the result
//   run_command     — a deterministic host command (e.g. research assembly)
//   user_decision   — a genuine human-input boundary
//   blocked / done
export async function advance({ repoRoot, runDir, context }) {
  const { state, plan, registry, approvedPrd, reuse } = context;
  const nowIso = context.nowIso;
  refreshStaleness(state, nowIso);

  const intakeAction = () => {
    const invocation = buildInvocation(registry, "intake-assess", {
      request: { prd: state.request.prd, materials: state.request.materials },
      materials: context.materials.map((m) => ({ id: m.id, source: m.source, declaredRole: m.declaredRole, description: m.description, parseStatus: m.parseStatus, contentSniff: m.contentSniff ?? null, bytes: m.bytes, sha256: m.sha256 })),
      nowIso,
    });
    return { type: "invoke_workflow", stage: "intake", ...invocation, saveResultTo: join(runDir, "assessment.json"), then: `integrate record ${runDir} intake --result ${join(runDir, "assessment.json")}` };
  };

  if (!context.assessment || state.stages.intake.status !== "done") {
    await saveRun(runDir, state);
    return intakeAction();
  }
  if (!plan) throw new Error("no route plan available; record the intake assessment first");

  if (plan.pendingQuestions.length) {
    await saveRun(runDir, state);
    return {
      type: "user_decision",
      stage: "intake",
      kind: "intake_questions",
      payload: plan.pendingQuestions,
      how: `Ask the user each question, then: integrate answer ${runDir} --question <id> --text "<answer>" (repeat per question).`,
    };
  }

  for (const stageId of STAGE_ORDER) {
    const stage = state.stages[stageId];
    if (stage.status === "done") continue;
    const planStage = plan.stages.find((s) => s.id === stageId);

    if (planStage.decision === "blocked") {
      stage.status = "blocked";
      await saveRun(runDir, state);
      return { type: "blocked", stage: stageId, reason: planStage.rationale, unmetChecks: planStage.unmetChecks };
    }

    if (planStage.decision === "reuse") {
      await applyReuse({ state, stageId, planStage, approvedPrd, reuse, runDir, nowIso });
      continue;
    }

    if (stageDef(stageId).humanGate) {
      // Only two moments interrupt the human. Ask everything that is ready in
      // this touchpoint at once rather than coming back per gate.
      const touchpoint = touchpointOf(stageId);
      const ready = readyGatesInTouchpoint(state, touchpoint.id).filter((gateId) => {
        const gatePlan = plan.stages.find((s) => s.id === gateId);
        return !gatePlan || gatePlan.decision !== "reuse";
      });
      for (const gateId of ready) state.stages[gateId].status = "awaiting_user";
      await saveRun(runDir, state);
      const asks = [];
      for (const gateId of ready) asks.push(await humanDecision({ stageId: gateId, state, runDir }));
      return {
        type: "user_decision",
        touchpoint: touchpoint.id,
        touchpointTitle: touchpoint.title,
        stage: stageId,
        kind: asks.length === 1 ? asks[0].kind : "bundle",
        asks,
        remainingInTouchpoint: touchpoint.gates.filter((g) => state.stages[g].status !== "done" && !ready.includes(g)),
        how: asks.map((a) => a.how).join("\n"),
      };
    }

    const action = await workflowAction({ repoRoot, runDir, stageId, state, registry, approvedPrd, nowIso });
    await saveRun(runDir, state);
    return action;
  }
  await saveRun(runDir, state);
  return { type: "done", message: "All stages complete (or satisfied by checked reuse)." };
}

async function applyReuse({ state, stageId, planStage, approvedPrd, reuse, runDir, nowIso }) {
  const base = { actor: "reuse_checked", decision: "reuse", nowIso };
  if (["prd_interview", "prd_answers", "prd_revise"].includes(stageId)) {
    recordStageOutput(state, stageId, { ...base, path: approvedPrd.path, sha256: approvedPrd.sha256, summary: planStage.rationale });
  } else if (stageId === "prd_approval") {
    recordApproval(state, "prd_approval", {
      by: approvedPrd.json.approval.approvedBy,
      at: approvedPrd.json.approval.approvedAt,
      revision: approvedPrd.sha256,
      evidence: `user_supplied_approved_prd material=${approvedPrd.materialId}`,
    });
  } else if (stageId === "research") {
    recordStageOutput(state, stageId, { ...base, path: reuse.research.candidate, sha256: reuse.research.packageHash, summary: planStage.rationale });
    state.stages.research.researchRunDir = dirname(reuse.research.candidate);
    state.stages.research.reuseEvidence = reuse.research.evidence;
  } else if (stageId === "wireframe") {
    const laneOutput = reuse.wireframe.laneOutput;
    recordStageOutput(state, stageId, { ...base, path: reuse.wireframe.candidate, sha256: sha256(stableStringify(laneOutput)), summary: planStage.rationale });
    if (laneOutput.aiRecommendation?.recommendedVariantId) {
      const dir = dirname(reuse.wireframe.candidate);
      const path = join(dir, `wireframe-${laneOutput.aiRecommendation.recommendedVariantId}.html`);
      state.stages.wireframe.representative = {
        variantId: laneOutput.aiRecommendation.recommendedVariantId,
        path,
        sha256: sha256(await readFile(path)),
        actor: "ai_confirmed",
        reason: laneOutput.aiRecommendation.reason ?? null,
      };
    }
    state.stages.wireframe.reuseEvidence = reuse.wireframe.evidence;
  } else if (stageId === "concept_elicit" || stageId === "concept_answers") {
    recordStageOutput(state, stageId, { ...base, path: null, sha256: null, summary: planStage.rationale });
  } else if (stageId === "concepts") {
    recordStageOutput(state, stageId, { ...base, path: null, sha256: null, summary: planStage.rationale });
    state.stages.concepts.selectedArtifacts = planStage.selectedArtifacts;
    state.stages.concepts.adoptedMaterial = planStage.selectedArtifacts.at(-1) ?? null;
  } else if (stageId === "concept_approval") {
    const adoptedId = planStage.selectedArtifacts[0];
    recordApproval(state, "concept_approval", {
      by: "user-declaration",
      at: nowIso,
      revision: planStage.evidence.find((e) => e.check === "explicit_revision_approval") ? state.request.materials.find((m, i) => (m.id || `mat-${String(i + 1).padStart(2, "0")}`) === adoptedId)?.approvedRevision : null,
      evidence: JSON.stringify(planStage.evidence),
    });
  } else {
    recordStageOutput(state, stageId, { ...base, summary: planStage.rationale });
  }
  await saveRun(runDir, state);
}

async function humanDecision({ stageId, state, runDir }) {
  if (stageId === "prd_answers") {
    return {
      type: "user_decision",
      stage: stageId,
      kind: "interview_answers",
      payload: state.questions ?? [],
      how: `Collect the user's answers, write [{"id","answer"}] JSON, then: integrate answer ${runDir} --file <answers.json>`,
    };
  }
  if (stageId === "prd_approval") {
    return {
      type: "user_decision",
      stage: stageId,
      kind: "prd_approval",
      payload: { prdV2: state.stages.prd_revise?.output?.path ?? null },
      how: `Show PRD-v2 to the user; on approval produce an approved-prd/v1 JSON and run: integrate approve ${runDir} prd_approval --by "<name>" --prd-file <approved-prd.json>`,
    };
  }
  if (stageId === "concept_answers") {
    return {
      type: "user_decision",
      stage: stageId,
      kind: "client_preferences",
      payload: state.questionnaire ?? [],
      how: `Ask the client each question (colour first) with AskUserQuestion, then: integrate answer ${runDir} --preferences '{"<questionId>":"<optionId>"}'`,
      note: "The visual-concept lane refuses to generate any concept before these answers exist; tone and manner come from them, not from the design systems.",
    };
  }
  if (stageId === "concept_approval") {
    let concepts = [];
    const round = state.stages.concepts.round ?? 1;
    const laneOutputPath = conceptLaneOutputPath(runDir, state);
    const laneDir = dirname(laneOutputPath);
    if (existsSync(laneOutputPath)) {
      const laneOutput = JSON.parse(await readFile(laneOutputPath, "utf8"));
      concepts = (laneOutput.artifacts || []).map((a) => ({ conceptId: a.conceptId ?? a.id, path: join(laneDir, a.path), revisionHash: a.revisionHash }));
    }
    return {
      type: "user_decision",
      stage: stageId,
      kind: "concept_approval",
      payload: { concepts, round, rounds: state.conceptReview?.rounds ?? [] },
      how: `Show the concepts to the client, then record their decision:\n`
        + `  integrate review ${runDir} concept_review --decision approve --by "<name>" --concept <id>\n`
        + `  integrate review ${runDir} concept_review --decision revise --by "<name>" --scope style|structure --feedback "<text>"\n`
        + `  integrate review ${runDir} concept_review --decision recolor --by "<name>" --request "<text>"`,
      note: "Only approve is an approval. A revise or a recolor is a client instruction: it opens another round of this same touchpoint and drops any standing approval.",
    };
  }
  throw new Error(`no human decision handler for ${stageId}`);
}

// Round 1 keeps the historical directory name so existing runs stay readable;
// later rounds get their own directory, because a revise round must not
// overwrite the artifacts an earlier approval or review was bound to.
export function roundDir(runDir, stage, round) {
  return join(runDir, round > 1 ? `${stage}-r${round}` : stage);
}

export function conceptsDir(runDir, round) {
  return roundDir(runDir, "concepts", round);
}

// The approval binds to the lane output actually recorded for this run, which
// after a revise round is no longer the round-1 directory.
export function conceptLaneOutputPath(runDir, state) {
  const recorded = state.stages?.concepts?.output?.path;
  if (recorded && basename(recorded) === "lane-output.json") return recorded;
  return join(conceptsDir(runDir, state.stages?.concepts?.round ?? 1), "lane-output.json");
}

function asWorkflowAction(stageId, invocation, extras) {
  if (!invocation.ok) {
    return { type: "blocked", stage: stageId, reason: `workflow ${invocation.workflow} unavailable (${invocation.status})`, unmetChecks: [`adapter:${invocation.status}`, ...(invocation.missing ? invocation.missing.map((m) => `missing_arg:${m}`) : [])] };
  }
  return { type: "invoke_workflow", stage: stageId, ...invocation, ...extras };
}

async function workflowAction({ repoRoot, runDir, stageId, state, registry, approvedPrd, nowIso }) {
  const runId = state.runId;
  if (stageId === "prd_interview") {
    const outDir = join(runDir, "prd");
    await mkdir(outDir, { recursive: true });
    const invocation = buildInvocation(registry, "prd-interview", {
      prdPath: state.request.prd.path,
      outDir,
      promptsDir: join(repoRoot, ".claude/workflows/prd-interview/prompts"),
      maxTurns: 1,
      skipInterviewer: true,
    });
    return asWorkflowAction(stageId, invocation, { saveResultTo: join(runDir, "prd-interview-result.json"), then: `integrate record ${runDir} prd_interview --result ${join(runDir, "prd-interview-result.json")}` });
  }
  if (stageId === "prd_revise") {
    const invocation = buildInvocation(registry, "prd-interview-revise", {
      stage: "revise",
      prdPath: state.request.prd.path,
      outDir: join(runDir, "prd"),
      promptsDir: join(repoRoot, ".claude/workflows/prd-interview/prompts"),
      answers: state.answers,
    });
    return asWorkflowAction(stageId, invocation, { saveResultTo: join(runDir, "prd-revise-result.json"), then: `integrate record ${runDir} prd_revise --result ${join(runDir, "prd-revise-result.json")}` });
  }
  if (stageId === "research") {
    const draftPath = join(runDir, "research-draft.json");
    if (!state.stages.research.draft) {
      const invocation = buildInvocation(registry, "competitor-reference", { prd: approvedPrd.json, nowIso });
      return asWorkflowAction(stageId, invocation, { saveResultTo: draftPath, then: `integrate record ${runDir} research --draft ${draftPath}` });
    }
    const researchRunsDir = join(runDir, "research-runs");
    const researchRunId = `${runId}-research`;
    return {
      type: "run_command",
      stage: stageId,
      argv: ["node", join(repoRoot, "research/bin/assemble-run.mjs"), "--prd", approvedPrd.path, "--draft", state.stages.research.draft.path, "--run-id", researchRunId, "--runs-dir", researchRunsDir],
      then: `integrate record ${runDir} research --research-run-dir ${join(researchRunsDir, researchRunId)}`,
      note: "Assembles + live-verifies the research draft; the run becomes consumable only as verified_autonomous.",
    };
  }
  if (stageId === "wireframe") {
    const lanePrdPath = await ensureLanePrd({ runDir, state, approvedPrd });
    const round = state.stages.wireframe.round ?? 1;
    const wfDir = roundDir(runDir, "wireframe", round);
    await mkdir(wfDir, { recursive: true });
    const invocation = buildInvocation(registry, "wireframe-lane", {
      prdPath: lanePrdPath,
      runDir: wfDir,
      runId: `${runId}-wf-r${round}`,
      round,
      startedAt: nowIso,
      ...(state.stages.wireframe.feedback ? { feedback: state.stages.wireframe.feedback } : {}),
    });
    return asWorkflowAction(stageId, invocation, { saveResultTo: join(runDir, "wireframe-result.json"), then: `integrate record ${runDir} wireframe --result ${join(runDir, "wireframe-result.json")}`, note: "Autonomous: representative variant is auto-selected from the lane's AI recommendation (ai_confirmed), no designer gate." });
  }
  if (stageId === "concept_elicit") {
    const lanePrdPath = await ensureDraftLanePrd({ runDir, state, approvedPrd });
    const vcDir = join(runDir, "concepts");
    await mkdir(vcDir, { recursive: true });
    const invocation = buildInvocation(registry, "visual-concept-elicit", {
      prdPath: lanePrdPath,
      runDir: vcDir,
      runId: `${runId}-vc-elicit`,
      round: state.stages.concept_elicit.round ?? 1,
      startedAt: nowIso,
    });
    return asWorkflowAction(stageId, invocation, {
      saveResultTo: join(runDir, "concept-questionnaire.json"),
      then: `integrate record ${runDir} concept_elicit --result ${join(runDir, "concept-questionnaire.json")}`,
      note: "Elicitation pass: the lane returns mode:\"elicitation\" with a questionnaire and stops before generating anything.",
    });
  }
  if (stageId === "concepts") {
    const round = state.stages.concepts.round ?? 1;
    const vcDir = conceptsDir(runDir, round);
    const recolor = state.stages.concepts.recolor ?? null;
    const lanePrdPath = await ensureLanePrd({ runDir, state, approvedPrd });
    await mkdir(vcDir, { recursive: true });
    const resultPath = join(runDir, `concepts-result-r${round}.json`);
    const then = `integrate record ${runDir} concepts --result ${resultPath}`;
    if (recolor) {
      // Hue-only main-colour change over the previous round's files; the lane
      // copies them instead of regenerating, so no wireframe/preferences args.
      const invocation = buildInvocation(registry, "visual-concept-recolor", {
        prdPath: lanePrdPath,
        runDir: vcDir,
        runId: `${runId}-vc-r${round}-recolor`,
        round,
        startedAt: nowIso,
        recolor: { fromRunDir: recolor.fromRunDir, request: recolor.request },
      });
      return asWorkflowAction(stageId, invocation, { saveResultTo: resultPath, then, note: "Recolor pass (컬러 변경 원칙): only --primary-h changes; saturation, lightness, neutrals and imagery stay as they are." });
    }
    const representative = state.stages.wireframe.representative;
    if (!representative?.path) {
      return { type: "blocked", stage: stageId, reason: "No representative wireframe recorded (wireframe stage must record an AI-confirmed representative first).", unmetChecks: ["representative_missing"] };
    }
    const invocation = buildInvocation(registry, "visual-concept-lane", {
      prdPath: lanePrdPath,
      runDir: vcDir,
      runId: `${runId}-vc-r${round}`,
      round,
      startedAt: nowIso,
      representativeWireframePath: representative.path,
      representativeVariant: { id: representative.variantId, selectedBy: representative.actor, reason: representative.reason },
      clientPreferences: state.clientPreferences,
      ...(state.stages.concepts.feedback ? { feedback: state.stages.concepts.feedback } : {}),
    });
    return asWorkflowAction(stageId, invocation, { saveResultTo: resultPath, then });
  }
  if (stageId === "production") {
    const conceptApproval = state.approvals.concept_approval;
    const representative = state.stages.wireframe.representative;
    const conceptId = state.stages.concepts.approvedConceptId ?? conceptApproval?.note;
    const wireframeManifestPath = state.stages.wireframe.output?.path;
    const conceptManifestPath = state.stages.concepts.output?.path;
    if (!approvedPrd?.path || !conceptApproval || !conceptId || !representative?.variantId || !wireframeManifestPath || !conceptManifestPath) {
      return { type: "blocked", stage: stageId, reason: "Production requires an approved PRD, an AI-confirmed selected wireframe, and a human-approved concept artifact.", unmetChecks: ["production_inputs_missing"] };
    }
    const productionDir = join(runDir, "production");
    const metadataPath = join(productionDir, "product-input-metadata.json");
    const inputPath = join(productionDir, "product-input.json");
    const preparationFingerprint = stageFingerprint(state, "production");
    if (!existsSync(inputPath) || state.stages.production.preparedFingerprint !== preparationFingerprint) {
      await mkdir(productionDir, { recursive: true });
      const metadata = {
        sourceRoot: runDir,
        outputDir: productionDir,
        approvedPrdPath: approvedPrd.path,
        wireframeManifestPath,
        wireframeId: representative.variantId,
        conceptManifestPath,
        conceptId,
        coordinatorStatePath: join(runDir, "state.json"),
        approval: {
          kind: "coordinator-approval",
          coordinator: {
            conceptApproval: { by: conceptApproval.by, at: conceptApproval.at, revision: conceptApproval.revision, conceptId },
            wireframeRepresentative: { variantId: representative.variantId, revisionHash: representative.sha256 ?? null }
          }
        },
        compatibility: representative.compatibility ?? {
          mode: "normalize-pinned-structure",
          representativeScreenId: "pending-normalization",
          sectionOrder: [],
          basis: "The coordinator pins the selected wireframe HTML and manifest, but this lane output has no structured block inventory. The native normalization workflow must extract its representative screen and ordered blocks from those pinned bytes."
        }
      };
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      state.stages.production.preparedFingerprint = preparationFingerprint;
      return {
        type: "run_command",
        stage: stageId,
        argv: ["node", join(repoRoot, "product/integration.mjs"), "--metadata", metadataPath],
        then: `integrate next ${runDir}`,
        note: "Builds a revision-pinned product input from the approved PRD, selected wireframe and selected human-approved concept. It never creates upstream review receipts."
      };
    }
    const invocation = buildInvocation(registry, "post-approval-prototype", { inputPath, outDir: join(productionDir, "package") });
    return asWorkflowAction(stageId, invocation, { saveResultTo: join(runDir, "production-result.json"), then: `integrate record ${runDir} production --result ${join(runDir, "production-result.json")}`, note: "Native Workflow produces only the portable HTML prototype and all-screen/state inspection board; it does not invoke Figma." });
  }
  throw new Error(`no workflow action for ${stageId}`);
}

// The questionnaire only needs domain + brand context, so it runs off the
// approved PRD when there is one and off the intake brief when there is not.
async function ensureDraftLanePrd({ runDir, state, approvedPrd }) {
  if (approvedPrd) return ensureLanePrd({ runDir, state, approvedPrd });
  const assessment = JSON.parse(await readFile(join(runDir, "assessment.json"), "utf8"));
  const lanePrd = briefToLaneInput(assessment.normalizedBrief, { id: `${state.runId}-draft` });
  const path = join(runDir, "lane-prd.draft.json");
  await writeFile(path, `${JSON.stringify(lanePrd, null, 2)}\n`);
  return path;
}

async function ensureLanePrd({ runDir, state, approvedPrd }) {
  const path = join(runDir, "lane-prd.json");
  const research = state.stages.research;
  const researchHandoff = research?.output?.sha256
    ? { path: relative(runDir, research.output.path ?? "") || research.output.path, approvedRevision: research.output.sha256 }
    : null;
  const lanePrd = approvedPrdToLaneInput(approvedPrd.json, { researchHandoff });
  await writeFile(path, `${JSON.stringify(lanePrd, null, 2)}\n`);
  return path;
}
