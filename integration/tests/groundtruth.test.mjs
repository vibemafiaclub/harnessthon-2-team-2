import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, validateArgsAgainstSource, buildInvocation } from "../lib/registry.mjs";
import { validateApprovedPrd, approvedPrdToLaneInput, missingBrandValues } from "../lib/laneprd.mjs";
import { STAGE_ORDER, stageDef, TOUCHPOINTS, touchpointOf } from "../lib/runstate.mjs";

// The ground truth files are executable contracts, not documentation: every
// declared input contract is checked against the real workflow source, every
// example against its own contract, and every handoff by deriving the next
// stage's input from this stage's output with the real adapter code.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GT_DIR = join(repoRoot, "integration/groundtruth");
const registry = loadRegistry(repoRoot);

const files = (await readdir(GT_DIR)).filter((f) => f.endsWith(".json")).sort();
const truth = {};
for (const file of files) {
  const doc = JSON.parse(await readFile(join(GT_DIR, file), "utf8"));
  truth[doc.stage] = { ...doc, file };
}

function present(object, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), object) != null;
}

const declaredOrder = [];
for (const file of files) declaredOrder.push(JSON.parse(await readFile(join(GT_DIR, file), "utf8")).stage);

test("ground truth covers every pipeline stage exactly once, in order", () => {
  assert.deepEqual(Object.keys(truth).sort(), [...STAGE_ORDER].sort());
  assert.deepEqual(declaredOrder, STAGE_ORDER, "file numbering must follow the stage order");
});

test("the human is asked at exactly two touchpoints, and every gate declares its own", () => {
  assert.deepEqual(TOUCHPOINTS.map((t) => t.id), ["prd_review", "concept_review"]);
  for (const [stage, doc] of Object.entries(truth)) {
    const touchpoint = touchpointOf(stage);
    if (stageDef(stage).humanGate) {
      assert.equal(doc.touchpoint, touchpoint.id, `${stage}: ground truth touchpoint mismatch`);
    } else {
      assert.equal(doc.touchpoint, undefined, `${stage} is autonomous and must not claim a human touchpoint`);
      assert.equal(touchpoint, null);
    }
  }
  // Research, wireframes and concept generation carry no human gate at all.
  for (const stage of ["research", "wireframe", "concept_elicit", "concepts"]) {
    assert.equal(stageDef(stage).humanGate, false, `${stage} must stay autonomous`);
  }
});

test("each stage's declared workflow and actor match the pipeline definition", () => {
  for (const [stage, doc] of Object.entries(truth)) {
    const def = stageDef(stage);
    assert.equal(doc.workflow ?? null, def.workflow ?? null, `${stage}: workflow mismatch`);
    if (def.humanGate) {
      assert.ok(["human_input", "human_approved"].includes(doc.actor), `${stage}: human gate must have a human actor, got ${doc.actor}`);
    } else {
      assert.notEqual(doc.actor, "human_approved", `${stage}: an autonomous stage must never claim human approval`);
    }
  }
});

test("every declared input contract equals the adapter's real required args", async () => {
  for (const [stage, doc] of Object.entries(truth)) {
    if (!doc.workflow) continue;
    const entry = registry[doc.workflow];
    assert.ok(entry, `${stage}: workflow ${doc.workflow} is not in the registry`);
    assert.deepEqual(
      [...doc.inputContract.required].sort(),
      [...entry.requiredArgs].sort(),
      `${stage}: ground truth input contract drifted from the adapter`,
    );
    if (entry.status === "available") {
      const check = await validateArgsAgainstSource(entry);
      assert.deepEqual(check.failures, [], `${stage}: adapter args missing from the real workflow source`);
    }
  }
});

test("every input example satisfies its own contract and builds a real invocation", () => {
  for (const [stage, doc] of Object.entries(truth)) {
    for (const path of doc.inputContract.required) {
      assert.ok(present(doc.inputExample, path), `${stage}: inputExample is missing required "${path}"`);
    }
    for (const path of doc.inputContract.mustOmit ?? []) {
      assert.equal(doc.inputExample[path], undefined, `${stage}: inputExample must NOT carry "${path}"`);
    }
    if (doc.workflow && registry[doc.workflow].status === "available") {
      const invocation = buildInvocation(registry, doc.workflow, doc.inputExample);
      assert.equal(invocation.ok, true, `${stage}: the documented input does not produce a valid invocation`);
    }
  }
});

test("every output example satisfies its own contract", () => {
  for (const [stage, doc] of Object.entries(truth)) {
    if (doc.outputExample == null) {
      assert.ok(doc.status?.startsWith("NOT IMPLEMENTED"), `${stage}: a null outputExample is only allowed for an unimplemented stage`);
      continue;
    }
    for (const path of doc.outputContract.required) {
      assert.ok(present(doc.outputExample, path), `${stage}: outputExample is missing required "${path}"`);
    }
    for (const [collection, keys] of [["perQuestion", doc.outputContract.perQuestion], ["perMaterial", doc.outputContract.perMaterial], ["perAnswer", doc.outputContract.perAnswer]]) {
      if (!keys) continue;
      const list = findList(doc.outputExample, collection);
      assert.ok(list?.length, `${stage}: no ${collection} list found in the output example`);
      for (const item of list) {
        for (const key of keys) assert.ok(item[key] !== undefined, `${stage}: ${collection} item missing "${key}"`);
      }
    }
  }
});

