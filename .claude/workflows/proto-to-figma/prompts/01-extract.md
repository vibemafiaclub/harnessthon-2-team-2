# 화면·플로우 추출

`입력 > 프로토타입 경로`의 소스를 읽고, `입력 > design.md 경로`를 참고해 화면 목록과 화면 간 전이를 뽑는다.

1. 라우터 정의를 찾는다 — react-router `<Route path=... element=...>`, Next.js `app/`·`pages/` 디렉토리 구조, 정적 HTML은 파일 목록. 각 라우트를 화면 후보로 삼는다.
2. 각 화면 파일 안에서 전이를 찾는다: `<Link to=...>`, `<a href=...>`, `navigate(...)`, `router.push(...)`, `window.location`, 모달/드로어/상태 토글을 여는 클릭 핸들러.
3. 같은 URL 안에서 조건부로 보이는 다른 뷰(모달, 빈 상태, 에러 상태)는 별도 화면 노드로 만든다. 그 뷰를 강제하는 쿼리 파라미터가 코드에 있으면 `query`에 적고 `reachable: true`. 없으면 `query: ""`, `reachable: false`.
4. `design.md`는 화면 이름·역할을 자연스럽게 붙일 때만 참고한다. 토큰 값을 화면 데이터에 넣지 않는다.
5. 뒤로가기·탭바처럼 **모든 화면에 공통으로 있는** 전이는 `edges`에 넣지 않고 `commonNav`에 한 줄씩 요약한다.
6. `entry`는 앱의 첫 화면 id(루트 라우트).
7. 결과를 Write 도구로 `입력 > 저장 경로(flow.json)`에는 JSON으로, `입력 > 저장 경로(screens.md)`에는 화면 목록 표(id, 이름, URL, 진입 방법, 비고 — reachable:false인 화면은 비고에 이유를 적는다)로 저장한다. 그리고 같은 내용을 구조화 출력으로도 반환하라.
