#!/usr/bin/env node
// Orchestration entry point for the PRD + materials → design pipeline
// integration. The main Claude session (or a human) drives it:
//
//   node integration/bin/integrate.mjs init --request <request.json> [--run-id <id>]
//   node integration/bin/integrate.mjs next <runDir> [--json]
//   node integration/bin/integrate.mjs record <runDir> <stageId> --result <file>
//   node integration/bin/integrate.mjs record <runDir> research --draft <file>
//   node integration/bin/integrate.mjs record <runDir> research --research-run-dir <dir>
//   node integration/bin/integrate.mjs answer <runDir> --file <answers.json>
//   node integration/bin/integrate.mjs answer <runDir> --question <id> --text "<answer>"
//   node integration/bin/integrate.mjs answer <runDir> --preferences '{"q-color":"opt-sage"}'
//   node integration/bin/integrate.mjs approve <runDir> prd_approval --by <name> --prd-file <approved-prd.json>
//   node integration/bin/integrate.mjs approve <runDir> concept_approval --by <name> --concept <id>
//   node integration/bin/integrate.mjs register <workflow-name> --script <path> [--note <text>]
//   node integration/bin/integrate.mjs status <runDir>
//
// Workflow invocations are returned as concrete Workflow-tool inputs; this CLI
// never fakes their execution.

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, stableStringify } from "../../research/lib/canonical.mjs";
import { acquireMaterials, materialsFingerprint, acquireOne } from "../lib/materials.mjs";
import { validateAssessment, detectBrandConflicts } from "../lib/assess.mjs";
import { createRun, loadRun, saveRun, recordStageOutput, recordApproval, recordAnswers, recordClientPreferences, touchpointOf } from "../lib/runstate.mjs";
import { registerExternal, validateArgsAgainstSource, loadRegistry } from "../lib/registry.mjs";
import { prepareContext } from "../lib/context.mjs";
import { advance } from "../lib/next.mjs";
import { checkLaneArtifactReuse, checkResearchReuse } from "../lib/reuse.mjs";
import { validateApprovedPrd, approvedPrdHash, missingBrandValues } from "../lib/laneprd.mjs";
import { renderStatusHtml } from "../lib/statushtml.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_RUNS_DIR = join(repoRoot, "integration/runs");

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest.filter((a) => a.startsWith("--")));
const positional = rest.filter((a) => !a.startsWith("--") && !isFlagValue(rest, a));

