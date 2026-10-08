// docs/design/mockups/render-review.js — 총무 검토 /review/:grant
"use strict";
var TM_RENDER_REVIEW = (function () {
  var U = TM_UI;
  var current = null; // 현재 그려진 장면 객체 (상호작용 재렌더용)
  var releaseTrap = null, lastFocus = null;

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
        return U.pass(t, { index: i + 1, total: v.transfers.length, action: { label: "카톡 문구 복사", onclick: "TM_RENDER_REVIEW.copyText('" + U.js(t.from + " → " + t.to + " " + U.won(t.amount)) + "')" } });
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

  function mount(html) { document.getElementById("app").innerHTML = html; U.revealRail(); }
  function toast(msg) { var t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 1800); }
  function approve() {
    var st = JSON.parse(JSON.stringify(current));
    st.organizer_approved_at = "2026-09-06 14:30"; st.stage = "participant_review";
    st.window = { opens_at: "2026-09-06 14:30", closes_at: "2026-09-09 18:00", days_left: 3 };
    st.decisions = TM_DATA.members.filter(function (m) { return m.role !== "organizer"; }).map(function (m) { return { member_id: m.id, decision: "not_responded" }; });
    mount(renderState(TM_DATA, st)); toast("v" + st.version + " 승인 · 참여자 검토창이 열렸습니다");
  }
  function requestRevision(ev) { ev.preventDefault(); var f = ev.target; var msg = f.querySelector(".form-msg"); msg.style.color = ""; if (!f.note.value.trim()) { msg.textContent = "바꿀 내용을 적어 주세요"; return false; } msg.style.color = "var(--green)"; msg.textContent = "수정 요청을 보냈습니다 (목업)"; return false; }
  function requestLock() { toast("잠금 요청을 보냈습니다. 내부 QA 후 잠깁니다 (목업)"); }
  function copyText(text) { if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {}); toast("복사했습니다: " + text); }
  function preview() {
    var v = versionOf(TM_DATA, current).result, fx = TM_DATA.fx[TM_DATA.fx.length - 1];
    var text = "[" + TM_DATA.trip.name + "] 정산 v" + current.version + "\n기준 환율 " + fx.pair + " " + fx.rate + " (" + fx.as_of + ")\n" + v.transfers.map(function (t) { return "· " + t.from + " → " + t.to + " " + U.won(t.amount); }).join("\n") + "\n결과 링크는 만료됩니다";
    document.getElementById("modal").innerHTML = '<div class="modal-bg" onclick="TM_RENDER_REVIEW.closeModal()"><div class="modal" role="dialog" aria-modal="true" aria-label="카카오 공유 미리보기" onclick="event.stopPropagation()"><h2>카카오 공유 미리보기</h2><pre style="white-space:pre-wrap;font-size:14px">' + U.esc(text) + "</pre>" + U.btn("닫기", { secondary: true, onclick: "TM_RENDER_REVIEW.closeModal()" }) + "</div></div>";
    lastFocus = document.activeElement;
    releaseTrap = U.trapModal(document.querySelector("#modal .modal"), closeModal);
  }
  function closeModal() {
    if (releaseTrap) { releaseTrap(); releaseTrap = null; }
    document.getElementById("modal").innerHTML = "";
    if (lastFocus && lastFocus.focus) { lastFocus.focus(); lastFocus = null; }
  }

  return { render: render, renderState: renderState, lockConditions: lockConditions, approve: approve, requestRevision: requestRevision, requestLock: requestLock, copyText: copyText, preview: preview, closeModal: closeModal };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TM_RENDER_REVIEW;
