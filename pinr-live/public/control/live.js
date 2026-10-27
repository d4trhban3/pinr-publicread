// The live layer of the blueprint page. Reads /api/control/status every few seconds (the engine's control service, through the feed server,
// behind Cloudflare Access), colours each source node, and adds controls (on/off, pace, trade-feed coin count) that POST to /api/control/set, plus the change
// log with undo. Everything the server sends is put on the page as text, never as markup. The pure parts are on window.PinrLive so they can be tested.
(function () {
  "use strict";
  // Which of the engine's request-counter names each blueprint source node stands for (the names are the control service's own list).
  const SRC = {
    s_gtnew: ["geckoterminal"], s_gtc: ["geckoterminal"], s_lists: ["raydium-launchlab", "raydium"], s_pump: ["pumpfun-coins", "pumpfun-trades"],
    s_jup: ["jupiter"], s_rpc: ["helius", "helius-history", "shyft", "shyft-parse", "chainstack", "public", "publicnode-solana"], s_ipfs: ["ipfs"],
    s_dex: ["dexscreener"], s_x: ["x-api"],
  };
  const TRADES_NODE = "s_ws";
  const AI_NODE = "e_ai";
  const EVERY_MS = 5000;

  /** One source's counters added together over the sources a node stands for. */
  function sum(sources, names) {
    const t = { calls: 0, ok: 0, errors: 0, http429: 0, timeouts: 0, last_ok: null, seen: 0 };
    for (const n of names) {
      const s = sources && sources[n];
      if (!s || typeof s !== "object") continue;
      t.seen++;
      for (const k of ["calls", "ok", "errors", "http429", "timeouts"]) t[k] += Number.isFinite(s[k]) ? s[k] : 0;
      if (typeof s.last_ok === "string" && (!t.last_ok || s.last_ok > t.last_ok)) t.last_ok = s.last_ok;
    }
    return t;
  }
  /** off (switched off in the control file), red (calls and none good, or a third failing), warn (a 429 or a timeout), idle (no calls in the hour), ok. */
  function stateOf(total, allOff) {
    if (allOff) return "off";
    if (total.calls === 0) return "idle";
    if (total.ok === 0 || total.errors / total.calls >= 0.3) return "red";
    if (total.http429 > 0 || total.timeouts > 0) return "warn";
    return "ok";
  }
  function ageText(iso, now) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "no good read yet";
    const s = Math.max(0, Math.round(((now || Date.now()) - ms) / 1000));
    return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  }
  function badgeText(total, state) {
    if (state === "off") return "switched off";
    if (state === "idle") return "no calls this hour";
    return `${total.calls} calls · ${total.errors} err${total.http429 ? ` · ${total.http429}×429` : ""}${total.timeouts ? ` · ${total.timeouts} timeouts` : ""}`;
  }
  const isOn = (control, name) => !(control && control.sources && control.sources[name] && control.sources[name].on === false);
  /** The control file's value for a key we may set. */
  const paceOf = (control, name) => (control && control.sources && control.sources[name] ? control.sources[name].pace_per_min ?? null : null);

  /** PINRai's switch and daily cap in the control file: off unless it says on; the cap is the server's own when none is set. */
  const aiOn = (control) => !!(control && control.pinrai && control.pinrai.on === true);
  const aiCap = (control) => (control && control.pinrai && Number.isFinite(control.pinrai.daily_dollar_cap) ? control.pinrai.daily_dollar_cap : null);
  /** The cap the server accepts: dollars above 0, at most 25, whole cents. null when it would be refused. */
  function capValue(text) {
    const t = String(text).trim();
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
    const v = Number(t);
    return v > 0 && v <= 25 ? v : null;
  }
  /** Spend and coins read, only when the server reports them (status.pinrai: used_pct, coins_read); otherwise the plain words that it does not. */
  function aiUsage(report) {
    const r = report && typeof report === "object" ? report : {};
    const bits = [];
    if (Number.isFinite(r.used_pct)) bits.push(`today's spend: ${Math.round(r.used_pct)}% of the cap`);
    if (Number.isFinite(r.coins_read)) bits.push(`${r.coins_read} coin${r.coins_read === 1 ? "" : "s"} read today`);
    return bits.length ? bits.join(" · ") : "Spend and coins read: not reported by the server yet.";
  }

  /** What an edit of the current selection does: nothing on the server (drawing only), except the controls the page adds for a source node. */
  const NOTE_ALL = "Live settings, which change the server: a source on or off, its pace, the coins the trade feed watches, PINRai on or off and its daily cap; the gate's checks (after Preview and Apply); and under Routes (after Preview and Apply) which source fills a coin's picture, links, token data, price, volume, liquidity and candles, the launchpad switches, the Solana node order and the trade feed's nodes. A map wire marked \"live\" is one of those routes. Everything else you draw or edit here (other wires, nodes, notes) is drawing only: saved in your browser, nothing on the server changes.";
  function modeNote(selected, hasLive, isRoute) {
    if (!selected) return NOTE_ALL;
    if (selected.type === "wire" && isRoute) return "This wire is live: drawing or removing it stages the change (under Routes, or on the gate), and nothing changes on the server until Preview and Apply. How it looks here is saved in your browser.";
    const what = selected.type === "wire" ? "this wire" : "this node's title, kind, status, notes, pins and wires";
    return `Drawing only: ${what} ${selected.type === "wire" ? "is" : "are"} saved in your browser and change${selected.type === "wire" ? "s" : ""} nothing on the server.${hasLive ? " The controls further down are live: a source's settings change the server at once, the gate's only after Preview and Apply." : ""}`;
  }
  const DRAWING_TOAST = "Drawing only: saved in this browser, nothing on the server changes";
  /**
   * The operator: one short label. "Live control" only when he can actually control the blueprint: his wire edits on the map stage
   * real route changes through Preview and Apply (routes.js, since this build), AND the server says this signed-in viewer's changes are accepted
   * (`status.viewer.can_apply === true`, DATA). Anything else, including a status that answers without that yes, is "Read only"; nothing is guessed.
   */
  /** The badge's hover: who "Live control" is for, and why a browser may say "Read only". */
  const hoverOf = (label, problem) =>
    label === "Live control"
      ? "Live control: changes made on this page are accepted by the server. Anyone Cloudflare Access lets in sees this; there is no per-person list."
      : `Read only: changes from this page would not be accepted now${problem ? ` (${problem})` : ""}. Safari before 16.4 always shows Read only (it does not send the header the server checks).`;
  const liveLabel = (status, problem) => (status && !problem && status.viewer && status.viewer.can_apply === true ? "Live control" : "Read only");

  window.PinrLive = { hoverOf, liveLabel, AI_NODE, aiOn, aiCap, capValue, aiUsage, SRC, TRADES_NODE, sum, stateOf, ageText, badgeText, isOn, paceOf, modeNote, NOTE_ALL, DRAWING_TOAST };
  if (typeof document === "undefined") return;

  let last = null; // the latest status answer
  window.PinrLive.current = () => last; // for the badge layer
  let problem = null; // why there is none
  const $b = () => document.getElementById("livebar");
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  function paintNodes() {
    for (const e of document.querySelectorAll("#world .node")) {
      const id = e.dataset.id;
      const names = SRC[id];
      e.classList.remove("lv-ok", "lv-warn", "lv-red", "lv-off");
      let b = e.querySelector(".lv");
      if (!names || !last || !last.engine) {
        if (b) b.remove();
        continue;
      }
      const total = sum(last.engine.sources, names);
      const ctl = last.control || {};
      const state = total.seen === 0 && names.every((n) => isOn(ctl, n)) ? "idle" : stateOf(total, names.every((n) => !isOn(ctl, n)));
      if (!b) {
        b = el("div", "lv");
        const nb = e.querySelector(".nb");
        e.insertBefore(b, nb || null);
      }
      b.textContent = badgeText(total, state);
      b.title = names.map((n) => { const s = last.engine.sources[n]; return s ? `${n}: ${s.calls} calls, ${s.ok} ok, ${s.errors} errors, ${s.http429} 429s, ${s.timeouts} timeouts, last good ${ageText(s.last_ok)}` : `${n}: not asked this hour`; }).join("\n");
      if (state !== "idle") e.classList.add("lv-" + state);
    }
    const ae = document.querySelector(`#world .node[data-id="${AI_NODE}"]`);
    if (ae) {
      let b = ae.querySelector(".lv");
      if (!last || !last.control) { if (b) b.remove(); ae.classList.remove("lv-ok", "lv-off"); }
      else {
        if (!b) { b = el("div", "lv"); ae.insertBefore(b, ae.querySelector(".nb") || null); }
        const on = aiOn(last.control);
        b.textContent = on ? "on" : "switched off";
        b.title = aiUsage(last.pinrai);
        ae.classList.toggle("lv-ok", on);
        ae.classList.toggle("lv-off", !on);
      }
    }
    const ln = document.getElementById("livenote");
    if (ln) {
      const label = liveLabel(last, problem);
      ln.textContent = label;
      ln.title = hoverOf(label, problem);
      ln.classList.toggle("on", label === "Live control");
    }
    const bar = $b();
    if (bar) {
      bar.className = problem ? "bad" : last ? "ok" : "";
      bar.textContent = problem ? `Live data unavailable: ${problem}` : last ? `Status read · ${new Date(last.as_of).toLocaleTimeString()}${last.who ? " · " + last.who : ""}` : "Live data: loading…";
    }
  }

  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) throw new Error((j && j.error) || `the service answered ${r.status}`);
    return j;
  }
  async function change(key, value) {
    try {
      const j = await post("/api/control/set", { key, value });
      if (last) last.control = j.control;
      toastMsg("Saved: " + key);
      await poll();
    } catch (e) { toastMsg("Not saved: " + e.message); }
  }
  async function undo(id) {
    try {
      const j = await post("/api/control/undo", { id });
      if (last) last.control = j.control;
      toastMsg("Undone");
      await poll();
    } catch (e) { toastMsg("Not undone: " + e.message); }
  }
  const toastMsg = (m) => { if (typeof toast === "function") toast(m); };

  function controls(id) {
    const box = el("div", "lvbox");
    box.id = "livectl";
    if (!last) return box;
    const ctl = last.control || {};
    if (SRC[id]) {
      box.append(el("h3", "", "Controls"));
      for (const name of SRC[id]) {
        const row = el("div", "lvrow");
        row.append(el("b", "", name));
        const on = isOn(ctl, name);
        const t = el("button", on ? "on" : "off", on ? "on" : "off");
        t.title = on ? "Switch this source off" : "Switch this source on";
        t.onclick = () => change(`sources.${name}.on`, !on);
        const pace = el("input");
        pace.type = "number"; pace.min = "1"; pace.max = "6000"; pace.placeholder = "no limit";
        const p = paceOf(ctl, name);
        pace.value = p === null ? "" : String(p);
        pace.title = "Most calls a minute (empty: no limit)";
        const set = el("button", "", "set pace");
        set.onclick = () => {
          const v = pace.value.trim();
          if (v !== "" && !(Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 6000)) return toastMsg("Pace: a whole number 1 to 6000, or empty");
          change(`sources.${name}.pace_per_min`, v === "" ? null : Number(v));
        };
        row.append(t, pace, set);
        box.append(row);
      }
      box.append(el("div", "lvnote", "A source switched off is never asked by the engine; a pace holds it to that many calls a minute (per process)."));
    } else if (id === AI_NODE) {
      box.append(el("h3", "", "Controls"));
      const on = aiOn(ctl);
      const row = el("div", "lvrow");
      row.append(el("b", "", "PINRai"));
      const t = el("button", on ? "on" : "off", on ? "on" : "off");
      t.title = on ? "Switch PINRai off (off always wins)" : "Switch PINRai on";
      t.onclick = () => change("pinrai.on", !on);
      row.append(t);
      box.append(row);
      const crow = el("div", "lvrow");
      crow.append(el("b", "", "Daily cap ($)"));
      const inp = el("input");
      inp.type = "text"; inp.inputMode = "decimal"; inp.placeholder = "the server's own";
      const cap = aiCap(ctl);
      inp.value = cap === null ? "" : String(cap);
      const set = el("button", "", "set cap");
      set.onclick = () => {
        const v = capValue(inp.value);
        if (v === null) return toastMsg("Cap: dollars above 0 and at most 25, in cents (for example 5 or 7.50)");
        change("pinrai.daily_dollar_cap", v);
      };
      crow.append(inp, set);
      box.append(crow);
      box.append(el("div", "lvnote", aiUsage(last.pinrai)));
      box.append(el("div", "lvnote", "PINRai reads only coins that passed the gate and sends nothing while it is off; the cap stops the day's reading."));
    } else if (id === TRADES_NODE) {
      box.append(el("h3", "", "Controls"));
      const row = el("div", "lvrow");
      row.append(el("b", "", "Trade feed coins"));
      const inp = el("input");
      inp.type = "number"; inp.min = "1"; inp.max = "1000";
      inp.value = ctl.trades_ws_max_coins === undefined ? "" : String(ctl.trades_ws_max_coins);
      const set = el("button", "", "set");
      // With a trade feed wire applied under Routes, its coin count is set there (the server refuses this setting then).
      const wired = !!(window.PinrRoutes && window.PinrRoutes.current && window.PinrRoutes.tradeFeedApplied(window.PinrRoutes.current()));
      inp.disabled = wired;
      set.disabled = wired;
      set.onclick = () => {
        const v = Number(inp.value);
        if (!Number.isInteger(v) || v < 1 || v > 1000) return toastMsg("Coins: a whole number 1 to 1000");
        change("trades_ws_max_coins", v);
      };
      row.append(inp, set);
      box.append(row);
      if (wired) box.append(el("div", "lvnote", "Set under Routes: the trade feed wire is applied, and it sets the coins watched (the server refuses this one while it is)."));
      if (last.trades && typeof last.trades === "object") {
        const bits = Object.entries(last.trades).filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean").slice(0, 6).map(([k, v]) => `${k}: ${v}`);
        if (bits.length) box.append(el("div", "lvnote", bits.join(" · ")));
      }
    }
    return box;
  }

  function log() {
    const box = el("div", "lvbox lvlog");
    box.id = "livelog";
    box.append(el("h3", "", "Change log"));
    const list = last && Array.isArray(last.recent_changes) ? last.recent_changes : [];
    if (!list.length) box.append(el("div", "", last ? "No changes yet." : "No live data."));
    for (const c of list.slice(0, 20)) {
      const row = el("div");
      row.append(el("span", "", `${new Date(c.at).toLocaleTimeString()} · ${c.who} · ${c.key}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}${c.undo_of ? " (undo)" : ""}`));
      if (!c.undo_of) {
        const u = el("button", "", "undo");
        u.onclick = () => undo(c.id);
        row.append(u);
      }
      box.append(row);
    }
    return box;
  }

  function paintPanel() {
    const panel = document.getElementById("panel");
    if (!panel) return;
    for (const x of panel.querySelectorAll("#livectl, #livemode, #livehelp")) x.remove();
    const id = typeof sel !== "undefined" && sel && sel.type === "node" ? sel.id : null;
    const gateNode = !!(id && window.PinrGate && window.PinrGate.CHECKS_OF[id]);
    const label = liveLabel(last, problem);
    const mode = el("div", `lvmode${label === "Live control" ? " on" : ""}`, label);
    mode.id = "livemode";
    mode.title = hoverOf(label, problem);
    panel.prepend(mode);
    if (id && (SRC[id] || id === TRADES_NODE || id === AI_NODE)) panel.append(controls(id));
    // The long explanation lives in the help text at the foot of the side panel (the operator: the note itself says only "Read only" or "Live control").
    const selNow = typeof sel !== "undefined" ? sel : null;
    const R = window.PinrRoutes;
    const st = R && R.current ? R.current() : null;
    const isRoute = !!(selNow && selNow.type === "wire" && typeof G !== "undefined" && ((R && st && st.catalog && R.routesOfWire(G.wires[selNow.id], st.catalog).length) || (window.PinrGate && window.PinrGate.isGateWire && window.PinrGate.isGateWire(G.wires[selNow.id]))));
    const help = el("div", "lvnote lvhelp", modeNote(selNow, !!(id && (SRC[id] || id === TRADES_NODE || id === AI_NODE)) || gateNode, isRoute));
    help.id = "livehelp";
    panel.append(help);
    // The change log is no longer on the side panel: it has its own "Change log" tab beside Routes (logtab.js).
  }
  window.PinrLive.logBox = () => log();

  async function poll() {
    try {
      const r = await fetch("/api/control/status", { cache: "no-store" });
      if (!r.ok) {
        let m = `the service answered ${r.status}`;
        try { const j = await r.json(); if (j && j.error) m = j.error; } catch { /* not JSON */ }
        throw new Error(m);
      }
      last = await r.json();
      problem = null;
    } catch (e) {
      problem = e.message || "no answer";
    }
    paintNodes();
    // Controls are rebuilt only when nothing in the panel has the cursor (a number being typed is never taken away).
    const panel = document.getElementById("panel");
    if (panel && !panel.contains(document.activeElement)) paintPanel();
  }

  // Draw again whenever the page itself redraws its nodes or its panel.
  const baseRender = window.render;
  if (typeof baseRender === "function") window.render = function () { const r = baseRender.apply(this, arguments); paintNodes(); return r; };
  const basePanel = window.renderPanel;
  if (typeof basePanel === "function") window.renderPanel = function () { const r = basePanel.apply(this, arguments); paintPanel(); return r; };

  // Every save of the drawing says what it is: drawing only (at most one reminder every 5 seconds).
  const baseSave = window.save;
  let lastToast = 0;
  if (typeof baseSave === "function") window.save = function () { const r = baseSave.apply(this, arguments); if (Date.now() - lastToast > 5000) { lastToast = Date.now(); toastMsg(DRAWING_TOAST); } return r; };

  const note = el("div", "", "Read only");
  note.id = "livenote";
  note.title = "";
  document.body.append(note);
  const bar = el("div");
  bar.id = "livebar";
  document.body.append(bar);
  paintNodes();
  paintPanel();
  poll();
  setInterval(poll, EVERY_MS);
})();
