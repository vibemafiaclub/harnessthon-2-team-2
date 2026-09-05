export const meta = {
  name: 'prd-interview-v2',
  description: 'PRD에서 역할별 페르소나를 뽑아 가상 인터뷰를 돌리고, 불편사항을 검증해 v2 PRD로 개정한다 (프롬프트는 prompts/*.md)',
  whenToUse: 'PRD 초안이 있고 실제 유저 인터뷰가 불가능할 때. 2단계로 돌린다. 1단계 args: {prdPath, outDir, promptsDir, maxTurns?, skipInterviewer?} → 인터뷰 1회 + 검증 + 사람에게 물을 질문 목록. 2단계 args: {stage: "revise", prdPath, outDir, promptsDir, answers: [{id, answer}]} → PRD-v2.md (모든 경로는 절대경로)',
  phases: [
    { title: 'Prepare', detail: '페르소나 추출 + 제품 설명서 작성', model: 'sonnet' },
    { title: 'Stories', detail: '페르소나별 유저스토리·인터뷰 질문', model: 'sonnet' },
    { title: 'Interview', detail: '인터뷰어·응답자 2-에이전트 질답 (1회)', model: 'sonnet' },
    { title: 'Extract', detail: '전사 기록 + 불편사항 추출', model: 'sonnet' },
    { title: 'Verify', detail: '불편사항별 반박 검증', model: 'sonnet' },
    { title: 'Questions', detail: 'pain-points.md + 사람에게 물을 질문 목록', model: 'sonnet' },
    { title: 'Revise', detail: '(2단계) 답변 반영해 PRD-v2.md 작성', model: 'sonnet' },
  ],
}

// ---------- args ----------
const prdPath = args && args.prdPath
const outDir = args && args.outDir
const promptsDir = args && args.promptsDir
if (!prdPath || !outDir || !promptsDir) throw new Error('args.prdPath, args.outDir, args.promptsDir (절대경로)가 필요합니다')
const maxTurns = (args && args.maxTurns) || 1
const skipInterviewer = !!(args && args.skipInterviewer)
const stage = (args && args.stage) || 'interview'
// 모든 에이전트 sonnet. effort는 단계별: 판단이 필요한 단계(페르소나·인터뷰어·검증·질문 종합·PRD 개정)는 medium,
// 기계적인 단계(응답자 역할극·전사/추출·pain-points 정리)는 low.
const SUB = { model: 'sonnet', effort: 'medium' }
const SUB_LOW = { model: 'sonnet', effort: 'low' }

// ---------- prompt assembly ----------
// 스크립트는 파일을 읽을 수 없으므로, 각 에이전트가 자기 프롬프트 파일을 Read 도구로 읽는다.
// 스크립트는 "# 입력" 아래에 이름 붙인 블록만 붙여 준다. 프롬프트 md는 `입력 > 이름`으로 이 블록을 참조한다.
function withPrompt(file, inputs) {
  const body = Object.entries(inputs)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `## ${k}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)
    .join('\n\n')
  return `먼저 Read 도구로 아래 프롬프트 파일을 읽고, 그 지시를 그대로 따라라. 아래 "# 입력" 블록이 프롬프트가 말하는 \`입력 > 이름\`이다.\n프롬프트 파일: ${promptsDir}/${file}\n\n# 입력\n\n${body}`
}

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

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['refuted', 'reason'],
}

const QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Q1, Q2… 순번' },
          kind: { type: 'string', enum: ['undecided', 'conflict', 'followup'], description: 'undecided: PRD 미정 사항 / conflict: 페르소나 간 충돌 / followup: 2라운드에서 물었을 후속 질문' },
          question: { type: 'string', description: 'PRD 소유자에게 던지는 한 문장 질문' },
          why: { type: 'string', description: '이 질문이 나온 근거 (관련 기능 id, 불편사항 id, 페르소나 발언)' },
          options: { type: 'array', items: { type: 'string' }, description: '가능한 선택지 2~4개 (없으면 빈 배열)' },
        },
        required: ['id', 'kind', 'question', 'why', 'options'],
      },
    },
  },
  required: ['questions'],
}

