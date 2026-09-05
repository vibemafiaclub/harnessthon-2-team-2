export const meta = {
  name: 'visual-concept-lane',
  description: 'Apply shadcn / SEED / Wanted(Montage web) design systems to the representative wireframe structure, producing the three client-facing concepts',
  whenToUse: 'Run after the designer gate picked (or AI-recommended) the representative wireframe structure. Clients see ONLY these three concepts and propose requirements.',
  phases: [
    { title: 'Elicit', detail: 'client aesthetic-preference questionnaire (mandatory before any generation)' },
    { title: 'Direct', detail: 'representative screen + per-system application plan' },
    { title: 'Generate', detail: 'one self-contained HTML per system, structure held fixed' },
    { title: 'Check & Repair', detail: 'structure/system fidelity checks, up to 3 auto-repairs each' },
    { title: 'Package', detail: 'lane-output.json + review sheet render' },
  ],
}

// Subagent model policy (user directive): Sonnet 5 at medium effort for every agent call.
const SUB = { model: 'sonnet', effort: 'medium' }

// args: { prdPath, runDir, runId, round, startedAt, representativeWireframePath, representativeVariant,
//         clientPreferences?, feedback? }
// MANDATORY preference elicitation (user directive 2026-09-05): without clientPreferences this run
// only produces a questionnaire and STOPS - no concept may be generated before the client has
// answered aesthetic questions (color first). The session asks the client, then relaunches with
// clientPreferences filled in.
const { prdPath, runDir, runId, round, startedAt, representativeWireframePath, representativeVariant, clientPreferences, feedback } = args
if (!prdPath || !runDir || !runId || !round || !startedAt) {
  throw new Error('args must include prdPath, runDir, runId, round, startedAt')
}
// Elicitation and recolor need only the PRD, so they can run IN PARALLEL with the
// wireframe lane (user directive: no designer gate blocks; stages run concurrently).
// Generation requires the representative wireframe (AI-recommended variant auto-selected).
if (clientPreferences && !args.recolor && !representativeWireframePath) {
  throw new Error('generation requires representativeWireframePath')
}

// Color token rules (user directive 2026-09-05, "컬러 변경 원칙"): the entire main color
// must be changeable from a single request like "보라색으로 변경해 줘".
const COLOR_RULES = `COLOR TOKEN RULES (mandatory):
- Every color lives in CSS custom properties on :root; components reference tokens only - NO hardcoded hex/rgb inside component styles.
- The main color is decomposed as --primary-h / --primary-s / --primary-l and composed via hsl(var(--primary-h) var(--primary-s) var(--primary-l)).
- Derived colors (hover, active, disabled, tint/light backgrounds, focus ring) are DERIVED from the primary tokens (adjust only lightness/saturation via calc or documented steps), never independent hex values.
- Neutral tokens (grays/white/black for text, borders, surfaces) are separate from the primary family and are NEVER affected by a main-color change; content images are never recolored.
- A recolor request changes ONLY --primary-h (hue) while keeping the existing saturation and lightness; no arbitrary or generic default colors.
- Text/background contrast must stay WCAG AA after any recolor; note in a comment near :root which token pairs were contrast-checked.`

const ELICIT_SCHEMA = {
  type: 'object',
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'question', 'options'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['color', 'mood', 'shape', 'typography', 'other'] },
          question: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'label', 'description'],
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                description: { type: 'string' },
                exampleHex: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
}

