import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const NOW = "2026-09-05T12:00:00.000Z";

export async function tempDir(prefix = "integration-test-") {
  return mkdtemp(join(tmpdir(), prefix));
}

export function approvedPrdFixture(overrides = {}) {
  return {
    $schema: "approved-prd/v1",
    prdId: "prd.fixture.v1",
    title: "Fixture product",
    domain: "fixture domain",
    problem: "People need a fixture.",
    audience: "Fixture users",
    coreTasks: ["do the fixture task"],
    features: [
      { featureId: "feat.one", name: "Feature one", description: "First feature." },
      { featureId: "feat.two", name: "Feature two", description: "Second feature." },
    ],
    constraints: ["mobile-first"],
    brandConstraints: {
      colors: [{ role: "primary", value: "#123456" }],
      fonts: [{ role: "heading", family: "Fixture Serif" }],
      notes: "client values are fixed",
    },
    approval: { approvedBy: "fixture-owner", approvedAt: "2026-09-04T00:00:00Z" },
    ...overrides,
  };
}

export function assessmentFixture({ materials = [], brief = {}, conflicts = [], intakeQuestions = [] } = {}) {
  return {
    assessedAt: NOW,
    materials,
    inaccessible: [],
    normalizedBrief: {
      title: "Fixture product",
      domain: "fixture domain",
      problem: "People need a fixture.",
      audience: "Fixture users",
      coreTasks: ["do the fixture task"],
      features: [{ featureId: "feat.one", name: "Feature one", description: "First feature." }],
      constraints: [],
      brandConstraints: null,
      ...brief,
    },
    userRequirements: [],
    conflicts,
    intakeQuestions,
  };
}

export function assessedMaterial(materialId, type, overrides = {}) {
  return { materialId, type, confidence: "high", verified: true, observations: [{ note: "seen", evidence: { kind: "excerpt", detail: "quoted text" } }], flags: [], ...overrides };
}

export function acquiredMaterial(id, overrides = {}) {
  return {
    id,
    declaredRole: null,
    description: null,
    acquiredAt: NOW,
    source: { kind: "file", path: `/fixture/${id}.md` },
    parseStatus: "parsed_text",
    sha256: `${"0".repeat(58)}${id.slice(-6).padStart(6, "0")}`.slice(0, 64),
    bytes: 10,
    contentSniff: "text",
    textExcerpt: "x",
    observationRequired: false,
    ...overrides,
  };
}

export function registryFixture(overrides = {}) {
  const available = (name, requiredArgs) => ({ name, kind: "external", scriptPath: `/fixture/${name}.mjs`, requiredArgs, status: "available" });
  return {
    "intake-assess": { name: "intake-assess", kind: "builtin", scriptPath: "/fixture/intake.mjs", requiredArgs: ["request", "materials", "nowIso"], status: "available" },
    "prd-interview": { name: "prd-interview", kind: "builtin", scriptPath: "/fixture/prd.js", requiredArgs: ["prdPath", "outDir", "promptsDir"], status: "available" },
    "prd-interview-revise": { name: "prd-interview-revise", kind: "builtin", scriptPath: "/fixture/prd.js", requiredArgs: ["stage", "prdPath", "outDir", "promptsDir", "answers"], status: "available" },
    "competitor-reference": { name: "competitor-reference", kind: "builtin", scriptPath: "/fixture/research.mjs", requiredArgs: ["prd", "nowIso"], status: "available" },
    "wireframe-lane": available("wireframe-lane", ["prdPath", "runDir", "runId", "round", "startedAt"]),
    "visual-concept-elicit": available("visual-concept-elicit", ["prdPath", "runDir", "runId", "round", "startedAt"]),
    "visual-concept-lane": available("visual-concept-lane", ["prdPath", "runDir", "runId", "round", "startedAt", "representativeWireframePath", "clientPreferences"]),
    "visual-concept-recolor": available("visual-concept-recolor", ["prdPath", "runDir", "runId", "round", "startedAt", "recolor"]),
    "production-outputs": { name: "production-outputs", kind: "external", scriptPath: null, requiredArgs: ["prdPath", "runDir", "conceptId"], status: "unregistered" },
    ...overrides,
  };
}

export async function makeRunDir({ state, materials, assessment }) {
  const dir = await tempDir("integration-run-");
  await writeFile(join(dir, "state.json"), JSON.stringify(state, null, 2));
  await writeFile(join(dir, "materials.json"), JSON.stringify(materials, null, 2));
  if (assessment) await writeFile(join(dir, "assessment.json"), JSON.stringify(assessment, null, 2));
  return dir;
}

export function baseState(runId = "run-test") {
  const stages = {};
  for (const id of ["intake", "prd_interview", "prd_answers", "prd_revise", "prd_approval", "research", "wireframe", "concept_elicit", "concept_answers", "concepts", "concept_approval", "production"]) {
    stages[id] = { status: "pending" };
  }
  return {
    runId,
    createdAt: NOW,
    request: { prd: { path: "/fixture/PRD.md", sha256: "a".repeat(64) }, materials: [] },
    materialsHash: "b".repeat(64),
    stages,
    approvals: {},
    approvalsHistory: [],
    intakeAnswers: {},
    events: [],
  };
}
