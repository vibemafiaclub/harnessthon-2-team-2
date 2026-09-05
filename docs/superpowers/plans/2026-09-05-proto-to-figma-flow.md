# proto-to-figma-flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프로토타입 코드(라우팅이 동작하는 페이지)와 `design.md`에서 화면·플로우를 자동 추출하고, 사람 확인을 거쳐 Figma에 화면 프레임과 플로우 연결을 만드는 2단계 Workflow를 만든다.

**Architecture:** `prd-interview` 워크플로우와 같은 관례(단일 `workflow.js` + `args.stage`로 분기 + `prompts/*.md`를 에이전트가 Read로 읽음)를 따르는 Workflow 스크립트 하나. 1단계(`extract`)는 에이전트 1개가 코드를 읽어 `flow.json`/`screens.md`를 만든다. 2단계(`build`)는 Preflight(환경 점검) → Capture(화면별 Figma 캡처, concurrency 제한 병렬) → Connect(배치+연결, `use_figma` 1회) → Report 순으로 진행하며, Figma MCP·Playwright MCP는 서브에이전트가 `ToolSearch`로 로드해 직접 호출한다(스파이크로 확인됨).

**Tech Stack:** Claude Code Workflow 스크립트(plain JS, no TS), Figma MCP(`generate_figma_design`, `use_figma`, `whoami`, `get_metadata`), Playwright MCP(폴백), 로컬 Node 프로토타입(테스트용 fixture).

**Spec:** `docs/superpowers/specs/2026-09-05-proto-to-figma-flow-design.md`

## Global Constraints

- 모든 경로 입력(`protoDir`, `designMdPath`, `outDir`, `promptsDir`)은 절대경로다.
- 워크플로우 에이전트는 전부 `model: 'sonnet'`. effort: Extract·Connect는 `'medium'`, Preflight·Capture·Report는 `'low'`.
- 스크립트는 Node/파일시스템 API를 쓸 수 없다 (`Date.now()`, `Math.random()`, `new Date()` 금지). 파일 내용은 에이전트가 Write/Read로 다루고, 스크립트는 `args`로 받은 값과 에이전트 반환값만 가공한다.
- Capture는 `pipeline()`이 아니라 `args.concurrency`(기본 3) 크기로 자른 `parallel()` 반복문으로 돈다 (Figma rate limit 보호, Workflow의 기본 동시 cap 16보다 낮춰야 함).
- 화면 하나의 Capture 실패가 전체 실행을 죽여선 안 된다. 실패는 `captureFailed` 배열에 담고 계속 진행한다 (no silent caps: 실패 목록은 항상 `result.md`와 반환값에 남는다).
- `stage: 'build'`는 Preflight가 `ok: false`면 Capture·Connect를 실행하지 않고 즉시 반환한다.
- Figma·Playwright MCP 서버는 레포 루트 `.mcp.json`에 이미 설정돼 있다 (Figma: `https://mcp.figma.com/mcp` http 타입, Playwright: `npx @playwright/mcp@0.0.80`). 다른 컴퓨터에서 이 레포를 열어도 새로 설정할 필요 없이 프로젝트 MCP 서버 승인만 하면 된다. Figma는 최초 1회 OAuth 로그인이 필요하다.
- 프롬프트 파일 관례: 스크립트는 `# 입력` 아래에 이름 붙인 블록만 프롬프트에 붙이고, 각 프롬프트 md는 `Read` 도구로 자기 파일을 먼저 읽게 지시한다 (`.claude/workflows/prd-interview/workflow.js`의 `withPrompt` 패턴 그대로 재사용).
- Figma MCP·Playwright MCP를 쓰는 프롬프트는 첫 줄에 `ToolSearch`로 로드할 정확한 도구 이름을 적는다.

---

## 파일 구조

```
.claude/workflows/proto-to-figma/
  README.md
  workflow.js
  prompts/
    00-preflight.md
    01-extract.md
    02-capture.md
    03-connect.md
    04-report.md
```

테스트용 최소 프로토타입 fixture(라우팅 동작 확인용, 실제 wedding-scheduler 프로토타입이 아직 없으므로):

```
docs/superpowers/plans/fixtures/proto-to-figma/
  package.json
  vite.config.js
  index.html
  src/main.jsx
  src/App.jsx          # react-router 라우트 3개 + Link 2개
  src/pages/Home.jsx
  src/pages/List.jsx
  src/pages/Detail.jsx
  design.md
```

이 fixture는 Task 1에서 Extract 에이전트 검증에 쓰고, Task 6(전체 통합 테스트)에서 dev 서버로 띄워 Capture까지 검증한다.

---

### Task 1: 테스트 fixture 프로토타입 만들기

**Files:**
- Create: `docs/superpowers/plans/fixtures/proto-to-figma/package.json`
- Create: `docs/superpowers/plans/fixtures/proto-to-figma/vite.config.js`
- Create: `docs/superpowers/plans/fixtures/proto-to-figma/index.html`
- Create: `docs/superpowers/plans/fixtures/proto-to-figma/src/main.jsx`
- Create: `docs/superpowers/plans/fixtures/proto-to-figma/src/App.jsx`
- Create: `docs/superpowers/plans/fixtures/proto-to-figma/src/pages/Home.jsx`
- Create: `docs/superpowers/plans/fixtures/proto-to-figma/src/pages/List.jsx`
- Create: `docs/superpowers/plans/fixtures/proto-to-figma/src/pages/Detail.jsx`
- Create: `docs/superpowers/plans/fixtures/proto-to-figma/design.md`

