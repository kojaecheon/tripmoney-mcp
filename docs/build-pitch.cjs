const pptx = require("pptxgenjs");
const p = new pptx();
p.layout = "LAYOUT_WIDE"; // 13.3 x 7.5
p.author = "Jake"; p.title = "TripMoney Pitch";

const INK="13233B", NAVY="1F3A5F", TEAL="1F8A8A", MINT="02C39A", ICE="E9F1F8", CARD="F4F7FB", MUT="6B7787", WHITE="FFFFFF", AMBER="C9821A", CORAL="E2574C", GOOD="1F8A5A";
const W=13.3, H=7.5;
const HF="Cambria", BF="Calibri";
const sh = () => ({ type:"outer", color:"1F3A5F", blur:9, offset:3, angle:90, opacity:0.12 });

function titleBlock(s, kicker, title, dark=false){
  s.addText(kicker.toUpperCase(), { x:0.7, y:0.5, w:11.9, h:0.3, fontFace:BF, fontSize:12, bold:true, color: dark?MINT:TEAL, charSpacing:3 });
  s.addText(title, { x:0.7, y:0.78, w:11.9, h:0.8, fontFace:HF, fontSize:32, bold:true, color: dark?WHITE:NAVY });
}
function card(s,x,y,w,h,fill=WHITE){ s.addShape(p.shapes.ROUNDED_RECTANGLE,{x,y,w,h,fill:{color:fill},rectRadius:0.09,shadow:sh()}); }
function circleNum(s,x,y,n,color=TEAL){ s.addShape(p.shapes.OVAL,{x,y,w:0.5,h:0.5,fill:{color}}); s.addText(String(n),{x,y,w:0.5,h:0.5,align:"center",valign:"middle",fontFace:HF,fontSize:18,bold:true,color:WHITE}); }

// ---------- 1. TITLE ----------
let s = p.addSlide(); s.background={color:INK};
s.addShape(p.shapes.OVAL,{x:9.6,y:-1.6,w:5.4,h:5.4,fill:{color:NAVY}});
s.addShape(p.shapes.OVAL,{x:11.2,y:3.4,w:3.6,h:3.6,fill:{color:TEAL,transparency:55}});
s.addText("TripMoney", { x:0.8, y:2.35, w:9, h:1.1, fontFace:HF, fontSize:60, bold:true, color:WHITE });
s.addText("여행 일정·비용 공유 & 정산 AI 에이전트", { x:0.82, y:3.5, w:10, h:0.6, fontFace:BF, fontSize:22, color:MINT, bold:true });
s.addText("일정 → 영수증 → 환율 환산 → 정산 → 송금까지, 채팅 한 줄로.", { x:0.82, y:4.15, w:10.5, h:0.5, fontFace:BF, fontSize:15, color:"AFC3D8" });
s.addText([
  {text:"Seed Pitch", options:{color:"AFC3D8"}},
  {text:"   ·   ", options:{color:TEAL}},
  {text:"2026.06", options:{color:"AFC3D8"}},
  {text:"   ·   ", options:{color:TEAL}},
  {text:"Jake (Platform PO)", options:{color:"AFC3D8"}},
], { x:0.82, y:6.4, w:11, h:0.4, fontFace:BF, fontSize:13 });

