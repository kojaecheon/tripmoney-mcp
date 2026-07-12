# TripMoney Product Strategy

Date: 2026-06-29

## Decision

TripMoney should not position itself as another generic travel expense app.

The strongest wedge is:

> A Korean-first AI travel treasurer that lives in chat and turns receipts, itinerary context, exchange rates, and settlement into one guided workflow.

The product should win the first paying users by making one person radically more effective: the trip organizer who currently manages money through KakaoTalk, screenshots, notes, spreadsheets, banking apps, and memory.

## Current Product Reality

What exists now:

- MCP server with 11 tools:
  - `createTrip`
  - `addMember`
  - `addSchedule`
  - `updateSchedule`
  - `addExpense`
  - `updateExpense`
  - `deleteExpense`
  - `scanReceipt`
  - `getBudgetSummary`
  - `calculateSettlement`
  - `createShareLink`
- Supabase schema with trip protection, share tokens, expense updates, and settlement shares.
- Web prototype for demo and operator use.
- Settlement logic with rounding-safe equal splits and proportional share rescaling.
- OCR, exchange-rate conversion, Toss deeplink, Kakao share-message primitives.

What is not proven yet:

- That travelers will pay directly.
- That trip organizers trust an AI/MCP tool with real settlement.
- That receipt OCR accuracy is good enough in real travel conditions.
- That the workflow beats the status quo quickly enough to overcome setup friction.

## Customer Wedge

Primary ICP:

- Korean-speaking trip organizer for a 3-8 person overseas trip.
- Usually one person in the group becomes the "총무".
- They use KakaoTalk heavily.
- They deal with foreign currency, card/cash mix, receipts, partial participation, and last-day settlement.

Initial user segment to avoid:

- Solo travelers.
- Domestic-only simple N-bang groups.
- People already happy with Splitwise.
- Enterprise travel managers.

The first paid wedge should be groups where the organizer has a real reputational burden:

- Friend-group overseas trips.
- University club trips.
- Company workshop / offsite organizers.
- Creator-led group trips.
- Small travel agency package coordinators.

## Paid Offer

Do not start with a broad SaaS subscription.

Start with a simple paid service:

### TripMoney Concierge Beta

Offer:

- "Send us your trip members, itinerary, and receipts. TripMoney gives you a live settlement board and a final Kakao-ready settlement message."
- Price test:
  - Personal trip: KRW 4,900-9,900 per trip.
  - Organizer/agency/offsite: KRW 29,000-99,000 per trip depending on group size.

Why this works:

- It tests willingness to pay before building a full consumer app.
- It lets the team observe real receipts and real settlement edge cases.
- It creates examples, testimonials, and product data.

Revenue hypothesis:

- Consumers may resist another subscription.
- Organizers will pay per trip when the pain is acute.
- B2B-ish organizers are more attractive than casual travelers because they repeat.

## Positioning

Bad positioning:

- "Splitwise for Korea"
- "Travel budget app"
- "AI itinerary and expense management platform"

Better positioning:

- "여행 총무 AI"
- "영수증만 보내면 여행비 정산문까지"
- "카톡방 여행비 총무를 대신하는 MCP"

Core promise:

> 여행 중 비용을 말하거나 영수증을 보내면, 일정에 자동으로 붙고, 환율이 반영되고, 마지막에 누가 누구에게 얼마 보낼지 카톡 문구까지 나온다.

## Competitive View

Competitors by category:

- Splitwise: strong settlement graph, currency, receipt features, global brand.
- Wanderlog: strong itinerary collaboration and trip planning.
- TravelSpend: strong travel budgeting, currencies, travel expense tracking.
- Korean status quo: KakaoTalk + bank transfers + notes + spreadsheets.

TripMoney cannot beat mature apps feature-by-feature at launch.

TripMoney can win if it owns this wedge:

- Korean-first messaging and payment last mile.
- Chat-native execution through MCP.
- Itinerary-context-aware expense capture.
- "총무 assistant" framing rather than "expense database" framing.

The status quo is the real competitor. The product must make the first useful result happen in under 3 minutes.

## Product Roadmap

### Phase 0: Trustworthy Alpha

Goal:

- Make the current prototype safe enough for real friends/family trips.

Must ship:

- Enforce same-trip validation for schedule, payer, split members, and custom shares.
- Wrap expense creation/update/delete plus share writes in DB transactions.
- Require actor identity for role-based writes if roles are product-visible.
- Add audit log for money-changing actions.
- Add operator checklist for migrations and env vars.

Success:

- 3 real trips can use it without manual DB repair.

### Phase 1: Concierge Beta

Goal:

- Validate demand and willingness to pay.

Must ship:

- Landing page with one offer and payment/contact CTA.
- Kakao-friendly onboarding instructions.
- Receipt upload or receipt URL workflow that does not require technical users.
- Admin workflow for creating trips and returning share links.
- Final settlement export: Kakao text, CSV, image/card.

Success:

- 10 real trips processed.
- At least 3 paid, even if manually serviced.
- At least 2 users say they would be upset if it disappeared.

### Phase 2: Chat-Native Product

Goal:

- Reduce manual concierge work and make MCP the core automation layer.

Must ship:

- Kakao/Telegram/Discord-style bot surface or a clean web chat surface.
- "Forward receipt image" flow.
- Natural language expense correction.
- Invite/share flow for members.
- Better OCR review screen.

Success:

- Organizer can complete trip setup without developer help.
- More than 70% of expenses are captured during the trip, not after.

### Phase 3: Repeatable Revenue

Goal:

- Find repeatable acquisition and revenue.

Possible channels:

- Travel creators and group-trip hosts.
- University clubs.
- Small agencies.
- Corporate workshop organizers.
- Travel community partnerships.

Pricing tests:

- Per trip.
- Per organizer monthly.
- White-label for agencies.
- Paid OCR/settlement pack.

## Next 14 Days

### Product

- Choose the first ICP: friend trip organizer or small group-trip organizer.
- Create one-page landing copy.
- Define one paid offer and price.
- Recruit 5 beta trips manually.

### Engineering

- Fix same-trip validation.
- Add DB transaction helper.
- Add audit log migration and writes.
- Add a simple trip setup checklist.
- Keep MCP as the system of record; keep web as demo/operator surface.

### Sales

- Send 20 direct messages to likely organizers.
- Ask for a real upcoming trip, not general feedback.
- Offer to run settlement for one trip at a beta price.

## Hard Questions

Before investing months, answer these with evidence:

1. Who paid or seriously attempted to pay?
2. Which moment made them say "this saves me"?
3. What did they do before TripMoney?
4. Did they use it during the trip or only after?
5. Did they trust OCR output without checking?
6. Did they share the settlement result with the group?
7. Would they use it again next trip?

## Kill Criteria

Stop or pivot if:

- 10 real target users try it and none will pay per trip.
- Users only want it after the trip, but setup friction is too high.
- OCR correction takes more effort than manual entry.
- The Kakao/payment last mile does not materially improve completion.

## Recommended Immediate Path

Do not build a large app yet.

Build:

- Trustworthy MCP core.
- Operator-friendly dashboard.
- Concierge beta landing page.
- Kakao-ready settlement output.

Then sell manually before automating more.
