import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi } from '../../web/api.mjs';
import type { IdentityApi } from '../../web/api.mjs';
import { createTravelController, readInviteFragment, defaultTripDraft } from '../../web/travel/controller.mjs';
const trip = { id: 'trip-1', name: '서울 여행', destination: '서울', startDate: '2026-11-02', endDate: '2026-11-03', timeZone: 'Asia/Seoul', budgetKrw: 0, settlementMode: 'end_of_trip' as const, dailyTime: '20:00', revision: 1, status: 'active' as const, createdAt: '2026-11-02T00:00:00Z', ownerMemberId: 'member-1', role: 'owner' as const, memberCount: 1 };
const member = { id: 'member-1', tripId: trip.id, alias: '여행자', role: 'owner' as const, active: true, isMe: true };
const change = <T>(value: T, replayed = false) => ({ value, tripRevision: 1, replayed });
function fake(overrides: Partial<IdentityApi> = {}): IdentityApi { return { me: async () => ({ me: { userId:'a',email:'a@example.invalid',expiresAt:'2026-11-09T00:00:00Z' } }), listTrips: async () => [trip], getTrip: async () => trip, createTrip: async () => change({ trip, ownerMember: member }), updateTrip: async () => change(trip), listMembers: async () => [member], manageMember: async () => change(member), issueInvite: async () => { throw new ApiError(503, 'unavailable'); }, listInvites: async () => [], getInviteLink: async () => { throw new ApiError(503, 'unavailable'); }, revokeInvite: async () => { throw new ApiError(503, 'unavailable'); }, inspectInvite: async () => ({ state: 'pending', tripName: trip.name, role: 'viewer', expiresAt: '2026-11-09T00:00:00Z' }), acceptInvite: async () => change({ trip, member }), ...overrides }; }
function ready(overrides: Partial<IdentityApi> = {}) { let id = 0; return createTravelController(fake(overrides), { makeOperationId: () => `operation-${++id}` }); }
function draft(c: ReturnType<typeof ready>) { c.setCreateField('name', '보존할 여행'); c.setCreateField('destination', '서울'); c.setCreateField('alias', '나'); }
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
test('API uses service names, guarded PATCH/DELETE, empty link POST and safe DTO', async () => {
 const calls: [string, RequestInit][] = []; const invite = { id: 'i', role: 'viewer', status: 'pending', expiresAt: '2026-11-09T00:00:00Z' }; const replies = [{ trips: [{ ...trip, ownerUserId: 'private' }] }, change(trip), change(invite), { invite, url: 'http://127.0.0.1:8125/invite#t=sample' }];
 const api = createApi(async (url, init) => { calls.push([url, init]); return response(replies.shift()); });
 assert.equal('ownerUserId' in (await api.listTrips())[0]!, false); await api.updateTrip(trip.id, trip, 1, 'op','a'); await api.revokeInvite(trip.id, 'i', 1, 'op2','a'); await api.getInviteLink(trip.id, 'i','a'); assert.deepEqual(calls.map(([,i]) => i.method), ['GET','PATCH','DELETE','POST']); assert.equal(calls[3]![1].body, '{}'); for (const [,i] of calls.slice(1)) { const headers=i.headers as Record<string,string>; assert.equal(headers['X-TripMoney-Request'],'1'); assert.equal(headers['X-TripMoney-Expected-Account'],'a'); }
});
test('409/410 and travel field errors are safe', async () => { for (const [status, code] of [[409,'conflict'],[410,'invite_unavailable'],[422,'validation']] as const) { const api = createApi(async () => response({ error: { code, field:'alias', message:'private' }, requestId:'r' }, status)); await assert.rejects(api.inspectInvite('sample'), (e: unknown) => e instanceof ApiError && e.code === code && !e.message.includes('private') && (status !== 422 || e.field === 'alias')); } });
test('Seoul defaults use Korean date across month boundary', () => { const d = defaultTripDraft(new Date('2026-10-31T16:00:00Z')); assert.equal(d.startDate,'2026-11-01'); assert.equal(d.endDate,'2026-11-02'); });
test('network retry preserves original payload/operation and replay reloads latest GET', async () => { const calls: unknown[]=[]; let fail=true; const c=ready({ createTrip:async (input,op) => { calls.push([input,op]); if(fail) throw new ApiError(0,'network'); return change({trip,ownerMember:member},true); }, getTrip:async()=>({...trip,revision:9}) }); await c.setAccount('a'); draft(c); await c.saveTrip(); assert.equal(c.state.createDraft.name,'보존할 여행'); c.setCreateField('name','편집한 여행'); fail=false; await c.retryPending(); assert.deepEqual(calls[0],calls[1]); assert.equal(c.state.trip?.revision,9); c.destroy(); });
test('409 retains draft, latest check does not write, explicit reapply uses new operation', async () => { let calls=0; const ops:string[]=[]; const revs:number[]=[]; const c=ready({getTrip:async()=>({...trip,revision:7}),updateTrip:async(_id,_input,rev,op)=>{calls++;ops.push(op);revs.push(rev);if(calls===1)throw new ApiError(409,'conflict');return change(trip);}}); await c.setAccount('a');await c.selectTrip(trip.id);c.setSettingsField('name','새 여행명');await c.saveSettings();assert.equal(c.state.error?.code,'conflict');await c.refreshConflict();assert.equal(calls,1);assert.equal(c.state.settingsDraft.name,'새 여행명');await c.reapply();assert.equal(calls,2);assert.notEqual(ops[0],ops[1]);assert.deepEqual(revs,[7,7]);c.destroy(); });
test('401 clears private state, same-account draft restores, late responses are blocked', async()=>{let expired=0;const c=createTravelController(fake({getTrip:async()=>{throw new ApiError(401,'unauthenticated');}}),{onUnauthorized:()=>{expired++;}});await c.setAccount('a');draft(c);await c.selectTrip(trip.id);assert.equal(c.state.accountId,null);assert.deepEqual(c.state.trips,[]);assert.equal(c.state.createDraft.name,'');assert.equal(expired,1);await c.setAccount('a');assert.equal(c.state.createDraft.name,'보존할 여행');await c.setAccount(null);await c.setAccount('b');assert.equal(c.state.createDraft.name,'');c.destroy();let resolve!:(v:typeof trip[])=>void;const late=ready({listTrips:()=>new Promise(r=>{resolve=r;})});const pending=late.setAccount('a');await late.setAccount(null);resolve([trip]);await pending;assert.deepEqual(late.state.trips,[]);late.destroy();});
test('owner flag follows role; 403 stops writes and 404 clears inaccessible trip',async()=>{let role:'owner'|'viewer'='owner';let calls=0;const c=ready({getTrip:async()=>({...trip,role}),updateTrip:async()=>{calls++;throw new ApiError(403,'forbidden');}});await c.setAccount('a');await c.selectTrip(trip.id);assert.equal(c.state.canManage,true);role='viewer';await c.saveSettings();assert.equal(c.state.canManage,false);await c.saveSettings();assert.equal(calls,1);c.destroy();const lost=ready({getTrip:async()=>{throw new ApiError(404,'not_found');}});await lost.setAccount('a');await lost.selectTrip(trip.id);assert.equal(lost.state.trip,null);assert.equal(lost.state.selectedTripId,null);lost.destroy();});
test('invite token remains closure-only and initial anonymous bootstrap preserves it',async()=>{let inspections=0;const c=ready({inspectInvite:async()=>{inspections++;return {state:'pending',tripName:trip.name,role:'viewer',expiresAt:'2026-11-09T00:00:00Z'};}});c.setInviteToken('sensitive-test-value');await c.setAccount(null);assert.equal(inspections,0);assert.ok(!JSON.stringify(c.state).includes('sensitive-test-value'));await c.setAccount('a');assert.equal(c.state.invite?.state,'pending');c.setAlias('동행자');await c.acceptInvite();assert.equal(c.state.trip?.id,trip.id);assert.equal(c.state.alias,'');await c.setAccount(null);await c.setAccount('b');assert.equal(inspections,1);c.destroy();});
test('joined opens detail; alias/503 failure keeps alias and does not report success',async()=>{const joined=ready({inspectInvite:async()=>({state:'joined',tripId:trip.id})});joined.setInviteToken('sample');await joined.setAccount('a');assert.equal(joined.state.trip?.id,trip.id);joined.destroy();let status=422;const c=ready({acceptInvite:async()=>{throw new ApiError(status,status===422?'validation':'unavailable','alias');}});c.setInviteToken('sample');await c.setAccount('a');c.setAlias('나');await c.acceptInvite();assert.equal(c.state.alias,'나');assert.equal(c.state.error?.field,'alias');status=503;c.discardPending();await c.acceptInvite();assert.equal(c.state.alias,'나');assert.equal(c.state.error?.code,'unavailable');assert.equal(c.state.trip,null);c.destroy();});
test('fragment is removed immediately',()=>{const calls:unknown[]=[];assert.equal(readInviteFragment({hash:'#t=sample',pathname:'/invite',search:''},{replaceState:(...args:unknown[])=>calls.push(args)}),'sample');assert.deepEqual(calls[0],[null,'','/invite']);});
test('owner links validate origin and stay out of subscriptions, copy awaits success and fallback is manual', async()=>{
 const invite={id:'i',role:'viewer' as const,status:'pending' as const,expiresAt:'2026-11-09T00:00:00Z'};const url='http://127.0.0.1:8125/invite#t=sensitive-share-value';let external=false;
 const c=ready({issueInvite:async()=>change({invite,url:external?'https://outside.invalid/invite#t=sample':url}),getInviteLink:async()=>({invite,url})});const seen:string[]=[];c.subscribe(s=>seen.push(JSON.stringify(s)));await c.setAccount('a');await c.selectTrip(trip.id);await c.issueInvite();assert.equal(c.state.shareOpen,true);assert.ok(seen.every(s=>!s.includes('sensitive-share-value')));const textarea={value:''};c.fillShare(textarea);assert.equal(textarea.value,url);
 let resolve!:()=>void;const pending=c.copyLink({writeText:()=>new Promise<void>(r=>{resolve=r;})});assert.ok(!c.state.shareStatus.includes('복사했습니다'));resolve();await pending;assert.ok(c.state.shareStatus.includes('복사했습니다'));await c.copyLink({writeText:async()=>{throw new Error('private');}});assert.ok(c.state.shareStatus.includes('직접'));c.closeShare();c.fillShare(textarea);assert.equal(textarea.value,'');external=true;await c.issueInvite();assert.equal(c.state.shareOpen,false);assert.equal(c.state.error?.code,'invalid_response');c.destroy();
});
test('duplicate submit sends once; auth loss clears token and destroy blocks notifications',async()=>{
 let resolve!:(v:ReturnType<typeof change<{trip:typeof trip;ownerMember:typeof member}>>)=>void;let calls=0;let dispatch!:()=>void;const sent=new Promise<void>(r=>{dispatch=r;});const c=ready({createTrip:()=>{calls++;dispatch();return new Promise(r=>{resolve=r;});}});await c.setAccount('a');draft(c);const pending=c.saveTrip();await c.saveTrip();await sent;assert.equal(calls,1);await c.setAccount(null);resolve(change({trip,ownerMember:member}));await pending;assert.equal(c.state.trip,null);let n=0;c.subscribe(()=>n++);c.destroy();const old=n;c.setAlias('ignored');assert.equal(n,old);
});
test('conflict latest check blocks reapply after authority loss and joined accept resolves without a second write',async()=>{
 let role:'owner'|'viewer'='owner';let writes=0;const c=ready({getTrip:async()=>({...trip,role}),updateTrip:async()=>{writes++;throw new ApiError(409,'conflict');}});await c.setAccount('a');await c.selectTrip(trip.id);await c.saveSettings();role='viewer';await c.refreshConflict();assert.equal(await c.reapply(),false);assert.equal(writes,1);c.destroy();
 let joined=false;let accepts=0;const a=ready({inspectInvite:async()=>joined?{state:'joined',tripId:trip.id}:{state:'pending',tripName:trip.name,role:'viewer',expiresAt:'2026-11-09T00:00:00Z'},acceptInvite:async()=>{accepts++;throw new ApiError(409,'conflict');}});a.setInviteToken('sample');await a.setAccount('a');a.setAlias('동행');await a.acceptInvite();joined=true;await a.refreshConflict();assert.equal(a.state.conflict,null);assert.equal(a.state.pendingKind,null);assert.equal(a.state.trip?.id,trip.id);assert.equal(accepts,1);a.destroy();
});
test('revoking an invite clears the open share property', async()=>{
 const invite={id:'i',role:'viewer' as const,status:'pending' as const,expiresAt:'2026-11-09T00:00:00Z'};
 const c=ready({issueInvite:async()=>change({invite,url:'http://127.0.0.1:8125/invite#t=sample'}),revokeInvite:async()=>change({...invite,status:'revoked'})});await c.setAccount('a');await c.selectTrip(trip.id);await c.issueInvite();const textarea={value:''};c.fillShare(textarea);assert.ok(textarea.value);await c.revokeInvite(invite.id);c.fillShare(textarea);assert.equal(textarea.value,'');assert.equal(c.state.shareOpen,false);c.destroy();
});