**Interfaces:**
- Produces: 라우트 3개(`/`, `/list`, `/list/:id`), `Home → List`(Link), `List → Detail`(Link), Vite dev 서버로 `npm run dev` 시 `http://localhost:5173`에서 뜬다. Task 2(Extract 프롬프트)와 Task 6(build 통합 테스트)이 이 구조를 그대로 전제한다.

이 fixture는 Extract 에이전트가 "라우터 정의에서 화면 후보를 뽑고 `<Link>`에서 전이를 찾는다"는 스펙 §5를 검증할 최소 대상이다. 실제 wedding-scheduler 프로토타입이 나오기 전까지 이 fixture로 워크플로우 자체를 검증한다.

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "proto-to-figma-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port 5173"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: vite.config.js 작성**

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
```

- [ ] **Step 3: index.html 작성**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Fixture</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 4: src/main.jsx 작성**

```jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
```

- [ ] **Step 5: src/App.jsx 작성**

```jsx
import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home.jsx'
import List from './pages/List.jsx'
import Detail from './pages/Detail.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/list" element={<List />} />
      <Route path="/list/:id" element={<Detail />} />
    </Routes>
  )
}
```

- [ ] **Step 6: src/pages/Home.jsx 작성**

```jsx
import { Link } from 'react-router-dom'

export default function Home() {
  return (
    <div>
      <h1>홈</h1>
      <Link to="/list">목록 보기</Link>
    </div>
  )
}
```

- [ ] **Step 7: src/pages/List.jsx 작성**

```jsx
import { Link } from 'react-router-dom'

export default function List() {
  return (
    <div>
      <h1>목록</h1>
      <Link to="/list/1">항목 1 상세</Link>
    </div>
  )
}
```

- [ ] **Step 8: src/pages/Detail.jsx 작성**

```jsx
import { useParams } from 'react-router-dom'

export default function Detail() {
  const { id } = useParams()
  return (
    <div>
      <h1>상세 {id}</h1>
    </div>
  )
}
```

- [ ] **Step 9: design.md 작성**

```markdown
# Design Tokens (fixture)

- Background: #FFFFFF
- Text: #111111
- Accent: #3B82F6
- Spacing grid: 8px
- Font: system-ui
```

- [ ] **Step 10: 의존성 설치 후 dev 서버로 확인**

Run:
```bash
cd docs/superpowers/plans/fixtures/proto-to-figma && npm install && npm run dev &
sleep 3 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/
kill %1
```
Expected: `200`

- [ ] **Step 11: Commit**

```bash
git add docs/superpowers/plans/fixtures/proto-to-figma
git commit -m "test: proto-to-figma 검증용 최소 fixture 프로토타입 추가"
```

---

### Task 2: Extract 프롬프트 + workflow.js stage=extract

**Files:**
- Create: `.claude/workflows/proto-to-figma/prompts/01-extract.md`
- Create: `.claude/workflows/proto-to-figma/workflow.js`

**Interfaces:**
- Consumes: `args.protoDir`, `args.designMdPath`, `args.outDir`, `args.promptsDir` (문자열, 모두 절대경로 필수 — 없으면 `throw new Error`).
- Produces: `PERSONAS` 없음. `EXTRACT_FLOW_SCHEMA`로 강제된 반환값 `{ screens: [...], edges: [...], entry, commonNav: [...] }` (스펙 §5 flow.json 스키마와 동일). Task 3이 이 스키마를 `args.flow`로 받는다.

- [ ] **Step 1: 01-extract.md 작성**

```markdown
# 화면·플로우 추출

`입력 > 프로토타입 경로`의 소스를 읽고, `입력 > design.md 경로`를 참고해 화면 목록과 화면 간 전이를 뽑는다.

