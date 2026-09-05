import { sha256, stableStringify } from "../../research/lib/canonical.mjs";

// Adapters between the pipeline's PRD/handoff shapes.

// Minimal structural validation of approved-prd/v1 (research/schemas/
// approved-prd.schema.json) without a JSON-schema dependency.
export function validateApprovedPrd(prd) {
  const failures = [];
  if (!prd || typeof prd !== "object") return { ok: false, failures: ["not_object"] };
  if (prd.$schema !== "approved-prd/v1") failures.push("schema_marker_missing");
  for (const key of ["prdId", "title", "domain", "problem", "audience"]) {
    if (typeof prd[key] !== "string" || !prd[key].trim()) failures.push(`missing:${key}`);
  }
  if (!Array.isArray(prd.coreTasks) || !prd.coreTasks.length) failures.push("missing:coreTasks");
  if (!Array.isArray(prd.features) || !prd.features.length) failures.push("missing:features");
  for (const feature of prd.features || []) {
    if (!feature?.featureId || !feature?.name || !feature?.description) failures.push(`feature_incomplete:${feature?.featureId ?? "?"}`);
  }
  if (!prd.approval?.approvedBy || !prd.approval?.approvedAt) failures.push("missing:approval");
  return { ok: failures.length === 0, failures };
}

// Client-specified brand values must survive verbatim — never silently
// substituted. Returns the values from `constraints` that are absent in `prd`.
export function missingBrandValues(constraints, prd) {
  const wanted = [];
  for (const entry of constraints?.colors || []) wanted.push(typeof entry === "object" ? entry.value : entry);
  for (const entry of constraints?.fonts || []) wanted.push(typeof entry === "object" ? entry.family : entry);
  const haystack = JSON.stringify(prd.brandConstraints ?? {});
  return wanted.filter((value) => value && !haystack.includes(value));
}

// approved-prd/v1 → the lane PRD-input contract consumed by the downstream
// wireframe/visual-concept lanes (contracts/prd-input.schema.json).
export function approvedPrdToLaneInput(prd, { researchHandoff = null, viewport = null } = {}) {
  const brandHints = [];
  for (const entry of prd.brandConstraints?.colors || []) {
    const value = typeof entry === "object" ? entry.value : entry;
    const role = typeof entry === "object" && entry.role ? `${entry.role}: ` : "";
    if (value) brandHints.push(`client color override — ${role}${value} (fixed, overrides system defaults)`);
  }
  for (const entry of prd.brandConstraints?.fonts || []) {
    const family = typeof entry === "object" ? entry.family : entry;
    const role = typeof entry === "object" && entry.role ? `${entry.role}: ` : "";
    if (family) brandHints.push(`client font override — ${role}${family} (fixed, overrides system defaults)`);
  }
  const lanePrd = {
    id: prd.prdId,
    title: prd.title,
    domain: prd.domain,
    problem: prd.problem,
    targetUsers: [prd.audience],
    background: prd.brandConstraints?.notes ?? "",
    coreFlows: prd.coreTasks.map((task, index) => ({
      id: `flow-${index + 1}`,
      name: task,
      steps: [task],
    })),
    mustHaveScreens: [],
    brandHints,
    constraints: prd.constraints ?? [],
  };
  if (viewport) lanePrd.viewport = viewport;
  if (researchHandoff) lanePrd.researchHandoff = researchHandoff;
  const check = missingBrandValues(prd.brandConstraints, { brandConstraints: { colors: lanePrd.brandHints, fonts: lanePrd.brandHints } });
  if (check.length) throw new Error(`brand values lost in lane conversion: ${check.join(", ")}`);
  return lanePrd;
}

// Provisional lane PRD built from the intake brief, before the PRD is
// approved. Used only for the aesthetic questionnaire, which needs the domain
// and brand context but not a settled feature list — that is what lets the
// client answer it during the PRD review instead of in a third sitting.
export function briefToLaneInput(brief, { id = "prd-draft" } = {}) {
  const asApproved = {
    prdId: id,
    title: brief.title,
    domain: brief.domain,
    problem: brief.problem,
    audience: brief.audience,
    coreTasks: brief.coreTasks ?? [],
    features: brief.features ?? [],
    constraints: brief.constraints ?? [],
    brandConstraints: brief.brandConstraints ?? null,
    approval: { approvedBy: "provisional", approvedAt: new Date(0).toISOString() },
  };
  const lanePrd = approvedPrdToLaneInput(asApproved, { viewport: brief.viewport ?? null });
  lanePrd.background = `${lanePrd.background ?? ""}\n\nPROVISIONAL: derived from the intake brief before PRD approval. Used only to ground the client aesthetic questionnaire.`.trim();
  return lanePrd;
}

export function approvedPrdHash(prd) {
  return sha256(stableStringify(prd));
}
