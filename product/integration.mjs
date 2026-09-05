/**
 * Deterministic bridge from an integration run's approved artifacts to the
 * pinned input consumed by the post-approval native Workflow.
 *
 * This bridge derives the minimum default-state scope from the selected
 * wireframe manifest when the coordinator has no richer scope. It still
 * requires structure compatibility, because manifests do not encode blocks.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { localPath, readJSON, sha, writeJSON } from './lib/io.mjs';

const systems = new Set(['shadcn', 'seed', 'wanted-montage']);
const colorRoles = new Set(['primary', 'onPrimary', 'bg', 'surface', 'text', 'muted', 'border']);
const bareHash = (value) => String(value ?? '').replace(/^sha256:/, '');
const isHash = (value) => /^[a-f0-9]{64}$/i.test(value);

function fail(message) { throw new Error(`Post-approval integration input: ${message}`); }
function pin(path, label) {
  if (!path || !existsSync(path)) fail(`${label} missing: ${path ?? '(none)'}`);
  return { path: resolve(path), sha256: sha(readFileSync(path)) };
}
function sourceRef(root, path, label) {
  const pinned = pin(path, label);
  const rel = relative(root, pinned.path);
  if (!rel || rel === '..' || rel.startsWith('../')) fail(`${label} escapes coordinator source root`);
  return { path: rel, sha256: pinned.sha256 };
}
function snapshotExternalLane(root, destination, manifestFile, selected, lane) {
  const rel = relative(root, manifestFile.path);
  if (rel !== '..' && !rel.startsWith('../')) return;
  const snapshotDir = resolve(destination, 'input-sources', lane);
  const artifactRelativePath = relative(dirname(manifestFile.path), selected.path);
  localPath(dirname(manifestFile.path), artifactRelativePath);
  const artifactPath = resolve(snapshotDir, artifactRelativePath);
  const manifestPath = resolve(snapshotDir, 'lane-output.json');
  if (artifactPath === manifestPath) fail(`${lane} artifact collides with its manifest`);
  mkdirSync(dirname(artifactPath), { recursive: true });
  localPath(root, relative(root, dirname(artifactPath)));
  if (existsSync(artifactPath)) localPath(root, relative(root, artifactPath));
  if (existsSync(manifestPath)) localPath(root, relative(root, manifestPath));
  writeFileSync(artifactPath, readFileSync(selected.path));
  writeFileSync(manifestPath, readFileSync(manifestFile.path));
  selected.path = artifactPath;
  manifestFile.path = manifestPath;
}
function artifact(manifest, manifestPath, id, label) {
  const found = (manifest.artifacts ?? []).find((item) => item.id === id || item.conceptId === id || item.id === `concept-${id}` || item.id === `wf-${id}`);
  if (!found) fail(`${label} selection "${id}" absent from its manifest`);
  const path = resolve(dirname(manifestPath), found.path ?? '');
  const pinned = pin(path, `${label} artifact`);
  if (!isHash(bareHash(found.revisionHash)) || bareHash(found.revisionHash) !== pinned.sha256) fail(`${label} artifact hash does not match manifest: ${found.path}`);
  return { id: found.id, path, sha256: pinned.sha256, conceptId: found.conceptId ?? null };
}
function requiredScope(scope) {
  if (!scope || !Array.isArray(scope.screens) || !scope.screens.length || !Array.isArray(scope.viewports) || !scope.viewports.length) fail('scope.screens and scope.viewports are required; manifests do not encode meaningful state coverage');
  for (const screen of scope.screens) if (!screen?.id || !Array.isArray(screen.states) || !screen.states.length) fail('every scope screen needs an id and at least one state');
  for (const viewport of scope.viewports) if (!viewport?.id || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)) fail('every scope viewport needs id, integer width and integer height');
  return scope;
}
function scopeFromManifest(wireframe, wireframeId) {
  const screens = (wireframe.screens ?? [])
    .filter((screen) => screen.id?.startsWith(`${wireframeId}:`))
    .map((screen) => ({ id: screen.id.slice(wireframeId.length + 1), states: ['default'] }));
  if (!screens.length) fail(`wireframe manifest has no screens for selected variant "${wireframeId}"`);
  const viewport = wireframe.viewport;
  return requiredScope({ screens, viewports: [{ id: 'approved', width: viewport?.width, height: viewport?.height }] });
}
function requiredCompatibility(compatibility, wireframe, wireframeId, wireframeHtml) {
  if (!compatibility?.representativeScreenId || !Array.isArray(compatibility.sectionOrder) || !compatibility.basis) fail('compatibility requires representativeScreenId, sectionOrder, and an evidence basis');
  if (compatibility.mode === 'normalize-pinned-structure') {
    if (compatibility.representativeScreenId !== 'pending-normalization' || compatibility.sectionOrder.length) fail('normalize-pinned-structure requires representativeScreenId="pending-normalization" and an empty sectionOrder');
    return compatibility;
  }
  if (!compatibility.sectionOrder.length) fail('compatibility.sectionOrder must not be empty outside normalize-pinned-structure mode');
  const sourceId = `${wireframeId}:${compatibility.representativeScreenId}`;
  if (!(wireframe.screens ?? []).some((screen) => screen.id === sourceId)) fail(`representative screen ${sourceId} is absent from the selected wireframe manifest`);
  if (!wireframeHtml.includes(compatibility.representativeScreenId)) fail(`representative screen ${compatibility.representativeScreenId} is absent from selected wireframe HTML`);
  return compatibility;
}
function productBrand(approved) {
  const brand = {};
  const hints = [];
  for (const color of approved.brandConstraints?.colors ?? []) {
    const role = typeof color === 'object' ? color.role : null;
    const value = typeof color === 'object' ? color.value : color;
    if (role && value && colorRoles.has(role)) brand[role] = value;
    if (value) hints.push(`${role ?? 'client color'}: ${value}`);
  }
  for (const font of approved.brandConstraints?.fonts ?? []) {
    const role = typeof font === 'object' ? font.role : null;
    const value = typeof font === 'object' ? font.family : font;
    if (value) brand[role === 'heading' ? 'fontHeading' : 'fontFamily'] = value;
    if (value) hints.push(`${role ?? 'client font'}: ${value}`);
  }
  return { brand, hints };
}

/**
 * Build a fully pinned post-approval input without inventing upstream review
 * records, selected artifacts, scope, or structural evidence.
 */