try {
  switch (command) {
    case "init": await cmdInit(); break;
    case "next": await cmdNext(positional[0]); break;
    case "record": await cmdRecord(positional[0], positional[1]); break;
    case "answer": await cmdAnswer(positional[0]); break;
    case "approve": await cmdApprove(positional[0], positional[1]); break;
    case "register": await cmdRegister(positional[0]); break;
    case "status": await cmdStatus(positional[0]); break;
    default:
      console.error("Unknown command. See header of integration/bin/integrate.mjs for usage.");
      process.exit(2);
  }
} catch (error) {
  console.error(`[integrate] ERROR: ${error.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- commands

async function cmdInit() {
  if (!flags.request) fail("init requires --request <request.json>");
  const requestPath = resolve(flags.request);
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const nowIso = new Date().toISOString();
  const baseDir = dirname(requestPath);
  if (!request.prd?.path) fail("request.prd.path is required (the PRD source document)");
  const prdRecord = await acquireOne({ path: request.prd.path, id: "prd", role: "prd" }, { baseDir, nowIso, index: -1 });
  if (prdRecord.parseStatus === "missing") fail(`PRD not readable: ${prdRecord.source.path ?? request.prd.path}`);
  request.prd = { path: prdRecord.source.path, sha256: prdRecord.sha256, parseStatus: prdRecord.parseStatus };
  const materials = await acquireMaterials(request, { baseDir, nowIso });
  const runId = flags["run-id"] || request.runId || `run-${Date.now().toString(36)}`;
  const runsDir = flags["runs-dir"] ? resolve(flags["runs-dir"]) : DEFAULT_RUNS_DIR;
  const { runDir } = await createRun(runsDir, runId, { request, materials, materialsHash: materialsFingerprint(materials), nowIso });
  console.log(`[integrate] run created: ${runDir}`);
  summarizeMaterials(materials);
  await cmdNext(runDir);
}

async function cmdNext(runDir) {
  if (!runDir) fail("next requires <runDir>");
  runDir = resolve(runDir);
  const context = await prepareContext({ repoRoot, runDir });
  const action = await advance({ repoRoot, runDir, context });
  await writeFile(join(runDir, "next-action.json"), `${JSON.stringify(action, null, 2)}\n`);
  if (context.plan) await writeFile(join(runDir, "route-plan.json"), `${JSON.stringify(context.plan, null, 2)}\n`);
  await writeStatus(runDir, context, action);
  if (flags.json) {
    console.log(JSON.stringify(action, null, 2));
    return;
  }
  printAction(action, runDir);
}

async function cmdRecord(runDir, stageId) {
  if (!runDir || !stageId) fail("record requires <runDir> <stageId>");
  runDir = resolve(runDir);
  const state = await loadRun(runDir);
  const nowIso = new Date().toISOString();

  if (stageId === "intake") {
    const resultPath = resolve(flags.result ?? join(runDir, "assessment.json"));
    const assessment = JSON.parse(await readFile(resultPath, "utf8"));
    const materials = JSON.parse(await readFile(join(runDir, "materials.json"), "utf8"));
    const check = validateAssessment(assessment, materials);
    if (!check.ok) fail(`assessment failed deterministic validation: ${check.failures.join(", ")}`);
    const extraConflicts = detectBrandConflicts(assessment.normalizedBrief?.brandConstraints);
    for (const conflict of extraConflicts) {
      const detail = `${conflict.axis} role "${conflict.role}" has competing values ${conflict.values.join(" vs ")}`;
      if (!(assessment.conflicts || []).some((c) => c.detail?.includes(conflict.values[0]) && c.detail?.includes(conflict.values[1]))) {
        assessment.conflicts = [...(assessment.conflicts || []), { kind: "brand_conflict", detail, materialIds: assessment.normalizedBrief?.brandConstraints?.sourceMaterialIds ?? [] }];
      }
    }
    const digest = sha256(stableStringify(assessment));
    await writeFile(join(runDir, "assessment.json"), `${JSON.stringify(assessment, null, 2)}\n`);
    recordStageOutput(state, "intake", { path: join(runDir, "assessment.json"), sha256: digest, actor: "ai_confirmed", summary: `assessed ${assessment.materials.length} materials`, nowIso });
    await saveRun(runDir, state);
    console.log(`[integrate] intake assessment recorded (${assessment.materials.length} materials, ${assessment.conflicts?.length ?? 0} conflicts)`);
  } else if (stageId === "prd_interview") {
    const result = JSON.parse(await readFile(resolve(requireFlag("result")), "utf8"));
    if (!Array.isArray(result.questions)) fail("prd_interview result must contain questions[] (stage-1 workflow return)");
    state.questions = result.questions;
    recordStageOutput(state, "prd_interview", { path: resolve(flags.result), sha256: sha256(stableStringify(result)), actor: "ai_confirmed", summary: `${result.questions.length} open questions`, nowIso });
    await saveRun(runDir, state);
    console.log(`[integrate] prd_interview recorded: ${result.questions.length} questions for the user`);
  } else if (stageId === "prd_revise") {
    const result = JSON.parse(await readFile(resolve(requireFlag("result")), "utf8"));
    const prdV2 = result.file;
    if (!prdV2 || !existsSync(prdV2)) fail(`PRD-v2 file missing: ${prdV2}`);
    const digest = sha256(await readFile(prdV2));
    recordStageOutput(state, "prd_revise", { path: prdV2, sha256: digest, actor: "ai_confirmed", summary: result.prdV2Summary ?? "PRD-v2 written", nowIso });
    await saveRun(runDir, state);
    console.log(`[integrate] prd_revise recorded: ${prdV2}`);
  } else if (stageId === "research") {
    if (flags.draft) {
      const draftPath = resolve(flags.draft);
      const draft = JSON.parse(await readFile(draftPath, "utf8"));
      if (!Array.isArray(draft.cards)) fail("research draft must contain cards[]");
      state.stages.research.draft = { path: draftPath, sha256: sha256(stableStringify(draft)), recordedAt: nowIso };
      await saveRun(runDir, state);
      console.log("[integrate] research draft recorded; run `next` for the assemble command (live verification).");
    } else if (flags["research-run-dir"]) {
      const researchRunDir = resolve(flags["research-run-dir"]);
      const runStatePath = join(researchRunDir, "state.json");
      if (!existsSync(runStatePath)) fail(`no state.json in ${researchRunDir}`);
      const researchState = JSON.parse(await readFile(runStatePath, "utf8"));
      const approvedPrdPath = state.approvals.prd_approval ? (existsSync(join(runDir, "approved-prd.json")) ? join(runDir, "approved-prd.json") : null) : null;
      const prdJson = approvedPrdPath ? JSON.parse(await readFile(approvedPrdPath, "utf8")) : await userSuppliedApprovedPrd(runDir, state);
      if (!prdJson) fail("no approved PRD available to validate the research run against");
      const check = await checkResearchReuse({ runDir: researchRunDir, prd: prdJson, nowIso });
      if (!check.ok) fail(`research run not consumable: ${check.failures.join(", ")}`);
      recordStageOutput(state, "research", { path: join(researchRunDir, "package.json"), sha256: check.packageHash, actor: researchState.status === "verified_autonomous" ? "ai_confirmed" : "human_approved", summary: `research package ${check.packageHash.slice(0, 12)}… (${researchState.status})`, nowIso });
      state.stages.research.researchRunDir = researchRunDir;
      await saveRun(runDir, state);
      console.log(`[integrate] research recorded from ${researchRunDir} (${researchState.status})`);
    } else {
      fail("record research requires --draft <file> or --research-run-dir <dir>");
    }
  } else if (stageId === "wireframe") {
    const result = JSON.parse(await readFile(resolve(requireFlag("result")), "utf8"));
    const laneDir = result.runDir ? resolve(result.runDir) : join(runDir, "wireframe");
    const laneOutputPath = join(laneDir, "lane-output.json");
    const check = await checkLaneArtifactReuse({ laneOutputPath, expectedLaneId: "wireframe", nowIso });
    if (!check.ok) fail(`wireframe lane output failed validation: ${check.failures.join(", ")}`);
    const recommendation = result.aiRecommendation ?? check.laneOutput.aiRecommendation;
    if (!recommendation?.recommendedVariantId) fail("no AI representative recommendation in lane output; cannot auto-select (autonomous flow requires it)");
    const representativePath = join(laneDir, `wireframe-${recommendation.recommendedVariantId}.html`);
    if (!existsSync(representativePath)) fail(`recommended variant file missing: ${representativePath}`);
    recordStageOutput(state, "wireframe", { path: laneOutputPath, sha256: sha256(stableStringify(check.laneOutput)), actor: "ai_confirmed", summary: `variants: ${(result.variants ?? []).map((v) => v.id).join(", ")}; representative auto-selected`, nowIso });
    state.stages.wireframe.representative = {
      variantId: recommendation.recommendedVariantId,
      path: representativePath,
      sha256: sha256(await readFile(representativePath)),
      actor: "ai_confirmed",
      reason: recommendation.reason ?? null,
    };
    await saveRun(runDir, state);
    console.log(`[integrate] wireframe recorded; representative "${recommendation.recommendedVariantId}" auto-selected (ai_confirmed, no designer gate)`);
  } else if (stageId === "concept_elicit") {
    const result = JSON.parse(await readFile(resolve(requireFlag("result")), "utf8"));
    if (result.mode !== "elicitation") fail(`expected the lane's elicitation pass (mode "elicitation"), got mode "${result.mode ?? "none"}" — do not skip the client questionnaire`);
    const questions = result.questionnaire?.questions;
    if (!Array.isArray(questions) || !questions.length) fail("elicitation result has no questionnaire.questions[]");
    if (questions[0].kind !== "color") fail(`the first client question must be about colour (kind "color"), got "${questions[0].kind}"`);
    state.questionnaire = questions;
    recordStageOutput(state, "concept_elicit", { path: resolve(flags.result), sha256: sha256(stableStringify(result)), actor: "ai_confirmed", summary: `${questions.length} client aesthetic questions`, nowIso });
    await saveRun(runDir, state);
    console.log(`[integrate] questionnaire recorded: ${questions.length} questions (first is colour). Ask the client next.`);
  } else if (stageId === "concepts") {
    const result = JSON.parse(await readFile(resolve(requireFlag("result")), "utf8"));
    if (result.mode === "elicitation") fail("this is an elicitation result, not generated concepts — record it as concept_elicit and collect the client's answers first");
    const laneDir = result.runDir ? resolve(result.runDir) : join(runDir, "concepts");
    const laneOutputPath = join(laneDir, "lane-output.json");
    const check = await checkLaneArtifactReuse({ laneOutputPath, expectedLaneId: "visual-concept", nowIso });
    if (!check.ok) fail(`concept lane output failed validation: ${check.failures.join(", ")}`);
    recordStageOutput(state, "concepts", { path: laneOutputPath, sha256: sha256(stableStringify(check.laneOutput)), actor: "ai_confirmed", summary: `concepts: ${(check.laneOutput.artifacts || []).map((a) => a.conceptId ?? a.id).join(", ")}`, nowIso });
    await saveRun(runDir, state);
    console.log("[integrate] concepts recorded; next real user decision is concept approval");
  } else if (stageId === "production") {
    const result = JSON.parse(await readFile(resolve(requireFlag("result")), "utf8"));
    const { inspectRun } = await import("../../product/pipeline.mjs");
    const productDir = join(runDir, "production/package");
    const productState = inspectRun(productDir);
    if (result.status !== "ready-for-review" || productState.status !== "ready-for-review") fail("production is not ready for human inspection; incomplete or failed checks cannot be recorded as done");
    const handoffPath = join(productDir, productState.revision, "handoff.json");
    const handoff = JSON.parse(await readFile(handoffPath, "utf8"));
    if (handoff.specHash !== productState.specHash || handoff.engineHash !== productState.engineHash || handoff.status !== "ready-for-review") fail("production handoff revision mismatch");
    recordStageOutput(state, "production", { path: resolve(flags.result), sha256: sha256(stableStringify(result)), actor: "ai_confirmed", summary: result.summary ?? "production outputs recorded", nowIso });
    await saveRun(runDir, state);
    console.log("[integrate] production outputs recorded");
  } else {
    fail(`unknown stage for record: ${stageId}`);
  }
}

