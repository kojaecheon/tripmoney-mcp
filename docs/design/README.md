# TripMoney 제품 표면 목업

승인된 설계 `docs/superpowers/specs/2026-09-06-tripmoney-product-surfaces-ux-design.md`를 합성 데이터로 보여주는 정적 목업이다. 프로덕션 코드가 아니며 `public/`과 `vercel.json`에서 참조하지 않는다.

## 열기

`docs/design/mockups/index.html`을 브라우저에서 연다. 서버가 필요 없다. 허브에서 네 화면과 열한 장면으로 이동한다.

## 장면

| 페이지 | `state` | 장면 |
|---|---|---|
| landing | `intake_on` | 신청 폼 활성 |
| landing | `intake_off` | 접수 비활성 안내 |
| review | `awaiting_organizer` | 총무 승인 대기, 잠금 조건 3개 미충족 |
| review | `participant_review` | 총무 승인 완료, 검토창 진행 중, 이의 1건 |
| review | `finalized` | 잠금 완료 |
| share | `notice` | 첫 고지 화면 |
| share | `active` | 본인 결과와 결정 버튼 |
| share | `expired` | 만료·폐기 안내 |
| operator | `queue` | 케이스 큐와 첫 케이스 상세 |
| operator | `case` | 검수 중 케이스 상세 |
| operator | `login` | 로그인 화면 |

## 검증

자동 검사: `node --test docs/design/mockups/tests/*.test.cjs`

시각 검증 결과는 아래 표에 기록한다.

| 장면 | 375px | 768px | 1180px | 콘솔 오류 | 비고 |
|---|---|---|---|---|---|
| landing/intake_on | 통과 | 통과 | 통과 | 없음 | 빈 연락처로 제출 시 오류 문구 표시 확인 |
| landing/intake_off | 통과 | 통과 | 통과 | 없음 | 접수 비활성 안내만 표시, 신청 폼 없음 |
| review/awaiting_organizer | 지출 표의 증빙 태그(예: "OCR 미검수")가 좁은 셀에서 두 줄로 줄바꿈되며 고정 높이 밖으로 텍스트가 넘침 → `e69b8aa`로 `.tag` 높이를 `min-height`로 수정 후 통과 | 통과 | 통과 | 없음 | "이 버전 승인" 클릭 시 총무 스탬프 표시와 검토창 전환 확인 |
| review/participant_review | 통과 (`e69b8aa` 반영 확인) | 통과 | 통과 | 없음 | 잠금 요청 비활성 사유(미해결 이의 등) 표시 확인 |
| review/finalized | 통과 (`e69b8aa` 반영 확인) | 통과 | 통과 | 없음 | 잠금 스탬프 v2·내부 QA 스탬프 표시 확인 |
| share/notice | 통과 | 통과 | 통과 | 없음 | 검토 전 문구 6항목, 선택지 3개 표시 확인 |
| share/active | 통과 | 통과 | 통과 | 없음 | "계속" 클릭 시 활성 화면 전환, 이의 제기 모달에서 빈 사유 제출 시 "사유를 적어 주세요" 표시 확인 |
| share/expired | 통과 | 통과 | 통과 | 없음 | 여행명 없이 안내 문구만 표시 확인 |
| operator/queue | 통과 | 통과 | 통과 | 없음 | 큐에서 C-013 클릭 시 상세가 전환되고 일시정지 배지 표시 확인 |
| operator/case | 통과 | 통과 | 통과 | 없음 | 체크포인트·자료수집·지출 목록·영수증 3열 등 구획 순서 확인. C-014만 상세 제공, QA 스탬프·검수자 승인 시각·지출 목록 태그·이의 목록 추가(최종 검토 반영) |
| operator/login | 통과 | 통과 | 통과 | 없음 | 이메일 입력 폼만 표시, 레일·모티프 없음 확인 |

접근성 점검(7.2): 대비 AA는 `contrast.test.cjs`, 헤딩 구조·빈 버튼·alt는 `pages.test.cjs`로 자동 확인. 포커스 링(호박색 3px, `outline-offset:3px`)은 landing·review·share·operator 네 페이지에서 각 1개 장면씩 Tab 키로 수동 확인해 모두 통과했다. 결과: 통과. 모달 포커스 가둠과 Esc 닫힘은 `components.js`의 `trapModal`로 구현했다 — review의 카카오 공유 미리보기 모달과 share의 이의 제기 모달 모두 Escape 키로 닫히고 Tab이 모달 안 요소 사이에서만 순환하며, 닫힌 뒤 포커스는 모달을 연 트리거 버튼으로 돌아간다. `trapModal`은 `components.test.cjs`로 자동 검사하고, 실제 두 모달의 동작은 브라우저에서 수동으로 재확인했다. 결과: 통과. 터치 대상 44px은 운영자 탭(`.tabs .pill`)과 레일 단계(`.rail-step`)에 `min-height:44px` 규칙을 두고 `tokens.test.cjs`로 자동 검사한다. 레일은 좁은 화면에서 가로로 스크롤되므로 `components.js`의 `revealRail()`이 첫 그리기와 매 `mount()`마다 현재 단계를 보이는 위치로 옮기고, 참여자 공유 화면의 레일은 `.rail-sm`으로 축소해 375px에서도 현재 단계와 앞뒤 단계가 함께 보인다. 결과: 통과.

내용 규칙 점검(7.3): 모티프 예산·금액 병기·계좌 미노출·참여자 최소화·검토 전 문구 표시는 `render-*.test.cjs`와 `pages.test.cjs`로 자동 확인. 결과: 통과.
