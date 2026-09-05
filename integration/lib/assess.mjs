// Deterministic validation of the intake-assess workflow output. Model
// assessments are only accepted when they stay coupled to the acquisition
// evidence: no fabricated observations for unread inputs, no invented
// material ids, adoption intent only with a real user declaration.

export const MATERIAL_TYPES = [
  "prd_text",
  "approved_prd",
  "brand_tokens",
  "component_library",
  "design_system",
  "html_template",
  "screenshot",
  "mockup",
  "wireframe",
  "ia_userflow",
  "research_package",
  "concept_output",
  "page_output",
  "reference",
  "unverified",
  "other",
];

const UNREADABLE = new Set(["missing", "unreadable"]);

export function validateAssessment(assessment, materials) {
  const failures = [];
  const byId = new Map(materials.map((m) => [m.id, m]));
  if (!assessment || typeof assessment !== "object") return { ok: false, failures: ["assessment_not_object"] };
  const items = Array.isArray(assessment.materials) ? assessment.materials : null;
  if (!items) return { ok: false, failures: ["materials_array_missing"] };

  const covered = new Set();
  for (const item of items) {
    const material = byId.get(item.materialId);
    if (!material) {
      failures.push(`unknown_material_id:${item.materialId}`);
      continue;
    }
    if (covered.has(item.materialId)) failures.push(`duplicate_assessment:${item.materialId}`);
    covered.add(item.materialId);
    if (!MATERIAL_TYPES.includes(item.type)) failures.push(`unknown_type:${item.materialId}:${item.type}`);
    const observations = Array.isArray(item.observations) ? item.observations : [];
    const hasAgentObservation = observations.some((o) => o?.evidence?.kind === "agent_observation" && o.evidence.detail);
    if (UNREADABLE.has(material.parseStatus)) {
      // Nothing was readable: the model may not claim extracted content.
      if (item.verified) failures.push(`verified_without_access:${item.materialId}`);
      if (observations.length) failures.push(`observations_without_access:${item.materialId}`);
      if (item.type !== "unverified") failures.push(`type_must_be_unverified:${item.materialId}`);
    } else if (material.parseStatus === "remote_unfetched" || material.parseStatus === "binary_unparsed") {
      // Verification requires an actual parser/model observation.
      if (item.verified && !hasAgentObservation) failures.push(`verified_without_observation:${item.materialId}`);
      if (!item.verified && observations.length && !hasAgentObservation) failures.push(`unverified_claims_content:${item.materialId}`);
    }
    if (item.adoptionIntent?.declared) {
      const declarationText = `${material.declaredRole ?? ""} ${material.description ?? ""}`;
      if (!item.adoptionIntent.quote || !declarationText.includes(item.adoptionIntent.quote)) {
        failures.push(`adoption_quote_not_in_declaration:${item.materialId}`);
      }
      if (!["adopted-concept", "adopted-template", "html-template", "design-system"].includes(material.declaredRole ?? "")) {
        failures.push(`adoption_without_declared_role:${item.materialId}`);
      }
    }
  }
  for (const material of materials) {
    if (!covered.has(material.id)) failures.push(`material_not_assessed:${material.id}`);
  }

  const brief = assessment.normalizedBrief;
  if (!brief || typeof brief !== "object") failures.push("normalized_brief_missing");
  else {
    for (const key of ["title", "domain", "problem", "audience"]) {
      if (typeof brief[key] !== "string" || !brief[key].trim()) failures.push(`brief_field_missing:${key}`);
    }
    if (!Array.isArray(brief.coreTasks) || !brief.coreTasks.length) failures.push("brief_core_tasks_missing");
    if (!Array.isArray(brief.features) || !brief.features.length) failures.push("brief_features_missing");
    const sourceIds = brief.brandConstraints?.sourceMaterialIds || [];
    for (const id of sourceIds) if (!byId.has(id)) failures.push(`brand_source_unknown:${id}`);
  }

  for (const conflict of assessment.conflicts || []) {
    for (const id of conflict.materialIds || []) if (!byId.has(id)) failures.push(`conflict_material_unknown:${id}`);
  }
  return { ok: failures.length === 0, failures };
}

// Deterministic brand-conflict detection: same declared role, different value,
// from user-supplied constraint sources. Complements (never replaces) the
// model's own conflict reporting.
export function detectBrandConflicts(brandConstraints) {
  const conflicts = [];
  for (const axis of ["colors", "fonts"]) {
    const seen = new Map();
    for (const entry of brandConstraints?.[axis] || []) {
      const role = typeof entry === "object" ? entry.role ?? "unspecified" : "unspecified";
      const value = typeof entry === "object" ? entry.value ?? entry.family : entry;
      if (!value) continue;
      if (seen.has(role) && seen.get(role) !== value) {
        conflicts.push({ kind: "brand_conflict", axis, role, values: [seen.get(role), value] });
      }
      seen.set(role, value);
    }
  }
  return conflicts;
}
