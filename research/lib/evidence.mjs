import {
  fail,
  isSha256,
  optionalString,
  requiredEnum,
  requiredString,
  requiredTime,
  sha256,
  stableStringify,
} from "./canonical.mjs";

// Evidence status taxonomy. "Not found" is never promoted to absence:
// an unsuccessful search yields "unknown"; "explicit_absence" requires a
// quote in which the vendor/source explicitly supports the absence.
export const EVIDENCE_STATUS = new Set(["observed", "explicit_absence", "unknown", "contradictory"]);
export const SUBJECT_TYPES = new Set(["competitor", "reference"]);
export const PROOF_TYPES = new Set(["quote", "screenshot", "none"]);
export const RELIABILITY = new Set(["high", "medium", "low"]);
export const CLAIM_SUPPORT = new Set(["direct", "indirect", "none"]);
export const RELEVANCE = new Set(["high", "medium", "low"]);
// Screenshot proofs must be real captures. A generated or reconstructed image
// is never admissible as observation evidence.
export const CAPTURE_METHODS = new Set(["browser_capture", "device_capture", "downloaded_press_asset"]);

const ID = /^[A-Za-z][A-Za-z0-9_.:-]{1,120}$/;

export function normalizeEvidenceCard(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("card_type", "Evidence card must be an object.");
  const cardId = requiredId(input.cardId, "cardId");
  const subjectType = requiredEnum(input.subjectType, SUBJECT_TYPES, "subjectType");
  const subjectId = requiredId(input.subjectId, "subjectId");
  const status = requiredEnum(input.status, EVIDENCE_STATUS, "status");
  const claim = requiredString(input.claim, 2000, "claim");
  const source = normalizeSource(input.source, status);
  const proof = normalizeProof(input.proof, status, cardId);
  const limitations = normalizeLimitations(input.limitations);
  const assessment = normalizeAssessment(input.assessment);
  const body = { cardId, subjectType, subjectId, status, claim, source, proof, limitations, assessment };
  return Object.freeze({ ...body, cardHash: sha256(body) });
}

function normalizeSource(value, status) {
  if (status === "unknown" && (value === undefined || value === null)) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("source_type", "source is required for non-unknown cards.");
  const url = requiredString(value.url, 2000, "source.url");
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    fail("source_url_invalid", "source.url must be an absolute URL.");
  }
  if (parsed.protocol !== "https:") fail("source_url_https", "source.url must use HTTPS.");
  return {
    url: parsed.toString(),
    publisher: optionalString(value.publisher, 200, "source.publisher"),
    // publishedAt is source metadata that often arrives date-only; normalize
    // leniently to ISO (like the lab's normalizeIsoOrNull) instead of failing.
    publishedAt: normalizeLenientTime(value.publishedAt),
    fetchedAt: requiredTime(value.fetchedAt, "source.fetchedAt"),
    context: requiredString(value.context, 1000, "source.context"),
  };
}

function normalizeProof(value, status, cardId) {
  const proof = value && typeof value === "object" && !Array.isArray(value) ? value : { type: "none" };
  const type = requiredEnum(proof.type ?? "none", PROOF_TYPES, "proof.type");
  if ((status === "observed" || status === "explicit_absence" || status === "contradictory") && type === "none") {
    fail("proof_required", `Card ${cardId} with status "${status}" requires quote or screenshot proof; without proof the status is "unknown".`);
  }
  if (type === "quote") {
    return { type, quote: requiredString(proof.quote, 3000, "proof.quote") };
  }
  if (type === "screenshot") {
    const shot = proof.screenshot;
    if (!shot || typeof shot !== "object") fail("screenshot_record_required", "Screenshot proof needs a capture record.");
    return {
      type,
      screenshot: {
        file: requiredString(shot.file, 500, "proof.screenshot.file"),
        captureMethod: requiredEnum(shot.captureMethod, CAPTURE_METHODS, "proof.screenshot.captureMethod"),
        capturedAt: requiredTime(shot.capturedAt, "proof.screenshot.capturedAt"),
        sha256: isSha256(shot.sha256) ? shot.sha256 : fail("screenshot_hash_invalid", "proof.screenshot.sha256 must be a canonical sha256 hash of the captured file."),
      },
    };
  }
  return { type: "none" };
}

function normalizeLimitations(value) {
  const list = Array.isArray(value) ? value : [];
  if (list.length > 20) fail("limitations_count", "At most 20 limitations per card.");
  return list.map((item, index) => requiredString(item, 500, `limitations[${index}]`));
}

