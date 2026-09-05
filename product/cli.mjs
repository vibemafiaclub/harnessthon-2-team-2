#!/usr/bin/env node
import { resolve } from 'node:path';
import { validateInput, validateSpec } from './lib/validate.mjs';
import { runProduct, inspectRun, bindBrowserEvidence } from './pipeline.mjs';
import { readJSON } from './lib/io.mjs';
const [command,...argv]=process.argv.slice(2);
const get = key => {const i=argv.indexOf(key);return i<0?undefined:argv[i+1];};
try {
  let result;
  if(command==='validate') {
    const context=validateInput(resolve(get('--input'))),spec=get('--spec')?readJSON(get('--spec')):context.spec;
    result={status:'input-valid',inputHash:context.inputHash,normalizationRequired:!spec,checks:spec?validateSpec(spec,context):[]};
    if(result.checks.some(c=>c.status==='fail')) result.status='invalid-spec';
  } else if(command==='run') result=await runProduct({inputPath:resolve(get('--input')),outDir:resolve(get('--out')),specPath:get('--spec'),stopAfterGenerate:argv.includes('--generate-only')});
  else if(command==='status') result=inspectRun(resolve(get('--out')));
  else if(command==='bind-evidence') result=bindBrowserEvidence(resolve(get('--out')),resolve(get('--evidence')));
  else throw new Error('Usage: node product/cli.mjs validate|run --input PATH [--spec PATH] [--out DIR]; status --out DIR; bind-evidence --out DIR --evidence PATH');
  console.log(JSON.stringify(result,null,2));
  if(['invalid-spec','blocked','needs-repair','needs-concept-resolution'].includes(result.status)) process.exitCode=2;
} catch(error) {console.error(JSON.stringify({status:'blocked',error:error.message}));process.exitCode=1;}
