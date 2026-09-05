// Static, self-contained route/status view. All supplied content is escaped;
// user materials are described, never embedded or executed.

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const DECISION_LABEL = { run: "생성 실행", reuse: "재사용 (검증됨)", repair: "부분 재사용 + 보수", blocked: "차단됨" };
const STATUS_LABEL = { pending: "대기", done: "완료", stale: "무효화됨(입력 변경)", blocked: "차단", awaiting_user: "사용자 결정 대기" };
const TOUCHPOINT_LABEL = { prd_review: "PRD 리뷰", concept_review: "시안 리뷰" };

export function renderStatusHtml({ state, materials, assessment, plan, nextAction }) {
  const assessedById = new Map((assessment?.materials || []).map((m) => [m.materialId, m]));
  const materialRows = materials.map((m) => {
    const a = assessedById.get(m.id);
    return `<tr>
      <td><code>${esc(m.id)}</code></td>
      <td>${esc(m.source?.path ?? m.source?.url ?? "-")}</td>
      <td>${esc(m.declaredRole ?? "-")}</td>
      <td>${a ? esc(a.type) : "<em>미평가</em>"}</td>
      <td>${a ? (a.verified ? "✅ 검증됨" : "⚠️ 미검증") : "-"}</td>
      <td>${esc(m.parseStatus)}${m.sha256 ? `<br><code class="hash">${esc(m.sha256.slice(0, 12))}…</code>` : ""}</td>
      <td>${a ? a.observations.map((o) => `<div class="obs">${esc(o.note)}</div>`).join("") : ""}</td>
    </tr>`;
  }).join("\n");

  const stageRows = (plan?.stages || []).map((ps) => {
    const st = state.stages[ps.id] || {};
    const evidence = (ps.evidence || []).map((e) => `<div class="obs"><b>${esc(e.check)}</b>: ${esc(e.detail)}</div>`).join("");
    const unmet = (ps.unmetChecks || []).map((u) => `<div class="unmet">${esc(u)}</div>`).join("");
    return `<tr class="d-${esc(ps.decision)} s-${esc(st.status ?? "pending")}">
      <td><code>${esc(ps.id)}</code>${ps.humanGate ? ` <span class="gate">👤 ${esc(TOUCHPOINT_LABEL[ps.touchpoint] ?? "인간 결정")}</span>` : ""}</td>
      <td>${esc(DECISION_LABEL[ps.decision] ?? ps.decision)}</td>
      <td>${esc(STATUS_LABEL[st.status] ?? st.status ?? "대기")}${st.actor ? `<br><code>${esc(st.actor)}</code>` : ""}</td>
      <td>${esc(ps.rationale)}${evidence}${unmet}</td>
      <td>${st.output?.sha256 ? `<code class="hash">${esc(st.output.sha256.slice(0, 12))}…</code><br>` : ""}${esc(st.output?.path ?? "")}</td>
    </tr>`;
  }).join("\n");

  const questions = (plan?.pendingQuestions || []).map((q) => `<li><b>${esc(q.id)}</b>: ${esc(q.question)} <span class="why">(${esc(q.why)})</span></li>`).join("\n");

  let nextHtml = "<em>없음</em>";
  if (nextAction) {
    const detail = nextAction.type === "invoke_workflow"
      ? `워크플로 <code>${esc(nextAction.workflow)}</code> 실행 (scriptPath: <code>${esc(nextAction.input?.scriptPath)}</code>)`
      : nextAction.type === "run_command"
        ? `명령 실행: <code>${esc((nextAction.argv || []).join(" "))}</code>`
        : nextAction.type === "user_decision"
          ? `사용자 결정 필요 — ${esc(nextAction.kind)}`
          : nextAction.type === "blocked"
            ? `차단: ${esc(nextAction.reason)}`
            : esc(nextAction.message ?? nextAction.type);
    nextHtml = `<b>[${esc(nextAction.stage ?? "-")}]</b> ${detail}${nextAction.how ? `<div class="obs">${esc(nextAction.how)}</div>` : ""}${nextAction.then ? `<div class="obs">기록: <code>${esc(nextAction.then)}</code></div>` : ""}`;
  }

  const approvals = Object.entries(state.approvals || {}).map(([gate, a]) =>
    `<li><code>${esc(gate)}</code> — ${esc(a.by)} @ ${esc(a.at)} (rev <code class="hash">${esc((a.revision ?? "").slice(0, 12))}…</code>, actor ${esc(a.actor)})</li>`).join("\n");

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>통합 런 상태 — ${esc(state.runId)}</title>
<style>
body{font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;margin:2rem auto;max-width:1100px;padding:0 1rem;color:#1a1a2e;background:#fafaf8}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem;border-bottom:2px solid #e0ded8;padding-bottom:.3rem}
table{border-collapse:collapse;width:100%;font-size:.85rem}
th,td{border:1px solid #e0ded8;padding:.45rem .6rem;text-align:left;vertical-align:top}
th{background:#f0efe9}
code{background:#f0efe9;padding:.05rem .3rem;border-radius:3px;font-size:.82em}
code.hash{color:#7a6a52}
.obs{color:#555;font-size:.92em;margin-top:.2rem}
.unmet{color:#a33;font-size:.92em;margin-top:.2rem}
.why{color:#777}
.gate{background:#fff3cd;border-radius:4px;padding:.05rem .35rem;font-size:.8em}
tr.d-reuse td:nth-child(2){color:#1d6d3a;font-weight:600}
tr.d-blocked td:nth-child(2){color:#a33;font-weight:600}
tr.d-repair td:nth-child(2){color:#8a6d1a;font-weight:600}
tr.s-stale{background:#fdf3f3}
.next{background:#eef4fb;border:1px solid #c8d8ec;border-radius:8px;padding:.8rem 1rem;margin-top:.5rem}
</style></head><body>
<h1>통합 런 상태 — <code>${esc(state.runId)}</code></h1>
<p>생성 ${esc(state.createdAt)} · 갱신 ${esc(state.updatedAt ?? "-")}</p>
<h2>사람이 개입하는 지점 (총 2회)</h2>
<ol>
  <li><b>PRD 리뷰</b> — 인터뷰 미결 질문 + 클라이언트 미감 질문지를 한자리에서 답하고, 반영된 PRD-v2를 승인</li>
  <li><b>시안 리뷰</b> — 세 시안 중 하나를 선택·승인</li>
</ol>
<p style="color:#666;font-size:.85rem">리서치·와이어프레임·시안 생성은 사람 게이트 없이 자율 진행되며 <code>ai_confirmed</code>로 기록됩니다.</p>
<h2>다음 실제 행동</h2>
<div class="next">${nextHtml}</div>
${questions ? `<h2>인테이크 질문 (사용자 답변 필요)</h2><ul>${questions}</ul>` : ""}
<h2>인식된 자료</h2>
<table><tr><th>ID</th><th>출처</th><th>선언된 역할</th><th>인식 유형</th><th>검증</th><th>수집 상태 / 해시</th><th>관찰 내용</th></tr>
${materialRows || '<tr><td colspan="7"><em>자료 없음 — 전체 정상 경로로 진행</em></td></tr>'}</table>
<h2>라우트 플랜 — 무엇을 재사용하고, 무엇을 건너뛰고, 무엇을 생성하는가</h2>
<table><tr><th>스테이지</th><th>결정</th><th>상태</th><th>근거 / 증거 / 미충족 체크</th><th>산출물</th></tr>
${stageRows || '<tr><td colspan="5"><em>인테이크 평가 후 플랜이 생성됩니다</em></td></tr>'}</table>
<h2>승인 기록 (리비전 바인딩)</h2>
<ul>${approvals || "<li><em>아직 없음</em></li>"}</ul>
<p style="color:#888;font-size:.8rem">ai_confirmed는 인간 승인이 아니며 서로 변환되지 않습니다. 재사용된 스테이지는 "검증된 아티팩트의 재사용"으로 기록되며 생성 성공으로 기록되지 않습니다.</p>
</body></html>`;
}