// ---------- 2. PROBLEM ----------
s = p.addSlide(); s.background={color:WHITE};
titleBlock(s,"Problem","여행 총무의 고질적 페인 — ‘일정 따로, 정산 따로’");
const probs=[
  ["일정 조율","단톡·메모·캡처로 흩어진 일정. 현장 지연되면 뒤 일정 수기 재조정."],
  ["지출 기록","영수증은 쌓이고 누가 뭘 냈는지 사후 복원. 현지통화 환산은 매번 암산."],
  ["정산 계산","전체 N빵·일부 참여·각자부담이 뒤섞여 ‘누가 누구에게 얼마’가 스트레스."],
  ["송금 단절","계산은 끝났는데 실제 송금은 은행·페이 앱을 따로 열어야 함."],
];
probs.forEach((c,i)=>{ const x=0.7+(i%2)*6.15, y=1.95+Math.floor(i/2)*2.35;
  card(s,x,y,5.85,2.05,CARD);
  s.addShape(p.shapes.OVAL,{x:x+0.35,y:y+0.35,w:0.5,h:0.5,fill:{color:CORAL,transparency:15}});
  s.addText(String(i+1),{x:x+0.35,y:y+0.35,w:0.5,h:0.5,align:"center",valign:"middle",fontFace:HF,bold:true,fontSize:17,color:WHITE});
  s.addText(c[0],{x:x+1.05,y:y+0.32,w:4.5,h:0.5,fontFace:HF,fontSize:19,bold:true,color:NAVY});
  s.addText(c[1],{x:x+1.05,y:y+0.85,w:4.6,h:1.0,fontFace:BF,fontSize:13.5,color:MUT,lineSpacingMultiple:1.05});
});
s.addText("통합된 단일 워크플로우를 가진 절대 강자가 아직 비어 있다.",{x:0.7,y:6.55,w:12,h:0.4,fontFace:BF,italic:true,fontSize:14,color:TEAL});

// ---------- 3. SOLUTION (flow) ----------
s = p.addSlide(); s.background={color:WHITE};
titleBlock(s,"Solution","하나의 흐름으로 잇는다 — End-to-End");
const steps=["여행방·일정\n공유","영수증\n촬영","해당 일정\n자동 귀속","현지통화\n→ 한화","N빵·각자\n정산","토스·카톡\n송금"];
steps.forEach((t,i)=>{ const x=0.62+i*2.07, y=2.5;
  card(s,x,y,1.78,1.7, i%2? ICE:CARD);
  circleNum(s,x+0.64,y+0.22,i+1, i%2?NAVY:TEAL);
  s.addText(t,{x:x+0.05,y:y+0.82,w:1.68,h:0.8,align:"center",fontFace:BF,fontSize:12.5,bold:true,color:NAVY,lineSpacingMultiple:0.95});
  if(i<5) s.addText("›",{x:x+1.72,y:y+0.45,w:0.4,h:0.8,align:"center",valign:"middle",fontFace:HF,fontSize:30,bold:true,color:TEAL});
});
s.addText("사용자 개입 최소화 — 시간의 흐름과 지출이 자동으로 연결된다.",{x:0.7,y:4.7,w:12,h:0.4,fontFace:BF,fontSize:15,color:MUT});
s.addText([
  {text:"AI 에이전트(MCP) 우선.  ", options:{bold:true,color:NAVY}},
  {text:"앱 설치·화면 학습 없이 PlayMCP·LLM 채팅 안에서 자연어로 바로 실행.", options:{color:MUT}},
],{x:0.7,y:5.45,w:12,h:0.5,fontFace:BF,fontSize:14.5});

// ---------- 4. PRODUCT (8 tools) ----------
s = p.addSlide(); s.background={color:WHITE};
titleBlock(s,"Product","이미 동작하는 8개 도구 — 자연어로 호출");
const tools=[
  ["createTrip","여행방 생성"],["addMember","멤버·계좌 추가"],["addSchedule","일정·예산 등록"],
  ["updateSchedule","일정 수정·조정"],["addExpense","비용 등록(환율)"],["scanReceipt","영수증 OCR"],
  ["getBudgetSummary","예산/지출 요약"],["calculateSettlement","N빵·송금 정산"],
];
tools.forEach((t,i)=>{ const x=0.7+(i%4)*3.05, y=2.1+Math.floor(i/4)*1.5;
  card(s,x,y,2.85,1.3,CARD);
  s.addText(t[0],{x:x+0.25,y:y+0.22,w:2.5,h:0.4,fontFace:"Consolas",fontSize:13,bold:true,color:TEAL});
  s.addText(t[1],{x:x+0.25,y:y+0.66,w:2.5,h:0.5,fontFace:BF,fontSize:13.5,color:NAVY});
});
card(s,0.7,5.35,11.9,1.45, INK);
s.addText([
  {text:"“방콕 3박 여행방 만들고 셋 추가” → ",options:{color:"AFC3D8"}},
  {text:"createTrip·addMember",options:{color:MINT,bold:true}},
  {text:"     “이 영수증 등록” → ",options:{color:"AFC3D8"}},
  {text:"scanReceipt",options:{color:MINT,bold:true}},
  {text:"     “N빵 정산” → ",options:{color:"AFC3D8"}},
  {text:"calculateSettlement",options:{color:MINT,bold:true}},
],{x:1.0,y:5.6,w:11.3,h:1,fontFace:BF,fontSize:14.5,valign:"middle",lineSpacingMultiple:1.3});