1. 라우터 정의를 찾는다 — react-router `<Route path=... element=...>`, Next.js `app/`·`pages/` 디렉토리 구조, 정적 HTML은 파일 목록. 각 라우트를 화면 후보로 삼는다.
2. 각 화면 파일 안에서 전이를 찾는다: `<Link to=...>`, `<a href=...>`, `navigate(...)`, `router.push(...)`, `window.location`, 모달/드로어/상태 토글을 여는 클릭 핸들러.
3. 같은 URL 안에서 조건부로 보이는 다른 뷰(모달, 빈 상태, 에러 상태)는 별도 화면 노드로 만든다. 그 뷰를 강제하는 쿼리 파라미터가 코드에 있으면 `query`에 적고 `reachable: true`. 없으면 `query: ""`, `reachable: false`.
4. `design.md`는 화면 이름·역할을 자연스럽게 붙일 때만 참고한다. 토큰 값을 화면 데이터에 넣지 않는다.
5. 뒤로가기·탭바처럼 **모든 화면에 공통으로 있는** 전이는 `edges`에 넣지 않고 `commonNav`에 한 줄씩 요약한다.
6. `entry`는 앱의 첫 화면 id(루트 라우트).
7. 결과를 Write 도구로 `입력 > 저장 경로(flow.json)`에는 JSON으로, `입력 > 저장 경로(screens.md)`에는 화면 목록 표(id, 이름, URL, 진입 방법, 비고 — reachable:false인 화면은 비고에 이유를 적는다)로 저장한다. 그리고 같은 내용을 구조화 출력으로도 반환하라.
```

- [ ] **Step 2: workflow.js 뼈대 + stage=extract 작성**

```js
export const meta = {
  name: 'proto-to-figma',
  description: '프로토타입 코드에서 화면·플로우를 추출해 Figma에 화면 프레임과 플로우 연결을 만든다 (2단계: extract → build)',
  whenToUse: 'args.stage 기본값은 extract. args: {protoDir, designMdPath, outDir, promptsDir} → flow.json, screens.md. 사람이 screens.md를 보고 뺄 화면/합칠 화면을 정하면, args: {stage:"build", outDir, promptsDir, devUrl, flow, decisions, figmaFileKey?, figmaFileName?, concurrency?} 로 다시 실행한다. figmaFileKey를 안 주면 새 Figma 파일을 자동으로 만든다.',
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
```

- [ ] **Step 3: 문법 검증 (스크립트가 plain JS로 파싱되는지)**

Run: `node --check .claude/workflows/proto-to-figma/workflow.js`
Expected: 에러 없이 종료

- [ ] **Step 4: Workflow 도구로 stage=extract 실행 (fixture 대상)**

Task 1의 fixture 경로를 절대경로로 채워 `Workflow({ scriptPath: ".claude/workflows/proto-to-figma/workflow.js", args: { protoDir: "<repo>/docs/superpowers/plans/fixtures/proto-to-figma/src", designMdPath: "<repo>/docs/superpowers/plans/fixtures/proto-to-figma/design.md", outDir: "<repo>/docs/superpowers/plans/fixtures/proto-to-figma/out", promptsDir: "<repo>/.claude/workflows/proto-to-figma/prompts" } })`로 실행.

Expected: 반환값의 `screens`가 3 이상(`/`, `/list`, `/list/:id`), `edges`가 2 이상(Home→List, List→Detail), `unreachable`이 빈 배열, `outDir/flow.json`과 `outDir/screens.md`가 실제로 생성됨.

- [ ] **Step 5: Commit**

```bash
git add .claude/workflows/proto-to-figma/workflow.js .claude/workflows/proto-to-figma/prompts/01-extract.md
git commit -m "feat: proto-to-figma stage=extract — 프로토타입에서 화면·플로우 추출"
```

---

### Task 3: decisions 반영 로직 (순수 함수, 에이전트 없음)

**Files:**
- Modify: `.claude/workflows/proto-to-figma/workflow.js`

**Interfaces:**
- Consumes: Task 2가 만든 `EXTRACT_FLOW_SCHEMA` 모양의 객체(`args.flow`), `args.decisions` (`[{id, action: 'drop'|'merge', into?}]`).
- Produces: `applyDecisions(flow, decisions)` 함수 — `{ screens, edges, entry, commonNav }`를 반환. Task 4(Capture)와 Task 5(Connect)가 이 함수의 출력을 입력으로 받는다.

이 로직은 스크립트가 직접 처리한다 (스펙 §6 "에이전트 없이 스크립트가 처리"). 테스트는 워크플로우 실행이 아니라 순수 함수 단위 테스트로 한다 — 별도 Node 스크립트로 `workflow.js`에서 함수를 잘라 실행할 수는 없으므로(모듈 export가 없는 워크플로우 스크립트 형식), 임시 테스트 파일에 같은 로직을 복사해 검증한 뒤 본 파일에 반영한다.

- [ ] **Step 1: 임시 테스트 파일에 로직 작성 후 검증**

Create `/tmp/test-apply-decisions.mjs` (repo 밖, 순수 로직 검증용이라 스크래치패드에 둔다):

```js
function applyDecisions(flow, decisions) {
  const drop = new Set(decisions.filter((d) => d.action === 'drop').map((d) => d.id))
  const mergeMap = new Map(
    decisions.filter((d) => d.action === 'merge').map((d) => [d.id, d.into]),
  )
  const resolve = (id) => {
    let cur = id
    while (mergeMap.has(cur)) cur = mergeMap.get(cur)
    return cur
  }

  const screens = flow.screens
    .filter((s) => s.reachable)
    .filter((s) => !drop.has(s.id))
    .filter((s) => !mergeMap.has(s.id))

  const edges = []
  const seen = new Set()
  for (const e of flow.edges) {
    if (drop.has(e.from) || drop.has(e.to)) continue
    const from = resolve(e.from)
    const to = resolve(e.to)
    if (drop.has(from) || drop.has(to)) continue
    if (from === to) continue
    const key = `${from}->${to}:${e.trigger}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ ...e, from, to })
  }

  const entry = drop.has(flow.entry) ? screens[0]?.id : resolve(flow.entry)
  return { screens, edges, entry, commonNav: flow.commonNav }
}

// --- 테스트 ---
const flow = {
  screens: [
    { id: 'S1', reachable: true },
    { id: 'S2', reachable: true },
    { id: 'S3', reachable: true },
    { id: 'S4', reachable: true },
    { id: 'S7', reachable: false },
  ],
  edges: [
    { from: 'S1', to: 'S2', trigger: 'a' },
    { from: 'S2', to: 'S4', trigger: 'b' },
    { from: 'S3', to: 'S4', trigger: 'c' },
  ],
  entry: 'S1',
  commonNav: [],
}
const decisions = [
  { id: 'S4', action: 'drop' },
  { id: 'S3', action: 'merge', into: 'S2' },
]
const result = applyDecisions(flow, decisions)

console.assert(result.screens.map((s) => s.id).sort().join(',') === 'S1,S2', 'screens 실패: ' + JSON.stringify(result.screens))
console.assert(result.edges.length === 1 && result.edges[0].from === 'S1' && result.edges[0].to === 'S2', 'edges 실패: ' + JSON.stringify(result.edges))
console.assert(!result.screens.some((s) => s.id === 'S7'), 'unreachable 화면이 남음')
console.log('OK')
```

Run: `node /tmp/test-apply-decisions.mjs`
Expected: `OK` 출력, assert 실패 없음

- [ ] **Step 2: 검증된 함수를 workflow.js에 반영**

`.claude/workflows/proto-to-figma/workflow.js`의 `EXTRACT_FLOW_SCHEMA` 정의 아래, `stage: 'extract'` 블록 위에 삽입:

```js
// decisions를 flow에 반영: drop은 제거, merge는 into로 흡수. reachable:false는 항상 제외.
function applyDecisions(flow, decisions) {
  const drop = new Set(decisions.filter((d) => d.action === 'drop').map((d) => d.id))
  const mergeMap = new Map(
    decisions.filter((d) => d.action === 'merge').map((d) => [d.id, d.into]),
  )
  const resolve = (id) => {
    let cur = id
    while (mergeMap.has(cur)) cur = mergeMap.get(cur)
    return cur
  }

  const screens = flow.screens
    .filter((s) => s.reachable)
    .filter((s) => !drop.has(s.id))
    .filter((s) => !mergeMap.has(s.id))

  const edges = []
  const seen = new Set()
  for (const e of flow.edges) {
    if (drop.has(e.from) || drop.has(e.to)) continue
    const from = resolve(e.from)
    const to = resolve(e.to)
    if (drop.has(from) || drop.has(to)) continue
    if (from === to) continue
    const key = `${from}->${to}:${e.trigger}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ ...e, from, to })
  }

  const entry = drop.has(flow.entry) ? screens[0] && screens[0].id : resolve(flow.entry)
  return { screens, edges, entry, commonNav: flow.commonNav }
}
```

- [ ] **Step 3: node --check로 문법 확인**

Run: `node --check .claude/workflows/proto-to-figma/workflow.js`
Expected: 에러 없이 종료

- [ ] **Step 4: Commit**

```bash
git add .claude/workflows/proto-to-figma/workflow.js
git commit -m "feat: proto-to-figma — decisions(drop/merge) 반영 순수 함수 추가"
```

---

### Task 4: Preflight 프롬프트 + stage=build 진입부

**Files:**
- Create: `.claude/workflows/proto-to-figma/prompts/00-preflight.md`
- Modify: `.claude/workflows/proto-to-figma/workflow.js`

**Interfaces:**
- Consumes: `args.devUrl`, `args.figmaFileKey`(옵션), `args.figmaFileName`(옵션, 기본 `"proto-to-figma"`), `args.flow`, `args.decisions`(옵션, 기본 `[]`).
- Produces: `PREFLIGHT_SCHEMA`로 강제된 `{ ok, checks: {figmaConnected, fileKeyValid, fileCreated, devServer, sampleCapture}, message, figmaFileKey, figmaFileUrl, sampleScreenId, sampleFigmaNodeId, sampleCaptureError, fileCreateError }`. `ok:false`면 스크립트가 즉시 반환하고 Task 5(Capture)를 실행하지 않는다. `ok:true`면 이후 Capture·Connect·Report는 (사람이 준 것이든 새로 만든 것이든) `preflight.figmaFileKey`를 쓰고, Task 5가 `sampleScreenId`/`sampleFigmaNodeId`를 재사용해 그 화면을 다시 캡처하지 않는다.

**사람이 Figma 파일을 미리 만들어 오지 않아도 된다.** `figmaFileKey`가 없으면 Preflight가 `whoami`로 plan을 찾아 자동으로 새 파일을 만든다.

- [ ] **Step 1: 00-preflight.md 작성**

```markdown
# 환경 점검 (Preflight)