const OK_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
const OK_SUMMARY_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
  required: ['ok', 'summary'],
}

// ---------- helpers ----------
function personaCard(p) {
  return `이름: ${p.name}\n역할: ${p.role}\n상황: ${p.context}\n기술 숙련도: ${p.techLevel}\n달성하려는 목적: ${p.goal}\n현재 대안: ${p.currentAlternative}\n좌절 포인트: ${p.frustrations.join(' / ')}`
}

function transcriptText(t) {
  if (!t.length) return '(아직 없음)'
  return t.map((x) => `[턴 ${x.turn}]\n인터뷰어: ${x.questions.join(' | ')}\n응답자: ${x.answer}`).join('\n\n')
}

function featureNames(ids) {
  return features.filter((f) => ids.includes(f.id)).map((f) => `${f.id} ${f.name}`).join(', ')
}

// questions를 최대 maxTurns개 묶음으로 나눈다 (skipInterviewer용)
function chunkQuestions(questions, n) {
  if (!questions.length) return []
  const size = Math.ceil(questions.length / n)
  const out = []
  for (let i = 0; i < questions.length; i += size) out.push(questions.slice(i, i + size))
  return out
}

// ---------- helpers: file paths shared by both stages ----------
const files = {
  personas: `${outDir}/personas.md`,
  walkthrough: `${outDir}/product-walkthrough.md`,
  painPoints: `${outDir}/pain-points.md`,
  openQuestions: `${outDir}/open-questions.md`,
  prdV2: `${outDir}/PRD-v2.md`,
}

// =====================================================================
// Stage 2: revise — 사람의 답변을 받아 PRD-v2 작성
// =====================================================================
if (stage === 'revise') {
  const answers = (args && args.answers) || []
  if (!answers.length) throw new Error('stage=revise 에는 args.answers ([{id, answer}])가 필요합니다')
  phase('Revise')
  log(`답변 ${answers.length}개 반영해 PRD-v2 작성`)
  const prdV2 = await agent(
    withPrompt('10-prd-v2.md', {
      'PRD 경로': prdPath,
      '페르소나 파일': files.personas,
      '제품 설명서 파일': files.walkthrough,
      '불편사항 파일': files.painPoints,
      '질문 파일': files.openQuestions,
      '답변': answers,
      '저장 경로': files.prdV2,
    }),
    { schema: OK_SUMMARY_SCHEMA, ...SUB, label: 'PRD-v2.md', phase: 'Revise' },
  )
  return { stage: 'revise', file: files.prdV2, prdV2Summary: prdV2 ? prdV2.summary : null, written: !!(prdV2 && prdV2.ok) }
}

// =====================================================================
// Stage 1: interview — 준비 → 인터뷰 1회 → 추출 → 검증 → 질문 목록
// =====================================================================

// ---------- Phase 1: Prepare ----------
phase('Prepare')
log('페르소나 추출과 제품 설명서 작성을 병렬로 시작')

const [personaResult, walk] = await parallel([
  () =>
    agent(withPrompt('01-personas.md', { 'PRD 경로': prdPath, '저장 경로': files.personas }), {
      schema: PERSONAS_SCHEMA, ...SUB, label: 'personas', phase: 'Prepare',
    }),
  () =>
    agent(withPrompt('02-walkthrough.md', { 'PRD 경로': prdPath, '저장 경로': files.walkthrough }), {
      schema: WALKTHROUGH_SCHEMA, ...SUB, label: 'walkthrough', phase: 'Prepare',
    }),
])

if (!personaResult || !walk) throw new Error('준비 단계 실패: 페르소나 또는 제품 설명서가 비어 있음')
const personas = personaResult.personas
const features = walk.features
const featureIds = features.map((f) => f.id)
log(`페르소나 ${personas.length}명: ${personas.map((p) => p.role).join(', ')} / 기능 ${features.length}개`)