// ---------- 5. DIFFERENTIATION ----------
s = p.addSlide(); s.background={color:WHITE};
titleBlock(s,"Why us","차별화 — 컨텍스트 자동화 + 라스트마일");
const diff=[
  ["영수증 OCR 기본","사진 한 장 → 금액·가맹점·일자 자동. (경쟁사는 유료 전용)"],
  ["실시간 환율 환산","현지통화 입력 즉시 한화 환산·저장. 해외여행 핵심."],
  ["시간 기반 자동 귀속","지출 시각으로 진행 중 일정에 자동 매칭."],
  ["정산 라스트마일","토스 송금 딥링크 + 카톡 공유로 ‘계산→송금’ 단절 제거."],
];
diff.forEach((c,i)=>{ const y=2.0+i*1.18;
  card(s,0.7,y,11.9,1.02, i%2?ICE:CARD);
  s.addShape(p.shapes.OVAL,{x:1.0,y:y+0.26,w:0.5,h:0.5,fill:{color:TEAL}});
  s.addText("✓",{x:1.0,y:y+0.26,w:0.5,h:0.5,align:"center",valign:"middle",fontFace:BF,fontSize:18,bold:true,color:WHITE});
  s.addText(c[0],{x:1.75,y:y+0.16,w:3.6,h:0.7,fontFace:HF,fontSize:17,bold:true,color:NAVY,valign:"middle"});
  s.addText(c[1],{x:5.5,y:y+0.16,w:6.9,h:0.7,fontFace:BF,fontSize:13.5,color:MUT,valign:"middle"});
});

// ---------- 6. MARKET ----------
s = p.addSlide(); s.background={color:WHITE};
titleBlock(s,"Market","시장 — 회복된 해외여행 수요, MZ 중심");
const stats=[["2,872만","2024 한국인 해외출국 (’19년 99.4%)"],["1,000만","여행앱 트리플 가입자"],["73.5%","트리플 이용자 중 2030 비중"]];
stats.forEach((c,i)=>{ const x=0.7+i*4.0;
  card(s,x,1.95,3.75,1.85, i===0?NAVY:CARD);
  s.addText(c[0],{x:x+0.1,y:2.15,w:3.55,h:0.95,align:"center",fontFace:HF,fontSize:40,bold:true,color:i===0?WHITE:TEAL});
  s.addText(c[1],{x:x+0.25,y:3.12,w:3.25,h:0.6,align:"center",fontFace:BF,fontSize:12.5,color:i===0?"CADCFC":MUT});
});
s.addText("한국인 인기 해외 여행지 (2024, 백만 명)",{x:0.7,y:4.1,w:8,h:0.4,fontFace:BF,fontSize:13,bold:true,color:NAVY});
s.addChart(p.charts.BAR,[{name:"방문자",labels:["일본","베트남","중국","태국·기타"],values:[8.6,4.49,2.3,3.2]}],{
  x:0.6,y:4.45,w:8.1,h:2.7,barDir:"col",chartColors:[TEAL],
  showValue:true,dataLabelPosition:"outEnd",dataLabelColor:NAVY,dataLabelFontSize:11,
  catAxisLabelColor:MUT,valAxisHidden:true,valGridLine:{style:"none"},catGridLine:{style:"none"},showLegend:false,
  chartArea:{fill:{color:WHITE}},
});
card(s,9.0,4.45,3.6,2.7,ICE);
s.addText("인기지 톱5",{x:9.3,y:4.62,w:3,h:0.4,fontFace:HF,fontSize:15,bold:true,color:NAVY});
s.addText([
  {text:"오사카 · 도쿄 · 후쿠오카",options:{breakLine:true,color:NAVY,bold:true}},
  {text:"방콕 · 타이베이",options:{breakLine:true,color:NAVY,bold:true}},
  {text:"→ 전부 환율·영수증 페인이 큰",options:{breakLine:true,color:MUT}},
  {text:"   해외 단거리 그룹 여행",options:{color:MUT}},
],{x:9.3,y:5.1,w:3.1,h:1.9,fontFace:BF,fontSize:13,lineSpacingMultiple:1.25});