`ToolSearch`로 다음 도구를 로드하라: `mcp__plugin_figma_figma__whoami`, `mcp__plugin_figma_figma__get_metadata`, `mcp__plugin_figma_figma__create_new_file`, `mcp__plugin_figma_figma__generate_figma_design`. 필요하면 Playwright MCP 도구도 검색해 로드하라 (`select:mcp__plugin_playwright_playwright__browser_navigate` 등).

캡처를 실제로 시작하기 전에, 이 환경에서 실행 가능한지 아래 순서로 확인한다. 하나라도 실패하면 그 이후 점검은 생략해도 된다.

1. **Figma MCP 연결 확인**: `whoami`를 인자 없이 호출한다. 성공하면 `checks.figmaConnected = true`. 이 호출의 `plans` 배열은 다음 단계에서도 쓴다.
2. **figmaFileKey 확정**:
   - `입력 > figmaFileKey`가 있으면: `get_metadata({ fileKey })`를 호출한다. 파일 정보가 오면 `checks.fileKeyValid = true`, `figmaFileKey`에 그 값을 그대로, `figmaFileUrl`에 `https://figma.com/design/<fileKey>`를 담는다. 실패하면 `checks.fileKeyValid = false`.
   - `입력 > figmaFileKey`가 없으면: 1번에서 받은 `plans` 배열의 첫 번째 plan의 `key`를 `planKey`로 써서 `create_new_file({ planKey, fileName: 입력 > figmaFileName (없으면 "proto-to-figma"), editorType: 'design' })`를 호출한다. plan이 여러 개면 첫 번째를 쓰고 그 사실을 `message`에 남긴다. 성공하면 `checks.fileCreated = true`, 반환된 `file_key`를 `figmaFileKey`에, `file_url`을 `figmaFileUrl`에 담는다. 실패하면 `checks.fileCreated = false`, 에러 원문을 `fileCreateError`에 담는다. (이 경우 `checks.fileKeyValid`은 `true`로 둔다 — 사람이 준 키가 아예 없어 이 점검 자체가 해당 없음.)
3. **dev 서버 응답 확인**: `입력 > devUrl`에 HTTP 요청을 보낸다 (curl 또는 도구가 제공하는 fetch). 응답이 오면 `checks.devServer = true`.
4. **샘플 캡처**: 2번에서 확정된 `figmaFileKey`로, `입력 > 화면 목록`에서 첫 번째 화면 하나를 골라 실제로 `generate_figma_design({ fileKey })` → 반환된 캡처 스크립트를 `devUrl + path + query`에 대해 실행 → `captureId`로 5초 간격 최대 10회 폴링까지 전부 실행한다. 완료되면 `checks.sampleCapture = true`, 생성된 노드 id를 `sampleFigmaNodeId`에, 그 화면의 id를 `sampleScreenId`에 담는다. 실패하면 `checks.sampleCapture = false`, 에러 원문을 `sampleCaptureError`에 담는다.

