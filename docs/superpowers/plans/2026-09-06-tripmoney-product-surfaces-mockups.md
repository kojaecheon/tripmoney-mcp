# TripMoney 제품 표면 목업 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 UX 설계의 네 표면(공개 랜딩, 총무 검토, 참여자 공유, 운영자 워크벤치)을 합성 데이터로 움직이는 정적 HTML 목업과 허브 페이지로 만들고, Node 내장 테스트로 설계 규칙을 자동 검증한다.

**Architecture:** 모든 화면은 순수 렌더 함수(`components.js`, `render-*.js`)가 데이터와 장면 키를 받아 HTML 문자열을 돌려주는 구조다. HTML 페이지는 스크립트를 순서대로 불러온 뒤 `state` 쿼리 값으로 장면을 골라 `#app`에 넣기만 한다. 렌더 함수는 브라우저 전역과 CommonJS 내보내기를 동시에 제공하므로 Node의 `node --test`로 문자열 출력을 검증할 수 있다. 빌드, 번들러, 외부 라이브러리는 없다.

**Tech Stack:** 정적 HTML, CSS 사용자 정의 속성, ES2020 스크립트(전역 + CommonJS 이중 내보내기), Node 20 내장 테스트 러너(`node --test`), Google Fonts(Fraunces, Space Mono)와 Pretendard CDN.

**Spec:** `docs/superpowers/specs/2026-09-06-tripmoney-product-surfaces-ux-design.md`

## Global Constraints

- 산출물은 `docs/design/` 아래에만 둔다. `public/`, `vercel.json`, `lib/`, `api/`, `package.json`, DB, 배포 설정은 변경하지 않는다.
- 빌드 도구, 번들러, 프레임워크, 외부 JS 라이브러리를 쓰지 않는다. 서체는 Google Fonts(Fraunces, Space Mono)와 Pretendard CDN만 쓰고 Space Grotesk와 Inter는 불러오지 않는다.
- 페이지는 `file://`로 열어도 동작해야 하므로 ES 모듈(`type="module"`)과 `fetch`를 쓰지 않는다.
- 실제 개인정보, 계좌번호, 은행명, Toss 링크, 실제 영수증 이미지를 넣지 않는다. 영수증 자리는 회색 자리 표시로 대신한다.
- 토큰 값은 스펙 4.1을 그대로 쓴다. 캔버스 `#FFFAF0`, 종이 `#F5EFE3`, 카드 `#FFFDF7`, 잉크 `#172133`, 보조 글자 `#5E574B`, 선 `#DDD0BA`, 승인 `#1F6B4A`, 대기 `#B86718`, 이의 `#B14B3F`, 정보 `#305D88`, 표현색 라벤더 `#B8A4ED`, 피치 `#FFB084`, 오커 `#E8B94A`, 민트 `#A4D4C5`, 딥네이비 `#233049`.
- 한글 제목은 Pretendard 600, 자간 -0.02em이며 700 이상을 쓰지 않는다. 글자 크기 단계는 56, 40, 28, 20, 16, 14, 13px, 모바일 히어로는 34px이다.
- 모서리는 버튼·입력 12px, 콘텐츠 카드 16px, 랜딩 특징 카드 24px, 칩 알약형, 서류 컴포넌트 10~14px이다. 버튼과 입력 높이는 44px이다.
- 모티프 예산: 한 화면에 서류 컴포넌트 종류는 셋(보딩패스, 스탬프, 수하물 태그)을 넘기지 않고, 폼·표·필터·설정·로그인에는 모티프를 쓰지 않는다. 표현색은 랜딩과 허브의 특징 카드에만 쓰고 같은 색을 연속으로 두 번 쓰지 않는다. 채운 버튼은 앱 화면에서는 페이지에 하나, 랜딩에서는 히어로·가격·마무리 CTA 구획에 하나씩이다.
- 스탬프 종류는 총무 승인, 참여자 승인, 참여자 이의, 이의 철회, 내부 QA, 최종 잠금의 여섯 가지뿐이다. 수하물 태그 상태는 원본 검수, OCR 미검수, 수동 입력, 원본 삭제의 네 가지뿐이다.
- 금액은 `₩` 뒤 천 단위 구분 정수, 숫자 서체와 표 형식 숫자. 외화는 금액 뒤 통화 코드, 환산 원화는 다음 줄. 버전은 `v2`, 케이스 번호는 `C-014`, 시각은 `2026-09-06 14:30` 형식이다.
- 법률 검토 전 문구(참여자 고지, 약관, 개인정보)에는 "검토 전 문구" 표시를 붙인다.
- 문구 원칙: 버튼은 동사로 시작하는 한국어 문장체이고 마침표를 붙이지 않는다. 헤드라인은 "근거가 남는 해외여행 최종 정산"이다. "3~8명"은 운영 범위로 표기한다. 가격은 29,000원과 59,000원이다.
- 커밋은 작업 단위로 하고 푸시는 하지 않는다. 커밋 메시지는 `design: ...` 접두어와 한국어 요약을 쓰고 마지막 줄에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`을 붙인다.
- 테스트 실행 명령은 항상 `node --test docs/design/mockups/tests/`이다. Node 20 이상이 필요하며 `node_modules`는 필요 없다.

---

## 파일 구조

스펙 6.1의 구조를 렌더 함수와 테스트 디렉터리로 확장한다. 스펙 6.1은 마지막 작업에서 이 구조로 갱신한다.

| 파일 | 책임 |
|---|---|
| `docs/design/README.md` | 목업 사용법, 장면 목록, 검증 결과 기록 |
| `docs/design/mockups/tokens.css` | 스펙 4.1 토큰, 공통 카드·표·폼·버튼, 여정 레일, 서류 컴포넌트 3종, 반응형 규칙 |
| `docs/design/mockups/data.js` | 합성 여행 데이터, 정산 계산, 장면별 상태(`TM_DATA` 전역 + CommonJS) |
| `docs/design/mockups/components.js` | 이스케이프·금액·날짜 도우미, 여정 레일, 보딩패스, 스탬프, 수하물 태그, 버튼, 목업 이동 막대(`TM_UI` 전역 + CommonJS) |
| `docs/design/mockups/render-landing.js` | 랜딩 페이지 렌더 함수 `TM_RENDER_LANDING.render(data, state)` |
| `docs/design/mockups/render-review.js` | 총무 검토 렌더 함수 `TM_RENDER_REVIEW.render(data, state)` |
| `docs/design/mockups/render-share.js` | 참여자 공유 렌더 함수 `TM_RENDER_SHARE.render(data, state)` |
| `docs/design/mockups/render-operator.js` | 운영자 워크벤치 렌더 함수 `TM_RENDER_OPERATOR.render(data, state)` |
| `docs/design/mockups/landing.html`, `review.html`, `share.html`, `operator.html` | 스크립트 로드와 부트스트랩만 담은 페이지 |
| `docs/design/mockups/index.html` | 허브: 네 화면과 열한 장면 링크 |
| `docs/design/mockups/tests/helpers.cjs` | 파일 읽기와 스크립트 로드 도우미 |
| `docs/design/mockups/tests/*.test.cjs` | 토큰, 데이터, 컴포넌트, 페이지별 렌더, HTML 구조, 대비 검사 |

이중 내보내기 관례는 모든 스크립트가 같다. 파일 끝에 다음을 둔다.

```js
if (typeof module !== "undefined" && module.exports) module.exports = TM_UI;
```

브라우저에서는 `<script src>`로 불러 전역을 쓰고, Node 테스트에서는 `require`로 같은 객체를 받는다. 스크립트끼리는 전역 이름(`TM_DATA`, `TM_UI`)으로만 서로를 참조하며, Node에서는 테스트 도우미가 전역에 미리 심어 준다.

장면 키는 스펙 3.3과 같다.

| 페이지 | `state` 값 |
|---|---|
| landing | `intake_on`, `intake_off` |
| review | `awaiting_organizer`, `participant_review`, `finalized` |
| share | `notice`, `active`, `expired` |
| operator | `queue`, `case`, `login` |

---

### Task 1: 테스트 러너와 도우미 스캐폴드

**Files:**
- Create: `docs/design/README.md`
- Create: `docs/design/mockups/tests/helpers.cjs`
- Create: `docs/design/mockups/tests/smoke.test.cjs`

**Interfaces:**
- Produces: `helpers.read(rel)`는 `docs/design/mockups/` 기준 상대 경로의 파일 내용을 문자열로 돌려준다. `helpers.load(name)`는 `data.js`, `components.js`, `render-*.js`를 순서대로 `require`하면서 전역 `TM_DATA`, `TM_UI`를 심고 요청한 모듈의 내보내기를 돌려준다. `helpers.MOCK_DIR`는 목업 디렉터리 절대 경로다.

- [ ] **Step 1: 도우미 작성**

```js
// docs/design/mockups/tests/helpers.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const MOCK_DIR = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(MOCK_DIR, rel), "utf8");
}

function fresh(rel) {
  const abs = path.join(MOCK_DIR, rel);
  delete require.cache[abs];
  return require(abs);
}

// 전역을 심는 순서: data → components → 요청 모듈
function load(name) {
  globalThis.TM_DATA = fresh("data.js");
  globalThis.TM_UI = fresh("components.js");
  if (name === "data.js") return globalThis.TM_DATA;
  if (name === "components.js") return globalThis.TM_UI;
  return fresh(name);
}

module.exports = { MOCK_DIR, read, load };
```

- [ ] **Step 2: 실패하는 스모크 테스트 작성**

```js
// docs/design/mockups/tests/smoke.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MOCK_DIR } = require("./helpers.cjs");

test("목업 필수 파일이 존재한다", () => {
  for (const f of ["tokens.css", "data.js", "components.js", "index.html"]) {
    assert.ok(fs.existsSync(path.join(MOCK_DIR, f)), `${f} 없음`);
  }
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --test docs/design/mockups/tests/`
Expected: FAIL, 메시지에 `tokens.css 없음`

- [ ] **Step 4: README 초안 작성**

```markdown
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
```

- [ ] **Step 5: 커밋**

```bash
git add docs/design/README.md docs/design/mockups/tests/helpers.cjs docs/design/mockups/tests/smoke.test.cjs
git commit -m "design: 목업 테스트 스캐폴드와 README 초안

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 디자인 토큰과 공통 스타일 `tokens.css`

**Files:**
- Create: `docs/design/mockups/tokens.css`
- Create: `docs/design/mockups/tests/tokens.test.cjs`

**Interfaces:**
- Produces: CSS 사용자 정의 속성 `--canvas --paper --panel --ink --mut --line --green --amber --rose --blue --lavender --peach --ochre --mint --navy --disp --disp-latin --sans --mono --shadow`, 클래스 `.btn .btn-secondary .input .card .card-lg .feature .band-paper .rail .rail-dot .rail-line .rail-badge .pass .pass-body .pass-stub .stamp .tag .table .mocknav .sr-only .num .eyebrow`, 표현색 수식어 `.feature.lavender .feature.peach .feature.ochre .feature.mint .feature.navy`, 스탬프 수식어 `.stamp.organizer .stamp.participant .stamp.objection .stamp.withdrawn .stamp.qa .stamp.locked`, 태그 수식어 `.tag.verified .tag.ocr_only .tag.manual .tag.deleted`.

- [ ] **Step 1: 실패하는 토큰 테스트 작성**

```js
// docs/design/mockups/tests/tokens.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { read } = require("./helpers.cjs");

const css = () => read("tokens.css");

test("스펙 4.1 색 토큰 값이 정확하다", () => {
  const c = css();
  const expected = {
    "--canvas": "#FFFAF0", "--paper": "#F5EFE3", "--panel": "#FFFDF7", "--ink": "#172133",
    "--mut": "#5E574B", "--line": "#DDD0BA", "--green": "#1F6B4A", "--amber": "#B86718",
    "--rose": "#B14B3F", "--blue": "#305D88", "--lavender": "#B8A4ED", "--peach": "#FFB084",
    "--ochre": "#E8B94A", "--mint": "#A4D4C5", "--navy": "#233049",
  };
  for (const [k, v] of Object.entries(expected)) {
    assert.match(c, new RegExp(`${k}\\s*:\\s*${v}`, "i"), `${k} 값이 ${v}가 아니다`);
  }
});

test("서체 토큰과 금지 서체", () => {
  const c = css();
  assert.match(c, /--disp\s*:\s*'Pretendard Variable'/);
  assert.match(c, /--disp-latin\s*:\s*'Fraunces'/);
  assert.match(c, /--mono\s*:\s*'Space Mono'/);
  assert.doesNotMatch(c, /Space Grotesk|Inter/);
});

test("제목 굵기 상한과 자간", () => {
  const c = css();
  assert.match(c, /h1[^{]*\{[^}]*font-weight\s*:\s*600/s);
  assert.match(c, /letter-spacing\s*:\s*-0?\.02em/);
  assert.doesNotMatch(c, /font-weight\s*:\s*(700|800|900|bold)/);
});

test("버튼·입력 규격과 모서리 단계", () => {
  const c = css();
  assert.match(c, /\.btn[^{]*\{[^}]*height\s*:\s*44px/s);
  assert.match(c, /\.btn[^{]*\{[^}]*border-radius\s*:\s*12px/s);
  assert.match(c, /\.input[^{]*\{[^}]*height\s*:\s*44px/s);
  assert.match(c, /\.card[^{,]*\{[^}]*border-radius\s*:\s*16px/s);
  assert.match(c, /\.feature[^{,]*\{[^}]*border-radius\s*:\s*24px/s);
});

test("필수 컴포넌트 클래스가 정의된다", () => {
  const c = css();
  for (const cls of [".rail", ".rail-dot", ".rail-badge", ".pass", ".pass-stub", ".stamp", ".tag",
    ".stamp.organizer", ".stamp.locked", ".tag.verified", ".tag.deleted", ".feature.navy", ".mocknav", ".sr-only", ".band-paper"]) {
    assert.ok(c.includes(cls), `${cls} 없음`);
  }
});

test("포커스 링은 호박색 3px", () => {
  assert.match(css(), /:focus-visible\s*\{[^}]*outline\s*:\s*3px solid var\(--amber\)/s);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test docs/design/mockups/tests/tokens.test.cjs`
Expected: FAIL, `ENOENT ... tokens.css`

- [ ] **Step 3: tokens.css 작성**

옅은 배경 위의 작은 글자(대기·이의 필, OCR 미검수 태그, SLA 표시)는 스펙 의미색 그대로 쓰면 AA 4.5:1에 미달하므로 어두운 변형 `#7A4410`(호박색), `#8E3A30`(장미색)을 쓴다. Task 9의 대비 검사가 이 값을 확인한다.

```css
/* docs/design/mockups/tokens.css — 스펙 4장 디자인 시스템 */
:root{
  --canvas:#FFFAF0; --paper:#F5EFE3; --panel:#FFFDF7; --ink:#172133; --mut:#5E574B; --line:#DDD0BA;
  --green:#1F6B4A; --amber:#B86718; --rose:#B14B3F; --blue:#305D88;
  --lavender:#B8A4ED; --peach:#FFB084; --ochre:#E8B94A; --mint:#A4D4C5; --navy:#233049;
  --disp:'Pretendard Variable','Pretendard',-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;
  --disp-latin:'Fraunces','Pretendard Variable',serif;
  --sans:'Pretendard Variable','Pretendard',-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;
  --mono:'Space Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --shadow:0 18px 54px -34px rgba(23,33,51,.55);
  --r-ctl:12px; --r-card:16px; --r-feature:24px; --r-doc:12px;
  --max-landing:1280px; --max-app:1180px;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--sans);background:var(--canvas);color:var(--ink);line-height:1.55;-webkit-font-smoothing:antialiased;font-size:16px}
a{color:var(--blue)}
img{max-width:100%;display:block}
button,input,select,textarea{font:inherit;color:inherit}
:focus-visible{outline:3px solid var(--amber);outline-offset:3px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.02em}

/* 제목: 한글 600 상한, 자간 -0.02em */
h1,h2,h3,h4{font-family:var(--disp);font-weight:600;letter-spacing:-0.02em;line-height:1.2}
h1{font-size:56px;line-height:1.08}
h2{font-size:40px}
h3{font-size:28px}
h4{font-size:20px}
.eyebrow{font-size:13px;color:var(--mut);letter-spacing:.06em;text-transform:none}
.latin{font-family:var(--disp-latin)}
small,.meta{font-size:14px;color:var(--mut)}
.caption{font-size:13px;color:var(--mut)}
@media(max-width:767px){h1{font-size:34px}h2{font-size:28px}h3{font-size:22px}}