// ---------- 7. COMPETITION ----------
s = p.addSlide(); s.background={color:WHITE};
titleBlock(s,"Competition","경쟁 — 통합 흐름은 비어 있다");
const Y="✓", N="–";
const rows=[
  [{text:"",options:{fill:{color:WHITE}}},
   {text:"일정 공유",options:{bold:true,color:WHITE,fill:{color:NAVY},align:"center"}},
   {text:"정산/N빵",options:{bold:true,color:WHITE,fill:{color:NAVY},align:"center"}},
   {text:"영수증 OCR",options:{bold:true,color:WHITE,fill:{color:NAVY},align:"center"}},
   {text:"자동 환율",options:{bold:true,color:WHITE,fill:{color:NAVY},align:"center"}},
   {text:"AI/채팅",options:{bold:true,color:WHITE,fill:{color:NAVY},align:"center"}}],
];
const data=[
  ["트리플 / Wanderlog", Y, "△", N, N, N],
  ["Splitwise", N, Y, "유료", "유료", N],
  ["트래블월렛", N, N, N, "환전", N],
  ["TripMoney", Y, Y, Y, Y, Y],
];
data.forEach((r,ri)=>{
  const isUs = r[0]==="TripMoney";
  const row=[{text:r[0],options:{bold:true,color:isUs?WHITE:NAVY,fill:{color:isUs?TEAL:CARD},align:"left",valign:"middle"}}];
  for(let c=1;c<r.length;c++){
    const v=r[c]; const mark = v===Y?Y:(v===N?N:v);
    const col = v===Y?GOOD:(v===N?"C4CCD6":(isUs?WHITE:AMBER));
    row.push({text:mark,options:{align:"center",valign:"middle",bold:true,color:isUs&&v===Y?WHITE:col,fill:{color:isUs?TEAL:(ri%2?CARD:WHITE)}}});
  }
  rows.push(row);
});
s.addTable(rows,{x:0.7,y:2.2,w:11.9,colW:[3.5,1.68,1.68,1.68,1.68,1.68],rowH:[0.55,0.7,0.7,0.7,0.85],
  border:{type:"solid",pt:1,color:"E1E7EF"},fontFace:BF,fontSize:14,valign:"middle"});
s.addText("TripMoney만 일정·정산·OCR·환율·AI를 한 제품에서 기본 제공.",{x:0.7,y:6.65,w:12,h:0.4,fontFace:BF,italic:true,fontSize:14,color:TEAL});