// Recolor mode (컬러 변경 원칙): args.recolor = { fromRunDir, request } applies a hue-only
// main-color change to existing concepts without regenerating them.
if (args.recolor) {
  const { fromRunDir, request } = args.recolor
  if (!fromRunDir || !request) throw new Error('recolor requires fromRunDir and request')
  phase('Recolor')
  const recolored = await parallel(
    SYSTEMS.map((system) => () =>
      agent(
        `Recolor task for ${fromRunDir}/concept-${system.id}.html (skip gracefully and return "absent" if the file does not exist).
Client request: ${JSON.stringify(request)}
${COLOR_RULES}
Steps: copy the file to ${runDir}/concept-${system.id}.html, read the current --primary-h/-s/-l tokens, set --primary-h to the hue matching the requested color while KEEPING the existing saturation and lightness, verify derived tokens (hover/active/disabled/tints) still derive from the primary tokens, leave neutral tokens and any content imagery untouched, then compute the resulting body-text and button-label contrast ratios and fix ONLY lightness offsets of derived tokens if AA breaks. If the source file hardcodes colors in components (violating the token rules), refactor them into tokens first, changing nothing visually except the requested hue. Return a short summary with old and new hue values and the contrast ratios you computed.`,
        { ...SUB, label: `recolor:${system.id}`, phase: 'Recolor' }
      )
    )
  )
  const done = recolored.filter(Boolean)
  if (!done.length) throw new Error('recolor produced no files')
  phase('Package')
  const packageSummary = await agent(
    `Package the recolor round. Compute sha256 for each concept-*.html present in ${runDir}; current time as finishedAt.
Copy ${fromRunDir}/lane-output.json to ${runDir}/lane-output.json, then update: runId ${JSON.stringify(runId)}, round ${round}, artifacts' revisionHash values, timing {startedAt: ${JSON.stringify(startedAt)}, finishedAt: <now>}, and append to repairHistory one entry per concept: {attempt: 1, trigger: "client recolor request: " + ${JSON.stringify(String(request))}, change: <the hue change made>, result: "contrast re-verified"}. rationaleSummary: note this was a hue-only token recolor (S/L preserved, neutrals/images untouched).
Run \`node scripts/render-review-sheet.mjs ${runDir}\` from the repo root and confirm the sheet path prints. Return the sheet path.`,
    { ...SUB, label: 'package:recolor', phase: 'Package' }
  )
  return { laneId: 'visual-concept', runId, round, runDir, mode: 'recolor', results: done, packageSummary }
}

if (!clientPreferences) {
  phase('Elicit')
  const questionnaire = await agent(
    `Read the PRD at ${prdPath}.
Compose the client aesthetic-preference questionnaire that MUST be answered before any visual concept is generated. The first question is always about color ("어떤 색깔로 하면 좋을까요?" grounded in this product). 3-4 questions total, in Korean, for a non-designer client:
- kind "color": 3-4 concrete palette directions with exampleHex swatches (grounded in the PRD's brandHints and domain), each described by the feeling it creates, not designer jargon.
- kind "mood" and optionally "shape"/"typography": concrete, example-anchored options (e.g. "서체가 또렷하고 각진 느낌" vs "부드럽고 둥근 느낌"), never bare labels like "모던한 게 좋으세요?".
Each option description must say what the choice would concretely do to their product's screens.
Return structured output only.`,
    { ...SUB, label: 'elicit:questionnaire', phase: 'Elicit', schema: ELICIT_SCHEMA }
  )
  if (!questionnaire) throw new Error('elicitation agent failed')
  log('Preference questionnaire ready - stopping before generation (mandatory client answers)')
  return { laneId: 'visual-concept', runId, round, runDir, mode: 'elicitation', questionnaire }
}

