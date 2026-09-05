// Claude Dynamic Workflow: competitor research + reference checking.
// Invoked with Workflow({scriptPath: this file, args: {prd, nowIso}}).
// The script has no filesystem access; it returns a research DRAFT that the
// main session persists and seals via research/bin/assemble-run.mjs (which
// also re-verifies every quote against the live source before human review).

export const meta = {
  name: 'competitor-reference-research',
  description: 'Research competitors and references for an approved PRD, with evidence cards and a convergence check',
  phases: [
    { title: 'Scope', detail: 'confirm research scope and classify competitor candidates' },
    { title: 'Research', detail: 'parallel competitor observation lanes (autonomous)' },
    { title: 'Converge', detail: 'status/contradiction audit, feature matrix, top-3 ranking with rationale' },
    { title: 'Distill', detail: 'distill style/layout/interaction reference directions from the top 3' },
  ],
}

const prd = args.prd
const nowIso = args.nowIso
if (!prd || !nowIso) throw new Error('args.prd and args.nowIso are required')

const EVIDENCE_RULES = `
EVIDENCE RULES (mandatory):
- Only free, public HTTPS sources. NEVER bypass paywalls, log in, or purchase anything. If key evidence sits behind a paywall or inside an app you cannot observe, record it in accessLimitations/failures (kind "paywalled_source" or "app_only_evidence") instead of inventing findings.
- Every "observed", "explicit_absence", or "contradictory" card needs proof.type "quote" with an EXACT verbatim quote (copy the sentence exactly as it appears in the fetched page text, 1-2 sentences). The quote will later be machine-checked against a re-fetch of source.url; a paraphrase will fail verification and downgrade the card. Do NOT invent screenshots; proof.type "screenshot" is forbidden for you.
- "explicit_absence" requires a quote that explicitly supports the absence (e.g. pricing/FAQ saying the feature is not offered). Failing to find a feature is "unknown", never absence.
- status "unknown" cards may have proof.type "none" and source null; explain in limitations what was searched and why it stayed unknown.
- source.fetchedAt is the ISO UTC time you actually fetched the page; source.context says where on the page/site the quote sits.
- assessment fields are separate axes: sourceReliability (high|medium|low), claimSupport (direct|indirect|none), relevance (high|medium|low), optional task-based uxHeuristics [{heuristic, task, note}], optional visualPreference (a taste note, distinct from reliability). NEVER output any numeric or aggregate UX score.
- Card ids: lowercase, dot-separated, e.g. "card.comp-a.rsvp-1".`

