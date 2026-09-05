import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha, digest, inventory, readJSON, writeJSON, files } from './lib/io.mjs';
import { validateInput, validateSpec } from './lib/validate.mjs';

const engineRoot = fileURLToPath(new URL('./', import.meta.url));
export function engineHash() {
  const paths=files(engineRoot).filter(p => !p.startsWith('examples/') && !p.startsWith('tests/') && !p.startsWith('fixtures/') && !p.startsWith('runs/'));
  paths.push('../contracts/product-spec.schema.json','../contracts/post-approval-input.schema.json','../contracts/product-handoff.schema.json');
  return digest(paths.map(p => ({path:p,hash:sha(readFileSync(join(engineRoot,p)))})));
}
function assertUnchanged(dir, artifacts) {
  for(const a of artifacts) if(!existsSync(join(dir,a.path)) || sha(readFileSync(join(dir,a.path))) !== a.sha256) throw new Error(`Output changed; evidence invalid: ${a.path}`);
}
export function inspectRun(outDir) {
  const state = readJSON(join(outDir,'state.json'));
  if(state.engineHash !== engineHash()) throw new Error('Generator source changed; generate a new revision before reusing evidence');
  if(state.artifacts) assertUnchanged(join(outDir,state.revision),state.artifacts);
  if(state.browserEvidence) assertUnchanged(join(outDir,state.revision),[state.browserEvidence]);
  return state;
}

export async function runProduct({ inputPath, outDir, specPath, repair, evaluate, stopAfterGenerate = false }) {
  outDir = resolve(outDir);
  const context = validateInput(inputPath);
  let spec = specPath ? readJSON(specPath) : context.spec;
  if(!spec) throw new Error('Normalization required: supply --spec from the native Workflow normalization agent');
  const inputHash = context.inputHash, sourceHash = engineHash(), key = digest({inputHash,sourceHash});
  mkdirSync(outDir,{recursive:true});
  const stateFile = join(outDir,'state.json');
  let state = existsSync(stateFile) ? readJSON(stateFile) : null;
  let sourceHistory=[];
  if(state && state.key !== key) {
    writeJSON(join(outDir,'history',`${state.key}.json`),state);
    sourceHistory=[...(state.sourceHistory??[]),{fromRevision:state.revision,fromInputHash:state.inputHash,toInputHash:inputHash,fromEngineHash:state.engineHash,toEngineHash:sourceHash,trigger:state.checks?.filter(c=>c.status==='fail').map(c=>c.id)??[],result:'derived-evidence-invalidated'}];
    state = null; // Inputs/source updates start a new immutable revision, never reuse evidence.
  }
  if(!state) state = {version:1,key,inputHash,engineHash:sourceHash,status:'normalized',attempt:0,repairHistory:[],sourceHistory,revisions:[]};
  if(state.status === 'ready-for-review' && state.specHash === digest(spec)) {
    inspectRun(outDir); return {...state,resumed:true};
  }
  if(state.status === 'blocked' && state.attempt >= 3) return state;
  for(;;) {
    const specHash = digest(spec);
    if(state.specHash && state.specHash !== specHash && state.status !== 'normalized') {
      if(state.attempt >= 3) { state.status='blocked'; writeJSON(stateFile,state); return state; }
      const previous = state.specHash;
      state.attempt++;
      state.repairHistory.push({attempt:state.attempt,fromSpecHash:previous,toSpecHash:specHash,trigger:state.checks?.filter(c=>c.status==='fail').map(c=>c.id)??[],result:'pending'});
    }
    state.specHash = specHash;
    const revision = `revisions/${key.slice(0,12)}-${specHash.slice(0,12)}-a${state.attempt}`;
    const revisionDir = join(outDir,revision);
    state.revision = revision;
    const checks = validateSpec(spec,context);
    const failures = checks.filter(c=>c.status==='fail');
    const material = failures.filter(c=>c.axis==='fidelity');
    state.checks = checks;
    if(material.length) {
      state.status='needs-concept-resolution'; state.failures=material;
      writeJSON(stateFile,state); return state;
    }
    if(!failures.length) {
      if(existsSync(revisionDir)) {
        const stored = readJSON(join(revisionDir,'revision.json'));
        assertUnchanged(revisionDir,stored.artifacts);
        state.artifacts=stored.artifacts;
      } else {
        const staging = `${revisionDir}.partial`;
        rmSync(staging,{recursive:true,force:true}); mkdirSync(staging,{recursive:true});
        const { generateProduct } = await import('./render.mjs');
        await generateProduct({...spec,revision:digest({specHash,engineHash:sourceHash})},staging);
        writeJSON(join(staging,'normalized-spec.json'),spec);
        writeJSON(join(staging,'input-snapshot.json'),context.input);
        writeJSON(join(staging,'screen-state-matrix.json'),spec.screens.flatMap(s=>s.states.flatMap(state=>spec.viewports.map(viewport=>({screenId:s.id,route:s.route,state:state.id,viewport,sourceScreenId:s.sourceScreenId})))));
        // Preserve only selected evidence, not another worktree or mutable links.
        mkdirSync(join(staging,'sources'),{recursive:true});
        writeFileSync(join(staging,'sources/prd.json'),JSON.stringify(context.prd,null,2));
        for(const lane of ['wireframe','concept']) {
          writeFileSync(join(staging,`sources/${lane}.html`),context.selected[lane].html);
          writeJSON(join(staging,`sources/${lane}-manifest.json`),context.selected[lane].manifest);
        }
        state.artifacts=inventory(staging);
        writeJSON(join(staging,'revision.json'),{inputHash,specHash,engineHash:sourceHash,artifacts:state.artifacts});
        mkdirSync(dirname(revisionDir),{recursive:true}); renameSync(staging,revisionDir);
      }
      if(!state.revisions.includes(revision)) state.revisions.push(revision);
      state.status='generated'; writeJSON(stateFile,state);
      if(stopAfterGenerate) return state;
      if(evaluate) checks.push(...await evaluate({spec,revisionDir,revision,specHash}));
      else checks.push({id:'browser-execution',axis:'browser',status:'not-verified',observed:'Run product/browser-check.mjs; screenshots alone do not demonstrate task completion.'});
    }
    state.checks=checks;
    const failed = checks.filter(c=>c.status==='fail');
    const pending = checks.filter(c=>c.status==='not-verified');
    state.status=failed.length ? (state.attempt>=3?'blocked':'needs-repair') : pending.length?'awaiting-browser-verification':'ready-for-review';
    state.failures=failed;
    if(state.repairHistory.length && state.repairHistory.at(-1).result!=='no-change') state.repairHistory.at(-1).result=state.status;
    writeJSON(stateFile,state);
    if(existsSync(revisionDir)) writeJSON(join(revisionDir,'checks.json'),{inputHash,specHash,engineHash:sourceHash,revision,checks,status:state.status});
    if(!failed.length || !repair || state.attempt>=3) return state;
    const repaired = await repair({spec:structuredClone(spec),checks,attempt:state.attempt+1,revisionDir});
    if(!repaired || digest(repaired)===digest(spec)) {
      state.attempt++;
      state.repairHistory.push({attempt:state.attempt,fromSpecHash:specHash,toSpecHash:specHash,trigger:failed.map(c=>c.id),result:'no-change'});
      if(state.attempt>=3) {state.status='blocked';writeJSON(stateFile,state);return state;}
    } else spec=repaired;
  }
}

