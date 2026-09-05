import { fail } from "./canonical.mjs";

export function assertCompetitors(competitors, count = 3) {
  if (!Array.isArray(competitors) || competitors.length !== count) fail("comparison_incomplete", `Research incomplete: exactly ${count} competitors are required; reselect before analysis.`);
  for (const key of ["competitorId", "name", "url"]) {
    const values = competitors.map((c) => {
      if (typeof c[key] !== "string" || !c[key].trim()) fail("competitor_identity", `Missing competitor ${key}.`);
      if (key !== "url") return c[key].trim().toLowerCase();
      let url;
      try { url = new URL(c.url); } catch { fail("competitor_identity", "Competitor needs a public HTTPS URL."); }
      if (url.protocol !== "https:") fail("competitor_identity", "Competitor needs a public HTTPS URL.");
      return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`;
    });
    if (new Set(values).size !== count) fail("duplicate_competitor", `Duplicate competitor ${key}; reselect before analysis.`);
  }
}

export function assertFeatures(features) {
  if (!Array.isArray(features) || !features.length) fail("comparison_legacy", "Approved PRD features are required; legacy research must be explicitly re-collected/migrated.");
  const ids = features.map((f) => f.featureId);
  if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) fail("comparison_features", "PRD feature IDs must be present and unique.");
}

export function assertRanking(ranking, competitors) {
  if (!Array.isArray(ranking) || ranking.length !== 3 || new Set(ranking.map((r) => r.competitorId)).size !== 3 ||
      ranking.some((r) => !competitors.some((c) => c.competitorId === r.competitorId)) ||
      ranking.map((r) => r.rank).sort().join(",") !== "1,2,3") fail("comparison_ranking", "Ranking must cover the selected three competitors at ranks 1, 2, 3.");
}

// Structural linkage is checked here; semantic support remains the AI audit's
// responsibility, and exact source quotes are independently re-fetched.
export function assertComparison(input, features = input.prd?.features, { requireEvidence = true } = {}) {
  assertFeatures(features);
  assertCompetitors(input.competitors);
  const competitorIds = input.competitors.map((c) => c.competitorId);
  const featureIds = new Set(features.map((f) => f.featureId));
  const rows = input.featureMatrix;
  if (!Array.isArray(rows) || rows.length !== features.length || new Set(rows.map((r) => r.featureId)).size !== features.length || rows.some((r) => !featureIds.has(r.featureId))) fail("comparison_features", "Matrix must cover every approved PRD feature ID exactly once, with no foreign IDs.");
  const cards = new Map();
  for (const card of input.cards || []) {
    if (cards.has(card.cardId)) fail("duplicate_id", "Duplicate evidence card ID.");
    cards.set(card.cardId, card);
    if (card.subjectType === "competitor" && (!competitorIds.includes(card.subjectId) || !featureIds.has(card.featureId))) fail("comparison_card_link", "Competitor evidence must name the selected competitor and an exact PRD feature ID.");
    if (card.subjectType === "competitor" && !["product_behavior", "product_documentation", "marketing_description", "unknown"].includes(card.observationType)) fail("comparison_observation_type", "Competitor cards must distinguish product behavior, documentation, marketing, and unknown evidence.");
  }
  for (const row of rows) {
    const keys = Object.keys(row.perCompetitor || {});
    if (keys.length !== 3 || keys.some((id) => !competitorIds.includes(id))) fail("comparison_columns", "Every matrix row must have exactly the selected competitor columns.");
    for (const [id, cell] of Object.entries(row.perCompetitor)) {
      const links = cell.cardIds || [];
      if (new Set(links).size !== links.length) fail("comparison_duplicate_cell", "Duplicate evidence link in a matrix cell.");
      if (!["observed", "explicit_absence", "unknown", "contradictory"].includes(cell.status) || (cell.status !== "unknown" && !links.length)) fail("matrix_cards_required", "Non-unknown cells require supporting evidence.");
      for (const cardId of links) {
        const card = cards.get(cardId);
        if (!card || card.subjectType !== "competitor" || card.subjectId !== id || card.featureId !== row.featureId || card.status !== cell.status) fail("comparison_card_link", "Matrix evidence must support this competitor, feature, and status.");
      }
    }
  }
  if (requireEvidence) for (const id of competitorIds) {
    if (!rows.some((row) => row.perCompetitor[id].status !== "unknown" && row.perCompetitor[id].cardIds.some((cardId) => {
      const card = cards.get(cardId);
      return card.source?.url && ["quote", "screenshot"].includes(card.proof?.type) && card.assessment?.relevance === "high" && card.assessment?.claimSupport === "direct";
    }))) fail("comparison_incomplete", `Research incomplete: ${id} has no directly supported, relevant PRD-feature evidence.`);
  }
  assertRanking(input.competitorRanking, input.competitors);
}
