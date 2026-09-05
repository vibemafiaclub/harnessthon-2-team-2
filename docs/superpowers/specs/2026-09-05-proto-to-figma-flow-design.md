# proto-to-figma-flow — 프로토타입에서 Figma 프로덕트 플로우 그리기 (최소 버전)

작성일: 2026-09-05
상태: 초안 v2 (구현 전 검토용)

v1에서 바뀐 것: 스파이크로 Workflow 서브에이전트가 Figma MCP를 호출할 수 있음을 확인(`whoami` 성공). 그래서 2단계(Figma 생성)도 메인 세션 스킬이 아니라 **같은 Workflow 안**에서 돌린다. SKILL.md는 없앤다.

## 1. 목적

코드로 만들어진 프로토타입(HTML/React, 라우팅·내비게이션이 동작하는 product-ready 페이지)과 `design.md`를 입력으로 받아, Figma 파일 안에 **모든 화면 프레임 + 화면 간 플로우 연결**을 만든다.

어떤 화면이 필요한지(플로우 정의)는 사람이 적어 주지 않는다. 프로토타입 자체에서 뽑는다.

하네스톤 당일 안에 돌아가야 하므로 정확도보다 **호출 횟수와 사람 대기 시간**을 우선해 깎은 최소 버전이다. 깎은 것과 나중에 붙일 것은 §8에 적는다.

## 2. 입력과 출력

### 입력 (모두 절대경로)

| 이름 | 단계 | 설명 |
|---|---|---|
| `protoDir` | 1 | 프로토타입 소스 루트. 라우트 정의, 페이지/컴포넌트 파일이 있어야 한다 |
| `designMdPath` | 1 | `design.md`. 토큰(색·타이포·spacing), 컴포넌트 목록, 톤 설명 |
| `outDir` | 1, 2 | 산출물 폴더 |
| `promptsDir` | 1, 2 | `prompts/` 절대경로 |
| `devUrl` | 2 | 실행 중인 프로토타입 dev 서버 URL (예: `http://localhost:5173`) |
| `figmaFileKey` | 2 | 화면을 넣을 Figma 디자인 파일 키. 사람이 미리 만들어 둔다 |
| `decisions` | 2 | 사람 확인 결과. `[{ id: 'S7', action: 'drop' }, { id: 'S4', action: 'merge', into: 'S3' }]`. 없으면 빈 배열 |
| `concurrency` | 2 | 동시 캡처 수. 기본 3 |

### 출력

| 위치 | 내용 |
|---|---|
| `outDir/flow.json` | 화면 노드 + 전이 엣지 그래프 (스키마 §5) |
| `outDir/screens.md` | 사람이 확인할 화면 목록 (한 화면당 한 줄) |
| Figma 파일 | 화면당 프레임 1개, 플로우 순서대로 배치, 엣지마다 프로토타입 연결(reaction) |
| `outDir/result.md` | 생성된 프레임 id, 연결된 엣지 수, 캡처 실패 화면, `reachable: false` 화면, Figma 파일 URL |

## 3. 전제

- 프로토타입의 **모든 화면은 URL로 열 수 있어야 한다.** 라우트가 있거나, 모달·상태별 뷰는 `?state=empty` 같은 쿼리로 강제할 수 있어야 한다. URL로 못 여는 화면은 Extract가 `reachable: false`로 표시하고 2단계에서 건너뛴다. 사람이 프로토타입에 쿼리를 추가하면 다시 돌린다.
- `design.md`는 **읽기만** 한다. `generate_figma_design`이 렌더된 화면을 그대로 캡처하므로 토큰을 Figma 변수로 옮기지 않는다 (§8).
- 서브에이전트는 `ToolSearch`로 Figma MCP(`generate_figma_design`, `use_figma`)와 Playwright MCP를 로드해 쓴다. 각 프롬프트 md 첫 줄에 로드할 도구 이름을 적는다.
- Figma MCP rate limit이 있다. 캡처 동시 수를 `concurrency`로 제한한다.

## 4. 구조

`prd-interview`와 같은 2단계 실행. 둘 다 같은 `workflow.js`, `args.stage`로 구분한다.

```
stage: 'extract'  (기본)
  Extract 에이전트 1개: protoDir + design.md → flow.json, screens.md
        ↓ 사람이 screens.md 확인: 빼라 / 합쳐라 → decisions
stage: 'build'
  스크립트: decisions를 flow.json에 반영 (에이전트 없음)
  Capture 에이전트 × 화면 수 (pipeline, 동시 concurrency개): 화면 1개 캡처 → figmaNodeId
  Connect 에이전트 1개: use_figma 1회 → 배치 + reaction 연결
  스크립트: result.md 작성 에이전트 1개 (low) → 반환
```

