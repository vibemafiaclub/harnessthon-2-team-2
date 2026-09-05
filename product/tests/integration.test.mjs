import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecondDomain } from '../fixtures/second-domain.mjs';
import { preparePostApprovalInput } from '../integration.mjs';
import { readJSON, writeJSON } from '../lib/io.mjs';
import { validateInput } from '../lib/validate.mjs';

for (const external of [false, true]) {
  test(`pins ${external ? 'external reused' : 'local'} lane sources without changing source revisions`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'product-integration-'));
    try {
      const runDir = join(dir, 'run');
      const source = createSecondDomain(external ? join(dir, 'reused') : runDir);
      const wireframePath = join(source.root, source.input.wireframe.manifest.path);
      const conceptPath = join(source.root, source.input.concept.manifest.path);
      const wireframe = readJSON(wireframePath);
      wireframe.artifacts[0].id = 'wf-reservation';
      writeJSON(wireframePath, wireframe);
      const approvedPath = join(runDir, 'approved.json');
      writeJSON(approvedPath, {
        $schema: 'approved-prd/v1', prdId: source.spec.id, title: source.spec.title,
        domain: 'pet-care-reservation', problem: 'Arrange pet care',
        audience: 'Pet owners', coreTasks: ['Book care']
      });
      const prepared = preparePostApprovalInput({
        sourceRoot: runDir, outputDir: join(runDir, 'production'),
        approvedPrdPath: approvedPath, wireframeManifestPath: wireframePath,
        wireframeId: 'reservation', conceptManifestPath: conceptPath, conceptId: 'pet-care',
        system: 'shadcn', scope: source.input.scope,
        compatibility: source.input.compatibility, approval: source.input.approval
      });
      const validated = validateInput(prepared.inputPath);
      assert.equal(validated.input.wireframe.artifact.sha256, source.input.wireframe.artifact.sha256);
      assert.equal(validated.input.concept.artifact.sha256, source.input.concept.artifact.sha256);
      assert.deepEqual(readFileSync(join(runDir, prepared.input.wireframe.manifest.path)), readFileSync(wireframePath));
      if (external) {
        assert.match(prepared.input.wireframe.manifest.path, /production\/input-sources\/wireframe/);
        writeFileSync(join(source.root, source.input.wireframe.artifact.path), 'upstream changed');
        assert.doesNotThrow(() => validateInput(prepared.inputPath));
      }
      writeFileSync(join(runDir, prepared.input.wireframe.artifact.path), 'tampered snapshot');
      assert.throws(() => validateInput(prepared.inputPath), /Stale or tampered artifact/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
