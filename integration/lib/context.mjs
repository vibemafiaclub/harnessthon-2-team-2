import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadRegistry } from "./registry.mjs";
import { loadRun, readRunJson } from "./runstate.mjs";
import { checkResearchReuse, checkLaneArtifactReuse } from "./reuse.mjs";
import { validateApprovedPrd, approvedPrdHash } from "./laneprd.mjs";
import { buildRoutePlan } from "./routing.mjs";

// Prepares everything buildRoutePlan needs: run state, materials, assessment
// (decorated with revision-match facts only the host can verify), the
// approved PRD (pipeline-produced or user-supplied), and evidence-based reuse
// check results.

export async function prepareContext({ repoRoot, runDir, nowIso = new Date().toISOString() }) {
  const state = await loadRun(runDir);
  const materials = await readRunJson(runDir, "materials");
  const registry = loadRegistry(repoRoot);
  let assessment = null;
  if (existsSync(join(runDir, "assessment.json"))) {
    assessment = await readRunJson(runDir, "assessment");
    decorateAssessment(assessment, state, materials);
  }

  const approvedPrd = await deriveApprovedPrd({ runDir, state, materials, assessment });
  const reuse = {};

  const researchCandidate = findCandidate(materials, assessment, ["research-package"], ["research_package"]);
  if (researchCandidate) {
    if (approvedPrd) {
      const path = researchCandidate.source.path;
      const opts = basename(path) === "package.json" || basename(path) === "state.json"
        ? { runDir: dirname(path) }
        : { packagePath: path };
      reuse.research = { ...(await checkResearchReuse({ ...opts, prd: approvedPrd.json, nowIso, maxAgeDays: state.request?.policy?.maxResearchAgeDays })), candidate: path };
    } else {
      reuse.research = { ok: false, failures: ["approved_prd_not_yet_available"], evidence: [], candidate: researchCandidate.source.path };
    }
  }

  const wireframeCandidate = findCandidate(materials, assessment, ["wireframe"], ["wireframe"], (m) => basename(m.source?.path ?? "") === "lane-output.json");
  if (wireframeCandidate) {
    reuse.wireframe = {
      ...(await checkLaneArtifactReuse({ laneOutputPath: wireframeCandidate.source.path, expectedLaneId: "wireframe", nowIso })),
      candidate: wireframeCandidate.source.path,
    };
  }

  const plan = assessment ? buildRoutePlan({ state, assessment, registry, reuse, approvedPrd, nowIso }) : null;
  return { state, materials, assessment, registry, reuse, approvedPrd, plan, nowIso };
}

// Facts only the host can verify are attached here, never claimed by the model:
// does a user-declared approvedRevision actually match the acquired bytes?
function decorateAssessment(assessment, state, materials) {
  const acquisitionById = new Map(materials.map((m) => [m.id, m]));
  const requestById = new Map();
  (state.request?.materials || []).forEach((input, index) => {
    const id = input.id || `mat-${String(index + 1).padStart(2, "0")}`;
    requestById.set(id, input);
  });
  for (const item of assessment.materials || []) {
    const acquisition = acquisitionById.get(item.materialId);
    const input = requestById.get(item.materialId);
    if (input?.approvedRevision && acquisition?.sha256 && input.approvedRevision === acquisition.sha256) {
      item.approvedRevisionMatch = acquisition.sha256;
    }
  }
}

function findCandidate(materials, assessment, roles, types, extra = () => true) {
  const assessedTypes = new Map((assessment?.materials || []).map((m) => [m.materialId, m.type]));
  return materials.find((m) => {
    if (m.source?.kind !== "file") return false;
    const roleMatch = roles.includes(m.declaredRole ?? "");
    const typeMatch = types.includes(assessedTypes.get(m.id) ?? "");
    return (roleMatch || typeMatch) && extra(m);
  }) ?? null;
}

async function deriveApprovedPrd({ runDir, state, materials, assessment }) {
  // 1. Pipeline-approved PRD recorded in this run.
  const approvedPath = join(runDir, "approved-prd.json");
  if (state.approvals.prd_approval && existsSync(approvedPath)) {
    const json = JSON.parse(await readFile(approvedPath, "utf8"));
    return { json, sha256: approvedPrdHash(json), source: "pipeline", path: approvedPath };
  }
  // 2. User-supplied approved PRD material: explicit role + valid schema.
  //    The assessment (when present) must also have verified it.
  const candidate = materials.find((m) => m.declaredRole === "approved-prd" && m.source?.kind === "file" && m.parseStatus === "parsed_text");
  if (!candidate) return null;
  let json;
  try {
    json = JSON.parse(await readFile(candidate.source.path, "utf8"));
  } catch {
    return null;
  }
  const check = validateApprovedPrd(json);
  if (!check.ok) return null;
  if (assessment) {
    const assessed = (assessment.materials || []).find((m) => m.materialId === candidate.id);
    if (!assessed?.verified || assessed.type !== "approved_prd") return null;
  }
  return { json, sha256: approvedPrdHash(json), source: "user_supplied", materialId: candidate.id, path: candidate.source.path };
}
