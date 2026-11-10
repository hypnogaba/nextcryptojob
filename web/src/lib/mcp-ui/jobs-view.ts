import { appShell } from "./app-shell";

/**
 * Картки вакансій у розмові з помічником: результат search_jobs ({ data: [...] }) і
 * get_my_matches ({ matches: [...] }). Посилання відкриваються через ui/open-link точно такими,
 * як прийшли (умови дошок: без своїх параметрів), джерело називаємо підписом «via».
 * 👍/👎 є лише на власних добірках людини: rate_job приймає лише вакансії, які їй надіслали.
 */
export const JOBS_VIEW_URI = "ui://nextcryptojob/jobs.html";

const CSS = `
.list{display:grid;gap:8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.title{font-weight:600;font-size:15px;margin:0}
.co{color:var(--muted);margin:2px 0 0}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{background:var(--chip);border-radius:999px;padding:2px 8px;font-size:12px;color:var(--ink)}
.chip.pay{color:var(--good);font-weight:600}
.why{margin:8px 0 0;font-size:13px}
.why b{font-weight:600}
.row{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
.apply{background:var(--accent);color:var(--on-accent);border:0;border-radius:8px;padding:6px 12px;font-weight:600}
.vote{background:transparent;border:1px solid var(--line);border-radius:8px;padding:4px 10px;color:var(--ink)}
.vote[aria-pressed=true]{border-color:var(--accent);background:var(--chip)}
.via{color:var(--muted);font-size:12px;margin-left:auto}
.gone{opacity:.6}
.foot{color:var(--muted);font-size:12px;padding:8px 2px 0}
`;

/** Тіло render(data, api): лише ES5, без шаблонних рядків (код вставляється в шаблонний рядок). */
const RENDER = `
var esc = api.esc;
var items = [], mine = false;
function money(s){
  if (!s) return "";
  var cur = s.currency || "";
  function k(n){ return n >= 1000 ? Math.round(n / 1000) + "k" : String(n); }
  var a = s.min != null ? k(s.min) : "", b = s.max != null ? k(s.max) : "";
  var r = a && b && a !== b ? a + "–" + b : (a || b);
  if (!r) return "";
  return (cur === "USD" ? "$" + r : r + " " + cur) + (s.period === "month" ? "/mo" : "");
}
if (data.data) {
  items = data.data.map(function(j){
    var place = (j.work_mode || []).indexOf("remote") >= 0 ? "Remote" : "";
    if (j.city) place = place ? place + " · " + j.city : j.city;
    return { title: j.title, company: j.company, place: place, pay: money(j.salary) || (j.salary_estimate ? "est. " + money(j.salary_estimate) : ""),
      url: j.url, via: j.via || "", why: "", date: (j.posted_at || "").slice(0, 10), ref: null, state: "ok" };
  });
} else if (data.matches) {
  mine = true;
  items = data.matches.map(function(m){
    return { title: m.title, company: m.company, place: m.location || "", pay: m.salary || "", url: m.url, via: m.via || "",
      why: m.why || "", date: m.date || "", ref: m.ref, state: m.state, vote: m.vote || null };
  });
}
if (!items.length) return '<p class="empty">' + esc(mine ? "No matches sent yet. Your first daily list comes after you finish your brief." : "No jobs match this search.") + "</p>";
var html = items.map(function(it){
  var chips = [];
  if (it.place) chips.push('<span class="chip">' + esc(it.place) + "</span>");
  if (it.pay) chips.push('<span class="chip pay">' + esc(it.pay) + "</span>");
  if (it.date) chips.push('<span class="chip">' + esc(it.date) + "</span>");
  if (it.state === "gone") chips.push('<span class="chip">closed</span>');
  var votes = "";
  if (mine && it.ref) {
    votes = '<button class="vote" data-ref="' + esc(it.ref) + '" data-v="up" aria-pressed="' + (it.vote === "up") + '" title="Good match">👍</button>' +
            '<button class="vote" data-ref="' + esc(it.ref) + '" data-v="down" aria-pressed="' + (it.vote === "down") + '" title="Not for me">👎</button>';
  }
  var apply = it.url && it.state !== "gone" ? '<button class="apply" data-link="' + esc(it.url) + '">Open job</button>' : "";
  return '<article class="card' + (it.state === "gone" ? " gone" : "") + '">' +
    '<div class="top"><div><p class="title">' + esc(it.title) + '</p><p class="co">' + esc(it.company) + "</p></div></div>" +
    (chips.length ? '<div class="meta">' + chips.join("") + "</div>" : "") +
    (it.why ? '<p class="why"><b>Why you:</b> ' + esc(it.why) + "</p>" : "") +
    '<div class="row">' + apply + votes + (it.via ? '<span class="via">via ' + esc(it.via) + "</span>" : "") + "</div>" +
  "</article>";
}).join("");
if (!window.__votesBound) {
  window.__votesBound = true;
  document.addEventListener("click", function(e){
    var b = e.target.closest && e.target.closest(".vote");
    if (!b) return;
    var ref = b.getAttribute("data-ref"), v = b.getAttribute("data-v");
    var pair = document.querySelectorAll('.vote[data-ref="' + ref + '"]');
    for (var i = 0; i < pair.length; i++) pair[i].setAttribute("aria-pressed", String(pair[i] === b));
    api.callTool("rate_job", { ref: ref, vote: v }).catch(function(){ b.setAttribute("aria-pressed", "false"); });
  });
}
return '<div class="list">' + html + '</div><p class="foot">NextCryptoJob · jobs from employer career pages and crypto job boards</p>';
`;

export const JOBS_VIEW_HTML = appShell({ name: "nextcryptojob-jobs", css: CSS, render: RENDER });
