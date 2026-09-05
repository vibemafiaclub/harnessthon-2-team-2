# proto-to-figma

프로토타입 코드(라우팅이 동작하는 페이지)와 design.md에서 화면·플로우를 추출하고, 사람 확인 후 Figma에 화면 프레임과 플로우 연결을 만든다.

## 1단계: 화면·플로우 추출

```js
Workflow({
  scriptPath: "<repo>/.claude/workflows/proto-to-figma/workflow.js",
  args: {
    protoDir: "<프로토타입 소스 루트, 절대경로>",
    designMdPath: "<design.md 절대경로>",
    outDir: "<산출물 폴더, 절대경로>",
    promptsDir: "<repo>/.claude/workflows/proto-to-figma/prompts",
  },
})
```

반환값의 `flow`와 `outDir/screens.md`를 확인해, 뺄 화면(`drop`)이나 합칠 화면(`merge`)이 있으면 결정한다.

## 2단계 실행 전 로컬 준비물

1. 프로토타입 의존성 설치·dev 서버 실행 (예: `npm install && npm run dev`), 뜬 포트를 `devUrl`로 쓴다.
2. Claude Code에서 Figma 플러그인 로그인 상태 확인.

Figma 파일은 미리 만들어 둘 필요 없다 — `figmaFileKey`를 생략하면 Preflight가 자동으로 새 파일을 만든다. 기존 파일에 이어 그리고 싶으면 그 파일의 URL에서 fileKey를 추출해 넘긴다. 준비물이 안 맞아도 워크플로우가 죽지 않는다 — Preflight가 안내 메시지로 멈춘다.

## 2단계: Figma에 그리기

```js
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
```

`ok: false`가 오면 `message`를 그대로 사용자에게 보여주고, 안내된 항목을 고친 뒤 같은 args로 재실행한다. `ok: true`면 `figmaUrl`을 열어 확인한다 (`figmaFileKey`도 함께 반환되므로, 같은 파일에 이어서 다시 돌리고 싶으면 다음 실행에 그 값을 넘긴다).