test('403 recovery followed by 404 clears inaccessible detail and refreshes the list once', async () => {
 let removed = false;
 let listCalls = 0;
 let detailCalls = 0;
 const invite = { id: 'i', role: 'viewer' as const, status: 'pending' as const, expiresAt: '2026-11-09T00:00:00Z' };
 const c = ready({
  listTrips: async () => { listCalls++; return removed ? [] : [trip]; },
  getTrip: async () => { detailCalls++; if (removed) throw new ApiError(404, 'not_found'); return trip; },
  listInvites: async () => [invite],
  updateTrip: async () => { removed = true; throw new ApiError(403, 'forbidden'); },
 });
 await c.setAccount('a');
 await c.selectTrip(trip.id);
 draft(c);
 c.setSettingsField('name', '접근 상실 전 설정 초안');
 assert.ok(c.state.members.length);
 assert.ok(c.state.invites.length);
 await c.saveSettings();
 assert.equal(c.state.selectedTripId, null);
 assert.equal(c.state.trip, null);
 assert.deepEqual(c.state.members, []);
 assert.deepEqual(c.state.invites, []);
 assert.deepEqual(c.state.settingsDraft, {});
 assert.deepEqual(c.state.trips, []);
 assert.equal(c.state.createDraft.name, '보존할 여행');
 assert.equal(c.state.error?.code, 'not_found');
 assert.equal(c.state.canManage, false);
 assert.equal(c.state.pendingKind, null);
 assert.equal(detailCalls, 2);
 assert.equal(listCalls, 2);
 c.destroy();
});