// ---------- per-persona: stories → interview → extract ----------
// skipInterviewer=true면 인터뷰어 호출 없이 stories가 만든 질문을 그대로 응답자에게 던진다 (턴당 호출 1개 절약).
async function runInterviewSkipInterviewer(p, questions) {
  const transcript = []
  const chunks = chunkQuestions(questions, maxTurns)
  for (let t = 0; t < chunks.length; t++) {
    const chunk = chunks[t]
    if (!chunk.length) break
    const a = await agent(
      withPrompt('05-respondent.md', {
        '당신': personaCard(p),
        '당신이 소개받은 제품': walk.walkthrough,
        '지금까지의 대화': transcriptText(transcript),
        '인터뷰어의 질문': chunk.map((x, i) => `${i + 1}. ${x.question}`).join('\n'),
      }),
      { schema: ANSWER_SCHEMA, ...SUB_LOW, label: `${p.slug} A${t + 1}`, phase: 'Interview' },
    )
    if (!a) break
    transcript.push({ turn: t + 1, questions: chunk.map((x) => x.question), answer: a.answer })
  }
  return transcript
}

async function runInterview(p, questions) {
  if (skipInterviewer) return runInterviewSkipInterviewer(p, questions)
  const transcript = []
  for (let t = 0; t < maxTurns; t++) {
    const q = await agent(
      withPrompt('04-interviewer.md', {
        '페르소나': personaCard(p),
        '준비된 질문 목록': questions.map((x, i) => `${i + 1}. (${x.storyId}) ${x.question}`).join('\n'),
        '지금까지의 대화': transcriptText(transcript),
        '턴 정보': `턴 ${t + 1}/${maxTurns}`,
      }),
      { schema: INTERVIEWER_SCHEMA, ...SUB, label: `${p.slug} Q${t + 1}`, phase: 'Interview' },
    )
    if (!q || !q.questions || !q.questions.length) break

    const a = await agent(
      withPrompt('05-respondent.md', {
        '당신': personaCard(p),
        '당신이 소개받은 제품': walk.walkthrough,
        '지금까지의 대화': transcriptText(transcript),
        '인터뷰어의 질문': q.questions.map((x, i) => `${i + 1}. ${x}`).join('\n'),
      }),
      { schema: ANSWER_SCHEMA, ...SUB_LOW, label: `${p.slug} A${t + 1}`, phase: 'Interview' },
    )
    if (!a) break
    transcript.push({ turn: t + 1, questions: q.questions, answer: a.answer })
    if (q.done) break
  }
  return transcript
}

async function runPersona(p) {
  const s = await agent(
    withPrompt('03-stories.md', {
      'PRD 경로': prdPath,
      '페르소나': personaCard(p),
      '기능 목록': features,
      '저장 경로': `${outDir}/stories/${p.slug}.md`,
    }),
    { schema: STORIES_SCHEMA, ...SUB, label: `${p.slug} stories`, phase: 'Stories' },
  )
  if (!s) return null

  const transcript = await runInterview(p, s.questions)
  if (!transcript.length) return null

  const ex = await agent(
    withPrompt('06-extract.md', {
      '페르소나': personaCard(p),
      '기능 목록': features,
      '전사': transcriptText(transcript),
      '저장 경로': `${outDir}/interviews/${p.slug}.md`,
    }),
    { schema: EXTRACT_SCHEMA, ...SUB_LOW, label: `${p.slug} extract`, phase: 'Extract' },
  )
  if (!ex) return null
  return {
    persona: p,
    transcript,
    painPoints: ex.painPoints.map((pp, i) => ({ ...pp, id: `${p.slug}-${i + 1}`, persona: p.role })),
    featuresDiscussed: ex.featuresDiscussed,
  }
}

