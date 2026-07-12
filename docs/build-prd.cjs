const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, LevelFormat, HeadingLevel, BorderStyle, WidthType, ShadingType,
  TableOfContents, PageBreak, PageNumber, Header, Footer,
} = require("docx");

const NAVY = "1F3A5F", BLUE = "2E75B6", TEAL = "1F8A8A", GRAY = "666666", LIGHT = "EAF1F8";
const CW = 9360; // content width (US Letter, 1" margins)

const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const H3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(t)] });
const P = (t, opts = {}) => new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: t, ...opts })] });
const B = (t) => new Paragraph({ numbering: { reference: "bul", level: 0 }, spacing: { after: 60 }, children: textRuns(t) });
const Bn = (t) => new Paragraph({ numbering: { reference: "num", level: 0 }, spacing: { after: 60 }, children: textRuns(t) });

// "라벨: 내용" 에서 라벨 볼드 처리
function textRuns(t) {
  const i = t.indexOf("|b|");
  if (i >= 0) return [new TextRun({ text: t.slice(0, i), bold: true }), new TextRun(t.slice(i + 3))];
  return [new TextRun(t)];
}

function cell(text, { w, head = false, bold = false, fill, align } = {}) {
  const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
  const runs = Array.isArray(text)
    ? text.map((x, i) => new TextRun({ text: x, break: i ? 1 : 0, bold: head || bold, color: head ? "FFFFFF" : undefined, size: 19 }))
    : [new TextRun({ text, bold: head || bold, color: head ? "FFFFFF" : undefined, size: 19 })];
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    borders: { top: border, bottom: border, left: border, right: border },
    shading: { fill: head ? NAVY : (fill || "FFFFFF"), type: ShadingType.CLEAR },
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    children: [new Paragraph({ alignment: align === "c" ? AlignmentType.CENTER : AlignmentType.LEFT, children: runs })],
  });
}
function table(widths, rows) {
  return new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: widths,
    rows: rows.map((r, ri) =>
      new TableRow({
        tableHeader: ri === 0,
        children: r.map((c, ci) =>
          cell(c, { w: widths[ci], head: ri === 0, fill: ri % 2 === 0 ? LIGHT : "FFFFFF" })
        ),
      })
    ),
  });
}
const SP = (a = 80) => new Paragraph({ spacing: { after: a }, children: [] });

const children = [];

// ===== 표지 =====
children.push(
  new Paragraph({ spacing: { before: 1600, after: 0 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "TripMoney", bold: true, size: 72, color: NAVY })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 },
    children: [new TextRun({ text: "여행 일정·비용 공유 & 정산 AI 에이전트", size: 30, color: TEAL, bold: true })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 600 },
    children: [new TextRun({ text: "Product Requirements Document (PRD)", size: 26, color: GRAY })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
    children: [new TextRun({ text: "v1.0  ·  2026-06-23", size: 22, color: GRAY })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
    children: [new TextRun({ text: "포지셔닝: AI 에이전트(MCP) 우선  ·  타겟: 해외여행 그룹(국내 확장)", size: 22, color: GRAY })] }),
  new Paragraph({ alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "작성: Jake (Platform PO)", size: 22, color: GRAY })] }),
  new Paragraph({ children: [new PageBreak()] }),
);

