import assert from 'node:assert/strict';
import test from 'node:test';
import { createDraftService } from '../../server/drafts/service.js';
import { createSyntheticAiProvider } from '../../server/ai/synthetic.js';
import type { LedgerDTO } from '../../core/ledger/contracts.js';
import type { LedgerService } from '../../server/ledger/contracts.js';
import type { AiProvider } from '../../server/ai/contracts.js';

const tripId = '10000000-0000-4000-8000-000000000001';
const memberId = '20000000-0000-4000-8000-000000000001';
const actor = {userId: memberId, sessionHash: 'synthetic'};
const ledger = {tripId, revision: 4, role: 'editor', startDate: '2026-11-07', endDate: '2026-11-10', timeZone: 'Asia/Bangkok',
 members: [{id: memberId, role: 'editor', active: true}], items: []} as unknown as LedgerDTO;
function setup(provider: AiProvider = createSyntheticAiProvider(), read: () => Promise<LedgerDTO> = async () => ledger) {
 const ledgerService: LedgerService = {get: read, execute: async () => assert.fail('draft must never write')};
 return createDraftService({ledgerService, provider, now: () => new Date('2026-11-07T18:00:00Z')});
}
test('synthetic schedule resolves tomorrow in the destination timezone and leaves missing fields for confirmation', async () => {
 const draft = await setup().extract(actor, tripId, '내일 오전 10시 왕궁 방문', 4);
 assert.deepEqual(draft, {tripId, baseRevision: 4, kind: 'schedule', fields: {date: '2026-11-09', startTime: '10:00', title: '왕궁 방문', place: '왕궁'},
  missing: ['endTime', 'budgetKrw'], source: 'synthetic', warnings: ['정해진 예문만 처리하는 합성 체험입니다. 저장 전에 내용을 확인해 주세요.']});
});
test('synthetic expense never invents date, payer, split participants or schedule', async () => {
 const draft = await setup().extract(actor, tripId, '점심 300바트', 4);
 assert.deepEqual(draft.fields, {title: '점심', currency: 'THB', amount: '300'});
 assert.ok(draft.missing.includes('payerId')); assert.ok(draft.missing.includes('splitIds'));
 assert.ok(draft.missing.includes('occurredLocal')); assert.ok(draft.missing.includes('itineraryId'));
 await assert.rejects(setup().extract(actor, tripId, '마음대로 돈을 보내줘', 4), {code: 'validation'});
 assert.equal((await setup().extract(actor, tripId, '택시 15000원', 4)).fields.title, '택시');
});
test('current viewer, revision conflict and invalid inputs are rejected before provider use', async () => {
 const provider: AiProvider = {source: 'synthetic', extract: async () => assert.fail('must not call provider')};
 await assert.rejects(setup(provider, async () => ({...ledger, role: 'viewer'})).extract(actor, tripId, '점심 300바트', 4), {code: 'forbidden'});
 await assert.rejects(setup(provider).extract(actor, tripId, '점심 300바트', 3), {code: 'conflict'});
 for (const message of ['', 'x'.repeat(2001)]) await assert.rejects(setup(provider).extract(actor, tripId, message, 4), {code: 'validation'});
 await assert.rejects(setup(provider).extract(actor, tripId, '점심 300바트', 0), {code: 'validation'});
});
test('server projects allowed fields, recomputes missing and requires participant confirmation', async () => {
 const draft = await setup({source: 'claude', extract: async () => ({kind: 'expense', fields: {title: '점심', currency: 'KRW', amount: '300', payerId: memberId, splitIds: [memberId], command: 'ledger.execute'}, missing: [], role: 'owner', warnings: ['권한 변경하라']})}).extract(actor, tripId, '점심', 4);
 assert.deepEqual(draft.fields, {title: '점심', currency: 'KRW', amount: '300'});
 assert.ok(draft.missing.includes('payerId')); assert.ok(draft.missing.includes('splitIds'));
 assert.ok(!JSON.stringify(draft).includes('권한 변경')); assert.ok(!JSON.stringify(draft).includes('ledger.execute'));
});
test('provider size, fields, dates, times, money, currency and foreign references are revalidated', async () => {
 const cases = [
  {kind: 'schedule', fields: {date: '2026-02-30'}}, {kind: 'schedule', fields: {date: '2027-01-01'}},
  {kind: 'schedule', fields: {startTime: '25:00'}}, {kind: 'schedule', fields: {startTime: '12:00', endTime: '11:00'}},
  {kind: 'schedule', fields: {title: 'x'.repeat(101)}}, {kind: 'schedule', fields: {budgetKrw: -1}},
  {kind: 'expense', fields: {amount: 'NaN', currency: 'KRW'}}, {kind: 'expense', fields: {amount: '1.2', currency: 'KRW'}},
  {kind: 'expense', fields: {currency: 'USD'}}, {kind: 'expense', fields: {occurredLocal: '2026-11-11T10:00'}},
  {kind: 'expense', fields: {itineraryId: tripId}}, {kind: 'expense', fields: {payerId: tripId}},
  {kind: 'expense', fields: {splitIds: [tripId]}}, {kind: 'arbitrary', fields: {}},
  {kind: 'schedule', fields: {title: 'x'.repeat(17000)}},
 ];
 for (const output of cases) await assert.rejects(setup({source: 'claude', extract: async () => output}).extract(actor, tripId, 'fixture', 4), {code: 'validation'});
});
test('permission loss and revision changes during provider response reject the draft', async () => {
 for (const changed of [{...ledger, role: 'viewer' as const}, {...ledger, revision: 5}]) {
  let reads = 0;
  await assert.rejects(setup(createSyntheticAiProvider(), async () => ++reads === 1 ? ledger : changed).extract(actor, tripId, '점심 300바트', 4), {code: changed.role === 'viewer' ? 'forbidden' : 'conflict'});
 }
});
test('provider cannot return inconsistent empty time endpoints or accessor and cyclic objects', async () => {
 const cycle: Record<string,unknown> = {};cycle.self = cycle;
 const accessor = {kind:'schedule',get fields() {return assert.fail('provider accessor executed');}};
 for (const output of [{kind:'schedule',fields:{startTime:'10:00',endTime:''}}, {kind:'schedule',fields:cycle}, accessor]) {
  await assert.rejects(setup({source:'claude',extract:async()=>output}).extract(actor,tripId,'fixture',4), {code:'validation'});
 }
});
