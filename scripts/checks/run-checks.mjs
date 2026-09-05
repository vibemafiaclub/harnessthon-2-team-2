#!/usr/bin/env node
// Contract and behavior checks for the review/approval core.
// Usage: node scripts/checks/run-checks.mjs
// Covers: PRD samples vs contract, lane-output validation + review sheet
// rendering, revision binding (tamper detection) on render and on review
// recording, revise-round recording, and validator edge cases.

import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validate, assertValid } from '../lib/validate.mjs';
import { renderReviewSheet } from '../render-review-sheet.mjs';
import { recordReview } from '../record-review.mjs';
import { appendFeedback, startReviewServer } from '../review-server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const schema = (name) => JSON.parse(readFileSync(join(root, 'contracts', name), 'utf8'));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

let passed = 0;
const check = (label, fn) => {
  try {
    fn();
    passed++;
    console.log(`ok   ${label}`);
  } catch (e) {
    console.error(`FAIL ${label}\n     ${e.message}`);
    process.exitCode = 1;
  }
};
const expectThrow = (fn, needle) => {
  try {
    fn();
  } catch (e) {
    if (e.message.includes(needle)) return;
    throw new Error(`threw, but message lacked "${needle}": ${e.message}`);
  }
  throw new Error(`expected a throw containing "${needle}"`);
};

// 1. Sample PRDs conform to the input contract.
const prdSchema = schema('prd-input.schema.json');
for (const f of ['wedding-invitation.prd.json', 'petcare-booking.prd.json']) {
  check(`sample ${f} matches prd-input contract`, () => {
    const prd = JSON.parse(readFileSync(join(root, 'samples', f), 'utf8'));
    assertValid(prdSchema, prd, f);
    if (prd.sampleInput !== true) throw new Error('sample PRDs must set sampleInput:true');
  });
}

// 2. Build a fixture run directory with a valid lane-output.
const runDir = mkdtempSync(join(tmpdir(), 'lane-check-'));
const wireHtml = '<!doctype html><title>wf</title><p>fixture wireframe</p>';
writeFileSync(join(runDir, 'wireframe.html'), wireHtml);
const laneOutput = {
  laneId: 'wireframe',
  runId: 'check-run-1',
  prdId: 'prd-wedding-invitation-v1',
  round: 1,
  viewport: { width: 390, height: 844 },
  artifacts: [{ id: 'wf-1', type: 'clickable-wireframe', path: 'wireframe.html', revisionHash: sha256(wireHtml) }],
  screens: [{ id: 's1', name: 'Template gallery', purpose: 'pick a starting template' }],
  qualityChecks: [
    { criterionId: 'C1', axis: 'spec-fidelity', status: 'pass', expected: 'all mustHaveScreens present', observed: '4/4 present' },
    { criterionId: 'C2', axis: 'accessibility', status: 'not-verified', expected: 'labels on all inputs', observed: 'not checked in fixture' },
  ],
  repairHistory: [{ attempt: 1, trigger: 'broken nav link', change: 'fixed href to #screen-2', result: 'links pass' }],
  timing: { startedAt: '2026-09-05T10:00:00+09:00', finishedAt: '2026-09-05T10:12:00+09:00' },
};
writeFileSync(join(runDir, 'lane-output.json'), JSON.stringify(laneOutput, null, 2));

check('valid lane-output renders a review sheet with bound hashes', () => {
  const out = renderReviewSheet(runDir);
  const html = readFileSync(out, 'utf8');
  if (!html.includes(laneOutput.artifacts[0].revisionHash.slice(0, 16))) throw new Error('revision hash missing from sheet');
  if (!html.includes('축별 분리')) throw new Error('axis-separation notice missing');
});

// 3. Tampering with an artifact after packaging must block rendering AND recording.
const tamperedDir = mkdtempSync(join(tmpdir(), 'lane-tamper-'));
cpSync(runDir, tamperedDir, { recursive: true });
writeFileSync(join(tamperedDir, 'wireframe.html'), wireHtml + '<!-- tampered -->');
check('render fails when artifact changed after packaging', () =>
  expectThrow(() => renderReviewSheet(tamperedDir), 'Revision mismatch'));
