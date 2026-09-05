export const meta = {
  name: 'prd-interview',
  description: 'PRD에서 역할별 페르소나를 뽑아 가상 인터뷰를 돌리고, 불편사항을 검증해 v2 PRD로 개정한다',
  whenToUse: 'PRD 초안이 있고 실제 유저 인터뷰가 불가능할 때. args: {prdPath, outDir, maxRounds?, maxTurns?}',
  phases: [
    { title: 'Prepare', detail: '페르소나 추출 + 제품 설명서 작성', model: 'sonnet' },
    { title: 'Stories', detail: '페르소나별 유저스토리·인터뷰 질문', model: 'sonnet' },
    { title: 'Interview', detail: '인터뷰어·응답자 2-에이전트 질답', model: 'sonnet' },
    { title: 'Extract', detail: '전사 기록 + 불편사항 추출 + 중복 제거', model: 'sonnet' },
    { title: 'Verify', detail: '불편사항별 반박 검증', model: 'sonnet' },
    { title: 'Synthesize', detail: 'pain-points.md + PRD-v2.md 작성' },
  ],
}

// ---------- args ----------
const prdPath = args && args.prdPath
const outDir = args && args.outDir
if (!prdPath || !outDir) throw new Error('args.prdPath 와 args.outDir(절대경로)가 필요합니다')
const maxRounds = (args && args.maxRounds) || 3
const maxTurns = (args && args.maxTurns) || 3
const SUB = 'sonnet'

// ---------- schemas ----------
const PERSONAS_SCHEMA = {
  type: 'object',
  properties: {
    personas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'ascii 소문자/하이픈, 파일명용 (예: bride)' },
          role: { type: 'string', description: 'PRD상의 역할/사용케이스 이름' },
          name: { type: 'string' },
          context: { type: 'string', description: '상황·배경 (나이대, 직업, 결혼 준비 단계 등 구체적으로)' },
          techLevel: { type: 'string' },
          goal: { type: 'string', description: '이 제품으로 달성하려는 목적 (JTBD 형식)' },
          currentAlternative: { type: 'string', description: '지금은 이 문제를 어떻게 해결하는지' },
          frustrations: { type: 'array', items: { type: 'string' } },
        },
        required: ['slug', 'role', 'name', 'context', 'techLevel', 'goal', 'currentAlternative', 'frustrations'],
      },
    },
  },
  required: ['personas'],
}

const WALKTHROUGH_SCHEMA = {
  type: 'object',
  properties: {
    walkthrough: { type: 'string', description: '사용자에게 보여주는 제품 소개 + 흐름 시나리오 (PRD 용어 금지)' },
    features: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' }, summary: { type: 'string' } },
        required: ['id', 'name', 'summary'],
      },
    },
  },
  required: ['walkthrough', 'features'],
}

const STORIES_SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          story: { type: 'string' },
          featureIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'story', 'featureIds'],
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { storyId: { type: 'string' }, question: { type: 'string' } },
        required: ['storyId', 'question'],
      },
    },
  },
  required: ['stories', 'questions'],
}

const INTERVIEWER_SCHEMA = {
  type: 'object',
  properties: {
    questions: { type: 'array', items: { type: 'string' }, description: '이번 턴에 던질 질문 2~3개' },
    done: { type: 'boolean', description: '이번 턴이 마지막이면 true' },
  },
  required: ['questions', 'done'],
}

const ANSWER_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string', description: '질문 각각에 대한 답을 자연스러운 대화체로' } },
  required: ['answer'],
}

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    painPoints: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['functional', 'ux'] },
          featureIds: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          quote: { type: 'string', description: '응답자 발언 원문 인용' },
        },
        required: ['type', 'featureIds', 'description', 'quote'],
      },
    },
    featuresDiscussed: { type: 'array', items: { type: 'string' } },
  },
  required: ['painPoints', 'featuresDiscussed'],
}

