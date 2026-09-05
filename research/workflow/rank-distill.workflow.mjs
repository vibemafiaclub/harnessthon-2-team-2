// Supplemental Claude Dynamic Workflow: retrofit stage-2 ranking and stage-3
// reference distillation (qa-round-2 restructure) onto an existing research
// draft. args: { nowIso, prd: {domain, coreTasks}, competitors, cards,
// existingReferences } — competitors/cards from the draft package.

export const meta = {
  name: 'rank-distill',
  description: 'Rank competitors (top 3, with rationale) and distill style/layout/interaction reference directions',
  phases: [
    { title: 'Rank', detail: 'holistic top-3 ranking with recorded rationale' },
    { title: 'Distill', detail: 'three reference categories from the top 3' },
  ],
}

// args: { nowIso, prd, competitors, cards, featureMatrix, existingReferences }.
// Legacy file-only callers must pass full data for runtime validation.
const { nowIso } = args
if (!nowIso) throw new Error('args.nowIso is required')


// Runtime guard: model schemas alone do not bound paid observation lanes.
function assertSelected(list, expected = 3) {
  if (!Array.isArray(list) || list.length !== expected) throw new Error('Research incomplete: expected exactly ' + expected + ' selected competitors; reselect before observation')
  for (const key of ['competitorId', 'name', 'url']) {
    const values = list.map(c => String(c[key] || '').trim().toLowerCase().replace(/^https:\/\/(www\.)?/, '').replace(/\/+$/, ''))
    if (values.some(v => !v) || new Set(values).size !== expected) throw new Error('Research incomplete: duplicate or missing competitor ' + key)
  }
  if (list.some(c => !/^https:\/\//.test(c.url))) throw new Error('Research incomplete: competitor URLs must be HTTPS')
}

// Validate reused data before rank/distillation agent calls.
const { competitors, prd, cards, featureMatrix } = args
assertSelected(competitors)
if (!prd?.features?.length || new Set(prd.features.map(f => f.featureId)).size !== prd.features.length || !Array.isArray(featureMatrix) || featureMatrix.length !== prd.features.length || new Set(featureMatrix.map(r => r.featureId)).size !== prd.features.length || featureMatrix.some(r => !prd.features.some(f => f.featureId === r.featureId) || Object.keys(r.perCompetitor || {}).length !== 3 || Object.keys(r.perCompetitor).some(id => !competitors.some(c => c.competitorId === id)))) throw new Error('Research incomplete: legacy input needs full PRD-feature comparison migration')
if (!Array.isArray(cards) || cards.some(c => c.subjectType === 'competitor' && (!prd.features.some(f => f.featureId === c.featureId) || !competitors.some(p => p.competitorId === c.subjectId)))) throw new Error('Research incomplete: evidence linkage missing')
for (const row of featureMatrix) for (const [id, cell] of Object.entries(row.perCompetitor)) {
  if (new Set(cell.cardIds || []).size !== (cell.cardIds || []).length || (cell.status !== 'unknown' && !cell.cardIds?.length) || (cell.cardIds || []).some(cardId => !cards.some(c => c.cardId === cardId && c.subjectType === 'competitor' && c.subjectId === id && c.featureId === row.featureId && c.status === cell.status))) throw new Error('Research incomplete: competitor-feature evidence mismatch')
}
for (const competitor of competitors) {
  if (!featureMatrix.some(row => row.perCompetitor[competitor.competitorId].status !== 'unknown' && row.perCompetitor[competitor.competitorId].cardIds.some(id => cards.some(c => c.cardId === id && c.proof?.type === 'quote' && c.source?.url && c.assessment?.claimSupport === 'direct' && c.assessment?.relevance === 'high')))) throw new Error('Research incomplete: insufficient relevant competitor evidence')
}
phase('Rank')
const ranked = await agent(
  `You are the competitor-ranking step of stage 2 (autonomous). Current time: ${nowIso}.
Use ONLY this runtime-checked input; no web access:
${JSON.stringify({ prd, competitors, cards, featureMatrix, existingReferences: args.existingReferences || [] })}

Rank the competitors (cards with subjectType "competitor" are their evidence) holistically — evidence coverage (observed vs unknown per PRD feature), feature similarity to the PRD, and value as a design reference. Return competitorRanking: one entry per competitor {competitorId, rank starting at 1, rationale}. The rationale (1-2 sentences, grounded in the cards, no hidden reasoning) is mandatory: the top 3 drive reference distillation.`,
  {
    label: 'rank-top3',
    phase: 'Rank',
    model: 'sonnet',
    effort: 'medium',
    schema: {
      type: 'object',
      required: ['competitorRanking'],
      properties: {
        competitorRanking: {
          type: 'array',
          items: {
            type: 'object',
            required: ['competitorId', 'rank', 'rationale'],
            properties: { competitorId: { type: 'string' }, rank: { type: 'integer' }, rationale: { type: 'string' } },
          },
        },
      },
    },
  },
)
if (!ranked) throw new Error('ranking failed')
const ranking = [...ranked.competitorRanking].sort((a, b) => a.rank - b.rank)
if (ranking.length !== 3 || new Set(ranking.map(r => r.competitorId)).size !== 3 || ranking.some(r => !competitors.some(c => c.competitorId === r.competitorId)) || ranking.map(r => r.rank).join(',') !== '1,2,3') throw new Error('Research incomplete: ranking must cover the selected three')
const topThree = ranking
log(`top-3: ${topThree.map(r => r.competitorId).join(' > ')}`)

phase('Distill')
const distilled = await agent(
  `You are the reference-distillation stage (stage 3, autonomous). Current time: ${nowIso}.
Input:
${JSON.stringify({ prd, competitors, cards, existingReferences: args.existingReferences || [] })}
Top-3 competitors from stage 2 (reference selection depends on this ranking; use only their supplied cards):
${JSON.stringify(topThree, null, 2)}
You may cite supplied existingReferences ids in referenceIds.

Tasks:
1. Optionally add 0-3 NEW free public references that deepen what the top-3 evidence shows (WebSearch + WebFetch; paid libraries like Mobbin are OFF-LIMITS; record paywalls as failures). Each new reference: {referenceId: "ref.<slug>", title, url (https), kind (pattern_gallery|article|official_docs|design_system|case_study|other), whyRelevant} plus 1 evidence card (subjectType "reference", subjectId = referenceId) with an EXACT verbatim quote copied from the fetched page (it will be machine-verified against a re-fetch; paraphrases fail). "observed" cards need quote proofs; unknown cards use proof {type:"none"}.
BRAND CONSTRAINT RULE: if the input file's prd carries brandConstraints (client-specified colors/fonts), they are fixed constraints — the "style" direction must recommend WITHIN them and never propose replacing them; unspecified properties defer to the selected design system's defaults.
2. Distill EXACTLY three reference categories from the top-3 evidence plus references — "style" (visual direction), "layout" (screen structure/hierarchy), "interaction" (task/interaction patterns). Each: {category, direction (2-4 sentence synthesis), referenceIds (existing or new reference ids), cardIds (ids that exist in the inputs or your new cards), rationale (grounded in top-3 evidence)}. Each category must cite at least one reference or card. Keep visual taste separate from task-based UX reasoning; no numeric scores.`,
  {
    label: 'distill-references',
    phase: 'Distill',
    model: 'sonnet',
    effort: 'medium',
    schema: {
      type: 'object',
      required: ['references', 'cards', 'referenceDistillation'],
      properties: {
        references: {
          type: 'array',
          items: {
            type: 'object',
            required: ['referenceId', 'title', 'url', 'kind', 'whyRelevant'],
            properties: {
              referenceId: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' },
              kind: { enum: ['pattern_gallery', 'article', 'official_docs', 'design_system', 'case_study', 'other'] },
              whyRelevant: { type: 'string' },
            },
          },
        },
        cards: { type: 'array' },
        referenceDistillation: {
          type: 'array', minItems: 3, maxItems: 3,
          items: {
            type: 'object',
            required: ['category', 'direction', 'referenceIds', 'cardIds', 'rationale'],
            properties: {
              category: { enum: ['style', 'layout', 'interaction'] },
              direction: { type: 'string' },
              referenceIds: { type: 'array', items: { type: 'string' } },
              cardIds: { type: 'array', items: { type: 'string' } },
              rationale: { type: 'string' },
            },
          },
        },
        failures: { type: 'array' },
        accessLimitations: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)
if (!distilled) throw new Error('distillation failed')
log(`distilled 3 categories, ${distilled.references.length} new references`)

return { competitorRanking: ranking, ...distilled }
