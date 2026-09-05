// Supplemental Claude Dynamic Workflow: replace a defunct competitor.
// args: { prd, nowIso, excludeNames: string[], count: number }
// Finds `count` live competitors (excluding the given names), then runs one
// observation lane per new competitor with the same evidence rules as the
// main workflow. Returns { competitors, cards, failures, accessLimitations }.

export const meta = {
  name: 'competitor-replacement',
  description: 'Find live replacement competitors and collect their evidence cards',
  phases: [
    { title: 'Find', detail: 'verify live replacement competitors' },
    { title: 'Observe', detail: 'one evidence lane per new competitor' },
  ],
}

const { prd, nowIso, excludeNames, count } = args
if (!prd || !nowIso || !count) throw new Error('args.prd, args.nowIso, args.count are required')

const EVIDENCE_RULES = `
EVIDENCE RULES (mandatory):
- Only free, public HTTPS sources. NEVER bypass paywalls, log in, or purchase anything. Record inaccessible evidence in failures (kind "paywalled_source" or "app_only_evidence") instead of inventing findings.
- Every "observed", "explicit_absence", or "contradictory" card needs proof.type "quote" with an EXACT verbatim quote copied from the fetched page text (1-2 sentences). The quote is later machine-checked against a re-fetch of source.url; paraphrases fail and get downgraded. Do NOT claim screenshots.
- "explicit_absence" requires a quote explicitly supporting the absence. Failing to find a feature is "unknown", never absence.
- "unknown" cards may have proof {type:"none"} and source null; explain in limitations what was searched.
- source.fetchedAt is the ISO UTC time you fetched the page; source.context locates the quote on the page.
- assessment axes are separate: sourceReliability, claimSupport, relevance, optional task-based uxHeuristics [{heuristic, task, note}], optional visualPreference. NEVER output a numeric or aggregate UX score.
- Card ids: lowercase dot-separated, e.g. "card.comp-x.rsvp-1".`

const CARD_SCHEMA = {
  type: 'object',
  required: ['cardId', 'subjectType', 'subjectId', 'status', 'claim', 'proof', 'limitations', 'assessment'],
  properties: {
    cardId: { type: 'string' },
    subjectType: { enum: ['competitor'] },
    subjectId: { type: 'string' },
    status: { enum: ['observed', 'explicit_absence', 'unknown', 'contradictory'] },
    claim: { type: 'string' },
    source: { type: ['object', 'null'], properties: { url: { type: 'string' }, publisher: { type: ['string', 'null'] }, publishedAt: { type: ['string', 'null'] }, fetchedAt: { type: 'string' }, context: { type: 'string' } } },
    proof: { type: 'object', required: ['type'], properties: { type: { enum: ['quote', 'none'] }, quote: { type: 'string' } } },
    limitations: { type: 'array', items: { type: 'string' } },
    assessment: {
      type: 'object',
      required: ['sourceReliability', 'claimSupport', 'relevance'],
      properties: {
        sourceReliability: { enum: ['high', 'medium', 'low'] },
        claimSupport: { enum: ['direct', 'indirect', 'none'] },
        relevance: { enum: ['high', 'medium', 'low'] },
        uxHeuristics: { type: 'array', items: { type: 'object', required: ['heuristic', 'task', 'note'], properties: { heuristic: { type: 'string' }, task: { type: 'string' }, note: { type: 'string' } } } },
        visualPreference: { type: ['string', 'null'] },
      },
    },
  },
}

const FAILURE_SCHEMA = {
  type: 'object',
  required: ['kind', 'detail'],
  properties: {
    kind: { enum: ['source_unavailable', 'app_only_evidence', 'paywalled_source', 'contradiction', 'interrupted', 'review_rejected'] },
    detail: { type: 'string' },
    subjectId: { type: ['string', 'null'] },
  },
}

phase('Find')
const found = await agent(
  `Current time: ${nowIso}. Find exactly ${count} real, CURRENTLY LIVE competitor products for this PRD, excluding: ${JSON.stringify(excludeNames)}.
PRD problem: ${prd.problem}
PRD audience: ${prd.audience}
Domain: ${prd.domain}

Requirements: each competitor must share the same user problem AND audience, and have a public HTTPS website that you have ACTUALLY verified is reachable right now with WebFetch (fetch the homepage and confirm real product content loads — a domain-parking page, error page, or JS-only empty shell does not count). Korean-market products preferred given the audience. For each, return competitorId ("comp.<slug>"), name, url, rationale {sharedProblem, sharedAudience, sharedJobs, featureOverlap}, accessLimitations. Do not reuse excluded names.`,
  {
    label: 'find-live-competitors',
    phase: 'Find',
    model: 'sonnet',
    effort: 'medium',
    schema: {
      type: 'object',
      required: ['competitors'],
      properties: {
        competitors: {
          type: 'array',
          items: {
            type: 'object',
            required: ['competitorId', 'name', 'url', 'rationale'],
            properties: {
              competitorId: { type: 'string' }, name: { type: 'string' }, url: { type: 'string' },
              rationale: {
                type: 'object',
                required: ['sharedProblem', 'sharedAudience', 'sharedJobs', 'featureOverlap'],
                properties: {
                  sharedProblem: { type: 'string' }, sharedAudience: { type: 'string' },
                  sharedJobs: { type: 'array', items: { type: 'string' } },
                  featureOverlap: { type: 'array', items: { type: 'string' } },
                },
              },
              accessLimitations: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        failures: { type: 'array', items: FAILURE_SCHEMA },
      },
    },
  },
)
if (!found || !found.competitors.length) throw new Error('no live replacement competitors found')
log(`live competitors: ${found.competitors.map(c => c.name).join(', ')}`)

const featureList = prd.features.map(f => `- ${f.featureId}: ${f.name} — ${f.description}`).join('\n')
const results = await pipeline(
  found.competitors.slice(0, count),
  competitor => agent(
    `You are a competitor-observation lane. Current time: ${nowIso}.
Competitor: ${JSON.stringify(competitor, null, 2)}
PRD features to check:
${featureList}

Using WebFetch on the competitor's public HTTPS pages (start at ${competitor.url}; follow feature/pricing/help/guide pages), collect evidence of how this competitor implements each PRD feature. One card per feature where you found or explicitly ruled out support, plus "unknown" cards for unconfirmed features. subjectType "competitor", subjectId "${competitor.competitorId}". Distinguish observed interactions from marketing claims in limitations. 3-8 cards.
${EVIDENCE_RULES}
Also return failures for anything inaccessible.`,
    {
      label: `observe:${competitor.competitorId}`,
      phase: 'Observe',
      model: 'sonnet',
      effort: 'medium',
      schema: {
        type: 'object',
        required: ['cards'],
        properties: {
          cards: { type: 'array', items: CARD_SCHEMA },
          failures: { type: 'array', items: FAILURE_SCHEMA },
          accessLimitations: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  ),
)

const lanes = results.filter(Boolean)
return {
  competitors: found.competitors.slice(0, count),
  cards: lanes.flatMap(lane => lane.cards || []),
  failures: [...(found.failures || []), ...lanes.flatMap(lane => lane.failures || [])],
  accessLimitations: lanes.flatMap(lane => lane.accessLimitations || []),
}
