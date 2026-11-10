/**
 * Оболонка MCP App (розширення MCP «Apps», протокол 2026-01-26): HTML, який Claude, ChatGPT та
 * інші клієнти малюють у пісочниці під результатом інструмента.
 *
 * Без бібліотеки @modelcontextprotocol/ext-apps (її збірка для браузера важить 540 КБ): той самий
 * обмін JSON-RPC через postMessage, лише потрібні нам повідомлення:
 * - ui/initialize → відповідь з hostContext (тема), далі ui/notifications/initialized;
 * - ui/notifications/tool-result: результат інструмента, малюємо structuredContent;
 * - ui/notifications/host-context-changed: нова тема;
 * - ui/open-link: відкрити посилання в браузері людини (в пісочниці <a target=_blank> не працює);
 * - tools/call: викликати інструмент нашого сервера з картки (👍/👎);
 * - ui/notifications/size-changed: висота вмісту, щоб рамка не різала картки.
 * Запити від хоста (наприклад ui/resource-teardown) отримують порожню відповідь.
 *
 * `render` у рядку `script` це тіло функції `render(data, api)`: data = structuredContent,
 * api = { openLink(url), callTool(name, args), esc(text) }. Скрипт і стилі вбудовані:
 * пісочниця не пускає нікуди, крім оголошених у _meta.ui.csp доменів.
 */

export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const MCP_APPS_PROTOCOL = "2026-01-26";

export function appShell(opts: { name: string; css: string; render: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:transparent;--card:#ffffff;--ink:#14140f;--muted:#5d5d55;--line:#e2e2da;--accent:#1f5eff;--on-accent:#ffffff;--good:#167a3a;--chip:#f1f1ea}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark;--card:#1b1b18;--ink:#f2f2ec;--muted:#a3a39a;--line:#34342e;--accent:#7aa2ff;--on-accent:#0b1530;--good:#5fd38a;--chip:#26261f}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--card:#1b1b18;--ink:#f2f2ec;--muted:#a3a39a;--line:#34342e;--accent:#7aa2ff;--on-accent:#0b1530;--good:#5fd38a;--chip:#26261f}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
#app{padding:4px}
.empty{color:var(--muted);padding:12px}
button{font:inherit;cursor:pointer}
${opts.css}
</style></head>
<body><div id="app"><p class="empty">Loading…</p></div>
<script>
(function(){
  var seq = 0, pending = {};
  function send(m){ window.parent.postMessage(m, "*"); }
  function request(method, params){
    return new Promise(function(resolve, reject){
      var id = ++seq; pending[id] = { resolve: resolve, reject: reject };
      send({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }
  function notify(method, params){ send({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function esc(v){ return String(v == null ? "" : v).replace(/[&<>"']/g, function(c){ return "&#" + c.charCodeAt(0) + ";"; }); }
  function theme(ctx){ if (ctx && (ctx.theme === "dark" || ctx.theme === "light")) document.documentElement.setAttribute("data-theme", ctx.theme); }
  var api = {
    esc: esc,
    openLink: function(url){ return request("ui/open-link", { url: url }); },
    callTool: function(name, args){ return request("tools/call", { name: name, arguments: args || {} }); }
  };
  var render = function(data, api){ ${opts.render} };
  function draw(result){
    var root = document.getElementById("app");
    try {
      var data = result && result.structuredContent;
      if (result && result.isError) {
        var msg = (data && data.error && data.error.message) || (result.content && result.content[0] && result.content[0].text) || "Something went wrong.";
        root.innerHTML = '<p class="empty">' + esc(msg) + "</p>";
        return;
      }
      if (!data) { root.innerHTML = '<p class="empty">' + esc(result && result.isError ? "Something went wrong. Ask again." : "Nothing to show.") + "</p>"; return; }
      root.innerHTML = render(data, api);
    } catch (e) { root.innerHTML = '<p class="empty">Could not show this result.</p>'; }
  }
  window.addEventListener("message", function(e){
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id != null && !m.method && pending[m.id]) {
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.reject(m.error); else p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-result") draw(m.params);
    else if (m.method === "ui/notifications/host-context-changed") theme(m.params);
    else if (m.method && m.id != null) send({ jsonrpc: "2.0", id: m.id, result: {} });
  });
  document.addEventListener("click", function(e){
    var a = e.target.closest && e.target.closest("[data-link]");
    if (a) { e.preventDefault(); api.openLink(a.getAttribute("data-link")); }
  });
  api.isError = function(r){ return !r || r.isError === true; };
  window.__app = api;
  var last = 0;
  if (window.ResizeObserver) new ResizeObserver(function(){
    // Висота вмісту, а не документа: scrollHeight документа не менший за саму рамку, тож не зменшувався б.
    var h = Math.ceil(document.body.getBoundingClientRect().height);
    if (h !== last) { last = h; notify("ui/notifications/size-changed", { height: h }); }
  }).observe(document.body);
  request("ui/initialize", {
    protocolVersion: "${MCP_APPS_PROTOCOL}",
    appInfo: { name: ${JSON.stringify(opts.name)}, version: "1.0.0" },
    appCapabilities: {}
  }).then(function(r){ theme(r && r.hostContext); notify("ui/notifications/initialized"); })
    .catch(function(){ notify("ui/notifications/initialized"); });
})();
</script></body></html>`;
}