test('404 recovery followed by 401 clears identity and invite, restoring draft only to its account', async () => {
 let expired = false;
 let unauthorized = 0;
 let listCalls = 0;
 let inspections = 0;
 const c = createTravelController(fake({
  listTrips: async () => { listCalls++; if (expired) throw new ApiError(401, 'unauthenticated'); return [trip]; },
  inspectInvite: async () => { inspections++; return { state: 'pending', tripName: trip.name, role: 'viewer', expiresAt: '2026-11-09T00:00:00Z' }; },
  updateTrip: async () => { expired = true; throw new ApiError(404, 'not_found'); },
 }), { onUnauthorized: () => { unauthorized++; }, makeOperationId: () => 'operation-recovery' });
 c.setInviteToken('sensitive-recovery-token');
 await c.setAccount('a');
 await c.selectTrip(trip.id);
 draft(c);
 await c.saveSettings();
 assert.equal(c.state.accountId, null);
 assert.equal(c.state.trip, null);
 assert.equal(c.state.selectedTripId, null);
 assert.deepEqual(c.state.trips, []);
 assert.deepEqual(c.state.members, []);
 assert.deepEqual(c.state.invites, []);
 assert.equal(c.state.invite, null);
 assert.equal(c.state.createDraft.name, '');
 assert.equal(c.state.pendingKind, null);
 assert.equal(unauthorized, 1);
 assert.equal(listCalls, 2);
 expired = false;
 await c.setAccount('a');
 assert.equal(c.state.createDraft.name, '보존할 여행');
 assert.equal(inspections, 1);
 await c.setAccount(null);
 await c.setAccount('b');
 assert.equal(c.state.createDraft.name, '');
 assert.equal(c.state.invite, null);
 assert.equal(inspections, 1);
 c.destroy();
});

