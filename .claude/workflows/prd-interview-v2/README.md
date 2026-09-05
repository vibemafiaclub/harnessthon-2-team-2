# prd-interview-v2

PRD → 페르소나 + 제품 설명서 → **여정 걷기(빠진 플로우)** → 유저스토리 → 인터뷰 질문 → 가상 인터뷰(2-에이전트, 1회) → 불편사항 검증 → **사람에게 물을 질문** → (답변 받은 뒤) v2 PRD.

v1(`../prd-interview.js`)과 다른 점:
- 페르소나마다 에이전트 하나가 "제품을 처음 알게 되는 순간 → 마지막"을 걸으며 기능 목록에 없어서 막히는 화면·플로우(가입/로그인, 배우자 연결, 연락처 가져오기 등)를 찾는다. 병합 에이전트가 페르소나 간 중복을 합쳐 F0-n 목록을 만든다. 표준이 있는 것(baseline)은 인터뷰 없이 제안을 PRD-v2에 넣고 소유자가 정할 것만 질문으로 올린다. 사용자 반응이 중요한 것(interview, 예: 초대받은 지인의 첫 진입)은 기능 목록에 합쳐 인터뷰를 탄다.
- 인터뷰를 1회만 돌린다. 2라운드 대신 PRD 소유자(이 워크플로우를 돌리는 사람)에게 직접 물을 질문 목록을 만든다.
- 그래서 2단계로 나뉜다. 워크플로우 안에서는 사람에게 물을 수 없으므로, 1단계가 끝나면 메인 세션이 질문하고 답을 받아 2단계를 돌린다.
- 페르소나별로 stories→interview→extract→verify를 하나의 pipeline으로 묶는다. 단일 라운드라 라운드 간 dedup이 없으므로, 모든 페르소나의 추출이 끝날 때까지 기다리는 배리어 없이 먼저 끝난 페르소나의 검증이 다른 페르소나 인터뷰와 동시에 진행된다.
- 모든 에이전트는 sonnet. effort는 응답자(05)·추출(06)·pain-points(09)만 low, 나머지(페르소나·설명서·스토리·인터뷰어·검증·질문 종합·PRD 개정)는 medium.
- 단계별 프롬프트를 `prompts/*.md`로 분리했다. 스크립트는 파일을 읽을 수 없으므로 각 에이전트가 자기 프롬프트 파일을 Read로 읽는다. 스크립트는 `# 입력` 아래에 이름 붙인 블록만 붙이고, 프롬프트 md는 `` `입력 > 이름` ``으로 그 블록을 참조한다.

## 실행

### 1단계: 인터뷰 + 검증 + 질문 목록

```
Workflow({
  scriptPath: "<repo>/.claude/workflows/prd-interview-v2/workflow.js",
  args: {
    prdPath:    "<repo>/examples/wedding-scheduler/PRD.md",
    outDir:     "<repo>/examples/wedding-scheduler/research-v2",
    promptsDir: "<repo>/.claude/workflows/prd-interview-v2/prompts",
    maxTurns: 1,          // 페르소나당 인터뷰 턴 상한, 기본 1 (턴당 질문 2~3개)
    skipInterviewer: false // true면 인터뷰어 호출 없이 stories 질문을 그대로 응답자에게 던짐 (턴당 호출 1개 절약, 기본 false)
  }
})
```

반환값의 `questions` (id, kind, question, why, options)를 사용자에게 물어 답을 받는다. 같은 내용이 `outDir/open-questions.md`에도 저장된다.
마지막 항목은 항상 `Q-free`(자유 응답)다. 위 질문에 없지만 빠진 것이나 하고 싶은 말을 적는 자리이고, 답은 다른 답변과 같이 `answers`에 넣는다. 2단계에서 이 답이 가장 우선한다.

### 2단계: 답변 반영해 PRD-v2

```
Workflow({
  scriptPath: "<repo>/.claude/workflows/prd-interview-v2/workflow.js",
  args: {
    stage: "revise",
    prdPath, outDir, promptsDir,   // 1단계와 동일
    answers: [{ id: "Q1", answer: "..." }, ...]
  }
})
```

2단계 에이전트는 1단계가 저장한 personas.md, product-walkthrough.md, pain-points.md, open-questions.md를 Read로 읽는다. 경로는 전부 절대경로.

## 프롬프트 파일과 입력 블록

| 파일 | 단계 | 받는 입력 블록 |
|---|---|---|
| 01-personas.md | 페르소나 추출 | PRD 경로, 저장 경로 |
| 02-walkthrough.md | 제품 설명서 (응답자가 PRD 대신 보는 문서) | PRD 경로, 저장 경로 |
| 12-journey.md | 페르소나별 여정 걷기 (빠진 화면·플로우) | 페르소나, 제품 소개서, 기능 목록, 저장 경로 |
| 13-merge-gaps.md | 빠진 플로우 병합 → F0-n | 기능 목록, 빠진 항목, 저장 경로 |
| 03-stories.md | 유저스토리 + 인터뷰 질문 | PRD 경로, 페르소나, 기능 목록, 저장 경로 |
| 04-interviewer.md | 인터뷰어 (턴마다 호출) | 페르소나, 준비된 질문 목록, 지금까지의 대화, 턴 정보 |
| 05-respondent.md | 응답자 (턴마다 호출) | 당신, 당신이 소개받은 제품, 지금까지의 대화, 인터뷰어의 질문 |
| 06-extract.md | 전사 저장 + 불편사항 추출 | 페르소나, 기능 목록, 전사, 저장 경로 |
| 08-verify.md | 반박 검증 | 페르소나, 제품 소개서, 불편사항 |
| 09-pain-points.md | pain-points.md 작성 | 실행 요약, 기능 목록, 통과, 탈락, 저장 경로 |
| 11-open-questions.md | 사람에게 물을 질문 목록 | 제품 소개서, 기본 플로우 질문(있을 때), 기능 목록, 다뤄지지 않은 기능, 페르소나, 검증 통과 불편사항, 인터뷰 전사, 저장 경로 |
| 10-prd-v2.md | (2단계) PRD v2 개정 | PRD 경로, 페르소나 파일, 제품 설명서 파일, 빠진 플로우 파일, 불편사항 파일, 질문 파일, 답변, 저장 경로 |

프롬프트 문구만 바꾸려면 md만 고치면 된다. 입력 블록을 추가·삭제하려면 `workflow.js`의 해당 `withPrompt(...)` 호출도 같이 고친다.
구조화 출력 스키마(어떤 필드를 돌려줘야 하는지)는 `workflow.js` 상단에 있고, 에이전트에게 자동으로 주입된다.

## 산출물 (`outDir`)

1단계:
- personas.md, product-walkthrough.md
- journeys/<slug>.md, missing-flows.md
- stories/<slug>.md
- interviews/<slug>.md
- pain-points.md (통과/탈락 모두, 사유 포함)
- open-questions.md (사람에게 물을 질문)

2단계:
- PRD-v2.md
