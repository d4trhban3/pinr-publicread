// The "Change log" tab on /control (the operator: "i dont need the change log on the front of the control site make it a tab next to routes"): the live
// settings' change log with its undo buttons, and the gate's versions with "undo to this", in their own panel opened from the top bar beside Routes. The
// boxes are live.js's and gate.js's own; this only places them. Nothing the server sends goes on the page as markup.
(function () {
  "use strict";
  if (typeof document === "undefined") return;
  const EVERY_MS = 3000;
  const panel = document.createElement("section");
  panel.id = "logpanel";
  panel.hidden = true;
  document.body.append(panel);
  function paint() {
    if (panel.hidden) return;
    const a = document.activeElement;
    if (a && panel.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return; // never rebuilt under typing
    const head = document.createElement("div");
    head.className = "askhead";
    const t = document.createElement("b");
    t.textContent = "Change log";
    const close = document.createElement("button");
    close.textContent = "close";
    close.onclick = () => (panel.hidden = true);
    head.append(t, close);
    const parts = [head];
    if (window.PinrLive && window.PinrLive.logBox) parts.push(window.PinrLive.logBox());
    if (window.PinrGate && window.PinrGate.historyBox) parts.push(window.PinrGate.historyBox());
    panel.replaceChildren(...parts);
  }
  const header = document.querySelector("header");
  if (header) {
    const b = document.createElement("button");
    b.id = "bLog";
    b.textContent = "Change log";
    b.title = "Every live change with undo, and the gate's versions";
    b.onclick = () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        const routes = document.getElementById("routespanel");
        if (routes) routes.hidden = true; // one side panel at a time
        paint();
      }
    };
    const routesBtn = document.getElementById("bRoutes");
    if (routesBtn && routesBtn.parentNode === header) routesBtn.after(b);
    else header.insertBefore(b, header.querySelector(".sp") || null);
    // Opening Routes closes this one, the same way.
    if (routesBtn) routesBtn.addEventListener("click", () => { if (!document.getElementById("routespanel").hidden) panel.hidden = true; });
  }
  setInterval(paint, EVERY_MS);
})();
