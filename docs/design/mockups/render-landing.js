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
      '<div class="card-lg hero-art"><p class="sr-only">완성된 정산 결과 예시</p><div class="stack">' + U.pass(t, { index: 1, total: v.transfers.length }) +
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
    msg.style.color = "";
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
