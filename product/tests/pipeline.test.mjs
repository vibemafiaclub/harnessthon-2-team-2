import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecondDomain } from '../fixtures/second-domain.mjs';
import { bindBrowserEvidence, inspectRun, runProduct } from '../pipeline.mjs';
import { validateInput, validateSpec } from '../lib/validate.mjs';
import { digest, readJSON, sha, writeJSON } from '../lib/io.mjs';

const productRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryDirectories = [];
function fixture() {
  mkdirSync(join(productRoot, 'runs'), { recursive: true });
  const dir = mkdtempSync(join(productRoot, 'runs/test-pipeline-'));
  temporaryDirectories.push(dir);
  return createSecondDomain(dir);
}
function clone(value) { return structuredClone(value); }
function failed(checks, id) { return checks.find((check) => check.id === id)?.status === 'fail'; }
const browserCriteria = ['routes-states-viewports', 'task-completion', 'form-recovery', 'controls', 'keyboard-focus', 'font-overflow', 'board', 'portable-http'];
function browserEvidence(state, overrides = {}) {
  return {
    specHash: state.specHash,
    sourceHash: digest(state.artifacts),
    checks: browserCriteria.map((id) => ({ id, status: 'pass', observed: 'Synthetic deterministic browser harness result.' })),
    ...overrides
  };
}
function writeEvidence(root, name, evidence) {
  const path = join(root, name);
  writeJSON(path, evidence);
  return path;
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

test('accepts an explicitly authorized scenario without fabricating or requiring review receipts', () => {
  const { inputPath, root } = fixture();
  const context = validateInput(inputPath);
  assert.equal(context.input.approval.kind, 'user-authorized-scenario');
  assert.match(context.input.approval.authorization, /fixture authorization/i);
  assert.equal(existsSync(join(root, 'reviews.json')), false);
  assert.equal(validateSpec(context.spec, context).some((check) => check.status === 'fail'), false);
});

test('rejects stale manifests and stale selected source artifacts before generation', () => {
  const { inputPath, root } = fixture();
  writeFileSync(join(root, 'manifests/concept.json'), '{"tampered":true}\n');
  assert.throws(() => validateInput(inputPath), /Stale or tampered artifact: manifests\/concept\.json/);

  const second = fixture();
  writeFileSync(join(second.root, 'manifests/wireframe.html'), '<main>changed source</main>\n');
  assert.throws(() => validateInput(second.inputPath), /Stale or tampered artifact: manifests\/wireframe\.html/);
});

test('reports conflicting PRD and client branding as a fidelity failure', () => {
  const { inputPath } = fixture();
  const context = validateInput(inputPath);
  context.input.brandConstraints.primary = '#7c2d12';
  const checks = validateSpec(context.spec, context);
  assert.equal(failed(checks, 'brand-conflict:primary'), true);
});

test('covers every scoped screen and state and rejects a missing required state', () => {
  const { inputPath } = fixture();
  const context = validateInput(inputPath);
  const missingState = clone(context.spec);
  missingState.screens.find((screen) => screen.id === 'reservation-form').states = [{ id: 'default', title: '기본' }];
  assert.equal(failed(validateSpec(missingState, context), 'screen:reservation-form'), true);

  const missingScreen = clone(context.spec);
  missingScreen.screens = missingScreen.screens.filter((screen) => screen.id !== 'reservation-detail');
  assert.equal(failed(validateSpec(missingScreen, context), 'screen:reservation-detail'), true);
});

test('detects dead controls and task/component specification mismatches', () => {
  const { inputPath } = fixture();
  const context = validateInput(inputPath);
  const invalid = clone(context.spec);
  invalid.screens.find((screen) => screen.id === 'carer-list').actions[0].to = 'missing-screen';
  invalid.components = ['Button'];
  invalid.tasks[0].actionIds[1] = 'missing-action';
  const checks = validateSpec(invalid, context);
  assert.equal(failed(checks, 'action:select-carer'), true);
  assert.equal(failed(checks, 'task:book-pet-care'), true);
  assert.equal(failed(checks, 'components'), true);
});

test('reuses a generated revision on interruption/resume instead of creating a duplicate', async () => {
  const { inputPath, specPath, root } = fixture();
  const outDir = join(root, 'output');
  const first = await runProduct({ inputPath, specPath, outDir, stopAfterGenerate: true });
  const second = await runProduct({ inputPath, specPath, outDir, stopAfterGenerate: true });
  assert.equal(first.status, 'generated');
  assert.equal(second.status, 'generated');
  assert.equal(second.revision, first.revision);
  assert.deepEqual(second.revisions, [first.revision]);
  assert.equal(existsSync(join(outDir, first.revision, 'index.html')), true);
});

test('invalidates tampered generated artifacts instead of reusing their evidence', async () => {
  const { inputPath, specPath, root } = fixture();
  const outDir = join(root, 'output');
  const generated = await runProduct({ inputPath, specPath, outDir, stopAfterGenerate: true });
  const index = join(outDir, generated.revision, 'index.html');
  writeFileSync(index, `${readFileSync(index, 'utf8')}<!-- tampered -->\n`);
  assert.throws(() => inspectRun(outDir), /Output changed; evidence invalid: index\.html/);
  await assert.rejects(() => runProduct({ inputPath, specPath, outDir, stopAfterGenerate: true }), /Output changed; evidence invalid: index\.html/);
});

test('stops after exactly three no-change repair attempts and records the exhaustion', async () => {
  const { inputPath, root, spec } = fixture();
  const broken = clone(spec);
  broken.screens.find((screen) => screen.id === 'carer-list').actions[0].to = 'missing-screen';
  const brokenSpecPath = join(root, 'broken-spec.json');
  writeFileSync(brokenSpecPath, `${JSON.stringify(broken, null, 2)}\n`);
  let calls = 0;
  const result = await runProduct({
    inputPath,
    outDir: join(root, 'repair-output'),
    specPath: brokenSpecPath,
    repair: async () => { calls += 1; return clone(broken); }
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.attempt, 3);
  assert.equal(calls, 3);
  assert.equal(result.repairHistory.length, 3);
  assert.ok(result.repairHistory.every((entry) => entry.result === 'no-change'));
});

test('declares unavailable prototype capabilities instead of presenting them as working integrations', () => {
  const { inputPath } = fixture();
  const context = validateInput(inputPath);
  const checks = validateSpec(context.spec, context);
  assert.equal(failed(checks, 'capability:payment-help'), false);
  assert.equal(failed(checks, 'capability:contact-carer'), false);
  assert.equal(context.spec.capabilities.find((capability) => capability.id === 'payments').status, 'unavailable');
});

test('rejects browser evidence from a different normalized specification or artifact inventory', async () => {
  const { inputPath, specPath, root } = fixture();
  const outDir = join(root, 'output');
  const state = await runProduct({ inputPath, specPath, outDir, stopAfterGenerate: true });
  const wrongSpec = writeEvidence(root, 'wrong-spec-evidence.json', browserEvidence(state, { specHash: sha('different-spec') }));
  assert.throws(() => bindBrowserEvidence(outDir, wrongSpec), /Browser evidence revision mismatch/);
  const wrongSource = writeEvidence(root, 'wrong-source-evidence.json', browserEvidence(state, { sourceHash: sha('different-inventory') }));
  assert.throws(() => bindBrowserEvidence(outDir, wrongSource), /Browser evidence revision mismatch/);
});

test('rejects incomplete browser evidence and records a passing synthetic check set as review-ready, never approved', async () => {
  const { inputPath, specPath, root } = fixture();
  const outDir = join(root, 'output');
  const state = await runProduct({ inputPath, specPath, outDir, stopAfterGenerate: true });
  const incomplete = writeEvidence(root, 'incomplete-evidence.json', browserEvidence(state, { checks: [{ id: 'board', status: 'pass', observed: 'Only one criterion.' }] }));
  assert.throws(() => bindBrowserEvidence(outDir, incomplete), /Missing browser criterion routes-states-viewports/);

  const complete = writeEvidence(root, 'complete-evidence.json', browserEvidence(state));
  const bound = bindBrowserEvidence(outDir, complete);
  assert.equal(bound.status, 'ready-for-review');
  const handoff = readJSON(join(outDir, bound.revision, 'handoff.json'));
  assert.equal(handoff.reviewRequired, true);
  assert.equal(handoff.reviewDecision, 'not-recorded');
});

test('invalidates a run when its persisted browser evidence is tampered after binding', async () => {
  const { inputPath, specPath, root } = fixture();
  const outDir = join(root, 'output');
  const state = await runProduct({ inputPath, specPath, outDir, stopAfterGenerate: true });
  bindBrowserEvidence(outDir, writeEvidence(root, 'evidence.json', browserEvidence(state)));
  const storedEvidence = join(outDir, state.revision, 'browser-evidence.json');
  writeFileSync(storedEvidence, '{"tampered":true}\n');
  assert.throws(() => inspectRun(outDir), /Output changed; evidence invalid: browser-evidence\.json/);
});

test('accepts a current revision-bound human approval and rejects a later revise decision', () => {
  const created = fixture();
  const { inputPath, root, input } = created;
  const wireframe = readJSON(join(root, 'manifests/wireframe.json'));
  const concept = readJSON(join(root, 'manifests/concept.json'));
  const approvedWireframe = { reviewId: 'fixture-wf-approved', laneId: 'wireframe', runId: wireframe.runId, round: wireframe.round, decision: 'approved', decidedBy: 'human', decidedAt: '2026-01-01T00:00:02.000Z', boundRevisions: [{ artifactId: 'fixture-wireframe', revisionHash: input.wireframe.artifact.sha256 }] };
  const approvedConcept = { reviewId: 'fixture-concept-approved', laneId: 'visual-concept', runId: concept.runId, round: concept.round, decision: 'approved', decidedBy: 'human', decidedAt: '2026-01-01T00:00:02.000Z', selectedConceptId: 'pet-care', boundRevisions: [{ artifactId: 'fixture-concept', revisionHash: input.concept.artifact.sha256 }] };
  writeJSON(join(root, 'reviews/wireframe.json'), [approvedWireframe]);
  writeJSON(join(root, 'reviews/concept.json'), [approvedConcept]);
  input.approval = {
    kind: 'human-review',
    wireframe: { path: 'reviews/wireframe.json', sha256: sha(readFileSync(join(root, 'reviews/wireframe.json'))) },
    concept: { path: 'reviews/concept.json', sha256: sha(readFileSync(join(root, 'reviews/concept.json'))) }
  };
  writeJSON(inputPath, input);
  assert.equal(validateInput(inputPath).input.approval.kind, 'human-review');

  const revised = { ...approvedConcept, reviewId: 'fixture-concept-revise', decision: 'revise', decidedAt: '2026-01-01T00:00:03.000Z' };
  writeJSON(join(root, 'reviews/concept.json'), [approvedConcept, revised]);
  input.approval.concept.sha256 = sha(readFileSync(join(root, 'reviews/concept.json')));
  writeJSON(inputPath, input);
  assert.throws(() => validateInput(inputPath), /concept: no current revision-bound approval/);
});

test('rejects a stale generator identity stored with a run', async () => {
  const { inputPath, specPath, root } = fixture();
  const outDir = join(root, 'output');
  await runProduct({ inputPath, specPath, outDir, stopAfterGenerate: true });
  const statePath = join(outDir, 'state.json');
  const state = readJSON(statePath);
  state.engineHash = sha('stale-generator');
  writeJSON(statePath, state);
  assert.throws(() => inspectRun(outDir), /Generator source changed; generate a new revision before reusing evidence/);
});

test('repairs a broken route to the supplied existing normalized specification within the retry cap', async () => {
  const { inputPath, root, spec } = fixture();
  const broken = clone(spec);
  broken.screens.find((screen) => screen.id === 'carer-list').actions[0].to = 'missing-screen';
  const brokenPath = join(root, 'broken-spec.json');
  writeJSON(brokenPath, broken);
  let repairs = 0;
  const result = await runProduct({
    inputPath,
    specPath: brokenPath,
    outDir: join(root, 'repaired-output'),
    evaluate: async () => [],
    repair: async ({ checks, attempt }) => {
      repairs += 1;
      assert.equal(attempt, 1);
      assert.equal(failed(checks, 'action:select-carer'), true);
      return clone(spec);
    }
  });
  assert.equal(result.status, 'ready-for-review');
  assert.equal(repairs, 1);
  assert.equal(result.attempt, 1);
  assert.ok(result.repairHistory.length <= 3);
  assert.equal(result.repairHistory[0].result, 'ready-for-review');
});

test('rejects an input pin that attempts to escape its declared root', () => {
  const { inputPath, root, input } = fixture();
  const outside = join(productRoot, 'runs', `escape-${basename(root)}.json`);
  writeFileSync(outside, '{"outside":true}\n');
  temporaryDirectories.push(outside);
  input.prd = { path: `../${basename(outside)}`, sha256: sha(readFileSync(outside)) };
  writeJSON(inputPath, input);
  assert.throws(() => validateInput(inputPath), /Artifact escapes input root/);
});
