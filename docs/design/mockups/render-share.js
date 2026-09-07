// docs/design/mockups/render-share.js — 참여자 공유 /share/:token
"use strict";
var TM_RENDER_SHARE = (function () {
  var U = TM_UI;
  var current = null, mode = "notice", noticeAt = null;
  var releaseTrap = null, lastFocus = null;

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
      return U.pass(t, { index: i + 1, total: mine.length, action: { label: "이름·금액 복사", onclick: "TM_RENDER_SHARE.copyText('" + U.js(other + " " + U.won(t.amount)) + "')" } });
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
      decideBody = '<p class="meta">무응답은 승인이 아닙니다. 검토창이 닫히면 무응답으로 기록됩니다.</p><div class="btn-row actions-fixed">' + U.btn("승인", { onclick: "TM_RENDER_SHARE.approve()" }) + U.btn("이의 제기", { secondary: true, onclick: "TM_RENDER_SHARE.objectModal()" }) + "</div>";
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
    lastFocus = document.activeElement;
    releaseTrap = U.trapModal(document.querySelector("#modal .modal"), closeModal);
  }
  function submitObjection(ev) {
    ev.preventDefault(); var f = ev.target, reason = f.reason.value.trim(), msg = f.querySelector(".form-msg");
    if (!reason) { msg.textContent = "사유를 적어 주세요"; return false; }
    closeModal(); setMyDecision("objection", reason); toast("이의를 보냈습니다"); return false;
  }
  function copyText(text) { if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {}); toast("복사했습니다: " + text); }
  function closeModal() {
    if (releaseTrap) { releaseTrap(); releaseTrap = null; }
    document.getElementById("modal").innerHTML = "";
    if (lastFocus && lastFocus.focus) { lastFocus.focus(); lastFocus = null; }
  }

  return { render: render, renderState: renderState, myTransfers: myTransfers, go: go, approve: approve, withdraw: withdraw, objectModal: objectModal, submitObjection: submitObjection, copyText: copyText, closeModal: closeModal, toast: toast };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TM_RENDER_SHARE;
