# 화면 캡처

`ToolSearch`로 `mcp__plugin_figma_figma__generate_figma_design`을 로드하라. 필요하면 Playwright MCP도 검색해 로드하라.

`입력 > 화면`(id, name, path, query) 하나를 Figma에 캡처한다.

1. `generate_figma_design({ fileKey: 입력 > figmaFileKey })`를 호출해 캡처 스크립트와 captureId를 받는다.
2. 받은 캡처 스크립트를 `입력 > devUrl` + `입력 > 화면.path` + `입력 > 화면.query`에 대해 도구가 안내하는 방식으로 실행한다. 로컬 dev 서버는 도구가 직접 열 수 있으면 그렇게 하고, 안 되면 Playwright MCP로 그 URL을 열어 실행한다.
3. captureId로 5초 간격, 최대 10회 폴링해 완료를 기다린다.
4. 완료되면 생성된 노드 id를 확인해 `{ id: 입력 > 화면.id, figmaNodeId, ok: true, error: "" }`를 반환한다.
5. 실패하면 한 번만 더 처음부터 재시도한다. 재시도도 실패하면 `{ id: 입력 > 화면.id, figmaNodeId: "", ok: false, error: <에러 원문> }`을 반환한다. 예외를 던지지 말고 반드시 이 형태로 반환하라.
