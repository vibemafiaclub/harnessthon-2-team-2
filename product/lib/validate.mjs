import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValid } from '../../scripts/lib/validate.mjs';
import { readJSON, localPath, sha, digest } from './io.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fail = message => { throw new Error(message); };
const unique = (values, name) => { if (new Set(values).size !== values.length) fail(`Duplicate ${name}`); };
const pin = (root, ref) => {
  if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256)) fail('Missing SHA-256 pin');
  const path = localPath(root, ref.path), bytes = readFileSync(path);
  if (sha(bytes) !== ref.sha256) fail(`Stale or tampered artifact: ${ref.path}`);
  return { path, bytes, ref };
};

export function validateInput(inputPath) {
  const input = readJSON(inputPath), root = resolve(dirname(inputPath), input.root ?? '.');
  assertValid(readJSON(resolve(repo, 'contracts/post-approval-input.schema.json')), input, 'post-approval input');
  const prdFile = pin(root, input.prd), prd = JSON.parse(prdFile.bytes);
  assertValid(readJSON(resolve(repo, 'contracts/prd-input.schema.json')), prd, 'PRD');
  const selected = {};
  for (const lane of ['wireframe', 'concept']) {
    const selection = input[lane], manifestFile = pin(root, selection.manifest), artifactFile = pin(root, selection.artifact);
    const manifest = JSON.parse(manifestFile.bytes);
    assertValid(readJSON(resolve(repo, 'contracts/lane-output.schema.json')), manifest, lane);
    if (manifest.prdId !== prd.id || manifest.laneId !== (lane === 'concept' ? 'visual-concept' : lane)) fail(`${lane}: incompatible PRD/lane`);
    const artifact = manifest.artifacts.find(a => a.id === selection.artifactId);
    if (!artifact || artifact.revisionHash !== selection.artifact.sha256 || localPath(dirname(manifestFile.path), artifact.path) !== artifactFile.path) fail(`${lane}: manifest/artifact mismatch`);
    if (lane === 'concept' && artifact.conceptId !== selection.selectedId) fail('Selected concept mismatch');
    if (lane === 'concept' && !manifest.concepts?.some(c => c.id === selection.selectedId)) fail('Missing selected concept metadata');
    if (lane === 'wireframe' && !manifest.screens?.some(s => s.id.startsWith(selection.selectedId + ':'))) fail('Missing selected structure metadata');
    selected[lane] = { manifest, artifact, html: artifactFile.bytes.toString(), path: artifactFile.path };
    if (input.approval.kind === 'human-review') {
      const reviewFile = pin(root, input.approval[lane]);
      const records = JSON.parse(reviewFile.bytes);
      const review = records.at(-1);
      if (!review || review.decision !== 'approved' || review.decidedBy !== 'human' || review.runId !== manifest.runId || review.round !== manifest.round || review.laneId !== manifest.laneId || !review.boundRevisions.some(r => r.artifactId === artifact.id && r.revisionHash === artifact.revisionHash)) fail(`${lane}: no current revision-bound approval`);
      if (lane === 'concept' && review.selectedConceptId !== selection.selectedId) fail('Approval selected concept mismatch');
    }
  }
  if (input.approval.kind === 'user-authorized-scenario' && (!input.approval.authorization || !input.approval.assumption)) fail('Scenario requires explicit authorization and assumption; never forge reviewer receipts');
  if(input.approval.kind==='coordinator-approval') {
    const approval=input.approval.coordinator;
    const state=JSON.parse(pin(root,approval?.runState).bytes);
    const recorded=state.approvals?.concept_approval,claimed=approval.conceptApproval,representative=state.stages?.wireframe?.representative;
    const bare=value=>String(value??'').replace(/^sha256:/,'');
    if(!recorded||recorded.actor!=='human_approved'||!recorded.by||!recorded.at||recorded.by!==claimed?.by||recorded.at!==claimed.at||bare(recorded.revision)!==claimed.revision||recorded.note!==claimed.conceptId||claimed.conceptId!==input.concept.selectedId||claimed.revision!==input.concept.artifact.sha256) fail('Coordinator concept approval does not bind selected revision');
    if(!representative||representative.variantId!==input.wireframe.selectedId||bare(representative.sha256)!==input.wireframe.artifact.sha256||approval.wireframeRepresentative?.artifactId!==input.wireframe.artifactId||approval.wireframeRepresentative?.variantId!==representative.variantId||approval.wireframeRepresentative?.revisionHash!==input.wireframe.artifact.sha256) fail('Coordinator representative does not bind selected wireframe');
    if(state.stages?.concepts?.status==='stale'||state.stages?.wireframe?.status==='stale')fail('Coordinator approval depends on stale upstream output');
  }
  const compatibility = input.compatibility;
  if (compatibility.wireframeHash !== input.wireframe.artifact.sha256 || compatibility.conceptHash !== input.concept.artifact.sha256 || compatibility.prdHash !== input.prd.sha256) fail('Compatibility binding is stale');
  const deferred=compatibility.mode==='normalize-pinned-structure'&&input.approval.kind==='coordinator-approval';
  if(!deferred){
    const sourceScreen = `${input.wireframe.selectedId}:${compatibility.representativeScreenId}`;
    if (!selected.wireframe.manifest.screens.some(s => s.id === sourceScreen)) fail('Representative screen not in selected structure');
    if (!selected.wireframe.html.includes(compatibility.representativeScreenId)) fail('Representative screen absent from wireframe HTML');
    if (!compatibility.sectionOrder?.length) fail('Missing structure/style compatibility evidence');
  }
  if(!compatibility.basis)fail('Missing compatibility basis');
  const spec = input.spec ? JSON.parse(pin(root, input.spec).bytes) : null;
  return { input, inputHash: digest(input), root, prd, selected, spec };
}

