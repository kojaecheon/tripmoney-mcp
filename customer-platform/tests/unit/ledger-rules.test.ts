import assert from 'node:assert/strict';
import { test } from 'node:test';

test('integer rounding preserves the demo split and rejects unsafe totals', async () => {
  const { amountCents, convertKrw, allocateShares, safeSum } = await import('../../core/ledger/money.js');
  assert.equal(amountCents('THB', '0.05'), 5);
  assert.equal(convertKrw(5, 38600), 2);
  assert.equal(convertKrw(125, 38400), 48);
  assert.equal(convertKrw(100, 38500), 39);
  assert.equal(convertKrw(100_000_000, 1_000_000_000), 1_000_000_000_000);
  assert.throws(() => convertKrw(1, 38600), { code: 'validation' });
  for (const value of ['0','-1','1e2','1000000.01','1.123','Infinity']) {
    assert.throws(() => amountCents('THB', value), { code: 'validation' });
  }
  assert.throws(() => amountCents('KRW', '1.0'), { code: 'validation' });
  assert.throws(() => safeSum(Number.MAX_SAFE_INTEGER, 1), { code: 'validation' });
  assert.deepEqual(allocateShares(2, ['c','b','a']), [
    {memberId:'a',amountKrw:1},{memberId:'b',amountKrw:1},{memberId:'c',amountKrw:0}
  ]);
});

test('civil time uses the trip zone and selects the earlier overlap instant', async () => {
  const { occurredAt } = await import('../../core/ledger/time.js');
  assert.equal(occurredAt('2026-11-01T01:30','America/New_York'), '2026-11-01T05:30:00.000Z');
  assert.equal(occurredAt('2026-04-05T01:45','Australia/Lord_Howe'), '2026-04-04T14:45:00.000Z');
  assert.equal(occurredAt('2026-11-03T00:15','Asia/Kathmandu'), '2026-11-02T18:30:00.000Z');
  for (const [local, zone] of [
    ['2026-03-08T02:30','America/New_York'], ['2026-02-30T10:00','UTC'],
    ['2026-02-28T24:01','UTC'], ['2026-01-01T10:00','+03:00'],
    ['2011-12-30T00:00','Pacific/Apia']
  ] as const) assert.throws(() => occurredAt(local, zone), { code:'validation' });
});

test('commands reject additional keys, invalid identifiers, control characters and partial times', async () => {
  const { normalizeLedgerCommand } = await import('../../core/ledger/normalize.js');
  const schedule = {date:'2026-11-03',startTime:'',endTime:'',title:'  하루  ',place:'',budgetKrw:0};
  const type = 'schedule.create';
  assert.deepEqual(normalizeLedgerCommand({type,input:schedule}), {type,input:{...schedule,title:'하루'}});
  for (const input of [{...schedule,role:'owner'}, {...schedule,title:'\n하루'},
    {...schedule,place:'a\u0085b'}, {...schedule,title:'😀'.repeat(101)}, {...schedule,date:'2026-04-31'},
    {...schedule,startTime:'12:00'}, {...schedule,startTime:'12:30',endTime:'12:00'}]) {
    assert.throws(() => normalizeLedgerCommand({type,input}), {code:'validation'});
  }
  assert.throws(() => normalizeLedgerCommand({type,input:schedule,actor:{}}), {code:'validation'});
  assert.throws(() => normalizeLedgerCommand({type:'expense.cancel',id:'00000000-0000-0000-0000-000000000000'}), {code:'validation'});
  assert.throws(() => normalizeLedgerCommand({type:'fx.update',source:'demo',rateMilli:40_000}), {code:'validation'});
});

test('command normalization never invokes accessors or reads inherited command types', async () => {
  const { normalizeLedgerCommand } = await import('../../core/ledger/normalize.js');
  let invoked = false;
  const accessor = () => { invoked = true; throw new Error('unexpected getter'); };
  const badType = Object.defineProperty({},'type',{enumerable:true,get:accessor});
  const badInput = Object.defineProperty({type:'schedule.create'},'input',{enumerable:true,get:accessor});
  for (const value of [badType,badInput,Object.create({type:'schedule.create'})]) {
    assert.throws(()=>normalizeLedgerCommand(value),{code:'validation'});
  }
  assert.equal(invoked,false);
});

test('ID normalization copies own entries without invoking an inherited iterator', async () => {
  const { normalizeLedgerCommand } = await import('../../core/ledger/normalize.js');
  const ownId = '11111111-1111-1111-1111-111111111111';
  const alternateId = '22222222-2222-2222-2222-222222222222';
  const ids = [ownId];
  let iteratorReads = 0;
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype,Symbol.iterator,{get() {
    iteratorReads++;
    return function* () { yield alternateId; };
  }});
  Object.setPrototypeOf(ids,prototype);

  assert.deepEqual(normalizeLedgerCommand({type:'schedule.reorder',date:'2026-11-03',ids}),
    {type:'schedule.reorder',date:'2026-11-03',ids:[ownId]});
  assert.equal(iteratorReads,0);
});
