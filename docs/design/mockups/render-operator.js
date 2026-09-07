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
    return '<header class="app-head"><h1 class="sr-only">운영자 워크벤치</h1><div class="shell-app between"><div class="tabs" role="navigation" aria-label="운영자 메뉴">' + tab("케이스 큐", "queue") + tab("리드", "leads") + '<span class="pill" aria-disabled="true" title="준비 중">설정 · 준비 중</span></div><div class="stamp-inline"><span class="meta">검수 담당 · reviewer</span>' + U.btn("로그아웃", { secondary: true, href: "operator.html?state=login" }) + "</div></div></header>";
  }

  function queue(d, selectedId) {
    return '<aside id="queue"><h2 style="margin-bottom:8px;font-size:18px">케이스 큐</h2>' + sortQueue(d.cases).map(function (c) {
      var status = c.paused_reason ? U.pill("일시정지 · " + c.paused_reason, "wait") : c.sla_hours_left != null ? U.pill("SLA " + c.sla_hours_left + "h", "info") : U.pill("검토창", "");
      return '<button type="button" class="case-row' + (c.id === selectedId ? " on" : "") + '" onclick="TM_RENDER_OPERATOR.select(\'' + U.js(c.id) + '\')"><b class="num">' + c.id + "</b> · " + U.esc(c.product) + "<br>" + U.pill(stageLabel(d, c.stage), "") + " " + status + (c.objections ? " " + U.pill("이의 " + c.objections, "bad") : "") + '<span class="caption">다음 조치: ' + U.esc(c.next_action) + "</span></button>";
    }).join("") + "</aside>";
  }

  function caseHead(d, c, full) {
    var sla = c.sla_hours_left != null ? U.pill("SLA 남은 시간 " + c.sla_hours_left + "h", "info") : c.paused_reason ? U.pill("일시정지 · " + c.paused_reason, "wait") : "";
    return '<section class="card section-app" id="case-head"><div class="between"><div><p class="eyebrow num">' + c.id + " · " + U.esc(c.product) + "</p><h2>" + U.esc(c.trip_name) + "</h2></div>" + sla + "</div>" +
      U.rail(d.stages, c.stage, { badge: c.paused_reason ? "일시정지 · " + c.paused_reason : null }) +
      (c.checklist.length ? '<h3>체크포인트</h3><ul class="cond-list">' + c.checklist.map(function (i) {
        return "<li><span>" + U.esc(i.label) + (i.note ? ' <span class="reason">' + U.esc(i.note) + "</span>" : "") + "</span>" + U.pill(i.ok ? "확인" : "차단", i.ok ? "ok" : "bad") + "</li>";
      }).join("") + "</ul>" : "") + (c.blockers.length ? '<p class="blockers">차단: ' + c.blockers.map(U.esc).join(" · ") + "</p>" : "") +
      (!full && c.id === "C-014" ? U.btn("검수 열기", { href: "operator.html?state=case" }) : "") + "</section>";
  }

  function collect(c) {
    return '<section class="card section-app" id="collect"><h2>자료수집 체크리스트</h2><ul class="cond-list">' + collection(c).map(function (i) {
      return "<li><span>" + i.label + "</span>" + U.pill(i.ok ? "확인" : "미확인", i.ok ? "ok" : "bad") + "</li>";
    }).join("") + "</ul></section>";
  }

  // 목록은 근거 상태만 태그로 보여주고, 3열 비교는 아래 receipt()에서 한 지출씩 펼친다 (스펙 5.4).
  function expenseList(d) {
    return '<section class="card section-app" id="expenses"><h2>지출 목록</h2><table class="table"><thead><tr><th>지출</th><th class="num">금액</th><th>근거</th></tr></thead><tbody>' +
      d.expenses.map(function (e) {
        return '<tr class="expense"><td>' + U.esc(e.title) + '</td><td class="num">' + U.money(e.amount, e.currency, d.krw(e)) + "</td><td>" + U.tag(e.evidence) + "</td></tr>";
      }).join("") + '</tbody></table><p class="caption">한 지출의 3열 비교는 아래에서 펼쳐 봅니다.</p></section>';
  }

  function receipt(d) {
    var r = d.receipt_compare;
    var approvedAt = current && current.receipt_approved_at ? current.receipt_approved_at : r.approved_at;
    var row = function (k, v) { return "<tr><th>" + k + "</th><td>" + U.esc(v) + "</td></tr>"; };
    return '<section class="section-app" id="receipt"><h2>영수증 검수 · ' + U.esc(r.title) + ' <span class="num meta">' + r.expense_id + '</span></h2><div class="grid-3">' +
      '<div class="card"><h3>원본</h3><div class="placeholder" role="img" aria-label="영수증 원본 자리 표시"></div><p class="caption">원본은 private 저장소에서 서명된 URL로만 열립니다</p></div>' +
      '<div class="card"><h3>OCR 추출</h3><table class="kv">' + row("금액", r.ocr.amount) + row("통화", r.ocr.currency) + row("가맹점", r.ocr.merchant) + row("일시", r.ocr.date) + "</table><p class=\"caption\">신뢰도 " + U.esc(r.ocr.confidence) + "</p></div>" +
      '<form class="card stack" onsubmit="return TM_RENDER_OPERATOR.approveReceipt(event)"><h3>수정 · 승인</h3><label class="field">금액<input class="input" name="amount" value="' + U.esc(r.corrected.amount) + '"></label><label class="field">통화<input class="input" name="currency" value="' + U.esc(r.corrected.currency) + '"></label><label class="field">가맹점<input class="input" name="merchant" value="' + U.esc(r.corrected.merchant) + '"></label><label class="field">일시<input class="input" name="date" value="' + U.esc(r.corrected.date) + '"></label><p class="caption">검수자 ' + U.esc(r.reviewer) + " · 승인 시각 " + (approvedAt ? U.esc(approvedAt) : "미승인") + '</p><p class="form-msg" aria-live="polite"></p><button type="submit" class="btn">검수 승인</button></form></div></section>';
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
    var list = c.objection_list || [];
    var body;
    if (!list.length) {
      body = '<p class="meta">' + (c.stage === "participant_review" ? "미해결 이의 0건" : "참여자 검토창이 열리기 전입니다") + "</p>";
    } else {
      body = list.map(function (o) {
        var st = o.status === "resolved" ? ["해결", "ok"] : ["미해결", "bad"];
        return '<div class="decision"><span>' + U.esc(o.alias) + ' <span class="reason">' + U.esc(o.reason) + "</span></span>" + U.pill(st[0], st[1]) +
          '<span class="reason">' + U.esc(o.resolution || "해결 기록 없음") + "</span></div>";
      }).join("");
    }
    return '<section class="card section-app" id="objections"><h2>이의 목록</h2>' + body + "</section>";
  }

  function qa(d) {
    var failed = d.invariants.filter(function (i) { return i.ok === false; }).length;
    var head = current && current.qa_at
      ? '<div class="stamp-inline">' + U.stamp("qa", current.qa_at) + '<p class="meta">내부 QA 승인이 기록되었습니다.</p></div>'
      : '<p class="meta">상태를 \'확인\'으로 제출하면 내부 QA 스탬프가 찍힙니다.</p>';
    return '<section class="card section-app" id="qa"><h2>내부 QA와 잠금</h2>' + head + '<form class="stack" onsubmit="return TM_RENDER_OPERATOR.submitQa(event)"><label class="field">상태<select class="input" name="status"><option value="ok">확인</option><option value="needs_fix">수정 필요</option><option value="blocked">차단</option></select></label><label class="field">QA 의견 (추가만 가능)<textarea class="input" name="note" placeholder="짧은 내부 의견"></textarea></label><p class="caption">연락처·원문 개인정보를 입력하지 않습니다. 정정은 새 의견으로 남깁니다.</p><p class="form-msg" aria-live="polite"></p><button type="submit" class="btn btn-secondary">의견 추가</button></form>' +
      '<div class="stamp-inline" style="margin-top:12px">' + U.btn("잠금 실행", { secondary: true, disabled: true }) + '<span class="meta">불변식 ' + failed + "개 실패 · 총무 잠금 요청 없음</span></div></section>";
  }

  function ops(d) {
    return '<section class="section-app" id="ops"><div class="grid-3">' +
      '<details class="card"><summary>공유 · 폐기</summary><p class="caption">카카오 미리보기에는 여행명, 버전, 기준 환율, 송금 제안만 들어갑니다.</p>' + U.btn("링크 폐기", { secondary: true, onclick: "TM_RENDER_OPERATOR.revokeLink()" }) + "</details>" +
      '<details class="card"><summary>작업시간 · 비용 · 환불</summary><table class="kv"><tr><th>작업시간</th><td class="num">3h 40m</td></tr><tr><th>OCR 호출</th><td class="num">14건</td></tr><tr><th>환불</th><td>없음</td></tr></table></details>' +
      '<details class="card"><summary>보유 · 삭제 · 사고중단</summary><table class="kv"><tr><th>삭제 예정</th><td class="num">2026-12-08</td></tr><tr><th>삭제 요청</th><td class="num">0건</td></tr></table><label class="switch"><input type="checkbox" onchange="TM_RENDER_OPERATOR.toggleStop(this)">신규 접수 중단</label></details>' +
      "</div></section>";
  }

  // 상세 목업은 C-014에만 있다. 다른 케이스는 머리 정보와 안내만 둔다 (스펙 5.4).
  function caseDetail(d, c, full) {
    var out = caseHead(d, c, full);
    if (c.id !== "C-014") out += '<section class="card section-app" id="no-detail"><p class="meta">이 케이스의 상세 목업은 준비되지 않았습니다. 상세는 C-014에서 확인합니다.</p></section>';
    else if (full) out += collect(c) + expenseList(d) + receipt(d) + fx(d) + invariants(d) + objections(c) + qa(d) + ops(d);
    return '<section id="case" class="stack">' + out + "</section>";
  }

  function renderLeads(d) {
    var rows = [["k***@***.com", "2026-09-01", "실고객"], ["010-****-4821", "2026-09-03", "실고객"], ["m***@***.kr", "2026-09-05", "실고객"]];
    return '<section class="card section-app" id="leads"><h2>베타 리드 (마스킹)</h2><table class="table"><thead><tr><th>연락수단</th><th>접수일</th><th>분류</th></tr></thead><tbody>' + rows.map(function (r) {
      return "<tr><td>" + r[0] + '</td><td class="num">' + r[1] + "</td><td>" + r[2] + "</td></tr>";
    }).join("") + '</tbody></table><form class="stack" onsubmit="return TM_RENDER_OPERATOR.submitQa(event)"><label class="field">QA 의견 (추가만 가능)<textarea class="input" name="note" placeholder="짧은 내부 의견"></textarea></label><p class="form-msg" aria-live="polite"></p><button type="submit" class="btn btn-secondary">의견 추가</button></form></section>';
  }

  function renderState(d, st) {
    current = st;
    if (st.view === "login") return loginPage();
    var c = caseById(d, st.selected);
    var full = st.view === "case" && c.id === "C-014";
    return nav("queue") + '<main class="shell-app app-main op-grid">' + queue(d, c.id) + caseDetail(d, c, full) + "</main>";
  }
  function render(d, key) { return renderState(d, d.scenes.operator[key]); }

  function mount(html) { document.getElementById("app").innerHTML = html; U.revealRail(); }
  function toast(msg) { var t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 1800); }
  function select(id) { mount(renderState(TM_DATA, { view: current.view, selected: id })); }
  function showLeads() { mount(nav("leads") + '<main class="shell-app app-main stack">' + renderLeads(TM_DATA) + "</main>"); }
  function showQueue() { mount(renderState(TM_DATA, { view: "queue", selected: current.selected || "C-014" })); }
  function login(ev) { ev.preventDefault(); var f = ev.target, msg = f.querySelector(".form-msg"); msg.style.color = ""; if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(f.email.value.trim())) { msg.textContent = "등록된 직원 이메일을 입력해 주세요"; return false; } msg.style.color = "var(--green)"; msg.textContent = "로그인 링크를 보냈습니다 (목업)"; return false; }
  // 승인 시각·QA 시각은 장면 객체 사본에만 기록한다. TM_DATA는 바꾸지 않는다.
  function approveReceipt(ev) {
    ev.preventDefault(); var f = ev.target, msg = f.querySelector(".form-msg"); msg.style.color = "";
    if (!/^[A-Z]{3}$/.test(f.currency.value.trim())) { msg.textContent = "통화는 세 글자 코드로 확정해 주세요"; return false; }
    var st = JSON.parse(JSON.stringify(current));
    st.receipt_approved_at = "2026-09-07 10:20";
    mount(renderState(TM_DATA, st));
    return false;
  }
  function submitQa(ev) {
    ev.preventDefault(); var f = ev.target, msg = f.querySelector(".form-msg"); msg.style.color = "";
    var v = f.note.value.trim();
    if (!v) { msg.textContent = "의견을 적어 주세요"; return false; }
    if (v.length > 200 || /@|\d{6,}/.test(v)) { msg.textContent = "200자 이내로, 연락처나 긴 숫자는 넣지 않습니다"; return false; }
    if (f.status && f.status.value === "ok") {
      var st = JSON.parse(JSON.stringify(current));
      st.qa_at = "2026-09-07 10:40";
      mount(renderState(TM_DATA, st));
      return false;
    }
    msg.style.color = "var(--green)"; msg.textContent = "의견을 추가했습니다 (목업)"; f.note.value = ""; return false;
  }
  function revokeLink() { toast("참여자 링크를 폐기했습니다 (목업)"); }
  function toggleStop(cb) { toast(cb.checked ? "신규 접수를 중단했습니다 (목업)" : "신규 접수를 다시 엽니다 (목업)"); }

  return { render: render, renderState: renderState, sortQueue: sortQueue, collection: collection, renderLeads: renderLeads, select: select, showLeads: showLeads, showQueue: showQueue, login: login, approveReceipt: approveReceipt, submitQa: submitQa, revokeLink: revokeLink, toggleStop: toggleStop };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TM_RENDER_OPERATOR;