// Decision D12/D14/D16: exactly these three systems, applied to ONE fixed structure.
// The systems contribute PATTERN LANGUAGE ONLY (component anatomy, spacing discipline,
// state model, hierarchy conventions). TONE & MANNER - color, mood, type feeling, shape
// softness - comes EXCLUSIVELY from the client's elicited preferences. Reproducing a
// system's brand tone (Daangn orange/warmth, Wanted's product palette, shadcn's zinc
// neutrality) is an explicit FAILURE (user directive 2026-09-05).
const SYSTEMS = [
  {
    id: 'shadcn',
    name: 'shadcn/ui',
    sources: ['https://ui.shadcn.com/docs', 'https://ui.shadcn.com/docs/skills'],
    patternLanguage: 'Token-driven CSS custom properties (background/foreground/muted/accent roles), thin-border card anatomy, compact vertical rhythm, explicit focus rings, muted secondary-text hierarchy, form patterns with label-above inputs.',
    forbiddenTone: 'Do NOT reproduce shadcn default zinc/slate/neutral gray tone or Inter-default look; all colors and type feeling come from the client preferences.',
  },
  {
    id: 'seed',
    name: 'SEED (Daangn)',
    sources: ['https://seed-design.io/foundations/design-token', 'https://seed-design.io/foundations/layout', 'https://seed-design.io/foundations/state'],
    patternLanguage: 'Semantic fg/bg/stroke token roles, mobile-first density and touch-target discipline, explicit enabled/pressed/selected/disabled state model, section-divider list anatomy, bottom-fixed primary action pattern.',
    forbiddenTone: 'Do NOT reproduce Daangn brand tone (carrot orange, marketplace friendliness); all colors and mood come from the client preferences.',
  },
  {
    id: 'wanted-montage',
    name: 'Wanted Montage (web)',
    sources: ['https://montage.wanted.co.kr/', 'https://github.com/wanteddev/montage-web'],
    patternLanguage: 'Structured spacing scale, crisp typographic hierarchy with strong size contrast between heading levels, generous section padding, card-grid composition, decisive single-primary-CTA per view.',
    forbiddenTone: 'Do NOT reproduce Wanted brand tone (its product blue/corporate palette); all colors and mood come from the client preferences.',
  },
]