// Reliability, claim support, relevance, task-based UX notes, and visual
// preference are deliberately separate fields. There is no aggregate or
// universal "UX score" anywhere in this contract.
function normalizeAssessment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("assessment_type", "assessment is required.");
  if ("score" in value || "uxScore" in value) fail("universal_score_forbidden", "Aggregate UX scores are not part of this contract.");
  const uxHeuristics = Array.isArray(value.uxHeuristics)
    ? value.uxHeuristics.map((item, index) => ({
        heuristic: requiredString(item?.heuristic, 200, `assessment.uxHeuristics[${index}].heuristic`),
        task: requiredString(item?.task, 300, `assessment.uxHeuristics[${index}].task`),
        note: requiredString(item?.note, 1000, `assessment.uxHeuristics[${index}].note`),
      }))
    : [];
  return {
    sourceReliability: requiredEnum(value.sourceReliability, RELIABILITY, "assessment.sourceReliability"),
    claimSupport: requiredEnum(value.claimSupport, CLAIM_SUPPORT, "assessment.claimSupport"),
    relevance: requiredEnum(value.relevance, RELEVANCE, "assessment.relevance"),
    uxHeuristics,
    visualPreference: optionalString(value.visualPreference, 1000, "assessment.visualPreference"),
  };
}

export function normalizeCompetitor(input) {
  if (!input || typeof input !== "object") fail("competitor_type", "Competitor must be an object.");
  const rationale = input.rationale;
  if (!rationale || typeof rationale !== "object") fail("competitor_rationale", "Each competitor needs a classification rationale.");
  return {
    competitorId: requiredId(input.competitorId, "competitorId"),
    name: requiredString(input.name, 200, "competitor.name"),
    url: optionalString(input.url, 2000, "competitor.url"),
    rationale: {
      sharedProblem: requiredString(rationale.sharedProblem, 1000, "rationale.sharedProblem"),
      sharedAudience: requiredString(rationale.sharedAudience, 1000, "rationale.sharedAudience"),
      sharedJobs: (Array.isArray(rationale.sharedJobs) ? rationale.sharedJobs : []).map((job, index) => requiredString(job, 300, `rationale.sharedJobs[${index}]`)),
      featureOverlap: (Array.isArray(rationale.featureOverlap) ? rationale.featureOverlap : []).map((feature, index) => requiredString(feature, 300, `rationale.featureOverlap[${index}]`)),
    },
    accessLimitations: (Array.isArray(input.accessLimitations) ? input.accessLimitations : []).map((item, index) => requiredString(item, 500, `accessLimitations[${index}]`)),
  };
}

export function normalizeFeatureCell(value) {
  const status = requiredEnum(value?.status, EVIDENCE_STATUS, "featureMatrix.status");
  const cardIds = Array.isArray(value?.cardIds) ? value.cardIds.map((id) => requiredId(id, "featureMatrix.cardIds[]")) : [];
  if ((status === "observed" || status === "explicit_absence" || status === "contradictory") && !cardIds.length) {
    fail("matrix_cards_required", `A "${status}" matrix cell must reference at least one evidence card.`);
  }
  return { status, cardIds };
}