### 파일 배치

```
.claude/workflows/proto-to-figma/
  README.md              # 실행법 (§7)
  workflow.js            # 두 단계 모두
  prompts/
    01-extract.md
    02-capture.md
    03-connect.md
    04-report.md
```

`workflow.js`는 `prd-interview/workflow.js`의 `withPrompt` 관례를 그대로 쓴다: 스크립트는 `# 입력` 블록만 붙이고, 에이전트가 Read로 프롬프트 파일을 읽는다. 모델은 전부 sonnet. effort는 Extract·Connect medium, Capture·Report low.

## 5. stage: extract

### Extract 에이전트 (01-extract.md)

입력: `protoDir`, `designMdPath`, `저장 경로`(flow.json, screens.md).

하는 일:
1. 라우터 정의(react-router `<Route>`, Next `app/`·`pages/`, 정적 HTML은 파일 목록)에서 화면 후보를 뽑는다.
2. 각 화면 파일에서 전이를 찾는다: `<Link to>`, `<a href>`, `navigate()`, `router.push()`, `window.location`, 그리고 모달/드로어/상태 토글을 여는 핸들러.
3. 모달·빈 상태·에러 상태처럼 같은 URL 안의 다른 뷰는 별도 화면 노드로 만들되, 그 뷰를 강제하는 쿼리 파라미터를 코드에서 찾는다. 못 찾으면 `reachable: false`.
4. `design.md`는 화면 이름·역할을 붙일 때 참고만 한다.
5. `flow.json`과 `screens.md`를 Write로 저장하고, 같은 내용을 구조화 출력으로 반환한다.

### flow.json 스키마 (= Extract 반환 스키마)

```json
{
  "screens": [
    {
      "id": "S1",
      "name": "지인 풀",
      "role": "등록된 지인을 그룹별로 보고 추가한다",
      "path": "/friends",
      "query": "",
      "reachable": true,
      "sourceFiles": ["src/pages/Friends.tsx"],
      "note": ""
    }
  ],
  "edges": [
    { "from": "S1", "to": "S2", "trigger": "‘모임 만들기’ 버튼", "sourceFile": "src/pages/Friends.tsx" }
  ],
  "entry": "S1",
  "commonNav": ["하단 탭바: 지인/모임/일정", "헤더 뒤로가기"]
}
```

`entry`는 앱의 첫 화면. `edges`는 코드에서 명시적으로 보이는 것만. 뒤로가기·탭바처럼 모든 화면에 공통인 전이는 `edges`에 넣지 않고 `commonNav`에 한 줄씩만 적는다 (연결 수 폭발 방지).

### screens.md

한 화면당 한 줄. 사람이 1분 안에 훑고 답할 수 있어야 한다.

```
| id | 이름 | URL | 진입 방법 | 비고 |
| S1 | 지인 풀 | /friends | 첫 화면 | |
| S7 | 회신 마감 모달 | /meetings/:id | S4에서 ‘마감’ 버튼 | reachable: false — 쿼리 없음 |
```

### 반환값

```js
{ stage: 'extract', screens: N, edges: M, unreachable: ['S7'], files: [flow.json, screens.md],
  nextStep: 'screens.md를 사용자에게 보여주고 빼거나 합칠 화면을 받는다. 답을 decisions로 넣어 stage: "build"로 다시 실행한다.' }
```

## 6. stage: build

### 스크립트: decisions 반영

에이전트 없이 스크립트가 처리한다. `flow` 데이터는 Extract 반환값을 다시 쓸 수 없으므로(다른 실행), Build 시작 시 Read 전용 에이전트 대신 **`args.flow`로 flow.json 내용을 통째로 넘긴다** (메인 세션이 파일을 읽어 넣음). `drop`은 screens·edges에서 제거, `merge`는 `into` 노드로 합치고 엣지 재지정. `reachable: false`는 제외.

### Capture 에이전트 (02-capture.md), 화면당 1개

입력: `figmaFileKey`, `devUrl`, 화면 1개(id, name, path, query).

1. `generate_figma_design({ fileKey })` 호출 → 캡처 스크립트 + `captureId`.
2. 돌려받은 캡처 스크립트를 `devUrl + path + query`에 대해 도구 안내대로 실행한다 (로컬 dev 서버는 도구가 직접 열고, 안 되면 Playwright MCP로 연다). 정확한 실행 방식은 구현 시 첫 화면으로 한 번 확인한다.
3. `captureId`로 5초 간격 폴링, 최대 10회.
4. 반환: `{ id, figmaNodeId, ok, error }`. 실패 시 재시도 1회 후 `ok: false`.

