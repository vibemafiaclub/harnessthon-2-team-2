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