async function cmdAnswer(runDir) {
  if (!runDir) fail("answer requires <runDir>");
  runDir = resolve(runDir);
  const state = await loadRun(runDir);
  const nowIso = new Date().toISOString();
  if (flags.question) {
    if (flags.text === undefined) fail("answer --question requires --text");
    state.intakeAnswers = state.intakeAnswers || {};
    state.intakeAnswers[flags.question] = { answer: flags.text, at: nowIso };
    state.events.push({ at: nowIso, event: "intake_question_answered", id: flags.question });
    await saveRun(runDir, state);
    console.log(`[integrate] intake answer recorded for ${flags.question}`);
  } else if (flags.preferences) {
    const preferences = typeof flags.preferences === "string" && flags.preferences.trim().startsWith("{")
      ? JSON.parse(flags.preferences)
      : JSON.parse(await readFile(resolve(flags.preferences), "utf8"));
    const known = new Set((state.questionnaire ?? []).map((q) => q.id));
    if (known.size) {
      const unknown = Object.keys(preferences).filter((id) => !known.has(id));
      if (unknown.length) fail(`answers for questions the lane never asked: ${unknown.join(", ")}`);
      const unanswered = [...known].filter((id) => preferences[id] === undefined);
      if (unanswered.length) fail(`the lane will not generate with unanswered questions: ${unanswered.join(", ")}`);
    }
    recordClientPreferences(state, { preferences, at: nowIso });
    await saveRun(runDir, state);
    console.log(`[integrate] client aesthetic preferences recorded (${Object.keys(preferences).length} answers)`);
  } else if (flags.file) {
    const answers = JSON.parse(await readFile(resolve(flags.file), "utf8"));
    recordAnswers(state, { answers, at: nowIso });
    await saveRun(runDir, state);
    console.log(`[integrate] ${answers.length} interview answers recorded`);
  } else {
    fail("answer requires --file <answers.json>, --preferences <json|file>, or --question <id> --text <answer>");
  }
}