전부 `true`면 `ok: true` (`figmaFileKey`, `figmaFileUrl` 포함). 하나라도 `false`면 `ok: false`이고, `message`에는 실패한 항목의 안내문만 모아 적는다:
- figmaConnected 실패: "Figma MCP가 연결되지 않았습니다. Claude Code에서 Figma 플러그인 로그인 상태를 확인하세요."
- fileKeyValid 실패(전달된 키가 있을 때만): "전달된 figmaFileKey가 잘못됐거나 접근 권한이 없습니다."
- fileCreated 실패(키를 안 줬을 때만): "새 Figma 파일 생성에 실패했습니다: " + fileCreateError
- devServer 실패: "devUrl에서 응답이 없습니다. 프로토타입 dev 서버(npm run dev 등)를 먼저 실행하세요."
- sampleCapture 실패: "대표 화면 캡처에 실패했습니다: " + sampleCaptureError

출력 스키마의 모든 필드(`figmaFileKey`, `figmaFileUrl`, `fileCreateError` 등)는 해당 없는 경우 빈 문자열로 채워라 (JSON Schema가 필수 필드로 요구한다).
```

- [ ] **Step 2: workflow.js에 PREFLIGHT_SCHEMA와 stage=build 진입부 추가**

`.claude/workflows/proto-to-figma/workflow.js`의 `// stage: build는 Task 4, 5에서 이어서 작성` 줄과 `throw new Error(...)` 줄 사이를 아래로 교체:

```js
const PREFLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    checks: {
      type: 'object',
      properties: {
        figmaConnected: { type: 'boolean' },
        fileKeyValid: { type: 'boolean' },
        fileCreated: { type: 'boolean' },
        devServer: { type: 'boolean' },
        sampleCapture: { type: 'boolean' },
      },
      required: ['figmaConnected', 'fileKeyValid', 'fileCreated', 'devServer', 'sampleCapture'],
    },
    message: { type: 'string' },
    figmaFileKey: { type: 'string' },
    figmaFileUrl: { type: 'string' },
    sampleScreenId: { type: 'string' },
    sampleFigmaNodeId: { type: 'string' },
    sampleCaptureError: { type: 'string' },
    fileCreateError: { type: 'string' },
  },
  required: ['ok', 'checks', 'message', 'figmaFileKey', 'figmaFileUrl', 'sampleScreenId', 'sampleFigmaNodeId', 'sampleCaptureError', 'fileCreateError'],
}

// =====================================================================
// stage: build
// =====================================================================
if (stage === 'build') {
  const devUrl = args && args.devUrl
  const figmaFileKeyArg = args && args.figmaFileKey // 옵션 — 없으면 Preflight가 새로 만든다
  const figmaFileName = (args && args.figmaFileName) || 'proto-to-figma'
  const rawFlow = args && args.flow
  const decisions = (args && args.decisions) || []
  const concurrency = (args && args.concurrency) || 3
  if (!devUrl || !rawFlow) {
    throw new Error('stage=build 에는 args.devUrl, args.flow (stage=extract 반환값의 flow)가 필요합니다')
  }

  const flow = applyDecisions(rawFlow, decisions)
  log(`decisions 반영 후 화면 ${flow.screens.length}개, 전이 ${flow.edges.length}개`)

  phase('Preflight')
  const preflight = await agent(
    withPrompt('00-preflight.md', {
      devUrl,
      figmaFileKey: figmaFileKeyArg,
      figmaFileName,
      '화면 목록': flow.screens,
    }),
    { schema: PREFLIGHT_SCHEMA, ...SUB_LOW, label: 'preflight', phase: 'Preflight' },
  )
  if (!preflight || !preflight.ok) {
    const message = preflight ? preflight.message : 'Preflight 에이전트가 응답하지 않았습니다.'
    log(`Preflight 실패: ${message}`)
    return {
      stage: 'build',
      ok: false,
      phase: 'preflight',
      checks: preflight ? preflight.checks : null,
      message,
      nextStep: '안내된 항목을 고친 뒤 같은 args로 다시 실행하세요.',
    }
  }
  const figmaFileKey = preflight.figmaFileKey
  log(`Preflight 통과 (figmaFileKey=${figmaFileKey}, 샘플 화면 ${preflight.sampleScreenId} 캡처 재사용)`)

  // Capture, Connect, Report는 Task 5, 6에서 이어서 작성
  throw new Error('Capture/Connect/Report 미구현 (Task 5, 6에서 추가)')
}

throw new Error(`알 수 없는 stage: ${stage}`)
```

- [ ] **Step 3: node --check로 문법 확인**

Run: `node --check .claude/workflows/proto-to-figma/workflow.js`
Expected: 에러 없이 종료

- [ ] **Step 4: Commit**

```bash
git add .claude/workflows/proto-to-figma/workflow.js .claude/workflows/proto-to-figma/prompts/00-preflight.md
git commit -m "feat: proto-to-figma stage=build — Preflight 환경 점검 추가"
```

---

### Task 5: Capture 프롬프트 + 동시성 제한 루프

**Files:**
- Create: `.claude/workflows/proto-to-figma/prompts/02-capture.md`
- Modify: `.claude/workflows/proto-to-figma/workflow.js`