// 페르소나 하나가 stories→interview→extract를 끝내는 대로 그 페르소나의 불편사항만 바로 검증한다.
// (다른 페르소나 인터뷰가 아직 진행 중이어도 병행되므로, 전원이 끝나길 기다리는 배리어가 없다.)
async function verifyPersonaResult(result) {
  if (!result) return null
  const verifiedPainPoints = (
    await pipeline(result.painPoints, (pp) =>
      agent(
        withPrompt('08-verify.md', {
          '페르소나': personaCard(result.persona),
          '제품 소개서': walk.walkthrough,
          '불편사항': pp,
        }),
        { schema: VERDICT_SCHEMA, ...SUB, label: `verify ${pp.id}`, phase: 'Verify' },
      ).then((v) => ({ ...pp, refuted: v ? v.refuted : false, verdictReason: v ? v.reason : '검증 실패(에이전트 응답 없음), 통과 처리' })),
    )
  ).filter(Boolean)
  return { ...result, painPoints: verifiedPainPoints }
}

// ---------- Single round: 페르소나별 인터뷰 → 그 페르소나 검증을 하나의 파이프라인으로 ----------
log('인터뷰 1회 + 불편사항 검증 시작 (페르소나별 파이프라인, 라운드 배리어 없음)')
const results = (await pipeline(personas, (p) => runPersona(p), (r) => verifyPersonaResult(r))).filter(Boolean)
const discussed = new Set(results.flatMap((r) => r.featuresDiscussed))
const seen = results.flatMap((r) => r.painPoints)
const uncoveredFinal = featureIds.filter((id) => !discussed.has(id))
const passed = seen.filter((x) => !x.refuted)
const rejected = seen.filter((x) => x.refuted)
log(`인터뷰 ${results.length}건, 불편사항 ${seen.length}개(통과 ${passed.length}, 탈락 ${rejected.length}), 미커버 기능 ${uncoveredFinal.length}개`)
if (uncoveredFinal.length) log(`주의: 다뤄지지 않은 기능 ${uncoveredFinal.join(', ')}`)

// ---------- Questions: pain-points.md + 사람에게 물을 질문 ----------
phase('Questions')
const runSummary = `인터뷰 1회 (페르소나당 최대 ${maxTurns}턴), 다뤄지지 않은 기능: ${uncoveredFinal.length ? uncoveredFinal.join(', ') : '없음'}`
const transcripts = results.map((r) => `### ${r.persona.role} (${r.persona.name})\n${transcriptText(r.transcript)}`).join('\n\n')

const [painDoc, oq] = await parallel([
  () =>
    agent(
      withPrompt('09-pain-points.md', {
        '실행 요약': runSummary,
        '기능 목록': features,
        '통과': passed,
        '탈락': rejected,
        '저장 경로': files.painPoints,
      }),
      { schema: OK_SCHEMA, ...SUB_LOW, label: 'pain-points.md', phase: 'Questions' },
    ),
  () =>
    agent(
      withPrompt('11-open-questions.md', {
        '제품 소개서': walk.walkthrough,
        '기능 목록': features,
        '다뤄지지 않은 기능': uncoveredFinal.length ? featureNames(uncoveredFinal) : '없음',
        '페르소나': personas,
        '검증 통과 불편사항': passed,
        '인터뷰 전사': transcripts,
        '저장 경로': files.openQuestions,
      }),
      { schema: QUESTIONS_SCHEMA, ...SUB, label: 'open-questions.md', phase: 'Questions' },
    ),
])
const questions = oq ? oq.questions : []
log(`사람에게 물을 질문 ${questions.length}개`)

return {
  stage: 'interview',
  personas: personas.map((p) => p.role),
  features: features.length,
  painPoints: { passed: passed.length, rejected: rejected.length },
  uncoveredFeatures: uncoveredFinal,
  questions,
  files: [files.personas, files.walkthrough, `${outDir}/stories/`, `${outDir}/interviews/`, files.painPoints, files.openQuestions],
  painDocWritten: !!(painDoc && painDoc.ok),
  nextStep: `위 questions를 워크플로우를 돌리는 사람에게 물어 답을 받은 뒤, 같은 scriptPath로 args: { stage: 'revise', prdPath, outDir, promptsDir, answers: [{ id, answer }] } 를 넘겨 다시 실행하면 PRD-v2.md가 만들어진다.`,
}