async function cmdApprove(runDir, gate) {
  if (!runDir || !gate) fail("approve requires <runDir> <gate>");
  runDir = resolve(runDir);
  const state = await loadRun(runDir);
  const nowIso = new Date().toISOString();
  const by = requireFlag("by");
  if (gate === "prd_approval") {
    const prdFile = resolve(requireFlag("prd-file"));
    const prd = JSON.parse(await readFile(prdFile, "utf8"));
    const check = validateApprovedPrd(prd);
    if (!check.ok) fail(`approved PRD invalid: ${check.failures.join(", ")}`);
    // Client-specified brand values recognized at intake must survive verbatim.
    if (existsSync(join(runDir, "assessment.json"))) {
      const assessment = JSON.parse(await readFile(join(runDir, "assessment.json"), "utf8"));
      const missing = missingBrandValues(assessment.normalizedBrief?.brandConstraints, prd);
      if (missing.length) fail(`approved PRD silently drops client brand values: ${missing.join(", ")} — carry them in brandConstraints`);
    }
    await copyFile(prdFile, join(runDir, "approved-prd.json"));
    recordApproval(state, "prd_approval", { by, at: nowIso, revision: approvedPrdHash(prd), evidence: `approved via integrate approve (source ${prdFile})` });
    await saveRun(runDir, state);
    console.log(`[integrate] PRD approved by ${by}, revision ${approvedPrdHash(prd).slice(0, 12)}…`);
  } else if (gate === "concept_approval") {
    const conceptId = requireFlag("concept");
    const laneOutputPath = join(runDir, "concepts", "lane-output.json");
    let revision = flags.revision ?? null;
    if (existsSync(laneOutputPath)) {
      const laneOutput = JSON.parse(await readFile(laneOutputPath, "utf8"));
      const artifact = (laneOutput.artifacts || []).find((a) => (a.conceptId ?? a.id) === conceptId || a.id === `concept-${conceptId}`);
      if (!artifact) fail(`concept "${conceptId}" not found in ${laneOutputPath}`);
      const file = join(runDir, "concepts", artifact.path);
      const digest = sha256(await readFile(file));
      if (artifact.revisionHash && digest !== artifact.revisionHash) fail(`concept file changed after packaging (tampered): ${artifact.path}`);
      revision = digest;
    } else if (!revision) {
      fail("no concepts lane output; pass --revision <sha256> of the adopted artifact explicitly");
    }
    recordApproval(state, "concept_approval", { by, at: nowIso, revision, note: conceptId, evidence: `concept ${conceptId} approved at revision ${revision?.slice(0, 12)}…` });
    state.stages.concepts.approvedConceptId = conceptId;
    await saveRun(runDir, state);
    console.log(`[integrate] concept "${conceptId}" approved by ${by} (revision-bound)`);
  } else {
    fail(`unknown gate: ${gate} (research/wireframe have no human gate by design)`);
  }
}