export function sealResearchPackage(input) {
  if (!input || typeof input !== "object") fail("package_type", "Research package input must be an object.");
  const cards = (Array.isArray(input.cards) ? input.cards : []).map(normalizeEvidenceCard);
  assertUnique(cards.map((card) => card.cardId), "cardId");
  const cardIds = new Set(cards.map((card) => card.cardId));
  const competitors = (Array.isArray(input.competitors) ? input.competitors : []).map(normalizeCompetitor);
  assertUnique(competitors.map((item) => item.competitorId), "competitorId");
  const subjectIds = new Set(competitors.map((item) => item.competitorId));
  const references = (Array.isArray(input.references) ? input.references : []).map(normalizeReference);
  assertUnique(references.map((item) => item.referenceId), "referenceId");
  for (const reference of references) subjectIds.add(reference.referenceId);
  for (const card of cards) {
    if (!subjectIds.has(card.subjectId)) fail("card_subject_unknown", `Card ${card.cardId} references unknown subject ${card.subjectId}.`);
  }
  const featureMatrix = (Array.isArray(input.featureMatrix) ? input.featureMatrix : []).map((row) => {
    const perCompetitor = {};
    for (const [competitorId, cell] of Object.entries(row?.perCompetitor || {})) {
      if (!subjectIds.has(competitorId)) fail("matrix_competitor_unknown", `Feature matrix references unknown competitor ${competitorId}.`);
      const normalized = normalizeFeatureCell(cell);
      for (const cardId of normalized.cardIds) {
        if (!cardIds.has(cardId)) fail("matrix_card_unknown", `Feature matrix cites unknown card ${cardId}.`);
      }
      perCompetitor[competitorId] = normalized;
    }
    return {
      featureId: requiredId(row?.featureId, "featureMatrix.featureId"),
      prdFeature: requiredString(row?.prdFeature, 500, "featureMatrix.prdFeature"),
      perCompetitor,
      ideas: (Array.isArray(row?.ideas) ? row.ideas : []).map((idea, index) => requiredString(idea, 800, `featureMatrix.ideas[${index}]`)),
    };
  });
  const brandConstraints = normalizeBrandConstraints(input.brandConstraints);
  const competitorIds = new Set(competitors.map((item) => item.competitorId));
  const referenceIds = new Set(references.map((item) => item.referenceId));
  const competitorRanking = normalizeRanking(input.competitorRanking, competitorIds);
  const referenceDistillation = normalizeDistillation(input.referenceDistillation, referenceIds, cardIds);
  const body = {
    $schema: "competitor-research-package/v1",
    runId: requiredId(input.runId, "runId"),
    prd: {
      prdId: requiredId(input.prd?.prdId, "prd.prdId"),
      title: requiredString(input.prd?.title, 300, "prd.title"),
      domain: requiredString(input.prd?.domain, 200, "prd.domain"),
      payloadHash: isSha256(input.prd?.payloadHash) ? input.prd.payloadHash : fail("prd_hash_invalid", "prd.payloadHash must be a canonical sha256 hash of the approved PRD."),
    },
    scope: {
      problem: requiredString(input.scope?.problem, 2000, "scope.problem"),
      audience: requiredString(input.scope?.audience, 1000, "scope.audience"),
      jobs: (Array.isArray(input.scope?.jobs) ? input.scope.jobs : []).map((job, index) => requiredString(job, 300, `scope.jobs[${index}]`)),
      featureScope: (Array.isArray(input.scope?.featureScope) ? input.scope.featureScope : []).map((item, index) => requiredString(item, 300, `scope.featureScope[${index}]`)),
    },
    brandConstraints,
    competitors,
    competitorRanking,
    references,
    referenceDistillation,
    featureMatrix,
    cards,
    accessLimitations: (Array.isArray(input.accessLimitations) ? input.accessLimitations : []).map((item, index) => requiredString(item, 800, `accessLimitations[${index}]`)),
    decisionRationales: (Array.isArray(input.decisionRationales) ? input.decisionRationales : []).map((item, index) => requiredString(item, 1500, `decisionRationales[${index}]`)),
    timing: normalizeTiming(input.timing),
    failures: (Array.isArray(input.failures) ? input.failures : []).map(normalizeFailure),
    createdAt: requiredTime(input.createdAt, "createdAt"),
  };
  const payloadHash = sha256(stableStringify(body));
  return Object.freeze({ ...body, payloadHash });
}

export function verifyResearchPackage(pkg) {
  const failures = [];
  try {
    if (!pkg || pkg.$schema !== "competitor-research-package/v1") failures.push("invalid_schema");
    const { payloadHash, ...body } = pkg || {};
    if (payloadHash !== sha256(stableStringify(body))) failures.push("payload_hash_mismatch");
    const resealed = sealResearchPackage(body);
    if (resealed.payloadHash !== payloadHash) failures.push("package_not_canonical");
    for (const card of pkg.cards || []) {
      const { cardHash, ...cardBody } = card;
      if (cardHash !== sha256(cardBody)) failures.push(`card_hash_mismatch:${card.cardId}`);
    }
  } catch (error) {
    failures.push(error.code || "package_invalid");
  }
  return { ok: failures.length === 0, failures };
}

export const FAILURE_KINDS = new Set([
  "source_unavailable",
  "app_only_evidence",
  "paywalled_source",
  "contradiction",
  "interrupted",
  "review_rejected",
]);

function normalizeFailure(value, index) {
  return {
    kind: requiredEnum(value?.kind, FAILURE_KINDS, `failures[${index}].kind`),
    detail: requiredString(value?.detail, 1000, `failures[${index}].detail`),
    subjectId: value?.subjectId ? requiredId(value.subjectId, `failures[${index}].subjectId`) : null,
  };
}

// Team rule (feedback-2026-09-05-1549, "client colors and fonts"): client-
// specified colors/fonts from the approved PRD take precedence over design-
// system defaults downstream. The research package carries them verbatim;
// reference recommendations must never overwrite them. Unspecified
// properties fall back to the selected system's defaults.
function normalizeBrandConstraints(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) fail("brand_constraints_type", "brandConstraints must be an object.");
  const entry = (item, key, label) => {
    if (typeof item === "string") return { role: null, [key]: requiredString(item, 300, label), note: null };
    return {
      role: optionalString(item?.role, 120, `${label}.role`),
      [key]: requiredString(item?.[key], 300, `${label}.${key}`),
      note: optionalString(item?.note, 500, `${label}.note`),
    };
  };
  const colors = (Array.isArray(value.colors) ? value.colors : []).map((item, index) => entry(item, "value", `brandConstraints.colors[${index}]`));
  const fonts = (Array.isArray(value.fonts) ? value.fonts : []).map((item, index) => entry(item, "family", `brandConstraints.fonts[${index}]`));
  if (!colors.length && !fonts.length) return null;
  return {
    source: "approved-prd",
    precedence: "client_values_override_design_system_defaults",
    unspecifiedProperties: "selected_system_defaults",
    colors,
    fonts,
    notes: optionalString(value.notes, 2000, "brandConstraints.notes"),
  };
}

