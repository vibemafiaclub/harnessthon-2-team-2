# 환경 점검 (Preflight)

`ToolSearch`로 "figma whoami", "figma get_metadata", "figma create_new_file", "figma generate_figma_design" 등 필요한 키워드로 검색해 로드하라 (이 프로젝트 환경에 따라 도구 이름이 `mcp__figma__*` 또는 `mcp__plugin_figma_figma__*` 둘 중 하나로 나타난다). 필요하면 Playwright MCP 도구도 "playwright browser_navigate" 같은 키워드로 검색해 로드하라 (`mcp__playwright__*` 또는 `mcp__plugin_playwright_playwright__*`).

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