const DIRECT_SCHEMA = {
  type: 'object',
  required: ['representativeScreen', 'viewport', 'systemPlans'],
  properties: {
    representativeScreen: {
      type: 'object',
      required: ['screenId', 'name', 'why', 'contentOutline'],
      properties: {
        screenId: { type: 'string' },
        name: { type: 'string' },
        why: { type: 'string' },
        contentOutline: { type: 'array', items: { type: 'string' } },
      },
    },
    viewport: {
      type: 'object',
      required: ['width', 'height'],
      properties: { width: { type: 'number' }, height: { type: 'number' } },
    },
    systemPlans: {
      type: 'array',
      items: {
        type: 'object',
        required: ['systemId', 'application', 'tokenOverlay'],
        properties: {
          systemId: { type: 'string' },
          application: { type: 'string' },
          tokenOverlay: { type: 'object' },
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

phase('Direct')
const direction = await agent(
  `Read the PRD at ${prdPath} and the REPRESENTATIVE wireframe at ${representativeWireframePath}${representativeVariant ? ` (selected variant: ${JSON.stringify(representativeVariant)})` : ''}.
This structure is FIXED (designer gate decision) - concepts differ ONLY in design system, so the client compares pure style.
CLIENT AESTHETIC DECISIONS (already elicited - these are binding requirements, not suggestions): ${JSON.stringify(clientPreferences)}
The three systems are PATTERN TEMPLATES (component anatomy, spacing discipline, state model, hierarchy conventions), NOT mandatory looks: the client's chosen color/mood must be expressed within each system's pattern language.
1. representativeScreen: pick the one screen from that wireframe that best exposes visual identity and density; screenId must be a real screen id in the wireframe. contentOutline = its real content blocks.
2. viewport: PRD's viewport if present, else 390x844.
3. systemPlans: for EACH of these three systems, in this order, describe how the client's chosen palette/mood is realized through that system's official pattern language, with a concrete tokenOverlay: express the primary color as HSL components {primaryH, primaryS, primaryL} derived from the client's color choice, plus neutral family, radius scale, font stack, shadow character: ${JSON.stringify(SYSTEMS)}
${COLOR_RULES}
Ground each plan in the system's official documented patterns; do not invent a fourth direction, do not blend systems, and never override the client's color/mood decisions with a system's default palette.
${feedback ? `Round ${round} client/team feedback to respect: ${JSON.stringify(feedback)}` : ''}
Return structured output only.`,
  { ...SUB, label: 'direct:3-system-plans', phase: 'Direct', schema: DIRECT_SCHEMA }
)
if (!direction) throw new Error('direction agent failed')
if (direction.systemPlans.length !== 3) throw new Error(`expected 3 system plans, got ${direction.systemPlans.length}`)
log(`Systems on "${direction.representativeScreen.name}": ${direction.systemPlans.map((p) => p.systemId).join(' / ')}`)

const conceptResults = await pipeline(
  direction.systemPlans,
  (planItem, _i, idx) => {
    const system = SYSTEMS.find((s) => s.id === planItem.systemId) ?? SYSTEMS[idx]
    return agent(
      `Create ${runDir}/concept-${system.id}.html: ONE self-contained HTML file, no external assets or network requests. Client-facing concept ${idx + 1}/3.
System to apply: ${JSON.stringify(system)}
Application plan: ${JSON.stringify(planItem)}
FIXED structure source: ${representativeWireframePath} - reproduce the representative screen "${direction.representativeScreen.name}" (id ${direction.representativeScreen.screenId}) with the SAME layout order, sections, and content blocks as the wireframe.
CLIENT AESTHETIC DECISIONS (binding): ${JSON.stringify(clientPreferences)} - the palette/mood come from the client; the system contributes its pattern language (component anatomy, spacing, states, hierarchy), not its default colors.
${COLOR_RULES}
Viewport ${direction.viewport.width}x${direction.viewport.height}. All copy in Korean, realistic content from the PRD at ${prdPath} (no lorem ipsum).
ONE PAGE ONLY (speed directive): render just the "대표 화면" - the fixed structure fully styled in this concept, inside a ${direction.viewport.width}px device frame - plus a one-line footer caption naming the pattern system and its official source. NO style tile, NO extra sections.
Accessibility: real text, body-text contrast >= WCAG AA, lang="ko", tap targets >= 44px.
Write the file, re-read to verify, return a one-paragraph summary.`,
      { ...SUB, label: `generate:${system.id}`, phase: 'Generate' }
    )
  },
  async (genSummary, planItem, idx) => {
    const system = SYSTEMS.find((s) => s.id === planItem.systemId) ?? SYSTEMS[idx]
    if (!genSummary) return { system, planItem, error: 'generate failed', checks: [], repairHistory: [] }
    let checkResult = null
    const repairHistory = []
    for (let attempt = 0; attempt <= 3; attempt++) {
      checkResult = await agent(
        `Inspect ${runDir}/concept-${system.id}.html (system: ${system.name}, PRD: ${prdPath}).
Mechanical: self-contained, lang="ko", real Korean text. COLOR TOKENS: all colors are :root CSS custom properties with --primary-h/-s/-l decomposition, derived states (hover/active/disabled/tints) computed from primary tokens, neutrals in a separate token family, NO hardcoded hex/rgb inside component styles - each violation is a FAIL (recolorability requirement).
spec-fidelity - STRUCTURE FIXED: compare against ${representativeWireframePath} screen "${direction.representativeScreen.screenId}" - same section order and content blocks ${JSON.stringify(direction.representativeScreen.contentOutline)}; report any structural drift as FAIL (client preference must isolate style). Single page only (대표 화면 + source caption footer) - extra sections are a FAIL.
accessibility: compute body-text contrast from actual hex; tap targets >= 44px.
aesthetic: expresses the CLIENT's chosen palette/mood ${JSON.stringify(clientPreferences)} through ${system.name}'s pattern language (${system.patternLanguage}). FAIL immediately if the system's brand tone leaked in - ${system.forbiddenTone} Differences vs the other two concepts must be pattern differences (anatomy/density/hierarchy), not tone differences; coherent hierarchy.
Concrete evidence per criterion; not-verified when unchecked. failingCriterionIds = fail only.`,
        { ...SUB, label: `check:${system.id}-a${attempt}`, phase: 'Check & Repair', schema: CHECK_SCHEMA }
      )
      if (!checkResult) return { system, planItem, error: 'check failed', checks: [], repairHistory }
      if (!checkResult.failingCriterionIds.length) break
      if (attempt === 3) break
      const repair = await agent(
        `Repair ${runDir}/concept-${system.id}.html. Failing: ${JSON.stringify(checkResult.checks.filter((c) => checkResult.failingCriterionIds.includes(c.criterionId)))}.
Smallest in-place edits; keep the fixed structure, the client's tone decisions, and the system's pattern language intact. Return a one-sentence change description.`,
        { ...SUB, label: `repair:${system.id}-a${attempt + 1}`, phase: 'Check & Repair', schema: REPAIR_SCHEMA }
      )
      repairHistory.push({
        attempt: attempt + 1,
        trigger: `${system.id}: ${checkResult.failingCriterionIds.join(', ')}`,
        change: repair ? repair.change : 'repair agent failed',
        result: 'rechecked',
      })
    }
    return { system, planItem, checks: checkResult.checks, failing: checkResult.failingCriterionIds, repairHistory }
  }
)

const ok = conceptResults.filter(Boolean).filter((r) => !r.error)
if (!ok.length) throw new Error('all concept generations failed')
for (const r of conceptResults.filter(Boolean).filter((r) => r.error)) {
  log(`Concept ${r.system.id} failed: ${r.error} - proceeding with ${ok.length} concept(s), gap will be visible to humans`)
}

phase('Package')
const allChecks = ok.flatMap((r) => r.checks.map((c) => ({ ...c, criterionId: `${r.system.id}:${c.criterionId}` })))
const allRepairs = ok.flatMap((r) => r.repairHistory)
const conceptEntries = ok.map((r) => ({
  id: r.system.id,
  name: r.system.name,
  direction: `${r.system.name} 공식 시스템 적용 (구조 고정)`,
  differentiation: `패턴 언어가 차별점(톤앤매너는 클라이언트 미감으로 통일): ${r.system.patternLanguage}`,
  tokenOverlay: r.planItem.tokenOverlay,
}))
const packageSummary = await agent(
  `Package the visual-concept lane run (CLIENT-facing: client proposes requirements after seeing these three; this is not a wireframe approval).
1. Compute sha256 for each of ${JSON.stringify(ok.map((r) => `concept-${r.system.id}.html`))} in ${runDir}.
2. Current time as finishedAt (ISO with timezone).
3. Write ${runDir}/lane-output.json per contracts/lane-output.schema.json:
   laneId "visual-concept", runId ${JSON.stringify(runId)}, prdId from ${prdPath}, round ${round}, viewport ${JSON.stringify(direction.viewport)},
   artifacts: one per concept {id:"concept-<systemId>", type:"combined-concept", path:"concept-<systemId>.html", revisionHash:<sha256>, conceptId:"<systemId>"},
   concepts: ${JSON.stringify(conceptEntries)},
   qualityChecks: ${JSON.stringify(allChecks)},
   repairHistory: ${JSON.stringify(allRepairs)},
   timing: {startedAt: ${JSON.stringify(startedAt)}, finishedAt: <now>, budgetNote: note overruns of the 15-minute lane target},
   rationaleSummary: state that structure is FIXED to ${representativeWireframePath} (${direction.representativeScreen.name}) so differences between the three concepts are pure design-system style - clients compare style only, and structural feedback routes back to the wireframe stage.
4. Run \`node scripts/render-review-sheet.mjs ${runDir}\` from the repo root; confirm the sheet path prints. Fix lane-output.json (never artifacts) on validation failure and rerun.
Return the sheet path and finishedAt.`,
  { ...SUB, label: 'package:lane-output', phase: 'Package' }
)
if (!packageSummary) throw new Error('package agent failed')

return {
  laneId: 'visual-concept',
  runId,
  round,
  runDir,
  representative: { path: representativeWireframePath, screen: direction.representativeScreen.name },
  concepts: ok.map((r) => ({ id: r.system.id, name: r.system.name, failingAfterRepairs: r.failing ?? [] })),
  repairs: allRepairs.length,
  packageSummary,
}