check('review recording fails when artifact changed after packaging', () =>
  expectThrow(() => recordReview(tamperedDir, { decision: 'approved', decidedAt: '2026-09-05T11:00:00+09:00' }), 'changed since packaging'));

// 4. A clean run records approval bound to the shown revision, then a revise round.
check('approval binds the exact shown revision', () => {
  const rec = recordReview(runDir, { decision: 'approved', decidedAt: '2026-09-05T11:00:00+09:00' });
  if (rec.boundRevisions[0].revisionHash !== laneOutput.artifacts[0].revisionHash) throw new Error('bound hash differs');
  if (rec.decidedBy !== 'human') throw new Error('decidedBy must be human');
});
check('revise decision with feedback appends a second record', () => {
  recordReview(runDir, { decision: 'revise', decidedAt: '2026-09-05T11:05:00+09:00', feedback: 'RSVP form should come before map' });
  const reviews = JSON.parse(readFileSync(join(runDir, 'reviews.json'), 'utf8'));
  if (reviews.length !== 2) throw new Error(`expected 2 records, got ${reviews.length}`);
  if (reviews[1].feedback !== 'RSVP form should come before map') throw new Error('feedback not stored');
});

// 5. In-sheet feedback: form rendered, entries persisted, server round-trip.
check('review sheet contains per-artifact feedback form and submit', () => {
  const html = readFileSync(join(runDir, 'review-sheet.html'), 'utf8');
  if (!html.includes('data-target="wf-1"')) throw new Error('per-artifact feedback textarea missing');
  if (!html.includes('/api/feedback')) throw new Error('feedback submit wiring missing');
});
check('appendFeedback persists items with revisions and rejects empty', () => {
  const entry = appendFeedback(runDir, {
    items: [{ target: 'wf-1', text: 'RSVP 버튼을 더 위로' }],
    general: '전반적으로 좋음',
    revisions: laneOutput.artifacts.map((a) => ({ artifactId: a.id, revisionHash: a.revisionHash })),
  });
  if (entry.items[0].text !== 'RSVP 버튼을 더 위로') throw new Error('item text lost');
  const saved = JSON.parse(readFileSync(join(runDir, 'feedback.json'), 'utf8'));
  if (saved.length !== 1 || saved[0].revisions[0].revisionHash !== laneOutput.artifacts[0].revisionHash) throw new Error('feedback not bound to revision');
  expectThrow(() => appendFeedback(runDir, { items: [{ target: 'x', text: '  ' }] }), 'empty feedback');
});
await (async () => {
  const port = 4790;
  const server = startReviewServer(runDir, port);
  try {
    await new Promise((r) => server.on('listening', r));
    const res = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ target: 'general', text: 'served feedback' }] }),
    });
    const body = await res.json();
    check('review server accepts feedback POST and appends to feedback.json', () => {
      if (!body.ok) throw new Error(`server error: ${body.error}`);
      const saved = JSON.parse(readFileSync(join(runDir, 'feedback.json'), 'utf8'));
      if (saved.length !== 2 || saved[1].items[0].text !== 'served feedback') throw new Error('served entry not appended');
    });
    const page = await fetch(`http://127.0.0.1:${port}/`);
    check('review server serves the review sheet at /', () => {
      if (!page.ok) throw new Error(`status ${page.status}`);
    });
  } finally {
    server.close();
  }
})();

// 6. Validator edge cases the contracts rely on.
check('validator rejects unknown enum values and missing fields', () => {
  const bad = { ...laneOutput, laneId: 'both-lanes' };
  const errs = validate(schema('lane-output.schema.json'), bad);
  if (!errs.some((e) => e.includes('not in enum'))) throw new Error('enum violation not caught');
  const missing = validate(schema('lane-output.schema.json'), { laneId: 'wireframe' });
  if (!missing.some((e) => e.includes('missing required'))) throw new Error('missing-required not caught');
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}. Fixture dirs: ${runDir}`);