async function cmdRegister(name) {
  if (!name) fail("register requires <workflow-name>");
  const { localAbs, local } = registerExternal(repoRoot, name, requireFlag("script"), { sourceNote: flags.note });
  const registry = loadRegistry(repoRoot);
  const probe = { ...registry[name], scriptPath: local.workflows[name].scriptPath, status: "available" };
  const contract = await validateArgsAgainstSource(probe);
  if (!contract.ok) fail(`registration rejected — arg contract does not match source: ${contract.failures.join(", ")}`);
  await writeFile(localAbs, `${JSON.stringify(local, null, 2)}\n`);
  console.log(`[integrate] registered ${name} → ${local.workflows[name].scriptPath} (sha256 ${local.workflows[name].sha256.slice(0, 12)}…)`);
}

async function cmdStatus(runDir) {
  if (!runDir) fail("status requires <runDir>");
  runDir = resolve(runDir);
  const context = await prepareContext({ repoRoot, runDir });
  let nextAction = null;
  if (existsSync(join(runDir, "next-action.json"))) {
    nextAction = JSON.parse(await readFile(join(runDir, "next-action.json"), "utf8"));
  }
  const path = await writeStatus(runDir, context, nextAction);
  console.log(`[integrate] status view: ${path}`);
  for (const stage of context.plan?.stages ?? []) {
    const st = context.state.stages[stage.id];
    const gate = stage.humanGate ? `  [사람: ${touchpointOf(stage.id)?.title ?? "?"}]` : "";
    console.log(`  ${stage.id.padEnd(18)} ${String(stage.decision).padEnd(8)} ${(st?.status ?? "pending").padEnd(14)}${st?.actor ? `(${st.actor})` : ""}${gate}`);
  }
}

