// 환율 변환 헬퍼 (현지통화 → base 통화)
// 무료 공개 API(open.er-api.com, 키 불필요) 사용 + 람다 수명 동안 메모리 캐시
import { z } from "zod";

type RateCache = { rates: Record<string, number>; fetchedAt: number };
const cache = new Map<string, RateCache>();
const TTL_MS = 1000 * 60 * 60; // 1시간

// M3: 외부 응답을 zod 로 검증 (any 직접 접근 제거)
const ErApiResponse = z.object({
  result: z.string(),
  rates: z.record(z.string(), z.number()).optional(),
});

/**
 * 1 fromCur = ? toCur. 동일통화면 1.
 * M2(graceful degradation): 신선한 캐시 → 즉시 반환. 만료 시 갱신 시도하되,
 * 외부 API 실패 시 만료된 캐시라도 있으면 폴백한다. 폴백조차 없으면 예외(수동 환율 안내).
 */
export async function getRate(fromCur: string, toCur: string): Promise<number> {
  const from = fromCur.toUpperCase();
  const to = toCur.toUpperCase();
  if (from === to) return 1;

  const cached = cache.get(from);
  const fresh = cached && Date.now() - cached.fetchedAt < TTL_MS;
  if (fresh && cached!.rates[to]) {
    return cached!.rates[to];
  }

  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${from}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = ErApiResponse.safeParse(await res.json());
    if (!parsed.success || parsed.data.result !== "success" || !parsed.data.rates) {
      throw new Error("응답 형식 오류");
    }
    cache.set(from, { rates: parsed.data.rates, fetchedAt: Date.now() });
    const rate = parsed.data.rates[to];
    if (!rate) throw new Error(`지원하지 않는 통화: ${to}`);
    return rate;
  } catch (e: any) {
    // M2: 외부 장애 시 만료된 캐시로 폴백 (서비스 연속성)
    if (cached?.rates[to]) return cached.rates[to];
    throw new Error(
      `환율 조회 실패(${from}→${to}): ${e?.message ?? e}. exchange_rate 를 직접 전달하면 우회할 수 있습니다.`
    );
  }
}

/** 금액을 base 통화로 환산. exchangeRate가 주어지면 그것을 사용, 아니면 조회 */
export async function toBase(
  amount: number,
  currency: string,
  baseCurrency: string,
  exchangeRate?: number
): Promise<{ amount_base: number; exchange_rate: number }> {
  const rate =
    exchangeRate && exchangeRate > 0
      ? exchangeRate
      : await getRate(currency, baseCurrency);
  return { amount_base: Math.round(amount * rate * 100) / 100, exchange_rate: rate };
}
