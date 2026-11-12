export const settingFields = ['name','destination','startDate','endDate','timeZone','budgetKrw','settlementMode','dailyTime'];
export const tripFields = [...settingFields, 'alias'];
export function defaultTripDraft(now = new Date()) {
 const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now).map(p => [p.type,p.value]));
 const startDate = `${parts.year}-${parts.month}-${parts.day}`;
 const endDate = new Date(Date.parse(`${startDate}T00:00:00Z`) + 86400000).toISOString().slice(0,10);
 return { name:'', destination:'', startDate, endDate, timeZone:'Asia/Seoul', budgetKrw:0, alias:'', settlementMode:'end_of_trip', dailyTime:'20:00' };
}
export function settingsOf(trip) { return Object.fromEntries(settingFields.map(key => [key, trip[key]])); }
export function validateDraft(draft, alias = true) {
 for(const [key,max] of [['name',80],['destination',100],...(alias ? [['alias',40]] : [])]) if(typeof draft[key] !== 'string' || !draft[key].trim() || [...draft[key].trim()].length > max || /[\u0000-\u001f\u007f]/u.test(draft[key])) return { code:'validation',field:key,message:'입력 내용을 확인해 주세요.' };
 const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000-') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
 if(!day(draft.startDate)) return {code:'validation',field:'startDate',message:'출발일을 확인해 주세요.'};
 if(!day(draft.endDate) || draft.endDate < draft.startDate || Date.parse(draft.endDate)-Date.parse(draft.startDate)>13*86400000) return {code:'validation',field:'endDate',message:'여행 기간은 출발일을 포함해 최대 14일입니다.'};
 try { if(!draft.timeZone || /^[+-]/.test(draft.timeZone)) throw new Error(); new Intl.DateTimeFormat('ko',{timeZone:draft.timeZone}); } catch { return {code:'validation',field:'timeZone',message:'Asia/Seoul 같은 IANA 시간대를 입력해 주세요.'}; }
 if(!Number.isSafeInteger(draft.budgetKrw)||draft.budgetKrw<0) return {code:'validation',field:'budgetKrw',message:'예산은 0 이상의 정수로 입력해 주세요.'};
 if(!['daily','end_of_trip'].includes(draft.settlementMode)) return {code:'validation',field:'settlementMode',message:'정산 방식을 선택해 주세요.'};
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.dailyTime)) return {code:'validation',field:'dailyTime',message:'알림 시간을 확인해 주세요.'};
 return null;
}
export const roleLabel = role => ({owner:'소유자',editor:'편집자',viewer:'조회자'}[role] ?? '');