// Stage-2 output (qa-round-2/qa7): AI holistic top-N ranking. Every entry
// must carry a recorded rationale — the audit trail for a non-reproducible
// judgment. Optional: an empty array means no ranking was produced.
function normalizeRanking(value, competitorIds) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  return list
    .map((item, index) => {
      const competitorId = requiredId(item?.competitorId, `competitorRanking[${index}].competitorId`);
      if (!competitorIds.has(competitorId)) fail("ranking_competitor_unknown", `Ranking references unknown competitor ${competitorId}.`);
      if (seen.has(competitorId)) fail("duplicate_id", "A competitor may appear once in the ranking.");
      seen.add(competitorId);
      const rank = Number(item?.rank);
      if (!Number.isInteger(rank) || rank < 1 || rank > 10) fail("rank_invalid", "rank must be an integer between 1 and 10.");
      return {
        competitorId,
        rank,
        rationale: requiredString(item?.rationale, 1500, `competitorRanking[${index}].rationale`),
      };
    })
    .sort((a, b) => a.rank - b.rank);
}

// Stage-3 output (qa-round-2/qa5): exactly three reference categories —
// style, layout, interaction — distilled from the top-ranked competitors.
// Optional (null) for packages produced before stage 3 runs.
export const DISTILLATION_CATEGORIES = new Set(["style", "layout", "interaction"]);

function normalizeDistillation(value, referenceIds, cardIds) {
  if (value === undefined || value === null) return null;
  const list = Array.isArray(value) ? value : fail("distillation_type", "referenceDistillation must be an array.");
  const seen = new Set();
  const categories = list.map((item, index) => {
    const category = requiredEnum(item?.category, DISTILLATION_CATEGORIES, `referenceDistillation[${index}].category`);
    if (seen.has(category)) fail("duplicate_id", "Each distillation category may appear once.");
    seen.add(category);
    const refs = (Array.isArray(item?.referenceIds) ? item.referenceIds : []).map((id) => requiredId(id, "distillation.referenceIds[]"));
    for (const id of refs) if (!referenceIds.has(id)) fail("distillation_reference_unknown", `Distillation cites unknown reference ${id}.`);
    const cards = (Array.isArray(item?.cardIds) ? item.cardIds : []).map((id) => requiredId(id, "distillation.cardIds[]"));
    for (const id of cards) if (!cardIds.has(id)) fail("distillation_card_unknown", `Distillation cites unknown card ${id}.`);
    if (!refs.length && !cards.length) fail("distillation_evidence_required", `Category "${category}" must cite at least one reference or evidence card.`);
    return {
      category,
      direction: requiredString(item?.direction, 2000, `referenceDistillation[${index}].direction`),
      referenceIds: refs,
      cardIds: cards,
      rationale: requiredString(item?.rationale, 1500, `referenceDistillation[${index}].rationale`),
    };
  });
  if (categories.length !== 3) fail("distillation_category_count", "referenceDistillation must contain exactly the three categories: style, layout, interaction.");
  return categories.sort((a, b) => a.category.localeCompare(b.category));
}

function normalizeReference(input) {
  return {
    referenceId: requiredId(input?.referenceId, "referenceId"),
    title: requiredString(input?.title, 300, "reference.title"),
    url: requiredString(input?.url, 2000, "reference.url"),
    kind: requiredEnum(input?.kind, new Set(["pattern_gallery", "article", "official_docs", "design_system", "case_study", "other"]), "reference.kind"),
    whyRelevant: requiredString(input?.whyRelevant, 1000, "reference.whyRelevant"),
  };
}

function normalizeTiming(value) {
  const startedAt = requiredTime(value?.startedAt, "timing.startedAt");
  const endedAt = requiredTime(value?.endedAt, "timing.endedAt");
  const elapsedMs = Date.parse(endedAt) - Date.parse(startedAt);
  if (elapsedMs < 0) fail("timing_invalid", "timing.endedAt must not precede timing.startedAt.");
  return { startedAt, endedAt, elapsedMs };
}

function normalizeLenientTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function requiredId(value, label) {
  const text = requiredString(value, 120, label);
  if (!ID.test(text)) fail("identifier_invalid", `${label} has an invalid format.`);
  return text;
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) fail("duplicate_id", `${label} values must be unique.`);
}
