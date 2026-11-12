import {createRecommendationController} from './controller.mjs';
export function mountRecommendation(root,options) {
 const c=createRecommendationController(options),removers=[];let renderedDraft=null,cards=[];
 root.innerHTML=`<section class="recommendation-panel notice-panel" aria-labelledby="recommendation-heading">
 <h3 id="recommendation-heading">여행 일정 추천</h3>
 <p class="help" id="recommendation-help">추천 후보의 장소와 비용을 확인한 뒤 저장할 일정을 선택해 주세요.</p>
 <form id="recommendation-form"><div class="field"><label for="recommendation-interests">관심사</label><input id="recommendation-interests" type="text" maxlength="204" placeholder="산책, 미술, 음식" aria-describedby="recommendation-preferences"><p class="help" id="recommendation-preferences">쉼표로 나누어 최대 5개, 각 40자까지 입력해 주세요.</p></div>
 <div class="field"><label for="recommendation-pace">여행 속도</label><select id="recommendation-pace"><option value="relaxed">여유롭게</option><option value="balanced">적당하게</option><option value="packed">알차게</option></select></div>
 <button type="submit" id="recommendation-generate" class="secondary">추천 생성</button></form>
 <p id="recommendation-role" class="help" hidden>편집 권한이 있어야 추천을 만들고 저장할 수 있습니다.</p>
 <p id="recommendation-status" class="status" role="status" aria-live="polite" hidden></p><p id="recommendation-error" class="error" role="alert" hidden></p>
 <section id="recommendation-result" hidden><h4 id="recommendation-source">추천 후보</h4><p id="recommendation-warnings" class="help"></p><p id="recommendation-expiry" class="help"></p><div id="recommendation-items" class="recommendation-items"></div>
 <p id="recommendation-selection" class="help"></p><button type="button" id="recommendation-save">선택한 후보 저장</button></section></section>`;
 const refs=Object.fromEntries([...root.querySelectorAll('[id]')].map(node=>[node.id,node]));
 function on(node,event,fn){node.addEventListener(event,fn);removers.push(()=>node.removeEventListener(event,fn));}
 on(refs['recommendation-interests'],'input',()=>c.setInterests(refs['recommendation-interests'].value));on(refs['recommendation-pace'],'change',()=>c.setPace(refs['recommendation-pace'].value));
 on(refs['recommendation-form'],'submit',async event=>{event.preventDefault();await c.generate();});on(refs['recommendation-save'],'click',async()=>{await c.save();});
 const unsubscribe=c.subscribe(state=>{
  const busy=state.busy||state.saving;
  refs['recommendation-interests'].value=state.interests;refs['recommendation-pace'].value=state.pace;
  refs['recommendation-interests'].disabled=!state.canEdit||busy||state.selectionLocked;refs['recommendation-pace'].disabled=!state.canEdit||busy||state.selectionLocked;
  refs['recommendation-generate'].disabled=!state.canEdit||busy||state.selectionLocked;refs['recommendation-generate'].textContent=state.busy?'생성 중':state.stale?'추천 다시 생성':'추천 생성';refs['recommendation-role'].hidden=state.canEdit;
  refs['recommendation-form'].setAttribute('aria-busy',String(busy));refs['recommendation-status'].textContent=state.busy?'추천 후보를 만들고 있습니다.':state.saving?'선택한 후보를 저장하고 있습니다.':state.status;
  refs['recommendation-status'].hidden=!busy&&!state.status;refs['recommendation-error'].textContent=state.error;refs['recommendation-error'].hidden=!state.error;
  refs['recommendation-result'].hidden=!state.draft;refs['recommendation-warnings'].textContent=state.draft?.warnings.join(' ')??'';
  refs['recommendation-source'].textContent=state.draft?.source==='gemini'?'Gemini 추천 후보':'추천 후보';
  refs['recommendation-expiry'].textContent=state.draft?(state.selectionLocked?'기존 저장 요청의 결과를 먼저 확인해 주세요.':state.stale?'장부가 갱신되었습니다. 다시 생성해 주세요.':`추천 유효 시간: ${new Date(state.draft.expiresAt).toLocaleTimeString('ko-KR')}`):'';
  const doc=root.ownerDocument;if(renderedDraft!==state.draft){renderedDraft=state.draft;cards=(state.draft?.items??[]).map(item=>{
   const card=doc.createElement('label');card.className='recommendation-card';const checkbox=doc.createElement('input');checkbox.type='checkbox';checkbox.checked=state.selectedIds.includes(item.id);checkbox.disabled=!state.canEdit||busy||state.stale||state.selectionLocked;checkbox.setAttribute('aria-label',`${item.input.date} ${item.input.title} 선택`);checkbox.addEventListener('change',()=>c.toggle(item.id,checkbox.checked));
   const title=doc.createElement('strong');title.textContent=item.input.title;const details=doc.createElement('p');details.textContent=`${item.input.date} ${item.input.startTime||'시간 미정'}${item.input.endTime?' ~ '+item.input.endTime:''} · 예상 예산 ${item.input.budgetKrw.toLocaleString('ko-KR')}원`;
   const place=doc.createElement('p');place.textContent=`장소: ${item.input.place||'미지정'} · ${{synthetic:'합성 장소',verified:'장소 확인',unverified:'장소 미확인'}[item.placeStatus]??'장소 미확인'}`;const reason=doc.createElement('p');reason.textContent=`추천 이유: ${item.reason}`;card.append(checkbox,title,details,place,reason);return card;
  });refs['recommendation-items'].replaceChildren(...cards);}
  cards.forEach((card,index)=>{const checkbox=card.children[0],item=state.draft.items[index];checkbox.checked=state.selectedIds.includes(item.id);checkbox.disabled=!state.canEdit||busy||state.stale||state.selectionLocked;});refs['recommendation-selection'].textContent=`${state.selectedIds.length}개 선택. 선택한 후보만 새 일정으로 저장합니다.`;
  refs['recommendation-save'].disabled=!state.canEdit||busy||(state.stale&&!state.selectionLocked)||!state.selectedIds.length;refs['recommendation-save'].textContent=state.saving?'저장 중':state.selectionLocked?'저장 결과 확인':'선택한 후보 저장';
 });
 return {updateContext:context=>c.updateContext(context),destroy(){unsubscribe();c.destroy();for(const remove of removers)remove();root.replaceChildren();}};
}