/* 레이아웃 */
.shell{max-width:var(--max-landing);margin:0 auto;padding:0 24px}
.shell-app{max-width:var(--max-app);margin:0 auto;padding:0 16px}
.section{padding:96px 0}
@media(max-width:767px){.section{padding:56px 0}}
.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}
.grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}
@media(max-width:1023px){.grid-3{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:767px){.grid-2,.grid-3{grid-template-columns:1fr}}
.stack{display:grid;gap:16px}
.between{display:flex;justify-content:space-between;align-items:center;gap:12px}

/* 카드 */
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:24px}
.card-lg{background:var(--paper);border-radius:var(--r-feature);padding:32px}
.feature{border-radius:24px;padding:32px;color:var(--ink);display:grid;gap:12px;min-height:240px}
.feature.lavender{background:var(--lavender)}
.feature.peach{background:var(--peach)}
.feature.ochre{background:var(--ochre)}
.feature.mint{background:var(--mint)}
.feature.navy{background:var(--navy);color:#FFFDF7}
.feature .fragment{background:var(--panel);color:var(--ink);border-radius:12px;padding:12px;margin-top:auto}
.band-paper{background:var(--paper);padding:96px 0}
@media(max-width:767px){.band-paper{padding:56px 0}}
.cta-band{background:var(--paper);border-radius:24px;padding:80px 32px;text-align:center}
@media(max-width:767px){.cta-band{padding:40px 20px}}

/* 버튼·입력 */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 20px;border-radius:12px;border:1px solid var(--ink);background:var(--ink);color:#FFFDF7;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none}
.btn-secondary{background:var(--canvas);color:var(--ink);border:1px solid var(--line)}
.btn[disabled],.btn.is-disabled{background:var(--line);border-color:var(--line);color:var(--mut);cursor:not-allowed}
.btn.block{width:100%}
.input{height:44px;width:100%;padding:0 16px;border-radius:12px;border:1px solid var(--line);background:var(--panel)}
textarea.input{height:auto;min-height:96px;padding:12px 16px}
.field{display:grid;gap:6px;font-size:14px}
.check{display:flex;gap:10px;align-items:flex-start;font-size:14px}
.pill{display:inline-flex;align-items:center;height:28px;padding:0 12px;border-radius:999px;background:var(--paper);font-size:13px;font-weight:500}
.pill.ok{background:#E6F0E9;color:var(--green)}
.pill.wait{background:#F7EAD8;color:#7A4410}
.pill.bad{background:#F3DEDB;color:#8E3A30}
.pill.info{background:#E3EBF3;color:var(--blue)}

/* 표 */
.table{width:100%;border-collapse:collapse;font-size:14px}
.table th{text-align:left;font-weight:500;color:var(--mut);padding:8px 10px;border-bottom:1px solid var(--line)}
.table td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
.table td.num,.table th.num{text-align:right}

/* 여정 레일 */
.rail{display:flex;align-items:center;gap:0;overflow-x:auto;padding:8px 0}
.rail-step{display:flex;flex-direction:column;align-items:center;min-width:96px;position:relative;font-size:13px;color:var(--mut)}
.rail-dot{width:16px;height:16px;border-radius:50%;border:2px solid var(--line);background:var(--panel)}
.rail-step.done .rail-dot{background:var(--ink);border-color:var(--ink)}
.rail-step.current .rail-dot{border-color:var(--blue);box-shadow:0 0 0 3px #E3EBF3}
.rail-step.current{color:var(--ink);font-weight:600}
.rail-line{flex:1;min-width:24px;border-top:2px dashed var(--line);margin-top:-18px}
.rail-sla{font-size:11px;color:#7A4410;position:absolute;top:-14px}
.rail-badge{margin-left:auto;align-self:flex-start}
.rail-step .cond{display:none;position:absolute;top:44px;background:var(--ink);color:#FFFDF7;font-size:12px;padding:6px 8px;border-radius:8px;width:180px;text-align:center;z-index:2}
.rail-step:hover .cond,.rail-step:focus-within .cond{display:block}

/* 보딩패스 */
.pass{display:flex;background:var(--paper);border:1px solid var(--line);border-radius:var(--r-doc);overflow:hidden;box-shadow:var(--shadow)}
.pass-body{flex:1;padding:14px 16px;display:grid;gap:4px}
.pass-body .leg{font-size:12px;color:var(--mut)}
.pass-body .route{font-weight:600;font-size:18px}
.pass-stub{width:150px;padding:14px 12px;border-left:2px dashed var(--line);display:grid;gap:6px;align-content:center;text-align:right;background:var(--panel)}
.pass-stub .fare{font-size:18px;font-weight:600}
@media(max-width:767px){.pass-stub{width:120px}}

/* 스탬프 */
.stamp{display:inline-grid;place-items:center;width:104px;height:104px;border-radius:50%;border:3px solid currentColor;font-size:12px;font-weight:600;line-height:1.25;text-align:center;transform:rotate(-8deg);padding:8px;background:transparent}
.stamp.organizer,.stamp.participant{color:var(--green)}
.stamp.objection{color:var(--rose)}
.stamp.withdrawn,.stamp.locked{color:var(--ink)}
.stamp.qa{color:var(--blue)}
.stamp .date{font-family:var(--mono);font-weight:400;font-size:11px}

/* 수하물 태그 */
.tag{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px 0 16px;border-radius:4px 12px 12px 4px;font-size:12px;font-weight:500;position:relative;border:1px solid var(--line);background:var(--panel)}
.tag::before{content:"";position:absolute;left:5px;top:50%;width:6px;height:6px;border-radius:50%;background:var(--canvas);border:1px solid var(--line);transform:translateY(-50%)}
.tag.verified{background:#E6F0E9;color:var(--green);border-color:#BFD9C9}
.tag.ocr_only{background:#F7EAD8;color:#7A4410;border-color:#E7C9A2}
.tag.manual{background:var(--panel);color:var(--ink);border-color:var(--ink)}
.tag.deleted{background:#ECE9E2;color:var(--mut);border-color:var(--line)}

/* 목업 전용 이동 막대 (설계 화면의 일부가 아님) */
.mocknav{background:var(--ink);color:#FFFDF7;font-size:12px;padding:6px 12px;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.mocknav a{color:#FFFDF7}
.mocknav .cur{text-decoration:underline}

/* 모달 */
.modal-bg{position:fixed;inset:0;background:rgba(23,33,51,.45);display:flex;align-items:center;justify-content:center;padding:16px;z-index:10}
.modal{background:var(--panel);border-radius:16px;padding:24px;max-width:420px;width:100%;display:grid;gap:12px}
[hidden]{display:none !important}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test docs/design/mockups/tests/tokens.test.cjs`
Expected: PASS 6개

- [ ] **Step 5: 커밋**

```bash
git add docs/design/mockups/tokens.css docs/design/mockups/tests/tokens.test.cjs
git commit -m "design: 목업 디자인 토큰과 공통 스타일

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 합성 데이터와 정산 계산 `data.js`

**Files:**
- Create: `docs/design/mockups/data.js`
- Create: `docs/design/mockups/tests/data.test.cjs`

**Interfaces:**
- Produces: 전역 `TM_DATA`. 필드는 `trip {id,name,base_currency,ended_on,product,organizer_id}`, `members [{id,alias,role}]`(role은 `organizer`|`participant`), `fx [{pair,rate,source,as_of,manual_reason}]`, `expenses [{id,title,amount,currency,rate,payer_id,split_ids,spent_at,evidence}]`(evidence는 `verified`|`ocr_only`|`manual`), `versions [{version,status,created_at,note,change,result}]`, `stages [{key,label,cond,sla?}]`, `scenes {landing,review,share,operator}`, `cases`, `invariants [{label,ok}]`(ok는 `true`|`false`|`null`), `receipt_compare`, `pricing`, `eligibility {include,exclude}`, `notices`, `policy_version`, `revision_quota {total,used}`, 함수 `settle(expenses)`와 `krw(expense)`.
- `settle()` 반환값: `{ total, per_member:[{id,alias,paid,owed,net}], transfers:[{from_id,from,to_id,to,amount}], shares:{[expense_id]:[{id,share}]} }`. 모든 금액은 정수 원이다.
- 장면 객체: `scenes.review[state] = { stage, version, organizer_approved_at, window:{opens_at,closes_at,days_left}|null, decisions:[{member_id,decision,at?,reason?}], locked_at, qa_at }`, decision은 `approved`|`objection`|`withdrawn`|`not_responded`. `scenes.share[state] = { viewer_id, stage, expired, decisions, window, version }`. `scenes.operator[state] = { view:"queue"|"case"|"login", selected }`. `scenes.landing[state] = { intake:boolean }`.

- [ ] **Step 1: 실패하는 데이터 테스트 작성**

```js
// docs/design/mockups/tests/data.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, read } = require("./helpers.cjs");

test("멤버 5명, 총무 1명, 별칭만 있다", () => {
  const d = load("data.js");
  assert.equal(d.members.length, 5);
  assert.equal(d.members.filter((m) => m.role === "organizer").length, 1);
  for (const m of d.members) assert.deepEqual(Object.keys(m).sort(), ["alias", "id", "role"]);
});

test("지출 12건, 근거 상태 3종이 모두 나타난다", () => {
  const d = load("data.js");
  assert.equal(d.expenses.length, 12);
  const states = new Set(d.expenses.map((e) => e.evidence));
  for (const s of ["verified", "ocr_only", "manual"]) assert.ok(states.has(s), `${s} 없음`);
  assert.ok(d.expenses.some((e) => e.currency === "KRW"));
  assert.ok(d.expenses.some((e) => e.currency === "THB"));
});

test("정산 불변식: 분담 합계 = 환산액, net 합계 0, 송금은 양수 정수", () => {
  const d = load("data.js");
  for (const v of d.versions) {
    const r = v.result;
    assert.equal(r.per_member.reduce((s, m) => s + m.net, 0), 0, `v${v.version} net 합계`);
    for (const t of r.transfers) {
      assert.ok(Number.isInteger(t.amount) && t.amount > 0, "송금액");
      assert.notEqual(t.from_id, t.to_id);
    }
    for (const [id, shares] of Object.entries(r.shares)) {
      const e = d.expenses.find((x) => x.id === id);
      assert.equal(shares.reduce((s, x) => s + x.share, 0), d.krw(e), `${id} 분담 합계`);
    }
    assert.equal(r.total, d.expenses.reduce((s, e) => s + d.krw(e), 0));
  }
});

test("버전 2개: v1은 스파 분담에 지은 포함, v2는 제외", () => {
  const d = load("data.js");
  assert.equal(d.versions.length, 2);
  assert.equal(d.versions[1].status, "current");
  assert.ok(d.versions[0].result.shares.e09.some((s) => s.id === "m_jieun"));
  assert.ok(!d.versions[1].result.shares.e09.some((s) => s.id === "m_jieun"));
});

test("장면 키가 스펙 3.3과 같다", () => {
  const d = load("data.js");
  assert.deepEqual(Object.keys(d.scenes.landing), ["intake_on", "intake_off"]);
  assert.deepEqual(Object.keys(d.scenes.review), ["awaiting_organizer", "participant_review", "finalized"]);
  assert.deepEqual(Object.keys(d.scenes.share), ["notice", "active", "expired"]);
  assert.deepEqual(Object.keys(d.scenes.operator), ["queue", "case", "login"]);
});

test("참여자 검토 장면: 승인 2, 이의 1, 무응답 1", () => {
  const d = load("data.js");
  const ds = d.scenes.review.participant_review.decisions;
  const count = (k) => ds.filter((x) => x.decision === k).length;
  assert.equal(count("approved"), 2);
  assert.equal(count("objection"), 1);
  assert.equal(count("not_responded"), 1);
  assert.equal(d.scenes.review.finalized.decisions.filter((x) => x.decision === "objection").length, 0);
  assert.ok(d.scenes.review.finalized.locked_at);
});

test("케이스 3건, C-014 차단 2건, 불변식 8개, 단계 6개", () => {
  const d = load("data.js");
  assert.deepEqual(d.cases.map((c) => c.id), ["C-014", "C-013", "C-012"]);
  assert.equal(d.cases[0].blockers.length, 2);
  assert.ok(d.cases[1].paused_reason);
  assert.equal(d.invariants.length, 8);
  assert.deepEqual(d.stages.map((s) => s.key), ["collecting", "reviewing", "awaiting_organizer", "participant_review", "finalized", "delivered"]);
  assert.equal(d.stages.filter((s) => s.sla).length, 1);
});

test("개인정보·계좌·Toss 흔적이 없다", () => {
  const src = read("data.js");
  assert.doesNotMatch(src, /\d{10,}/, "10자리 이상 숫자열");
  assert.doesNotMatch(src, /toss|\d{2,6}-\d{2,6}-\d{4,8}|계좌번호|@[a-z0-9.-]+\.[a-z]{2,}/i);
});

test("가격 셀 2개와 적격·제외 조건", () => {
  const d = load("data.js");
  assert.deepEqual(d.pricing.map((p) => p.price), [29000, 59000]);
  assert.equal(d.pricing.filter((p) => p.featured).length, 1);
  assert.equal(d.eligibility.include.length, 6);
  assert.equal(d.eligibility.exclude.length, 6);
  assert.equal(d.revision_quota.total, 2);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test docs/design/mockups/tests/data.test.cjs`
Expected: FAIL, `Cannot find module ... data.js`

- [ ] **Step 3: data.js 작성**

```js
// docs/design/mockups/data.js — 합성 데이터. 실제 인물·계좌·영수증 없음.
"use strict";
var TM_DATA = (function () {
  var members = [
    { id: "m_hyunwoo", alias: "현우", role: "organizer" },
    { id: "m_minsu", alias: "민수", role: "participant" },
    { id: "m_jieun", alias: "지은", role: "participant" },
    { id: "m_seojun", alias: "서준", role: "participant" },
    { id: "m_harin", alias: "하린", role: "participant" }
  ];
  var ALL = members.map(function (m) { return m.id; });
  var trip = { id: "trip_bkk", name: "방콕 4박", base_currency: "KRW", ended_on: "2026-08-30", product: "deadline", organizer_id: "m_hyunwoo" };

  var fx = [
    { pair: "THB/KRW", rate: 38.6, source: "open.er-api.com", as_of: "2026-08-26 09:00", manual_reason: null },
    { pair: "THB/KRW", rate: 38.9, source: "수동 입력", as_of: "2026-08-29 21:10", manual_reason: "현지 환전소 영수증 기준" }
  ];

  var expenses = [
    { id: "e01", title: "수완나품 공항 택시", amount: 450, currency: "THB", rate: 38.6, payer_id: "m_hyunwoo", split_ids: ALL, spent_at: "2026-08-26 15:40", evidence: "verified" },
    { id: "e02", title: "첫날 저녁 식사", amount: 2100, currency: "THB", rate: 38.6, payer_id: "m_minsu", split_ids: ALL, spent_at: "2026-08-26 19:30", evidence: "verified" },
    { id: "e03", title: "편의점 물·간식", amount: 380, currency: "THB", rate: 38.6, payer_id: "m_jieun", split_ids: ALL, spent_at: "2026-08-26 22:10", evidence: "manual" },
    { id: "e04", title: "왓포 입장료", amount: 1000, currency: "THB", rate: 38.6, payer_id: "m_hyunwoo", split_ids: ALL, spent_at: "2026-08-27 10:20", evidence: "verified" },
    { id: "e05", title: "차오프라야 보트", amount: 300, currency: "THB", rate: 38.6, payer_id: "m_seojun", split_ids: ALL, spent_at: "2026-08-27 13:00", evidence: "ocr_only" },
    { id: "e06", title: "점심 팟타이", amount: 900, currency: "THB", rate: 38.6, payer_id: "m_harin", split_ids: ALL, spent_at: "2026-08-27 13:40", evidence: "verified" },
    { id: "e07", title: "쩟페어 야시장", amount: 1250, currency: "THB", rate: 38.6, payer_id: "m_minsu", split_ids: ALL, spent_at: "2026-08-28 19:40", evidence: "ocr_only" },
    { id: "e08", title: "그랩 이동", amount: 220, currency: "THB", rate: 38.6, payer_id: "m_hyunwoo", split_ids: ALL, spent_at: "2026-08-28 22:00", evidence: "manual" },
    { id: "e09", title: "오아시스 스파", amount: 4000, currency: "THB", rate: 38.9, payer_id: "m_hyunwoo", split_ids: ["m_hyunwoo", "m_minsu", "m_seojun", "m_harin"], spent_at: "2026-08-29 14:00", evidence: "verified" },
    { id: "e10", title: "짐톰슨 기념품", amount: 1800, currency: "THB", rate: 38.9, payer_id: "m_jieun", split_ids: ["m_jieun", "m_harin"], spent_at: "2026-08-29 17:30", evidence: "verified" },
    { id: "e11", title: "공항 가는 택시", amount: 480, currency: "THB", rate: 38.9, payer_id: "m_seojun", split_ids: ALL, spent_at: "2026-08-30 08:10", evidence: "manual" },
    { id: "e12", title: "인천공항 주차비", amount: 48000, currency: "KRW", rate: 1, payer_id: "m_hyunwoo", split_ids: ALL, spent_at: "2026-08-30 18:30", evidence: "manual" }
  ];

  function krw(e) { return Math.round(e.amount * e.rate); }

  // 균등 분담 + 최소 송금(탐욕). lib/settlement.ts와 같은 원칙이지만 목업용 단순화.
  function settle(list) {
    var paid = {}, owed = {}, shares = {};
    ALL.forEach(function (id) { paid[id] = 0; owed[id] = 0; });
    list.forEach(function (e) {
      var total = krw(e);
      paid[e.payer_id] += total;
      var n = e.split_ids.length, base = Math.floor(total / n), rem = total - base * n;
      shares[e.id] = e.split_ids.map(function (id, i) {
        var share = base + (i < rem ? 1 : 0);
        owed[id] += share;
        return { id: id, share: share };
      });
    });
    var per_member = members.map(function (m) {
      return { id: m.id, alias: m.alias, paid: paid[m.id], owed: owed[m.id], net: paid[m.id] - owed[m.id] };
    });
    var debtors = per_member.filter(function (x) { return x.net < 0; }).map(function (x) { return { id: x.id, alias: x.alias, amt: -x.net }; }).sort(function (a, b) { return b.amt - a.amt; });
    var creditors = per_member.filter(function (x) { return x.net > 0; }).map(function (x) { return { id: x.id, alias: x.alias, amt: x.net }; }).sort(function (a, b) { return b.amt - a.amt; });
    var transfers = [], i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      var amt = Math.min(debtors[i].amt, creditors[j].amt);
      if (amt > 0) transfers.push({ from_id: debtors[i].id, from: debtors[i].alias, to_id: creditors[j].id, to: creditors[j].alias, amount: amt });
      debtors[i].amt -= amt; creditors[j].amt -= amt;
      if (debtors[i].amt === 0) i++;
      if (creditors[j].amt === 0) j++;
    }
    var total = list.reduce(function (s, e) { return s + krw(e); }, 0);
    return { total: total, per_member: per_member, transfers: transfers, shares: shares };
  }

  var v1Expenses = expenses.map(function (e) { return e.id === "e09" ? Object.assign({}, e, { split_ids: ALL }) : e; });
  var versions = [
    { version: 1, status: "superseded", created_at: "2026-09-02 11:00", note: "초안", change: null, result: settle(v1Expenses) },
    { version: 2, status: "current", created_at: "2026-09-04 16:20", note: "지은 이의 반영", change: "e09 오아시스 스파 분담에서 지은 제외", result: settle(expenses) }
  ];

  var stages = [
    { key: "collecting", label: "체크인", cond: "멤버·결제자·통화·분담·원본 목록이 모두 확인됨" },
    { key: "reviewing", label: "검수", cond: "모든 지출의 금액·통화가 확정되고 정산 초안 불변식이 통과함", sla: true },
    { key: "awaiting_organizer", label: "탑승 승인", cond: "총무가 해당 버전을 승인함" },
    { key: "participant_review", label: "순항 검토", cond: "검토창이 종료되고 미해결 금액 이의가 0건임" },
    { key: "finalized", label: "착륙 잠금", cond: "총무 잠금 요청과 내부 QA 승인으로 스냅샷이 잠김" },
    { key: "delivered", label: "도착", cond: "정산 결과가 전달되고 삭제 예정일이 기록됨" }
  ];

  var window2 = { opens_at: "2026-09-05 10:12", closes_at: "2026-09-08 18:00", days_left: 2 };
  var decisionsOpen = [
    { member_id: "m_minsu", decision: "approved", at: "2026-09-05 12:30" },
    { member_id: "m_harin", decision: "approved", at: "2026-09-05 21:05" },
    { member_id: "m_seojun", decision: "objection", at: "2026-09-06 09:40", reason: "택시비 2건이 중복 같아요" },
    { member_id: "m_jieun", decision: "not_responded" }
  ];
  var decisionsResolved = [
    { member_id: "m_minsu", decision: "approved", at: "2026-09-05 12:30" },
    { member_id: "m_harin", decision: "approved", at: "2026-09-05 21:05" },
    { member_id: "m_seojun", decision: "withdrawn", at: "2026-09-07 15:20", reason: "운영자 확인: 26일과 30일 택시는 다른 건" },
    { member_id: "m_jieun", decision: "not_responded" }
  ];

  var scenes = {
    landing: { intake_on: { intake: true }, intake_off: { intake: false } },
    review: {
      awaiting_organizer: { stage: "awaiting_organizer", version: 2, organizer_approved_at: null, window: null, decisions: [], locked_at: null, qa_at: null },
      participant_review: { stage: "participant_review", version: 2, organizer_approved_at: "2026-09-05 10:12", window: window2, decisions: decisionsOpen, locked_at: null, qa_at: null },
      finalized: { stage: "finalized", version: 2, organizer_approved_at: "2026-09-05 10:12", window: Object.assign({}, window2, { days_left: 0 }), decisions: decisionsResolved, locked_at: "2026-09-09 11:00", qa_at: "2026-09-09 10:40" }
    },
    share: {
      notice: { viewer_id: "m_jieun", stage: "participant_review", version: 2, expired: false, window: window2, decisions: decisionsOpen },
      active: { viewer_id: "m_jieun", stage: "participant_review", version: 2, expired: false, window: window2, decisions: decisionsOpen },
      expired: { viewer_id: "m_jieun", stage: "participant_review", version: 2, expired: true, window: null, decisions: [] }
    },
    operator: {
      queue: { view: "queue", selected: "C-014" },
      case: { view: "case", selected: "C-014" },
      login: { view: "login", selected: null }
    }
  };

  var cases = [
    { id: "C-014", trip_name: "방콕 4박", product: "마감 대행형", stage: "reviewing", sla_hours_left: 5, paused_reason: null, next_action: "영수증 2건 통화 확정", blockers: ["통화 미확정 1건", "미상 결제자 1건"],
      checklist: [
        { label: "멤버·결제자 확인", ok: true, note: null },
        { label: "통화·분담 확인", ok: false, note: "통화 미확정 1건" },
        { label: "원본 목록 수집", ok: true, note: null },
        { label: "OCR 검수", ok: false, note: "2건 남음" },
        { label: "정산 초안 불변식", ok: false, note: "미상 결제자 1건" }
      ] },
    { id: "C-013", trip_name: "다낭 3박", product: "검수형", stage: "collecting", sla_hours_left: null, paused_reason: "고객 답변 대기", next_action: "결제자 확인 답변 대기", blockers: [], checklist: [] },
    { id: "C-012", trip_name: "오사카 2박", product: "검수형", stage: "participant_review", sla_hours_left: null, paused_reason: null, next_action: "이의 1건 확인", blockers: [], checklist: [], objections: 1 }
  ];

  var invariants = [
    { label: "각 지출의 분담액 합계 = 해당 지출의 KRW 환산액", ok: true },
    { label: "모든 멤버의 net 합계 = 0", ok: true },
    { label: "모든 송금액은 양수 정수 원", ok: true },
    { label: "미상 결제자 또는 미해결 제외 지출 = 0건", ok: false },
    { label: "적용된 expense version과 fx quote가 존재", ok: false },
    { label: "총무의 해당 버전 승인·잠금 요청 완료", ok: null },
    { label: "참여자 이의가 해결 또는 명시적으로 철회됨", ok: null },
    { label: "내부 QA와 릴리스 승인 완료", ok: null }
  ];

  var receipt_compare = {
    expense_id: "e07", title: "쩟페어 야시장",
    ocr: { amount: "1,250", currency: "(미확정)", merchant: "Jodd Fairs", date: "2026-08-28", confidence: "금액 0.93 · 통화 0.41" },
    corrected: { amount: "1,250", currency: "THB", merchant: "쩟페어 야시장", date: "2026-08-28 19:40" },
    reviewer: "reviewer", approved_at: null
  };

  var pricing = [
    { key: "review", name: "검수형", price: 29000, members: "최대 5명", items: "최대 30건", sla: "완전한 자료 접수 후 48시간", revisions: "수정 묶음 1회", support: "참여자 배포는 총무가 수행", refund: "최종 잠금 전 취소 시 전액 환불", featured: false },
    { key: "deadline", name: "마감 대행형", price: 59000, members: "최대 8명", items: "최대 80건", sla: "완전한 자료 접수 후 24시간", revisions: "수정 묶음 2회", support: "응답 추적과 총무가 보내는 1회 알림 문구 지원", refund: "최종 잠금 전 취소 시 전액 환불", featured: true }
  ];

  var eligibility = {
    include: [
      "한국어로 상담할 수 있는 20~39세 성인 여행 총무",
      "친구 중심 3~8명 해외여행",
      "여행이 끝났거나 종료와 필수 자료 완성이 접수 후 7일 이내로 확정됨",
      "총무가 멤버별 결제자·참여자·통화·영수증을 확인할 수 있음",
      "참여자가 읽기 전용 결과를 확인할 수 있음",
      "고객 자금이 TripMoney를 통과하지 않는 흐름에 동의함"
    ],
    exclude: [
      "미성년자가 직접 계약·결제하는 여행",
      "9명 이상 단체, 공개 모집형 패키지, 불특정 다수 여행",
      "법인 출장비·세금 증빙·회사 회계 승인이 필요한 사례",
      "해외송금 또는 외국 은행 송금이 필수인 사례",
      "카드·은행 자동연동 또는 자금 보관을 요구하는 사례",
      "여행 종료 후 60일을 넘긴 대량 사후 복구 사례"
    ]
  };

  var notices = {
    funds: "고객 자금은 TripMoney를 거치지 않습니다. 송금은 참여자가 직접 합니다.",
    contacts: "참여자의 전화번호와 이메일을 받지 않습니다. 결과 링크는 총무가 직접 전달합니다.",
    retention: "정산 자료는 보유기간이 끝나면 자동으로 삭제됩니다. 기간은 검토 전 문구입니다.",
    abroad: "영수증 OCR과 환율 조회에 국외 처리가 포함될 수 있습니다. 검토 전 문구입니다."
  };

  return {
    trip: trip, members: members, fx: fx, expenses: expenses, versions: versions, stages: stages, scenes: scenes,
    cases: cases, invariants: invariants, receipt_compare: receipt_compare, pricing: pricing, eligibility: eligibility,
    notices: notices, policy_version: "2026-09-draft", revision_quota: { total: 2, used: 1 }, settle: settle, krw: krw
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TM_DATA;
```

- [ ] **Step 4: 통과 확인**

Run: `node --test docs/design/mockups/tests/data.test.cjs`
Expected: PASS 9개

- [ ] **Step 5: 커밋**

```bash
git add docs/design/mockups/data.js docs/design/mockups/tests/data.test.cjs
git commit -m "design: 목업 합성 데이터와 정산 계산

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 공통 컴포넌트 `components.js`

**Files:**
- Create: `docs/design/mockups/components.js`
- Create: `docs/design/mockups/tests/components.test.cjs`

**Interfaces:**
- Consumes: 없음(전역 `TM_DATA`에 의존하지 않는다).
- Produces: 전역 `TM_UI`. 함수는 `esc(s)`, `won(n)`, `money(amount, currency, krwAmount)`, `stamp(kind, date, extra?)`(kind는 `organizer|participant|objection|withdrawn|qa|locked`), `tag(state)`(state는 `verified|ocr_only|manual|deleted`), `pass(transfer, opts?)`(transfer는 `{from,to,amount}`, opts는 `{index,total,action:{label,onclick}}`), `rail(stages, currentKey, opts?)`(opts는 `{badge, compact}`), `pill(text, tone)`(tone은 `ok|wait|bad|info|""`), `btn(label, opts?)`(opts는 `{secondary, disabled, onclick, href, block}`), `mocknav(page, states, current)`, `stateFromUrl(defaultState, allowed)`, `motifKinds(html)`, 상수 `STAMPS`, `TAGS`.

- [ ] **Step 1: 실패하는 컴포넌트 테스트 작성**

```js
// docs/design/mockups/tests/components.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers.cjs");

test("esc는 HTML 특수문자를 이스케이프한다", () => {
  const ui = load("components.js");
  assert.equal(ui.esc('<a href="x">&\'</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
});

test("won은 원화 기호와 천 단위 구분 정수를 만든다", () => {
  const ui = load("components.js");
  assert.equal(ui.won(37217), "₩37,217");
  assert.equal(ui.won(1240000.4), "₩1,240,000");
});

test("money는 외화 뒤 통화 코드, 다음 줄 환산 원화", () => {
  const ui = load("components.js");
  const html = ui.money(2000, "THB", 77800);
  assert.match(html, /2,000 THB/);
  assert.match(html, /<br>/);
  assert.match(html, /₩77,800/);
  assert.doesNotMatch(ui.money(48000, "KRW", 48000), /<br>/);
});

test("스탬프는 여섯 종류만 허용한다", () => {
  const ui = load("components.js");
  assert.deepEqual(Object.keys(ui.STAMPS), ["organizer", "participant", "objection", "withdrawn", "qa", "locked"]);
  const html = ui.stamp("locked", "2026-09-09", "v2");
  assert.match(html, /class="stamp locked"/);
  assert.match(html, /잠금 · v2/);
  assert.match(html, /role="img"/);
  assert.throws(() => ui.stamp("approved", "2026-09-09"), /unknown stamp/);
});

test("수하물 태그는 네 상태만 허용한다", () => {
  const ui = load("components.js");
  assert.deepEqual(Object.keys(ui.TAGS), ["verified", "ocr_only", "manual", "deleted"]);
  assert.match(ui.tag("ocr_only"), /OCR 미검수/);
  assert.throws(() => ui.tag("pending"), /unknown tag/);
});

test("보딩패스는 상대와 금액만 담고 계좌를 담지 않는다", () => {
  const ui = load("components.js");
  const html = ui.pass({ from: "현우", to: "민수", amount: 37217 }, { index: 1, total: 2, action: { label: "이름·금액 복사", onclick: "copyLeg(0)" } });
  assert.match(html, /송금 1 \/ 2/);
  assert.match(html, /현우 → 민수/);
  assert.match(html, /₩37,217/);
  assert.match(html, /btn btn-secondary/);
  assert.doesNotMatch(html, /계좌|은행|toss/i);
});

test("여정 레일은 6단계, 현재 단계와 SLA 표시, 배지를 그린다", () => {
  const d = load("data.js");
  const ui = load("components.js");
  const html = ui.rail(d.stages, "awaiting_organizer", { badge: "일시정지 · 고객 답변 대기" });
  assert.equal((html.match(/rail-step/g) || []).length, 6);
  assert.equal((html.match(/rail-step done/g) || []).length, 2);
  assert.equal((html.match(/rail-step current/g) || []).length, 1);
  assert.match(html, /SLA 시작/);
  assert.match(html, /rail-badge[^>]*>일시정지 · 고객 답변 대기/);
  assert.match(html, /총무가 해당 버전을 승인함/);
  assert.equal((ui.rail(d.stages, "delivered").match(/rail-step done/g) || []).length, 5);
});

test("btn과 pill", () => {
  const ui = load("components.js");
  assert.match(ui.btn("신청하기", { href: "#apply" }), /<a class="btn" href="#apply">신청하기<\/a>/);
  assert.match(ui.btn("잠금 요청", { secondary: true, disabled: true }), /class="btn btn-secondary is-disabled" disabled/);
  assert.match(ui.pill("승인 2", "ok"), /class="pill ok"/);
});

test("stateFromUrl은 허용 목록 밖이면 기본값을 준다", () => {
  const ui = load("components.js");
  globalThis.location = { search: "?state=finalized" };
  assert.equal(ui.stateFromUrl("awaiting_organizer", ["awaiting_organizer", "finalized"]), "finalized");
  globalThis.location = { search: "?state=hack" };
  assert.equal(ui.stateFromUrl("awaiting_organizer", ["awaiting_organizer", "finalized"]), "awaiting_organizer");
  delete globalThis.location;
});

test("mocknav와 motifKinds", () => {
  const ui = load("components.js");
  const nav = ui.mocknav("review", ["awaiting_organizer", "finalized"], "finalized");
  assert.match(nav, /href="index.html"/);
  assert.match(nav, /href="review.html\?state=awaiting_organizer"/);
  assert.match(nav, /class="cur"[^>]*>finalized/);
  assert.deepEqual(ui.motifKinds('<div class="pass"></div><span class="tag verified"></span>'), ["pass", "tag"]);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test docs/design/mockups/tests/components.test.cjs`
Expected: FAIL, `Cannot find module ... components.js`

- [ ] **Step 3: components.js 작성**

```js
// docs/design/mockups/components.js — 여정 레일, 서류 컴포넌트 3종, 공통 도우미
"use strict";
var TM_UI = (function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function won(n) { return "₩" + Math.round(n).toLocaleString("ko-KR"); }
  function money(amount, currency, krwAmount) {
    if (currency === "KRW") return '<span class="num">' + won(amount) + "</span>";
    return '<span class="num">' + Number(amount).toLocaleString("ko-KR") + " " + esc(currency) + '</span><br><span class="num caption">' + won(krwAmount) + "</span>";
  }

  var STAMPS = { organizer: "총무 승인", participant: "확인", objection: "이의", withdrawn: "이의 철회", qa: "내부 QA", locked: "잠금" };
  function stamp(kind, date, extra) {
    if (!STAMPS[kind]) throw new Error("unknown stamp: " + kind);
    var label = STAMPS[kind] + (extra ? " · " + extra : "");
    return '<span class="stamp ' + kind + '" role="img" aria-label="' + esc(label + " " + date) + '"><span>' + esc(label) + '</span><span class="date">' + esc(date) + "</span></span>";
  }

  var TAGS = { verified: "원본 검수", ocr_only: "OCR 미검수", manual: "수동 입력", deleted: "원본 삭제" };
  function tag(state) {
    if (!TAGS[state]) throw new Error("unknown tag: " + state);
    return '<span class="tag ' + state + '">' + TAGS[state] + "</span>";
  }

  function btn(label, opts) {
    opts = opts || {};
    var cls = "btn" + (opts.secondary ? " btn-secondary" : "") + (opts.disabled ? " is-disabled" : "") + (opts.block ? " block" : "");
    if (opts.href) return '<a class="' + cls + '" href="' + esc(opts.href) + '">' + esc(label) + "</a>";
    return '<button type="button" class="' + cls + '"' + (opts.disabled ? " disabled" : "") + (opts.onclick ? ' onclick="' + esc(opts.onclick) + '"' : "") + ">" + esc(label) + "</button>";
  }

  function pill(text, tone) { return '<span class="pill ' + (tone || "") + '">' + esc(text) + "</span>"; }

  function pass(t, opts) {
    opts = opts || {};
    var leg = opts.total ? "송금 " + opts.index + " / " + opts.total : "송금";
    var action = opts.action ? btn(opts.action.label, { secondary: true, onclick: opts.action.onclick }) : "";
    return '<div class="pass"><div class="pass-body"><span class="leg">' + esc(leg) + '</span><span class="route">' + esc(t.from) + " → " + esc(t.to) + '</span></div><div class="pass-stub"><span class="fare num">' + won(t.amount) + "</span>" + action + "</div></div>";
  }

  function rail(stages, currentKey, opts) {
    opts = opts || {};
    var idx = stages.findIndex(function (s) { return s.key === currentKey; });
    if (currentKey === "closed") idx = stages.length - 1;
    var out = '<div class="rail" role="list" aria-label="정산 진행 단계">';
    stages.forEach(function (s, i) {
      var cls = i < idx ? "done" : i === idx ? "current" : "";
      out += '<div class="rail-step ' + cls + '" role="listitem" tabindex="0">' +
        (s.sla ? '<span class="rail-sla">SLA 시작</span>' : "") +
        '<span class="rail-dot" aria-hidden="true"></span><span>' + esc(s.label) + '</span><span class="cond">' + esc(s.cond) + "</span></div>";
      if (i < stages.length - 1) out += '<span class="rail-line" aria-hidden="true"></span>';
    });
    if (opts.badge) out += '<span class="pill wait rail-badge">' + esc(opts.badge) + "</span>";
    return out + "</div>";
  }

  function mocknav(page, states, current) {
    var links = states.map(function (s) {
      return '<a href="' + page + ".html?state=" + s + '"' + (s === current ? ' class="cur"' : "") + ">" + s + "</a>";
    }).join("");
    return '<nav class="mocknav" aria-label="목업 장면 이동"><a href="index.html">허브</a><span>' + esc(page) + "</span>" + links + "</nav>";
  }

  function stateFromUrl(defaultState, allowed) {
    var q = typeof location !== "undefined" && location && location.search ? location.search : "";
    var m = /[?&]state=([a-z_]+)/.exec(q);
    var s = m ? m[1] : defaultState;
    return allowed.indexOf(s) >= 0 ? s : defaultState;
  }

  function motifKinds(html) {
    var kinds = [];
    if (/class="pass\b/.test(html)) kinds.push("pass");
    if (/class="stamp\b/.test(html)) kinds.push("stamp");
    if (/class="tag\b/.test(html)) kinds.push("tag");
    return kinds;
  }

  return { esc: esc, won: won, money: money, stamp: stamp, tag: tag, pass: pass, rail: rail, pill: pill, btn: btn, mocknav: mocknav, stateFromUrl: stateFromUrl, motifKinds: motifKinds, STAMPS: STAMPS, TAGS: TAGS };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TM_UI;
```

- [ ] **Step 4: 통과 확인**

Run: `node --test docs/design/mockups/tests/components.test.cjs`
Expected: PASS 10개

- [ ] **Step 5: 커밋**

```bash
git add docs/design/mockups/components.js docs/design/mockups/tests/components.test.cjs
git commit -m "design: 여정 레일과 서류 컴포넌트 3종

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 공개 랜딩 `render-landing.js` + `landing.html`

**Files:**
- Create: `docs/design/mockups/render-landing.js`
- Create: `docs/design/mockups/landing.html`
- Modify: `docs/design/mockups/tokens.css` (파일 끝에 "랜딩 전용" 구획 추가)
- Create: `docs/design/mockups/tests/render-landing.test.cjs`

**Interfaces:**
- Consumes: `TM_DATA`(Task 3), `TM_UI`(Task 4).
- Produces: 전역 `TM_RENDER_LANDING`. `render(data, stateKey)`는 `stateKey`가 `intake_on`|`intake_off`일 때 전체 페이지 HTML 문자열을 돌려준다. `submit(event)`는 신청 폼 제출을 화면 안에서 처리한다. `FEATURE_COLORS`는 `["lavender","peach","mint","ochre","navy"]`이다.
- 구획 id 순서: `top`, `features`, `flow`, `pricing`, `eligibility`, `notices`, `apply`, `cta`, `policy`.

- [ ] **Step 1: 실패하는 랜딩 렌더 테스트 작성**

```js
// docs/design/mockups/tests/render-landing.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, read } = require("./helpers.cjs");

function page(state) {
  const d = load("data.js");
  const r = load("render-landing.js");
  return r.render(d, state);
}
const filled = (html) => (html.match(/class="btn(?: block)?"/g) || []).length;
const between = (html, a, b) => html.slice(html.indexOf(a), b ? html.indexOf(b) : undefined);

test("구획 순서가 스펙 5.1과 같다", () => {
  const html = page("intake_on");
  const ids = ["top", "features", "flow", "pricing", "eligibility", "notices", "apply", "cta", "policy"];
  const pos = ids.map((id) => html.indexOf(`id="${id}"`));
  pos.forEach((p, i) => assert.ok(p >= 0, `${ids[i]} 없음`));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos);
});

test("헤드라인과 h1 하나", () => {
  const html = page("intake_on");
  assert.equal((html.match(/<h1/g) || []).length, 1);
  assert.match(html, /<h1>근거가 남는 해외여행 최종 정산<\/h1>/);
  assert.match(html, /3~8명 여행이 운영 범위/);
});

test("특징 카드 5장, 표현색 연속 반복 없음, 각 카드에 UI 조각", () => {
  const html = page("intake_on");
  const colors = [...html.matchAll(/class="feature (\w+)"/g)].map((m) => m[1]);
  assert.equal(colors.length, 5);
  for (let i = 1; i < colors.length; i++) assert.notEqual(colors[i], colors[i - 1]);
  assert.equal((html.match(/class="fragment"/g) || []).length, 5);
});

test("채운 버튼은 히어로·가격·마무리 CTA에 하나씩, 헤더는 보조형", () => {
  const html = page("intake_on");
  assert.equal(filled(html), 3);
  const header = between(html, "<header", "<main");
  assert.equal(filled(header), 0);
  assert.match(header, /btn btn-secondary/);
  assert.equal(filled(between(html, 'id="apply"', 'id="cta"')), 0);
});

test("가격 셀 2개, 마감 대행형은 반전 강조", () => {
  const html = between(page("intake_on"), 'id="pricing"', 'id="eligibility"');
  assert.match(html, /₩29,000/);
  assert.match(html, /₩59,000/);
  assert.equal((html.match(/class="price featured"/g) || []).length, 1);
  assert.match(html, /완전한 자료 접수 후 24시간/);
  assert.match(html, /최종 잠금 전 취소 시 전액 환불/);
});

test("적격·제외 조건 6+6과 고지 4칸", () => {
  const html = page("intake_on");
  const el = between(html, 'id="eligibility"', 'id="notices"');
  assert.equal((el.match(/<li>/g) || []).length, 12);
  const no = between(html, 'id="notices"', 'id="apply"');
  assert.equal((no.match(/class="card notice"/g) || []).length, 4);
  assert.ok((no.match(/검토 전 문구/g) || []).length >= 2);
});

test("신청 폼은 연락수단 1개, 기본 해제 동의, 정책 버전이며 모티프가 없다", () => {
  const d = load("data.js");
  const form = between(page("intake_on"), "<form", "</form>");
  assert.match(form, /name="contact"/);
  assert.match(form, /type="checkbox" name="consent"/);
  assert.doesNotMatch(form, /checked/);
  assert.ok(form.includes(d.policy_version));
  assert.deepEqual(load("components.js").motifKinds(form), []);
  assert.doesNotMatch(form, /name="(name|trip_name|destination|price)"/);
});

test("접수 비활성 변형은 폼 대신 안내만 둔다", () => {
  const html = page("intake_off");
  assert.doesNotMatch(html, /<form/);
  assert.match(html, /지금은 신청을 받지 않습니다/);
});

test("푸터는 워드마크와 정책 링크 3개, 계좌·Toss 없음, 대문자·그라데이션 없음", () => {
  const html = page("intake_on");
  const footer = between(html, "<footer");
  assert.match(footer, /class="wordmark latin"/);
  assert.equal((footer.match(/검토 전 문구/g) || []).length, 3);
  assert.doesNotMatch(html, /toss|\d{2,6}-\d{2,6}-\d{4,8}|계좌번호\s*[:：]|은행명\s*[:：]/i);
  assert.doesNotMatch(read("tokens.css") + read("landing.html"), /text-transform\s*:\s*uppercase|linear-gradient/);
  assert.ok(load("components.js").motifKinds(html).length <= 3);
});

test("landing.html은 스크립트를 순서대로 불러오고 모듈·fetch를 쓰지 않는다", () => {
  const html = read("landing.html");
  const order = ["data.js", "components.js", "render-landing.js"].map((f) => html.indexOf(`src="${f}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order[0] > 0);
  assert.doesNotMatch(html, /type="module"|fetch\(|Space\+Grotesk|Inter/);
  assert.match(html, /lang="ko"/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test docs/design/mockups/tests/render-landing.test.cjs`
Expected: FAIL, `Cannot find module ... render-landing.js`

- [ ] **Step 3: tokens.css 끝에 랜딩 전용 구획 추가**

```css
/* ---- 랜딩 전용 ---- */
.top{position:sticky;top:0;background:rgba(255,250,240,.94);border-bottom:1px solid var(--line);z-index:5}
.top .nav{height:64px}
.brand{font-size:20px;font-weight:600;color:var(--ink);text-decoration:none}
.navlinks{display:flex;gap:20px;align-items:center;font-size:14px}
.navlinks a{color:var(--ink);text-decoration:none}
.hero-grid{display:grid;grid-template-columns:7fr 5fr;gap:48px;align-items:center}
@media(max-width:1023px){.hero-grid{grid-template-columns:1fr}}
.lead{font-size:20px;color:var(--mut)}
.facts{list-style:none;display:grid;gap:8px;font-size:14px}
.facts li::before{content:"·";margin-right:8px;color:var(--amber)}
.btn-row{display:flex;gap:12px;flex-wrap:wrap}
.hero-art{box-shadow:none}
.stamp-row{display:flex;gap:8px;flex-wrap:wrap}
.stamp-row .stamp{width:84px;height:84px;font-size:11px}
.feature h3,.card > h3{font-size:20px}
.conds{list-style:none;margin-top:24px;font-size:14px}
.price{display:grid;gap:12px;border-radius:16px;padding:32px}
.price.featured{background:var(--navy);color:#FFFDF7}
.price.featured .eyebrow,.price.featured .meta{color:#D9DEE8}
.price.featured .btn{background:#FFFDF7;color:var(--navy);border-color:#FFFDF7}
.price-num{font-size:40px;font-weight:600;letter-spacing:-0.02em}
.plist{list-style:none;display:grid;gap:6px;font-size:14px}
.plist li{padding-left:16px;position:relative}
.plist li::before{content:"·";position:absolute;left:4px}
.notice-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
@media(max-width:1023px){.notice-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:767px){.notice-grid{grid-template-columns:1fr}}
.form-msg{min-height:20px;font-size:14px;color:var(--rose)}
.footer{background:var(--canvas);padding:80px 0 40px;border-top:1px solid var(--line)}
.wordmark{font-size:96px;line-height:1;color:var(--ink);margin-bottom:24px}
@media(max-width:767px){.wordmark{font-size:56px}}
.footer nav{display:flex;gap:20px;flex-wrap:wrap;font-size:14px;margin-bottom:12px}
```

- [ ] **Step 4: render-landing.js 작성**

```js
// docs/design/mockups/render-landing.js — 공개 랜딩
"use strict";
var TM_RENDER_LANDING = (function () {
  var U = TM_UI;
  var FEATURE_COLORS = ["lavender", "peach", "mint", "ochre", "navy"];

  function header() {
    return '<header class="top"><div class="shell between nav"><a class="brand latin" href="#top">TripMoney</a>' +
      '<nav class="navlinks" aria-label="주요 메뉴"><a href="#flow">절차</a><a href="#pricing">가격</a><a href="#apply">신청</a>' +
      U.btn("신청하기", { secondary: true, href: "#apply" }) + "</nav></div></header>";
  }

  function expenseRow(d, e) {
    return '<div class="between"><div><b>' + U.esc(e.title) + "</b><br>" + U.money(e.amount, e.currency, d.krw(e)) + "</div>" + U.tag(e.evidence) + "</div>";
  }
  function fxTable(d) {
    return '<table class="table">' + d.fx.map(function (f) {
      return "<tr><td>" + U.esc(f.pair) + '</td><td class="num">' + f.rate + "</td><td>" + U.esc(f.source) + '<br><span class="caption">' + U.esc(f.as_of) + (f.manual_reason ? " · " + U.esc(f.manual_reason) : "") + "</span></td></tr>";
    }).join("") + "</table>";
  }
  function queueFragment(d) {
    return '<table class="table">' + d.cases.map(function (c) {
      return "<tr><td class=\"num\">" + U.esc(c.id) + "</td><td>" + U.esc(c.product) + "</td><td>" + (c.paused_reason ? U.pill("일시정지", "wait") : c.sla_hours_left != null ? U.pill("SLA " + c.sla_hours_left + "h", "info") : U.pill("검토창", "")) + "</td></tr>";
    }).join("") + "</table>";
  }

  function hero(d) {
    var v = d.versions[1].result, t = v.transfers[0], e = d.expenses[0];
    return '<section class="section" id="top"><div class="shell hero-grid">' +
      '<div class="stack"><p class="eyebrow">해외여행 총무를 위한 유료 정산 검수</p><h1>근거가 남는 해외여행 최종 정산</h1>' +
      '<p class="lead">영수증, 환율, 분담 근거를 사람이 검수하고 참여자 확인까지 거친 최종 정산을 전달합니다.</p>' +
      '<ul class="facts"><li>고객 자금을 보관하지 않습니다</li><li>3~8명 여행이 운영 범위입니다</li><li>여행이 끝난 뒤 정산합니다</li></ul>' +
      '<div class="btn-row">' + U.btn("신청하기", { href: "#apply" }) + U.btn("절차 보기", { secondary: true, href: "#flow" }) + "</div></div>" +
      '<div class="card-lg hero-art" role="img" aria-label="완성된 정산 결과 예시"><div class="stack">' + U.pass(t, { index: 1, total: v.transfers.length }) +
      '<div class="card">' + expenseRow(d, e) + "</div>" +
      '<div style="text-align:right">' + U.stamp("organizer", "2026-09-05") + "</div></div></div></div></section>";
  }

  function features(d) {
    var v = d.versions[1].result;
    var items = [
      { title: "근거가 붙은 지출", body: "모든 지출에 영수증 근거 상태가 태그로 남습니다.", fragment: expenseRow(d, d.expenses[6]) },
      { title: "출처가 있는 환율", body: "환율마다 출처와 시각, 수동 입력 사유를 기록합니다.", fragment: fxTable(d) },
      { title: "송금 한 건이 한 장", body: "최소 송금 제안을 보딩패스로 보여줍니다.", fragment: U.pass(v.transfers[0]) },
      { title: "참여자가 직접 확인", body: "승인, 이의, 철회가 스탬프로 남고 무응답은 승인이 아닙니다.", fragment: '<div class="stamp-row">' + U.stamp("participant", "09-05") + U.stamp("objection", "09-06") + U.stamp("withdrawn", "09-07") + "</div>" },
      { title: "SLA가 보이는 운영", body: "검수 시작부터 초안 전달까지 걸린 시간을 추적합니다.", fragment: queueFragment(d) }
    ];
    return '<section class="section" id="features"><div class="shell"><h2>정산이 끝나도 근거는 남습니다</h2><div class="grid-3" style="margin-top:32px">' +
      items.map(function (it, i) {
        return '<article class="feature ' + FEATURE_COLORS[i] + '"><h3>' + U.esc(it.title) + "</h3><p>" + U.esc(it.body) + '</p><div class="fragment">' + it.fragment + "</div></article>";
      }).join("") + "</div></div></section>";
  }

  function flow(d) {
    return '<section class="band-paper" id="flow"><div class="shell"><h2>여섯 단계, 한 줄로</h2><p class="meta">검수 단계에 들어갈 때 SLA 시계가 시작됩니다. 각 단계를 누르면 종료 조건이 보입니다.</p>' +
      U.rail(d.stages, "reviewing") + '<ol class="conds grid-3">' + d.stages.map(function (s) {
        return "<li><b>" + U.esc(s.label) + '</b><br><span class="meta">' + U.esc(s.cond) + "</span></li>";
      }).join("") + "</ol></div></section>";
  }

  function pricing(d) {
    return '<section class="section" id="pricing"><div class="shell"><h2>가격은 결제할 금액 그대로</h2><div class="grid-2" style="margin-top:32px">' +
      d.pricing.map(function (p) {
        return '<article class="' + (p.featured ? "price featured" : "price card") + '"><p class="eyebrow">' + U.esc(p.name) + '</p><p class="price-num num">' + U.won(p.price) + '<span class="meta"> / 여행</span></p>' +
          '<ul class="plist"><li>' + U.esc(p.members) + " · " + U.esc(p.items) + "</li><li>초안 SLA: " + U.esc(p.sla) + "</li><li>" + U.esc(p.revisions) + "</li><li>" + U.esc(p.support) + "</li><li>" + U.esc(p.refund) + "</li></ul>" +
          U.btn(p.name + " 신청하기", { href: "#apply", secondary: !p.featured, block: true }) + "</article>";
      }).join("") + "</div></div></section>";
  }

  function eligibility(d) {
    var list = function (arr) { return "<ul class=\"plist\">" + arr.map(function (x) { return "<li>" + U.esc(x) + "</li>"; }).join("") + "</ul>"; };
    return '<section class="section" id="eligibility"><div class="shell"><h2>처음부터 모두를 받지 않습니다</h2><div class="grid-2" style="margin-top:32px">' +
      '<article class="card"><h3>이런 여행을 받습니다</h3>' + list(d.eligibility.include) + "</article>" +
      '<article class="card"><h3>이런 사례는 받지 않습니다</h3>' + list(d.eligibility.exclude) + "</article></div></div></section>";
  }

  function notices(d) {
    var n = d.notices;
    var cell = function (title, body, draft) { return '<article class="card notice"><h3>' + title + "</h3><p>" + U.esc(body) + "</p>" + (draft ? U.pill("검토 전 문구", "wait") : "") + "</article>"; };
    return '<section class="section" id="notices"><div class="shell"><h2>돈은 맡지 않고, 정보는 최소로</h2><div class="notice-grid" style="margin-top:32px">' +
      cell("자금", n.funds, false) + cell("참여자 연락처", n.contacts, false) + cell("보유기간", n.retention, true) + cell("국외처리", n.abroad, true) + "</div></div></section>";
  }

  function apply(d, st) {
    if (!st.intake) {
      return '<section class="section" id="apply"><div class="shell"><div class="card"><h3>지금은 신청을 받지 않습니다</h3><p class="meta">접수가 다시 열리면 이 자리에 신청 폼이 나타납니다. 정책 문서는 아래에서 볼 수 있습니다.</p><a href="#policy">정책 보기</a></div></div></section>';
    }
    return '<section class="section" id="apply"><div class="shell"><div class="grid-2"><div><h2>유료 베타 신청</h2><p class="meta">연락 수단 하나만 받습니다. 이름, 여행명, 계좌는 받지 않습니다.</p></div>' +
      '<form class="card stack" id="betaForm" onsubmit="return TM_RENDER_LANDING.submit(event)">' +
      '<label class="field">이메일 또는 휴대전화 번호<input class="input" name="contact" placeholder="name@example.com" autocomplete="off"></label>' +
      '<label class="check"><input type="checkbox" name="consent"><span>신청 처리를 위해 연락 수단을 보관하는 데 동의합니다. 정책 버전 ' + U.esc(d.policy_version) + " (검토 전 문구)</span></label>" +
      '<p class="form-msg" aria-live="polite"></p>' +
      '<button type="submit" class="btn btn-secondary block">신청 보내기</button></form></div></div></section>';
  }

  function cta() {
    return '<section class="section" id="cta"><div class="shell"><div class="cta-band"><h2>다음 여행의 정산은 근거와 함께 끝내세요</h2><p class="lead" style="margin:12px 0 24px">여행이 끝난 뒤 자료만 보내면, 검수된 정산과 참여자 확인 결과를 받습니다.</p>' + U.btn("신청하기", { href: "#apply" }) + "</div></div></section>";
  }

  function footer(d) {
    return '<footer class="footer" id="policy"><div class="shell"><p class="wordmark latin">TripMoney</p><nav aria-label="정책 문서"><a href="#policy">약관 (검토 전 문구)</a><a href="#policy">개인정보 처리방침 (검토 전 문구)</a><a href="#policy">국외처리 고지 (검토 전 문구)</a></nav><p class="caption">사업자 정보 자리 · 정책 버전 ' + U.esc(d.policy_version) + "</p></div></footer>";
  }

  function render(d, stateKey) {
    var st = d.scenes.landing[stateKey];
    return header() + "<main>" + hero(d) + features(d) + flow(d) + pricing(d) + eligibility(d) + notices(d) + apply(d, st) + cta() + "</main>" + footer(d);
  }

  function submit(ev) {
    ev.preventDefault();
    var f = ev.target, contact = f.contact.value.trim(), msg = f.querySelector(".form-msg");
    var ok = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(contact) || /^01\d-?\d{3,4}-?\d{4}$/.test(contact);
    if (!ok) { msg.textContent = "이메일 또는 휴대전화 번호 하나를 입력해 주세요"; return false; }
    if (!f.consent.checked) { msg.textContent = "동의에 체크해야 신청할 수 있습니다"; return false; }
    msg.style.color = "var(--green)";
    msg.textContent = "신청이 접수됐습니다 (목업이라 저장되지 않습니다)";
    return false;
  }

  return { render: render, submit: submit, FEATURE_COLORS: FEATURE_COLORS };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TM_RENDER_LANDING;
```

- [ ] **Step 5: landing.html 작성**

```html
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TripMoney · 근거가 남는 해외여행 최종 정산 (목업)</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" as="style" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<link rel="stylesheet" href="tokens.css">
</head>
<body>
<div id="mocknav"></div>
<div id="app"></div>
<script src="data.js"></script>
<script src="components.js"></script>
<script src="render-landing.js"></script>
<script>
(function () {
  var states = Object.keys(TM_DATA.scenes.landing);
  var s = TM_UI.stateFromUrl("intake_on", states);
  document.getElementById("mocknav").innerHTML = TM_UI.mocknav("landing", states, s);
  document.getElementById("app").innerHTML = TM_RENDER_LANDING.render(TM_DATA, s);
})();
</script>
</body>
</html>
```

- [ ] **Step 6: 통과 확인**

Run: `node --test docs/design/mockups/tests/`
Expected: 지금까지의 모든 테스트 PASS (smoke는 index.html이 없어 아직 FAIL 1개 남는다. Task 9에서 해소한다.)

- [ ] **Step 7: 브라우저에서 두 장면 확인**

`docs/design/mockups/landing.html`과 `landing.html?state=intake_off`를 연다. 히어로 오른쪽에 보딩패스·태그·스탬프가 보이고, 특징 카드 다섯 장의 색이 서로 다르며, 폼에서 빈 값 제출 시 오류 문구가 나오는지 본다. 콘솔 오류가 없어야 한다.

- [ ] **Step 8: 커밋**

```bash
git add docs/design/mockups/render-landing.js docs/design/mockups/landing.html docs/design/mockups/tokens.css docs/design/mockups/tests/render-landing.test.cjs
git commit -m "design: 공개 랜딩 목업

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: 총무 검토 `render-review.js` + `review.html`

**Files:**
- Create: `docs/design/mockups/render-review.js`
- Create: `docs/design/mockups/review.html`
- Modify: `docs/design/mockups/tokens.css` (파일 끝에 "앱 화면 공통" 구획 추가)
- Create: `docs/design/mockups/tests/render-review.test.cjs`

**Interfaces:**
- Consumes: `TM_DATA`, `TM_UI`.
- Produces: 전역 `TM_RENDER_REVIEW`. `render(data, stateKey)`는 장면 키(`awaiting_organizer`|`participant_review`|`finalized`)로 렌더한다. `renderState(data, sceneObject)`는 장면 객체를 직접 받는다(승인 버튼 클릭 후 재렌더에 사용). `lockConditions(scene)`는 `[{label, ok}]` 3개를 돌려준다. `approve()`, `copyText(text)`, `preview()`, `closeModal()`는 화면 상호작용이다.
- 구획 id 순서: `result`, `evidence`, `lock-conditions`, `revision`(잠금 후 없음), `approval`, `participants`, `lock-request`, `share`(총무 승인 전 없음).

- [ ] **Step 1: 실패하는 총무 검토 렌더 테스트 작성**

```js
// docs/design/mockups/tests/render-review.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, read } = require("./helpers.cjs");

function page(state) {
  const d = load("data.js");
  return { d, html: load("render-review.js").render(d, state) };
}
const filled = (html) => (html.match(/class="btn(?: block)?"/g) || []).length;
const between = (html, a, b) => html.slice(html.indexOf(a), b ? html.indexOf(b) : undefined);

test("승인 대기: 현재 단계 탑승 승인, 채운 버튼은 승인 하나, 잠금 조건 3개 미충족, 공유 구획 없음", () => {
  const { html } = page("awaiting_organizer");
  assert.match(html, /rail-step current[^>]*>(?:(?!<\/div>).)*탑승 승인/s);
  assert.equal(filled(html), 1);
  assert.match(html, /class="btn"[^>]*onclick="TM_RENDER_REVIEW.approve\(\)"[^>]*>이 버전 승인/);
  const lock = between(html, 'id="lock-conditions"', 'id="revision"');
  assert.equal((lock.match(/class="pill wait"/g) || []).length, 3);
  assert.doesNotMatch(html, /id="share"/);
  assert.doesNotMatch(html, /class="stamp organizer"/);
  assert.match(html, /정산 제외 항목 없음/);
});

test("구획 순서가 스펙 5.2와 같다", () => {
  const { html } = page("participant_review");
  const ids = ["result", "evidence", "lock-conditions", "revision", "approval", "participants", "lock-request", "share"];
  const pos = ids.map((id) => html.indexOf(`id="${id}"`));
  pos.forEach((p, i) => assert.ok(p >= 0, `${ids[i]} 없음`));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos);
});

test("참여자 검토 중: 총무 스탬프, 승인 2·이의 1·무응답 1, 잠금 요청 비활성 사유, 채운 버튼은 링크 복사", () => {
  const { html } = page("participant_review");
  assert.match(html, /class="stamp organizer"/);
  assert.match(html, />승인 2</);
  assert.match(html, />이의 1</);
  assert.match(html, />무응답 1</);
  assert.match(html, /택시비 2건이 중복 같아요/);
  const lock = between(html, 'id="lock-request"', 'id="share"');
  assert.match(lock, /is-disabled" disabled[^>]*>최종 잠금 요청/);
  assert.match(lock, /검토창 종료 후 활성화/);
  assert.equal(filled(html), 1);
  assert.match(between(html, 'id="share"'), /class="btn"[^>]*>참여자 링크 복사/);
});

test("잠금 완료: 잠금 스탬프 v2, 수정 요청 없음, 원본 삭제 태그, 조건 모두 충족", () => {
  const { html } = page("finalized");
  assert.match(html, /class="stamp locked"[^>]*aria-label="잠금 · v2 2026-09-09 11:00"/);
  assert.doesNotMatch(html, /id="revision"|<textarea/);
  assert.match(html, /원본 삭제/);
  assert.doesNotMatch(html, /원본 검수/);
  const lock = between(html, 'id="lock-conditions"', 'id="approval"');
  assert.equal((lock.match(/class="pill ok"/g) || []).length, 3);
  assert.match(html, /class="stamp qa"/);
  assert.equal(filled(html), 1);
});

test("결과와 근거: 멤버 5행, 송금 수는 v2 제안과 같고, 환율 출처 2건", () => {
  const { d, html } = page("participant_review");
  const result = between(html, 'id="result"', 'id="evidence"');
  assert.equal((result.match(/<tr class="member">/g) || []).length, 5);
  assert.equal((result.match(/class="pass"/g) || []).length, d.versions[1].result.transfers.length);
  assert.match(result, new RegExp(d.versions[1].result.total.toLocaleString("ko-KR")));
  const ev = between(html, 'id="evidence"', 'id="lock-conditions"');
  assert.equal((ev.match(/<tr class="expense">/g) || []).length, 12);
  assert.match(ev, /open\.er-api\.com/);
  assert.match(ev, /현지 환전소 영수증 기준/);
});

test("수정 요청 폼과 표에는 모티프가 없고 남은 묶음 횟수를 표시한다", () => {
  const { html } = page("awaiting_organizer");
  const rev = between(html, 'id="revision"', 'id="approval"');
  assert.match(rev, /남은 수정 묶음 1회/);
  assert.deepEqual(load("components.js").motifKinds(between(rev, "<form", "</form>")), []);
  assert.doesNotMatch(html, /toss|\d{2,6}-\d{2,6}-\d{4,8}|계좌번호\s*[:：]|은행명\s*[:：]/i);
  assert.ok(load("components.js").motifKinds(html).length <= 3);
});

test("lockConditions 규칙", () => {
  const d = load("data.js");
  const r = load("render-review.js");
  assert.deepEqual(r.lockConditions(d.scenes.review.awaiting_organizer).map((c) => c.ok), [false, false, false]);
  assert.deepEqual(r.lockConditions(d.scenes.review.participant_review).map((c) => c.ok), [true, false, false]);
  assert.deepEqual(r.lockConditions(d.scenes.review.finalized).map((c) => c.ok), [true, true, true]);
});

test("review.html 스크립트 순서와 제약", () => {
  const html = read("review.html");
  const order = ["data.js", "components.js", "render-review.js"].map((f) => html.indexOf(`src="${f}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(html, /type="module"|fetch\(/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test docs/design/mockups/tests/render-review.test.cjs`
Expected: FAIL, `Cannot find module ... render-review.js`

- [ ] **Step 3: tokens.css 끝에 앱 화면 공통 구획 추가**

```css
/* ---- 앱 화면 공통 (검토·공유·운영자) ---- */
.app-head{position:sticky;top:0;background:rgba(255,250,240,.96);border-bottom:1px solid var(--line);padding:12px 0;z-index:4}
.app-head h1{font-size:22px}
.app-main{padding:24px 0 64px}
.section-app{display:grid;gap:12px}
.section-app h2{font-size:18px}
.section-app h3{font-size:16px}
.modal h2{font-size:18px}
.legs{display:grid;gap:10px}
.cond-list{list-style:none;display:grid;gap:8px}
.cond-list li{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:14px}
.decision{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);font-size:14px}
.reason{font-size:13px;color:var(--mut)}
.stamp-inline{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--ink);color:#FFFDF7;padding:10px 16px;border-radius:12px;font-size:14px;z-index:20}
.actions-fixed{position:sticky;bottom:0;background:var(--canvas);padding:12px 0;border-top:1px solid var(--line);display:flex;gap:12px}
.pos{color:var(--green)}.neg{color:var(--rose)}
```

- [ ] **Step 4: render-review.js 작성**

```js
// docs/design/mockups/render-review.js — 총무 검토 /review/:grant
"use strict";
var TM_RENDER_REVIEW = (function () {
  var U = TM_UI;
  var current = null; // 현재 그려진 장면 객체 (상호작용 재렌더용)

  function stageLabel(d, key) { var s = d.stages.find(function (x) { return x.key === key; }); return s ? s.label : key; }
  function alias(d, id) { var m = d.members.find(function (x) { return x.id === id; }); return m ? m.alias : id; }
  function versionOf(d, st) { return d.versions.find(function (v) { return v.version === st.version; }); }

  function lockConditions(st) {
    var objections = st.decisions.filter(function (x) { return x.decision === "objection"; }).length;
    return [
      { label: "총무 본인 승인", ok: !!st.organizer_approved_at },
      { label: "참여자 검토창 종료", ok: !!(st.window && st.window.days_left === 0) },
      { label: "미해결 이의 0건", ok: !!st.window && objections === 0 }
    ];
  }

  function header(d, st) {
    return '<header class="app-head"><div class="shell-app"><div class="between"><div><p class="eyebrow">총무 검토</p><h1>' + U.esc(d.trip.name) + ' <span class="num meta">v' + st.version + "</span></h1></div>" +
      U.pill(stageLabel(d, st.stage), "info") + "</div>" + U.rail(d.stages, st.stage) + "</div></header>";
  }

  function result(d, st) {
    var v = versionOf(d, st).result;
    return '<section class="section-app card" id="result"><h2>정산 결과</h2><p class="meta">총액 <b class="num">' + U.won(v.total) + "</b> · 멤버 " + d.members.length + "명 · 지출 " + d.expenses.length + "건</p>" +
      '<table class="table"><thead><tr><th>멤버</th><th class="num">낸 돈</th><th class="num">부담</th><th class="num">순액</th></tr></thead><tbody>' +
      v.per_member.map(function (m) {
        return '<tr class="member"><td>' + U.esc(m.alias) + '</td><td class="num">' + U.won(m.paid) + '</td><td class="num">' + U.won(m.owed) + '</td><td class="num ' + (m.net >= 0 ? "pos" : "neg") + '">' + (m.net >= 0 ? "+" : "") + U.won(m.net) + "</td></tr>";
      }).join("") + "</tbody></table>" +
      '<h3>송금 제안</h3><div class="legs">' + v.transfers.map(function (t, i) {
        return U.pass(t, { index: i + 1, total: v.transfers.length, action: { label: "카톡 문구 복사", onclick: "TM_RENDER_REVIEW.copyText('" + t.from + " → " + t.to + " " + U.won(t.amount) + "')" } });
      }).join("") + "</div></section>";
  }

  function evidence(d, st) {
    var v = versionOf(d, st).result;
    var rows = d.expenses.map(function (e) {
      var tagState = st.locked_at && e.evidence === "verified" ? "deleted" : e.evidence;
      return '<tr class="expense"><td>' + U.esc(e.title) + '<br><span class="caption">' + U.esc(e.spent_at) + " · " + U.esc(alias(d, e.payer_id)) + " 결제 · " + e.split_ids.length + "명 분담</span></td><td class=\"num\">" + U.money(e.amount, e.currency, d.krw(e)) + "</td><td>" + U.tag(tagState) + "</td></tr>";
    }).join("");
    var fx = d.fx.map(function (f) {
      return "<li><b>" + U.esc(f.pair) + ' <span class="num">' + f.rate + "</span></b> · " + U.esc(f.source) + " · " + U.esc(f.as_of) + (f.manual_reason ? ' <span class="reason">수동 사유: ' + U.esc(f.manual_reason) + "</span>" : "") + "</li>";
    }).join("");
    return '<section class="section-app card" id="evidence"><h2>근거</h2><table class="table"><thead><tr><th>지출</th><th class="num">금액</th><th>근거</th></tr></thead><tbody>' + rows + "</tbody></table>" +
      "<h3>환율 출처</h3><ul class=\"cond-list\">" + fx + "</ul>" +
      '<p class="meta">정산 제외 항목 없음 · 적용 버전 v' + st.version + " · 송금 " + v.transfers.length + "건</p></section>";
  }

  function lockPanel(st) {
    return '<section class="section-app card" id="lock-conditions"><h2>잠금까지 남은 조건</h2><ul class="cond-list">' + lockConditions(st).map(function (c) {
      return "<li><span>" + U.esc(c.label) + "</span>" + U.pill(c.ok ? "충족" : "대기", c.ok ? "ok" : "wait") + "</li>";
    }).join("") + "</ul></section>";
  }

  function revision(d, st) {
    if (st.locked_at) return "";
    var left = d.revision_quota.total - d.revision_quota.used;
    return '<section class="section-app card" id="revision"><h2>수정 이력</h2><ul class="cond-list">' + d.versions.map(function (v) {
      return "<li><span>v" + v.version + " · " + U.esc(v.created_at) + " · " + U.esc(v.note) + (v.change ? ' <span class="reason">' + U.esc(v.change) + "</span>" : "") + "</span>" + U.pill(v.status === "current" ? "현재" : "이전", v.status === "current" ? "info" : "") + "</li>";
    }).join("") + "</ul>" +
      '<p class="meta">남은 수정 묶음 ' + left + "회 (마감 대행형 " + d.revision_quota.total + "회 중 " + d.revision_quota.used + "회 사용)</p>" +
      '<form class="stack" onsubmit="return TM_RENDER_REVIEW.requestRevision(event)"><label class="field">수정 요청 (한 번에 모아서)<textarea class="input" name="note" placeholder="바꿀 지출과 이유를 적어 주세요"></textarea></label><p class="form-msg" aria-live="polite"></p><button type="submit" class="btn btn-secondary">수정 요청 보내기</button></form></section>';
  }

  function approval(st) {
    var body = st.organizer_approved_at
      ? '<div class="stamp-inline">' + U.stamp("organizer", st.organizer_approved_at) + '<p class="meta">이 버전(v' + st.version + ")의 내용에 동의했습니다. 참여자 검토창이 열렸습니다.</p></div>"
      : '<p class="meta">결과와 근거를 확인했다면 이 버전을 승인합니다. 승인 뒤 참여자 검토창이 열립니다.</p>' + U.btn("이 버전 승인", { onclick: "TM_RENDER_REVIEW.approve()" });
    return '<section class="section-app card" id="approval"><h2>총무 승인</h2>' + body + "</section>";
  }

  function participants(d, st) {
    if (!st.window) return '<section class="section-app card" id="participants"><h2>참여자 현황</h2><p class="meta">총무 승인 후 참여자 검토창이 열립니다.</p></section>';
    var count = function (k) { return st.decisions.filter(function (x) { return x.decision === k; }).length; };
    var labels = { approved: ["승인", "ok"], objection: ["이의", "bad"], withdrawn: ["이의 철회", ""], not_responded: ["무응답", "wait"] };
    return '<section class="section-app card" id="participants"><h2>참여자 현황</h2><div class="stamp-inline">' +
      U.pill("승인 " + count("approved"), "ok") + U.pill("이의 " + count("objection"), "bad") + U.pill("무응답 " + count("not_responded"), "wait") + (count("withdrawn") ? U.pill("철회 " + count("withdrawn"), "") : "") + "</div>" +
      '<p class="meta">검토창 마감 ' + U.esc(st.window.closes_at) + (st.window.days_left ? " · D-" + st.window.days_left : " · 종료") + "</p>" +
      st.decisions.map(function (x) {
        var l = labels[x.decision];
        return '<div class="decision"><span>' + U.esc(alias(d, x.member_id)) + (x.reason ? '<br><span class="reason">' + U.esc(x.reason) + "</span>" : "") + "</span>" + U.pill(l[0] + (x.at ? " · " + x.at : ""), l[1]) + "</div>";
      }).join("") + "</section>";
  }

  function lockRequest(st) {
    if (st.locked_at) {
      return '<section class="section-app card" id="lock-request"><h2>최종 잠금</h2><div class="stamp-inline">' + U.stamp("locked", st.locked_at, "v" + st.version) + U.stamp("qa", st.qa_at) + '<p class="meta">잠긴 버전은 바뀌지 않습니다. 수정이 필요하면 새 버전이 만들어집니다.</p></div></section>';
    }
    var conds = lockConditions(st), allOk = conds.every(function (c) { return c.ok; });
    var reason = !st.organizer_approved_at ? "총무 승인 후 활성화" : !(st.window && st.window.days_left === 0) ? "검토창 종료 후 활성화" : "미해결 이의 해결 후 활성화";
    return '<section class="section-app card" id="lock-request"><h2>최종 잠금 요청</h2>' + U.btn("최종 잠금 요청", allOk ? { onclick: "TM_RENDER_REVIEW.requestLock()" } : { secondary: true, disabled: true }) + (allOk ? "" : '<p class="meta">' + reason + "</p>") + "</section>";
  }

  function share(d, st) {
    if (!st.organizer_approved_at) return "";
    var primaryCopy = !st.locked_at;
    return '<section class="section-app card" id="share"><h2>참여자에게 전달</h2><p class="meta">참여자 연락처를 받지 않으므로 링크는 총무가 직접 보냅니다. 미리보기에는 여행명, 버전, 기준 환율, 송금 제안만 들어갑니다.</p><div class="btn-row">' +
      U.btn("참여자 링크 복사", primaryCopy ? { onclick: "TM_RENDER_REVIEW.copyText('share.html?state=active')" } : { secondary: true, onclick: "TM_RENDER_REVIEW.copyText('share.html?state=active')" }) +
      U.btn("카카오 공유 미리보기", primaryCopy ? { secondary: true, onclick: "TM_RENDER_REVIEW.preview()" } : { onclick: "TM_RENDER_REVIEW.preview()" }) + "</div></section>";
  }

  function renderState(d, st) {
    current = st;
    return header(d, st) + '<main class="shell-app app-main stack">' + result(d, st) + evidence(d, st) + lockPanel(st) + revision(d, st) + approval(st) + participants(d, st) + lockRequest(st) + share(d, st) + '</main><div id="modal"></div>';
  }
  function render(d, key) { return renderState(d, d.scenes.review[key]); }

  function mount(html) { document.getElementById("app").innerHTML = html; }
  function toast(msg) { var t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 1800); }
  function approve() {
    var st = JSON.parse(JSON.stringify(current));
    st.organizer_approved_at = "2026-09-06 14:30"; st.stage = "participant_review";
    st.window = { opens_at: "2026-09-06 14:30", closes_at: "2026-09-09 18:00", days_left: 3 };
    st.decisions = TM_DATA.members.filter(function (m) { return m.role !== "organizer"; }).map(function (m) { return { member_id: m.id, decision: "not_responded" }; });
    mount(renderState(TM_DATA, st)); toast("v" + st.version + " 승인 · 참여자 검토창이 열렸습니다");
  }
  function requestRevision(ev) { ev.preventDefault(); var f = ev.target; var msg = f.querySelector(".form-msg"); if (!f.note.value.trim()) { msg.textContent = "바꿀 내용을 적어 주세요"; return false; } msg.style.color = "var(--green)"; msg.textContent = "수정 요청을 보냈습니다 (목업)"; return false; }
  function requestLock() { toast("잠금 요청을 보냈습니다. 내부 QA 후 잠깁니다 (목업)"); }
  function copyText(text) { if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {}); toast("복사했습니다: " + text); }
  function preview() {
    var v = versionOf(TM_DATA, current).result, fx = TM_DATA.fx[TM_DATA.fx.length - 1];
    var text = "[" + TM_DATA.trip.name + "] 정산 v" + current.version + "\n기준 환율 " + fx.pair + " " + fx.rate + " (" + fx.as_of + ")\n" + v.transfers.map(function (t) { return "· " + t.from + " → " + t.to + " " + U.won(t.amount); }).join("\n") + "\n결과 링크는 만료됩니다";
    document.getElementById("modal").innerHTML = '<div class="modal-bg" onclick="TM_RENDER_REVIEW.closeModal()"><div class="modal" role="dialog" aria-modal="true" aria-label="카카오 공유 미리보기" onclick="event.stopPropagation()"><h2>카카오 공유 미리보기</h2><pre style="white-space:pre-wrap;font-size:14px">' + U.esc(text) + "</pre>" + U.btn("닫기", { secondary: true, onclick: "TM_RENDER_REVIEW.closeModal()" }) + "</div></div>";
  }
  function closeModal() { document.getElementById("modal").innerHTML = ""; }

  return { render: render, renderState: renderState, lockConditions: lockConditions, approve: approve, requestRevision: requestRevision, requestLock: requestLock, copyText: copyText, preview: preview, closeModal: closeModal };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TM_RENDER_REVIEW;
```

- [ ] **Step 5: review.html 작성**

`landing.html`과 같은 `<head>`를 쓰되 제목은 `TripMoney · 총무 검토 (목업)`, 스크립트는 `render-review.js`, 부트스트랩은 다음과 같다.

```html
<div id="mocknav"></div>
<div id="app"></div>
<script src="data.js"></script>
<script src="components.js"></script>
<script src="render-review.js"></script>
<script>
(function () {
  var states = Object.keys(TM_DATA.scenes.review);
  var s = TM_UI.stateFromUrl("awaiting_organizer", states);
  document.getElementById("mocknav").innerHTML = TM_UI.mocknav("review", states, s);
  document.getElementById("app").innerHTML = TM_RENDER_REVIEW.render(TM_DATA, s);
})();
</script>
```

- [ ] **Step 6: 통과 확인**

Run: `node --test docs/design/mockups/tests/render-review.test.cjs`
Expected: PASS 8개

- [ ] **Step 7: 브라우저에서 세 장면과 승인 상호작용 확인**

`review.html`에서 "이 버전 승인"을 누르면 스탬프가 찍히고 참여자 현황이 무응답 4로 바뀌며 공유 구획이 나타나는지, `?state=finalized`에서 잠금 스탬프와 원본 삭제 태그가 보이는지, 375px 폭에서 레일이 옆으로 스크롤되는지 본다.

- [ ] **Step 8: 커밋**

```bash
git add docs/design/mockups/render-review.js docs/design/mockups/review.html docs/design/mockups/tokens.css docs/design/mockups/tests/render-review.test.cjs
git commit -m "design: 총무 검토 목업

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: 참여자 공유 `render-share.js` + `share.html`

**Files:**
- Create: `docs/design/mockups/render-share.js`
- Create: `docs/design/mockups/share.html`
- Modify: `docs/design/mockups/tokens.css` (파일 끝에 "참여자 공유" 구획 추가)
- Create: `docs/design/mockups/tests/render-share.test.cjs`

**Interfaces:**
- Consumes: `TM_DATA`, `TM_UI`.
- Produces: 전역 `TM_RENDER_SHARE`. `render(data, stateKey)`(`notice`|`active`|`expired`), `renderState(data, scene, mode)`(mode는 `notice`|`active`), `myTransfers(result, viewerId)`는 본인이 보내거나 받는 송금만 돌려준다. 상호작용은 `go(mode)`, `approve()`, `objectModal()`, `submitObjection(event)`, `withdraw()`, `copyText(text)`, `closeModal()`.
- `active` 화면의 구획 id 순서: `me`, `transfers`, `basis`, `decide`.

- [ ] **Step 1: 실패하는 참여자 공유 렌더 테스트 작성**

```js
// docs/design/mockups/tests/render-share.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, read } = require("./helpers.cjs");

function page(state) {
  const d = load("data.js");
  return { d, html: load("render-share.js").render(d, state) };
}
const filled = (html) => (html.match(/class="btn(?: block)?"/g) || []).length;
const between = (html, a, b) => html.slice(html.indexOf(a), b ? html.indexOf(b) : undefined);

test("고지 화면: 여섯 항목, 세 선택지, 검토 전 표시, 금액 없음", () => {
  const { html } = page("notice");
  for (const k of ["운영자", "목적", "항목", "보유기간", "국외처리", "권리"]) assert.match(html, new RegExp(`<dt>${k}</dt>`));
  assert.match(html, /class="btn"[^>]*>계속</);
  assert.match(html, />삭제 요청</);
  assert.match(html, />이의 경로</);
  assert.match(html, /검토 전 문구/);
  assert.doesNotMatch(html, /₩/);
  assert.equal(filled(html), 1);
  assert.deepEqual(load("components.js").motifKinds(html), []);
});

test("활성 화면: 본인(지은) 중심, 본인 송금만, 지출 상세 없음", () => {
  const { d, html } = page("active");
  const r = load("render-share.js");
  const v = d.versions[1].result;
  const mine = r.myTransfers(v, "m_jieun");
  assert.ok(mine.length >= 1);
  assert.match(html, /<h2>지은 님<\/h2>/);
  const tr = between(html, 'id="transfers"', 'id="basis"');
  assert.equal((tr.match(/class="pass"/g) || []).length, mine.length);
  for (const m of tr.matchAll(/class="route">([^<]+)</g)) assert.match(m[1], /지은/);
  assert.match(tr, /이름·금액 복사/);
  assert.doesNotMatch(html, /<tr class="expense">|오아시스 스파|짐톰슨 기념품/);
  assert.doesNotMatch(html, /toss|\d{2,6}-\d{2,6}-\d{4,8}|계좌번호\s*[:：]|은행명\s*[:：]/i);
});

test("활성 화면: 근거 항목과 결정 버튼, 무응답 안내, 구획 순서", () => {
  const { html } = page("active");
  const basis = between(html, 'id="basis"', 'id="decide"');
  assert.match(basis, /38\.9/);
  assert.match(basis, /반올림/);
  assert.match(basis, /원본 검수 \d+건/);
  assert.match(basis, /2026-09-04 16:20/);
  assert.match(basis, /D-2/);
  const decide = between(html, 'id="decide"');
  assert.match(decide, /class="btn"[^>]*>승인</);
  assert.match(decide, /btn btn-secondary[^>]*>이의 제기</);
  assert.match(decide, /무응답은 승인이 아닙니다/);
  assert.equal(filled(html), 1);
  const ids = ["me", "transfers", "basis", "decide"].map((id) => html.indexOf(`id="${id}"`));
  assert.deepEqual([...ids].sort((a, b) => a - b), ids);
  assert.match(html, /고지 확인 /);
  const kinds = load("components.js").motifKinds(html);
  assert.ok(kinds.every((k) => k === "pass" || k === "stamp"));
});

test("결정 후에는 스탬프와 철회 링크가 버튼을 대신한다", () => {
  const d = load("data.js");
  const r = load("render-share.js");
  const st = JSON.parse(JSON.stringify(d.scenes.share.active));
  st.decisions = st.decisions.map((x) => (x.member_id === "m_jieun" ? { member_id: "m_jieun", decision: "objection", at: "2026-09-06 15:00", reason: "스파 분담 확인 부탁" } : x));
  const html = r.renderState(d, st, "active");
  assert.match(html, /class="stamp objection"/);
  assert.match(html, />이의 철회</);
  assert.equal(filled(html), 0);
});

test("만료 화면: 여행명 없이 안내만", () => {
  const { html } = page("expired");
  assert.match(html, /더 이상 열 수 없습니다/);
  assert.match(html, /총무에게/);
  assert.doesNotMatch(html, /방콕|₩|class="rail"/);
  assert.equal(filled(html), 0);
});

test("share.html 스크립트 순서와 제약", () => {
  const html = read("share.html");
  const order = ["data.js", "components.js", "render-share.js"].map((f) => html.indexOf(`src="${f}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(html, /type="module"|fetch\(/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test docs/design/mockups/tests/render-share.test.cjs`
Expected: FAIL, `Cannot find module ... render-share.js`

- [ ] **Step 3: tokens.css 끝에 참여자 공유 구획 추가**

```css
/* ---- 참여자 공유 ---- */
.notice-list{display:grid;grid-template-columns:96px 1fr;gap:8px 12px;font-size:14px}
.notice-list dt{color:var(--mut)}
.h3{font-size:22px}
.kv{width:100%;font-size:15px}
.kv th{text-align:left;font-weight:500;color:var(--mut);padding:8px 0}
.kv td{text-align:right;padding:8px 0}
```

- [ ] **Step 4: render-share.js 작성**

```js
// docs/design/mockups/render-share.js — 참여자 공유 /share/:token
"use strict";
var TM_RENDER_SHARE = (function () {
  var U = TM_UI;
  var current = null, mode = "notice", noticeAt = null;

  function alias(d, id) { var m = d.members.find(function (x) { return x.id === id; }); return m ? m.alias : id; }
  function stageLabel(d, key) { var s = d.stages.find(function (x) { return x.key === key; }); return s ? s.label : key; }
  function versionOf(d, st) { return d.versions.find(function (v) { return v.version === st.version; }); }
  function myTransfers(result, viewerId) {
    return result.transfers.filter(function (t) { return t.from_id === viewerId || t.to_id === viewerId; });
  }

  function notice(d, st) {
    return '<main class="shell-app app-main stack" id="notice"><section class="card stack"><p class="eyebrow">정산 결과 확인 전 안내</p><h1 class="h3">결과를 보기 전에 확인해 주세요</h1>' + U.pill("검토 전 문구", "wait") +
      '<dl class="notice-list"><dt>운영자</dt><dd>TripMoney (사업자 정보 자리)</dd><dt>목적</dt><dd>여행 정산 결과 확인과 이의 접수</dd><dt>항목</dt><dd>별칭, 본인 부담과 순액, 본인이 관련된 송금</dd><dt>보유기간</dt><dd>' + U.esc(d.notices.retention) + "</dd><dt>국외처리</dt><dd>" + U.esc(d.notices.abroad) + "</dd><dt>권리</dt><dd>조회 중단, 삭제 요청, 이의 제기를 언제든 할 수 있습니다</dd></dl>" +
      '<div class="btn-row">' + U.btn("계속", { onclick: "TM_RENDER_SHARE.go('active')" }) + U.btn("삭제 요청", { secondary: true, onclick: "TM_RENDER_SHARE.toast('삭제 요청 경로 (목업)')" }) + U.btn("이의 경로", { secondary: true, onclick: "TM_RENDER_SHARE.go('active')" }) + "</div></section></main>";
  }

  function expired() {
    return '<main class="shell-app app-main" id="expired"><section class="card stack"><h1 class="h3">이 링크는 더 이상 열 수 없습니다</h1><p class="meta">만료되었거나 폐기된 결과 링크입니다. 새 링크는 총무에게 요청해 주세요.</p></section></main>';
  }

  function active(d, st) {
    var v = versionOf(d, st).result;
    var me = v.per_member.find(function (m) { return m.id === st.viewer_id; });
    var mine = myTransfers(v, st.viewer_id);
    var my = st.decisions.find(function (x) { return x.member_id === st.viewer_id; });
    var fx = d.fx[d.fx.length - 1];
    var counts = { verified: 0, ocr_only: 0, manual: 0 };
    d.expenses.forEach(function (e) { counts[e.evidence] = (counts[e.evidence] || 0) + 1; });
    var head = '<header class="app-head"><div class="shell-app"><div class="between"><div><p class="eyebrow">참여자 확인</p><h1>' + U.esc(d.trip.name) + ' <span class="num meta">v' + st.version + "</span></h1></div>" + U.pill(stageLabel(d, st.stage), "info") + "</div>" + U.rail(d.stages, st.stage) + "</div></header>";
    var meSec = '<section class="card section-app" id="me"><h2>' + U.esc(alias(d, st.viewer_id)) + ' 님</h2><table class="kv"><tr><th>낸 돈</th><td class="num">' + U.won(me.paid) + '</td></tr><tr><th>부담</th><td class="num">' + U.won(me.owed) + '</td></tr><tr><th>순액</th><td class="num ' + (me.net >= 0 ? "pos" : "neg") + '">' + (me.net >= 0 ? "+" : "") + U.won(me.net) + "</td></tr></table></section>";
    var legs = mine.length ? mine.map(function (t, i) {
      var other = t.from_id === st.viewer_id ? t.to : t.from;
      return U.pass(t, { index: i + 1, total: mine.length, action: { label: "이름·금액 복사", onclick: "TM_RENDER_SHARE.copyText('" + other + " " + U.won(t.amount) + "')" } });
    }).join("") : '<p class="meta">보내거나 받을 송금이 없습니다</p>';
    var trSec = '<section class="card section-app" id="transfers"><h2>내가 관련된 송금</h2><p class="meta">계좌는 표시하지 않습니다. 이름과 금액을 복사해 직접 송금합니다.</p><div class="legs">' + legs + "</div></section>";
    var basis = '<section class="card section-app" id="basis"><h2>근거</h2><ul class="cond-list"><li><span>환율 기준</span><span class="num">' + U.esc(fx.pair) + " " + fx.rate + " · " + U.esc(fx.as_of) + "</span></li>" +
      "<li><span>반올림</span><span>1원 단위 균등 분담, 나머지는 앞 순서부터 1원씩</span></li>" +
      "<li><span>영수증 원본</span><span>원본 검수 " + counts.verified + "건 · OCR " + counts.ocr_only + "건 · 수동 " + counts.manual + "건</span></li>" +
      '<li><span>마지막 수정</span><span class="num">' + U.esc(versionOf(d, st).created_at) + "</span></li>" +
      '<li><span>검토창 마감</span><span class="num">' + U.esc(st.window.closes_at) + " · D-" + st.window.days_left + "</span></li></ul></section>";
    var decideBody;
    if (my && my.decision !== "not_responded") {
      var kind = { approved: "participant", objection: "objection", withdrawn: "withdrawn" }[my.decision];
      decideBody = '<div class="stamp-inline">' + U.stamp(kind, my.at || "") + (my.reason ? '<p class="reason">' + U.esc(my.reason) + "</p>" : "") + (my.decision === "objection" ? '<a href="#decide" onclick="TM_RENDER_SHARE.withdraw();return false">이의 철회</a>' : "") + "</div>";
    } else {
      decideBody = '<p class="meta">무응답은 승인이 아닙니다. 검토창이 닫히면 무응답으로 기록됩니다.</p><div class="btn-row">' + U.btn("승인", { onclick: "TM_RENDER_SHARE.approve()" }) + U.btn("이의 제기", { secondary: true, onclick: "TM_RENDER_SHARE.objectModal()" }) + "</div>";
    }
    var decide = '<section class="card section-app" id="decide"><h2>내 결정</h2>' + decideBody + "</section>";
    var foot = '<p class="caption" style="text-align:center">고지 확인 ' + U.esc(noticeAt || "2026-09-06 14:30") + " · 정책 버전 " + U.esc(d.policy_version) + "</p>";
    return head + '<main class="shell-app app-main stack">' + meSec + trSec + basis + decide + foot + '</main><div id="modal"></div>';
  }

  function renderState(d, st, m) {
    current = st; mode = m;
    if (st.expired) return expired();
    return m === "notice" ? notice(d, st) : active(d, st);
  }
  function render(d, key) { return renderState(d, d.scenes.share[key], key === "notice" ? "notice" : "active"); }

  function mount(html) { document.getElementById("app").innerHTML = html; }
  function toast(msg) { var t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 1800); }
  function go(m) { if (m === "active" && !noticeAt) noticeAt = "2026-09-06 14:30"; mount(renderState(TM_DATA, current, m)); }
  function setMyDecision(decision, reason) {
    var st = JSON.parse(JSON.stringify(current));
    st.decisions = st.decisions.filter(function (x) { return x.member_id !== st.viewer_id; });
    st.decisions.push({ member_id: st.viewer_id, decision: decision, at: "2026-09-06 15:00", reason: reason || undefined });
    mount(renderState(TM_DATA, st, "active"));
  }
  function approve() { setMyDecision("approved"); toast("승인했습니다"); }
  function withdraw() { setMyDecision("withdrawn", "본인 철회"); toast("이의를 철회했습니다"); }
  function objectModal() {
    document.getElementById("modal").innerHTML = '<div class="modal-bg" onclick="TM_RENDER_SHARE.closeModal()"><form class="modal" role="dialog" aria-modal="true" aria-label="이의 제기" onclick="event.stopPropagation()" onsubmit="return TM_RENDER_SHARE.submitObjection(event)"><h2>이의 제기</h2><label class="field">사유<textarea class="input" name="reason" placeholder="어느 항목이 왜 다른지 적어 주세요"></textarea></label><p class="form-msg" aria-live="polite"></p><div class="btn-row">' + U.btn("취소", { secondary: true, onclick: "TM_RENDER_SHARE.closeModal()" }) + '<button type="submit" class="btn">이의 보내기</button></div></form></div>';
    var ta = document.querySelector("#modal textarea"); if (ta) ta.focus();
  }
  function submitObjection(ev) {
    ev.preventDefault(); var f = ev.target, reason = f.reason.value.trim(), msg = f.querySelector(".form-msg");
    if (!reason) { msg.textContent = "사유를 적어 주세요"; return false; }
    closeModal(); setMyDecision("objection", reason); toast("이의를 보냈습니다"); return false;
  }
  function copyText(text) { if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {}); toast("복사했습니다: " + text); }
  function closeModal() { document.getElementById("modal").innerHTML = ""; }

  return { render: render, renderState: renderState, myTransfers: myTransfers, go: go, approve: approve, withdraw: withdraw, objectModal: objectModal, submitObjection: submitObjection, copyText: copyText, closeModal: closeModal, toast: toast };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TM_RENDER_SHARE;
```

- [ ] **Step 5: share.html 작성**

`landing.html`과 같은 `<head>`(제목 `TripMoney · 참여자 확인 (목업)`), 스크립트 `render-share.js`, 부트스트랩:

```html
<script>
(function () {
  var states = Object.keys(TM_DATA.scenes.share);
  var s = TM_UI.stateFromUrl("notice", states);
  document.getElementById("mocknav").innerHTML = TM_UI.mocknav("share", states, s);
  document.getElementById("app").innerHTML = TM_RENDER_SHARE.render(TM_DATA, s);
})();
</script>
```

- [ ] **Step 6: 통과 확인**

Run: `node --test docs/design/mockups/tests/render-share.test.cjs`
Expected: PASS 6개

- [ ] **Step 7: 브라우저에서 흐름 확인**

`share.html`에서 "계속"을 누르면 본인 화면으로 넘어가고 하단에 고지 확인 시각이 보이는지, "이의 제기" 모달에서 빈 사유 제출 시 오류가 나오고 사유 입력 후 이의 스탬프와 철회 링크가 나오는지, 375px 폭에서 보딩패스 스텁이 잘리지 않는지 본다.

- [ ] **Step 8: 커밋**

```bash
git add docs/design/mockups/render-share.js docs/design/mockups/share.html docs/design/mockups/tokens.css docs/design/mockups/tests/render-share.test.cjs
git commit -m "design: 참여자 공유 목업

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: 운영자 워크벤치 `render-operator.js` + `operator.html`

**Files:**
- Create: `docs/design/mockups/render-operator.js`
- Create: `docs/design/mockups/operator.html`
- Modify: `docs/design/mockups/tokens.css` (파일 끝에 "운영자" 구획 추가)
- Create: `docs/design/mockups/tests/render-operator.test.cjs`

**Interfaces:**
- Consumes: `TM_DATA`, `TM_UI`.
- Produces: 전역 `TM_RENDER_OPERATOR`. `render(data, stateKey)`(`queue`|`case`|`login`), `renderState(data, scene)`, `sortQueue(cases)`는 SLA 잔여 시간 오름차순, 그다음 검토창 케이스, 일시정지 케이스는 마지막 순으로 정렬한 새 배열을 돌려준다. `collection(caseObj)`는 자료수집 체크리스트 `[{label, ok}]` 5개를 돌려준다. `renderLeads(data)`는 마스킹된 리드 패널 HTML을 돌려준다. 상호작용은 `select(caseId)`, `showLeads()`, `showQueue()`, `login(event)`, `approveReceipt(event)`, `submitQa(event)`, `revokeLink()`, `toggleStop(checkbox)`.
- `case` 화면 구획 id 순서: `case-head`, `collect`, `receipt`, `fx`, `invariants`, `objections`, `qa`, `ops`.

- [ ] **Step 1: 실패하는 운영자 렌더 테스트 작성**

```js
// docs/design/mockups/tests/render-operator.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, read } = require("./helpers.cjs");

function page(state) {
  const d = load("data.js");
  const r = load("render-operator.js");
  return { d, r, html: r.render(d, state) };
}
const filled = (html) => (html.match(/class="btn(?: block)?"/g) || []).length;
const between = (html, a, b) => html.slice(html.indexOf(a), b ? html.indexOf(b) : undefined);

test("로그인: 이메일 하나와 안내, 채운 버튼 하나, 레일·모티프 없음", () => {
  const { html } = page("login");
  assert.match(html, /name="email"/);
  assert.match(html, /공개 가입은 없습니다/);
  assert.equal(filled(html), 1);
  assert.doesNotMatch(html, /class="rail"/);
  assert.match(html, /<h1 class="h3">직원 로그인<\/h1>/);
  assert.deepEqual(load("components.js").motifKinds(html), []);
});

test("큐: SLA 순 정렬, 일시정지는 마지막, 선택은 C-014, 검수 열기 버튼", () => {
  const { d, r, html } = page("queue");
  assert.deepEqual(r.sortQueue(d.cases).map((c) => c.id), ["C-014", "C-012", "C-013"]);
  const rows = [...html.matchAll(/class="case-row( on)?"[^>]*>\s*<b class="num">(C-\d+)</g)].map((m) => [m[2], !!m[1]]);
  assert.deepEqual(rows, [["C-014", true], ["C-012", false], ["C-013", false]]);
  assert.match(html, /SLA 남은 시간 5h/);
  assert.match(html, /일시정지 · 고객 답변 대기/);
  assert.match(html, /class="btn"[^>]*href="operator.html\?state=case"[^>]*>검수 열기/);
  assert.equal(filled(html), 1);
  assert.doesNotMatch(html, /id="receipt"/);
  const cp = between(html, 'id="case-head"', "</section>");
  assert.equal((cp.match(/class="pill ok"/g) || []).length, 2);
  assert.equal((cp.match(/class="pill bad"/g) || []).length, 3);
  assert.match(cp, /통화 미확정 1건 · 미상 결제자 1건/);
});

test("케이스 상세: 구획 순서, 자료수집 5항목, 영수증 3열, 불변식 8개", () => {
  const { html, r, d } = page("case");
  const ids = ["case-head", "collect", "receipt", "fx", "invariants", "objections", "qa", "ops"];
  const pos = ids.map((id) => html.indexOf(`id="${id}"`));
  pos.forEach((p, i) => assert.ok(p >= 0, `${ids[i]} 없음`));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos);
  assert.deepEqual(r.collection(d.cases[0]).map((c) => c.ok), [true, false, false, true, true]);
  const rc = between(html, 'id="receipt"', 'id="fx"');
  for (const h of ["원본", "OCR 추출", "수정 · 승인"]) assert.match(rc, new RegExp(`<h3>${h}</h3>`));
  assert.match(rc, /class="placeholder"/);
  assert.doesNotMatch(rc, /<img/);
  assert.match(rc, /class="btn"[^>]*>검수 승인/);
  const inv = between(html, 'id="invariants"', 'id="objections"');
  assert.equal((inv.match(/<li class="inv">/g) || []).length, 8);
  assert.equal((inv.match(/class="pill ok"/g) || []).length, 3);
  assert.equal((inv.match(/class="pill bad"/g) || []).length, 2);
  assert.equal((inv.match(/class="pill wait"/g) || []).length, 3);
  assert.equal(filled(html), 1);
});

test("QA·잠금·하단 패널: allowlist 상태, 개인정보 금지 안내, 잠금 비활성 사유, details 3개", () => {
  const { html } = page("case");
  const qa = between(html, 'id="qa"', 'id="ops"');
  assert.equal((qa.match(/<option/g) || []).length, 3);
  assert.match(qa, /연락처·원문 개인정보를 입력하지 않습니다/);
  assert.match(qa, /is-disabled" disabled[^>]*>잠금 실행/);
  assert.match(qa, /불변식 2개 실패/);
  const ops = between(html, 'id="ops"');
  assert.equal((ops.match(/<details class="card">/g) || []).length, 3);
  assert.match(ops, /링크 폐기/);
  assert.match(ops, /신규 접수 중단/);
  assert.doesNotMatch(html, /toss|\d{2,6}-\d{2,6}-\d{4,8}|계좌번호\s*[:：]|은행명\s*[:：]/i);
  const ui = load("components.js");
  for (const form of html.split("<form").slice(1)) assert.deepEqual(ui.motifKinds(form.split("</form>")[0]), []);
  assert.ok(ui.motifKinds(html).length <= 3);
});

test("리드 패널은 마스킹된 연락처만 보여준다", () => {
  const { d, r } = page("queue");
  const html = r.renderLeads(d);
  assert.match(html, /\*\*\*/);
  assert.doesNotMatch(html, /[a-z0-9]+@[a-z0-9]+\.[a-z]{2,}/i);
  assert.match(html, /QA 의견/);
  assert.match(html, /추가만 가능/);
});

test("operator.html 스크립트 순서와 제약", () => {
  const html = read("operator.html");
  const order = ["data.js", "components.js", "render-operator.js"].map((f) => html.indexOf(`src="${f}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(html, /type="module"|fetch\(/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test docs/design/mockups/tests/render-operator.test.cjs`
Expected: FAIL, `Cannot find module ... render-operator.js`

- [ ] **Step 3: tokens.css 끝에 운영자 구획 추가**

```css
/* ---- 운영자 ---- */
.op-grid{display:grid;grid-template-columns:280px minmax(0,1fr);gap:16px;align-items:start}
@media(max-width:1179px){.op-grid{grid-template-columns:1fr}}
.tabs{display:flex;gap:8px}
.tabs .pill{cursor:pointer;text-decoration:none;color:var(--mut)}
.tabs .pill.info{color:var(--blue)}
.case-row{display:block;width:100%;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:8px;cursor:pointer;font-size:14px}
.case-row.on{border-color:var(--ink)}
.case-row .caption{display:block;margin-top:4px}
.placeholder{height:160px;background:#ECE9E2;border:1px dashed var(--line);border-radius:12px}
.blockers{color:var(--rose);font-size:14px}
details.card summary{cursor:pointer;font-weight:600;font-size:16px}
details.card[open] summary{margin-bottom:12px}
.inv{display:flex;justify-content:space-between;gap:12px;align-items:center;font-size:14px;padding:6px 0;border-bottom:1px solid var(--line)}
.switch{display:flex;gap:10px;align-items:center;font-size:14px}
```

- [ ] **Step 4: render-operator.js 작성**

```js
// docs/design/mockups/render-operator.js — 운영자 워크벤치 /operator
"use strict";
var TM_RENDER_OPERATOR = (function () {
  var U = TM_UI;
  var current = null;

  function stageLabel(d, key) { var s = d.stages.find(function (x) { return x.key === key; }); return s ? s.label : key; }
  function caseById(d, id) { return d.cases.find(function (c) { return c.id === id; }) || d.cases[0]; }

  function sortQueue(cases) {
    return cases.slice().sort(function (a, b) {
      var ra = a.paused_reason ? 2 : a.sla_hours_left == null ? 1 : 0;
      var rb = b.paused_reason ? 2 : b.sla_hours_left == null ? 1 : 0;
      if (ra !== rb) return ra - rb;
      return (a.sla_hours_left || 0) - (b.sla_hours_left || 0);
    });
  }

  function collection(c) {
    var has = function (s) { return c.blockers.some(function (b) { return b.indexOf(s) >= 0; }); };
    return [
      { label: "멤버", ok: true },
      { label: "결제자", ok: !has("미상 결제자") },
      { label: "통화", ok: !has("통화 미확정") },
      { label: "분담", ok: true },
      { label: "원본 목록", ok: true }
    ];
  }

  function loginPage() {
    return '<main class="shell-app app-main" id="login"><section class="card stack" style="max-width:420px;margin:48px auto"><p class="eyebrow">운영자</p><h1 class="h3">직원 로그인</h1><p class="meta">등록된 직원 이메일로 일회용 로그인 링크를 보냅니다. 공개 가입은 없습니다.</p>' +
      '<form class="stack" onsubmit="return TM_RENDER_OPERATOR.login(event)"><label class="field">직원 이메일<input class="input" name="email" placeholder="staff@example.com" autocomplete="off"></label><p class="form-msg" aria-live="polite"></p><button type="submit" class="btn block">로그인 링크 받기</button></form></section></main>';
  }

  function nav(active) {
    var tab = function (label, key) { return '<a class="pill' + (active === key ? " info" : "") + '" href="#" onclick="TM_RENDER_OPERATOR.' + (key === "leads" ? "showLeads" : "showQueue") + "();return false\">" + label + "</a>"; };
    return '<header class="app-head"><h1 class="sr-only">운영자 워크벤치</h1><div class="shell-app between"><div class="tabs" role="tablist">' + tab("케이스 큐", "queue") + tab("리드", "leads") + tab("설정", "settings") + '</div><div class="stamp-inline"><span class="meta">reviewer</span>' + U.btn("로그아웃", { secondary: true, href: "operator.html?state=login" }) + "</div></div></header>";
  }

  function queue(d, selectedId) {
    return '<aside id="queue"><h2 style="margin-bottom:8px;font-size:18px">케이스 큐</h2>' + sortQueue(d.cases).map(function (c) {
      var status = c.paused_reason ? U.pill("일시정지 · " + c.paused_reason, "wait") : c.sla_hours_left != null ? U.pill("SLA " + c.sla_hours_left + "h", "info") : U.pill("검토창", "");
      return '<button type="button" class="case-row' + (c.id === selectedId ? " on" : "") + '" onclick="TM_RENDER_OPERATOR.select(\'' + c.id + '\')"><b class="num">' + c.id + "</b> · " + U.esc(c.product) + "<br>" + U.pill(stageLabel(d, c.stage), "") + " " + status + (c.objections ? " " + U.pill("이의 " + c.objections, "bad") : "") + '<span class="caption">다음 조치: ' + U.esc(c.next_action) + "</span></button>";
    }).join("") + "</aside>";
  }

  function caseHead(d, c, full) {
    var sla = c.sla_hours_left != null ? U.pill("SLA 남은 시간 " + c.sla_hours_left + "h", "info") : c.paused_reason ? U.pill("일시정지 · " + c.paused_reason, "wait") : "";
    return '<section class="card section-app" id="case-head"><div class="between"><div><p class="eyebrow num">' + c.id + " · " + U.esc(c.product) + "</p><h2>" + U.esc(c.trip_name) + "</h2></div>" + sla + "</div>" +
      U.rail(d.stages, c.stage, { badge: c.paused_reason ? "일시정지 · " + c.paused_reason : null }) +
      '<h3>체크포인트</h3><ul class="cond-list">' + c.checklist.map(function (i) {
        return "<li><span>" + U.esc(i.label) + (i.note ? ' <span class="reason">' + U.esc(i.note) + "</span>" : "") + "</span>" + U.pill(i.ok ? "확인" : "차단", i.ok ? "ok" : "bad") + "</li>";
      }).join("") + "</ul>" + (c.blockers.length ? '<p class="blockers">차단: ' + c.blockers.map(U.esc).join(" · ") + "</p>" : "") +
      (full ? "" : U.btn("검수 열기", { href: "operator.html?state=case" })) + "</section>";
  }

  function collect(c) {
    return '<section class="card section-app" id="collect"><h2>자료수집 체크리스트</h2><ul class="cond-list">' + collection(c).map(function (i) {
      return "<li><span>" + i.label + "</span>" + U.pill(i.ok ? "확인" : "미확인", i.ok ? "ok" : "bad") + "</li>";
    }).join("") + "</ul></section>";
  }

  function receipt(d) {
    var r = d.receipt_compare;
    var row = function (k, v) { return "<tr><th>" + k + "</th><td>" + U.esc(v) + "</td></tr>"; };
    return '<section class="section-app" id="receipt"><h2>영수증 검수 · ' + U.esc(r.title) + ' <span class="num meta">' + r.expense_id + '</span></h2><div class="grid-3">' +
      '<div class="card"><h3>원본</h3><div class="placeholder" role="img" aria-label="영수증 원본 자리 표시"></div><p class="caption">원본은 private 저장소에서 서명된 URL로만 열립니다</p></div>' +
      '<div class="card"><h3>OCR 추출</h3><table class="kv">' + row("금액", r.ocr.amount) + row("통화", r.ocr.currency) + row("가맹점", r.ocr.merchant) + row("일시", r.ocr.date) + "</table><p class=\"caption\">신뢰도 " + U.esc(r.ocr.confidence) + "</p></div>" +
      '<form class="card stack" onsubmit="return TM_RENDER_OPERATOR.approveReceipt(event)"><h3>수정 · 승인</h3><label class="field">금액<input class="input" name="amount" value="' + U.esc(r.corrected.amount) + '"></label><label class="field">통화<input class="input" name="currency" value="' + U.esc(r.corrected.currency) + '"></label><label class="field">가맹점<input class="input" name="merchant" value="' + U.esc(r.corrected.merchant) + '"></label><label class="field">일시<input class="input" name="date" value="' + U.esc(r.corrected.date) + '"></label><p class="form-msg" aria-live="polite"></p><button type="submit" class="btn">검수 승인</button></form></div></section>';
  }

  function fx(d) {
    return '<section class="card section-app" id="fx"><h2>환율 출처</h2><ul class="cond-list">' + d.fx.map(function (f) {
      return "<li><span>" + U.esc(f.pair) + ' <span class="num">' + f.rate + "</span> · " + U.esc(f.source) + " · " + U.esc(f.as_of) + "</span>" + (f.manual_reason ? U.pill("수동: " + f.manual_reason, "wait") : U.pill("자동", "ok")) + "</li>";
    }).join("") + "</ul></section>";
  }

  function invariants(d) {
    return '<section class="card section-app" id="invariants"><h2>정산 버전과 불변식</h2><ul class="cond-list">' + d.versions.map(function (v) {
      return "<li><span>v" + v.version + " · " + U.esc(v.created_at) + " · " + U.esc(v.note) + "</span>" + U.pill(v.status === "current" ? "현재" : "이전", v.status === "current" ? "info" : "") + "</li>";
    }).join("") + '</ul><ul class="cond-list">' + d.invariants.map(function (i) {
      var st = i.ok === true ? ["통과", "ok"] : i.ok === false ? ["실패", "bad"] : ["대기", "wait"];
      return '<li class="inv"><span>' + U.esc(i.label) + (i.ok === false ? ' <a href="#receipt">원인 지출 보기</a>' : "") + "</span>" + U.pill(st[0], st[1]) + "</li>";
    }).join("") + "</ul></section>";
  }

  function objections(c) {
    return '<section class="card section-app" id="objections"><h2>이의 목록</h2><p class="meta">' + (c.stage === "participant_review" ? "미해결 이의 " + (c.objections || 0) + "건" : "참여자 검토창이 열리기 전입니다") + "</p></section>";
  }

  function qa(d) {
    var failed = d.invariants.filter(function (i) { return i.ok === false; }).length;
    return '<section class="card section-app" id="qa"><h2>내부 QA와 잠금</h2><form class="stack" onsubmit="return TM_RENDER_OPERATOR.submitQa(event)"><label class="field">상태<select class="input" name="status"><option value="ok">확인</option><option value="needs_fix">수정 필요</option><option value="blocked">차단</option></select></label><label class="field">QA 의견 (추가만 가능)<textarea class="input" name="note" placeholder="짧은 내부 의견"></textarea></label><p class="caption">연락처·원문 개인정보를 입력하지 않습니다. 정정은 새 의견으로 남깁니다.</p><p class="form-msg" aria-live="polite"></p><button type="submit" class="btn btn-secondary">의견 추가</button></form>' +
      '<div class="stamp-inline" style="margin-top:12px">' + U.btn("잠금 실행", { secondary: true, disabled: true }) + '<span class="meta">불변식 ' + failed + "개 실패 · 총무 잠금 요청 없음</span></div></section>";
  }

  function ops(d) {
    return '<section class="section-app" id="ops"><div class="grid-3">' +
      '<details class="card"><summary>공유 · 폐기</summary><p class="caption">카카오 미리보기에는 여행명, 버전, 기준 환율, 송금 제안만 들어갑니다.</p>' + U.btn("링크 폐기", { secondary: true, onclick: "TM_RENDER_OPERATOR.revokeLink()" }) + "</details>" +
      '<details class="card"><summary>작업시간 · 비용 · 환불</summary><table class="kv"><tr><th>작업시간</th><td class="num">3h 40m</td></tr><tr><th>OCR 호출</th><td class="num">14건</td></tr><tr><th>환불</th><td>없음</td></tr></table></details>' +
      '<details class="card"><summary>보유 · 삭제 · 사고중단</summary><table class="kv"><tr><th>삭제 예정</th><td class="num">2026-12-08</td></tr><tr><th>삭제 요청</th><td class="num">0건</td></tr></table><label class="switch"><input type="checkbox" onchange="TM_RENDER_OPERATOR.toggleStop(this)">신규 접수 중단</label></details>' +
      "</div></section>";
  }

  function caseDetail(d, c, full) {
    var out = caseHead(d, c, full);
    if (full) out += collect(c) + receipt(d) + fx(d) + invariants(d) + objections(c) + qa(d) + ops(d);
    return '<section id="case" class="stack">' + out + "</section>";
  }

  function renderLeads(d) {
    var rows = [["k***@***.com", "2026-09-01", "real"], ["010-****-4821", "2026-09-03", "real"], ["m***@***.kr", "2026-09-05", "real"]];
    return '<section class="card section-app" id="leads"><h2>베타 리드 (마스킹)</h2><table class="table"><thead><tr><th>연락수단</th><th>접수일</th><th>분류</th></tr></thead><tbody>' + rows.map(function (r) {
      return "<tr><td>" + r[0] + '</td><td class="num">' + r[1] + "</td><td>" + r[2] + "</td></tr>";
    }).join("") + '</tbody></table><form class="stack" onsubmit="return TM_RENDER_OPERATOR.submitQa(event)"><label class="field">QA 의견 (추가만 가능)<textarea class="input" name="note" placeholder="짧은 내부 의견"></textarea></label><p class="form-msg" aria-live="polite"></p><button type="submit" class="btn btn-secondary">의견 추가</button></form></section>';
  }

  function renderState(d, st) {
    current = st;
    if (st.view === "login") return loginPage();
    var c = caseById(d, st.selected);
    return nav("queue") + '<main class="shell-app app-main op-grid">' + queue(d, c.id) + caseDetail(d, c, st.view === "case") + "</main>";
  }
  function render(d, key) { return renderState(d, d.scenes.operator[key]); }

  function mount(html) { document.getElementById("app").innerHTML = html; }
  function toast(msg) { var t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 1800); }
  function select(id) { mount(renderState(TM_DATA, { view: current.view, selected: id })); }
  function showLeads() { mount(nav("leads") + '<main class="shell-app app-main stack">' + renderLeads(TM_DATA) + "</main>"); }
  function showQueue() { mount(renderState(TM_DATA, { view: "queue", selected: current.selected || "C-014" })); }
  function login(ev) { ev.preventDefault(); var f = ev.target, msg = f.querySelector(".form-msg"); if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(f.email.value.trim())) { msg.textContent = "등록된 직원 이메일을 입력해 주세요"; return false; } msg.style.color = "var(--green)"; msg.textContent = "로그인 링크를 보냈습니다 (목업)"; return false; }
  function approveReceipt(ev) { ev.preventDefault(); var f = ev.target, msg = f.querySelector(".form-msg"); if (!/^[A-Z]{3}$/.test(f.currency.value.trim())) { msg.textContent = "통화는 세 글자 코드로 확정해 주세요"; return false; } msg.style.color = "var(--green)"; msg.textContent = "검수 승인 · expense 생성 (목업)"; return false; }
  function submitQa(ev) { ev.preventDefault(); var f = ev.target, msg = f.querySelector(".form-msg"); var v = f.note.value.trim(); if (!v) { msg.textContent = "의견을 적어 주세요"; return false; } if (v.length > 200 || /@|\d{6,}/.test(v)) { msg.textContent = "200자 이내로, 연락처나 긴 숫자는 넣지 않습니다"; return false; } msg.style.color = "var(--green)"; msg.textContent = "의견을 추가했습니다 (목업)"; f.note.value = ""; return false; }
  function revokeLink() { toast("참여자 링크를 폐기했습니다 (목업)"); }
  function toggleStop(cb) { toast(cb.checked ? "신규 접수를 중단했습니다 (목업)" : "신규 접수를 다시 엽니다 (목업)"); }

  return { render: render, renderState: renderState, sortQueue: sortQueue, collection: collection, renderLeads: renderLeads, select: select, showLeads: showLeads, showQueue: showQueue, login: login, approveReceipt: approveReceipt, submitQa: submitQa, revokeLink: revokeLink, toggleStop: toggleStop };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TM_RENDER_OPERATOR;
```

- [ ] **Step 5: operator.html 작성**

`landing.html`과 같은 `<head>`(제목 `TripMoney · 운영자 워크벤치 (목업)`), 스크립트 `render-operator.js`, 부트스트랩:

```html
<script>
(function () {
  var states = Object.keys(TM_DATA.scenes.operator);
  var s = TM_UI.stateFromUrl("queue", states);
  document.getElementById("mocknav").innerHTML = TM_UI.mocknav("operator", states, s);
  document.getElementById("app").innerHTML = TM_RENDER_OPERATOR.render(TM_DATA, s);
})();
</script>
```

- [ ] **Step 6: 통과 확인**

Run: `node --test docs/design/mockups/tests/render-operator.test.cjs`
Expected: PASS 6개

- [ ] **Step 7: 브라우저에서 확인**

`operator.html`에서 큐의 다른 케이스를 누르면 상세가 바뀌는지, `?state=case`에서 영수증 3열과 불변식 8개가 보이고 "잠금 실행"이 비활성인지, "리드" 탭에서 마스킹된 표가 나오는지, 1180px 미만에서 큐가 위로 올라가는지 본다.

- [ ] **Step 8: 커밋**

```bash
git add docs/design/mockups/render-operator.js docs/design/mockups/operator.html docs/design/mockups/tokens.css docs/design/mockups/tests/render-operator.test.cjs
git commit -m "design: 운영자 워크벤치 목업

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: 허브 `index.html`, 페이지 구조·접근성·대비 검사

**Files:**
- Create: `docs/design/mockups/index.html`
- Create: `docs/design/mockups/tests/pages.test.cjs`
- Create: `docs/design/mockups/tests/contrast.test.cjs`

**Interfaces:**
- Consumes: 네 렌더 모듈과 `TM_DATA.scenes`.
- Produces: 허브 페이지. 장면 링크 형식은 `<page>.html?state=<state>`이며 열한 개가 모두 있어야 한다.

- [ ] **Step 1: 실패하는 페이지 구조 테스트 작성**

```js
// docs/design/mockups/tests/pages.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, read } = require("./helpers.cjs");

const PAGES = ["index.html", "landing.html", "review.html", "share.html", "operator.html"];
const SCENES = {
  landing: ["intake_on", "intake_off"],
  review: ["awaiting_organizer", "participant_review", "finalized"],
  share: ["notice", "active", "expired"],
  operator: ["queue", "case", "login"],
};
const RENDERERS = { landing: "render-landing.js", review: "render-review.js", share: "render-share.js", operator: "render-operator.js" };

function allScenes() {
  const d = load("data.js");
  const out = [];
  for (const [page, states] of Object.entries(SCENES)) {
    const r = load(RENDERERS[page]);
    for (const st of states) out.push({ page, st, html: r.render(d, st) });
  }
  return out;
}

test("허브는 열한 장면 링크를 모두 가진다", () => {
  const html = read("index.html");
  for (const [page, states] of Object.entries(SCENES)) for (const st of states) assert.ok(html.includes(`${page}.html?state=${st}`), `${page}/${st} 링크 없음`);
  const colors = [...html.matchAll(/class="feature (\w+)"/g)].map((m) => m[1]);
  assert.equal(colors.length, 4);
  for (let i = 1; i < colors.length; i++) assert.notEqual(colors[i], colors[i - 1]);
  assert.match(html, /프로덕션 코드가 아닙니다/);
});

test("모든 HTML 페이지의 공통 제약", () => {
  for (const p of PAGES) {
    const html = read(p);
    assert.match(html, /<html lang="ko">/, p);
    assert.match(html, /name="viewport"/, p);
    assert.equal((html.match(/<title>/g) || []).length, 1, p);
    assert.match(html, /href="tokens\.css"/, p);
    assert.doesNotMatch(html, /Space\+Grotesk|family=Inter|type="module"|fetch\(/, p);
    for (const m of html.matchAll(/<script src="([^"]+)"/g)) assert.doesNotMatch(m[1], /^https?:/, `${p} 외부 스크립트`);
    assert.doesNotMatch(html, /<link[^>]+href="https?:\/\/(?!fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net)/, `${p} 허용 외 외부 리소스`);
  }
});

test("장면마다 h1 하나, 헤딩 단계 건너뜀 없음, 빈 버튼 없음", () => {
  for (const { page, st, html } of allScenes()) {
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    assert.equal(levels.filter((l) => l === 1).length, 1, `${page}/${st} h1 수`);
    let prev = 0;
    for (const l of levels) { assert.ok(l <= prev + 1, `${page}/${st} 헤딩 ${prev}→${l} 건너뜀`); prev = l; }
    assert.doesNotMatch(html, /<button[^>]*>\s*<\/button>/, `${page}/${st} 빈 버튼`);
    assert.doesNotMatch(html, /<img(?![^>]*alt=)/, `${page}/${st} alt 없는 이미지`);
    assert.doesNotMatch(html, /toss|\d{2,6}-\d{2,6}-\d{4,8}|계좌번호\s*[:：]|은행명\s*[:：]/i, `${page}/${st} 금지 문구`);
  }
});

test("표현색은 랜딩과 허브에만 있다", () => {
  for (const { page, st, html } of allScenes()) {
    if (page === "landing") continue;
    assert.doesNotMatch(html, /class="feature |lavender|peach|ochre|mint/, `${page}/${st} 표현색 사용`);
  }
});
```

- [ ] **Step 2: 실패하는 대비 테스트 작성**

```js
// docs/design/mockups/tests/contrast.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { read } = require("./helpers.cjs");

function lum(hex) {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(fg, bg) {
  const [a, b] = [lum(fg), lum(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const T = { canvas: "#FFFAF0", paper: "#F5EFE3", panel: "#FFFDF7", ink: "#172133", mut: "#5E574B", green: "#1F6B4A", amber: "#B86718", rose: "#B14B3F", blue: "#305D88", lavender: "#B8A4ED", peach: "#FFB084", ochre: "#E8B94A", mint: "#A4D4C5", navy: "#233049" };

const PAIRS = [
  ["본문 잉크/캔버스", T.ink, T.canvas, 4.5], ["본문 잉크/종이", T.ink, T.paper, 4.5], ["본문 잉크/카드", T.ink, T.panel, 4.5],
  ["보조 글자/캔버스", T.mut, T.canvas, 4.5], ["보조 글자/종이", T.mut, T.paper, 4.5], ["보조 글자/삭제 태그", T.mut, "#ECE9E2", 4.5],
  ["버튼 글자/잉크", T.panel, T.ink, 4.5], ["흰 글자/딥네이비", T.panel, T.navy, 4.5], ["딥네이비 보조 글자", "#D9DEE8", T.navy, 4.5],
  ["잉크/라벤더", T.ink, T.lavender, 4.5], ["잉크/피치", T.ink, T.peach, 4.5], ["잉크/오커", T.ink, T.ochre, 4.5], ["잉크/민트", T.ink, T.mint, 4.5],
  ["승인 필/초록", T.green, "#E6F0E9", 4.5], ["대기 필/보정 호박", "#7A4410", "#F7EAD8", 4.5], ["이의 필/보정 장미", "#8E3A30", "#F3DEDB", 4.5], ["정보 필/파랑", T.blue, "#E3EBF3", 4.5],
  ["장미 글자/카드", T.rose, T.panel, 4.5], ["초록 글자/카드", T.green, T.panel, 4.5], ["파랑 링크/캔버스", T.blue, T.canvas, 4.5],
  ["포커스 링(비문자)/캔버스", T.amber, T.canvas, 3],
];

test("스펙 4.6 대비 AA", () => {
  for (const [name, fg, bg, min] of PAIRS) {
    const r = ratio(fg, bg);
    assert.ok(r >= min, `${name}: ${r.toFixed(2)} < ${min}`);
  }
});

test("tokens.css가 보정 색을 실제로 쓴다", () => {
  const css = read("tokens.css");
  assert.match(css, /\.pill\.wait\{[^}]*color:#7A4410/);
  assert.match(css, /\.pill\.bad\{[^}]*color:#8E3A30/);
  assert.match(css, /\.tag\.ocr_only\{[^}]*color:#7A4410/);
  assert.doesNotMatch(css, /\.pill\.(wait|bad)\{[^}]*color:var\(--(amber|rose)\)/);
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --test docs/design/mockups/tests/`
Expected: `pages.test.cjs`는 `index.html` ENOENT로 FAIL, `contrast.test.cjs`의 첫 테스트는 PASS, 둘째는 tokens.css 상태에 따라 PASS.

- [ ] **Step 4: index.html 작성**

```html
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TripMoney 제품 표면 목업 허브</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" as="style" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<link rel="stylesheet" href="tokens.css">
<style>.scene-list{list-style:none;display:grid;gap:6px;font-size:14px}.scene-list a{color:inherit}</style>
</head>
<body>
<main class="shell section">
  <p class="eyebrow">TripMoney · 설계 목업</p>
  <h1>제품 표면 목업 허브</h1>
  <p class="lead" style="margin:12px 0 32px">네 표면과 열한 장면을 합성 데이터로 보여줍니다. 프로덕션 코드가 아닙니다. 설계 문서는 <code>docs/superpowers/specs/2026-09-06-tripmoney-product-surfaces-ux-design.md</code>입니다.</p>
  <div class="grid-2">
    <article class="feature lavender"><h2>공개 랜딩</h2><p>고객이 처음 보는 화면. 양쪽 기기 대응.</p>
      <ul class="scene-list fragment"><li><a href="landing.html?state=intake_on">intake_on · 신청 폼 활성</a></li><li><a href="landing.html?state=intake_off">intake_off · 접수 비활성 안내</a></li></ul></article>
    <article class="feature peach"><h2>총무 검토</h2><p>총무가 초안을 승인하고 잠금을 요청하는 화면. 모바일 우선.</p>
      <ul class="scene-list fragment"><li><a href="review.html?state=awaiting_organizer">awaiting_organizer · 승인 대기</a></li><li><a href="review.html?state=participant_review">participant_review · 검토창 진행</a></li><li><a href="review.html?state=finalized">finalized · 잠금 완료</a></li></ul></article>
    <article class="feature mint"><h2>참여자 공유</h2><p>참여자가 본인 몫만 확인하고 결정하는 화면. 모바일 우선.</p>
      <ul class="scene-list fragment"><li><a href="share.html?state=notice">notice · 첫 고지</a></li><li><a href="share.html?state=active">active · 본인 결과</a></li><li><a href="share.html?state=expired">expired · 만료 안내</a></li></ul></article>
    <article class="feature ochre"><h2>운영자 워크벤치</h2><p>직원이 케이스를 검수하고 잠그는 화면. 데스크톱 우선.</p>
      <ul class="scene-list fragment"><li><a href="operator.html?state=queue">queue · 케이스 큐</a></li><li><a href="operator.html?state=case">case · 검수 중 상세</a></li><li><a href="operator.html?state=login">login · 로그인</a></li></ul></article>
  </div>
  <p class="caption" style="margin-top:32px">자동 검사: <code>node --test docs/design/mockups/tests/</code></p>
</main>
</body>
</html>
```

- [ ] **Step 5: 전체 테스트 통과 확인**

Run: `node --test docs/design/mockups/tests/`
Expected: 모든 테스트 PASS (smoke 포함). 실패하면 실패한 장면과 규칙을 고친 뒤 다시 실행한다. 헤딩 건너뜀이 나오면 해당 렌더 함수의 헤딩 단계를 스펙의 구획 구조(페이지 제목 h1, 구획 h2, 구획 안 소제목 h3)에 맞춘다.

- [ ] **Step 6: 커밋**

```bash
git add docs/design/mockups/index.html docs/design/mockups/tests/pages.test.cjs docs/design/mockups/tests/contrast.test.cjs
git commit -m "design: 목업 허브와 페이지 구조·대비 검사

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: 시각 검증, README 기록, 스펙 6.1 갱신

**Files:**
- Modify: `docs/design/README.md`
- Modify: `docs/superpowers/specs/2026-09-06-tripmoney-product-surfaces-ux-design.md` (6.1 파일 구조, 4.1 대비 보정 색 한 줄)

- [ ] **Step 1: 브라우저 패널로 열한 장면을 세 폭에서 확인**

`.claude/launch.json`의 `tripmoney-prototype` 서버는 쓰지 않는다. 브라우저 패널에서 `file://` 경로로 `docs/design/mockups/index.html`을 열고 각 장면으로 이동한다. 각 장면에서 `resize_window`로 375, 768, 1180px을 차례로 적용하고 아래를 본다.

- 가로 스크롤이 생기지 않는다(`document.documentElement.scrollWidth <= window.innerWidth`를 `javascript_tool`로 확인).
- 보딩패스 스텁, 스탬프, 수하물 태그가 잘리지 않는다.
- 375px에서 여정 레일이 옆으로 스크롤된다.
- 콘솔 오류가 없다(`read_console_messages` onlyErrors).
- 키보드로 Tab을 눌러 포커스 링이 호박색으로 보인다.

문제가 있으면 렌더 함수나 `tokens.css`를 고치고 `node --test docs/design/mockups/tests/`를 다시 통과시킨 뒤 재확인한다.

- [ ] **Step 2: README에 검증 결과표 기록**

`docs/design/README.md`의 "시각 검증 결과는 아래 표에 기록한다." 문장 아래에 다음 표를 채운다. 각 칸은 `통과` 또는 발견한 문제와 수정 커밋 해시다.

```markdown
| 장면 | 375px | 768px | 1180px | 콘솔 오류 | 비고 |
|---|---|---|---|---|---|
| landing/intake_on | | | | | |
| landing/intake_off | | | | | |
| review/awaiting_organizer | | | | | |
| review/participant_review | | | | | |
| review/finalized | | | | | |
| share/notice | | | | | |
| share/active | | | | | |
| share/expired | | | | | |
| operator/queue | | | | | |
| operator/case | | | | | |
| operator/login | | | | | |

접근성 점검(7.2): 대비 AA는 `contrast.test.cjs`, 헤딩 구조·빈 버튼·alt는 `pages.test.cjs`, 포커스 링과 모달 포커스 가둠은 수동 확인. 결과: (여기에 적는다)

내용 규칙 점검(7.3): 모티프 예산·금액 병기·계좌 미노출·참여자 최소화·검토 전 문구 표시는 `render-*.test.cjs`와 `pages.test.cjs`로 자동 확인. 결과: (여기에 적는다)
```

- [ ] **Step 3: 스펙 6.1과 4.1 갱신**

`docs/superpowers/specs/2026-09-06-tripmoney-product-surfaces-ux-design.md`의 6.1 파일 구조 코드 블록을 실제 구조로 바꾼다.

```
docs/design/
  README.md
  mockups/
    index.html
    tokens.css
    data.js
    components.js
    render-landing.js
    render-review.js
    render-share.js
    render-operator.js
    landing.html
    review.html
    share.html
    operator.html
    tests/
      helpers.cjs
      smoke.test.cjs
      tokens.test.cjs
      data.test.cjs
      components.test.cjs
      render-landing.test.cjs
      render-review.test.cjs
      render-share.test.cjs
      render-operator.test.cjs
      pages.test.cjs
      contrast.test.cjs
```

같은 절의 설명 목록에 다음 두 줄을 더한다.

```markdown
- `components.js`는 여정 레일, 서류 컴포넌트 3종, 버튼과 도우미를 순수 함수로 담고, `render-*.js`는 화면별 렌더 함수를 담는다. 모든 스크립트는 브라우저 전역과 CommonJS 내보내기를 함께 제공한다.
- `tests/`는 Node 내장 테스트 러너로 토큰 값, 정산 불변식, 모티프 예산, 채운 버튼 수, 헤딩 구조, 대비 AA를 자동 검사한다. 실행 명령은 `node --test docs/design/mockups/tests/`이다.
```

4.1 표 아래 문단의 "구현 시 AA 대비를 확인한다." 뒤에 한 문장을 더한다.

```markdown
옅은 배경 위의 작은 글자(대기·이의 필, OCR 미검수 태그, SLA 표시)에는 호박색과 장미색의 어두운 변형 `#7A4410`, `#8E3A30`을 쓴다. 원래 값은 AA 4.5:1에 미달했기 때문이다.
```

- [ ] **Step 4: 최종 전체 검사**

Run: `node --test docs/design/mockups/tests/`
Expected: 전부 PASS

Run: `git status --short`
Expected: `docs/design/`와 두 문서 외의 변경이 없다.

- [ ] **Step 5: 커밋**

```bash
git add docs/design/README.md docs/superpowers/specs/2026-09-06-tripmoney-product-surfaces-ux-design.md
git commit -m "design: 목업 시각 검증 기록과 스펙 파일 구조 갱신

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## 스펙 대조

| 스펙 항목 | 구현 작업 |
|---|---|
| 3.1 여정 레일 6단계·배지·SLA 표시 | Task 3 `stages`, Task 4 `rail` |
| 3.2 공개 랜딩 | Task 5 |
| 3.2 총무 검토 | Task 6 |
| 3.2 참여자 공유 | Task 7 |
| 3.2 운영자 워크벤치(00B 리드 탭 포함) | Task 8 |
| 3.3 허브와 열한 장면 | Task 9 `index.html`, 각 페이지 `stateFromUrl` |
| 4.1 토큰·서체·크기·모서리·버튼 | Task 2, 대비 보정은 Task 9 검사 |
| 4.2 레일 상호작용(종료 조건 말풍선) | Task 2 CSS `.cond`, Task 4 `rail` |
| 4.3 보딩패스·스탬프 6종·태그 4종 | Task 4 |
| 4.4 모티프 예산 규칙 1~7 | Task 5~8 테스트의 `motifKinds`, 채운 버튼 수, 표현색 검사(Task 9) |
| 4.5 어휘와 숫자 표기 | Task 4 `won`, `money`; Task 3 시각 문자열 |
| 4.6 접근성·반응형 | Task 2 CSS, Task 9 `pages.test.cjs`·`contrast.test.cjs`, Task 10 시각 검증 |
| 4.7 문구 원칙 | Task 5~8 문구, 검토 전 문구 표시 |
| 5.1~5.5 화면 설계 | Task 5~8 |
| 6.1~6.3 목업 구현 | Task 1~9, 6.1 갱신은 Task 10 |
| 7.1~7.5 검증과 완료 정의 | Task 9~10 |
