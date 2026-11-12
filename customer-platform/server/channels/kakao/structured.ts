import {IdentityError} from '../../../core/contracts.js';
import {normalizeLedgerCommand} from '../../../core/ledger/normalize.js';
import type {ChannelCommand, ChannelContext} from '../../integration/contracts.js';

const guidance='입력 형식을 확인해 주세요.\n연결: 연결 뒤에 웹 연결 코드 입력\n여행: 여행\n경비: 경비 2026-11-08 12:00 | 점심 | 12000 KRW | 결제자 이름 | 전체\n분담자는 전체 또는 쉼표로 구분한 이름을 입력해 주세요. KRW는 정수, THB는 소수 둘째 자리까지 입력할 수 있습니다.';
export class StructuredInputError extends IdentityError {
 constructor(message=guidance){super('validation',message);}
}
type StructuredExpense={kind:'expense';date:string;time:string;title:string;amount:string;currency:'KRW'|'THB';payer:string;split:string[]|'all'};
type StructuredRequest={kind:'pair';code:string}|{kind:'context'}|StructuredExpense;

/** Deliberate grammar only. No natural-language inference or provider calls. */
export function parseStructuredUtterance(value:unknown):StructuredRequest {
 if(typeof value!=='string'||value.length>2000||/\p{Cc}/u.test(value))throw new StructuredInputError();
 const utterance=value.trim();
 if(utterance==='여행')return {kind:'context'};
 const pair=/^연결\s+([0-9a-f]{24})$/.exec(utterance);
 if(pair)return {kind:'pair',code:pair[1]!};
 const parts=utterance.split('|').map(part=>part.trim());
 if(parts.length!==5||parts.some(part=>!part))throw new StructuredInputError();
 const when=/^경비\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/.exec(parts[0]!);
 const money=/^([0-9]+(?:\.[0-9]{1,2})?)\s+(KRW|THB)$/.exec(parts[2]!);
 if(!when||!money||(money[2]==='KRW'&&money[1]!.includes('.')))throw new StructuredInputError();
 const split=parts[4]==='전체'?'all':parts[4]!.split(',').map(name=>name.trim());
 if(split!=='all'&&(split.some(name=>!name||name==='전체')||new Set(split).size!==split.length))throw new StructuredInputError('분담자 이름을 중복 없이 쉼표로 구분해 주세요. 전체는 단독으로 입력해 주세요.');
 return {kind:'expense',date:when[1]!,time:when[2]!,title:parts[1]!,amount:money[1]!,currency:money[2] as 'KRW'|'THB',payer:parts[3]!,split};
}

/** Resolve only current active member aliases from the authorized ledger DTO. */
export function structuredExpenseCommand(request:StructuredExpense,context:ChannelContext):ChannelCommand {
 const active=context.ledger.members.filter(member=>member.active);
 function member(name:string) {
  const matches=active.filter(member=>member.alias===name);
  if(matches.length!==1)throw new StructuredInputError('여행의 활성 멤버 이름을 정확히 입력해 주세요. 같은 이름이 여러 명이면 웹에서 이름을 구분한 뒤 다시 입력해 주세요.');
  return matches[0]!;
 }
 const payer=member(request.payer);
 const splits=request.split==='all'?active:request.split.map(member);
 // Whole-group input must not silently select ambiguous names either.
 if(!splits.length||splits.some(entry=>member(entry.alias).id!==entry.id))throw new StructuredInputError();
 const normalized=normalizeLedgerCommand({type:'expense.create',input:{itineraryId:null,title:request.title,
  occurredLocal:`${request.date}T${request.time}`,currency:request.currency,amount:request.amount,
  payerId:payer.id,splitIds:splits.map(entry=>entry.id),refreshRate:false}});
 if(normalized.type!=='expense.create')throw new StructuredInputError();
 return normalized;
}
