# TripMoney — 소스 검토 & 디자인 개선 리포트 (PDCA Check → Act)

- **일자**: 2026-06-29
- **대상**: TripMoney MCP 서버 (여행 일정·비용 공유/정산)
- **범위**: ① bkit 소스 검토(보안·품질·성능) ② 프런트 디자인 개선 ③ 후속 수정(보안 핫픽스·방 격리·정산 정확성·DRY)
- **검증**: `npm run typecheck` 통과 · `npm test` **16/16 통과**

---

## 1. Check — 소스 검토 결과 (bkit)

SQL은 파라미터화가 잘 되어 injection 위험은 낮음. 최대 부채는 **권한 모델이 강제력 없는 advisory 구조**였음.

### 🔴 Critical
| # | 이슈 | 위치 |
|---|---|---|
| C1 | `requireWriteRole`가 actor 미전달 시 스킵 + trip 소속 미검증 → 다른 방 멤버 id 도용 가능 | `lib/server.ts` |
| C2 | 비보호 방(기본값)은 `trip_id`만 알면 누구나 조회·수정. service-role 접속이라 RLS도 무력 | `supabase/migrations/0001` |
| C3 | 인증 키 미설정 시 fail-open(전면 개방) | `api/mcp.ts`, `api/web.ts` |
| C4 | `scanReceipt`의 `receipt_url`을 검증 없이 OCR이 fetch → SSRF | `lib/ocr.ts`, `lib/server.ts` |

### 🟡 Major / 🟢 Minor
- **M1** equal 정산 라운딩 잔차(100÷3=33.33×3=99.99) — 합계 불일치
- **M4** "최소 송금"은 NP-hard 근사(그리디) — 표현 부정확
- **M2** 환율 캐시 콜드스타트·외부 장애 시 `addExpense` 전체 실패
- **M3** 환율/OCR/DB 응답 `any` 남용 (타입 안정성)
- **M5** `updateSchedule` 동시성 낙관적 잠금 없음(last-write-wins)
- **Minor** `api/web.ts`/`prototypeStore.ts`가 expense·settle·toss 로직을 재구현(DRY 위반), CORS `*`

---

## 2. Act — 적용한 수정

### A. 보안 핫픽스
| # | 수정 | 결과 |
|---|---|---|
| **C3** | 키 미설정 시 **프로덕션 fail-closed**(`NODE_ENV!=='production'`만 통과) | `api/mcp.ts`, `api/web.ts` |
| **C1** | `requireWriteRole(actorId, **tripId**)` — `where id=$1 and trip_id=$2`로 방 소속까지 검증 | `lib/server.ts` |
| **C4** | OCR fetch 직전 `assertSafeImageUrl()` — https 강제 + 사설/루프백/169.254.169.254 차단 | `lib/ocr.ts` |
| **C2 (ⓐ 선택)** | `createTrip` 시 **모든 방에 `trip_key` 기본 발급**. 마이그레이션 `0003`로 `api_key` 기본값+backfill+NOT NULL. 읽기·쓰기 모든 도구가 이미 `requireTripKey` 호출 → 전면 격리 | `lib/server.ts`, `supabase/migrations/0003` |

> **테넌시 결정**: 웹 `/api/web`은 `TRIPMONEY_WEB_DEMO_KEY`로 보호되는 **운영자 콘솔(특권 뷰)**로 의도적으로 trip_key를 우회. 멀티테넌트 격리는 **MCP 표면(trip_key)**에서 강제. (`api/web.ts`, `README.md`에 명시)

### B. 프런트 디자인 개편 (`public/app.html`)
"여행 정산 = 탑승권(boarding pass)" 정체성으로 재설계.
- 정산을 **첫 탭(히어로)**으로 승격, 송금을 **절취선·노치 보딩패스**로 표현(구간/운임/토스 버튼)
- Space Grotesk + Space Mono, 모든 금액 `tabular-nums`
- `prompt()`/`alert()` 전면 제거 → 인라인 모달 + 토스트 + 공유 미리보기
- 예산 미터 경고/초과 색, 방향형 빈 상태 카피
- 접근성: `:focus-visible`, `prefers-reduced-motion`, 시맨틱 `<button>`, 모바일 스텁 가로 스크롤
- 검증: 프리뷰 스크린샷으로 보딩패스·순액·모달 동작 확인

### C. 정산 정확성 + DRY
- **M1**: `splitEqually()`(largest-remainder)를 `lib/settlement.ts`에 추가 → 잔차를 앞쪽 멤버에 1센트씩 배분, 합계 = total 보장
- **DRY**: N빵 분배(`splitEqually`)와 토스 딥링크(`lib/links.tossSendLink`)를 `server.ts`·`web.ts`·`prototypeStore.ts` **3중 사본 → 단일 출처**로 통합
- **M4**: 그리디 주석을 "휴리스틱(최적해 아님)"으로 정정

### D. 견고성 (2차 적용)
| # | 수정 | 위치 |
|---|---|---|
| **M2** | 환율 외부 API 장애 시 **만료된 캐시로 graceful degradation**(throw 대신 폴백), 폴백 없으면 수동 환율 안내 메시지 | `lib/fx.ts` |
| **M3** | 외부 응답을 **zod 검증** — 환율(`ErApiResponse`)·CLOVA 봉투/fields(`ClovaResponse`)에서 `any` 직접 접근 제거 | `lib/fx.ts`, `lib/ocr.ts` |
| **M5** | `updateSchedule`에 **낙관적 잠금**(`expected_updated_at`) — 그 사이 변경 시 충돌로 거부(미존재와 구분) | `lib/server.ts` |