export function bindBrowserEvidence(outDir,evidencePath) {
  const state=inspectRun(outDir), evidence=readJSON(evidencePath), dir=join(outDir,state.revision);
  if(evidence.specHash!==state.specHash || evidence.sourceHash!==digest(state.artifacts)) throw new Error('Browser evidence revision mismatch');
  const required=['routes-states-viewports','task-completion','form-recovery','controls','keyboard-focus','font-overflow','board','portable-http'];
  for(const id of required) if(!evidence.checks.some(c=>c.id===id && ['pass','fail','not-verified'].includes(c.status))) throw new Error(`Missing browser criterion ${id}`);
  state.checks=state.checks.filter(c=>c.axis!=='browser').concat(evidence.checks.map(c=>({...c,axis:'browser'})));
  state.failures=state.checks.filter(c=>c.status==='fail');
  state.status=state.failures.length ? (state.attempt>=3?'blocked':'needs-repair') : state.checks.some(c=>c.status==='not-verified')?'awaiting-browser-verification':'ready-for-review';
  const evidenceRef={path:'browser-evidence.json',sha256:sha(readFileSync(evidencePath))};
  writeJSON(join(dir,'browser-evidence.json'),evidence);
  // Hash the persisted normalized representation, not whitespace in an import file.
  evidenceRef.sha256=sha(readFileSync(join(dir,evidenceRef.path)));
  state.browserEvidence=evidenceRef;
  writeJSON(join(outDir,'state.json'),state);
  writeJSON(join(dir,'checks.json'),{inputHash:state.inputHash,specHash:state.specHash,engineHash:state.engineHash,revision:state.revision,checks:state.checks,status:state.status});
  writeJSON(join(dir,'handoff.json'),{version:1,stage:'post-approval-prototype',status:state.status,revision:state.revision,inputHash:state.inputHash,specHash:state.specHash,engineHash:state.engineHash,entry:'index.html',reviewRequired:true,reviewDecision:'not-recorded',artifacts:state.artifacts,evidence:evidenceRef,limits:readJSON(join(dir,'normalized-spec.json')).capabilities,repairHistory:state.repairHistory});
  return state;
}
