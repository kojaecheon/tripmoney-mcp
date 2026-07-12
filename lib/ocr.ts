// 네이버 CLOVA OCR (영수증 특화) 연동
// 활성화 조건: 환경변수 CLOVA_OCR_INVOKE_URL, CLOVA_OCR_SECRET 설정 시
// 미설정 시 isConfigured()=false → scanReceipt 는 수동 입력 폴백
import { z } from "zod";

// M3: 외부 응답 봉투/일반필드를 zod 로 검증 (any 직접 접근 축소).
// 영수증 특화(receipt.result) 트리는 벤더 스키마가 깊고 가변적이라 result 는 의도적으로 느슨하게 둔다.
const ClovaResponse = z
  .object({
    images: z
      .array(
        z
          .object({
            receipt: z.object({ result: z.unknown().optional() }).passthrough().optional(),
            fields: z.array(z.object({ inferText: z.string().optional() }).passthrough()).optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

export function isConfigured(): boolean {
  return !!(process.env.CLOVA_OCR_INVOKE_URL && process.env.CLOVA_OCR_SECRET);
}

/**
 * SSRF 방어: OCR 엔진이 서버 측에서 fetch 하는 외부 이미지 URL 검증.
 * https 만 허용하고 사설/루프백/링크로컬/메타데이터 대역을 차단한다.
 */
export function assertSafeImageUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("receipt_url 형식이 올바르지 않습니다 (https URL 이어야 합니다).");
  }
  if (u.protocol !== "https:") {
    throw new Error("receipt_url 은 https URL 이어야 합니다.");
  }
  const host = u.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) || // 루프백
    /^10\./.test(host) || // 사설 A
    /^192\.168\./.test(host) || // 사설 C
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || // 사설 B
    /^169\.254\./.test(host) || // 링크로컬 (AWS 메타데이터 169.254.169.254 포함)
    host.startsWith("[fd") || // IPv6 ULA
    host.startsWith("[fe80"); // IPv6 링크로컬
  if (blocked) {
    throw new Error("receipt_url: 사설/로컬 주소는 허용되지 않습니다.");
  }
  return raw;
}

/** data URI 접두어(data:image/png;base64,...) 를 제거하고 순수 base64 문자열만 반환 */
export function stripDataUri(s: string): string {
  const m = s.match(/^data:[^;,]+;base64,([\s\S]*)$/);
  return (m ? m[1] : s).replace(/\s/g, "");
}

/** base64 문자열에서 이미지 포맷 추정 (data URI 또는 매직넘버 기반). 실패 시 undefined */
export function sniffImageFormat(rawOrB64: string): string | undefined {
  const duri = rawOrB64.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,/);
  if (duri) return duri[1].toLowerCase().replace("jpeg", "jpg");
  const b64 = stripDataUri(rawOrB64).slice(0, 16);
  if (b64.startsWith("/9j/")) return "jpg"; // JPEG
  if (b64.startsWith("iVBORw0KGgo")) return "png"; // PNG
  if (b64.startsWith("JVBER")) return "pdf"; // %PDF
  if (b64.startsWith("SUkq") || b64.startsWith("TU0A")) return "tiff"; // II*/MM
  return undefined;
}

/** Vercel 요청 본문 한도(~4.5MB) 고려: base64 길이 상한 검증 */
export function assertBase64Size(b64: string): void {
  if (!b64 || b64.length < 32) {
    throw new Error("receipt_image_base64 값이 유효한 이미지 데이터가 아닙니다.");
  }
  const MAX = 5_500_000; // 약 4MB 바이트
  if (b64.length > MAX) {
    throw new Error("영수증 이미지가 너무 큽니다(약 4MB 초과). 더 작은 이미지를 사용해 주세요.");
  }
}

export type ReceiptParse = {
  amount?: number;
  currency?: string;
  merchant?: string;
  date?: string; // ISO (가능 시)
  raw?: any;
};

function num(s?: string): number | undefined {
  if (!s) return undefined;
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** 영수증 이미지(url 또는 base64)에서 금액/가맹점/일자 추출 */
export async function runReceiptOcr(image: {
  url?: string;
  dataBase64?: string;
  format?: string;
}): Promise<ReceiptParse> {
  const invoke = process.env.CLOVA_OCR_INVOKE_URL!;
  const secret = process.env.CLOVA_OCR_SECRET!;
  const img: any = { format: image.format ?? "jpg", name: "receipt" };
  if (image.url) img.url = image.url;
  else if (image.dataBase64) img.data = image.dataBase64;
  else throw new Error("OCR: 이미지 url 또는 dataBase64 가 필요합니다.");

  const body = {
    version: "V2",
    requestId: crypto.randomUUID(),
    timestamp: Date.now(),
    images: [img],
  };

  const res = await fetch(invoke, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OCR-SECRET": secret },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`CLOVA OCR 호출 실패: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  const parsedRes = ClovaResponse.safeParse(await res.json());
  const data = parsedRes.success ? parsedRes.data : {};
  const r: any = data.images?.[0]?.receipt?.result; // 벤더 영수증 도메인 (의도적 any)
  if (!r) {
    // 영수증 특화 응답이 아니면(일반 OCR 도메인) fields 텍스트에서 합계 추출 시도
    const fields = data.images?.[0]?.fields;
    if (Array.isArray(fields) && fields.length) {
      return extractFromGeneral(fields);
    }
    return { raw: data };
  }

  const amount =
    num(r?.totalPrice?.price?.formatted?.value) ??
    num(r?.totalPrice?.price?.text);
  const merchant = r?.storeInfo?.name?.text ?? undefined;

  // 날짜 조합 (yyyy mm dd / hh mm ss)
  let date: string | undefined;
  const d = r?.paymentInfo?.date?.formatted;
  const tm = r?.paymentInfo?.time?.formatted;
  if (d?.year && d?.month && d?.day) {
    const hh = tm?.hour ?? "00";
    const mm = tm?.minute ?? "00";
    const ss = tm?.second ?? "00";
    const iso = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    if (!Number.isNaN(Date.parse(iso))) date = new Date(iso).toISOString();
  }

  return { amount, merchant, date, raw: r };
}

/** 통화형 숫자만 인식 (날짜/시간/일반 정수 제외). 쉼표 천단위 또는 원/₩ 표기만 통화로 간주 */
function currencyNum(t: string): number | undefined {
  if (/\d{4}[-./]\d{1,2}[-./]\d{1,2}/.test(t)) return undefined; // 날짜
  if (/^\d{1,2}:\d{2}/.test(t)) return undefined; // 시간
  const isCurrency = /\d{1,3}(?:,\d{3})+/.test(t) || /[원₩]/.test(t);
  if (!isCurrency) return undefined;
  const n = Number(t.replace(/[^0-9]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 일반 OCR(fields) 결과에서 합계 금액/가맹점 휴리스틱 추출 */
function extractFromGeneral(fields: any[]): ReceiptParse {
  const tokens: string[] = fields.map((f) => String(f.inferText ?? "")).filter(Boolean);
  const fullText = tokens.join(" ");

  const KEYS = ["합계", "총액", "총금액", "결제금액", "받을금액", "판매금액", "결제", "total", "amount", "sum"];
  let amount: number | undefined;

  // 합계 키워드 이후 가까운(최대 6토큰) 통화 숫자 우선
  for (let i = 0; i < tokens.length && amount === undefined; i++) {
    const low = tokens[i].toLowerCase().replace(/\s/g, "");
    if (KEYS.some((k) => low.includes(k))) {
      for (let j = i; j < Math.min(i + 7, tokens.length); j++) {
        const v = currencyNum(tokens[j]);
        if (v) { amount = v; break; }
      }
    }
  }
  // 키워드 못 찾으면 통화형 숫자 중 최댓값 (총액은 보통 최대)
  if (amount === undefined) {
    const nums = tokens.map(currencyNum).filter((n): n is number => n !== undefined);
    if (nums.length) amount = Math.max(...nums);
  }

  const merchant = tokens[0] && !/^[0-9]/.test(tokens[0]) ? tokens[0] : undefined;
  return { amount, merchant, raw: { fullText, tokenCount: tokens.length } };
}