- 테스트: M1 4건 + M2 4건 추가 → **총 20/20 통과**

### E. 확장 (3차 적용)
| 항목 | 내용 | 위치 |
|---|---|---|
| **DB 행 타입화** | `lib/types.ts` 신설(TripRow/MemberRow/ScheduleRow/ExpenseRow/ExpenseShareRow). `server.ts`·`web.ts`의 `RETURNING *`·전체행·정산 조회 `<any>` → 타입 적용(`strict` 하 insert는 non-null 단언). pg numeric=문자열 주의 반영, `::float` projection은 인라인 타입 | `lib/types.ts`, `lib/server.ts`, `api/web.ts` |
| **읽기 전용 공유 토큰** | `share_token` 컬럼(`0004`) + `createShareLink` 툴(발급/회전/`revoke`). `requireReadAccess()`로 조회 도구가 trip_key(전체) **또는** share_token(읽기전용) 허용. 쓰기 도구는 trip_key만 → 토큰으로는 수정·재발급 불가(권한 상승 차단) | `lib/server.ts`, `supabase/migrations/0004`, `README.md` |

> 도구 8종 → **9종**(createShareLink 추가). 배포 시 **마이그레이션 0004**도 함께 적용.

---

### F. 디자인 QA (critique + audit → harden + typeset)
설치 스킬로 2차 디자인 진단·수정 수행.
- **진단**: `critique` **25/40**(AI-slop PASS, 약점=접근성·입력흐름·타이포), `audit` **15/20**(접근성 약점, 안티패턴 4/4)
- **harden(P1/P2)**:
  - 보조 텍스트 대비 `--mut` `#857C6C`→`#6A6152` → **3.59:1 → 5.32:1 (WCAG AA 통과)**
  - 섹션 라벨 `eyebrow` → **`<h2>` 시맨틱 헤딩 6개**, 탭 `role=tab`/`aria-selected`/`tabpanel`, 폼 `label for`
  - **비용 추가 후 탭 튕김 수정** — `selectTab('tExp')`로 비용 탭 유지 + 연속 입력 포커스
- **typeset**: mono를 **숫자·코드 전용**으로 한정(`.muted`/`.sub`/`label`/`.meta` 디스플레이 폰트화), 한글 **Pretendard** 도입(브랜드감 한글까지 확장), `#5fd0a0`→`--mint` 토큰화
- 검증: 라이브 실측(대비 5.32, h2 6, tabpanel 3, Pretendard 로드, 탭 유지) + 스크린샷
- **adapt**: 모바일 터치타깃 — `.tab` 37→**45px**, `.seg .s` **44px**, `.btn.sm`·`.stub` 패딩↑. h1/총지출 `clamp()` 유동 타이포
- **arrange**: 예산 미터 위계 재구성 — **비율 배지(60%, 상태색)** + "남음/초과 ₩" + "총 지출" 라벨로 분리(기존 작은 우측 텍스트 → 강한 포컬)
- **polish**: `.item`/`.pass`/`.seg` hover 피드백, 탭 `min-height`, 토스 버튼 최소 높이

### G. 비용 수정/삭제 기능 (신규, 풀스택)
| 레이어 | 내용 |
|---|---|
| MCP 도구 | `updateExpense`(금액 변경 시 환산 재계산 + **분담 비율 보존 재배분** + 낙관적 잠금) · `deleteExpense`(cascade) — trip_key + 쓰기 권한 검증 |
| 순수 로직 | `rescaleShares()` — equal/custom 비율 보존하며 새 총액에 센트 단위 정확 재배분 (테스트 2건) |
| 마이그레이션 | `0005` — `expenses.updated_at`(낙관적 잠금) |
| web/prototype | `action=updateExpense`/`deleteExpense` (운영자 콘솔 + 프리뷰 mock) |
| 프런트 | 비용 항목별 ✎/✕ 버튼 · 수정 모달(prefill) · 삭제 확인 모달 · 수정 후 비용 탭 유지 |

- 검증: 라이브 E2E(2000→2500 THB 수정 → base 96,250 + 분담 재배분 sumNet=0 · 택시 삭제 → 총액 갱신) + 모달 스크린샷. **도구 9 → 11종**. `npm test` **24/24**.

## 3. 배포 시 필수 액션
1. **마이그레이션 `0003`(방 보호) + `0004`(공유 토큰) + `0005`(expenses.updated_at) 실행** (Supabase).
2. backfill 직후 `select id, name, api_key from tripmoney.trips;`로 **기존 방들의 새 키 1회 확보** — 이 키 없이는 해당 방을 MCP로 접근 불가(웹 콘솔로는 계속 접근 가능).
3. 신규 방은 `createTrip` 응답의 `trip_key`를 멤버에게 공유.
4. 환경변수 `TRIPMONEY_API_KEY`, `TRIPMONEY_WEB_DEMO_KEY`를 프로덕션에 **반드시 설정**(미설정 시 이제 차단됨).

## 4. 남은 권장
- **환율 영속 캐시(KV/Edge Config)** — 콜드스타트 첫 호출 외부 의존 축소. **외부 인프라/패키지 필요**라 미적용(인프라 결정 사항).
- **M5 비용 경로 확대** — N/A: 현재 `updateExpense`/비용 수정 도구가 없어 잠금을 걸 변경 경로 자체가 없음. 향후 비용 수정 도구 추가 시 동일 패턴 적용.
- **DB 행 타입 잔여** — `api/web.ts`의 일부 표시 전용 projection(`action=trips`/`trip` 상세)은 인라인 타입 미적용(낮은 위험). 필요 시 view 타입화.