스크립트는 `pipeline`이 아니라 **동시 수 제한이 있는 루프**로 돌린다 (Workflow의 동시 cap은 16이라 rate limit 보호가 안 됨): 화면을 `concurrency` 크기로 잘라 `parallel`로 묶음씩 실행.

### Connect 에이전트 (03-connect.md), 1개

입력: `figmaFileKey`, 캡처 결과(id → figmaNodeId), edges, entry.

`use_figma` **1회**로:
1. 캡처 프레임을 한 페이지로 모으고 이름을 `S1 지인 풀` 형식으로 바꾼다.
2. `entry`부터 BFS 순서로 좌→우 배치. 같은 깊이는 위→아래. 간격은 프레임 폭 + 200.
3. `edges`마다 `from` 프레임에 reaction 추가 (ON_CLICK → NAVIGATE → `to` 프레임). **프레임 전체에 건다.** 요소 단위 핫스팟은 §8.
4. 프레임 위에 작은 텍스트 라벨로 `trigger` 문구를 적는다.

반환: `{ connected: N, failed: [{from, to, reason}] }`.

### Report 에이전트 (04-report.md), 1개, low

캡처 결과·연결 결과·unreachable 목록을 받아 `result.md`를 쓴다. 반환 `{ ok }`.

### 반환값

```js
{ stage: 'build', captured: N, captureFailed: [...], connected: M, connectFailed: [...], unreachable: [...],
  figmaUrl: `https://figma.com/design/${figmaFileKey}`, files: [result.md] }
```

## 7. 실행법 (README 초안)

```js
// 1단계
Workflow({ scriptPath: "<repo>/.claude/workflows/proto-to-figma/workflow.js",
  args: { protoDir, designMdPath, outDir, promptsDir } })
// → screens.md를 사용자에게 보여주고 빼기/합치기 답을 받는다

// 2단계 (dev 서버 실행 중이어야 함)
Workflow({ scriptPath: "<same>",
  args: { stage: 'build', outDir, promptsDir, devUrl, figmaFileKey,
          flow: <flow.json 내용>, decisions: [{ id: 'S7', action: 'drop' }], concurrency: 3 } })
```

## 8. 깎은 것과 나중에 붙일 것

| 깎은 것 | 이유 | 붙일 때 |
|---|---|---|
| Playwright 크롤링으로 화면 발견 | 상태 폭발·범위 제어에 시간이 든다 | Extract 에이전트만 교체. flow.json 스키마는 유지 |
| design.md 토큰 → Figma 변수·컴포넌트 | 캡처는 렌더 결과를 그대로 가져오므로 당장 필요 없다 | `figma-generate-design`의 병렬 워크플로우(use_figma로 컴포넌트 재구성)를 Capture 뒤에 추가 |
| 트리거 요소 단위 핫스팟 | 캡처 노드에서 버튼을 찾는 로직이 필요하다 | Connect에서 `trigger` 텍스트로 자식 노드 검색 후 그 노드에 reaction |
| A/C 단계 자동 검증 | 판단 기준이 아직 비어 있다 | `oss-design-harness` 스킬이 채워지면 Report 앞에 검증 단계 추가 |
| 공통 내비게이션 엣지 | 연결 수 폭발 | Figma 컴포넌트에 reaction을 걸어 인스턴스가 상속하게 |

## 9. 검증 방법

- 스파이크(완료): Workflow 서브에이전트가 `ToolSearch`로 Figma MCP `whoami` 호출 성공. 2026-09-05.
- extract: `examples/wedding-scheduler`에 프로토타입이 생기면 그걸로 돌려 `screens.md`의 화면 수가 라우트 수 이상이고, `edges`의 `sourceFile`이 실제 파일인지 확인.
- build: 첫 구현 시 화면 1개로만 돌려 캡처 스크립트 실행 방식을 확정한다. 그 뒤 전체로 돌려 Figma 프레젠테이션 모드에서 `entry`부터 클릭해 `edges` 수만큼 이동되는지 확인. 실패 화면은 `result.md`에 있어야 한다.

## 10. 소요 예상

- 구현: workflow.js + 프롬프트 4개 + README. 1시간 안쪽.
- 실행(화면 10개, concurrency 3 기준): Extract 1~2분, Capture 4~5분, Connect 1분.
