#!/usr/bin/env node
// Real Chromium execution. No screenshots or synthetic personas stand in for clicks.
import { chromium } from 'playwright';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';
import { inspectRun, bindBrowserEvidence } from './pipeline.mjs';
import { readJSON, writeJSON, digest, sha } from './lib/io.mjs';
import { serve } from './serve.mjs';
const assert = (condition,message) => {if(!condition)throw new Error(message);};

export async function checkBrowser(outDir) {
  const state=inspectRun(outDir),dir=join(outDir,state.revision),spec=readJSON(join(dir,'normalized-spec.json'));
  const evidence={version:1,kind:'real-browser-execution',specHash:state.specHash,sourceHash:digest(state.artifacts),startedAt:new Date().toISOString(),checks:[],journeys:[],screens:[],screenshots:[]};
  mkdirSync(join(dir,'evidence'),{recursive:true});
  const server=await serve(dir),base=`http://127.0.0.1:${server.address().port}/`;
  let browser;
  const check=async(id,fn)=>{try{const observed=await fn();evidence.checks.push({id,status:'pass',observed});}catch(e){evidence.checks.push({id,status:'fail',observed:e.message});}};
  try {
    browser=await chromium.launch({channel:process.env.PRODUCT_BROWSER_CHANNEL??'chrome',headless:true});
    evidence.browser=browser.version();
    const context=await browser.newContext({viewport:spec.viewports[0],permissions:['clipboard-read','clipboard-write']});
    const page=await context.newPage();page.setDefaultTimeout(5000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const screenMap=new Map(spec.screens.map(s=>[s.id,s]));
    const url=(s,state='default',embed=true)=>`${base}#${s.route}?state=${state}${embed?'&embed=1':''}`;
    const open=async(s,state='default',embed=true)=>{await page.goto(url(s,state,embed));await page.locator(`[data-screen-id="${s.id}"][data-state-id="${state}"]`).waitFor();};
    const fill=async(s)=>{for(const section of s.sections)for(const f of section.fields??[]){
      const locator=page.locator(`[name="${f.id}"]`);
      if(!await locator.count())continue;
      if(f.type==='select')await locator.selectOption(f.value||f.options[0]);
      else if(f.type==='file')continue;
      else await locator.fill(f.value||(f.type==='date'?'2026-10-24':f.type==='number'?String(f.min??1):'검증 사용자'));
    }};
    const click=async(a)=>page.locator(`[data-action-id="${a.id}"]`).click();
    await check('routes-states-viewports',async()=>{
      for(const viewport of spec.viewports){await page.setViewportSize({width:viewport.width,height:viewport.height});
        for(const s of spec.screens)for(const view of s.states){await open(s,view.id);
          const dimensions=await page.evaluate(()=>({width:innerWidth,height:innerHeight,screenId:document.querySelector('[data-screen-id]')?.dataset.screenId,state:document.querySelector('[data-state-id]')?.dataset.stateId,h1:document.querySelectorAll('h1').length}));
          assert(dimensions.width===viewport.width&&dimensions.height===viewport.height,`${s.id}: incorrect viewport`);
          assert(dimensions.h1===1,`${s.id}/${view.id}: expected one h1, got ${dimensions.h1}`);
          evidence.screens.push({screenId:s.id,state:view.id,viewport:viewport.id,...dimensions});
        }
      }
      return `${evidence.screens.length} exact screen/state/viewport combinations rendered`;
    });
    await page.setViewportSize({width:390,height:844});
    await check('task-completion',async()=>{
      for(const task of spec.tasks){await open(screenMap.get(task.screenIds[0]));
        for(let i=0;i<task.actionIds.length;i++){
          const from=screenMap.get(task.screenIds[i]),a=from.actions.find(a=>a.id===task.actionIds[i]);
          await fill(from);await click(a);
          await page.locator(`[data-screen-id="${a.to}"][data-state-id="${a.targetState??'default'}"]`).waitFor();
          evidence.journeys.push({taskId:task.id,actionId:a.id,from:from.id,to:a.to,state:a.targetState??'default',observedUrl:page.url()});
        }
      }
      return `${spec.tasks.length} end-to-end tasks completed through ${evidence.journeys.length} actual clicks`;
    });
    await check('form-recovery',async()=>{
      let count=0;
      for(const s of spec.screens){const submit=s.actions.find(a=>a.kind==='submit');
        const field=s.sections.flatMap(section=>section.fields??[]).find(f=>f.required&&['text','textarea'].includes(f.type));
        if(!submit||!field)continue;
        await open(s);await fill(s);await page.locator(`[name="${field.id}"]`).fill('');await click(submit);
        await page.locator(`[data-screen-id="${s.id}"][data-state-id="error"]`).waitFor();
        assert(await page.locator('[aria-invalid="true"]').count()>0,`${s.id}: invalid field not identified`);
        await fill(s);await click(submit);
        await page.locator(`[data-screen-id="${submit.to}"][data-state-id="${submit.targetState??'default'}"]`).waitFor();count++;
      }
      assert(count>0,'No validation/recovery journey exercised');
      const s=spec.screens.find(s=>s.actions.some(a=>a.kind==='submit'));
      await open(s,'default',false);await fill(s);
      await page.locator('[name="simulate-failure"]').check();
      const submit=s.actions.find(a=>a.kind==='submit');await click(submit);
      await page.locator(`[data-screen-id="${s.id}"][data-state-id="error"]`).waitFor();
      await page.locator('[name="simulate-failure"]').uncheck();await fill(s);await click(submit);
      await page.locator(`[data-screen-id="${submit.to}"][data-state-id="${submit.targetState??'default'}"]`).waitFor();
      return `${count} blank-input recovery journeys plus mock service failure/retry`;
    });
    await check('controls',async()=>{
      let count=0;
      for(const s of spec.screens)for(const a of s.actions){await open(s);await fill(s);
        const before=await page.locator('body').innerText();await click(a);
        if(['navigate','submit'].includes(a.kind))await page.locator(`[data-screen-id="${a.to}"][data-state-id="${a.targetState??'default'}"]`).waitFor();
        else {await page.waitForTimeout(100);assert(await page.locator('body').innerText()!==before,`${a.id}: no observable control response`);}
        count++;
      }
      assert(errors.length===0,errors.join('\n'));
      return `${count} declared controls clicked; zero browser exceptions`;
    });
    await check('product-behaviors',async()=>{
      const observations=[];
      for(const s of spec.screens){
        const number=s.sections.flatMap(section=>section.fields??[]).find(f=>f.type==='number'&&f.min!=null);
        const submit=s.actions.find(a=>a.kind==='submit');
        if(number&&submit){await open(s);await fill(s);await page.locator(`[name="${number.id}"]`).fill(String(number.min-1));await click(submit);await page.locator(`[data-state-id="error"]`).waitFor();assert(await page.locator(`[name="${number.id}"]`).getAttribute('aria-invalid')==='true','Numeric bound not validated');observations.push('numeric minimum');}
        if(s.states.some(st=>st.id==='empty')){await open(s,'empty');assert(await page.locator('.item-list').count()===0,'Empty state still lists results');await page.locator('#retry-empty').click();await page.locator('[data-state-id="default"]').waitFor();observations.push('empty state retry');}
        const file=s.sections.flatMap(section=>section.fields??[]).find(f=>f.type==='file');
        if(file){await open(s);await page.locator(`[name="${file.id}"]`).setInputFiles({name:'test-photo.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#555"/></svg>')});await page.locator('img.image-preview').waitFor();assert(await page.locator('img.image-preview').evaluate(img=>img.complete&&img.naturalWidth>0),'Uploaded image does not render');observations.push('local image upload');}
      }
      // State payloads must actually change content, not just the label.
      for(const s of spec.screens.filter(s=>s.states.some(st=>st.id==='success')&&s.sections.some(section=>section.fields?.length))){await open(s,'success');assert(await page.locator('[data-field]').count()===0,'Success still renders an unsubmitted form');assert(await page.locator('.summary-list').count()>0,'Missing submitted summary');observations.push('submitted summary');}
      const conditional=spec.screens.find(s=>s.sections.some(section=>section.fields?.some(f=>f.visibleWhen)));
      if(conditional){const field=conditional.sections.flatMap(s=>s.fields??[]).find(f=>f.visibleWhen);const controller=conditional.sections.flatMap(s=>s.fields??[]).find(f=>f.id===field.visibleWhen.field);await open(conditional);await fill(conditional);await page.locator(`[name="${controller.id}"]`).selectOption(controller.options.find(v=>v!==field.visibleWhen.equals));assert(await page.locator(`[name="${field.id}"]`).count()===0,'Conditional field remains required when hidden');observations.push('conditional form');}
      const s=spec.screens[0];await open(s,'default',false);
      await page.locator('#review-note').fill('Automated browser test note; not a human approval.');await page.locator('#review-decision').selectOption('changes-requested');await page.locator('#save-review').click();await page.reload();assert(await page.locator('#review-note').inputValue()==='Automated browser test note; not a human approval.','Review note not persisted');
      const downloadPromise=page.waitForEvent('download');await page.locator('#export-review').click();const download=await downloadPromise;const exported=JSON.parse(readFileSync(await download.path(),'utf8'));assert(exported.revision===readJSON(join(dir,'spec.json')).revision,'Review export bound to wrong revision');assert(exported.decisions.some(d=>d.decision==='changes-requested'),'Explicit review selection missing');observations.push('revision-bound local review export');
      return observations.join(', ');
    });
    await check('keyboard-focus',async()=>{
      const s=screenMap.get(spec.entryScreen);await open(s);await fill(s);
      const action=s.actions.find(a=>a.kind==='navigate'||a.kind==='submit');
      await page.locator(`[data-action-id="${action.id}"]`).focus();
      await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
      const style=await page.evaluate(()=>{const s=getComputedStyle(document.activeElement);return {outline:s.outlineStyle,width:s.outlineWidth,tag:document.activeElement.tagName};});
      assert(style.outline!=='none'&&style.width!=='0px','Focused control has no visible outline');
      await page.keyboard.press('Enter');await page.locator(`[data-screen-id="${action.to}"]`).waitFor();
      assert(await page.locator('h1').evaluate(el=>el===document.activeElement),'Route change does not focus heading');
      return 'Keyboard Tab/Shift+Tab, visible focus, Enter activation and route heading focus';
    });
    await check('font-overflow',async()=>{
      const results=[];
      for(const viewport of spec.viewports){await page.setViewportSize({width:viewport.width,height:viewport.height});for(const s of spec.screens)for(const st of s.states){await open(s,st.id);
        const result=await page.evaluate(async()=>{await document.fonts.ready;const root=document.querySelector('[data-screen-id]');return {fontStatus:document.fonts.status,font:getComputedStyle(root).fontFamily,overflow:document.documentElement.scrollWidth>innerWidth+1,clipped:[...root.querySelectorAll('p,h1,h2,label,button')].filter(e=>e.scrollWidth>e.clientWidth+2&&getComputedStyle(e).overflowX==='hidden').map(e=>e.textContent.slice(0,50)),unlabeled:[...root.querySelectorAll('input,select,textarea')].filter(e=>!e.labels?.length&&!e.getAttribute('aria-label')).map(e=>e.name)};});
        assert(!result.overflow,`${s.id}/${st.id}/${viewport.id}: horizontal overflow`);assert(!result.clipped.length,JSON.stringify(result.clipped));assert(!result.unlabeled.length,JSON.stringify(result.unlabeled));assert(result.fontStatus==='loaded','Fonts not loaded');
        results.push({screen:s.id,state:st.id,viewport:viewport.id,...result});
      }}
      evidence.layout=results;return `${results.length} combinations: loaded font fallback, no horizontal overflow, clipping or unlabeled fields`;
    });
    await check('board',async()=>{
      await page.evaluate(()=>localStorage.clear());
      await page.setViewportSize({width:1440,height:1000});await page.goto(base+'#/board');await page.reload();
      await page.locator('[data-board]').waitFor();
      const frames=page.locator('[data-board-frame]');
      const expected=spec.screens.reduce((n,s)=>n+s.states.length,0);
      assert(await frames.count()>=expected,`Board missing states: ${await frames.count()} / ${expected}`);
      await page.locator('[data-board-control="full"]').uncheck();
      await page.waitForFunction(()=>location.hash.includes('full=0')&&document.querySelector('iframe')?.dataset.autoHeight==='false');
      for(const viewport of spec.viewports){await page.locator('[data-board-control="viewport"]').selectOption(viewport.id);await page.waitForFunction(v=>[...document.querySelectorAll('iframe')].every(f=>Number(f.getAttribute('width'))===v.width&&Number(f.getAttribute('height'))===v.height),viewport);const dimensions=await page.locator('iframe').evaluateAll(frames=>frames.map(f=>({width:Number(f.getAttribute('width')),height:Number(f.getAttribute('height'))})));assert(dimensions.length===expected&&dimensions.every(d=>d.width===viewport.width&&d.height===viewport.height),'Board viewport frame mismatch');}
      await page.locator('[data-board-control="viewport"]').selectOption(spec.viewports[0].id);await page.locator('[data-board-control="full"]').check();
      await page.waitForTimeout(300);
      await page.screenshot({path:join(dir,'evidence/board.png')});
      const link=page.locator('[data-open-screen]').first();await link.click();await page.locator('[data-screen-id]').waitFor();
      return `${expected} required screen/state frames present; board opens interactive view`;
    });
    await check('portable-http',async()=>{
      const offline=await context.newPage();const failed=[];
      offline.on('request',r=>{if(!r.url().startsWith('file:')&&!r.url().startsWith('data:'))failed.push(r.url());});
      await offline.goto(pathToFileURL(join(dir,'index.html')).href+'#/board');
      await offline.locator('[data-board]').waitFor();assert(failed.length===0,'Portable HTML depends on network: '+failed.join(', '));
      await offline.close();return 'HTTP served successfully; file:// board opens with no network dependency';
    });
    await page.setViewportSize({width:390,height:844});
    const last=spec.screens.find(s=>s.states.some(st=>st.id==='success'))??spec.screens[0];
    await open(last,last.states.some(st=>st.id==='success')?'success':'default');await page.screenshot({path:join(dir,'evidence/completion.png'),fullPage:true});
    for(const path of ['evidence/board.png','evidence/completion.png']) {try{evidence.screenshots.push({path,sha256:sha(readFileSync(join(dir,path)))});}catch{}}
  } catch(e) {
    for(const id of ['routes-states-viewports','task-completion','form-recovery','controls','keyboard-focus','font-overflow','board','portable-http']) if(!evidence.checks.some(c=>c.id===id)) evidence.checks.push({id,status:'not-verified',observed:e.message});
  } finally {if(browser)await browser.close();server.close();}
  evidence.finishedAt=new Date().toISOString();
  const path=join(dir,'evidence/browser-result.json');writeJSON(path,evidence);
  return bindBrowserEvidence(outDir,path);
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {const result=await checkBrowser(resolve(process.argv[process.argv.indexOf('--out')+1]));console.log(JSON.stringify({status:result.status,revision:result.revision,checks:result.checks.filter(c=>c.axis==='browser')},null,2));if(result.status!=='ready-for-review')process.exitCode=2;}
  catch(e){console.error(e.message);process.exitCode=1;}
}