export function preparePostApprovalInput({ sourceRoot, outputDir, approvedPrdPath, wireframeManifestPath, wireframeId, conceptManifestPath, conceptId, scope, compatibility, approval, coordinatorStatePath, system }) {
  const root = resolve(sourceRoot);
  const destination = resolve(outputDir);
  if (!existsSync(root)) fail(`source root missing: ${root}`);
  if (!approval?.kind) fail('an explicit approval object is required; this adapter never fabricates a lane receipt');
  const approvedFile = pin(approvedPrdPath, 'approved PRD');
  const approved = readJSON(approvedFile.path);
  if (approved.$schema !== 'approved-prd/v1' || !approved.prdId || !approved.title || !approved.problem || !approved.audience || !Array.isArray(approved.coreTasks) || !approved.coreTasks.length) fail('approved PRD is not a usable approved-prd/v1 document');
  const wireframeFile = pin(wireframeManifestPath, 'wireframe manifest');
  const conceptFile = pin(conceptManifestPath, 'concept manifest');
  const wireframe = readJSON(wireframeFile.path), concept = readJSON(conceptFile.path);
  if (wireframe.laneId !== 'wireframe') fail('wireframe manifest has the wrong laneId');
  if (concept.laneId !== 'visual-concept') fail('concept manifest has the wrong laneId');
  if (wireframe.prdId !== approved.prdId || concept.prdId !== approved.prdId) fail('selected manifests do not match approved PRD identity');
  const selectedWireframe = artifact(wireframe, wireframeFile.path, wireframeId, 'wireframe');
  const selectedConcept = artifact(concept, conceptFile.path, conceptId, 'concept');
  const compatible = requiredCompatibility(compatibility, wireframe, wireframeId, readFileSync(selectedWireframe.path, 'utf8'));
  const requestedScope = scope ? requiredScope(scope) : scopeFromManifest(wireframe, wireframeId);
  const chosenSystem = system ?? (systems.has(conceptId) ? conceptId : null);
  if (!systems.has(chosenSystem)) fail(`system is required for concept "${conceptId}"; expected one of ${[...systems].join(', ')}`);
  snapshotExternalLane(root, destination, wireframeFile, selectedWireframe, 'wireframe');
  snapshotExternalLane(root, destination, conceptFile, selectedConcept, 'concept');
  const { brand, hints } = productBrand(approved);
  const productPrd = {
    id: approved.prdId, title: approved.title, domain: approved.domain, problem: approved.problem,
    targetUsers: [approved.audience], background: approved.brandConstraints?.notes ?? '',
    coreFlows: approved.coreTasks.map((task, index) => ({ id: `flow-${index + 1}`, name: task, steps: [task] })),
    mustHaveScreens: (wireframe.screens ?? []).filter(screen => screen.id?.startsWith(`${wireframeId}:`)).map(screen => screen.name),
    brandHints: hints, constraints: approved.constraints ?? [], brandConstraints: brand,
    viewport: requestedScope.viewports[0] ? { width: requestedScope.viewports[0].width, height: requestedScope.viewports[0].height } : undefined
  };
  const productPrdPath = resolve(destination, 'product-prd.json');
  writeJSON(productPrdPath, productPrd);
  const pinnedApproval = structuredClone(approval);
  if (pinnedApproval.kind === 'coordinator-approval') {
    if (!coordinatorStatePath) fail('coordinator-approval requires coordinatorStatePath for an immutable state snapshot');
    const coordinator = pin(coordinatorStatePath, 'coordinator state');
    const snapshotPath = resolve(destination, 'input-sources/coordinator-state.json');
    writeJSON(snapshotPath, readJSON(coordinator.path));
    pinnedApproval.coordinator = {
      ...(pinnedApproval.coordinator ?? {}),
      runState: sourceRef(root, snapshotPath, 'coordinator state snapshot'),
      conceptApproval: {...pinnedApproval.coordinator.conceptApproval, revision: bareHash(pinnedApproval.coordinator.conceptApproval.revision)},
      wireframeRepresentative: {...pinnedApproval.coordinator.wireframeRepresentative,artifactId:selectedWireframe.id,revisionHash:selectedWireframe.sha256}
    };
  }
  const input = {
    version: 1, root: relative(destination, root) || '.', system: chosenSystem,
    prd: sourceRef(root, productPrdPath, 'normalized product PRD'),
    wireframe: { manifest: sourceRef(root, wireframeFile.path, 'wireframe manifest'), artifact: sourceRef(root, selectedWireframe.path, 'wireframe artifact'), artifactId: selectedWireframe.id, selectedId: wireframeId },
    concept: { manifest: sourceRef(root, conceptFile.path, 'concept manifest'), artifact: sourceRef(root, selectedConcept.path, 'concept artifact'), artifactId: selectedConcept.id, selectedId: conceptId },
    scope: requestedScope, brandConstraints: brand,
    compatibility: { mode: compatible.mode, prdHash: sha(readFileSync(productPrdPath)), wireframeHash: selectedWireframe.sha256, conceptHash: selectedConcept.sha256, representativeScreenId: compatible.representativeScreenId, sectionOrder: compatible.sectionOrder, basis: compatible.basis },
    approval: pinnedApproval
  };
  const inputPath = resolve(destination, 'product-input.json');
  writeJSON(inputPath, input);
  return { inputPath, packageDir: resolve(destination, 'package'), productPrdPath, input };
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const metadata = readJSON(resolve(argument('metadata')));
    const result = preparePostApprovalInput({ ...metadata, sourceRoot: argument('source-root') ?? metadata.sourceRoot, outputDir: argument('out') ?? metadata.outputDir });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'blocked', error: error.message }));
    process.exitCode = 1;
  }
}
