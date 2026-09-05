import test from "node:test";
import assert from "node:assert/strict";
import { validateAssessment, detectBrandConflicts } from "../lib/assess.mjs";
import { assessmentFixture, assessedMaterial, acquiredMaterial } from "./fixtures.mjs";

test("accepts a well-coupled assessment", () => {
  const materials = [acquiredMaterial("mat-01")];
  const assessment = assessmentFixture({ materials: [assessedMaterial("mat-01", "prd_text")] });
  const result = validateAssessment(assessment, materials);
  assert.deepEqual(result, { ok: true, failures: [] });
});

test("rejects fabricated content for missing/unreadable materials", () => {
  const materials = [acquiredMaterial("mat-01", { parseStatus: "missing", sha256: null, textExcerpt: null })];
  const assessment = assessmentFixture({ materials: [assessedMaterial("mat-01", "brand_tokens")] });
  const result = validateAssessment(assessment, materials);
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("verified_without_access:mat-01"));
  assert.ok(result.failures.includes("observations_without_access:mat-01"));
  assert.ok(result.failures.includes("type_must_be_unverified:mat-01"));
});

test("binary materials need an actual agent observation to be verified", () => {
  const materials = [acquiredMaterial("mat-01", { parseStatus: "binary_unparsed", contentSniff: "png", observationRequired: true })];
  const bad = assessmentFixture({ materials: [assessedMaterial("mat-01", "screenshot")] }); // excerpt evidence only
  assert.ok(validateAssessment(bad, materials).failures.includes("verified_without_observation:mat-01"));
  const good = assessmentFixture({
    materials: [assessedMaterial("mat-01", "screenshot", { observations: [{ note: "list screen with 3 cards", evidence: { kind: "agent_observation", detail: "read the PNG: mobile list view" } }] })],
  });
  assert.equal(validateAssessment(good, materials).ok, true);
});

test("rejects unknown or uncovered material ids", () => {
  const materials = [acquiredMaterial("mat-01"), acquiredMaterial("mat-02")];
  const assessment = assessmentFixture({ materials: [assessedMaterial("mat-01", "prd_text"), assessedMaterial("ghost", "reference")] });
  const result = validateAssessment(assessment, materials);
  assert.ok(result.failures.includes("unknown_material_id:ghost"));
  assert.ok(result.failures.includes("material_not_assessed:mat-02"));
});

test("adoption intent requires the quote to come from the user's own declaration", () => {
  const materials = [acquiredMaterial("mat-01", { declaredRole: "adopted-concept", description: "we will adopt this template as-is" })];
  const good = assessmentFixture({
    materials: [assessedMaterial("mat-01", "concept_output", { adoptionIntent: { declared: true, quote: "adopt this template", coverage: "adequate" } })],
  });
  assert.equal(validateAssessment(good, materials).ok, true);
  const fabricated = assessmentFixture({
    materials: [assessedMaterial("mat-01", "concept_output", { adoptionIntent: { declared: true, quote: "please use exactly this design", coverage: "adequate" } })],
  });
  assert.ok(validateAssessment(fabricated, materials).failures.includes("adoption_quote_not_in_declaration:mat-01"));
  // Mere attachment: no adoption-ish declared role.
  const attachmentOnly = [acquiredMaterial("mat-02", { declaredRole: "reference", description: "adopt this template" })];
  const wrongRole = assessmentFixture({
    materials: [assessedMaterial("mat-02", "concept_output", { adoptionIntent: { declared: true, quote: "adopt this template", coverage: "adequate" } })],
  });
  assert.ok(validateAssessment(wrongRole, attachmentOnly).failures.includes("adoption_without_declared_role:mat-02"));
});

test("detects conflicting client brand constraints deterministically", () => {
  const conflicts = detectBrandConflicts({
    colors: [{ role: "primary", value: "#111111" }, { role: "primary", value: "#222222" }],
    fonts: [{ role: "heading", family: "Serif A" }],
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].axis, "colors");
  assert.deepEqual(conflicts[0].values, ["#111111", "#222222"]);
});