const pendingInvite = (tripName: string) => ({ state: 'pending' as const, tripName, role: 'viewer' as const, expiresAt: '2026-11-09T00:00:00Z' });
test('same-document replacement strips fragment, ignores skip navigation and isolates old inspections and accepts', async () => {
 let resolveOld!: (v: ReturnType<typeof pendingInvite>) => void;
 const c = ready({inspectInvite: async value => value === 'first' ? new Promise(r => {resolveOld = r;}) : pendingInvite('새 여행')});
 c.setInviteToken('first');
 const old = c.setAccount('a');
 await new Promise(r => setImmediate(r));
 let cleaned = false;
 const next = readInviteFragment({hash:'#t=second',pathname:'/invite',search:''},{replaceState:(_a,_b,url) => {cleaned = url === '/invite';}});
 assert.ok(cleaned);
 await c.setInviteToken(next);
 resolveOld(pendingInvite('이전 여행')); await old;
 assert.deepEqual(c.state.invite, pendingInvite('새 여행'));
 readInviteFragment({hash:'#main',pathname:'/invite',search:''},{replaceState:() => assert.fail('skip link must remain')});
 c.destroy();
 let finish!: () => void; let writes = 0;
 const d = ready({ inspectInvite:async value => pendingInvite(value === 'first'?'이전 여행':'새 여행'),
  acceptInvite:async () => { writes++; await new Promise<void>(r => {finish = r;}); throw new ApiError(0,'network'); } });
 d.setInviteToken('first'); await d.setAccount('a'); d.setAlias('이전 별칭');
 const accepting = d.acceptInvite(); await new Promise(r => setImmediate(r));
 await d.setInviteToken('second'); finish(); await accepting;
 assert.deepEqual(d.state.invite,pendingInvite('새 여행')); assert.equal(d.state.alias,'');
 assert.equal(d.state.conflict,null); assert.equal(d.state.pendingKind,null); assert.equal(await d.retryPending(),false); assert.equal(writes,1);
 d.destroy();
});