// ---------- 8. BUSINESS MODEL ----------
s = p.addSlide(); s.background={color:WHITE};
titleBlock(s,"Business model","수익 모델 — 무료 코어 + 제휴 + 프리미엄");
const bm=[
  ["여행 제휴 (메인)","숙소·항공·환전·현지 액티비티 송객 수수료. 일정·예산 데이터로 정밀 타게팅."],
  ["프리미엄 구독","영수증 무제한·해외 송금 연동·고급 정산 리포트 (Splitwise Pro 벤치마크)."],
  ["B2B / 임베드","여행사·모임 플랫폼에 정산 엔진 API·MCP 임베드."],
];
bm.forEach((c,i)=>{ const x=0.7+i*4.0;
  card(s,x,2.1,3.75,3.4,CARD);
  circleNum(s,x+0.3,y=2.4,i+1,TEAL);
  s.addText(c[0],{x:x+0.3,y:3.05,w:3.2,h:0.7,fontFace:HF,fontSize:18,bold:true,color:NAVY});
  s.addText(c[1],{x:x+0.3,y:3.75,w:3.2,h:1.6,fontFace:BF,fontSize:13.5,color:MUT,lineSpacingMultiple:1.1});
});
s.addText("핵심: 여행 ‘빈도’ 한계는 정산·기록의 필수 도구화 + 재여행 트리거로 보완.",{x:0.7,y:5.8,w:12,h:0.4,fontFace:BF,fontSize:14,color:NAVY,bold:true});

// ---------- 9. ROADMAP ----------
s = p.addSlide(); s.background={color:WHITE};
titleBlock(s,"Roadmap","로드맵");
const rm=[
  ["Phase 0","완료","MCP 8툴·배포·PlayMCP 등재, OCR·방키·송금딥링크", MINT],
  ["Phase 1","+4주","영수증 특화모델, 조회 웹 대시보드, 베타 모집", TEAL],
  ["Phase 2","+8주","상황인지 일정 제안(시간·GPS), 초대링크, 카카오 로그인", NAVY],
  ["Phase 3","+12주","해외 송금 연동, 국내 N빵 확장, 수익화 실험", "3A4A60"],
];
rm.forEach((c,i)=>{ const x=0.7+i*3.05;
  card(s,x,2.3,2.85,3.4,WHITE);
  s.addShape(p.shapes.ROUNDED_RECTANGLE,{x,y:2.3,w:2.85,h:0.85,fill:{color:c[3]},rectRadius:0.09});
  s.addText(c[0],{x:x+0.2,y:2.42,w:2.5,h:0.35,fontFace:HF,fontSize:16,bold:true,color:WHITE});
  s.addText(c[1],{x:x+0.2,y:2.76,w:2.5,h:0.3,fontFace:BF,fontSize:12,color:"E9F1F8"});
  s.addText(c[2],{x:x+0.22,y:3.35,w:2.45,h:2.1,fontFace:BF,fontSize:13,color:NAVY,lineSpacingMultiple:1.15});
});
s.addText("Phase 0는 이미 실서버에서 동작 — 가설검증을 코드가 아니라 사용자로 시작할 수 있는 단계.",{x:0.7,y:5.95,w:12,h:0.4,fontFace:BF,italic:true,fontSize:13.5,color:MUT});

// ---------- 10. CLOSING ----------
s = p.addSlide(); s.background={color:INK};
s.addShape(p.shapes.OVAL,{x:-1.6,y:3.6,w:5,h:5,fill:{color:NAVY}});
s.addShape(p.shapes.OVAL,{x:10.6,y:-1.4,w:4.4,h:4.4,fill:{color:TEAL,transparency:55}});
s.addText("여행의 ‘시간’과 ‘돈’을,",{x:0.9,y:2.4,w:11,h:0.7,fontFace:HF,fontSize:30,color:"AFC3D8"});
s.addText("가장 매끄럽게 잇는다.",{x:0.9,y:3.1,w:11,h:0.9,fontFace:HF,fontSize:40,bold:true,color:WHITE});
s.addText("이미 동작하는 MCP로 베타를 시작합니다. 함께 만들 분을 찾습니다.",{x:0.92,y:4.25,w:11,h:0.5,fontFace:BF,fontSize:16,color:MINT});
s.addText([
  {text:"tripmoney-alpha.vercel.app/mcp",options:{color:"AFC3D8"}},
  {text:"     ·     Jake (Platform PO)",options:{color:"7E93AB"}},
],{x:0.92,y:6.5,w:11,h:0.4,fontFace:BF,fontSize:13});

p.writeFile({ fileName: process.argv[2] || "TripMoney_Pitch.pptx" }).then(f=>console.log("done", f));
