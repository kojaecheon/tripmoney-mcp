# TripMoney MCP 서버

현재 체험용 진입점은 합성 데이터 전용 MVP다. 실제 고객 데이터 접수나 운영 배포를 승인한 버전은 아니다.

## 체험형 MVP 실행

```bash
npm run mvp
```

접속: [TripMoney MVP](http://127.0.0.1:8123/). 실행 서버는 로컬 컴퓨터에서만 접근할 수 있다.

- 구현 범위: 지출 수정·재계산, 총무 승인, 참여자 승인·이의, 검토 종료·잠금, 새로고침 복원, 샘플 초기화.
- 데이터: 기존 목업의 합성 멤버 5명, 지출 12건. 브라우저에만 저장하며 DB·OCR·결제·외부 공유를 사용하지 않는다.
- 안내: [MVP 사용법](mvp/README.md), [축소 범위와 검증 기록](docs/superpowers/reviews/2026-10-08-tripmoney-experience-mvp-verification.md).
- 기존 서비스: 아래 MCP·웹 데모·배포 설명은 기존 코드 안내다. 인증·개인정보·운영 경로 차단 등 신뢰 기반 작업은 미완료이므로 실제 고객 데이터로 실행하거나 배포하지 않는다.

## 기존 MCP 구현

여행 일정·비용을 공유하고 정산하는 **MCP(Model Context Protocol) 서버**.
PlayMCP / LLM → TripMoney MCP → Supabase(Postgres) 흐름으로 동작한다.

```
사용자 질문 → PlayMCP/LLM → TripMoney MCP(Vercel) → 일정·비용·정산 실행 → Supabase → 결과 반환
```

## 핵심 11종 Tool

| Tool | 역할 |
|---|---|
| `createTrip` | 여행방 생성 (기준통화·기간·초기멤버, trip_key 자동 발급) |
| `addMember` | 멤버 추가 (role: owner/editor=수정가능, viewer=조회) |
| `addSchedule` | 일정 등록 (일정별 예산 포함) |
| `updateSchedule` | 일정 수정 (viewer 권한 거부, 낙관적 잠금 지원) |
| `addExpense` | 비용 직접 등록 (현지통화→한화 실시간 환산, 카드/현금, N빵/커스텀 분담) |
| `updateExpense` | 비용 수정 (금액 변경 시 환산 재계산 + 분담 비율 보존 재배분, 낙관적 잠금) |
| `deleteExpense` | 비용 삭제 (분담 cascade 삭제) |
| `scanReceipt` | 영수증 기반 비용 등록 (시간 기반 일정 자동귀속, OCR은 파싱값 전달) |
| `getBudgetSummary` | 예산/지출 요약 (총액·결제수단별·통화별·일정별·멤버별) |
| `calculateSettlement` | 정산 (equal=N빵 / shares=분담기록 / individual=각자부담 + 최소 송금 제안) |
| `createShareLink` | 읽기 전용 공유 토큰 발급/회전/폐기 |

## 아키텍처

- **런타임**: Vercel 서버리스 함수 (TypeScript, Node 20+)
- **프로토콜**: MCP Streamable HTTP, stateless 모드
- **DB**: Supabase Postgres, 전용 `tripmoney` 스키마 (기존 데이터와 격리)
- **인증**: `x-api-key` 헤더 (PlayMCP Key/Token 인증과 호환)
- **환율**: open.er-api.com 무료 API + 메모리 캐시 (또는 `exchange_rate` 직접 전달)

```
api/mcp.ts        엔드포인트 (인증 + Streamable HTTP 핸들러)
api/beta.ts       공개 베타 신청 저장 API
api/health.ts     상태 점검 (/health)
lib/server.ts     MCP 서버 + 11종 Tool 정의
lib/db.ts         Postgres(pg) 연결
lib/fx.ts         환율 변환
lib/settlement.ts 정산 로직 (순수 함수)
lib/settlementExport.ts 카톡/CSV/정산카드 내보내기 생성
supabase/migrations/0001_init.sql  스키마 DDL (적용 완료)
```

## 배포 (Vercel)

> 코드의 Supabase 스키마(`tripmoney`)는 이미 적용 완료된 상태다. 아래는 서버 배포 + 등록 절차.

### 1. 환경변수 2개 준비

**`DATABASE_URL`** — Supabase 대시보드 → Project Settings → Database → Connection string → **Transaction pooler** 의 문자열을 복사하고 `[YOUR-PASSWORD]` 를 실제 DB 비밀번호로 채운다.
```
postgresql://postgres.fjgwjmjjfpaldxnkhwbd:비밀번호@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```
(프로젝트 ref: `fjgwjmjjfpaldxnkhwbd` / 리전: us-east-1 — 실제 문자열은 대시보드에서 복사)

**`TRIPMONEY_API_KEY`** — 임의의 강한 문자열. PlayMCP 에 `x-api-key` 값으로 등록할 키.

### 2. 배포

```bash
npm i -g vercel
vercel            # 첫 배포 (프로젝트 연결)
vercel env add DATABASE_URL production
vercel env add TRIPMONEY_API_KEY production
vercel --prod     # 프로덕션 배포
```

배포 후 엔드포인트:
- MCP: `https://<your-app>.vercel.app/mcp`
- 상태점검: `https://<your-app>.vercel.app/health` 또는 `/api/health`

### 3. PlayMCP 등록

| 항목 | 입력값 |
|---|---|
| 인증 방식 | Key/Token 인증 |
| 필드명 | `x-api-key` |
| 필드 설명 | TripMoney API 인증키 |
| MCP Endpoint | `https://<your-app>.vercel.app/mcp` |

## 로컬 개발/테스트

```bash
npm install
npm run typecheck            # 타입 검사
npm test                    # 정산 로직 단위 테스트
npx tsx test/mcp.smoke.ts   # MCP tools/list 스모크 테스트 (DB 불필요)
npm run dev                 # DB 없이 mock 데이터로 웹 프로토타입 실행
npm run prototype           # DB 없이 mock 데이터로 웹 프로토타입 실행
npm run vercel:dev          # Vercel 서버리스 런타임으로 실행 (.env 필요)
```

`.env` (로컬):
```
DATABASE_URL=postgresql://...
TRIPMONEY_API_KEY=dev-key
TRIPMONEY_PROTOTYPE_MODE=mock      # DB 없이 / 또는 /prototype 대시보드 시연
TRIPMONEY_WEB_DEMO_KEY=optional    # 웹 데모 API 보호가 필요할 때만 설정
```

웹/베타 표면:
- 로컬: `npm run prototype` 후 `http://127.0.0.1:3000/`
- `/` 은 유료 베타 랜딩 페이지(`public/index.html`)로 연결된다.
- `/` 의 베타 신청 폼은 `/api/beta` 로 저장되며, 이름/연락처/여행 규모/가격 관심도를 기록한다.
- `/prototype` 은 운영자/데모 대시보드(`public/app.html`)로 연결된다.
- `/prototype` 의 `+ 새 여행`은 여행명, 기준통화, 멤버/은행/계좌를 한 번에 입력한다.
- 개요 탭에서 기존 여행에 멤버/계좌를 추가할 수 있다. 추가 멤버는 이후 비용부터 기본 N빵에 포함된다.
- `/prototype` 비용 탭의 영수증 리뷰 흐름은 `receiptDraft` 로 초안을 만들고, 운영자가
  가맹점·금액·통화·결제자·일정 매칭을 확인한 뒤 `confirmReceipt` 로 저장한다.
- `DATABASE_URL` 이 없거나 `TRIPMONEY_PROTOTYPE_MODE=mock` 이면 샘플 여행 데이터로 동작하고,
  `DATABASE_URL` 이 있으면 Supabase `tripmoney` 스키마를 사용한다.

배포 후 동작 확인(예):
```bash
curl -s https://<app>.vercel.app/health

curl -s https://<app>.vercel.app/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "x-api-key: <키>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`/health` 는 비밀값을 노출하지 않고 `DATABASE_URL`, `TRIPMONEY_API_KEY`,
`TRIPMONEY_WEB_DEMO_KEY`, mock prototype mode, 필수 `tripmoney` 테이블/컬럼 준비 상태를
`ok`/`warn`/`error` 로 반환한다. `error` 가 있으면 HTTP 503 으로 응답한다.

## 사용 예시 흐름

1. `createTrip(name:"방콕 3박", base_currency:"KRW", members:[{name:"민수",role:"owner"},{name:"지영"},{name:"현우"}])`
2. `addSchedule(trip_id, title:"오아시스 스파", start_at, end_at, planned_budget:100000)`
3. `addExpense(trip_id, title:"스파", amount:2000, currency:"THB", payer_member_id:민수, pay_method:"card")`
   → 환율 자동조회로 한화 환산 + 전원 N빵 분담 생성
4. `scanReceipt(trip_id, receipt_url, amount:300, currency:"THB", spent_at)`
   → 시간대에 맞는 진행중 일정에 자동 귀속
5. `getBudgetSummary(trip_id)` → 예산 대비 지출 현황
6. `calculateSettlement(trip_id, mode:"equal")` → N빵 정산 + "누가 누구에게 얼마" 송금 제안 + 카톡/CSV/정산카드 내보내기

## 데이터 모델 (tripmoney 스키마)

- `trips` 여행방 · `members` 멤버(role 권한) · `schedules` 일정(예산)
- `expenses` 비용(현지금액+환율+한화환산, 카드/현금, source) · `expense_shares` 멤버별 분담
- 송금 딥링크용 `members.bank_name`, `members.account_no` 는 `supabase/migrations/0002_prototype_ready.sql` 에 포함되어 있다.
- 유료 베타 신뢰를 위한 변경 이력 `audit_events` 는 `supabase/migrations/0006_audit_events.sql` 에 포함되어 있다.
- 유료 베타 신청/전환 추적용 `beta_leads` 는 `supabase/migrations/0007_beta_leads.sql` 에 포함되어 있다.

## 고도화 기능 (구현됨)

**1. 영수증 OCR (네이버 CLOVA)** — `CLOVA_OCR_INVOKE_URL`, `CLOVA_OCR_SECRET` 설정 시 `scanReceipt` 가
amount 없이 영수증 이미지에서 금액·가맹점·일자를 자동 추출. 미설정 시 수동 입력으로 폴백.
(NCP 콘솔 → CLOVA OCR → 영수증 도메인 생성 → Invoke URL / Secret Key)

웹 운영자 콘솔은 실제 저장 전에 `receiptDraft` 로 초안을 보여주고 `confirmReceipt` 에서만
비용을 저장한다. 유료 베타에서는 OCR 결과를 사람이 확인한 뒤 정산에 반영하는 흐름을 기본으로 둔다.

**2. 방 단위 접근키 (보안)** — `createTrip` 시 **모든 여행방에 `trip_key` 자동 발급**(기본 보호).
이후 그 여행방의 모든 조회·수정 툴 호출에 `trip_key` 일치 필요(불일치 시 차단). 여행방별 데이터 격리.
생성 시 1회 반환되는 키를 보관해야 하며, 분실 시 복구 불가. (웹 운영자 콘솔 `/api/web` 은
`TRIPMONEY_WEB_DEMO_KEY` 로 보호되는 별도의 특권 뷰로, trip_key 없이 전체 조회가 가능하다.)

  - **읽기 전용 공유 토큰** — `createShareLink` 로 `share_token` 발급/회전/폐기(`revoke:true`).
    이 토큰은 `getBudgetSummary`/`calculateSettlement` **조회만** 허용(수정 불가). 정산 결과를
    동행에게 공유할 때 trip_key(전체 권한) 대신 안전하게 전달. (마이그레이션 `0004`)

**3. 송금 딥링크 정산 (라스트마일)** — 멤버 `bank_name`/`account_no` 등록 시
`calculateSettlement` 결과에 토스 송금 딥링크(`supertoss://send?...`)와
카톡 공유용 정산 메시지(`share_message`)를 함께 반환.

**4. 정산 내보내기 (유료 베타 라스트마일)** — `calculateSettlement` 와 웹 정산 API는
`settlement_export` 를 함께 반환한다.

- `kakao_text`: 카카오톡 단체방에 바로 붙여넣는 최종 정산문
- `csv`: 멤버별 paid/owed/net 과 송금 제안을 담은 CSV
- `card`: 화면에서 정산카드처럼 보여줄 수 있는 요약 payload

웹 프로토타입 `/prototype` 의 정산 탭에서도 `카톡문구 복사`, `CSV 저장`, `정산카드 보기`를 제공한다.

**5. 베타 신청/전환 추적** — 랜딩의 신청 폼은 공개 `/api/beta` 로 저장된다.
운영자 콘솔 `/prototype` 의 `베타 지표`에서 신청 수, 최근 7일 신청, 최근 신청 목록을 확인할 수 있다.
DB가 없는 mock 모드에서는 메모리에 저장되어 로컬 데모가 가능하고, 운영에서는 `beta_leads` 테이블을 사용한다.

### 추가 환경변수 (선택)
```
CLOVA_OCR_INVOKE_URL=...   # 네이버 CLOVA OCR 영수증 도메인 Invoke URL
CLOVA_OCR_SECRET=...       # X-OCR-SECRET 값
```

## 다음 고도화 (옵션)

- GPS/Geofencing 기반 일정 자동매칭 정밀화 (현재는 시간 기반)
- 카카오페이 계좌 프리필(공개 스킴 제약) / 페이팔·트래블월렛 해외 정산 연동
- Postgres RLS 정책 + 멀티테넌시 강화