test('normal refresh preserves the edited base revision, refreshes clean inputs and discards edits when read-only', async () => {
 let current: import('../../server/identity/contracts.js').TripDTO = trip; const seen: number[]=[];
 const c = ready({getTrip: async () => current, updateTrip: async (_id,_input,rev) => { seen.push(rev); if(rev!==current.revision) throw new ApiError(409,'conflict'); return change(current); }});
 await c.setAccount('a'); await c.selectTrip(trip.id);
 current = {...current,destination:'부산',revision:2}; await c.refresh(); assert.equal(c.state.settingsDraft.destination,'부산');
 c.setSettingsField('name','변경 초안'); current = {...current,destination:'제주',revision:3}; await c.refresh(); await c.saveSettings();
 assert.deepEqual(seen,[2]); assert.equal(c.state.conflict?.latestChecked,false); assert.equal(c.state.settingsDraft.name,'변경 초안');
 await c.refreshConflict(); assert.deepEqual(seen,[2]); current={...current,role:'viewer',destination:'울산'}; await c.refresh();
 assert.equal(c.state.settingsDraft.destination,'울산'); assert.equal(c.state.settingsDraft.name,trip.name); c.destroy();
});

test('only dedicated retry can repeat a pending member removal or invite revocation', async () => {
 const other = (id:string) => ({ ...member, id, role:'viewer' as const, isMe:false });
 const calls: unknown[][]=[];
 const c=ready({listMembers:async()=>[member,other('b'),other('c')],manageMember:async(...args)=>{calls.push(args);throw new ApiError(0,'network');},revokeInvite:async(...args)=>{calls.push(args);throw new ApiError(0,'network');}});
 await c.setAccount('a'); await c.selectTrip(trip.id); c.confirmRemove('b'); await c.removeMember('b');
 await c.manageMember('c','editor'); assert.equal(calls.length,1); await c.retryPending(); assert.deepEqual(calls[1],calls[0]);
 c.discardPending(); await c.revokeInvite('one'); await c.revokeInvite('two'); assert.equal(calls.length,3); await c.retryPending(); assert.deepEqual(calls[3],calls[2]); c.destroy();
});

test('stale displayed account discards all personal state before mutation and never restores its draft',async()=>{
 let signedIn='a'; let writes=0; let notices=0;
 const c=createTravelController(fake({me: async()=>({me:{userId:signedIn,email:'safe@example.invalid',expiresAt:'2026-11-09T00:00:00Z'}}),createTrip:async()=>{writes++;return change({trip,ownerMember:member});}}),{onUnauthorized:()=>{notices++;}});
 c.setInviteToken('test');await c.setAccount('a');await c.selectTrip(trip.id);draft(c);signedIn='b';
 assert.equal(await c.saveTrip(),false);assert.equal(writes,0);assert.equal(notices,1);assert.equal(c.state.accountId,null);assert.equal(c.state.invite,null);assert.deepEqual(c.state.trips,[]);assert.equal(c.state.pendingKind,null);
 signedIn='a';await c.setAccount('a');assert.equal(c.state.createDraft.name,'');c.destroy();
});