**Interfaces:**
- Consumes: Task 4의 `preflight.sampleScreenId`/`sampleFigmaNodeId`, `flow.screens`(Task 3 출력), `args.concurrency`.
- Produces: `CAPTURE_SCHEMA`로 강제된 화면별 결과 `{ id, figmaNodeId, ok, error }` 배열. Task 6(Connect)이 `id → figmaNodeId` 매핑을 받는다.

- [ ] **Step 1: 02-capture.md 작성**

```markdown
# 화면 캡처

`ToolSearch`로 `mcp__plugin_figma_figma__generate_figma_design`을 로드하라. 필요하면 Playwright MCP도 검색해 로드하라.

`입력 > 화면`(id, name, path, query) 하나를 Figma에 캡처한다.

1. `generate_figma_design({ fileKey: 입력 > figmaFileKey })`를 호출해 캡처 스크립트와 captureId를 받는다.
2. 받은 캡처 스크립트를 `입력 > devUrl` + `입력 > 화면.path` + `입력 > 화면.query`에 대해 도구가 안내하는 방식으로 실행한다. 로컬 dev 서버는 도구가 직접 열 수 있으면 그렇게 하고, 안 되면 Playwright MCP로 그 URL을 열어 실행한다.
3. captureId로 5초 간격, 최대 10회 폴링해 완료를 기다린다.
4. 완료되면 생성된 노드 id를 확인해 `{ id: 입력 > 화면.id, figmaNodeId, ok: true, error: "" }`를 반환한다.
5. 실패하면 한 번만 더 처음부터 재시도한다. 재시도도 실패하면 `{ id: 입력 > 화면.id, figmaNodeId: "", ok: false, error: <에러 원문> }`을 반환한다. 예외를 던지지 말고 반드시 이 형태로 반환하라.
```

- [ ] **Step 2: workflow.js에 CAPTURE_SCHEMA와 동시성 제한 캡처 루프 추가**

`Preflight 통과 (샘플 화면 ...) 재사용` 로그 다음, `// Capture, Connect, Report는 Task 5, 6에서 이어서 작성` 줄을 아래로 교체:

```js
const CAPTURE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    figmaNodeId: { type: 'string' },
    ok: { type: 'boolean' },
    error: { type: 'string' },
  },
  required: ['id', 'figmaNodeId', 'ok', 'error'],
}

phase('Capture')
const sampleResult = { id: preflight.sampleScreenId, figmaNodeId: preflight.sampleFigmaNodeId, ok: true, error: '' }
const toCapture = flow.screens.filter((s) => s.id !== preflight.sampleScreenId)

const captureResults = [sampleResult]
for (let i = 0; i < toCapture.length; i += concurrency) {
  const batch = toCapture.slice(i, i + concurrency)
  const batchResults = await parallel(
    batch.map((screen) => () =>
      agent(
        withPrompt('02-capture.md', {
          figmaFileKey,
          devUrl,
          화면: screen,
        }),
        { schema: CAPTURE_SCHEMA, ...SUB_LOW, label: `capture ${screen.id}`, phase: 'Capture' },
      ).catch(() => null),
    ),
  )
  batchResults.forEach((r, j) => {
    captureResults.push(r || { id: batch[j].id, figmaNodeId: '', ok: false, error: '에이전트 응답 없음' })
  })
  log(`캡처 진행 ${captureResults.length}/${flow.screens.length}`)
}

const captureFailed = captureResults.filter((r) => !r.ok)
const captureOk = captureResults.filter((r) => r.ok)
log(`캡처 완료: 성공 ${captureOk.length}, 실패 ${captureFailed.length}`)
if (captureFailed.length) log(`캡처 실패 화면: ${captureFailed.map((r) => r.id).join(', ')}`)

// Connect, Report는 Task 6에서 이어서 작성
throw new Error('Connect/Report 미구현 (Task 6에서 추가)')
```

- [ ] **Step 3: node --check로 문법 확인**

Run: `node --check .claude/workflows/proto-to-figma/workflow.js`
Expected: 에러 없이 종료

- [ ] **Step 4: Commit**

```bash
git add .claude/workflows/proto-to-figma/workflow.js .claude/workflows/proto-to-figma/prompts/02-capture.md
git commit -m "feat: proto-to-figma — 화면별 캡처 (concurrency 제한 병렬, 개별 실패 허용)"
```

---

### Task 6: Connect 프롬프트 + Report 프롬프트 + 최종 반환값

**Files:**
- Create: `.claude/workflows/proto-to-figma/prompts/03-connect.md`
- Create: `.claude/workflows/proto-to-figma/prompts/04-report.md`
- Modify: `.claude/workflows/proto-to-figma/workflow.js`

**Interfaces:**
- Consumes: Task 5의 `captureResults`(id→figmaNodeId 매핑), `flow.edges`, `flow.entry`.
- Produces: 최종 워크플로우 반환값 `{ stage: 'build', ok: true, captured, captureFailed, connected, connectFailed, unreachable, figmaUrl, files }` — 스펙 §6 "반환값"과 일치.

- [ ] **Step 1: 03-connect.md 작성**

