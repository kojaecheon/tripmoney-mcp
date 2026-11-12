export function createPhase2Api(call,{invalid,parseChange,parseTrip,parseDraft,parsePlaceReference,ledgerId}) {
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const integer=v=>Number.isSafeInteger(v)&&v>=1;
  function text(v,max=1000,empty=false) {
    if(typeof v!=='string'||[...v].length>max||(!empty&&!v.trim())||/\p{Cc}/u.test(v))invalid();
    return v;
  }
  function timestamp(v) {if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT/.test(v)||!Number.isFinite(Date.parse(v)))invalid();return v;}
  function token(v) {if(typeof v!=='string'||!/^[A-Za-z0-9_-]{16,256}$/.test(v))invalid();return v;}
  function day(v) {
    if(typeof v!=='string'||!/^\d{4}-\d\d-\d\d$/.test(v)||v.startsWith('0000'))invalid();
    const ms=Date.parse(v+'T00:00:00Z');if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==v)invalid();return v;
  }
  function schedule(v) {
    if(!object(v)||!Number.isSafeInteger(v.budgetKrw)||v.budgetKrw<0)invalid();
    const out={date:day(v.date),startTime:text(v.startTime,5,true),endTime:text(v.endTime,5,true),title:text(v.title,100),place:text(v.place,200,true),budgetKrw:v.budgetKrw};
    if((out.startTime||out.endTime)&&(!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.startTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.endTime)||out.endTime<out.startTime))invalid();
    if(Object.hasOwn(v,'placeRef'))out.placeRef=parsePlaceReference(v.placeRef);
    return out;
  }
  function expense(v) {
    if(!object(v)||!['KRW','THB'].includes(v.currency)||typeof v.refreshRate!=='boolean'||!Array.isArray(v.splitIds)||v.splitIds.length<1||v.splitIds.length>8)invalid();
    const occurredLocal=text(v.occurredLocal,16);day(occurredLocal.slice(0,10));
    if(!/^\d{4}-\d\d-\d\dT([01]\d|2[0-3]):[0-5]\d$/.test(occurredLocal))invalid();
    const amount=text(v.amount,30);if(!/^\d+(?:\.\d{1,2})?$/.test(amount)||Number(amount)<=0||Number(amount)>1000000||(v.currency==='KRW'&&!/^\d+$/.test(amount)))invalid();
    const splitIds=v.splitIds.map(ledgerId);if(new Set(splitIds).size!==splitIds.length)invalid();
    return {title:text(v.title,100),itineraryId:v.itineraryId===null?null:ledgerId(v.itineraryId),occurredLocal,currency:v.currency,amount,payerId:ledgerId(v.payerId),splitIds,refreshRate:v.refreshRate};
  }
  function recommendation(v,tripId,revision) {
    if(!object(v)||v.tripId!==tripId||v.baseRevision!==revision||!['synthetic','claude'].includes(v.source)||!Array.isArray(v.items)||v.items.length<1||v.items.length>60||!Array.isArray(v.warnings)||v.warnings.length>20)invalid();
    const items=v.items.map(row=>{
      if(!object(row)||!['synthetic','verified','unverified'].includes(row.placeStatus))invalid();
      return {id:ledgerId(row.id),input:schedule(row.input),reason:text(row.reason),placeStatus:row.placeStatus};
    });
    if(new Set(items.map(row=>row.id)).size!==items.length)invalid();
    return {id:ledgerId(v.id),tripId,baseRevision:revision,source:v.source,expiresAt:timestamp(v.expiresAt),items,warnings:v.warnings.map(row=>text(row))};
  }
  function status(v) {
    if(!object(v)||v.source!=='synthetic'||typeof v.linked!=='boolean'||!Array.isArray(v.trips)||v.trips.length>256)invalid();
    return {source:'synthetic',linked:v.linked,expiresAt:v.expiresAt===null?null:timestamp(v.expiresAt),tripId:v.tripId===null?null:ledgerId(v.tripId),trips:v.trips.map(parseTrip)};
  }
  function draft(v) {
    if(!object(v)||!integer(v.baseRevision))invalid();
    return {...parseDraft(v,ledgerId(v.tripId),v.baseRevision),id:ledgerId(v.id),expiresAt:timestamp(v.expiresAt)};
  }
  function confirmation(v) {
    if(!object(v)||!integer(v.baseRevision)||!['schedule','expense'].includes(v.kind))invalid();
    return {token:token(v.token),tripId:ledgerId(v.tripId),tripName:text(v.tripName,80),kind:v.kind,input:v.kind==='schedule'?schedule(v.input):expense(v.input),baseRevision:v.baseRevision,expiresAt:timestamp(v.expiresAt)};
  }
  const trip=id=>`trips/${encodeURIComponent(id)}`;
  const base='kakao-local';
  const change=v=>parseChange(v,row=>({targetId:row.targetId===null?null:ledgerId(row.targetId)}));
  return {
    generateRecommendation:(id,input,revision,account)=>call(`${trip(id)}/recommendations`,'POST',{interests:input.interests,pace:input.pace,expectedRevision:revision},b=>recommendation(b.recommendation,id,revision),account),
    adoptRecommendation:(id,draftId,selectedIds,operationId,account)=>call(`${trip(id)}/recommendations/${encodeURIComponent(draftId)}/adopt`,'POST',{selectedIds,operationId},change,account),
    kakaoStatus:account=>call(base,'GET',undefined,b=>status(b.status),account),
    issueKakaoPair:account=>call(base+'/pair','POST',{},b=>({code:token(b.pair?.code),expiresAt:timestamp(b.pair?.expiresAt)}),account),
    connectKakao:(code,account)=>call(base+'/connect','POST',{code},b=>status(b.status),account),
    unlinkKakao:account=>call(base+'/unlink','POST',{},b=>status(b.status),account),
    selectKakaoTrip:(tripId,account)=>call(base+'/trip','POST',{tripId},b=>status(b.status),account),
    prepareKakaoDraft:(message,account)=>call(base+'/drafts','POST',{message},b=>draft(b.draft),account),
    reviewKakaoDraft:(draftId,input,account)=>call(`${base}/drafts/${encodeURIComponent(draftId)}/review`,'POST',{input},b=>confirmation(b.confirmation),account),
    confirmKakao:(token,operationId,account)=>call(base+'/confirm','POST',{token,operationId},change,account),
    cancelKakaoDraft:(draftId,account)=>call(base+'/cancel','POST',{draftId},b=>status(b.status),account),
  };
}
