import {IdentityError} from '../../core/contracts.js';
import {isRecord,providerJson,providerUnavailable,validGeminiKey} from './provider-transport.js';
import type {RecommendationContext,RecommendationProvider} from './recommendation-provider.js';

const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent';
const example: RecommendationContext = {
  destination: '부산', startDate: '2026-12-12', endDate: '2026-12-12',
  timeZone: 'Asia/Seoul', memberCount: 1, budgetKrw: 60000,
  interests: ['시장', '산책'], pace: 'relaxed',
};
const inputFields = {
  date: {type:'string', enum:[example.startDate]},
  startTime: {type:'string', description:'24시간제 HH:mm'},
  endTime: {type:'string', description:'24시간제 HH:mm'},
  title: {type:'string'},
  place: {type:'string'},
  budgetKrw: {type:'integer', minimum:0, maximum:example.budgetKrw},
  placeRef: {type:'null'},
};
const responseJsonSchema = {
  type: 'object', required: ['items'],
  properties: {
    items: {
      type: 'array', minItems: 1, maxItems: 1,
      items: {
        type: 'object', required: ['input', 'reason'],
        properties: {
          input: {type:'object', required:Object.keys(inputFields), properties:inputFields, additionalProperties:false},
          reason: {type:'string'},
        },
      },
    },
  },
};

function readCandidate(response: unknown): unknown {
  if (!isRecord(response) || !Array.isArray(response.candidates) || response.candidates.length !== 1) throw providerUnavailable();
  const candidate: unknown = response.candidates[0];
  if (!isRecord(candidate) || candidate.finishReason !== 'STOP' || !isRecord(candidate.content) ||
      candidate.content.role !== 'model' || !Array.isArray(candidate.content.parts)) throw providerUnavailable();
  const textParts: string[] = [];
  for (const part of candidate.content.parts as unknown[]) {
    if (!isRecord(part) || typeof part.text !== 'string') throw providerUnavailable();
    if (part.thought !== true) textParts.push(part.text);
  }
  if (!textParts.length) throw providerUnavailable();
  const result: unknown = JSON.parse(textParts.join(''));
  if (!isRecord(result) || !Array.isArray(result.items) || result.items.length !== 1) throw providerUnavailable();
  const item: unknown = result.items[0];
  if (!isRecord(item) || !isRecord(item.input) || item.input.placeRef !== null) throw providerUnavailable();
  return result;
}

/** Local development only. The fixed example is the only payload sent to Google. */
export function createGeminiTrial({apiKey, fetcher = fetch}: {apiKey: string; fetcher?: typeof fetch}): RecommendationProvider {
  if (!validGeminiKey(apiKey)) throw Error('Gemini 무료 프로젝트의 API 키를 확인해 주세요.');
  let reserved = false;
  return {
    source: 'gemini',
    async generate(context) {
      const matchesExample = context.destination === example.destination && context.startDate === example.startDate &&
        context.endDate === example.endDate && context.timeZone === example.timeZone && context.memberCount === example.memberCount &&
        context.budgetKrw === example.budgetKrw && context.pace === example.pace &&
        context.interests.length === example.interests.length &&
        context.interests.every((interest, index) => interest === example.interests[index]);
      if (!matchesExample) throw new IdentityError('validation','Gemini 시험은 지정된 부산 가상 여행에서 실행해 주세요.');
      if (reserved) throw new IdentityError('rate_limited','이 실행에서 Gemini 추천을 이미 요청했습니다.');
      const response = await providerJson({
        apiKey, fetcher, allowNetwork: true, usageScope: 'local-fictional-trip', dailyLimit: 1, timeoutMs: 10000,
        usageStore: {
          async reserve() {
            if (reserved) return false;
            reserved = true;
            return true;
          },
        },
      }, 'gemini', endpoint, {
        method: 'POST',
        headers: {'Content-Type':'application/json', 'x-goog-api-key':apiKey},
        body: JSON.stringify({
          contents: [{role:'user', parts:[{text:`다음 가상 여행을 위한 한국어 일정 후보를 하나 제안하세요. 시간 순서와 예산을 지키고 placeRef는 null로 두세요. 영업 여부나 현재 요금은 확인된 것으로 표시하지 마세요. ${JSON.stringify(example)}`}]}],
          generationConfig: {maxOutputTokens:1024, responseMimeType:'application/json', responseJsonSchema, thinkingConfig:{thinkingLevel:'MINIMAL'}},
        }),
      });
      return readCandidate(response);
    },
  };
}