```markdown
# 배치 + 플로우 연결

`ToolSearch`로 `mcp__plugin_figma_figma__use_figma`를 로드하라. 로드 전에 `figma-use` 스킬을 먼저 확인해 그 규칙(색상 범위, 폰트 로딩 등)을 따르라.

`use_figma`를 **한 번만** 호출해 아래를 전부 처리한다.

입력: `입력 > figmaFileKey`, `입력 > 캡처 결과`(화면 id → figmaNodeId 매핑, 실패한 화면은 제외됨), `입력 > edges`, `입력 > entry`.

1. 캡처된 모든 프레임을 한 페이지로 모으고, 프레임 이름을 `{id} {name}` 형식(예: `S1 지인 풀`)으로 바꾼다.
2. `entry`부터 BFS 순서로 좌→우 배치한다. 같은 깊이의 화면은 위→아래로 나열한다. 프레임 간 가로 간격은 프레임 폭 + 200, 세로 간격은 프레임 높이 + 100.
3. `edges`의 각 항목마다 `from` 프레임에 reaction을 추가한다: trigger `ON_CLICK`, action `NAVIGATE`, 대상 `to` 프레임. 트리거 요소를 프레임 안에서 찾지 말고 **프레임 전체**에 reaction을 건다.
4. 각 `from` 프레임 위쪽에 작은 텍스트 노드를 추가해 그 프레임에서 나가는 `edges`의 `trigger` 문구를 나열한다 (사람이 어느 버튼이 어디로 가는지 알 수 있도록).
5. `to` 또는 `from`이 캡처 결과에 없는(캡처 실패한) 엣지는 건너뛰고 연결 못 한 목록으로 모은다.

결과를 반환하라: `{ connected: <실제로 건 reaction 수>, failed: [{from, to, reason}] }`.
```

- [ ] **Step 2: 04-report.md 작성**

```markdown
# result.md 작성

`입력`으로 받은 캡처 결과, 연결 결과, 도달 불가 화면 목록을 사람이 읽을 `result.md`로 정리해 Write 도구로 `입력 > 저장 경로`에 저장하라.

구성:
1. 요약: 캡처 성공/실패 수, 연결 성공/실패 수, 도달 불가 화면 수
2. 화면별 표: id, 이름, Figma 노드 id 또는 "실패", 실패 사유(있으면)
3. 연결 실패 목록: from, to, 사유
4. 도달 불가 화면 목록: id, 이름, 비고
5. 맨 아래에 `입력 > figmaUrl`

저장 후 `{ ok: true }`를 반환하라.
```

- [ ] **Step 3: workflow.js에 CONNECT_SCHEMA, REPORT_SCHEMA와 마무리 로직 추가**

`throw new Error('Connect/Report 미구현 (Task 6에서 추가)')` 줄을 아래로 교체:

```js
const CONNECT_SCHEMA = {
  type: 'object',
  properties: {
    connected: { type: 'number' },
    failed: {
      type: 'array',
      items: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' }, reason: { type: 'string' } },
        required: ['from', 'to', 'reason'],
      },
    },
  },
  required: ['connected', 'failed'],
}

phase('Connect')
const captureOkMap = Object.fromEntries(captureOk.map((r) => [r.id, r.figmaNodeId]))
const connect = await agent(
  withPrompt('03-connect.md', {
    figmaFileKey,
    '캡처 결과': captureOkMap,
    edges: flow.edges,
    entry: flow.entry,
  }),
  { schema: CONNECT_SCHEMA, ...SUB, label: 'connect', phase: 'Connect' },
)
const connected = connect ? connect.connected : 0
const connectFailed = connect ? connect.failed : flow.edges.map((e) => ({ from: e.from, to: e.to, reason: 'Connect 에이전트 실패' }))
log(`연결 완료: ${connected}개, 실패 ${connectFailed.length}개`)

const unreachable = rawFlow.screens.filter((s) => !s.reachable).map((s) => s.id)
const figmaUrl = preflight.figmaFileUrl || `https://figma.com/design/${figmaFileKey}`

phase('Report')
const REPORT_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
const report = await agent(
  withPrompt('04-report.md', {
    '캡처 결과': captureResults,
    '연결 결과': { connected, failed: connectFailed },
    '도달 불가 화면': unreachable,
    figmaUrl,
    '저장 경로': files.result,
  }),
  { schema: REPORT_SCHEMA, ...SUB_LOW, label: 'report', phase: 'Report' },
)

return {
  stage: 'build',
  ok: true,
  captured: captureOk.length,
  captureFailed: captureFailed.map((r) => ({ id: r.id, error: r.error })),
  connected,
  connectFailed,
  unreachable,
  figmaFileKey,
  figmaUrl,
  files: [files.result],
  reportWritten: !!(report && report.ok),
}
```

- [ ] **Step 4: node --check로 문법 확인**

Run: `node --check .claude/workflows/proto-to-figma/workflow.js`
Expected: 에러 없이 종료

- [ ] **Step 5: Commit**

```bash
git add .claude/workflows/proto-to-figma/workflow.js .claude/workflows/proto-to-figma/prompts/03-connect.md .claude/workflows/proto-to-figma/prompts/04-report.md
git commit -m "feat: proto-to-figma stage=build — Connect + Report, 최종 반환값 완성"
```

---

### Task 7: README + 전체 통합 테스트 (fixture로 extract→build 풀 실행)

**Files:**
- Create: `.claude/workflows/proto-to-figma/README.md`

**Interfaces:**
- Consumes: 앞 6개 태스크로 완성된 `workflow.js` 전체.
- Produces: 없음 (문서 + 검증). 이 태스크가 끝나면 워크플로우는 실행 가능한 완성 상태다.

- [ ] **Step 1: README.md 작성**

```markdown
# proto-to-figma

프로토타입 코드(라우팅이 동작하는 페이지)와 design.md에서 화면·플로우를 추출하고, 사람 확인 후 Figma에 화면 프레임과 플로우 연결을 만든다.

## 1단계: 화면·플로우 추출

