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

자동 검사: `node --test docs/design/mockups/tests/`

시각 검증 결과는 아래 표에 기록한다. (구현 마지막 작업에서 채운다.)
