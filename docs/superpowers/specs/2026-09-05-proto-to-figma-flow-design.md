# proto-to-figma-flow — 프로토타입에서 Figma 프로덕트 플로우 그리기 (최소 버전)

작성일: 2026-09-05
상태: 초안 (구현 전 검토용)

## 1. 목적

코드로 만들어진 프로토타입(HTML/React, 라우팅·내비게이션이 동작하는 product-ready 페이지)과 `design.md`를 입력으로 받아, Figma 파일 안에 **모든 화면 프레임 + 화면 간 플로우 연결**을 만든다.

어떤 화면이 필요한지(플로우 정의)는 사람이 적어 주지 않는다. 프로토타입 자체에서 뽑는다.

하네스톤 당일 안에 돌아가야 하므로 정확도보다 **호출 횟수와 사람 대기 시간**을 우선해 깎은 최소 버전이다. 깎은 것과 나중에 붙일 것은 §8에 적는다.

## 2. 입력과 출력

### 입력 (모두 절대경로)

| 이름 | 설명 |
|---|---|
| `protoDir` | 프로토타입 소스 루트. 라우트 정의, 페이지/컴포넌트 파일이 있어야 한다 |
| `designMdPath` | `design.md`. 토큰(색·타이포·spacing), 컴포넌트 목록, 톤 설명 |
| `devUrl` | 실행 중인 프로토타입 dev 서버 URL (예: `http://localhost:5173`). 2단계에서만 필요 |
| `figmaFileKey` | 화면을 넣을 Figma 디자인 파일 키. 없으면 2단계 시작 시 새 파일을 만든다 |
| `outDir` | 산출물 폴더 |

### 출력

| 위치 | 내용 |
|---|---|
| `outDir/flow.json` | 화면 노드 + 전이 엣지 그래프 (스키마 §5) |
| `outDir/screens.md` | 사람이 확인할 화면 목록 (한 화면당 한 줄: id, 이름, URL, 진입 방법, 비고) |
| Figma 파일 | 화면당 프레임 1개, 플로우 순서대로 배치, 엣지마다 프로토타입 연결(reaction) |
| `outDir/result.md` | 생성된 프레임 id 목록, 연결 못 한 엣지, 캡처 실패 화면 |

## 3. 전제

- 프로토타입의 **모든 화면은 URL로 열 수 있어야 한다.** 라우트가 있거나, 모달·상태별 뷰는 `?state=empty` 같은 쿼리로 강제할 수 있어야 한다. URL로 못 여는 화면은 Extract가 `reachable: false`로 표시하고 Generate에서 건너뛴다. 사람이 프로토타입에 쿼리를 추가하면 다시 돌린다.
- `design.md`는 이 단계에서 **읽기만** 한다. `generate_figma_design`이 렌더된 화면을 그대로 캡처하므로 토큰을 Figma 변수로 옮기는 작업은 하지 않는다 (§8).
- Figma MCP(`generate_figma_design`, `use_figma`)는 **메인 세션**에서 호출한다. Workflow 서브에이전트가 MCP를 쓸 수 있는지 검증되지 않았고, 검증할 시간을 쓰지 않는다.

## 4. 구조

`prd-interview`와 같은 2단계 실행이다. 1단계는 Workflow 스크립트, 2단계는 스킬 절차(메인 세션이 직접 수행).

```
1단계 (Workflow, 에이전트 1개)
  Extract: protoDir + design.md → flow.json, screens.md
        ↓ 사람이 screens.md 확인: 각 화면에 OK / 빼라 / 합쳐라
2단계 (메인 세션, 스킬 절차)
  Generate: 화면마다 generate_figma_design 1회 → 프레임
  Connect : use_figma 1회 → 프레임 배치 + reaction 연결
  Report  : result.md
```

### 파일 배치

```
.claude/workflows/proto-to-figma/
  README.md              # 실행법 (아래 §7)
  workflow.js            # 1단계만. Extract 에이전트 호출 + 결과 반환
  prompts/01-extract.md  # Extract 에이전트 프롬프트
.claude/skills/proto-to-figma/SKILL.md   # 2단계 절차 (Generate → Connect → Report)
```

`workflow.js`는 `prd-interview/workflow.js`의 `withPrompt` 관례를 그대로 쓴다: 스크립트는 `# 입력` 블록만 붙이고, 에이전트가 Read로 프롬프트 파일을 읽는다.

## 5. 1단계 — Extract

### 에이전트 1개 (sonnet, effort medium)

입력: `protoDir`, `designMdPath`, `outDir`.

하는 일:
1. 라우터 정의(react-router `<Route>`, Next `app/`·`pages/`, 정적 HTML은 파일 목록)에서 화면 후보를 뽑는다.
2. 각 화면 파일에서 전이를 찾는다: `<Link to>`, `<a href>`, `navigate()`, `router.push()`, `window.location`, 그리고 모달/드로어/상태 토글을 여는 핸들러.
3. 모달·빈 상태·에러 상태처럼 같은 URL 안의 다른 뷰는 별도 화면 노드로 만들되, 그 뷰를 강제하는 쿼리 파라미터를 코드에서 찾는다. 못 찾으면 `reachable: false`.
4. `design.md`는 화면 이름·역할을 붙일 때 참고만 한다.
5. `flow.json`과 `screens.md`를 Write로 저장한다.