// ---------------------------------------------------------------- helpers

async function writeStatus(runDir, context, nextAction) {
  const html = renderStatusHtml({ state: context.state, materials: context.materials, assessment: context.assessment, plan: context.plan, nextAction });
  const path = join(runDir, "status.html");
  await writeFile(path, html);
  return path;
}

async function userSuppliedApprovedPrd(runDir, state) {
  const materials = JSON.parse(await readFile(join(runDir, "materials.json"), "utf8"));
  const candidate = materials.find((m) => m.declaredRole === "approved-prd" && m.parseStatus === "parsed_text");
  if (!candidate) return null;
  return JSON.parse(await readFile(candidate.source.path, "utf8"));
}

function printAction(action, runDir) {
  console.log(`\n[integrate] NEXT (${action.type}) stage=${action.stage ?? "-"}`);
  if (action.type === "invoke_workflow") {
    console.log(`  Invoke the Workflow tool with:`);
    console.log(`    scriptPath: ${action.input.scriptPath}`);
    console.log(`    args: (see ${join(runDir, "next-action.json")})`);
    console.log(`  Save the workflow's returned JSON to: ${action.saveResultTo}`);
    console.log(`  Then: ${action.then}`);
  } else if (action.type === "run_command") {
    console.log(`  Run: ${action.argv.join(" ")}`);
    console.log(`  Then: ${action.then}`);
  } else if (action.type === "user_decision") {
    console.log(`  HUMAN TOUCHPOINT: ${action.touchpointTitle ?? action.touchpoint ?? action.kind}`);
    for (const ask of action.asks ?? [action]) {
      console.log(`  · ${ask.kind}`);
      if (Array.isArray(ask.payload)) for (const q of ask.payload) console.log(`     - [${q.id}] ${q.question ?? ""}`);
      if (ask.how) console.log(`     → ${ask.how}`);
    }
    if (action.remainingInTouchpoint?.length) {
      console.log(`  (still in this review, once the pipeline catches up: ${action.remainingInTouchpoint.join(", ")})`);
    }
  } else if (action.type === "blocked") {
    console.log(`  BLOCKED: ${action.reason}`);
    console.log(`  Unmet: ${(action.unmetChecks ?? []).join(", ")}`);
  } else {
    console.log(`  ${action.message ?? ""}`);
  }
}

function summarizeMaterials(materials) {
  for (const m of materials) {
    console.log(`  material ${m.id}: ${m.source?.path ?? m.source?.url ?? "?"} [${m.parseStatus}]${m.declaredRole ? ` role=${m.declaredRole}` : ""}`);
  }
}

function parseFlags(flagArgs) {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[name] = true;
    else { out[name] = next; i += 1; }
  }
  return out;
}

function isFlagValue(argv, value) {
  const index = argv.indexOf(value);
  return index > 0 && argv[index - 1].startsWith("--");
}

function requireFlag(name) {
  if (flags[name] === undefined || flags[name] === true) fail(`--${name} <value> is required`);
  return flags[name];
}

function fail(message) {
  throw new Error(message);
}
