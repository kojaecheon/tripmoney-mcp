// tripmoney 스키마 DB 행 타입.
// 주의: node-postgres(pg)는 numeric/timestamptz 를 기본적으로 문자열로 반환한다.
//  - 숫자 계산이 필요한 조회는 SELECT 에서 ::float 로 캐스팅한다(그 결과는 number).
//  - 아래 타입은 "전체 행/RETURNING *" 형태의 표준 행을 표현한다(numeric=문자열).
//    별칭·캐스팅 projection 은 호출부에서 별도 결과 타입을 쓴다.

export type Role = "owner" | "editor" | "viewer";
export type ScheduleStatus = "planned" | "ongoing" | "done" | "canceled";
export type PayMethod = "card" | "cash";
export type ExpenseSource = "manual" | "receipt";

export interface TripRow {
  id: string;
  name: string;
  base_currency: string;
  start_date: string | null;
  end_date: string | null;
  api_key: string | null; // 방 접근키(trip_key)
  share_token: string | null; // 읽기 전용 공유 토큰 (0004)
  created_at: string;
}

export interface MemberRow {
  id: string;
  trip_id: string;
  name: string;
  role: Role;
  bank_name: string | null; // 0002
  account_no: string | null; // 0002
  created_at: string;
}

export interface ScheduleRow {
  id: string;
  trip_id: string;
  title: string;
  start_at: string | null;
  end_at: string | null;
  location: string | null;
  lat: number | null;
  lng: number | null;
  planned_budget: string | null; // numeric → 문자열
  status: ScheduleStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExpenseRow {
  id: string;
  trip_id: string;
  schedule_id: string | null;
  payer_member_id: string | null;
  title: string;
  amount: string; // numeric → 문자열
  currency: string;
  exchange_rate: string; // numeric → 문자열
  amount_base: string; // numeric → 문자열
  pay_method: PayMethod;
  receipt_url: string | null;
  source: ExpenseSource;
  note: string | null;
  spent_at: string;
  created_at: string;
  updated_at: string; // 0005
}

export interface ExpenseShareRow {
  id: string;
  expense_id: string;
  member_id: string;
  share_base: string; // numeric → 문자열
}

export interface AuditEventRow {
  id: string;
  trip_id: string | null;
  actor_member_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}