// ===== 목차 =====
children.push(H1("목차"));
children.push(new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-2" }));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 1. 개요
children.push(H1("1. 제품 개요"));
children.push(P("TripMoney는 함께 여행하는 사람들이 하나의 공간에서 일정과 비용을 공유하고, 영수증 한 장으로 지출을 자동 기록하며, 마지막에 N빵·각자부담을 한 번에 정산하는 서비스다. 기존 시장이 ‘일정 앱’과 ‘정산 앱’으로 분리되어 있던 것과 달리, TripMoney는 [일정 → 영수증 촬영 → 해당 일정 비용으로 자동 귀속 → 환율 환산 → 맞춤 정산 → 송금]을 하나의 흐름(End-to-End)으로 잇는다."));
children.push(P("1차 제품은 독립 앱이 아니라 AI 에이전트(MCP) 형태로 출시한다. 사용자는 PlayMCP·LLM 채팅 안에서 자연어로 “방콕 3박 여행방 만들고 멤버 추가해줘”, “이 영수증 등록해줘”, “N빵으로 정산해줘”라고 말하면 TripMoney가 실행한다. 웹/모바일 화면은 조회·확인용 보조 대시보드로 둔다."));
children.push(H2("1.1 비전"));
children.push(P("“여행 중 발생하는 시간의 흐름과 지출이, 사용자의 개입을 최소화하며 자동으로 연결되는 가장 매끄러운 경험.”"));
children.push(H2("1.2 현재 상태 (2026-06 기준)"));
children.push(B("|b|구현·배포 완료: MCP 서버(8개 Tool) — Vercel 배포, PlayMCP 등재 진행. 일정/비용/환율환산/정산 전 기능 실동작."));
children.push(B("|b|고도화 완료: 영수증 OCR(네이버 CLOVA), 여행방 단위 접근키(보안), 토스 송금 딥링크 + 카톡 공유 메시지."));
children.push(B("|b|기술 스택: TypeScript · MCP Streamable HTTP(stateless) · Supabase(Postgres) · Vercel."));

// 2. 문제 정의
children.push(H1("2. 문제 정의"));
children.push(P("여행 총무와 동행자는 다음과 같은 반복적 불편(Pain Point)을 겪는다."));
children.push(B("|b|일정 조율: 단톡방·메모·캡처로 흩어진 일정. 현장에서 지연되면 뒤 일정을 일일이 다시 조정해야 함."));
children.push(B("|b|지출 기록: 영수증이 쌓이고, 누가 무엇을 냈는지 사후에 기억으로 복원. 현지통화↔한화 환산은 매번 수기 계산."));
children.push(B("|b|정산: 전체 N빵, 일부만 참여한 항목, 각자 부담이 뒤섞여 ‘누가 누구에게 얼마’ 계산이 총무에게 스트레스."));
children.push(B("|b|송금: 계산은 끝났는데 실제 송금은 은행/페이 앱을 따로 열어야 하는 단절(라스트마일)."));
children.push(P("핵심 인사이트: 기존 도구들은 ‘일정 따로, 정산 따로’다. 통합된 단일 워크플로우를 가진 절대 강자가 아직 비어 있다.", { italics: true, color: GRAY }));

// 3. 타겟
children.push(H1("3. 타겟 사용자"));
children.push(P("1차 플라이휠은 해외여행 그룹, 이후 국내 단체여행으로 확장한다. 해외를 우선하는 이유는 환율 환산·영수증·교차정산의 페인이 가장 크고, 그만큼 차별화 포인트(환율·OCR)가 강하게 살아나기 때문이다."));
children.push(table([2600, 3380, 3380], [
  ["페르소나", "상황", "TripMoney가 푸는 문제"],
  ["여행 총무 ‘민수’ (1차 핵심)", "3~6인 해외여행에서 예약·지출·정산을 떠맡음", "영수증 자동 기록 + 교차정산 + 송금 링크로 총무 부담 제거"],
  ["동행자 ‘지영’", "내가 얼마 썼고 얼마 내야 하는지 투명하게 보고 싶음", "실시간 예산 대비 지출·개인별 부담액 공유"],
  ["국내 단체 ‘현우’ (확장)", "MT·워크숍·가족모임 N빵", "빠른 비용 입력·N빵 정산(환율 비중 낮음)"],
]));
children.push(P("참고: 2024년 한국인 해외출국 약 2,872만 명(2019년의 99.4% 회복), 인기 여행지 오사카·도쿄·후쿠오카·방콕·타이베이. 트리플 가입자 1,000만 명 중 2030 비중 73.5% — 우리 타겟과 일치.", { size: 19, color: GRAY }));

// 4. 시장/경쟁
children.push(H1("4. 시장 및 경쟁 분석"));
children.push(H2("4.1 경쟁 지형"));
children.push(table([2200, 2600, 2400, 2160], [
  ["서비스", "강점", "약점", "유형"],
  ["트리플", "일정·동선 공유, 1천만 가입자", "정산이 수동·단순, 영수증/환율 약함", "일정 중심"],
  ["Wanderlog", "협업 일정, 글로벌 100만+ 사용자", "정산·환율 기능 미흡", "일정 중심"],
  ["Splitwise", "복잡한 N빵·교차정산 강력", "일정(동선) 없음, OCR·자동환율은 유료", "정산 중심"],
  ["트래블월렛", "해외결제·공동지갑", "일정/정산 워크플로우 부재", "결제 중심"],
]));
children.push(P("Splitwise는 영수증 OCR과 자동 환율 변환을 유료(Pro, 약 $5/월·$40/년)로만 제공하고 무료는 일 3~4건 입력 제한이 있다. TripMoney는 이 두 기능을 핵심 흐름에 기본 탑재하고, 일정 컨텍스트와 결합한다는 점이 결정적 차이다.", { size: 19, color: GRAY }));
children.push(H2("4.2 차별화 (포지셔닝)"));
children.push(B("|b|End-to-End 단일 워크플로우: 일정→영수증→자동귀속→환율→정산→송금까지 한 흐름."));
children.push(B("|b|AI 에이전트 네이티브: 앱 설치·화면 학습 없이 채팅 한 줄로 실행(MCP). 진입장벽 최소."));
children.push(B("|b|컨텍스트 자동화: 영수증 지출 시각으로 진행 중 일정에 자동 귀속, 현지통화 실시간 한화 환산."));
children.push(B("|b|정산 라스트마일: ‘계산’에서 끝내지 않고 토스 송금 딥링크·카톡 공유 메시지까지."));

// 5. 사용자 시나리오
children.push(H1("5. 핵심 사용자 시나리오 (E2E)"));
children.push(P("방콕 3박4일, 민수·지영·현우. (괄호 안은 대응되는 MCP Tool)"));
children.push(Bn("민수가 채팅에 “방콕 3박 여행방 만들고 셋 추가” → 여행방·멤버 생성 (createTrip / addMember)"));
children.push(Bn("“7/1 오후 2시 오아시스 스파, 예산 10만원” → 일정 등록 (addSchedule)"));
children.push(Bn("스파에서 결제 후 영수증 촬영 → 금액·가맹점 자동 추출, 현지 2,000밧 → 한화 자동 환산, 진행 중 일정에 자동 귀속 (scanReceipt)"));
children.push(Bn("“택시비 300밧 현금, 내가 냄” → 카드/현금 구분 비용 등록 (addExpense)"));
children.push(Bn("“지금까지 얼마 썼어?” → 예산 대비 지출·통화별·일정별 요약 (getBudgetSummary)"));
children.push(Bn("“N빵으로 정산” → 멤버별 부담액·‘누가 누구에게 얼마’ + 토스 송금 링크 (calculateSettlement)"));

// 6. 기능 요구사항
children.push(H1("6. 기능 요구사항"));
children.push(P("우선순위: M(Must, MVP·구현완료) / S(Should) / C(Could). 현재 8개 Tool은 모두 구현·배포 완료(M)."));
children.push(table([2100, 4500, 1300, 1460], [
  ["기능(Tool)", "설명", "우선순위", "상태"],
  ["createTrip", "여행방 생성(기준통화·기간·초기멤버, 보호키 발급 옵션)", "M", "완료"],
  ["addMember", "멤버 추가(역할·송금 계좌)", "M", "완료"],
  ["addSchedule", "일정 등록(일정별 예산)", "M", "완료"],
  ["updateSchedule", "일정 수정(권한 검사, 지연 일정 조정)", "M", "완료"],
  ["addExpense", "비용 직접 등록(현지통화→한화, 카드/현금, 분담)", "M", "완료"],
  ["scanReceipt", "영수증 OCR 자동 등록(시간 기반 일정 자동귀속)", "M", "완료"],
  ["getBudgetSummary", "예산/지출 요약(통화·결제수단·일정·멤버별)", "M", "완료"],
  ["calculateSettlement", "정산(N빵/분담/각자) + 송금 딥링크", "M", "완료"],
  ["상황인지 일정 제안", "현재 시각·위치 기반 지연 알림/재배치 제안", "S", "계획"],
  ["영수증 특화모델", "CLOVA Receipt 모델로 구조화 인식 정확도↑", "S", "승인 대기"],
  ["조회 대시보드(웹)", "비개발 사용자용 확인 화면", "S", "프로토타입"],
  ["해외 송금 연동", "페이팔/트래블월렛 등 해외 정산", "C", "검토"],
]));

// 7. 정산 로직
children.push(H1("7. 정산 로직 명세"));
children.push(P("balance = paid(실제 지불) − owed(부담). 양수면 받을 돈, 음수면 줄 돈. 최소 송금 횟수는 그리디 매칭(받을 사람·줄 사람 최대 매칭)으로 산출."));
children.push(table([1700, 4100, 3560], [
  ["모드", "owed 계산", "용도"],
  ["equal (N빵)", "총액 ÷ 인원 (전원 균등)", "다 같이 쓴 비용 균등 분배"],
  ["shares (분담)", "비용별 기록된 참여자 분담합", "일부만 먹은 카페 등 선택 정산"],
  ["individual (각자)", "owed = paid (각자 자기 지출 부담)", "각자 결제·각자 처리, 송금 없음"],
]));
children.push(P("검증: 단위 테스트 통과(equal/shares/individual/custom). 예) 민수 30,000 결제·지영 15,000 결제·전원 N빵 → 현우가 민수에게 15,000 송금 1건으로 정산.", { size: 19, color: GRAY }));

// 8. 아키텍처
children.push(H1("8. 시스템 아키텍처"));
children.push(P("사용자 질문 → PlayMCP/LLM → TripMoney MCP(Vercel 서버리스) → 일정·비용·정산 실행 → Supabase(Postgres) → 결과 반환."));
children.push(B("|b|프로토콜: MCP Streamable HTTP, stateless(서버리스 적합)."));
children.push(B("|b|DB: Supabase Postgres, 전용 tripmoney 스키마. 서버는 pg 직접연결(스키마 한정 SQL)."));
children.push(B("|b|환율: open.er-api.com 실시간 + 메모리 캐시(또는 명시 환율)."));
children.push(B("|b|OCR: 네이버 CLOVA. 영수증 이미지→금액·가맹점·일자. 미설정 시 수동 입력 폴백."));
children.push(B("|b|보안: 여행방 단위 접근키(trip_key). 보호 여행방은 키 불일치 시 차단."));
children.push(H2("8.1 데이터 모델"));
children.push(table([2000, 5300, 2060], [
  ["테이블", "주요 컬럼", "비고"],
  ["trips", "name, base_currency, 기간, api_key", "여행방·보호키"],
  ["members", "trip_id, name, role, bank/account", "역할·송금계좌"],
  ["schedules", "trip_id, title, 시간, planned_budget, status", "일정·예산"],
  ["expenses", "amount, currency, exchange_rate, amount_base, pay_method, source", "현지+한화 동시저장"],
  ["expense_shares", "expense_id, member_id, share_base", "멤버별 분담"],
]));

// 9. 비기능 요구사항
children.push(H1("9. 비기능 요구사항"));
children.push(B("|b|보안: 여행방별 격리(trip_key), 시크릿은 서버 환경변수에만 저장."));
children.push(B("|b|성능: 서버리스 콜드스타트 고려, 환율 캐시(1시간), 인덱스(trip_id 등)."));
children.push(B("|b|정확성: 통화 금액 소수 2자리 반올림, 날짜 토큰을 금액으로 오인하지 않는 통화 패턴 인식."));
children.push(B("|b|확장성: 다국가 통화, 향후 RLS·멀티테넌시 강화."));

// 10. 지표
children.push(H1("10. 성공 지표 (KPI)"));
children.push(table([3000, 3360, 3000], [
  ["구분", "지표", "초기 목표(가설)"],
  ["획득", "여행방 생성 수 / 주", "—(베타 측정)"],
  ["활성", "여행방당 비용 등록 건수", "≥ 20건/여행"],
  ["핵심가치", "영수증 OCR 자동등록 비율", "≥ 50% of 비용"],
  ["완결성", "정산 완료(송금 제안 도달) 비율", "≥ 70% of 여행방"],
  ["리텐션", "재여행 시 재사용률", "≥ 30%"],
]));

// 11. 로드맵
children.push(H1("11. 로드맵"));
children.push(table([1500, 3300, 4560], [
  ["단계", "기간(가설)", "내용"],
  ["Phase 0", "완료", "MCP 8툴·배포·PlayMCP 등재, OCR·방키·송금딥링크"],
  ["Phase 1", "+4주", "영수증 특화모델 적용, 조회용 웹 대시보드, 베타 사용자 모집"],
  ["Phase 2", "+8주", "상황인지 일정 제안(시간·GPS), 멤버 초대 링크, 카카오 로그인"],
  ["Phase 3", "+12주", "해외 송금 연동, 국내 N빵 시장 확장, 수익화 실험"],
]));

// 12. 리스크
children.push(H1("12. 리스크 및 대응"));
children.push(table([3200, 3080, 3080], [
  ["리스크", "내용", "대응"],
  ["낮은 사용 빈도", "여행 시에만 켬 → 리텐션 약함", "MCP로 진입장벽 제거, 정산·기록의 ‘필수 도구’화, 재여행 트리거"],
  ["수익모델 전환", "툴→매출 거리", "숙소·항공·환전 제휴, 프리미엄(영수증 무제한·해외송금)"],
  ["OCR 비용/정확도", "CLOVA 과금·인식 오차", "특화모델 적용, 캐시·배치, 무료 폴백 유지"],
  ["플랫폼 의존", "PlayMCP 정책", "표준 MCP라 타 호스트 이식 용이, 자체 앱 병행"],
]));

// 부록
children.push(H1("부록 A. 엔드포인트"));
children.push(B("|b|MCP Endpoint: https://tripmoney-alpha.vercel.app/mcp (Streamable HTTP, 현재 공개)"));
children.push(B("|b|Health: https://tripmoney-alpha.vercel.app/api/health"));
children.push(P("본 문서는 현재 구현 상태를 기준으로 작성되었으며, 베타 측정값에 따라 지표·우선순위는 갱신된다.", { size: 18, color: GRAY }));

// ===== 문서 빌드 =====
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 21 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 30, bold: true, color: NAVY, font: "Arial" },
        paragraph: { spacing: { before: 300, after: 140 }, outlineLevel: 0,
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BLUE, space: 4 } } } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 25, bold: true, color: BLUE, font: "Arial" },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 22, bold: true, color: TEAL, font: "Arial" },
        paragraph: { spacing: { before: 140, after: 80 }, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bul", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 280 } } } }] },
      { reference: "num", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 280 } } } }] },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
      new TextRun({ text: "TripMoney PRD v1.0  ·  대외비  ·  ", size: 16, color: GRAY }),
      new TextRun({ children: [PageNumber.CURRENT], size: 16, color: GRAY }),
    ] })] }) },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(process.argv[2] || "TripMoney_PRD.docx", buf);
  console.log("written", (buf.length / 1024).toFixed(1), "KB");
});
