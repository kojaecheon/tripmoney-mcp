// TripMoney MCP 서버 정의 + 핵심 8종 Tool 등록
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { q, one, tx } from "./db.js";
import { toBase } from "./fx.js";
import {
  calculateSettlement,
  rescaleShares,
  type Member,
  type ExpenseForCalc,
  type SettleMode,
} from "./settlement.js";
import {
  createShares,
  requireExpenseTripRefs,
  requireReadAccess,
  requireTripKey,
  requireWriteRole,
  tripBaseCurrency,
} from "./guards.js";
import type {
  TripRow,
  MemberRow,
  ScheduleRow,
  ExpenseRow,
} from "./types.js";
import {
  isConfigured as ocrConfigured,
  runReceiptOcr,
  assertSafeImageUrl,
  stripDataUri,
  sniffImageFormat,
  assertBase64Size,
} from "./ocr.js";
import {
  tossSendLink,
  kakaoPayLink,
  settlementMessage,
  type SettleTransferView,
} from "./links.js";
import { validateCustomShareTotal } from "./validation.js";
import { recordAuditEvent } from "./audit.js";
import { buildSettlementExport } from "./settlementExport.js";
import { recommendTripItinerary } from "./itinerary.js";

// ---- 공통 헬퍼 --------------------------------------------------------------

const ok = (data: any, summary?: string) => ({
  content: [
    {
      type: "text" as const,
      text: (summary ? summary + "\n\n" : "") + JSON.stringify(data, null, 2),
    },
  ],
  structuredContent: data,
});

const fail = (msg: string) => ({
  content: [{ type: "text" as const, text: `❌ ${msg}` }],
  isError: true,
});

/** schedule_id 로부터 trip_id 조회 */
async function tripIdOfSchedule(scheduleId: string): Promise<string> {
  const s = await one<{ trip_id: string }>(
    "select trip_id from tripmoney.schedules where id = $1",
    [scheduleId]
  );
  if (!s) throw new Error("존재하지 않는 schedule_id 입니다.");
  return s.trip_id;
}

/** expense_id 로부터 trip_id 조회 */
async function tripIdOfExpense(expenseId: string): Promise<string> {
  const e = await one<{ trip_id: string }>(
    "select trip_id from tripmoney.expenses where id = $1",
    [expenseId]
  );
  if (!e) throw new Error("존재하지 않는 expense_id 입니다.");
  return e.trip_id;
}

// ---- 서버 빌더 --------------------------------------------------------------

