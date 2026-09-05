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

// args: { nowIso, inputFile } — inputFile is a JSON file holding
// { prd: {domain, coreTasks}, competitors, cards, existingReferences }.
// The script cannot read files; each agent Reads the file itself.
const { nowIso, inputFile } = args
if (!nowIso || !inputFile) throw new Error('args.nowIso and args.inputFile are required')

phase('Rank')
const ranked = await agent(
  `You are the competitor-ranking step of stage 2 (autonomous). Current time: ${nowIso}.
First use the Read tool on ${inputFile} — it holds { prd, competitors, cards, existingReferences }. Use ONLY that data; no web access.

Rank the competitors (cards with subjectType "competitor" are their evidence) holistically — evidence coverage (observed vs unknown per PRD feature), feature similarity to the PRD, and value as a design reference. Return competitorRanking: one entry per competitor {competitorId, rank starting at 1, rationale}. The rationale (1-2 sentences, grounded in the cards, no hidden reasoning) is mandatory: the top 3 drive reference distillation.`,
  {
    label: 'rank-top3',
    phase: 'Rank',
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
const topThree = ranking.slice(0, 3)
log(`top-3: ${topThree.map(r => r.competitorId).join(' > ')}`)

phase('Distill')
const distilled = await agent(
  `You are the reference-distillation stage (stage 3, autonomous). Current time: ${nowIso}.
First use the Read tool on ${inputFile} — it holds { prd, competitors, cards, existingReferences }.
Top-3 competitors from stage 2 (reference selection depends on this ranking; use only their cards from the file):
${JSON.stringify(topThree, null, 2)}
You may cite existingReferences ids from the file in referenceIds.

Tasks:
1. Optionally add 0-3 NEW free public references that deepen what the top-3 evidence shows (WebSearch + WebFetch; paid libraries like Mobbin are OFF-LIMITS; record paywalls as failures). Each new reference: {referenceId: "ref.<slug>", title, url (https), kind (pattern_gallery|article|official_docs|design_system|case_study|other), whyRelevant} plus 1 evidence card (subjectType "reference", subjectId = referenceId) with an EXACT verbatim quote copied from the fetched page (it will be machine-verified against a re-fetch; paraphrases fail). "observed" cards need quote proofs; unknown cards use proof {type:"none"}.
BRAND CONSTRAINT RULE: if the input file's prd carries brandConstraints (client-specified colors/fonts), they are fixed constraints — the "style" direction must recommend WITHIN them and never propose replacing them; unspecified properties defer to the selected design system's defaults.
2. Distill EXACTLY three reference categories from the top-3 evidence plus references — "style" (visual direction), "layout" (screen structure/hierarchy), "interaction" (task/interaction patterns). Each: {category, direction (2-4 sentence synthesis), referenceIds (existing or new reference ids), cardIds (ids that exist in the inputs or your new cards), rationale (grounded in top-3 evidence)}. Each category must cite at least one reference or card. Keep visual taste separate from task-based UX reasoning; no numeric scores.`,
  {
    label: 'distill-references',
    phase: 'Distill',
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
