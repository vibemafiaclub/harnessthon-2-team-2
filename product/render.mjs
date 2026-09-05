import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const template = name => readFileSync(new URL(`./template/${name}`,import.meta.url),'utf8');
export function generateProduct(spec,outDir) {
  if(!spec.screens?.length || !spec.viewports?.length) throw new Error('Screens and viewports are required');
  mkdirSync(outDir,{recursive:true});
  const app=template('app.js'),css=template('style.css');
  const data=JSON.stringify(spec).replace(/</g,'\\u003c');
  const html=`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Product prototype</title><style>${css}</style></head>
<body><a class="skip" href="#main">본문으로 건너뛰기</a><header class="inspection-header"><a class="brand" href="#/board"></a><nav aria-label="검수 탐색"><a href="#/board">전체 화면</a><a id="prototype-nav">프로토타입</a></nav><span class="revision-label"></span></header><main id="main" tabindex="-1"></main><script>window.__PRODUCT_SPEC__=${data};</script><script>${app.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
  for(const [name,content] of Object.entries({'index.html':html,'app.js':app,'style.css':css,'spec.json':JSON.stringify(spec,null,2)+'\n'}))writeFileSync(join(outDir,name),content);
  return {outDir,files:['index.html','app.js','style.css','spec.json'],status:'awaiting-human-inspection'};
}