export function buildServer(): McpServer {
  const server = new McpServer({ name: "tripmoney-mcp", version: "0.1.0" });

  // 1) createTrip ------------------------------------------------------------
  server.registerTool(
    "createTrip",
    {
      title: "여행방 생성",
      description:
        "[트립머니] 같이 여행 가는 사람들을 위한 공유 공간(여행방)을 만든다. 기준 통화, 기간, 초기 멤버를 함께 등록할 수 있다.",
      annotations: {
        title: "여행방 생성",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        name: z.string().describe("여행방 이름"),
        base_currency: z.string().default("KRW").describe("정산 기준 통화 (기본 KRW)"),
        start_date: z.string().optional().describe("시작일 YYYY-MM-DD"),
        end_date: z.string().optional().describe("종료일 YYYY-MM-DD"),
        members: z
          .array(
            z.object({
              name: z.string(),
              role: z.enum(["owner", "editor", "viewer"]).default("editor"),
              bank_name: z.string().optional().describe("송금 딥링크용 은행명"),
              account_no: z.string().optional().describe("송금 딥링크용 계좌번호"),
            })
          )
          .optional()
          .describe("초기 멤버 목록 (role: owner/editor 는 수정 가능, viewer 는 조회만)"),
      },
    },
    async (a) => {
      try {
        // C2: 모든 여행방은 기본 보호 — trip_key 자동 발급 (이후 모든 조회·수정에 검증)
        const apiKey = crypto.randomUUID().replace(/-/g, "");
        const trip = (await one<TripRow>(
          "insert into tripmoney.trips(name, base_currency, start_date, end_date, api_key) values ($1,$2,$3,$4,$5) returning *",
          [a.name, a.base_currency ?? "KRW", a.start_date ?? null, a.end_date ?? null, apiKey]
        ))!; // insert ... returning * 은 항상 1행 보장
        const members: MemberRow[] = [];
        const list = a.members ?? [];
        for (let i = 0; i < list.length; i++) {
          const role = list[i].role ?? (i === 0 ? "owner" : "editor");
          const m = (await one<MemberRow>(
            "insert into tripmoney.members(trip_id, name, role, bank_name, account_no) values ($1,$2,$3,$4,$5) returning *",
            [trip.id, list[i].name, role, list[i].bank_name ?? null, list[i].account_no ?? null]
          ))!;
          members.push(m);
        }
        const msg = `🔐 여행방 '${a.name}' 생성 — trip_key: ${apiKey}\n이후 이 방의 모든 조회·수정 호출에 이 키가 필요합니다. 분실 시 복구 불가하니 안전하게 보관하세요.`;
        return ok({ trip, members, trip_key: apiKey }, msg);
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  // 2) addMember -------------------------------------------------------------
  server.registerTool(
    "addMember",
    {
      title: "멤버 추가",
      description: "[트립머니] 여행방에 동행 멤버를 추가한다.",
      annotations: {
        title: "멤버 추가",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        trip_id: z.string(),
        name: z.string(),
        role: z.enum(["owner", "editor", "viewer"]).default("editor"),
        bank_name: z.string().optional().describe("송금 딥링크용 은행명"),
        account_no: z.string().optional().describe("송금 딥링크용 계좌번호"),
        trip_key: z.string().optional().describe("보호 여행방의 접근키"),
      },
    },
    async (a) => {
      try {
        await requireTripKey(a.trip_id, a.trip_key);
        const m = await tx(async (db) => {
          const member = (await db.one<MemberRow>(
            "insert into tripmoney.members(trip_id, name, role, bank_name, account_no) values ($1,$2,$3,$4,$5) returning *",
            [a.trip_id, a.name, a.role ?? "editor", a.bank_name ?? null, a.account_no ?? null]
          ))!;
          await recordAuditEvent(
            {
              trip_id: a.trip_id,
              action: "member.add",
              target_type: "member",
              target_id: member.id,
              payload: { name: a.name, role: a.role ?? "editor" },
            },
            db
          );
          return member;
        });
        return ok({ member: m }, `✅ 멤버 '${a.name}' 추가`);
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  // 3) addSchedule -----------------------------------------------------------
  server.registerTool(
    "addSchedule",
    {
      title: "일정 등록",
      description:
        "[트립머니] 여행방에 일정을 등록한다. 일정별 예산(planned_budget)을 미리 잡아둘 수 있다.",
      annotations: {
        title: "일정 등록",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        trip_id: z.string(),
        title: z.string(),
        start_at: z.string().optional().describe("ISO8601 시작 시각"),
        end_at: z.string().optional().describe("ISO8601 종료 시각"),
        location: z.string().optional(),
        lat: z.number().optional(),
        lng: z.number().optional(),
        planned_budget: z.number().optional().describe("일정별 예산 (기준 통화)"),
        actor_member_id: z.string().optional().describe("등록 주체 멤버 id (권한 검사)"),
        trip_key: z.string().optional().describe("보호 여행방의 접근키"),
      },
    },
    async (a) => {
      try {
        await requireTripKey(a.trip_id, a.trip_key);
        await requireWriteRole(a.actor_member_id, a.trip_id);
        const s = await tx(async (db) => {
          const schedule = (await db.one<ScheduleRow>(
            `insert into tripmoney.schedules(trip_id,title,start_at,end_at,location,lat,lng,planned_budget,created_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
            [
              a.trip_id,
              a.title,
              a.start_at ?? null,
              a.end_at ?? null,
              a.location ?? null,
              a.lat ?? null,
              a.lng ?? null,
              a.planned_budget ?? 0,
              a.actor_member_id ?? null,
            ]
          ))!; // insert ... returning * 은 항상 1행 보장
          await recordAuditEvent(
            {
              trip_id: a.trip_id,
              actor_member_id: a.actor_member_id ?? null,
              action: "schedule.add",
              target_type: "schedule",
              target_id: schedule.id,
              payload: { title: a.title, start_at: a.start_at ?? null, end_at: a.end_at ?? null },
            },
            db
          );
          return schedule;
        });
        return ok({ schedule: s }, `✅ 일정 '${a.title}' 등록`);
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  // 4) updateSchedule --------------------------------------------------------
  server.registerTool(
    "updateSchedule",
    {
      title: "일정 수정",
      description:
        "[트립머니] 기존 일정을 수정한다. 현재 시간과 비교해 지연된 일정을 미루는 등 조정에 사용. viewer 권한은 거부된다.",
      annotations: {
        title: "일정 수정",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        schedule_id: z.string(),
        actor_member_id: z.string().optional().describe("수정 주체 멤버 id (권한 검사)"),
        title: z.string().optional(),
        start_at: z.string().optional(),
        end_at: z.string().optional(),
        location: z.string().optional(),
        lat: z.number().optional(),
        lng: z.number().optional(),
        planned_budget: z.number().optional(),
        status: z.enum(["planned", "ongoing", "done", "canceled"]).optional(),
        trip_key: z.string().optional().describe("보호 여행방의 접근키"),
        expected_updated_at: z
          .string()
          .optional()
          .describe("낙관적 잠금: 마지막으로 읽은 updated_at(ISO). 그 사이 변경됐으면 거부"),
      },
    },
    async (a) => {
      try {
        const schedTripId = await tripIdOfSchedule(a.schedule_id);
        await requireTripKey(schedTripId, a.trip_key);
        await requireWriteRole(a.actor_member_id, schedTripId);
        const fields: string[] = [];
        const vals: any[] = [];
        let i = 1;
        for (const k of [
          "title",
          "start_at",
          "end_at",
          "location",
          "lat",
          "lng",
          "planned_budget",
          "status",
        ] as const) {
          if (a[k] !== undefined) {
            fields.push(`${k} = $${i++}`);
            vals.push(a[k]);
          }
        }
        if (fields.length === 0) return fail("수정할 필드가 없습니다.");
        fields.push(`updated_at = now()`);
        // where 절: id (+ M5 낙관적 잠금 시 updated_at 일치)
        vals.push(a.schedule_id);
        let where = `id = $${i}`;
        if (a.expected_updated_at) {
          i++;
          vals.push(a.expected_updated_at);
          where += ` and updated_at = $${i}::timestamptz`;
        }
        const s = await tx(async (db) => {
          const updated = await db.one<ScheduleRow>(
            `update tripmoney.schedules set ${fields.join(", ")} where ${where} returning *`,
            vals
          );
          if (!updated) return null;
          await recordAuditEvent(
            {
              trip_id: schedTripId,
              actor_member_id: a.actor_member_id ?? null,
              action: "schedule.update",
              target_type: "schedule",
              target_id: updated.id,
              payload: { changed_fields: fields.filter((field) => !field.startsWith("updated_at")).map((field) => field.split(" = ")[0]) },
            },
            db
          );
          return updated;
        });
        if (!s) {
          // 낙관적 잠금 사용 시: 행이 존재하면 '충돌', 없으면 '미존재'로 구분
          if (a.expected_updated_at) {
            const exists = await one<{ updated_at: string }>(
              "select updated_at from tripmoney.schedules where id = $1",
              [a.schedule_id]
            );
            if (exists) {
              return fail(
                `충돌: 다른 사용자가 먼저 일정을 수정했습니다(현재 updated_at: ${exists.updated_at}). 최신 내용을 다시 불러온 뒤 시도하세요.`
              );
            }
          }
          return fail("존재하지 않는 schedule_id 입니다.");
        }
        return ok({ schedule: s }, `✅ 일정 수정 완료`);
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  // 공통 비용 입력 스키마 조각
  const splitFields = {
    payer_member_id: z.string().optional().describe("결제한 멤버 id"),
    schedule_id: z.string().optional().describe("귀속 일정 id"),
    pay_method: z.enum(["card", "cash"]).default("card"),
    exchange_rate: z
      .number()
      .optional()
      .describe("1 현지통화 = ? 기준통화. 미지정 시 실시간 환율 자동 조회"),
    spent_at: z.string().optional().describe("지출 시각 ISO8601"),
    note: z.string().optional(),
    actor_member_id: z.string().optional(),
    trip_key: z.string().optional().describe("보호 여행방의 접근키"),
    split_mode: z
      .enum(["equal", "custom", "payer"])
      .default("equal")
      .describe("equal=참여자 균등 N빵, custom=직접 분담, payer=결제자 전액"),
    split_member_ids: z
      .array(z.string())
      .optional()
      .describe("equal 분담 참여자(미지정 시 전원)"),
    custom_shares: z
      .array(z.object({ member_id: z.string(), amount: z.number() }))
      .optional()
      .describe("custom 모드 멤버별 부담액(기준통화)"),
  };

  async function insertExpense(a: any, source: "manual" | "receipt") {
    await requireTripKey(a.trip_id, a.trip_key);
    await requireWriteRole(a.actor_member_id, a.trip_id);
    const base = await tripBaseCurrency(a.trip_id);
    const currency = (a.currency ?? base).toUpperCase();
    const { amount_base, exchange_rate } = await toBase(
      a.amount,
      currency,
      base,
      a.exchange_rate
    );

    // 일정 자동 매칭(시간 기반): schedule_id 없고 spent_at 있으면 시간대 포함 일정 탐색
    let scheduleId = a.schedule_id ?? null;
    if (!scheduleId && a.spent_at) {
      const matched = await one<{ id: string }>(
        `select id from tripmoney.schedules
         where trip_id = $1 and start_at is not null and end_at is not null
           and $2::timestamptz between start_at and end_at
         order by start_at limit 1`,
        [a.trip_id, a.spent_at]
      );
      if (matched) scheduleId = matched.id;
    }

    await requireExpenseTripRefs(a.trip_id, {
      payer_member_id: a.payer_member_id,
      schedule_id: scheduleId,
      split_member_ids: a.split_member_ids,
      custom_shares: a.custom_shares,
    });
    if ((a.split_mode ?? "equal") === "custom") {
      validateCustomShareTotal(a.custom_shares, amount_base);
    }

    const exp = await tx(async (db) => {
      const inserted = (await db.one<ExpenseRow>(
        `insert into tripmoney.expenses(trip_id,schedule_id,payer_member_id,title,amount,currency,exchange_rate,amount_base,pay_method,receipt_url,source,note,spent_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,coalesce($13::timestamptz, now())) returning *`,
        [
          a.trip_id,
          scheduleId,
          a.payer_member_id ?? null,
          a.title,
          a.amount,
          currency,
          exchange_rate,
          amount_base,
          a.pay_method ?? "card",
          a.receipt_url ?? null,
          source,
          a.note ?? null,
          a.spent_at ?? null,
        ]
      ))!; // insert ... returning * 은 항상 1행 보장
      await createShares(
        db,
        a.trip_id,
        inserted.id,
        amount_base,
        a.split_mode ?? "equal",
        a.split_member_ids,
        a.custom_shares
      );
      await recordAuditEvent(
        {
          trip_id: a.trip_id,
          actor_member_id: a.actor_member_id ?? null,
          action: "expense.add",
          target_type: "expense",
          target_id: inserted.id,
          payload: {
            source,
            title: a.title,
            amount: a.amount,
            currency,
            amount_base,
            pay_method: a.pay_method ?? "card",
            schedule_id: scheduleId,
            payer_member_id: a.payer_member_id ?? null,
            split_mode: a.split_mode ?? "equal",
          },
        },
        db
      );
      return inserted;
    });
    return { exp, base, currency, amount_base, exchange_rate, auto_matched_schedule: scheduleId };
  }

  // 5) addExpense ------------------------------------------------------------
  server.registerTool(
    "addExpense",
    {
      title: "비용 직접 등록",
      description:
        "[트립머니] 비용을 직접 입력한다. 현지통화로 입력하면 실시간 환율로 기준통화(보통 한화) 환산액이 함께 저장된다. 카드/현금 구분, 일정 귀속, N빵/커스텀 분담 지원.",
      annotations: {
        title: "비용 직접 등록",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        trip_id: z.string(),
        title: z.string(),
        amount: z.number().describe("현지(입력) 통화 금액"),
        currency: z.string().optional().describe("입력 통화(기본=여행방 기준통화)"),
        ...splitFields,
      },
    },
    async (a) => {
      try {
        const r = await insertExpense(a, "manual");
        return ok(
          r.exp,
          `✅ 비용 '${a.title}' 등록: ${a.amount} ${r.currency} → ${r.amount_base.toLocaleString()} ${r.base} (환율 ${r.exchange_rate})`
        );
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  // 6) scanReceipt -----------------------------------------------------------
  server.registerTool(
    "scanReceipt",
    {
      title: "영수증 기반 비용 등록",
      description:
        "[트립머니] 영수증 사진으로 비용을 등록한다. 이미지를 base64(receipt_image_base64) 또는 공개 https URL(receipt_url)로 전달하면 CLOVA OCR 이 금액·가맹점·일자를 인식해 자동으로 검증·등록한다. 채팅에 첨부된 사진처럼 공개 URL 이 없을 때는 receipt_image_base64 사용을 권장한다. amount 를 직접 전달하면 OCR 없이 등록되며, spent_at 기준으로 진행 중 일정에 자동 귀속을 시도한다.",
      annotations: {
        title: "영수증 기반 비용 등록",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        trip_id: z.string(),
        receipt_image_base64: z
          .string()
          .optional()
          .describe(
            "영수증 이미지의 base64 문자열(권장). data URI 접두어(data:image/...;base64,) 포함/미포함 모두 허용. 채팅 첨부 사진처럼 공개 URL 이 없을 때 사용."
          ),
        receipt_url: z
          .string()
          .optional()
          .describe("영수증 이미지의 공개 https URL. OCR 엔진이 서버에서 직접 내려받아 인식한다."),
        image_format: z
          .enum(["jpg", "jpeg", "png", "pdf", "tiff"])
          .optional()
          .describe("이미지 포맷(미지정 시 자동 감지, 기본 jpg)"),
        amount: z.number().optional().describe("OCR 없이 직접 등록할 금액(전달 시 OCR 생략)"),
        currency: z.string().optional().describe("입력 통화(기본=여행방 기준통화)"),
        title: z.string().optional().describe("가맹점/항목명"),
        ...splitFields,
      },
    },
    async (a) => {
      try {
        const args = { ...a };
        let ocrNote = "";
        // 인증을 이미지 처리보다 먼저 수행: 잘못된 trip_key 로는 OCR(외부 fetch/과금)을 시작하지 않는다
        await requireTripKey(a.trip_id, a.trip_key);
        await requireWriteRole(a.actor_member_id, a.trip_id);
        const hasImage = !!(a.receipt_image_base64 || a.receipt_url);
        if (!hasImage && args.amount === undefined) {
          return fail(
            "영수증 이미지(receipt_image_base64 또는 receipt_url) 또는 amount 중 하나는 반드시 필요합니다."
          );
        }

        // 금액 미전달 시: 영수증 이미지를 OCR 로 인식·검증해 자동 추출
        if (args.amount === undefined) {
          if (!ocrConfigured()) {
            return fail(
              "OCR 엔진이 설정되지 않아 영수증 이미지를 인식할 수 없습니다. amount 를 직접 전달해 주세요."
            );
          }
          let parsed;
          if (a.receipt_image_base64) {
            // base64 직접 전달: 서버측 fetch 불필요 → 비공개/차단 이미지에도 안전(권장 경로)
            const b64 = stripDataUri(a.receipt_image_base64);
            assertBase64Size(b64);
            const fmt = a.image_format ?? sniffImageFormat(a.receipt_image_base64) ?? "jpg";
            parsed = await runReceiptOcr({ dataBase64: b64, format: fmt });
          } else {
            assertSafeImageUrl(a.receipt_url!); // SSRF 방어 + https 강제
            parsed = await runReceiptOcr({ url: a.receipt_url!, format: a.image_format });
          }
          if (parsed.amount === undefined) {
            return fail(
              "영수증 이미지에서 금액을 인식하지 못했습니다. 더 선명한 이미지를 사용하거나 amount 를 직접 전달해 주세요."
            );
          }
          args.amount = parsed.amount;
          args.title = a.title ?? parsed.merchant ?? "영수증 지출";
          if (!a.spent_at && parsed.date) args.spent_at = parsed.date;
          ocrNote = ` (OCR 자동추출: ${parsed.merchant ?? "가맹점미상"})`;
        } else {
          // 금액 직접입력 시에도 첨부 이미지/URL 은 항상 검증 (대용량 base64 조기 거부)
          if (a.receipt_image_base64) assertBase64Size(stripDataUri(a.receipt_image_base64));
          if (a.receipt_url) assertSafeImageUrl(a.receipt_url);
        }

        // base64 원본 바이트는 DB 에 저장하지 않음(용량). 공개 URL 만 보관.
        const r = await insertExpense(
          { ...args, receipt_url: a.receipt_url ?? null, title: args.title ?? "영수증 지출" },
          "receipt"
        );
        const matchMsg = r.auto_matched_schedule ? ` / 일정 자동귀속됨` : "";
        return ok(
          r.exp,
          `✅ 영수증 비용 등록: ${args.amount} ${r.currency} → ${r.amount_base.toLocaleString()} ${r.base}${matchMsg}${ocrNote}`
        );
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  // 7) getBudgetSummary ------------------------------------------------------
  server.registerTool(
    "getBudgetSummary",
    {
      title: "예산/지출 요약",
      description:
        "[트립머니] 여행방의 예산 대비 지출을 요약한다. 총액, 결제수단별/통화별 합계, 일정별 예산 대비 실지출, 멤버별 결제액/부담액을 반환한다.",
      annotations: {
        title: "예산/지출 요약",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        trip_id: z.string(),
        trip_key: z.string().optional().describe("보호 여행방의 접근키(전체)"),
        share_token: z.string().optional().describe("읽기 전용 공유 토큰"),
      },
    },
    async (a) => {
      try {
        await requireReadAccess(a.trip_id, a.trip_key ?? a.share_token);
        const trip = await one<TripRow>("select * from tripmoney.trips where id = $1", [a.trip_id]);
        if (!trip) return fail("존재하지 않는 trip_id 입니다.");

        const totalRow = await one<{ total: number; cnt: number }>(
          "select coalesce(sum(amount_base),0)::float as total, count(*)::int as cnt from tripmoney.expenses where trip_id = $1",
          [a.trip_id]
        );
        const byMethod = await q(
          "select pay_method, coalesce(sum(amount_base),0)::float as total from tripmoney.expenses where trip_id=$1 group by pay_method",
          [a.trip_id]
        );
        const byCurrency = await q(
          "select currency, coalesce(sum(amount),0)::float as local_total, coalesce(sum(amount_base),0)::float as base_total from tripmoney.expenses where trip_id=$1 group by currency",
          [a.trip_id]
        );
        const bySchedule = await q<{ id: string; title: string; planned: number; actual: number }>(
          `select s.id, s.title, coalesce(s.planned_budget,0)::float as planned,
                  coalesce((select sum(e.amount_base) from tripmoney.expenses e where e.schedule_id = s.id),0)::float as actual
           from tripmoney.schedules s where s.trip_id = $1 order by s.start_at nulls last`,
          [a.trip_id]
        );
        const perMemberPaid = await q(
          `select m.id, m.name, coalesce(sum(e.amount_base),0)::float as paid
           from tripmoney.members m left join tripmoney.expenses e on e.payer_member_id = m.id
           where m.trip_id = $1 group by m.id, m.name order by m.name`,
          [a.trip_id]
        );
        const perMemberOwed = await q(
          `select m.id, m.name, coalesce(sum(sh.share_base),0)::float as owed
           from tripmoney.members m left join tripmoney.expense_shares sh on sh.member_id = m.id
           where m.trip_id = $1 group by m.id, m.name order by m.name`,
          [a.trip_id]
        );

        const data = {
          trip: { id: trip.id, name: trip.name, base_currency: trip.base_currency },
          total_spent_base: totalRow?.total ?? 0,
          expense_count: totalRow?.cnt ?? 0,
          by_pay_method: byMethod,
          by_currency: byCurrency,
          by_schedule: bySchedule.map((r) => ({
            ...r,
            remaining: Math.round((r.planned - r.actual) * 100) / 100,
          })),
          per_member_paid: perMemberPaid,
          per_member_owed: perMemberOwed,
        };
        return ok(
          data,
          `📊 ${trip.name} 총지출 ${(totalRow?.total ?? 0).toLocaleString()} ${trip.base_currency} (${totalRow?.cnt ?? 0}건)`
        );
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  // 8) calculateSettlement ---------------------------------------------------
  server.registerTool(
    "calculateSettlement",
    {
      title: "정산 계산 (N빵/각자)",
      description:
        "[트립머니] 여행 비용을 정산한다. mode=equal(총액 N빵), shares(비용별 기록된 분담 기준), individual(각자 지출 각자 부담). 멤버별 결제액/부담액/순액과 최소 송금 제안을 반환한다.",
      annotations: {
        title: "정산 계산 (N빵/각자)",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        trip_id: z.string(),
        mode: z
          .enum(["equal", "shares", "individual"])
          .default("equal")
          .describe("equal=N빵, shares=분담기록기준, individual=각자부담"),
        trip_key: z.string().optional().describe("보호 여행방의 접근키(전체)"),
        share_token: z.string().optional().describe("읽기 전용 공유 토큰"),
      },
    },
    async (a) => {
      try {
        await requireReadAccess(a.trip_id, a.trip_key ?? a.share_token);
        const trip = await one<{ name: string; base_currency: string }>(
          "select name, base_currency from tripmoney.trips where id = $1",
          [a.trip_id]
        );
        if (!trip) return fail("존재하지 않는 trip_id 입니다.");
        const base = trip.base_currency;
        const members = await q<Member & { bank_name: string | null; account_no: string | null }>(
          "select id, name, bank_name, account_no from tripmoney.members where trip_id = $1 order by created_at",
          [a.trip_id]
        );
        if (members.length === 0) return fail("멤버가 없습니다.");
        const exps = await q<{ id: string; payer_member_id: string | null; amount_base: number }>(
          "select id, payer_member_id, amount_base::float as amount_base from tripmoney.expenses where trip_id = $1",
          [a.trip_id]
        );
        const shares = await q<{ expense_id: string; member_id: string; share_base: number }>(
          `select sh.expense_id, sh.member_id, sh.share_base::float as share_base
           from tripmoney.expense_shares sh join tripmoney.expenses e on e.id = sh.expense_id
           where e.trip_id = $1`,
          [a.trip_id]
        );
        const shareMap = new Map<string, { member_id: string; share_base: number }[]>();
        for (const s of shares) {
          if (!shareMap.has(s.expense_id)) shareMap.set(s.expense_id, []);
          shareMap.get(s.expense_id)!.push({ member_id: s.member_id, share_base: s.share_base });
        }
        const expForCalc: ExpenseForCalc[] = exps.map((e) => ({
          id: e.id,
          payer_member_id: e.payer_member_id,
          amount_base: e.amount_base,
          shares: shareMap.get(e.id) ?? [],
        }));

        const result = calculateSettlement(
          members,
          expForCalc,
          (a.mode ?? "equal") as SettleMode,
          base
        );

        const nameOf = new Map(members.map((m) => [m.id, m.name]));
        const accOf = new Map(members.map((m) => [m.id, m]));
        // 송금 딥링크 + 공유 메시지 (정산 라스트마일)
        const transferViews: SettleTransferView[] = result.transfers.map((t) => {
          const payee = accOf.get(t.to);
          const accStr =
            payee?.bank_name && payee?.account_no
              ? `${payee.bank_name} ${payee.account_no}`
              : null;
          return {
            from: nameOf.get(t.from) ?? t.from,
            to: nameOf.get(t.to) ?? t.to,
            amount: t.amount,
            toss_link: tossSendLink(t.amount, payee),
            kakaopay_link: kakaoPayLink(),
            payee_account: accStr,
          };
        });
        let share_message = settlementMessage(
          trip.name,
          base,
          result.total,
          transferViews
        );
        if (result.excluded.count > 0) {
          share_message += `\n⚠️ 결제자 미지정 지출 ${result.excluded.count}건(${result.excluded.total.toLocaleString()} ${base})은 누가 냈는지 알 수 없어 정산에서 제외됐어요. 해당 비용에 payer_member_id 를 지정하면 정산에 포함됩니다.`;
        }
        const settlement_export = buildSettlementExport({
          tripName: trip.name,
          baseCurrency: base,
          mode: result.mode,
          total: result.total,
          perMember: result.per_member,
          transfers: transferViews,
        });
        const out = { ...result, transfers_detail: transferViews, share_message, settlement_export };
        return ok(out, share_message);
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  // 9) updateExpense ---------------------------------------------------------
  server.registerTool(
    "updateExpense",
    {
      title: "비용 수정",
      description:
        "[트립머니] 기존 비용을 수정한다. 금액/통화/환율이 바뀌면 기준통화 환산액을 재계산하고, 기존 분담(share) 비율을 보존하며 새 금액에 맞춰 재배분한다. viewer 권한은 거부된다.",
      annotations: {
        title: "비용 수정",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        expense_id: z.string(),
        actor_member_id: z.string().optional().describe("수정 주체 멤버 id (권한 검사)"),
        trip_key: z.string().optional().describe("보호 여행방의 접근키"),
        title: z.string().optional(),
        amount: z.number().optional(),
        currency: z.string().optional(),
        exchange_rate: z.number().optional().describe("1 현지통화 = ? 기준통화. 미지정 시 실시간 조회"),
        pay_method: z.enum(["card", "cash"]).optional(),
        payer_member_id: z.string().optional(),
        schedule_id: z.string().optional(),
        note: z.string().optional(),
        spent_at: z.string().optional().describe("지출 시각 ISO8601"),
        expected_updated_at: z
          .string()
          .optional()
          .describe("낙관적 잠금: 마지막으로 읽은 updated_at(ISO). 그 사이 변경됐으면 거부"),
      },
    },
    async (a) => {
      try {
        const tripId = await tripIdOfExpense(a.expense_id);
        await requireTripKey(tripId, a.trip_key);
        await requireWriteRole(a.actor_member_id, tripId);
        const cur = await one<ExpenseRow>(
          "select * from tripmoney.expenses where id = $1",
          [a.expense_id]
        );
        if (!cur) return fail("존재하지 않는 expense_id 입니다.");

        // 금액/통화/환율 변경 시 기준통화 환산 재계산
        const recompute =
          a.amount !== undefined || a.currency !== undefined || a.exchange_rate !== undefined;
        let newBase: number | undefined;
        let newRate: number | undefined;
        let newCurrency: string | undefined;
        if (recompute) {
          const base = await tripBaseCurrency(tripId);
          newCurrency = (a.currency ?? cur.currency).toUpperCase();
          const amt = a.amount ?? Number(cur.amount);
          const r = await toBase(amt, newCurrency, base, a.exchange_rate);
          newBase = r.amount_base;
          newRate = r.exchange_rate;
        }

        await requireExpenseTripRefs(tripId, {
          payer_member_id: a.payer_member_id,
          schedule_id: a.schedule_id,
        });

        // 동적 SET 절 구성 (파라미터화)
        const fields: string[] = [];
        const vals: any[] = [];
        let i = 1;
        const setCol = (col: string, v: any) => {
          fields.push(`${col} = $${i++}`);
          vals.push(v);
        };
        if (a.title !== undefined) setCol("title", a.title);
        if (a.amount !== undefined) setCol("amount", a.amount);
        if (newCurrency !== undefined) setCol("currency", newCurrency);
        if (newRate !== undefined) setCol("exchange_rate", newRate);
        if (newBase !== undefined) setCol("amount_base", newBase);
        if (a.pay_method !== undefined) setCol("pay_method", a.pay_method);
        if (a.payer_member_id !== undefined) setCol("payer_member_id", a.payer_member_id);
        if (a.schedule_id !== undefined) setCol("schedule_id", a.schedule_id);
        if (a.note !== undefined) setCol("note", a.note);
        if (a.spent_at !== undefined) setCol("spent_at", a.spent_at);
        if (fields.length === 0) return fail("수정할 필드가 없습니다.");
        fields.push(`updated_at = now()`);

        vals.push(a.expense_id);
        let where = `id = $${i}`;
        if (a.expected_updated_at) {
          i++;
          vals.push(a.expected_updated_at);
          where += ` and updated_at = $${i}::timestamptz`;
        }
        const exp = await tx(async (db) => {
          const updated = await db.one<ExpenseRow>(
            `update tripmoney.expenses set ${fields.join(", ")} where ${where} returning *`,
            vals
          );
          if (!updated) return null;

          // 금액(amount_base)이 바뀌면 분담을 비율 보존하며 재배분
          if (newBase !== undefined && newBase !== Number(cur.amount_base)) {
            const oldShares = await db.q<{ member_id: string; share_base: number }>(
              "select member_id, share_base::float as share_base from tripmoney.expense_shares where expense_id = $1",
              [a.expense_id]
            );
            const rescaled = rescaleShares(oldShares, newBase);
            for (const s of rescaled) {
              await db.q(
                "update tripmoney.expense_shares set share_base = $3 where expense_id = $1 and member_id = $2",
                [a.expense_id, s.member_id, s.share_base]
              );
            }
          }

          await recordAuditEvent(
            {
              trip_id: tripId,
              actor_member_id: a.actor_member_id ?? null,
              action: "expense.update",
              target_type: "expense",
              target_id: updated.id,
              payload: {
                changed_fields: fields.filter((field) => !field.startsWith("updated_at")).map((field) => field.split(" = ")[0]),
                amount_base_before: cur.amount_base,
                amount_base_after: updated.amount_base,
              },
            },
            db
          );

          return updated;
        });
        if (!exp) {
          if (a.expected_updated_at) {
            const exists = await one<{ updated_at: string }>(
              "select updated_at from tripmoney.expenses where id = $1",
              [a.expense_id]
            );
            if (exists) {
              return fail(
                `충돌: 다른 사용자가 먼저 비용을 수정했습니다(현재 updated_at: ${exists.updated_at}). 최신 내용을 다시 불러온 뒤 시도하세요.`
              );
            }
          }
          return fail("존재하지 않는 expense_id 입니다.");
        }
        return ok({ expense: exp }, `✅ 비용 수정 완료`);
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  // 10) deleteExpense --------------------------------------------------------
  server.registerTool(
    "deleteExpense",
    {
      title: "비용 삭제",
      description:
        "[트립머니] 비용을 삭제한다. 연결된 분담(expense_shares)도 함께 삭제된다(되돌릴 수 없음). viewer 권한은 거부된다.",
      annotations: {
        title: "비용 삭제",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        expense_id: z.string(),
        actor_member_id: z.string().optional().describe("삭제 주체 멤버 id (권한 검사)"),
        trip_key: z.string().optional().describe("보호 여행방의 접근키"),
      },
    },
    async (a) => {
      try {
        const tripId = await tripIdOfExpense(a.expense_id);
        await requireTripKey(tripId, a.trip_key);
        await requireWriteRole(a.actor_member_id, tripId);
        const del = await tx(async (db) => {
          const deleted = await db.one<{ id: string }>(
            "delete from tripmoney.expenses where id = $1 returning id",
            [a.expense_id]
          );
          if (deleted) {
            await recordAuditEvent(
              {
                trip_id: tripId,
                actor_member_id: a.actor_member_id ?? null,
                action: "expense.delete",
                target_type: "expense",
                target_id: deleted.id,
                payload: {},
              },
              db
            );
          }
          return deleted;
        });
        if (!del) return fail("존재하지 않는 expense_id 입니다.");
        return ok({ deleted: del.id }, `🗑️ 비용을 삭제했습니다.`);
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  if (process.env.TRIPMONEY_ENABLE_ITINERARY_RECOMMENDATION === "true") {
    // 11+) recommendItinerary -------------------------------------------------
    // 공모전 재심사 기본 배포에서는 비활성화한다. 기존 승인 버전과 동일한 11개 tool 노출을 유지하기 위함.
    server.registerTool(
      "recommendItinerary",
      {
        title: "AI 여행 일정 추천",
        description:
          "[트립머니] 목적지, 기간, 인원, 취향, 예산 수준을 바탕으로 일정과 일정별 예상 예산을 추천한다. save_to_trip=true 와 trip_id/trip_key 를 함께 주면 추천 일정을 여행방에 바로 저장해 이후 비용 자동귀속·정산 기준으로 사용한다.",
        annotations: {
          title: "AI 여행 일정 추천",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          destination: z.string().describe("여행지/도시"),
          start_date: z.string().optional().describe("시작일 YYYY-MM-DD"),
          end_date: z.string().optional().describe("종료일 YYYY-MM-DD"),
          days: z.number().optional().describe("날짜가 없을 때 사용할 여행 일수"),
          members_count: z.number().default(1).describe("여행 인원"),
          interests: z.array(z.string()).optional().describe("관심사 예: 마사지, 야시장, 카페, 쇼핑"),
          budget_level: z.enum(["budget", "mid", "premium"]).default("mid"),
          pace: z.enum(["relaxed", "balanced", "packed"]).default("balanced"),
          base_currency: z.string().default("KRW"),
          trip_id: z.string().optional().describe("저장할 여행방 id"),
          trip_key: z.string().optional().describe("보호 여행방의 접근키"),
          save_to_trip: z.boolean().default(false).describe("true 면 추천 일정을 addSchedule과 같은 스키마로 저장"),
        },
      },
      async (a) => {
        try {
          const recommendation = recommendTripItinerary(a);
          let saved: ScheduleRow[] = [];
          if (a.save_to_trip) {
            if (!a.trip_id) return fail("save_to_trip=true 이면 trip_id 가 필요합니다.");
            const tripId = a.trip_id;
            await requireTripKey(tripId, a.trip_key);
            saved = await tx(async (db) => {
              const rows: ScheduleRow[] = [];
              for (const item of recommendation.schedules) {
                const row = (await db.one<ScheduleRow>(
                  `insert into tripmoney.schedules(trip_id,title,start_at,end_at,location,planned_budget)
                   values ($1,$2,$3,$4,$5,$6) returning *`,
                  [tripId, item.title, item.start_at, item.end_at, item.location, item.planned_budget]
                ))!;
                rows.push(row);
              }
              await recordAuditEvent(
                {
                  trip_id: tripId,
                  action: "itinerary.recommend.save",
                  target_type: "trip",
                  target_id: tripId,
                  payload: {
                    destination: a.destination,
                    schedules: rows.length,
                    total_budget: recommendation.total_budget,
                  },
                },
                db
              );
              return rows;
            });
          }
          return ok(
            { recommendation, saved_schedules: saved },
            `🧭 ${a.destination} ${recommendation.days}일 일정 ${recommendation.schedules.length}개 추천 · 예상 예산 ${recommendation.total_budget.toLocaleString()} ${recommendation.base_currency}`
          );
        } catch (e: any) {
          return fail(e.message);
        }
      }
    );
  }

  // 11) createShareLink ------------------------------------------------------
  server.registerTool(
    "createShareLink",
    {
      title: "읽기 전용 공유 토큰 발급",
      description:
        "[트립머니] 여행방의 읽기 전용 공유 토큰(share_token)을 발급/회전한다. 이 토큰으로는 getBudgetSummary/calculateSettlement 조회만 가능(수정 불가). trip_key 소유자만 호출 가능. revoke=true 면 토큰을 폐기한다.",
      annotations: {
        title: "읽기 전용 공유 토큰 발급",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        trip_id: z.string(),
        trip_key: z.string().optional().describe("방 접근키(전체 권한) — 보호 방이면 필수"),
        revoke: z.boolean().default(false).describe("true 면 기존 공유 토큰을 폐기"),
      },
    },
    async (a) => {
      try {
        await requireTripKey(a.trip_id, a.trip_key); // 전체 권한 필요 (read-only 토큰으로는 발급 불가)
        if (a.revoke) {
          await tx(async (db) => {
            await db.q("update tripmoney.trips set share_token = null where id = $1", [a.trip_id]);
            await recordAuditEvent(
              {
                trip_id: a.trip_id,
                action: "share_token.revoke",
                target_type: "trip",
                target_id: a.trip_id,
                payload: {},
              },
              db
            );
          });
          return ok({ trip_id: a.trip_id, share_token: null }, "🔌 공유 토큰을 폐기했습니다.");
        }
        const token = "ro_" + crypto.randomUUID().replace(/-/g, "");
        await tx(async (db) => {
          await db.q("update tripmoney.trips set share_token = $2 where id = $1", [a.trip_id, token]);
          await recordAuditEvent(
            {
              trip_id: a.trip_id,
              action: "share_token.create",
              target_type: "trip",
              target_id: a.trip_id,
              payload: { token_prefix: token.slice(0, 8) },
            },
            db
          );
        });
        return ok(
          { trip_id: a.trip_id, share_token: token },
          `🔗 읽기 전용 공유 토큰 발급: ${token}\ngetBudgetSummary/calculateSettlement 에 share_token 으로 전달하면 조회만 가능합니다(수정 불가).`
        );
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  return server;
}
