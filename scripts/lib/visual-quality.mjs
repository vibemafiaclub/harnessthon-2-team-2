import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

export const VISUAL_CRITERIA = ['task-hierarchy', 'content-specificity', 'composition', 'density-rhythm', 'decoration-purpose', 'brand-fidelity', 'visual-finish'];
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (v) => typeof v === 'string' && v.trim().length > 0;
export function runFile(root, path) {
  if (!text(path) || isAbsolute(path)) throw new Error('Evidence path must be run-relative');
  const base = realpathSync(root), file = realpathSync(resolve(base, path));
  const rel = relative(base, file);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Evidence escapes run directory');
  return file;
}

export function assertVisualReport(runDir, artifact, viewport, reportPath) {
  const report = JSON.parse(readFileSync(runFile(runDir, reportPath), 'utf8'));
  const reject = (why) => { throw new Error(`Visual quality blocked: ${artifact.id}: ${why}`); };
  if (report.schemaVersion !== 1 || report.artifactId !== artifact.id || report.revisionHash !== artifact.revisionHash) reject('report revision/identity mismatch');
  if (hash(readFileSync(runFile(runDir, artifact.path))) !== artifact.revisionHash) reject('HTML changed after evaluation');
  const capture = JSON.parse(readFileSync(runFile(runDir, report.capturePath), 'utf8'));
  if (capture.captureMethod !== 'aside-browser' || capture.revisionHash !== artifact.revisionHash || capture.artifactPath !== artifact.path) reject('capture not bound to HTML');
  if (capture.viewport?.width !== viewport.width || capture.viewport?.height !== viewport.height) reject('wrong capture viewport');
  const bytes = readFileSync(runFile(runDir, capture.screenshotPath));
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') reject('missing PNG evidence');
  if (hash(bytes) !== capture.screenshotHash || report.screenshotHash !== capture.screenshotHash) reject('screenshot hash mismatch');
  if (bytes.readUInt32BE(16) !== viewport.width || bytes.readUInt32BE(20) < viewport.height) reject('screenshot dimensions mismatch');
  if (capture.metrics?.fontsReady !== true || capture.metrics?.overflowX !== false || capture.metrics?.brokenImages !== 0) reject('render metrics failed or unavailable');
  const checks = report.checks;
  if (!Array.isArray(checks) || checks.length !== VISUAL_CRITERIA.length || new Set(checks.map(c => c.criterionId)).size !== checks.length) reject('missing or duplicate visual criteria');
  for (const id of VISUAL_CRITERIA) {
    const c = checks.find(c => c.criterionId === id);
    if (!c || c.status !== 'pass' || !text(c.observed) || !text(c.reason) || !Array.isArray(c.evidenceRefs) || !c.evidenceRefs.includes(capture.screenshotPath)) reject(`${id} did not pass with evidence`);
  }
  return report;
}

export function assertVisualRelease(runDir, output) {
  if (output.laneId !== 'visual-concept') return;
  if (!output.artifacts?.length) throw new Error('Visual quality blocked: no artifacts');
  if (!output.qualityChecks?.length || output.qualityChecks.some(c => !['pass', 'not-applicable'].includes(c.status))) throw new Error('Visual quality blocked: failed or unverified general checks');
  const reports = output.visualQuality?.reports;
  if (output.visualQuality?.version !== 1 || !Array.isArray(reports) || reports.length !== output.artifacts.length || new Set(reports.map(r => r.artifactId)).size !== reports.length) throw new Error('Visual quality blocked: rendered reports required for every artifact');
  for (const artifact of output.artifacts) {
    const ref = reports.find(r => r.artifactId === artifact.id);
    if (!ref) throw new Error(`Visual quality blocked: missing report ${artifact.id}`);
    assertVisualReport(runDir, artifact, output.viewport, ref.path);
    for (const axis of ['mechanical', 'spec-fidelity', 'accessibility', 'aesthetic']) {
      if (!output.qualityChecks.some(c => c.axis === axis && c.status === 'pass' && c.criterionId.startsWith(`${artifact.conceptId}:`))) throw new Error(`Visual quality blocked: missing ${artifact.id} ${axis} check`);
    }
  }
}
