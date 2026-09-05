import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, VISUAL_CRITERIA, assertVisualRelease } from '../lib/visual-quality.mjs';
import { renderReviewSheet } from '../render-review-sheet.mjs';
import { recordReview } from '../record-review.mjs';
import { startReviewServer } from '../review-server.mjs';

// Synthetic contract fixture, never treated as live browser/AI evaluation evidence.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'visual-gate-'));
  mkdirSync(join(dir, 'visual-evidence'));
  const html = '<!doctype html><html lang="ko"><p>예약 확인</p></html>';
  writeFileSync(join(dir, 'concept-seed.html'), html);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const capture = { captureMethod: 'aside-browser', artifactPath: 'concept-seed.html', revisionHash: hash(html), viewport: { width: 1, height: 1 }, screenshotPath: 'visual-evidence/c.png', screenshotHash: hash(png), metrics: { fontsReady: true, overflowX: false, brokenImages: 0 } };
  const report = { schemaVersion: 1, artifactId: 'concept-seed', revisionHash: hash(html), capturePath: 'visual-evidence/c.json', screenshotHash: hash(png), checks: VISUAL_CRITERIA.map(criterionId => ({ criterionId, status: 'pass', observed: 'Fixture region observation', reason: 'Fixture task-specific rationale', evidenceRefs: ['visual-evidence/c.png'] })) };
  const output = { laneId: 'visual-concept', runId: 'fixture', prdId: 'p', round: 1, viewport: capture.viewport, artifacts: [{ id: 'concept-seed', conceptId: 'seed', type: 'combined-concept', path: 'concept-seed.html', revisionHash: hash(html) }], qualityChecks: ['mechanical', 'spec-fidelity', 'accessibility', 'aesthetic'].map(axis => ({ criterionId: `seed:${axis}`, axis, status: 'pass', expected: 'fixture', observed: 'fixture' })), repairHistory: [], timing: { startedAt: '2026-09-05', finishedAt: '2026-09-05' }, visualQuality: { version: 1, reports: [{ artifactId: 'concept-seed', path: 'visual-evidence/report.json' }] } };
  function save() { writeFileSync(join(dir, 'visual-evidence/c.png'), png); writeFileSync(join(dir, 'visual-evidence/c.json'), JSON.stringify(capture)); writeFileSync(join(dir, 'visual-evidence/report.json'), JSON.stringify(report)); writeFileSync(join(dir, 'lane-output.json'), JSON.stringify(output)); }
  save(); return { dir, report, capture, output, save };
}
test('complete matching evidence passes and renders', () => { const f=fixture(); assertVisualRelease(f.dir,f.output); assert.ok(renderReviewSheet(f.dir)); });
for (const status of ['fail','not-verified','not-applicable']) test(`visual ${status} blocks release and approval`,()=>{ const f=fixture();f.report.checks[0].status=status;f.save();assert.throws(()=>renderReviewSheet(f.dir),/Visual quality blocked/);assert.throws(()=>recordReview(f.dir,{decision:'approved',decidedAt:'2026-09-05'}),/Visual quality blocked/); });
test('legacy concepts without rendered proof are blocked',()=>{const f=fixture();delete f.output.visualQuality;assert.throws(()=>assertVisualRelease(f.dir,f.output),/reports required/);});
test('missing and duplicate criteria cannot silently pass',()=>{const f=fixture();f.report.checks[0]=f.report.checks[1];f.save();assert.throws(()=>assertVisualRelease(f.dir,f.output),/duplicate/);});
test('unverified general checks block even if visual checks pass',()=>{const f=fixture();f.output.qualityChecks[0].status='not-verified';assert.throws(()=>assertVisualRelease(f.dir,f.output),/unverified/);});
test('recolor invalidates old render report',()=>{const f=fixture();writeFileSync(join(f.dir,'concept-seed.html'),'new color');f.output.artifacts[0].revisionHash=hash('new color');assert.throws(()=>assertVisualRelease(f.dir,f.output),/revision/);});
test('screenshot tamper rejected',()=>{const f=fixture();writeFileSync(join(f.dir,'visual-evidence/c.png'),'not a screenshot');assert.throws(()=>assertVisualRelease(f.dir,f.output),/PNG/);});
test('wrong viewport and overflow fail',()=>{const f=fixture();f.capture.viewport={width:2,height:1};f.save();assert.throws(()=>assertVisualRelease(f.dir,f.output),/viewport/);f.capture.viewport={width:1,height:1};f.capture.metrics.overflowX=true;f.save();assert.throws(()=>assertVisualRelease(f.dir,f.output),/metrics/);});
test('unsupported claims without screenshot reference fail',()=>{const f=fixture();f.report.checks[0].evidenceRefs=[];f.save();assert.throws(()=>assertVisualRelease(f.dir,f.output),/evidence/);});
test('server refuses to serve stale review or raw HTML after invalidation',async()=>{const f=fixture();renderReviewSheet(f.dir);const server=startReviewServer(f.dir,0);await new Promise(r=>server.once('listening',r));try{const url=`http://127.0.0.1:${server.address().port}`;assert.equal((await fetch(url)).status,200);writeFileSync(join(f.dir,'concept-seed.html'),'tamper');assert.equal((await fetch(url)).status,409);assert.equal((await fetch(url+'/concept-seed.html')).status,409);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}});
