import type { ExpenseInput, LedgerCommand, ScheduleInput } from './contracts.js';
import { amountCents, invalid } from './money.js';
import { calendarDate, clockTime, localMinute } from './time.js';
import { MAX_PAYMENT_KRW } from './settlement.js';
import { normalizePlaceRef } from '../places/contracts.js';

type Fields = Record<string,unknown>;
function dataProperty(object: object, key: string): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(object,key);
  if (descriptor?.enumerable === true && Object.hasOwn(descriptor,'value')) return descriptor;
}
function fields(value: unknown, keys: string[], field: string): Fields {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length || keys.some(k => !dataProperty(value,k))) return invalid(field);
  return value as Fields;
}
function text(value: unknown, min: number, max: number, field: string): string {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) return invalid(field);
  const clean = value.trim(), length = [...clean].length;
  if (length < min || length > max) return invalid(field);
  return clean;
}
export function ledgerId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
      value === '00000000-0000-0000-0000-000000000000') return invalid(field);
  return value.toLowerCase();
}
function ids(value: unknown, field: string, min: number, max: number): string[] {
  if (!Array.isArray(value)) return invalid(field);
  const length = value.length;
  if (length < min || length > max || Reflect.ownKeys(value).length !== length + 1) return invalid(field);
  const list: string[] = [];
  for (let i = 0; i < length; i++) {
    const entry = dataProperty(value,String(i));
    if (!entry) return invalid(field);
    list.push(ledgerId(entry.value,field));
  }
  if (new Set(list).size !== list.length) return invalid(field);
  return list;
}
function schedule(value: unknown): ScheduleInput {
  const hasRef = value !== null && typeof value === 'object' && Object.hasOwn(value,'placeRef');
  const s = fields(value,['date','startTime','endTime','title','place','budgetKrw',...(hasRef ? ['placeRef'] : [])],'input');
  const ref = hasRef ? normalizePlaceRef(s.placeRef) : null;
  if (hasRef && s.placeRef !== null && ref === null) return invalid('placeRef');
  const bothEmpty = s.startTime === '' && s.endTime === '';
  const startTime = bothEmpty ? '' : clockTime(s.startTime,'startTime');
  const endTime = bothEmpty ? '' : clockTime(s.endTime,'endTime');
  if (endTime < startTime) return invalid('endTime');
  if (typeof s.budgetKrw !== 'number' || !Number.isSafeInteger(s.budgetKrw) || s.budgetKrw < 0) return invalid('budgetKrw');
  return {date:calendarDate(s.date), startTime, endTime, title:text(s.title,1,100,'title'),
    place:text(s.place,0,200,'place'), budgetKrw:s.budgetKrw,...(hasRef ? {placeRef:ref} : {})};
}
function expense(value: unknown): ExpenseInput {
  const e = fields(value,['itineraryId','title','occurredLocal','currency','amount','payerId','splitIds','refreshRate'],'input');
  if (e.currency !== 'KRW' && e.currency !== 'THB') return invalid('currency');
  if (typeof e.amount !== 'string') return invalid('amount');
  if (typeof e.refreshRate !== 'boolean') return invalid('refreshRate');
  const cents = amountCents(e.currency,e.amount);
  const fraction = cents % 100;
  const amount = String(Math.floor(cents/100)) + (fraction ? '.' + String(fraction).padStart(2,'0') : '');
  return { itineraryId:e.itineraryId === null ? null : ledgerId(e.itineraryId,'itineraryId'),
    title:text(e.title,1,100,'title'), occurredLocal:localMinute(e.occurredLocal), currency:e.currency,
    amount, payerId:ledgerId(e.payerId,'payerId'), splitIds:ids(e.splitIds,'splitIds',1,8).sort(), refreshRate:e.refreshRate };
}
export function normalizeLedgerCommand(value: unknown): LedgerCommand {
  if (!value || typeof value !== 'object' || !dataProperty(value,'type')) return invalid('command');
  const type = (value as Fields).type;
  switch (type) {
    case 'schedule.adopt': {
      const {inputs} = fields(value,['type','inputs'],'command');
      if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 60 ||
          Reflect.ownKeys(inputs).length !== inputs.length + 1) return invalid('inputs');
      const list: ScheduleInput[] = [];
      for (let i = 0; i < inputs.length; i++) {
        const entry = dataProperty(inputs,String(i));
        if (!entry) return invalid('inputs');
        list.push(schedule(entry.value));
      }
      return {type,inputs:list};
    }
    case 'schedule.create': case 'expense.create': {
      const {input} = fields(value,['type','input'],'command');
      return type === 'schedule.create' ? {type,input:schedule(input)} : {type,input:expense(input)};
    }
    case 'schedule.update': case 'expense.update': {
      const row = fields(value,['type','input','id'],'command'), id = ledgerId(row.id,'id');
      return type === 'schedule.update' ? {type,id,input:schedule(row.input)} : {type,id,input:expense(row.input)};
    }
    case 'schedule.cancel': case 'expense.cancel':
      return {type,id:ledgerId(fields(value,['type','id'],'command').id,'id')};
    case 'schedule.reorder': {
      const row = fields(value,['type','date','ids'],'command');
      return {type,date:calendarDate(row.date),ids:ids(row.ids,'ids',0,60)};
    }
    case 'fx.update': {
      const {rateMilli, source} = fields(value,['type','rateMilli','source'],'command');
      if (source !== 'demo' && source !== 'manual') return invalid('source');
      if (typeof rateMilli !== 'number' || !Number.isSafeInteger(rateMilli) || rateMilli < 1 ||
          rateMilli > 1_000_000_000 || (source === 'demo' && rateMilli !== 38600)) return invalid('rateMilli');
      return {type,source,rateMilli};
    }
    case 'settlement.finalize': case 'settlement.reopen': {
      const {date} = fields(value,['type','date'],'command');
      return {type,date:date === null ? null : calendarDate(date)};
    }
    case 'payment.report': {
      const {toMemberId,amountKrw} = fields(value,['type','toMemberId','amountKrw'],'command');
      if (typeof amountKrw !== 'number' || !Number.isSafeInteger(amountKrw) ||
          amountKrw < 1 || amountKrw > MAX_PAYMENT_KRW) return invalid('amountKrw');
      return {type,toMemberId:ledgerId(toMemberId,'toMemberId'),amountKrw};
    }
    case 'payment.confirm': case 'payment.requestVoid': case 'payment.confirmVoid': {
      const {id,expectedPaymentRevision} = fields(value,['type','id','expectedPaymentRevision'],'command');
      if (typeof expectedPaymentRevision !== 'number' || !Number.isSafeInteger(expectedPaymentRevision) ||
          expectedPaymentRevision < 1) return invalid('expectedPaymentRevision');
      return {type,id:ledgerId(id,'id'),expectedPaymentRevision};
    }
    default: return invalid('command');
  }
}