export function contrast(a, b) {
  const lum = hex => { const c = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126*c[0]+.7152*c[1]+.0722*c[2]; };
  const x = lum(a), y = lum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}

function brandTokens(constraints = {}) {
  const result={};
  const aliases={background:'bg',foreground:'text',body:'fontFamily',heading:'fontHeading'};
  for(const [key,value] of Object.entries(constraints)) if(!['colors','fonts','notes','source','precedence','unspecifiedProperties'].includes(key)) result[key]=value;
  for(const color of constraints.colors??[]) {
    if(typeof color!=='object'||!color.role) fail('Ambiguous PRD brand color: specify a semantic role before normalization');
    result[aliases[color.role]??color.role]=color.value;
  }
  for(const font of constraints.fonts??[]) {
    if(typeof font!=='object'||!font.role||!font.family) fail('Ambiguous PRD font: specify role and family before normalization');
    result[aliases[font.role]??font.role]=font.family;
  }
  return result;
}

export function validateSpec(spec, context) {
  const { input, prd, selected } = context;
  assertValid(readJSON(resolve(repo, 'contracts/product-spec.schema.json')), spec, 'product spec');
  const checks = [], check = (id, ok, observed, axis = 'mechanical') => checks.push({ id, axis, status: ok ? 'pass' : 'fail', observed });
  check('identity', spec.id === prd.id && spec.system === input.system, 'PRD ID and chosen pattern system preserved', 'fidelity');
  unique(spec.screens.map(s => s.id), 'screen ID'); unique(spec.screens.map(s => s.route), 'route');
  unique(spec.viewports.map(v => v.id), 'viewport ID');
  const screenById = new Map(spec.screens.map(s => [s.id, s])), actionById = new Map();
  check('entry', screenById.has(spec.entryScreen), 'Entry screen exists');
  check('viewports', digest(spec.viewports) === digest(input.scope.viewports) && spec.viewports.every(v => Number.isInteger(v.width) && Number.isInteger(v.height) && v.width > 0 && v.height > 0), 'Exact declared viewport dimensions');
  if (prd.viewport) check('prd-viewport', spec.viewports.some(v => v.width === prd.viewport.width && v.height === prd.viewport.height), 'PRD viewport retained', 'fidelity');
  for (const required of input.scope.screens) {
    const s = screenById.get(required.id);
    check(`screen:${required.id}`, !!s && required.states.every(id => s.states.some(state => state.id === id)), 'Every required screen and meaningful state covered', 'coverage');
  }
  for (const name of prd.mustHaveScreens ?? []) check(`prd-screen:${name}`, spec.screens.some(s => s.prdScreen === name), name, 'coverage');
  for (const s of spec.screens) {
    unique(s.states.map(state => state.id), `${s.id} state`); unique(s.sections.map(section => section.id), `${s.id} section`);
    check(`route:${s.id}`, /^\/[a-z0-9/-]+$/.test(s.route) && !['/board','/ia','/flow','/components'].includes(s.route), 'Valid non-reserved route');
    check(`source:${s.id}`, selected.wireframe.manifest.screens.some(source => source.id === `${input.wireframe.selectedId}:${s.sourceScreenId}`), `Source ${s.sourceScreenId}`, 'fidelity');
    check(`state:${s.id}`, s.states.some(v => v.id === 'default'), 'Default state available');
    for (const action of s.actions) {
      if (actionById.has(action.id)) fail(`Duplicate action ID ${action.id}`);
      actionById.set(action.id, { ...action, from: s.id });
      const target = screenById.get(action.to);
      check(`action:${action.id}`, !!target && (!action.targetState || target.states.some(v => v.id === action.targetState)), 'Action target and state exist');
      if (action.kind === 'submit') check(`recovery:${action.id}`, s.states.some(v => v.id === 'error'), 'Forms include an error/retry state', 'ux-task');
      if (action.kind === 'unavailable') check(`capability:${action.id}`, spec.capabilities.some(c => c.id === action.capability && c.status === 'unavailable'), 'Unavailable integration explicitly described');
    }
  }
  const reachable = new Set([spec.entryScreen]);
  for (let n=0;n<spec.screens.length;n++) for(const s of spec.screens) if(reachable.has(s.id)) for(const a of s.actions) reachable.add(a.to);
  check('reachability', spec.screens.every(s => reachable.has(s.id)), `Reachable: ${[...reachable].join(', ')}`, 'ux-task');
  for (const task of spec.tasks) {
    const path = task.actionIds.map(id => actionById.get(id));
    check(`task:${task.id}`, task.screenIds.length === path.length + 1 && path.every((a,i) => a && a.from === task.screenIds[i] && a.to === task.screenIds[i+1]), 'Task follows implemented action transitions', 'ux-task');
  }
  for(const flow of prd.coreFlows) check(`flow:${flow.id}`, spec.tasks.some(t => t.id === flow.id), 'PRD core flow represented', 'coverage');
  const derived=input.compatibility.mode==='normalize-pinned-structure';
  const structure=derived?spec.sourceEvidence:input.compatibility;
  const representative = spec.screens.find(s => s.sourceScreenId === structure?.representativeScreenId);
  check('approved-section-order', !!representative && !!structure?.sectionOrder?.length && !!structure?.basis && selected.wireframe.html.includes(structure.representativeScreenId) && digest(representative.sections.map(s => s.id)) === digest(structure.sectionOrder), derived?'AI-derived block inventory must cite pinned HTML; final semantic fidelity is inspected by the human.':'Representative approved block order preserved', 'fidelity');
  const concept = selected.concept.manifest.concepts.find(c => c.id === input.concept.selectedId).tokenOverlay;
  const mapped = { primary: concept.primary ?? concept.color?.primary, bg: concept.bg ?? concept.color?.bg, surface: concept.surface ?? concept.color?.surface, text: concept.text ?? concept.color?.text, fontFamily: concept.fontStack };
  const clientBrand=brandTokens(input.brandConstraints),prdBrand=brandTokens(prd.brandConstraints);
  const brand = { ...clientBrand, ...prdBrand };
  for(const [key,value] of Object.entries(clientBrand)) if(prdBrand[key] && prdBrand[key] !== value) check(`brand-conflict:${key}`, false, 'Client input contradicts PRD; return to concept approval', 'fidelity');
  for(const [key,value] of Object.entries({...mapped,...brand})) if(value) check(`token:${key}`, spec.tokens[key] === value, `Expected ${value}; observed ${spec.tokens[key]}`, 'fidelity');
  for(const key of ['primary','onPrimary','bg','surface','text','muted','border']) if(!/^#[a-f0-9]{6}$/i.test(spec.tokens[key])) fail(`Invalid color token ${key}`);
  for(const [fg,bg] of [['text','bg'],['text','surface'],['muted','surface'],['muted','bg'],['onPrimary','primary']]) check(`contrast:${fg}/${bg}`, contrast(spec.tokens[fg],spec.tokens[bg]) >= 4.5, contrast(spec.tokens[fg],spec.tokens[bg]).toFixed(2), 'accessibility');
  check('components', digest([...spec.components].sort()) === digest(['Button','Card','Field','Notice','Screen'].sort()), 'Supported shared primitives are declared consistently', 'coverage');
  return checks;
}
