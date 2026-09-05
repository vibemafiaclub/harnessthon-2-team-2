/* Shared screen renderer: the canvas embeds this exact product implementation. */
const spec=window.__PRODUCT_SPEC__;
const $=(s,root=document)=>root.querySelector(s);
const main=$('#main');
const storageKey=`prototype:${spec.id}:${spec.revision}`;
const defaults=Object.fromEntries(spec.screens.flatMap(s=>s.sections.flatMap(section=>(section.fields||[]).map(f=>[f.id,f.value??'']))));
function load(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}}
let values={...defaults,...load(storageKey,{})},reviews=load(storageKey+':reviews',{}),mockFailure=false,invalidFields=new Set(),feedback=null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text=v=>esc(String(v??'').replace(/{{([\w-]+)}}/g,(_,id)=>values[id]??''));
const screenById=id=>spec.screens.find(s=>s.id===id);
function save(){try{localStorage.setItem(storageKey,JSON.stringify(values));}catch{feedback={message:'이 브라우저에 저장할 수 없습니다. 현재 화면에서는 계속 사용할 수 있어요.'};}}
function route(screen,state='default',embed=false){return '#'+screen.route+'?state='+encodeURIComponent(typeof state==='object'?state.id:state)+(embed?'&embed=1':'');}
function current(){const [path,query='']=(location.hash||'#/board').slice(1).split('?');const params=new URLSearchParams(query);const screen=spec.screens.find(s=>s.route===path)||screenById(spec.entryScreen);const state=screen.states.find(s=>s.id===params.get('state'))||screen.states[0];return {path,params,screen,state};}
function navigate(screen,state='default'){const embed=current().params.get('embed')==='1',next=route(screen,state,embed);feedback=null;if(location.hash===next)render();else location.hash=next;}
const fieldsOf=s=>s.sections.flatMap(section=>section.fields||[]);
const fieldVisible=field=>!field.visibleWhen||values[field.visibleWhen.field]===field.visibleWhen.equals;
function isInvalid(field){if(!fieldVisible(field))return false;const value=values[field.id];return (field.required&&!String(value??'').trim())||(field.type==='number'&&value!==''&&(!Number.isFinite(Number(value))||(field.min!=null&&Number(value)<field.min)))||(field.type==='select'&&value&&!field.options.includes(value));}
function button(action){return `<button type="button" class="button ${action.variant||'primary'}" data-action-id="${esc(action.id)}">${esc(action.label)}</button>`;}
function fieldHtml(field,state){
  const invalid=state.id==='error'&&(invalidFields.size?invalidFields.has(field.id):field.required);
  const attrs=`id="${esc(field.id)}" name="${esc(field.id)}" data-field="${esc(field.id)}" ${field.required?'required':''} ${invalid?`aria-invalid="true" aria-describedby="${esc(field.id)}-error"`:''}`;
  const value=values[field.id]??'';let control;
  if(field.type==='textarea')control=`<textarea ${attrs}>${esc(value)}</textarea>`;
  else if(field.type==='select')control=`<select ${attrs}><option value="">선택해 주세요</option>${field.options.map(o=>`<option ${o===value?'selected':''}>${esc(o)}</option>`).join('')}</select>`;
  else control=`<input ${attrs} type="${esc(field.type)}" ${field.type==='file'?'accept="image/*"':`value="${esc(value)}"`} ${field.min!=null?`min="${field.min}"`:''}>`;
  return `<label class="field ${invalid?'invalid':''}" for="${esc(field.id)}"><span>${esc(field.label)} ${field.required?'<span class="required">*</span>':''}</span>${control}${invalid?`<span class="field-error" id="${esc(field.id)}-error">${field.type==='number'?`${field.min??0} 이상의 숫자를 입력해 주세요.`:'입력 내용을 확인해 주세요.'}</span>`:''}</label>`;
}
function imageHtml(section){const field=section.fields?.find(f=>f.type==='file');const image=values[(field?.id||'photo')+':data'];return image?`<img class="image-preview" src="${esc(image)}" alt="선택한 대표 사진">`:`<div class="image-art" role="img" aria-label="사진 추가 전 기본 일러스트"><svg viewBox="0 0 100 80" aria-hidden="true"><path d="M15 65V28L50 10l35 18v37zM25 65V36l25-14 25 14v29M40 65V42h20v23M8 66h84"/><path d="M49 16c-10-13-20 1 1 13 20-12 11-26-1-13"/></svg><small>사진을 추가하면 이곳에 표시됩니다</small></div>`;}
function sectionHtml(section,screen,state){
  const isSuccess=state.tone==='success'||state.id==='success',fields=(section.fields||[]).filter(fieldVisible);
  const items=section.items?.length?(state.id==='empty'?`<div class="empty-card"><strong>${esc(state.title)}</strong><p>${text(state.message||'아직 등록된 항목이 없습니다.')}</p></div>`:`<ul class="item-list">${section.items.map(i=>`<li><strong>${text(i.title)}</strong>${i.description?`<span>${text(i.description)}</span>`:''}</li>`).join('')}</ul>`):'';
  const form=state.id==='empty'?'':isSuccess&&fields.length?`<dl class="summary-list">${fields.map(f=>`<div><dt>${esc(f.label)}</dt><dd>${f.type==='file'?'사진 선택 완료':text(values[f.id]||f.value||'—')}</dd></div>`).join('')}</dl>`:fields.map(f=>fieldHtml(f,state)).join('');
  return `<section class="card" data-section-id="${esc(section.id)}">${section.title?`<h2>${text(section.title)}</h2>`:''}${section.body?`<p>${text(section.body)}</p>`:''}${section.image?imageHtml(section):''}${items}${form}${screen.actions.filter(a=>a.sectionId===section.id).map(a=>`<div class="section-actions">${button(a)}</div>`).join('')}</section>`;
}
function screenHtml(screen,state){
  return `<article class="screen" data-screen-id="${esc(screen.id)}" data-state-id="${esc(state.id)}"><p class="eyebrow">${text(screen.description)}</p><h1 tabindex="-1">${text(screen.title)}</h1>${state.id==='success'?'<div class="success-mark" aria-hidden="true">✓</div>':''}${state.message?`<div class="notice ${esc(state.tone||'info')}" role="${state.tone==='error'?'alert':'status'}">${text(state.message)}</div>`:''}<div class="screen-grid">${screen.sections.map(section=>sectionHtml(section,screen,state)).join('')}</div><div class="button-row">${screen.actions.filter(a=>!a.sectionId&&(state.id!=='success'||a.kind!=='submit')).map(button).join('')}</div>${feedback?`<div class="notice feedback" role="status">${esc(feedback.message)}${feedback.value?`<label>복사할 내용<input readonly value="${esc(feedback.value)}"></label>`:''}</div>`:''}</article>`;
}
function exportReview(){const payload={version:1,specId:spec.id,revision:spec.revision,exportedAt:new Date().toISOString(),decisions:Object.values(reviews),status:'human-recorded-notes',scope:'Local inspection only; no external submission'};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='prototype-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function reviewPanel(screen,state){const key=`${screen.id}:${state.id}`,record=reviews[key]||{};return `<aside class="review-panel"><h2>이 화면 최종 검수</h2><div class="review-fields"><label>검수 의견<textarea id="review-note" placeholder="수정할 내용이나 확인한 사항을 적어 주세요.">${esc(record.note||'')}</textarea></label><label>검수 결과<select id="review-decision"><option value="pending" ${!record.decision||record.decision==='pending'?'selected':''}>아직 검수하지 않음</option><option value="accepted" ${record.decision==='accepted'?'selected':''}>이 화면 확인 완료</option><option value="changes-requested" ${record.decision==='changes-requested'?'selected':''}>수정 요청</option></select></label></div><div class="button-row"><button class="button primary" id="save-review">검수 기록 저장</button><button class="button secondary" id="export-review">검수 JSON 내보내기</button></div><p id="review-status" role="status">${record.savedAt?'이 브라우저에 검수 기록이 저장되어 있습니다.':'자동으로 승인 처리되지 않습니다.'}</p></aside>`;}
function renderPrototype(){
  const {screen,state,params}=current(),embed=params.get('embed')==='1';
  main.innerHTML=`<div class="prototype-shell">${screenHtml(screen,state)}${embed?'':`<aside class="demo-tools"><label><input type="checkbox" name="simulate-failure" ${mockFailure?'checked':''}> 저장 실패 상황 테스트</label><p>이 프로토타입은 현재 브라우저의 모의 데이터로 동작합니다. 실제 발행·결제는 하지 않습니다.</p><button class="button secondary" id="reset-demo">데모 입력 초기화</button></aside>${reviewPanel(screen,state)}`}</div>`;
  main.querySelectorAll('[data-field]').forEach(input=>{
    input.addEventListener(input.type==='file'?'change':'input',async()=>{
      if(input.type==='file'){
        const file=input.files[0];if(!file)return;
        if(!file.type.startsWith('image/')||file.size>2_000_000){feedback={message:'2MB 이하 이미지 파일을 선택해 주세요.'};renderPrototype();return;}
        values[input.name]=file.name;values[input.name+':data']=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(file);});save();renderPrototype();
      }else{values[input.name]=input.value;save();}
    });
    if(spec.screens.some(s=>fieldsOf(s).some(f=>f.visibleWhen?.field===input.name)))input.addEventListener('change',renderPrototype);
  });
  main.querySelectorAll('[data-action-id]').forEach(node=>node.addEventListener('click',()=>act(screen,screen.actions.find(a=>a.id===node.dataset.actionId))));
  if(state.id==='empty'){$('.button-row').innerHTML='<button class="button primary" id="retry-empty">목록 다시 불러오기</button>';$('#retry-empty').onclick=()=>navigate(screen);}
  if(!embed){
    $('[name="simulate-failure"]').addEventListener('change',e=>{mockFailure=e.target.checked;});
    $('#reset-demo').onclick=()=>{values={...defaults};save();invalidFields.clear();feedback={message:'데모 입력을 초기화했습니다.'};renderPrototype();};
    $('#save-review').onclick=()=>{const key=`${screen.id}:${state.id}`;reviews[key]={screenId:screen.id,stateId:state.id,decision:$('#review-decision').value,note:$('#review-note').value,savedAt:new Date().toISOString()};try{localStorage.setItem(storageKey+':reviews',JSON.stringify(reviews));$('#review-status').textContent='현재 revision에 대한 검수 기록을 저장했습니다.';}catch{$('#review-status').textContent='저장 공간이 없습니다. JSON으로 내보내 주세요.';}};
    $('#export-review').onclick=exportReview;
  }
  if(parent===window)$('.screen h1')?.focus({preventScroll:true});
  requestAnimationFrame(reportHeight);
}
async function act(screen,action){
  if(action.kind==='copy'){
    const section=screen.sections.find(s=>s.id===action.sectionId);
    const content=action.copyText??(section?.body?String(section.body).replace(/{{([\w-]+)}}/g,(_,id)=>values[id]??''):location.href.split('#')[0]+route(screenById(action.to)));
    try{await navigator.clipboard.writeText(content);feedback={message:'복사했습니다.',value:content};}catch{feedback={message:'아래 내용을 선택해 직접 복사해 주세요.',value:content};}renderPrototype();return;
  }
  if(action.kind==='unavailable'){feedback={message:spec.capabilities.find(c=>c.id===action.capability)?.description||'이 기능은 연결되지 않았습니다.'};renderPrototype();return;}
  if(action.kind==='reset'){values={...defaults};save();feedback={message:'입력을 초기화했습니다.'};renderPrototype();return;}
  if(action.kind==='submit'){
    invalidFields=new Set(fieldsOf(screen).filter(isInvalid).map(f=>f.id));
    if(invalidFields.size||mockFailure){navigate(screen,'error');return;}
    save();
  }
  invalidFields.clear();navigate(screenById(action.to),action.targetState||'default');
}
function options(items,selected,allLabel){return `${allLabel?'<option value="all">'+allLabel+'</option>':''}${items.map(i=>`<option value="${esc(i.id)}" ${i.id===selected?'selected':''}>${esc(i.title||i.id)}</option>`).join('')}`;}
function renderBoard(){
  const {params}=current(),sf=params.get('screen')||'all',st=params.get('state')||'all',vf=params.get('viewport')||spec.viewports[0].id,full=params.get('full')!=='0',zoom=Math.max(.2,Math.min(1,Number(params.get('zoom')||.62)));
  const screens=spec.screens.filter(s=>sf==='all'||s.id===sf),viewports=spec.viewports.filter(v=>vf==='all'||v.id===vf),states=[...new Map(spec.screens.flatMap(s=>s.states).map(s=>[s.id,s])).values()];
  main.innerHTML=`<section class="board-head"><h1>전체 화면 검수</h1><p>${spec.screens.length}개 화면 · ${spec.screens.reduce((n,s)=>n+s.states.length,0)}개 상태. 화면 제목을 누르면 실제 동작을 확인하고 검수 의견을 남길 수 있습니다.</p><div class="controls"><label>화면<select data-board-control="screen">${options(spec.screens,sf,'모든 화면')}</select></label><label>상태<select data-board-control="state">${options(states,st,'모든 상태')}</select></label><label>화면 크기<select data-board-control="viewport">${options(spec.viewports,vf,'모든 크기')}</select></label><label>확대 · ${Math.round(zoom*100)}%<input aria-label="확대" type="range" min=".2" max="1" step=".02" value="${zoom}" data-board-control="zoom"></label><label class="check-label"><input type="checkbox" data-board-control="full" ${full?'checked':''}>긴 화면 펼치기</label><button class="button secondary" id="export-review">검수 기록 내보내기</button></div></section><section class="canvas" data-board><div class="canvas-inner" style="zoom:${zoom}">${viewports.flatMap(viewport=>screens.map(screen=>`<div class="frame-column">${screen.states.filter(s=>st==='all'||s.id===st).map(state=>`<article class="frame" data-board-frame style="width:${viewport.width}px"><a class="frame-label" data-open-screen href="${route(screen,state)}"><strong>${esc(screen.id)} · ${esc(state.id)}</strong><small>${esc(screen.title)} / ${esc(state.title)} · ${viewport.width} × ${full?'콘텐츠':viewport.height}</small></a><iframe title="${esc(screen.id+' / '+state.id+' / '+viewport.id)}" src="${route(screen,state,true)}&board=1&full=${full?'1':'0'}" width="${viewport.width}" height="${viewport.height}" data-auto-height="${full}" data-viewport-height="${viewport.height}"></iframe></article>`).join('')}</div>`)).join('')}</div></section>`;
  main.querySelectorAll('[data-board-control]').forEach(control=>control.addEventListener('change',()=>{const next=new URLSearchParams(params);next.set(control.dataset.boardControl,control.type==='checkbox'?(control.checked?'1':'0'):control.value);location.hash='#/board?'+next;}));
  $('#export-review').onclick=exportReview;
}
function reportHeight(){if(parent!==window)parent.postMessage({kind:'prototype-height',height:Math.ceil($('.screen')?.getBoundingClientRect().height||0)},location.origin==='null'?'*':location.origin);}
addEventListener('message',event=>{if(event.origin!==location.origin||event.data?.kind!=='prototype-height')return;const iframe=[...document.querySelectorAll('iframe')].find(frame=>frame.contentWindow===event.source);if(iframe?.dataset.autoHeight==='true'&&Number.isFinite(event.data.height)&&event.data.height>0)iframe.height=String(Math.min(30000,event.data.height));});
function render(){
  const {path,params}=current();document.body.className=`system-${spec.system} ${params.get('embed')==='1'?'embed':''} ${params.get('board')==='1'&&params.get('full')==='1'?'board-embed':''}`;
  const map={primary:'primary',onPrimary:'on-primary',bg:'bg',surface:'surface',text:'text',muted:'muted',border:'border',radius:'radius',fontFamily:'font',fontHeading:'font-heading'};
  for(const [key,name] of Object.entries(map))if(spec.tokens[key])document.documentElement.style.setProperty('--'+name,spec.tokens[key]);
  $('.brand').textContent=spec.title;$('.revision-label').textContent='REV '+String(spec.revision).slice(0,10);$('#prototype-nav').href=route(screenById(spec.entryScreen));document.title=spec.title+' · 제품 검수';
  if(path==='/board')renderBoard();else renderPrototype();
}
addEventListener('hashchange',render);addEventListener('resize',reportHeight);render();
