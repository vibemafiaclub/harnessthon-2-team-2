export const meta = {
  name: 'wireframe-lane',
  description: 'PRD to three INTERNAL structural wireframe variants (designer inspection only, never shown to clients), checked, auto-repaired, packaged',
  whenToUse: 'Run one wireframe round for a structured PRD. Output feeds the designer gate that picks the representative structure for the visual-concept lane.',
  phases: [
    { title: 'Plan', detail: 'shared screen inventory + 3 distinct structural approaches' },
    { title: 'Generate', detail: 'one self-contained clickable wireframe per variant' },
    { title: 'Check & Repair', detail: 'per-variant checks, up to 3 auto-repairs each' },
    { title: 'Package', detail: 'lane-output.json + AI representative recommendation + review sheet' },
  ],
}

// Subagent model policy (user directive): Sonnet 5 at medium effort for every agent call.
const SUB = { model: 'sonnet', effort: 'medium' }

// args: { prdPath, runDir, runId, round, startedAt, feedback? }
const { prdPath, runDir, runId, round, startedAt, feedback } = args
if (!prdPath || !runDir || !runId || !round || !startedAt) {
  throw new Error('args must include prdPath, runDir, runId, round, startedAt')
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['viewport', 'variants'],
  properties: {
    viewport: {
      type: 'object',
      required: ['width', 'height'],
      properties: { width: { type: 'number' }, height: { type: 'number' } },
    },
    variants: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'structuralIdea', 'screens', 'edges'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          structuralIdea: { type: 'string' },
          screens: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'name', 'purpose'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                purpose: { type: 'string' },
                keyElements: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              required: ['from', 'to', 'action'],
              properties: { from: { type: 'string' }, to: { type: 'string' }, action: { type: 'string' } },
            },
          },
        },
      },
    },
  },
}

const CHECK_SCHEMA = {
  type: 'object',
  required: ['checks', 'failingCriterionIds'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterionId', 'axis', 'status', 'expected', 'observed'],
        properties: {
          criterionId: { type: 'string' },
          axis: { type: 'string', enum: ['ux-task', 'spec-fidelity', 'accessibility', 'aesthetic', 'mechanical'] },
          status: { type: 'string', enum: ['pass', 'fail', 'not-verified', 'not-applicable'] },
          expected: { type: 'string' },
          observed: { type: 'string' },
        },
      },
    },
    failingCriterionIds: { type: 'array', items: { type: 'string' } },
  },
}

const REPAIR_SCHEMA = { type: 'object', required: ['change'], properties: { change: { type: 'string' } } }

const RECOMMEND_SCHEMA = {
  type: 'object',
  required: ['recommendedVariantId', 'reason'],
  properties: { recommendedVariantId: { type: 'string' }, reason: { type: 'string' } },
}

phase('Plan')
const plan = await agent(
  `Read the structured PRD at ${prdPath} (conforms to contracts/prd-input.schema.json).
These wireframes are INTERNAL material for designers only - clients never see them - so optimize for exposing structural options clearly, not for polish.
Produce EXACTLY three structural variants that solve the same PRD with meaningfully different information architecture (e.g. hub-and-spoke vs linear wizard vs single-scroll with anchors - choose what fits this PRD, at least two structural axes apart from each other).
Every variant must cover all mustHaveScreens and every coreFlow step (screens may merge/split differently per variant - that is the point).
viewport: PRD's viewport if present, else 390x844.
Variant ids: short slugs (e.g. "hub", "wizard"). Screen ids unique within a variant.
${feedback ? `Round ${round} human/designer feedback to incorporate: ${JSON.stringify(feedback)}` : ''}
Return structured output only.`,
  { ...SUB, label: 'plan:3-variants', phase: 'Plan', schema: PLAN_SCHEMA }
)
if (!plan) throw new Error('plan agent failed')
if (plan.variants.length !== 3) throw new Error(`expected exactly 3 variants, got ${plan.variants.length}`)
log(`Variants: ${plan.variants.map((v) => `${v.name}(${v.screens.length} screens)`).join(' / ')}`)

