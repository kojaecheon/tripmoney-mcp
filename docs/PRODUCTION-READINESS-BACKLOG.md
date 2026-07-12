# TripMoney Production Readiness Backlog

Date: 2026-06-29

This backlog turns the current alpha into something safe enough to use with real travel groups and early paid beta customers.

## P0: Must Fix Before Real Money Trips

### 1. Same-Trip Data Validation — Done

Problem:

- `payer_member_id`, `split_member_ids`, `custom_shares.member_id`, and explicit `schedule_id` can reference rows from another trip if the UUID is known.
- Postgres foreign keys only prove the referenced row exists; they do not prove it belongs to the same trip.

Required behavior:

- When adding or updating an expense:
  - `payer_member_id` must be null or belong to the expense trip.
  - `schedule_id` must be null or belong to the expense trip.
  - every `split_member_ids[]` item must belong to the trip.
  - every `custom_shares[].member_id` must belong to the trip.
- `custom_shares` total should equal `amount_base` or the API must explicitly return a warning/error.

Evidence:

- `lib/validation.ts` validates payer, schedule, split members, custom-share members, and custom-share total.
- `lib/server.ts` applies the validation to MCP expense create/update paths.
- `api/web.ts` applies the same validation to operator expense create/update paths.
- `test/logic.test.ts` includes pure tests proving cross-trip references and bad custom totals are rejected.
- `npm run typecheck`, `npm test`, and `npm run smoke:mcp` should pass before release.

### 2. DB Transactions for Money-Changing Flows — Done

Problem:

- Expense insert/update/delete and share writes are multi-query flows.
- A partial failure can leave an expense without correct shares.

Required behavior:

- Add `tx()` helper in `lib/db.ts`.
- Use one transaction for:
  - `addExpense`
  - `scanReceipt` once it inserts
  - `updateExpense`
  - `deleteExpense`
  - web operator expense create/update/delete

Evidence:

- `lib/db.ts` exposes `tx(fn)` with `begin`/`commit`/`rollback` and a single `DbRunner`.
- MCP `insertExpense` wraps expense insert + share creation in one transaction.
- MCP `updateExpense` wraps expense update + share rescale writes in one transaction.
- MCP `deleteExpense` uses the transaction helper.
- Web operator expense create/update/delete use the same transaction helper.
- `npm run typecheck`, `npm test`, and `npm run smoke:mcp` should pass before release.

### 3. Audit Log — Done

Problem:

- Money-changing actions need traceability.

Required behavior:

- Add `tripmoney.audit_events`:
  - id
  - trip_id
  - actor_member_id
  - action
  - target_type
  - target_id
  - payload jsonb
  - created_at
- Write audit events for:
  - add/update/delete expense
  - add/update schedule
  - add member
  - create/revoke share token

Evidence:

- Migration `supabase/migrations/0006_audit_events.sql` creates `tripmoney.audit_events` and useful indexes.
- `lib/audit.ts` provides `recordAuditEvent()` for MCP and web paths.
- MCP writes audit rows for member add, schedule add/update, expense add/update/delete, and share token create/revoke.
- Web operator expense create/update/delete writes audit rows with `payload.surface = "web"`.
- Money-changing audit rows are written inside the same transaction as the data mutation where the mutation already uses `tx()`.
- `npm run typecheck`, `npm test`, and `npm run smoke:mcp` should pass before release.

### 4. Production Env Guard — Done

Problem:

- Running production without keys or migrations is dangerous.

Required behavior:

- `/health` should expose safe readiness flags:
  - database configured
  - api key configured
  - web demo key configured
  - prototype mode off/on
- Do not expose secrets.

Evidence:

- `lib/readiness.ts` returns a structured readiness report without exposing secret values.
- `api/health.ts` returns the report and uses HTTP 503 when any `error` check exists.
- `scripts/prototype-server.mjs` exposes the same `/api/health` and `/health` shape in local prototype mode.
- Checks cover `DATABASE_URL`, `TRIPMONEY_API_KEY`, `TRIPMONEY_WEB_DEMO_KEY`, mock prototype mode, required `tripmoney` tables, and required migration columns.
- `npm run typecheck`, `npm test`, and `npm run smoke:mcp` should pass before release.

## P1: Needed for Paid Concierge Beta

### 5. Landing Page — Done

Required behavior:

- Replace or supplement prototype dashboard with a simple public landing page.
- Offer:
  - "여행 총무 AI"
  - "영수증 보내면 정산문까지"
  - beta price/contact CTA
- Keep dashboard behind `/prototype` or `/dashboard`.

Evidence:

- `public/index.html` is the public paid beta landing page.
- `vercel.json` routes `/` to `index.html` and `/prototype` to `app.html`.
- `scripts/prototype-server.mjs` mirrors the same split locally.
- README documents the landing/prototype split.

### 6. Operator Flow — Done

Required behavior:

- Operator can create trip, add members/accounts, add expenses, edit/delete, and export settlement.
- Web operator should require `TRIPMONEY_WEB_DEMO_KEY` in production.

