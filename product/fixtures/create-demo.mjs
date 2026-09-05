import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { sha, writeJSON, readJSON } from '../lib/io.mjs';
import { weddingSpec, guestSections } from './wedding.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const base = join(root,'product/examples');
const ref = path => ({path,sha256:sha(readFileSync(join(root,path)))});
writeJSON(join(base,'wedding-spec.json'),weddingSpec);
const wf = readJSON(join(root,'runs/wf-wedding-r3/lane-output.json'));
const vc = readJSON(join(root,'runs/vc-wedding-r3/lane-output.json'));
const input = {
  version:1,root:'../..',prd:ref('samples/wedding-invitation.prd.json'),spec:ref('product/examples/wedding-spec.json'),system:'shadcn',
  wireframe:{manifest:ref('runs/wf-wedding-r3/lane-output.json'),artifact:ref('runs/wf-wedding-r3/wireframe-wizard.html'),artifactId:'wf-wizard',selectedId:'wizard'},
  concept:{manifest:ref('runs/vc-wedding-r3/lane-output.json'),artifact:ref('runs/vc-wedding-r3/concept-shadcn.html'),artifactId:'concept-shadcn',selectedId:'shadcn'},
  scope:{screens:weddingSpec.screens.map(s=>({id:s.id,states:s.states.map(v=>v.id)})),viewports:weddingSpec.viewports},
  compatibility:{prdHash:ref('samples/wedding-invitation.prd.json').sha256,wireframeHash:wf.artifacts.find(a=>a.id==='wf-wizard').revisionHash,conceptHash:vc.artifacts.find(a=>a.id==='concept-shadcn').revisionHash,representativeScreenId:'w-guest',sectionOrder:guestSections.map(s=>s.id),basis:'The concept manifest explicitly names runs/wf-wedding-r3/wireframe-wizard.html and w-guest; inspected representative HTML blocks in this exact order. r5 has no manifest and is intentionally not used.'},
  approval:{kind:'user-authorized-scenario',authorization:'User instruction in this session: assume upstream flow/wireframe and visual concept are approved as explicitly authorized by the user.',assumption:'Use the committed r3 wizard + shadcn concept as the approved representative scenario. This is not a new historical human review record.'}
};
writeJSON(join(base,'wedding-input.json'),input);
console.log(relative(root,join(base,'wedding-input.json')));