### flow.json 스키마

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
  "unreachable": ["S7"]
}
```

`entry`는 앱의 첫 화면(루트 라우트 또는 로그인). `edges`는 코드에서 명시적으로 보이는 것만. 뒤로가기·탭바처럼 모든 화면에 공통인 전이는 `edges`에 넣지 않고 `screens.md` 맨 아래 "공통 내비게이션" 절에 한 줄로만 적는다 (연결 수 폭발 방지).

### screens.md

한 화면당 한 줄. 사람이 1분 안에 훑고 답할 수 있어야 한다.

```
| id | 이름 | URL | 진입 방법 | 비고 |
| S1 | 지인 풀 | /friends | 첫 화면 | |
| S7 | 회신 마감 모달 | /meetings/:id | S4에서 ‘마감’ 버튼 | reachable: false — 쿼리 없음 |
```

### 반환값

```js
{ stage: 'extract', screens: N, edges: M, unreachable: [...], files: [flow.json, screens.md],
  nextStep: 'screens.md를 사용자에게 보여주고 빼거나 합칠 화면을 받는다. 그 뒤 스킬 proto-to-figma 절차로 2단계를 진행한다.' }
```

## 6. 2단계 — 스킬 절차 (메인 세션)

사람의 답을 `flow.json`에 반영한 뒤(빼기: screens·edges에서 제거, 합치기: 한 노드로 병합하고 엣지 재지정), 아래 순서로 진행한다. 실행 전 `figma-use`, `figma-generate-design` 스킬을 로드한다.

### Generate

`reachable: true`인 화면마다:
1. `generate_figma_design({ fileKey })` 호출 → 캡처 스크립트 + `captureId`.
2. 캡처 스크립트를 `devUrl + path + query`에 대해 실행(Playwright MCP로 열고 스크립트 주입).
3. `captureId`로 5초 간격 폴링, 최대 10회. 완료되면 생성된 노드 id를 `screen.figmaNodeId`에 기록.
4. 실패하면 `result.md`의 "캡처 실패"에 넣고 다음 화면으로. 재시도는 1회.

화면 수가 많으면 캡처를 2~3개씩 겹쳐 시작한다 (폴링 대기 시간이 대부분이라 병렬 이득이 크다). Figma MCP rate limit에 걸리면 직렬로 낮춘다.

### Connect

`use_figma` **1회**로 처리한다 (rate limit 절약):
1. 모든 캡처 프레임을 한 페이지로 모으고 프레임 이름을 `S1 지인 풀` 형식으로 바꾼다.
2. `entry`부터 BFS 순서로 좌→우 배치. 같은 깊이는 위→아래. 간격은 프레임 폭 + 200.
3. `edges`마다 `from` 프레임에 `reactions` 추가 (trigger ON_CLICK, action NAVIGATE → `to` 프레임). 트리거 요소를 프레임 안에서 찾지 않는다. **프레임 전체에 건다.** 정확한 핫스팟은 §8.
4. 프레임 위에 작은 텍스트 라벨로 `trigger` 문구를 적어 어느 전이인지 사람이 알 수 있게 한다.

### Report

`result.md`: 화면별 Figma 노드 id, 연결된 엣지 수, 캡처 실패 화면, `reachable: false` 화면. 마지막에 Figma 파일 URL.

## 7. 실행법 (README 초안)

```
// 1단계
Workflow({
  scriptPath: "<repo>/.claude/workflows/proto-to-figma/workflow.js",
  args: { protoDir, designMdPath, outDir, promptsDir }
})
// → screens.md를 사용자에게 보여주고 빼기/합치기 답을 받는다

// 2단계 (메인 세션, 스킬 절차)
/proto-to-figma  devUrl=<url> figmaFileKey=<key> outDir=<outDir>
```

## 8. 깎은 것과 나중에 붙일 것

| 깎은 것 | 이유 | 붙일 때 |
|---|---|---|
| Playwright 크롤링으로 화면 발견 | 상태 폭발·범위 제어에 시간이 든다 | Extract 에이전트만 교체. flow.json 스키마는 유지 |
| design.md 토큰 → Figma 변수·컴포넌트 | 캡처는 렌더 결과를 그대로 가져오므로 당장 필요 없다 | `figma-generate-design`의 병렬 워크플로우(use_figma로 컴포넌트 재구성) 추가 |
| 트리거 요소 단위 핫스팟 | 캡처 노드에서 버튼을 찾는 로직이 필요하다 | Connect에서 `trigger` 텍스트로 자식 노드 검색 후 그 노드에 reaction |
| A/C 단계 자동 검증 | 판단 기준이 아직 비어 있다 | `oss-design-harness` 스킬이 채워지면 Report 뒤에 연결 |
| 공통 내비게이션(탭바·뒤로가기) 엣지 | 연결 수 폭발 | Figma 컴포넌트에 reaction을 걸어 인스턴스가 상속하게 |

## 9. 검증 방법

- 1단계: `examples/wedding-scheduler`에 프로토타입이 생기면 그걸로 돌려 `screens.md`의 화면 수가 라우트 수 이상이고, `edges`의 `sourceFile`이 실제 파일인지 확인.
- 2단계: 생성된 Figma 파일에서 프레젠테이션 모드로 `entry`부터 클릭해 `edges` 수만큼 이동되는지 확인. 실패 화면은 `result.md`에 있어야 한다.

## 10. 소요 예상

- 구현: workflow.js(짧음) + 프롬프트 1개 + SKILL.md 절차. 1시간 안쪽.
- 실행(화면 10개 기준): Extract 1~2분, Generate 화면당 약 1분(캡처 폴링), Connect 1분.
