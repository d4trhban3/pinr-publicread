// Every wire and node on the /control map in one of three measured states: LIVE (data crossed it in the last few minutes:
// items a minute, the last item's time, a sample to click), BUILDING (its meter or its code is not built yet: nothing measured flows on it), NOT LIVE
// (measured and nothing crossed lately, its source refused, or its node is planned, blocked or hidden: with the reason). The feed server measures its own
// wires (GET /api/control/sitewires); the engine's control service the engine's (GET /api/control/wires, its own shape, read by fromEngine). Nothing the
// server sends goes on the page as markup. The pure part is on window.PinrWires so it can be tested.
(function () {
  "use strict";
  const EVERY_MS = 10000;
  /** Wires the server cannot see: the visitor's browser reads these sources itself. */
  const BROWSER_DIRECT = { "s_gtc>w_chart:GeckoTerminal": 1, "s_dex>w_chart:DexScreener line": 1, "s_dex>w_links:links": 1 };
  const keyOf = (w) => `${w[0]}>${w[2]}:${w[3]}`;
  const ago = (ms, now) => {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
  };
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  /**
   * One wire's state: { state: "live" | "building" | "notlive", text (the short label), why (the plain reason), r (the reading, if measured) }.
   * w = [from, fromPin, to, toPin]; r = the reading for its key, or undefined; from = the drawn node it comes from; m = { startedMs, liveMs }.
   */
  function wireState(w, r, from, now, m) {
    const fromOff = from && ["planned", "blocked", "hidden", "notlive"].includes(from.status);
    if (r && typeof r === "object") {
      // A wire that runs in bursts and is quiet within its usual gap stays LIVE; it says so in the engine's own words (ENGINE: "between_runs").
      if (r.state === "live" && r.betweenRuns) return { state: "live", text: "LIVE · between runs", why: `${r.betweenRuns[0].toUpperCase()}${r.betweenRuns.slice(1)}${/[.!?]$/.test(r.betweenRuns) ? "" : "."}`, r };
      if (r.state === "live") return { state: "live", text: `LIVE ${r.perMin}/min`, why: `${r.last10 === null ? `${r.perMin} a minute` : `${r.last10} in the last 10 minutes`}; the last ${r.lastMs ? ago(r.lastMs, now) : "just now"}.`, r };
      if (r.state === "error") return { state: "notlive", text: "NOT LIVE", why: `Its source refused${r.errorMs ? ` ${ago(r.errorMs, now)}` : ""}: ${r.error || "an error"}.`, r };
      const mins = Math.round(((m && m.liveMs) || 300000) / 60000);
      if (r.reason) return { state: "notlive", text: "NOT LIVE", why: `${r.reason[0].toUpperCase()}${r.reason.slice(1)}${r.lastMs ? `; the last at ${clock(r.lastMs)} (${ago(r.lastMs, now)})` : ""}.`, r };
      if (r.lastMs) return { state: "notlive", text: "NOT LIVE", why: `Nothing crossed in the last ${mins} minutes; the last at ${clock(r.lastMs)} (${ago(r.lastMs, now)}).`, r };
      return { state: "notlive", text: "NOT LIVE", why: `Nothing has crossed since the feed server started${m && m.startedMs ? ` ${ago(m.startedMs, now)}` : ""}.`, r };
    }
    if (fromOff) return { state: "notlive", text: "NOT LIVE", why: `Its node is ${from.status}${from.note ? `: ${from.note}` : "."}` };
    if (BROWSER_DIRECT[keyOf(w)]) return { state: "building", text: "BUILDING", why: "The visitor's browser reads this source itself, so the server cannot see it cross; its meter is not built yet." };
    return { state: "building", text: "BUILDING", why: "Not measured yet: no meter counts this wire. The engine's meters cover the wires marked LIVE; this one is not counted yet." };
  }

  /** A node's state from its measured wires: live when any crossed lately, not live when all are measured and none did; null when none is measured. */
  function nodeState(id, wires, readings, now) {
    let measured = 0, live = 0, newest = null, err = null;
    for (const w of wires) {
      if (w[0] !== id && w[2] !== id) continue;
      const r = readings[keyOf(w)];
      if (!r) continue;
      measured++;
      if (r.state === "live") live++;
      if (r.state === "error" && !err) err = r.error;
      if (r.lastMs && (!newest || r.lastMs > newest)) newest = r.lastMs;
    }
    if (!measured) return null;
    if (live) return { text: "live", why: `data crossed ${newest ? ago(newest, now) : "just now"} (${live} of ${measured} measured wires live)`, newest };
    return { text: "notlive", why: err ? `its source refused: ${err}` : newest ? `nothing crossed since ${clock(newest)}` : "nothing has crossed since the feed server started", newest };
  }

  /**
   * the engine's engine answer ({ wires: { "from|fromPin|to|toPin": { state: "live" | "not live", per_min, last_at, sample, reason } }, nodes: { id: { state,
   * last_at, reason } } }) in this page's shape: { wires: { "from>to:toPin": reading }, nodes: { id: { text, why, newest } } }.
   */
  function fromEngine(body) {
    const wires = {}, nodes = {};
    if (!body || typeof body !== "object") return { wires, nodes };
    for (const [k, v] of Object.entries(body.wires && typeof body.wires === "object" ? body.wires : {})) {
      const p = k.split("|");
      if (p.length !== 4 || !v || typeof v !== "object") continue;
      const lastMs = typeof v.last_at === "string" && Number.isFinite(Date.parse(v.last_at)) ? Date.parse(v.last_at) : null;
      const live = v.state === "live";
      const reason = typeof v.reason === "string" ? v.reason : null;
      const refused = !live && !!reason && !/^no data/i.test(reason);
      const sample = v.sample === undefined || v.sample === null ? null : typeof v.sample === "string" ? v.sample : JSON.stringify(v.sample);
      wires[`${p[0]}>${p[2]}:${p[3]}`] = { state: live ? "live" : refused ? "error" : "quiet", perMin: Number.isFinite(v.per_min) ? v.per_min : 0, last10: null, lastMs, sample: sample && sample.slice(0, 200), error: refused ? reason : null, errorMs: null, reason: live || refused ? null : reason, ...(live && v.between_runs === true && reason ? { betweenRuns: reason.slice(0, 200) } : {}) };
    }
    for (const [id, v] of Object.entries(body.nodes && typeof body.nodes === "object" ? body.nodes : {})) {
      if (!v || typeof v !== "object") continue;
      const newest = typeof v.last_at === "string" && Number.isFinite(Date.parse(v.last_at)) ? Date.parse(v.last_at) : null;
      nodes[id] = v.state === "live" ? { text: "live", why: "the engine reports it running", newest } : { text: "notlive", why: typeof v.reason === "string" ? v.reason : "the engine reports it not running", newest };
    }
    return { wires, nodes };
  }

  /** The two readings joined: the feed server's own and the engine's (the engine's), each { key: reading }. */
  function joinReadings(site, engine) {
    const out = {};
    for (const src of [engine, site]) if (src && typeof src === "object") for (const [k, v] of Object.entries(src)) if (v && typeof v === "object" && typeof v.state === "string") out[k] = v;
    return out;
  }

  window.PinrWires = { wireState, nodeState, joinReadings, fromEngine, keyOf, BROWSER_DIRECT };
  if (typeof document === "undefined") return;

  let site = null; // the last /api/control/sitewires answer
  let siteErr = null;
  let engine = { wires: {}, nodes: {} }; // the engine's last /api/control/wires answer, converted
  const meta = () => ({ startedMs: site && site.startedMs, liveMs: site && site.liveMs });
  const readings = () => joinReadings(site && site.wires, engine.wires);
  window.PinrWires.nodeLive = (id) => {
    if (typeof G === "undefined" || !site) return null;
    return nodeState(id, G.wires, readings(), Date.now()) || engine.nodes[id] || null;
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  function paintWires() {
    const svg = document.getElementById("wires");
    if (!svg || typeof G === "undefined") return;
    for (const t of svg.querySelectorAll("text.lw")) t.remove();
    if (!site) return;
    const rd = readings(), now = Date.now();
    for (const p of svg.querySelectorAll("path[data-w]")) {
      const w = G.wires[+p.dataset.w];
      if (!w) continue;
      const s = wireState(w, rd[keyOf(w)], typeof nodeById === "function" ? nodeById(w[0]) : null, now, meta());
      p.classList.toggle("lwlive", s.state === "live");
      p.classList.toggle("lwbuild", s.state === "building");
      p.classList.toggle("lwnot", s.state === "notlive");
      p.classList.toggle("dash", s.state !== "live");
      if (s.r && typeof p.getTotalLength === "function") {
        const pt = p.getPointAtLength(p.getTotalLength() / 2);
        const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("class", "lw " + s.state);
        t.setAttribute("x", String(pt.x));
        t.setAttribute("y", String(pt.y + 14));
        t.setAttribute("text-anchor", "middle");
        t.textContent = s.text;
        svg.append(t);
      }
    }
  }

  function paintBeats() {
    if (typeof G === "undefined") return;
    const rd = readings(), now = Date.now();
    for (const e of document.querySelectorAll("#world .node")) {
      for (const x of e.querySelectorAll(".hb")) x.remove();
      if (!site) continue;
      const n = nodeState(e.dataset.id, G.wires, rd, now) || engine.nodes[e.dataset.id];
      if (!n || !n.newest) continue;
      const hb = el("div", "hb " + n.text, `${n.text === "live" ? "♥" : "♡"} last data ${ago(n.newest, now)}`);
      hb.title = n.why;
      e.querySelector(".nh")?.after(hb);
    }
  }

  function paintPanel() {
    const panel = document.getElementById("panel");
    if (!panel) return;
    for (const x of panel.querySelectorAll("#wirestate")) x.remove();
    if (typeof sel === "undefined" || !sel || sel.type !== "wire" || typeof G === "undefined") return;
    const w = G.wires[sel.id];
    if (!w) return;
    const now = Date.now();
    const box = el("div", "lvbox");
    box.id = "wirestate";
    if (!site) {
      box.append(el("h3", "", "This wire's state"), el("p", "lvnote", siteErr ? `The feed server's meters are not read: ${siteErr}.` : "Reading the meters…"));
      return void panel.append(box);
    }
    const s = wireState(w, readings()[keyOf(w)], typeof nodeById === "function" ? nodeById(w[0]) : null, now, meta());
    box.append(el("h3", "", "This wire's state"), el("b", "lwstate " + s.state, s.state === "live" ? "LIVE" : s.state === "building" ? "BUILDING" : "NOT LIVE"), el("p", "lvnote", s.why));
    if (s.r) {
      const dl = el("div", "lwfacts");
      dl.append(el("span", "", `Items a minute: ${s.r.perMin}`), el("span", "", `In the last 10 minutes: ${s.r.last10 === null ? "—" : s.r.last10}`), el("span", "", `Last item: ${s.r.lastMs ? `${clock(s.r.lastMs)} (${ago(s.r.lastMs, now)})` : "none yet"}`));
      box.append(dl);
      if (s.r.sample) {
        const addr = /[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40}/.exec(s.r.sample);
        if (addr) {
          const a = el("a", "lwsample", `Sample: ${s.r.sample}`);
          a.href = `/?coin=${encodeURIComponent(addr[0])}`;
          a.target = "_blank";
          a.rel = "noopener";
          a.title = "Open this coin's page on pinr.io";
          box.append(a);
        } else box.append(el("span", "lwsample", `Sample: ${s.r.sample}`));
      }
    }
    box.append(el("p", "lvnote", "LIVE: data crossed in the last few minutes. BUILDING: not measured or not built yet. NOT LIVE: measured and nothing crossed, its source refused, or its node is off."));
    panel.append(box);
  }

  function paint() {
    paintWires();
    paintBeats();
  }
  async function poll() {
    try {
      const r = await fetch("/api/control/sitewires", { cache: "no-store" });
      const j = r.ok ? await r.json() : null;
      if (j && j.wires && typeof j.wires === "object") { site = j; siteErr = null; } else siteErr = `answer ${r.status}`;
    } catch (e) {
      siteErr = "no answer";
    }
    try {
      const r = await fetch("/api/control/wires", { cache: "no-store" }); // the engine's engine wires; a 404 until its build is live
      engine = r.ok ? fromEngine(await r.json()) : { wires: {}, nodes: {} };
    } catch (e) {
      engine = { wires: {}, nodes: {} };
    }
    document.body.classList.toggle("lwon", !!site);
    if (typeof window.drawWires === "function") window.drawWires();
    else paint();
    paintPanel();
  }

  const baseDraw = window.drawWires;
  if (typeof baseDraw === "function") window.drawWires = function () { const r = baseDraw.apply(this, arguments); paint(); return r; };
  const baseRender = window.render;
  if (typeof baseRender === "function") window.render = function () { const r = baseRender.apply(this, arguments); paintBeats(); return r; };
  const basePanel = window.renderPanel;
  if (typeof basePanel === "function") window.renderPanel = function () { const r = basePanel.apply(this, arguments); paintPanel(); return r; };
  poll();
  setInterval(poll, EVERY_MS);
})();