test('an in-flight preflight cannot submit after a tab account check invalidates its generation',async()=>{
 let release!:()=>void;let first=true;let writes=0;const me=(userId:string)=>({me:{userId,email:'safe@example.invalid',expiresAt:'2026-11-09T00:00:00Z'}});
 const c=ready({me:async()=>{if(first){first=false;await new Promise<void>(r=>{release=r;});return me('a');}return me('b');},createTrip:async()=>{writes++;return change({trip,ownerMember:member});}});
 await c.setAccount('a');draft(c);const saving=c.saveTrip();await new Promise(r=>setImmediate(r));await c.recheckAccount();release();await saving;
 assert.equal(writes,0);assert.equal(c.state.accountId,null);c.destroy();
});

test('accept reasons have distinct fixed copy and scoped fields; unknown reasons stay generic',async()=>{
 for(const reason of ['alias_taken','member_limit','unknown-private']){
  const client=createApi(async()=>response({requestId:'r',error:{code:'conflict',reason,message:'private'}},409));
  const c=ready({acceptInvite:client.acceptInvite});c.setInviteToken('test');await c.setAccount('a');c.showCreate();c.setAlias('입력한 별칭');await c.acceptInvite();
  assert.equal(c.state.alias,'입력한 별칭');assert.equal(c.state.error?.scope,'accept');assert.equal(c.state.conflict?.latestChecked,false);
  const msg=c.state.error?.message??''; assert.ok(!msg.includes('private'));assert.match(msg,reason==='alias_taken'?/별칭/:reason==='member_limit'?/정원/:/변경/);
  c.destroy();
 }
 const d=ready();await d.setAccount('a');await d.selectTrip(trip.id);d.showCreate();await d.saveTrip();assert.equal(d.state.error?.scope,'create');
 d.setSettingsField('name','');await d.saveSettings();assert.equal(d.state.error?.scope,'settings');d.destroy();
});

test('selection 404 followed by failed list refresh removes requested B, never accessible A',async()=>{
 const b={...trip,id:'b'};let list=0; const c=ready({listTrips:async()=>{if(list++)throw new ApiError(503,'unavailable');return [trip,b];},getTrip:async id=>{if(id===b.id)throw new ApiError(404,'not_found');return trip;}});
 await c.setAccount('a'); await c.selectTrip(trip.id);await c.selectTrip('b');assert.deepEqual(c.state.trips.map(t=>t.id),[trip.id]);assert.equal(c.state.trip?.id,trip.id);c.destroy();
});
test('management 410 closes share and retains independent received invite and alias',async()=>{
 const invite={id:'i',role:'viewer' as const,status:'pending' as const,expiresAt:'2026-11-09T00:00:00Z'};
 const c=ready({issueInvite:async()=>change({invite,url:'http://127.0.0.1:8125/invite#t=sample'}),getInviteLink:async()=>{throw new ApiError(410,'invite_unavailable');},revokeInvite:async()=>{throw new ApiError(410,'invite_unavailable');}});
 c.setInviteToken('received');await c.setAccount('a');await c.selectTrip(trip.id);c.setAlias('동행자');
 for(const action of [()=>c.getInviteLink('i'),()=>c.revokeInvite('i')]){
  await c.issueInvite();assert.ok(c.state.shareOpen);await action();assert.equal(c.state.shareOpen,false);
  assert.equal(c.state.pendingKind,null);assert.deepEqual(c.state.invite,pendingInvite(trip.name));assert.equal(c.state.alias,'동행자');
 }
 await c.acceptInvite();assert.equal(c.state.invite,null);c.destroy();
});

test('hidden action restores row summary or heading without stealing focus from another control', async () => {
 const viewModule = '../../web/travel/view.mjs';
 const { focusAfterAction } = await import(viewModule);
 const doc = {body:{},activeElement:{} as unknown};
 let focused='';
 const node = (name:string,hidden:boolean) => ({isConnected:true,disabled:false,closest:(selector:string)=>selector==='[hidden]'&&hidden?{}:null,focus:()=>{focused=name;}});
 const removed=node('removed',true), summary=node('summary',false), heading=node('heading',false);
 doc.activeElement=doc.body;focusAfterAction(doc,removed,[summary,heading]);assert.equal(focused,'summary');
 focused='';doc.activeElement=removed;focusAfterAction(doc,removed,[null,heading]);assert.equal(focused,'heading');
 focused='';doc.activeElement=node('other',false);focusAfterAction(doc,removed,[summary,heading]);assert.equal(focused,'');
});
