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
module.exports = TM_DATA;
