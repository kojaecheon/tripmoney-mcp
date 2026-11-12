import { invalid } from '../../core/ledger/money.js';
import { tripClock } from '../../core/ledger/time.js';
import type { AiProvider } from './contracts.js';

export const SYNTHETIC_MESSAGES = ['내일 오전 10시 왕궁 방문', '점심 300바트', '택시 15000원'] as const;
export function createSyntheticAiProvider(): AiProvider {
  return {source: 'synthetic', async extract(context) {
    switch (context.message) {
      case SYNTHETIC_MESSAGES[0]: {
        const today = tripClock(context.now, context.timeZone).date;
        const date = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0,10);
        return {kind: 'schedule', fields: {date, startTime: '10:00', title: '왕궁 방문', place: '왕궁'}};
      }
      case SYNTHETIC_MESSAGES[1]: return {kind: 'expense', fields: {title: '점심', currency: 'THB', amount: '300'}};
      case SYNTHETIC_MESSAGES[2]: return {kind: 'expense', fields: {title: '택시', currency: 'KRW', amount: '15000'}};
      default: return invalid('message');
    }
  }};
}