const CARD_SCHEMA = {
  type: 'object',
  required: ['cardId', 'subjectType', 'subjectId', 'status', 'claim', 'proof', 'limitations', 'assessment'],
  properties: {
    cardId: { type: 'string' },
    subjectType: { enum: ['competitor', 'reference'] },
    subjectId: { type: 'string' },
    status: { enum: ['observed', 'explicit_absence', 'unknown', 'contradictory'] },
    claim: { type: 'string' },
    source: {
      type: ['object', 'null'],
      properties: {
        url: { type: 'string' }, publisher: { type: ['string', 'null'] }, publishedAt: { type: ['string', 'null'] },
        fetchedAt: { type: 'string' }, context: { type: 'string' },
      },
    },
    proof: {
      type: 'object',
      required: ['type'],
      properties: { type: { enum: ['quote', 'none'] }, quote: { type: 'string' } },
    },
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

phase('Scope')
const scoped = await agent(
  `You are the scope-confirmation stage of a competitor-research workflow. Current time: ${nowIso}.
Approved PRD (JSON):
${JSON.stringify(prd, null, 2)}

Tasks:
1. Extract the research scope: problem, audience, jobs (from coreTasks), featureScope (from features).
2. Identify exactly 3 real, currently existing competitor products that share the same user problem AND audience. Use WebSearch to confirm they exist and have public HTTPS websites. For each, give the classification rationale (sharedProblem, sharedAudience, sharedJobs, featureOverlap) and known access limitations (e.g. app-only screens, paywalled galleries). Prefer competitors with substantial public web pages describing their features (their evidence will be quote-verified against those pages).
3. List 2-3 planned free evidence source types for references (pattern galleries, articles, official docs) relevant to this domain, with a short note on any paid libraries you are deliberately NOT using.
Competitor ids: "comp.<short-slug>". Do not fabricate products; if you cannot confirm a competitor exists, pick another.`,
  {
    label: 'scope+classify',
    phase: 'Scope',
    schema: {
      type: 'object',
      required: ['scope', 'competitors', 'referencePlan'],
      properties: {
        scope: {
          type: 'object',
          required: ['problem', 'audience', 'jobs', 'featureScope'],
          properties: {
            problem: { type: 'string' }, audience: { type: 'string' },
            jobs: { type: 'array', items: { type: 'string' } },
            featureScope: { type: 'array', items: { type: 'string' } },
          },
        },
        competitors: {
          type: 'array', minItems: 1, maxItems: 3,
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
        referencePlan: { type: 'array', items: { type: 'string' } },
        notUsedPaidSources: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)
if (!scoped) throw new Error('scope stage failed')
log(`scope confirmed: ${scoped.competitors.length} competitors — ${scoped.competitors.map(c => c.name).join(', ')}`)

phase('Research')
const featureList = prd.features.map(f => `- ${f.featureId}: ${f.name} — ${f.description}`).join('\n')
const lanes = [
  ...scoped.competitors.map(competitor => () =>
    agent(
      `You are a competitor-observation lane. Current time: ${nowIso}.
Competitor: ${JSON.stringify(competitor, null, 2)}
PRD features to check:
${featureList}

Using WebFetch on the competitor's public HTTPS pages (start at ${competitor.url}; follow feature/pricing/help pages), collect evidence of how this competitor implements each PRD feature. Produce one evidence card per feature where you found or explicitly ruled out support, plus "unknown" cards for features you could not confirm. subjectType "competitor", subjectId "${competitor.competitorId}". Distinguish an observed interaction/description from a marketing claim in the card's limitations. 3-8 cards total.
${EVIDENCE_RULES}
Also return failures for anything you could not access (kind source_unavailable / app_only_evidence / paywalled_source).`,
      {
        label: `observe:${competitor.competitorId}`,
        phase: 'Research',
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
    )),
]
// Barrier is intentional: convergence needs every lane's cards at once.
// Per team direction (research/decisions/qa-round-2.json), reference work is
// no longer an independent parallel lane: it consumes the top-3 competitor
// ranking, so it runs AFTER Converge as the Distill phase.
const laneResults = (await parallel(lanes)).filter(Boolean)
const allCards = laneResults.flatMap(result => result.cards || [])
const allFailures = laneResults.flatMap(result => result.failures || [])
const allLimitations = laneResults.flatMap(result => result.accessLimitations || [])
log(`competitor lanes done: ${allCards.length} cards, ${allFailures.length} failures`)

phase('Converge')
const converged = await agent(
  `You are the convergence/consistency stage of a competitor-research workflow. Current time: ${nowIso}. You have NO web access needs; work only on the data below.

PRD features:
${featureList}
Competitors: ${JSON.stringify(scoped.competitors.map(c => ({ competitorId: c.competitorId, name: c.name })))}
Evidence cards from all lanes:
${JSON.stringify(allCards, null, 2)}

Tasks (do NOT invent new evidence, do NOT alter any quote text):
1. Audit each card's status against the taxonomy: "observed"/"explicit_absence"/"contradictory" require a quote proof; absence requires the quote to explicitly support absence. Downgrade violating cards to "unknown" (drop the proof to {type:"none"}, keep the source, add a limitation explaining the downgrade). "Not found" is never absence.
2. Detect contradictions: if two cards about the same competitor+feature conflict, set both to "contradictory" and add a failure {kind:"contradiction", detail, subjectId}.
3. Deduplicate cards with identical claims; keep the better-sourced one.
4. Build the feature matrix: one row per PRD feature (featureId, prdFeature = feature name), perCompetitor map {competitorId: {status, cardIds}} — cardIds may only cite surviving cards; cells with no supporting card are {"status":"unknown","cardIds":[]}. Add 1-3 "ideas" per row: useful ideas or differentiation candidates grounded in the evidence.
5. Write 2-5 decisionRationales: concise, evidence-grounded rationales and lessons from this run (no hidden reasoning, no chain of thought — short conclusions only).
6. Rank the competitors holistically (evidence coverage, feature similarity to the PRD, value as a design reference) and return competitorRanking: one entry per competitor {competitorId, rank starting at 1, rationale} — the rationale is one or two sentences grounded in the evidence, and is mandatory: the top 3 of this ranking drive the reference-distillation stage.`,
  {
    label: 'converge+matrix+rank',
    phase: 'Converge',
    schema: {
      type: 'object',
      required: ['cards', 'featureMatrix', 'decisionRationales', 'competitorRanking'],
      properties: {
        cards: { type: 'array', items: CARD_SCHEMA },
        featureMatrix: {
          type: 'array',
          items: {
            type: 'object',
            required: ['featureId', 'prdFeature', 'perCompetitor'],
            properties: {
              featureId: { type: 'string' }, prdFeature: { type: 'string' },
              perCompetitor: { type: 'object' },
              ideas: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        failures: { type: 'array', items: FAILURE_SCHEMA },
        decisionRationales: { type: 'array', items: { type: 'string' } },
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
if (!converged) throw new Error('convergence stage failed')
const ranking = [...converged.competitorRanking].sort((a, b) => a.rank - b.rank)
const topThree = ranking.slice(0, 3)
log(`converged: ${converged.cards.length} cards, top-3 = ${topThree.map(r => r.competitorId).join(' > ')}`)

phase('Distill')
const topCards = converged.cards.filter(card => topThree.some(r => r.competitorId === card.subjectId))
const distilled = await agent(
  `You are the reference-distillation stage (stage 3). Current time: ${nowIso}.
PRD domain: ${prd.domain}. Core tasks: ${prd.coreTasks.join('; ')}.
Top-3 competitors from stage 2 (your ONLY competitor inputs — reference selection depends on this ranking):
${JSON.stringify(topThree, null, 2)}
Their evidence cards:
${JSON.stringify(topCards, null, 2)}
Reference source plan from scope: ${JSON.stringify(scoped.referencePlan)}

Tasks:
1. Using WebSearch + WebFetch, find 3-6 FREE public references (pattern write-ups, official docs, design systems, case studies) that deepen what the top-3 evidence shows. Paid libraries (Mobbin and similar) are OFF-LIMITS; free-tier candidates to try (verify free access at fetch time; record paywalls as failures instead of proceeding): UX Archive, Collect UI, Screenlane, Pttrns, Page Flows (free portion only). Each reference: {referenceId: "ref.<slug>", title, url (https), kind (pattern_gallery|article|official_docs|design_system|case_study|other), whyRelevant} plus 1-2 evidence cards (subjectType "reference", subjectId = referenceId) with exact quotes.
BRAND CONSTRAINT RULE: the approved PRD's client-specified colors/fonts are fixed constraints${prd.brandConstraints ? `: ${JSON.stringify(prd.brandConstraints)}` : ' (none specified in this PRD)'}. The "style" direction must recommend WITHIN them and never propose replacing them; unspecified properties defer to the selected design system's defaults.
2. Distill EXACTLY three reference categories from the top-3 evidence plus your references — "style" (visual direction), "layout" (screen structure/hierarchy), "interaction" (task/interaction patterns). Each category: {category, direction (2-4 sentence synthesis of the recommended direction), referenceIds (your references supporting it), cardIds (competitor/reference cards supporting it — cite only ids that exist in the inputs or your new cards), rationale (why this direction, grounded in the top-3 evidence)}. Keep style taste separate from task-based UX reasoning.
${EVIDENCE_RULES}`,
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
        cards: { type: 'array', items: { ...CARD_SCHEMA, properties: { ...CARD_SCHEMA.properties, subjectType: { enum: ['competitor', 'reference'] } } } },
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
        failures: { type: 'array', items: FAILURE_SCHEMA },
        accessLimitations: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)
if (!distilled) throw new Error('distillation stage failed')
log(`distilled 3 reference categories from ${distilled.references.length} references`)

return {
  scope: scoped.scope,
  competitors: scoped.competitors,
  competitorRanking: ranking,
  references: distilled.references,
  referenceDistillation: distilled.referenceDistillation,
  cards: [...converged.cards, ...distilled.cards],
  featureMatrix: converged.featureMatrix,
  accessLimitations: [...new Set([...allLimitations, ...(scoped.notUsedPaidSources || []), ...(distilled.accessLimitations || [])])],
  decisionRationales: converged.decisionRationales,
  failures: [...allFailures, ...(converged.failures || []), ...(distilled.failures || [])],
}