Evidence:

- Manual beta can be run without MCP client.
- Web `createTrip` accepts trip name, base currency, and multiple initial members with bank/account fields.
- Web `createTrip` writes trip + members in one transaction and records `member.add` audit events.
- Web `addMember` lets the operator add member/account details to an existing trip.
- Mock prototype mode mirrors both `createTrip` and `addMember`, so the flow can be demoed without a DB.
- `public/app.html` has a structured "새 여행 만들기" modal with multiline member/account paste input.
- `public/app.html` overview tab has a "멤버/계좌 추가" form.
- Existing operator expense create, edit/delete, receipt review, and settlement export flows cover the rest of the required manual beta path.
- Verified with `npm run typecheck`, `npm test`, `npm run smoke:mcp`, and local prototype curl checks for member/account trip creation and existing-trip member addition.

### 7. Settlement Export — Done

Required behavior:

- Add export formats:
  - Kakao text
  - CSV
  - image/card screenshot-style summary

Evidence:

- Organizer can send final result to group without editing raw JSON.
- `lib/settlementExport.ts` builds Kakao-ready text, CSV, and screenshot-card data from one shared settlement result.
- MCP `calculateSettlement` returns `settlement_export` alongside the existing `share_message`.
- Web `/api/web?action=settle` and mock prototype mode return the same `settlement_export` contract.
- `public/app.html` exposes "카톡문구 복사", "CSV 저장", and "정산카드 보기" actions in the settlement tab.
- `test/logic.test.ts` covers export text, CSV, and card payload generation.
- Verified with `npm run typecheck`, `npm test`, `npm run smoke:mcp`, and local prototype curl checks for `settlement_export`.

### 8. Receipt Review — Done

Required behavior:

- OCR output should be reviewable before saving:
  - merchant
  - amount
  - currency
  - spent_at
  - schedule match

Evidence:

- No OCR-derived expense is committed without confirm path in user-facing flow.
- Web operator API has `receiptDraft` for review-only parsing and schedule matching before any expense insert.
- Web operator API has `confirmReceipt` for the explicit reviewed save path; it writes `source='receipt'`, creates equal shares, and records an audit event in the same transaction.
- Mock prototype mode mirrors `receiptDraft` and `confirmReceipt`, so paid beta demos work without a DB or OCR engine.
- `public/app.html` now has a "영수증 리뷰" flow in the expense tab with editable merchant, amount, currency, payer, schedule, and spent-at fields before saving.
- Verified with `npm run typecheck`, `npm test`, `npm run smoke:mcp`, and local prototype curl checks for draft generation and confirmed receipt insertion.

### 8.5. Beta Intake Funnel — Done

Required behavior:

- Landing page should capture paid beta intent without relying only on email client behavior.
- Store contact, trip context, group size, customer segment, and price interest.
- Operator can see whether applications are coming in.

Evidence:

- Migration `supabase/migrations/0007_beta_leads.sql` creates `tripmoney.beta_leads` for public paid-beta applications.
- `api/beta.ts` accepts public POST submissions with honeypot spam protection and stores them through `lib/betaLeads.ts`.
- `public/index.html` now has an in-page paid beta application form posting to `/api/beta`.
- `api/web.ts?action=metrics` and mock prototype mode expose trip/member/expense counts plus beta lead stats.
- `public/app.html` has a "베타 지표" operator modal with total leads, recent 7-day leads, and recent application rows.
- `lib/readiness.ts` includes `beta_leads` in required production tables.
- Verified with `npm run typecheck`, `npm test`, `npm run smoke:mcp`, and local prototype curl checks for `/api/beta` submission and `/api/web?action=metrics` aggregation.

## P2: Growth and Defensibility

### 9. Chat Surface

Options:

- KakaoTalk channel integration if feasible.
- Telegram/Discord bot as faster proof.
- Web chat as fallback.

Goal:

- Organizer can run the trip without MCP developer tooling.

### 10. Invite and Role Model

Required behavior:

- Owner can invite members.
- Viewer/editor roles must be enforced without relying on optional actor IDs.

### 11. Persistent FX Cache

Required behavior:

- Store rates in DB or managed KV.
- Use stale rates with visible warning.

### 12. Metrics

Track:

- trips created
- expenses per trip
- receipt OCR success rate
- settlement generated
- settlement shared/exported
- paid conversions

Current coverage:

- `api/web?action=metrics` tracks total trips, members, expenses, spend, beta leads, recent 7-day leads, lead status, and price-interest distribution.
- Remaining deeper product analytics: receipt OCR success rate, settlement generated/shared events, and paid status lifecycle.

## Current Verification Commands

Run before each release:

```bash
npm run typecheck
npm test
npm run smoke:mcp
```

Current state on 2026-06-29:

- `npm run typecheck`: pass
- `npm test`: pass, 38/38
- `npm run smoke:mcp`: pass, 11 tools
