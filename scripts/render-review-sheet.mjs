#!/usr/bin/env node
// Render a static HTML review sheet from a run's lane-output.json (decision D7).
// Usage: node scripts/render-review-sheet.mjs <runDir>
// - Recomputes sha256 of each artifact and FAILS if it differs from the recorded
//   revisionHash (approval must bind the exact revision the human sees).
// - Output: <runDir>/review-sheet.html (open in a browser; approve via terminal).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValid } from './lib/validate.mjs';
import { assertVisualRelease } from './lib/visual-quality.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const laneOutputSchema = JSON.parse(readFileSync(join(root, 'contracts/lane-output.schema.json'), 'utf8'));

const AXIS_LABELS = {
  'ux-task': 'UX 과업 성공',
  'spec-fidelity': '스펙 충실도',
  accessibility: '접근성',
  aesthetic: '미적 판단',
  mechanical: '기계적 검사',
};
const LANE_LABELS = { wireframe: '와이어프레임', 'visual-concept': '비주얼 컨셉' };

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderReviewSheet(runDir) {
  const output = JSON.parse(readFileSync(join(runDir, 'lane-output.json'), 'utf8'));
  assertValid(laneOutputSchema, output, `lane-output.json in ${runDir}`);
  assertVisualRelease(runDir, output);

  for (const artifact of output.artifacts) {
    const actual = sha256File(join(runDir, artifact.path));
    if (actual !== artifact.revisionHash) {
      throw new Error(
        `Revision mismatch for ${artifact.id}: recorded ${artifact.revisionHash.slice(0, 12)}… but file is ${actual.slice(0, 12)}…. ` +
          'Re-package the run before review; approval must bind the shown revision.'
      );
    }
  }

  const checksRows = output.qualityChecks
    .map(
      (c) => `<tr class="st-${c.status}"><td>${esc(c.criterionId)}</td><td>${esc(AXIS_LABELS[c.axis] ?? c.axis)}</td><td class="status">${esc(c.status)}</td><td>${esc(c.expected)}</td><td>${esc(c.observed)}</td></tr>`
    )
    .join('\n');

  const repairs = output.repairHistory.length
    ? `<ol>${output.repairHistory.map((r) => `<li><b>#${r.attempt}</b> ${esc(r.trigger)} → ${esc(r.change)}${r.result ? ` (${esc(r.result)})` : ''}</li>`).join('')}</ol>`
    : '<p>자동 수리가 필요하지 않았습니다.</p>';

  const artifactBlocks = output.artifacts
    .map(
      (a) => `<section class="artifact">
  <h3>${esc(a.id)} <code>${esc(a.type)}</code>${a.conceptId ? ` — 컨셉 ${esc(a.conceptId)}` : ''}</h3>
  <p class="rev">리비전 <code>${esc(a.revisionHash.slice(0, 16))}</code> · <a href="${esc(a.path)}" target="_blank">open full page</a></p>
  <iframe src="${esc(a.path)}" loading="lazy"></iframe>
  <label class="fb-label" for="fb-${esc(a.id)}">이 산출물에 대한 피드백</label>
  <textarea class="fb" id="fb-${esc(a.id)}" data-target="${esc(a.id)}" placeholder="예: 상단 인사말이 너무 길어요. RSVP 버튼을 더 위로."></textarea>
</section>`
    )
    .join('\n');

  const concepts = (output.concepts ?? [])
    .map((c) => `<li><b>${esc(c.name)}</b> (${esc(c.id)}) — ${esc(c.direction)}<br><i>차별점:</i> ${esc(c.differentiation)}</li>`)
    .join('\n');
  const screens = (output.screens ?? [])
    .map((s) => `<li><b>${esc(s.name)}</b> (${esc(s.id)}) — ${esc(s.purpose)}</li>`)
    .join('\n');

  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>리뷰: ${esc(LANE_LABELS[output.laneId] ?? output.laneId)} · ${esc(output.runId)}</title>
<style>
  body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#f6f5f2;color:#1f2328}
  header{background:#1f2328;color:#fff;padding:16px 24px}
  header code{background:#3a3f45;padding:1px 6px;border-radius:4px}
  main{max-width:1100px;margin:0 auto;padding:24px}
  h2{margin-top:32px;border-bottom:2px solid #d8d5cf;padding-bottom:6px}
  table{border-collapse:collapse;width:100%;background:#fff}
  td,th{border:1px solid #d8d5cf;padding:6px 10px;text-align:left;vertical-align:top}
  .st-pass .status{color:#0a7a35;font-weight:600}
  .st-fail .status{color:#c22525;font-weight:600}
  .st-not-verified .status{color:#9a6700;font-weight:600}
  .artifact{background:#fff;border:1px solid #d8d5cf;border-radius:8px;padding:16px;margin:16px 0}
  .artifact iframe{width:100%;height:720px;border:1px solid #d8d5cf;border-radius:6px;background:#fff}
  .rev{color:#57606a}
  .notice{background:#fff8e5;border:1px solid #e6d9a8;border-radius:8px;padding:12px 16px}
  .fb-label{display:block;margin-top:12px;font-weight:600}
  textarea.fb{width:100%;box-sizing:border-box;min-height:64px;margin-top:6px;padding:8px;border:1px solid #d8d5cf;border-radius:6px;font:inherit}
  #fb-submit{margin-top:12px;padding:10px 20px;border:0;border-radius:6px;background:#1f2328;color:#fff;font:inherit;font-weight:600;cursor:pointer}
  #fb-status{margin-left:12px;font-weight:600}
</style></head><body>
<header>
  <h1>${esc(LANE_LABELS[output.laneId] ?? output.laneId)} 레인 리뷰 — 라운드 ${output.round}</h1>
  <p>run <code>${esc(output.runId)}</code> · PRD <code>${esc(output.prdId)}</code> · 뷰포트 ${output.viewport.width}×${output.viewport.height} · 생성 ${esc(output.timing.startedAt)} → ${esc(output.timing.finishedAt)}</p>
</header>
<main>
<div class="notice">승인/수정 요청/거부는 <b>터미널 세션에서</b> 입력해주세요. 결정은 여기 표시된 리비전 해시에 그대로 바인딩되어 기록됩니다. 리뷰 축은 의도적으로 분리 보고되며, 단일 통합 점수는 없습니다.</div>
${screens ? `<h2>화면 목록</h2><ul>${screens}</ul>` : ''}
${concepts ? `<h2>이번 배치의 컨셉</h2><ul>${concepts}</ul>` : ''}
<h2>산출물</h2>
${artifactBlocks}
<h2>품질 검사 (축별 분리)</h2>
<table><tr><th>기준</th><th>축</th><th>상태</th><th>기대</th><th>관찰</th></tr>
${checksRows}</table>
<h2>자동 수리 이력 (투명성 공개)</h2>
${repairs}
${output.rationaleSummary ? `<h2>근거 요약</h2><p>${esc(output.rationaleSummary)}</p>` : ''}
<h2>피드백 제출</h2>
<label class="fb-label" for="fb-general">전체 코멘트</label>
<textarea class="fb" id="fb-general" placeholder="레인 전체에 대한 피드백을 자유롭게 적어주세요."></textarea>
<button id="fb-submit">피드백 제출</button><span id="fb-status"></span>
<p class="rev">제출된 피드백은 이 run의 <code>feedback.json</code>에 리비전 해시와 함께 기록되어 Claude 세션이 다음 라운드에 반영합니다. 파일로 직접 열었다면(주소가 file://) 제출 시 클립보드에 복사되니 터미널에 붙여넣어 주세요.</p>
<script>
const REVISIONS = ${JSON.stringify(output.artifacts.map((a) => ({ artifactId: a.id, revisionHash: a.revisionHash })))};
document.getElementById('fb-submit').addEventListener('click', async () => {
  const items = [...document.querySelectorAll('textarea.fb[data-target]')]
    .map((t) => ({ target: t.dataset.target, text: t.value }))
    .filter((i) => i.text.trim());
  const general = document.getElementById('fb-general').value.trim();
  const status = document.getElementById('fb-status');
  if (!items.length && !general) { status.textContent = '작성된 피드백이 없습니다.'; return; }
  const payload = { items, general, revisions: REVISIONS };
  try {
    const res = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('server rejected');
    status.textContent = '제출 완료 — Claude 세션이 feedback.json에서 읽습니다.';
  } catch {
    const text = [...items.map((i) => '[' + i.target + '] ' + i.text), general ? '[전체] ' + general : ''].filter(Boolean).join('\\n');
    try { await navigator.clipboard.writeText(text); status.textContent = '서버가 없어 클립보드에 복사했습니다 — 터미널에 붙여넣어 주세요.'; }
    catch { status.textContent = '전송 실패. 아래 내용을 직접 복사해 터미널에 붙여넣어 주세요:\\n' + text; }
  }
});
</script>
</main></body></html>`;

  const outPath = join(runDir, 'review-sheet.html');
  writeFileSync(outPath, html);
  return outPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('Usage: node scripts/render-review-sheet.mjs <runDir>');
    process.exit(1);
  }
  console.log(renderReviewSheet(runDir));
}
