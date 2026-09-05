import { draftFor, NOW } from "./fixtures.mjs";
import { sha256 } from "../lib/canonical.mjs";

export function comparisonFixture(count = 2) {
  const base = draftFor("habit");
  const features = Array.from({ length: count }, (_, i) => ({ featureId: `feat.requirement-${i + 1}`, name: `Requirement ${i + 1}`, description: `User must complete task ${i + 1} from the main screen.` }));
  const competitors = Array.from({ length: 3 }, (_, i) => ({ ...base.competitors[0], competitorId: `comp.product-${i + 1}`, name: `Fixture product ${i + 1}`, url: `https://product-${i + 1}.example.com` }));
  const cards = competitors.flatMap(c => features.map(f => ({ ...base.cards[0], cardId: `card.${c.competitorId}.${f.featureId}`, subjectId: c.competitorId, featureId: f.featureId, observationType: "marketing_description", claim: `${c.name} documents ${f.name}.`, source: { url: c.url, fetchedAt: NOW, context: f.name }, proof: { type: "quote", quote: `${c.name} supports ${f.name}.` } })));
  const prd = { $schema: "approved-prd/v1", prdId: "prd.comparison-fixture", title: "Deterministic feature comparison", domain: "test", problem: base.scope.problem, audience: base.scope.audience, coreTasks: base.scope.jobs, features };
  const draft = { ...base, competitors, cards, competitorRanking: competitors.map((c, i) => ({ competitorId: c.competitorId, rank: i + 1, rationale: "Direct feature evidence supports comparison." })), featureMatrix: features.map(f => ({ featureId: f.featureId, prdFeature: f.name, perCompetitor: Object.fromEntries(competitors.map(c => [c.competitorId, { status: "observed", cardIds: cards.filter(card => card.subjectId === c.competitorId && card.featureId === f.featureId).map(card => card.cardId) }])), ideas: ["Keep the core task on the main screen."] })) };
  return { prd, draft, input: { ...draft, runId: "run-comparison-fixture", prd: { ...prd, payloadHash: sha256(prd) } } };
}