const variantResults = await pipeline(
  plan.variants,
  (variant) =>
    agent(
      `Create ${runDir}/wireframe-${variant.id}.html: ONE self-contained low-fidelity clickable wireframe. No external assets or network requests.
Variant: ${JSON.stringify(variant)}
Viewport: ${plan.viewport.width}x${plan.viewport.height}. PRD for content: ${prdPath}.
Requirements:
- Two tab views: "플로맵" (boxes per screen, labeled arrows matching edges exactly, boxes clickable) and "화면" (hash routing #screen-<id>, one screen at a time in a ${plan.viewport.width}x${plan.viewport.height} device frame).
- Low-fi discipline: grayscale boxes/placeholders, real Korean labels and CTA text derived from the PRD, NO brand styling or color - visual systems are applied later by another lane.
- Every edge is an actually clickable element routing to its target; persistent back affordance.
- Accessibility basics: <html lang="ko">, one h1 per screen, real <button>/<a>, labeled inputs.
- A small persistent banner: "내부 검토용 — 클라이언트 공유 금지".
Write the file, re-read to verify validity, return a one-paragraph summary.`,
      { ...SUB, label: `generate:${variant.id}`, phase: 'Generate' }
    ),
  async (genSummary, variant) => {
    if (!genSummary) return { variant, error: 'generate failed', checks: [], repairHistory: [] }
    let checkResult = null
    const repairHistory = []
    for (let attempt = 0; attempt <= 3; attempt++) {
      checkResult = await agent(
        `Inspect ${runDir}/wireframe-${variant.id}.html against variant ${JSON.stringify({ screens: variant.screens.map((s) => s.id), edges: variant.edges })} and the PRD at ${prdPath}.
Mechanical: every screen routable; every edge clickable to an existing target; no external assets; lang/h1/labels present; internal-use banner present.
ux-task: trace each coreFlow by clicks and name the path. spec-fidelity: mustHaveScreens and flow steps represented. accessibility: mechanical basics. aesthetic: low-fi discipline (no brand styling) and legible hierarchy; Korean copy throughout.
Concrete observed evidence per criterion; not-verified when unchecked. failingCriterionIds = status fail only.`,
        { ...SUB, label: `check:${variant.id}-a${attempt}`, phase: 'Check & Repair', schema: CHECK_SCHEMA }
      )
      if (!checkResult) return { variant, error: 'check failed', checks: [], repairHistory }
      if (!checkResult.failingCriterionIds.length) break
      if (attempt === 3) break
      const repair = await agent(
        `Repair ${runDir}/wireframe-${variant.id}.html. Failing: ${JSON.stringify(checkResult.checks.filter((c) => checkResult.failingCriterionIds.includes(c.criterionId)))}.
Smallest in-place edits; keep the variant's structural idea intact. Return a one-sentence change description.`,
        { ...SUB, label: `repair:${variant.id}-a${attempt + 1}`, phase: 'Check & Repair', schema: REPAIR_SCHEMA }
      )
      repairHistory.push({
        attempt: attempt + 1,
        trigger: `${variant.id}: ${checkResult.failingCriterionIds.join(', ')}`,
        change: repair ? repair.change : 'repair agent failed',
        result: 'rechecked',
      })
    }
    return { variant, checks: checkResult.checks, failing: checkResult.failingCriterionIds, repairHistory }
  }
)

const ok = variantResults.filter(Boolean).filter((r) => !r.error)
if (!ok.length) throw new Error('all variant generations failed')
for (const r of variantResults.filter(Boolean).filter((r) => r.error)) {
  log(`Variant ${r.variant.id} failed: ${r.error} - proceeding with ${ok.length} variant(s)`)
}

phase('Package')
const recommendation = await agent(
  `Compare the wireframe variants in ${runDir} (files: ${ok.map((r) => `wireframe-${r.variant.id}.html`).join(', ')}) for the PRD at ${prdPath}.
Variant intents: ${JSON.stringify(ok.map((r) => ({ id: r.variant.id, name: r.variant.name, idea: r.variant.structuralIdea })))}.
Recommend ONE representative structure for the visual-concept lane (designer may override; if the designer does not respond, this recommendation proceeds and is recorded). Judge task efficiency for the PRD's coreFlows, clarity for first-time users, and how well the structure showcases the product. reason: 2-3 sentences, concrete.`,
  { ...SUB, label: 'recommend:representative', phase: 'Package', schema: RECOMMEND_SCHEMA }
)

const allChecks = ok.flatMap((r) => r.checks.map((c) => ({ ...c, criterionId: `${r.variant.id}:${c.criterionId}` })))
const allRepairs = ok.flatMap((r) => r.repairHistory)
const allScreens = ok.flatMap((r) =>
  r.variant.screens.map((s) => ({ id: `${r.variant.id}:${s.id}`, name: `[${r.variant.name}] ${s.name}`, purpose: s.purpose }))
)
const packageSummary = await agent(
  `Package the wireframe lane run (INTERNAL / designer-inspection audience).
1. Compute sha256 for each of ${JSON.stringify(ok.map((r) => `wireframe-${r.variant.id}.html`))} in ${runDir}.
2. Current time as finishedAt (ISO with timezone).
3. Write ${runDir}/lane-output.json per contracts/lane-output.schema.json:
   laneId "wireframe", runId ${JSON.stringify(runId)}, prdId from ${prdPath}, round ${round}, viewport ${JSON.stringify(plan.viewport)},
   artifacts: one per variant {id:"wf-<variantId>", type:"clickable-wireframe", path:"wireframe-<variantId>.html", revisionHash:<sha256>},
   screens: ${JSON.stringify(allScreens)},
   qualityChecks: ${JSON.stringify(allChecks)},
   repairHistory: ${JSON.stringify(allRepairs)},
   timing: {startedAt: ${JSON.stringify(startedAt)}, finishedAt: <now>, budgetNote: note overruns of the 15-minute lane target},
   rationaleSummary: include the variant intents, the AI representative recommendation ${JSON.stringify(recommendation)}, and the audience rule "내부용 - 클라이언트 비노출, 디자이너는 대표 구조 선택만".
   Also add a top-level extra field "internalOnly": true and "aiRecommendation": ${JSON.stringify(recommendation)} (extra fields are allowed).
4. Run \`node scripts/render-review-sheet.mjs ${runDir}\` from the repo root; confirm the sheet path prints. Fix lane-output.json (never artifacts) on validation failure and rerun.
Return the sheet path and finishedAt.`,
  { ...SUB, label: 'package:lane-output', phase: 'Package' }
)
if (!packageSummary) throw new Error('package agent failed')

return {
  laneId: 'wireframe',
  runId,
  round,
  runDir,
  variants: ok.map((r) => ({ id: r.variant.id, name: r.variant.name, failingAfterRepairs: r.failing ?? [] })),
  aiRecommendation: recommendation,
  repairs: allRepairs.length,
  packageSummary,
}
