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
