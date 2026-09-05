export const meta = {
  name: 'proto-to-figma',
  description: '프로토타입 코드에서 화면·플로우를 추출해 Figma에 화면 프레임과 플로우 연결을 만든다 (2단계: extract → build)',
  whenToUse: 'args.stage 기본값은 extract. args: {protoDir, designMdPath, outDir, promptsDir} → flow.json, screens.md. 사람이 screens.md를 보고 뺄 화면/합칠 화면을 정하면, args: {stage:"build", outDir, promptsDir, devUrl, figmaFileKey, flow, decisions, concurrency?} 로 다시 실행한다.',
  phases: [
    { title: 'Extract', detail: '프로토타입 코드에서 화면·전이 추출', model: 'sonnet' },
    { title: 'Preflight', detail: '환경 점검 (dev 서버·Figma MCP·fileKey·샘플 캡처)', model: 'sonnet' },
    { title: 'Capture', detail: '화면별 Figma 캡처 (concurrency 제한 병렬)', model: 'sonnet' },
    { title: 'Connect', detail: '배치 + 플로우 연결', model: 'sonnet' },
    { title: 'Report', detail: 'result.md 작성', model: 'sonnet' },
  ],
}

const promptsDir = args && args.promptsDir
const outDir = args && args.outDir
if (!promptsDir || !outDir) throw new Error('args.promptsDir, args.outDir (절대경로)가 필요합니다')
const stage = (args && args.stage) || 'extract'

const SUB = { model: 'sonnet', effort: 'medium' }
const SUB_LOW = { model: 'sonnet', effort: 'low' }

function withPrompt(file, inputs) {
  const body = Object.entries(inputs)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `## ${k}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)
    .join('\n\n')
  return `먼저 Read 도구로 아래 프롬프트 파일을 읽고, 그 지시를 그대로 따라라. 아래 "# 입력" 블록이 프롬프트가 말하는 \`입력 > 이름\`이다.\n프롬프트 파일: ${promptsDir}/${file}\n\n# 입력\n\n${body}`
}

const files = {
  flow: `${outDir}/flow.json`,
  screens: `${outDir}/screens.md`,
  result: `${outDir}/result.md`,
}

const SCREEN_ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    path: { type: 'string' },
    query: { type: 'string' },
    reachable: { type: 'boolean' },
    sourceFiles: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['id', 'name', 'role', 'path', 'query', 'reachable', 'sourceFiles', 'note'],
}

const EDGE_ITEM = {
  type: 'object',
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    trigger: { type: 'string' },
    sourceFile: { type: 'string' },
  },
  required: ['from', 'to', 'trigger', 'sourceFile'],
}

const EXTRACT_FLOW_SCHEMA = {
  type: 'object',
  properties: {
    screens: { type: 'array', items: SCREEN_ITEM },
    edges: { type: 'array', items: EDGE_ITEM },
    entry: { type: 'string' },
    commonNav: { type: 'array', items: { type: 'string' } },
  },
  required: ['screens', 'edges', 'entry', 'commonNav'],
}

// decisions를 flow에 반영: drop은 제거, merge는 into로 흡수. reachable:false는 항상 제외.
function applyDecisions(flow, decisions) {
  const drop = new Set(decisions.filter((d) => d.action === 'drop').map((d) => d.id))
  const mergeMap = new Map(
    decisions.filter((d) => d.action === 'merge').map((d) => [d.id, d.into]),
  )
  const resolve = (id) => {
    const visited = new Set()
    let cur = id
    while (mergeMap.has(cur)) {
      if (visited.has(cur)) break
      visited.add(cur)
      cur = mergeMap.get(cur)
    }
    return cur
  }

  const screens = flow.screens
    .filter((s) => s.reachable)
    .filter((s) => !drop.has(s.id))
    .filter((s) => !mergeMap.has(s.id))

  const validIds = new Set(screens.map((s) => s.id))

  const edges = []
  const seen = new Set()
  for (const e of flow.edges) {
    if (drop.has(e.from) || drop.has(e.to)) continue
    const from = resolve(e.from)
    const to = resolve(e.to)
    if (drop.has(from) || drop.has(to)) continue
    if (!validIds.has(from) || !validIds.has(to)) continue
    if (from === to) continue
    const key = `${from}->${to}:${e.trigger}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ ...e, from, to })
  }

  const entry = drop.has(flow.entry) ? screens[0] && screens[0].id : resolve(flow.entry)
  return { screens, edges, entry, commonNav: flow.commonNav }
}

// =====================================================================
// stage: extract
// =====================================================================
if (stage === 'extract') {
  const protoDir = args && args.protoDir
  const designMdPath = args && args.designMdPath
  if (!protoDir || !designMdPath) throw new Error('stage=extract 에는 args.protoDir, args.designMdPath (절대경로)가 필요합니다')

  phase('Extract')
  log('프로토타입 코드에서 화면·플로우 추출 시작')
  const flow = await agent(
    withPrompt('01-extract.md', {
      '프로토타입 경로': protoDir,
      'design.md 경로': designMdPath,
      '저장 경로(flow.json)': files.flow,
      '저장 경로(screens.md)': files.screens,
    }),
    { schema: EXTRACT_FLOW_SCHEMA, ...SUB, label: 'extract', phase: 'Extract' },
  )
  if (!flow) throw new Error('Extract 실패: 에이전트가 결과를 반환하지 않음')

  const unreachable = flow.screens.filter((s) => !s.reachable).map((s) => s.id)
  log(`화면 ${flow.screens.length}개, 전이 ${flow.edges.length}개, 도달 불가 ${unreachable.length}개`)

  return {
    stage: 'extract',
    screens: flow.screens.length,
    edges: flow.edges.length,
    unreachable,
    files: [files.flow, files.screens],
    flow,
    nextStep: 'screens.md를 사용자에게 보여주고 빼거나 합칠 화면을 받는다. 답을 decisions로 넣어 stage: "build"로 다시 실행한다 (args.flow에는 이번 반환값의 flow를 그대로 넘긴다).',
  }
}

// stage: build는 Task 4, 5에서 이어서 작성
throw new Error(`알 수 없는 stage: ${stage}`)