function findList(output, collection) {
  if (collection === "perQuestion") return output.questions ?? output.questionnaire?.questions;
  if (collection === "perMaterial") return output.materials;
  if (collection === "perAnswer") return output.answers;
  return null;
}

// ---------------------------------------------------------------- handoffs

test("handoff: the approved PRD converts into a valid lane PRD without losing client brand values", () => {
  const approved = truth.prd_approval.outputExample;
  assert.deepEqual(validateApprovedPrd(approved), { ok: true, failures: [] });

  const lanePrd = approvedPrdToLaneInput(approved, { researchHandoff: { path: "research-runs/x/package.json", approvedRevision: "sha256:abc" } });
  // contracts/prd-input.schema.json required keys
  for (const key of ["id", "title", "domain", "problem", "targetUsers", "coreFlows"]) {
    assert.ok(lanePrd[key] != null, `lane PRD missing ${key}`);
  }
  assert.deepEqual(missingBrandValues(approved.brandConstraints, { brandConstraints: lanePrd.brandHints }), [], "client colour/font values were lost in conversion");
  // The lane PRD is what the wireframe/concept stages actually receive.
  assert.equal(truth.wireframe.laneInputExample.id != null, true);
  assert.equal(truth.concepts.inputExample.prdPath, truth.wireframe.inputExample.prdPath, "both lanes must read the same lane PRD");
});

test("handoff: interview questions → answers ids", () => {
  const questionIds = new Set(truth.prd_interview.outputExample.questions.map((q) => q.id));
  for (const answer of truth.prd_answers.outputExample.answers) {
    assert.ok(questionIds.has(answer.id), `answer for unknown question ${answer.id}`);
  }
  assert.deepEqual(
    truth.prd_revise.inputExample.answers.map((a) => a.id),
    truth.prd_answers.outputExample.answers.map((a) => a.id),
    "the revise pass must receive exactly the recorded answers",
  );
  assert.equal(truth.prd_revise.inputExample.stage, "revise");
});

test("handoff: research draft is only consumable once sealed as verified_autonomous", () => {
  const research = truth.research;
  assert.equal(research.sealStep.producesState.status, "verified_autonomous");
  assert.equal(research.sealStep.producesState.liveVerified, true);
  assert.ok(research.sealStep.command.includes("research/bin/assemble-run.mjs"));
  assert.match(research.outputContract.notes, /draft/i, "the workflow return must be described as a draft, not a package");
});

test("handoff: the wireframe's AI recommendation names the file the concepts stage consumes", () => {
  const recommendation = truth.wireframe.outputExample.aiRecommendation;
  assert.ok(recommendation.recommendedVariantId, "autonomous flow requires an AI recommendation");
  const expectedFile = `wireframe-${recommendation.recommendedVariantId}.html`;
  assert.ok(
    truth.concepts.inputExample.representativeWireframePath.endsWith(expectedFile),
    `concepts must consume ${expectedFile}, got ${truth.concepts.inputExample.representativeWireframePath}`,
  );
  assert.equal(truth.concepts.inputExample.representativeVariant.selectedBy, "ai_confirmed");
  // The recommended variant is a real artifact of that same lane output.
  const paths = truth.wireframe.laneOutputExample.artifacts.map((a) => a.path);
  assert.ok(paths.includes(expectedFile), `${expectedFile} is not among the lane's artifacts: ${paths.join(", ")}`);
});

test("handoff: questionnaire ids are exactly the keys of the client's answers, which are exactly what the lane receives", () => {
  const questionIds = truth.concept_elicit.outputExample.questionnaire.questions.map((q) => q.id);
  const preferences = truth.concept_answers.outputExample.preferences;
  assert.deepEqual([...questionIds].sort(), Object.keys(preferences).sort(), "every question must be answered, and nothing else");
  assert.deepEqual(truth.concepts.inputExample.clientPreferences, preferences, "the lane must receive the client's answers verbatim");
  assert.equal(truth.concept_elicit.outputExample.mode, "elicitation");
  assert.equal(truth.concept_elicit.outputExample.questionnaire.questions[0].kind, "color", "the first client question is always colour");
});

test("handoff: concept approval binds to a real artifact revision of the concepts lane output", () => {
  const artifacts = truth.concepts.laneOutputExample.artifacts;
  const approval = truth.concept_approval.outputExample;
  const matching = artifacts.find((a) => a.revisionHash === approval.revision);
  assert.ok(matching, "the approval must bind to one of the generated concept revisions");
  assert.equal(matching.conceptId ?? matching.id, approval.note, "the approved conceptId must match the artifact");
  assert.equal(approval.actor, "human_approved");
});

test("production uses the built-in workflow while legacy registrations remain optional", () => {
  assert.equal(registry["production-outputs"].status, "unregistered");
  assert.equal(registry[truth.production.workflow].status, "available");
  assert.equal(buildInvocation(registry, truth.production.workflow, truth.production.inputExample).ok, true);
});