\`\`\`js
Workflow({
  scriptPath: "<repo>/.claude/workflows/proto-to-figma/workflow.js",
  args: {
    protoDir: "<프로토타입 소스 루트, 절대경로>",
    designMdPath: "<design.md 절대경로>",
    outDir: "<산출물 폴더, 절대경로>",
    promptsDir: "<repo>/.claude/workflows/proto-to-figma/prompts",
  },
})
\`\`\`

반환값의 `flow`와 `outDir/screens.md`를 확인해, 뺄 화면(`drop`)이나 합칠 화면(`merge`)이 있으면 결정한다.

## 2단계 실행 전 로컬 준비물

1. 프로토타입 의존성 설치·dev 서버 실행 (예: `npm install && npm run dev`), 뜬 포트를 `devUrl`로 쓴다.
2. Claude Code에서 Figma 플러그인 로그인 상태 확인.

Figma 파일은 미리 만들어 둘 필요 없다 — `figmaFileKey`를 생략하면 Preflight가 자동으로 새 파일을 만든다. 기존 파일에 이어 그리고 싶으면 그 파일의 URL에서 fileKey를 추출해 넘긴다. 준비물이 안 맞아도 워크플로우가 죽지 않는다 — Preflight가 안내 메시지로 멈춘다.

## 2단계: Figma에 그리기

\`\`\`js
Workflow({
  scriptPath: "<repo>/.claude/workflows/proto-to-figma/workflow.js",
  args: {
    stage: "build",
    outDir: "<1단계와 동일>",
    promptsDir: "<1단계와 동일>",
    devUrl: "http://localhost:5173",
    // figmaFileKey: 생략하면 자동 생성. 기존 파일에 이어 그리려면 그 fileKey를 넘긴다.
    // figmaFileName: 자동 생성 시 파일 이름 (기본 "proto-to-figma").
    flow: /* 1단계 반환값의 flow를 그대로 */,
    decisions: [{ id: "S7", action: "drop" }, { id: "S4", action: "merge", into: "S3" }],
    concurrency: 3,
  },
})
\`\`\`

`ok: false`가 오면 `message`를 그대로 사용자에게 보여주고, 안내된 항목을 고친 뒤 같은 args로 재실행한다. `ok: true`면 `figmaUrl`을 열어 확인한다 (`figmaFileKey`도 함께 반환되므로, 같은 파일에 이어서 다시 돌리고 싶으면 다음 실행에 그 값을 넘긴다).
```

- [ ] **Step 2: Commit**

```bash
git add .claude/workflows/proto-to-figma/README.md
git commit -m "docs: proto-to-figma README — 2단계 실행법"
```

- [ ] **Step 3: fixture로 stage=extract 전체 실행 (재확인)**

Run (Workflow 도구): Task 2 Step 4와 동일한 args로 재실행. 반환값의 `flow`를 다음 단계에 쓰기 위해 기록해 둔다.

Expected: Task 2 Step 4와 동일 (screens ≥3, edges ≥2, unreachable 없음).

- [ ] **Step 4: fixture dev 서버를 백그라운드로 띄우고 stage=build 실행**

Run:
```bash
cd docs/superpowers/plans/fixtures/proto-to-figma && npm run dev &
sleep 3 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/
```
Expected: `200`

그 다음 Workflow 도구로 `args: { stage: "build", outDir: <Step3와 동일>, promptsDir: <동일>, devUrl: "http://localhost:5173", figmaFileKey: "<사람이 미리 만든 빈 Figma 파일 키>", flow: <Step3 반환값의 flow>, decisions: [], concurrency: 3 }` 실행.

Expected 경로 A (환경이 갖춰진 경우): `ok: true`, `captured` ≥ 화면 수 - `captureFailed.length`, `figmaUrl`이 유효한 링크, `outDir/result.md` 생성됨. 실제 Figma 파일을 열어 3개 화면 프레임과 화살표 2개(Home→List, List→Detail)가 있는지 육안 확인.

Expected 경로 B (Figma 파일 키가 아직 없거나 로그인이 안 된 경우): `ok: false`, `phase: 'preflight'`, `message`에 무엇을 고쳐야 하는지 명시됨. 이 경우도 워크플로우가 예외로 죽지 않고 정상 반환한 것이므로 Preflight 요구사항 충족으로 간주한다.

- [ ] **Step 5: fixture dev 서버 종료**

Run: `kill %1`

- [ ] **Step 6: 최종 커밋 (통합 테스트 결과를 스펙 §9에 기록)**

`docs/superpowers/specs/2026-09-05-proto-to-figma-flow-design.md`의 §9 검증 방법 아래에 실행 결과 한 줄 추가:

```markdown
- 통합 테스트(완료): fixture 프로토타입으로 extract→build 전체 실행. 결과는 구현 커밋 로그 참고.
```

```bash
git add docs/superpowers/specs/2026-09-05-proto-to-figma-flow-design.md
git commit -m "test: proto-to-figma fixture 통합 테스트 완료, 스펙에 결과 기록"
```

---

## Self-Review 메모 (계획 작성자용, 실행 시 참고)

- **스펙 커버리지**: §5(extract) → Task 2, §6 Preflight → Task 4, Capture → Task 5, Connect/Report/반환값 → Task 6, §7 README → Task 7, §3 전제(URL 도달성) → Task 2의 `reachable` 필드, §6 "화면 하나 실패해도 안 죽음" → Task 5의 `.catch(() => null)` + fallback 객체. 전부 매핑됨.
- **decisions 반영(§6 스크립트 부분)**을 Task 3에서 별도 태스크로 뽑은 이유: 에이전트 없는 순수 로직이라 리뷰어가 다른 태스크와 별개로 승인/반려할 수 있는 경계이기 때문.
- Capture는 `pipeline()`이 아니라 명시적 `for` + `parallel()` 배치 루프로 작성했다 (스펙 §6 "Workflow의 동시 cap은 16이라 rate limit 보호가 안 됨" 요구 반영).