const DEDUP_SCHEMA = {
  type: 'object',
  properties: {
    newIds: { type: 'array', items: { type: 'string' }, description: '기존 목록에 없는 새 불편사항의 id' },
  },
  required: ['newIds'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['refuted', 'reason'],
}

// ---------- helpers ----------
const j = (x) => JSON.stringify(x, null, 2)
const readPrd = `먼저 Read 도구로 PRD 원문을 읽어라: ${prdPath}`
const writeNote = (path) => `결과 파일은 Write 도구로 반드시 다음 절대경로에 저장하라: ${path}`

function personaCard(p) {
  return `이름: ${p.name}\n역할: ${p.role}\n상황: ${p.context}\n기술 숙련도: ${p.techLevel}\n달성하려는 목적: ${p.goal}\n현재 대안: ${p.currentAlternative}\n좌절 포인트: ${p.frustrations.join(' / ')}`
}

function transcriptText(t) {
  return t.map((x) => `[턴 ${x.turn}]\n인터뷰어: ${x.questions.join(' | ')}\n응답자: ${x.answer}`).join('\n\n')
}

// ---------- Phase 1: Prepare ----------
phase('Prepare')
log('페르소나 추출과 제품 설명서 작성을 병렬로 시작')

const [personaResult, walk] = await parallel([
  () =>
    agent(
      `${readPrd}

PRD에 등장하는 서로 다른 역할/사용케이스마다 페르소나를 정확히 1명씩 만들어라. 역할은 PRD의 유저스토리·배경·상황에서 뽑는다 (예: 예비신부, 예비신랑, 초대받은 지인). 같은 역할을 여러 명 만들지 마라.
각 페르소나는 실존하는 사람처럼 구체적으로: 이름, 상황(직업·나이대·결혼 준비 단계·인간관계 규모), 기술 숙련도, 이 제품으로 달성하려는 목적(JTBD: "~할 때 ~하고 싶다, 그래서 ~하기 위해"), 지금 쓰는 대안, 좌절 포인트 2~4개.
PRD가 놓치고 있을 법한 역할이 있으면 1명까지 추가해도 된다. 추가했다면 context에 그 이유를 적어라.

${writeNote(outDir + '/personas.md')} (마크다운, 페르소나별 섹션, 한국어)`,
      { schema: PERSONAS_SCHEMA, model: SUB, label: 'personas', phase: 'Prepare' },
    ),
  () =>
    agent(
      `${readPrd}

이 PRD를 "제품을 처음 접하는 일반 사용자에게 보여주는 제품 소개서"로 다시 써라. 조건:
- PRD의 항목 번호, "기능 요구사항", "유저스토리" 같은 문서 용어를 쓰지 마라. 사용자가 앱을 열고 무엇을 할 수 있는지, 어떤 순서로 흘러가는지를 시나리오처럼 설명한다.
- PRD에 없는 기능을 지어내지 마라. PRD가 정하지 않은 부분(화면 구성, 알림 방식 등)은 "정해지지 않음"이라고 명시한다.
- 동시에 PRD의 기능 요구사항을 features 목록으로 정리한다. id는 F1, F2… 형식, PRD의 기능 번호 순서대로.

${writeNote(outDir + '/product-walkthrough.md')} (한국어)`,
      { schema: WALKTHROUGH_SCHEMA, model: SUB, label: 'walkthrough', phase: 'Prepare' },
    ),
])

if (!personaResult || !walk) throw new Error('준비 단계 실패: 페르소나 또는 제품 설명서가 비어 있음')
const personas = personaResult.personas
const features = walk.features
const featureIds = features.map((f) => f.id)
log(`페르소나 ${personas.length}명: ${personas.map((p) => p.role).join(', ')} / 기능 ${features.length}개`)

// ---------- per-persona round ----------
async function runInterview(p, round, questions, focus) {
  const transcript = []
  for (let t = 0; t < maxTurns; t++) {
    const q = await agent(
      `너는 UX 리서처다. 아래 페르소나와 인터뷰 중이다. 목표는 이 사람이 제품을 쓸 때 겪을 기능적·UX적 불편함을 최대한 드러내는 것이다.

[페르소나]
${personaCard(p)}

[준비된 질문 목록]
${questions.map((x, i) => `${i + 1}. (${x.storyId}) ${x.question}`).join('\n')}

${focus ? `[이번 라운드 집중 주제]\n${focus}\n` : ''}
[지금까지의 대화]
${transcript.length ? transcriptText(transcript) : '(아직 없음)'}

턴 ${t + 1}/${maxTurns}. 이번 턴에 던질 질문 2~3개를 골라라. 규칙:
- 이전 답변에서 막힘·망설임·우회 행동이 보이면 준비된 질문보다 그걸 파고드는 후속 질문을 우선한다.
- 시나리오형으로 묻는다 ("~한 상황이라고 해봅시다. 그때 어떻게 하시겠어요?"). "편리할 것 같나요?" 같은 예/아니오 질문 금지.
- 아직 안 다룬 준비 질문이 남아 있으면 그것도 섞는다.
- 마지막 턴(${maxTurns})이거나 더 물을 게 없으면 done=true.`,
      { schema: INTERVIEWER_SCHEMA, model: SUB, label: `${p.slug} r${round} Q${t + 1}`, phase: 'Interview' },
    )
    if (!q || !q.questions || !q.questions.length) break

    const a = await agent(
      `너는 아래 인물이다. 이 인물로서만 말하고, 리서처나 제품팀의 입장을 취하지 마라.

[당신]
${personaCard(p)}

[당신이 소개받은 제품]
${walk.walkthrough}

[지금까지의 대화]
${transcript.length ? transcriptText(transcript) : '(아직 없음)'}

[인터뷰어의 질문]
${q.questions.map((x, i) => `${i + 1}. ${x}`).join('\n')}

규칙:
- 자신의 실제 상황과 습관에 비추어 답한다. 제품 소개서에 없는 기능은 모른다고 하거나 "그런 게 있으면 좋겠다"고 말한다.
- 좋은 점만 말하지 마라. 막히는 지점, 헷갈리는 지점, 귀찮아서 안 할 것 같은 지점, 지금 쓰는 방법(${p.currentAlternative})으로 돌아갈 것 같은 지점을 반드시 구체적으로 말한다.
- 질문마다 답하되 자연스러운 대화체 한국어로. 과장하지 말고 실제 있을 법한 사례를 들어 답한다.`,
      { schema: ANSWER_SCHEMA, model: SUB, label: `${p.slug} r${round} A${t + 1}`, phase: 'Interview' },
    )
    if (!a) break
    transcript.push({ turn: t + 1, questions: q.questions, answer: a.answer })
    if (q.done) break
  }
  return transcript
}

async function runPersonaRound(p, round, prepared, focus) {
  let questions = prepared
  if (round === 1) {
    const s = await agent(
      `${readPrd}

[페르소나]
${personaCard(p)}

[기능 목록]
${j(features)}

이 페르소나의 유저스토리를 3~6개 써라. 형식: "<역할>로서, <상황>에서 <행동>을 하고 싶다. 그래야 <목적>이기 때문이다." 각 스토리에 관련 기능 id(featureIds)를 붙인다. 이 페르소나가 실제로 마주칠 까다로운 경우(PRD 3장의 상황들)를 스토리에 반영하라.
그리고 각 스토리당 시나리오형 인터뷰 질문 1~2개를 만들어라. 라벨형("직관적이면 좋겠나요?") 금지, "~한 상황이라고 해봅시다" 식으로.

${writeNote(outDir + '/stories/' + p.slug + '.md')} (한국어, 스토리와 질문 모두 포함)`,
      { schema: STORIES_SCHEMA, model: SUB, label: `${p.slug} stories`, phase: 'Stories' },
    )
    if (!s) return null
    questions = s.questions
  }

  const transcript = await runInterview(p, round, questions, focus)
  if (!transcript.length) return null

  const ex = await agent(
    `아래는 페르소나 인터뷰 전사다. 두 가지를 하라.

1. 전사를 마크다운으로 정리해 저장한다. ${writeNote(outDir + '/interviews/' + p.slug + '-r' + round + '.md')} (페르소나 카드 요약 + 턴별 질문/답변 원문)
2. 전사에서 불편사항을 추출한다. 기준:
   - functional: 제품이 페르소나의 목적을 못 채우거나, 필요한 기능이 없거나, 상황(예외 케이스)을 다루지 못하는 것
   - ux: 기능은 있지만 헷갈리거나, 번거롭거나, 안 쓰고 기존 방법으로 돌아갈 것 같은 것
   - 각 항목에 관련 기능 id를 붙이고, 응답자 발언을 원문 그대로 인용한다. 발언에 근거 없는 추론은 넣지 마라.
   - 좋다는 평가는 불편사항이 아니다.
   - featuresDiscussed에는 대화에서 실제로 다뤄진 기능 id를 모두 넣는다.

[페르소나]
${personaCard(p)}

[기능 목록]
${j(features)}

[전사]
${transcriptText(transcript)}`,
    { schema: EXTRACT_SCHEMA, model: SUB, label: `${p.slug} r${round} extract`, phase: 'Extract' },
  )
  if (!ex) return null
  return {
    persona: p,
    round,
    questions,
    painPoints: ex.painPoints.map((pp, i) => ({ ...pp, id: `${p.slug}-r${round}-${i + 1}`, persona: p.role, round })),
    featuresDiscussed: ex.featuresDiscussed,
  }
}

// ---------- Rounds: loop until dry ----------
const seen = []
const discussed = new Set()
const preparedQuestions = {}
let dry = 0
let roundsRun = 0

for (let round = 1; round <= maxRounds && dry < 2; round++) {
  roundsRun = round
  const uncovered = featureIds.filter((id) => !discussed.has(id))
  let focus = null
  if (round > 1) {
    const uncoveredText = uncovered.length
      ? `아직 인터뷰에서 다뤄지지 않은 기능: ${features.filter((f) => uncovered.includes(f.id)).map((f) => `${f.id} ${f.name}`).join(', ')}. 이 기능들을 이 페르소나의 상황에서 겪는 시나리오로 물어라.`
      : '모든 기능이 한 번은 다뤄졌다.'
    const top = seen.slice(-8).map((x) => `- ${x.description}`).join('\n')
    focus = `${uncoveredText}\n지난 라운드에서 나온 불편사항(다른 페르소나 포함). 이 페르소나에게도 해당되는지, 다른 각도의 문제는 없는지 파고들어라:\n${top}`
  }
  log(`라운드 ${round} 시작 (미커버 기능 ${uncovered.length}개, 누적 불편사항 ${seen.length}개)`)

  const results = (await parallel(personas.map((p) => () => runPersonaRound(p, round, preparedQuestions[p.slug], focus)))).filter(Boolean)
  for (const r of results) {
    preparedQuestions[r.persona.slug] = r.questions
    r.featuresDiscussed.forEach((id) => discussed.add(id))
  }
  const fresh = results.flatMap((r) => r.painPoints)
  log(`라운드 ${round}: 인터뷰 ${results.length}건, 추출된 불편사항 ${fresh.length}개`)

  let newOnes = fresh
  if (seen.length && fresh.length) {
    const dd = await agent(
      `아래 [기존] 불편사항 목록과 [신규] 목록을 비교해, 신규 중 기존과 실질적으로 같은 문제가 아닌 것의 id만 골라라. 같은 기능의 같은 불편이면 페르소나가 달라도 중복으로 본다. 다른 원인이나 다른 상황이면 새 것으로 본다.

[기존]
${j(seen.map((x) => ({ id: x.id, description: x.description, featureIds: x.featureIds })))}

[신규]
${j(fresh.map((x) => ({ id: x.id, description: x.description, featureIds: x.featureIds })))}`,
      { schema: DEDUP_SCHEMA, model: SUB, label: `dedup r${round}`, phase: 'Extract' },
    )
    const keep = new Set(dd ? dd.newIds : fresh.map((x) => x.id))
    newOnes = fresh.filter((x) => keep.has(x.id))
  }
  seen.push(...newOnes)
  if (newOnes.length === 0) dry++
  else dry = 0
  log(`라운드 ${round}: 새 불편사항 ${newOnes.length}개 (연속 무수확 ${dry})`)
}
const uncoveredFinal = featureIds.filter((id) => !discussed.has(id))
if (uncoveredFinal.length) log(`주의: 끝까지 다뤄지지 않은 기능 ${uncoveredFinal.join(', ')}`)

// ---------- Verify ----------
phase('Verify')
log(`불편사항 ${seen.length}개 반박 검증`)
const verified = await pipeline(seen, (pp) =>
  agent(
    `너는 회의적인 검토자다. 아래 불편사항이 진짜인지 반박을 시도하라. 다음 중 하나라도 해당하면 refuted=true:
- 페르소나의 상황·목적과 모순된다 (그 사람이 겪을 리 없는 문제)
- 제품 소개서에 없는 기능을 전제로 하거나, 소개서를 오독했다
- 인용된 발언이 실제로 그 불편을 뒷받침하지 않는다
- 설계를 바꿀 필요가 없는 사소한 취향 표현이다
확실하지 않으면 refuted=false로 두되 reason에 의심 지점을 적어라.

[페르소나]
${personaCard(personas.find((p) => p.role === pp.persona) || personas[0])}

[제품 소개서]
${walk.walkthrough}

[불편사항]
${j(pp)}`,
    { schema: VERDICT_SCHEMA, model: SUB, label: `verify ${pp.id}`, phase: 'Verify' },
  ).then((v) => ({ ...pp, refuted: v ? v.refuted : false, verdictReason: v ? v.reason : '검증 실패(에이전트 응답 없음), 통과 처리' })),
)
const all = verified.filter(Boolean)
const passed = all.filter((x) => !x.refuted)
const rejected = all.filter((x) => x.refuted)
log(`검증 통과 ${passed.length}개, 탈락 ${rejected.length}개`)

// ---------- Synthesize ----------
phase('Synthesize')
const [painDoc, prdV2] = await parallel([
  () =>
    agent(
      `아래 데이터를 pain-points.md로 정리하라. 구성: 요약 표(id, 유형, 페르소나, 관련 기능, 한 줄 설명) → 통과 항목 상세(설명, 인용, 검증 코멘트) → 탈락 항목(설명, 탈락 사유). 라운드 수 ${roundsRun}, 끝까지 미커버된 기능: ${uncoveredFinal.length ? uncoveredFinal.join(', ') : '없음'} 도 머리에 적어라.
${writeNote(outDir + '/pain-points.md')}

[기능 목록]
${j(features)}

[통과]
${j(passed)}

[탈락]
${j(rejected)}`,
      { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, model: SUB, label: 'pain-points.md', phase: 'Synthesize' },
    ),
  () =>
    agent(
      `${readPrd}

당신은 이 PRD의 소유자다. 아래 페르소나 인터뷰 결과를 반영해 PRD를 v2로 개정하라. 원 PRD의 구조(배경, 유저스토리, 상황, 기능 요구사항, 조건)를 유지하되 내용을 고친다. 규칙:
- 기능 요구사항 각 항목 끝에 [유지] [수정] [추가] [삭제] 중 하나를 표시하고, 수정/추가/삭제에는 근거를 "근거: <페르소나> — "<인용>"" 형식으로 붙인다.
- 유저스토리는 페르소나별 인터뷰에서 확인된 것으로 갱신한다. 원 PRD에 없던 역할이 페르소나에 있으면 추가한다.
- 새 섹션 "설계 시 유의사항": 화면·흐름을 설계할 때 반드시 지켜야 할 것을 항목별로, 각 항목에 관련 불편사항 id를 붙인다.
- 새 섹션 "미해결 트레이드오프": 페르소나 간 요구가 충돌하는 지점을 지우지 말고 양쪽 입장과 함께 남긴다.
- 새 섹션 "개정 이력": 인터뷰 라운드 수, 페르소나 목록, 통과/탈락 불편사항 수, 끝까지 다뤄지지 않은 기능(${uncoveredFinal.length ? uncoveredFinal.join(', ') : '없음'}).
- 검증에서 탈락한 항목은 근거로 쓰지 마라.
- 제출/평가 관련 원문 섹션은 그대로 둔다.

${writeNote(outDir + '/PRD-v2.md')} (한국어)

[페르소나]
${j(personas)}

[기능 목록]
${j(features)}

[검증 통과 불편사항]
${j(passed)}`,
      { schema: { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'] }, label: 'PRD-v2.md', phase: 'Synthesize' },
    ),
])

return {
  personas: personas.map((p) => p.role),
  features: features.length,
  rounds: roundsRun,
  painPoints: { passed: passed.length, rejected: rejected.length },
  uncoveredFeatures: uncoveredFinal,
  files: ['personas.md', 'product-walkthrough.md', 'stories/', 'interviews/', 'pain-points.md', 'PRD-v2.md'].map((f) => outDir + '/' + f),
  prdV2Summary: prdV2 ? prdV2.summary : null,
  painDocWritten: !!(painDoc && painDoc.ok),
}
