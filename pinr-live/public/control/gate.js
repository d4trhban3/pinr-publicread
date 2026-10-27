// The gate on /control: live counts on the gate's nodes and wires, and its settings editable through a staged Apply (the engine's
// /api/control/gate: preview shows the before and after over the last day's coins, apply makes a new version, every version kept, undo puts one back).
// Server text goes on the page as text only. The pure parts are on window.PinrGate so they can be tested.
(function () {
  "use strict";
  // Which of the gate's checks each blueprint node stands for, and which private settings sit with which check (the values themselves are never written here).
  const CHECKS_OF = {
    g_vamp: ["lookalike_name_ticker", "lookalike_picture"],
    g_dup: ["same_creator_relaunch"],
    g_serial: ["serial_launcher"],
    g_fast: ["fast_launcher"],
  };
  const VALUES_OF = { g_serial: ["mass_line"], g_fast: ["fast_coins", "fast_minutes"] };
  const LABEL = {
    lookalike_name_ticker: "Look-alike by name and ticker",
    lookalike_picture: "Look-alike by picture",
    same_creator_relaunch: "Same creator relaunching",
    serial_launcher: "Serial launcher",
    fast_launcher: "Fast launcher",
    mass_line: "Count line (private default when empty)",
    fast_coins: "Fast: coins (private default when empty)",
    fast_minutes: "Fast: minutes (private default when empty)",
  };
  const ALL_CHECKS = Object.values(CHECKS_OF).flat();
  /** the engine's built order of the checks (the gate graph's `order` lists any of them first; the rest follow in this order). */
  const BUILT_ORDER = ["serial_launcher", "fast_launcher", "same_creator_relaunch", "lookalike_name_ticker", "lookalike_picture"];
  /** The full order a graph runs its checks in: its own `order` first (known names, once each), then the rest as built. */
  function orderOf(g) {
    const own = g && Array.isArray(g.order) ? g.order.filter((n, i, a) => BUILT_ORDER.includes(n) && a.indexOf(n) === i) : [];
    return [...own, ...BUILT_ORDER.filter((n) => !own.includes(n))];
  }
  function setOrder(g, order) {
    const n = clone(g);
    n.order = orderOf({ order });
    return n;
  }
  /** The checks in the order the map's chain runs them: from "Gate · on token data" along the wires, one check node after another. */
  function chainOrder(wires) {
    const ws = Array.isArray(wires) ? wires.filter(Array.isArray) : [];
    const seen = new Set();
    const out = [];
    let cur = "g_in";
    for (let step = 0; step < 10; step++) {
      const next = ws.filter((w) => w[0] === cur && CHECKS_OF[w[2]] && !seen.has(w[2])).sort((a, b) => (b[1] === "no" || b[1] === "check" ? 1 : 0) - (a[1] === "no" || a[1] === "check" ? 1 : 0))[0];
      if (!next) break;
      seen.add(next[2]);
      out.push(...CHECKS_OF[next[2]]);
      cur = next[2];
    }
    return out;
  }
  const MATCH_KINDS = ["address", "file", "near"];
  const EVERY_MS = 5000;

  const clone = (g) => JSON.parse(JSON.stringify(g || {}));
  /** A check missing from the graph is on. */
  const isCheckOn = (g, name) => !(g && g.checks && g.checks[name] && g.checks[name].on === false);
  function setCheck(g, name, on) {
    const n = clone(g);
    n.checks = n.checks || {};
    n.checks[name] = { ...(n.checks[name] || {}), on: !!on };
    return n;
  }
  /** The picture check's match kinds, or null when the graph does not name any (the gate as built). */
  const matchOf = (g) => (g && g.checks && g.checks.lookalike_picture && Array.isArray(g.checks.lookalike_picture.match) ? g.checks.lookalike_picture.match : null);
  function setMatch(g, kind, on) {
    const n = clone(g);
    n.checks = n.checks || {};
    const cur = new Set(matchOf(g) || []);
    on ? cur.add(kind) : cur.delete(kind);
    n.checks.lookalike_picture = { ...(n.checks.lookalike_picture || { on: true }), match: MATCH_KINDS.filter((k) => cur.has(k)) };
    return n;
  }
  /** A value: a number, or null (empty: the private default). */
  const valueOf = (g, key) => (g && g.values && g.values[key] !== undefined ? g.values[key] : null);
  function setValue(g, key, v) {
    const n = clone(g);
    n.values = n.values || {};
    n.values[key] = v;
    return n;
  }
  /** What differs between two graphs, as short words (a missing check is on; a missing value is null). */
  function diffGraph(base, draft) {
    const out = [];
    for (const name of ALL_CHECKS) {
      const a = isCheckOn(base, name);
      const b = isCheckOn(draft, name);
      if (a !== b) out.push(`${LABEL[name]}: ${a ? "on" : "off"} → ${b ? "on" : "off"}`);
    }
    const ma = JSON.stringify(matchOf(base));
    const mb = JSON.stringify(matchOf(draft));
    if (ma !== mb) out.push(`Picture match kinds: ${matchOf(base) ? matchOf(base).join(", ") || "none" : "as built"} → ${matchOf(draft) ? matchOf(draft).join(", ") || "none" : "as built"}`);
    const oa = orderOf(base);
    const ob = orderOf(draft);
    if (draft && Array.isArray(draft.order) && oa.join() !== ob.join()) out.push(`Order of the checks: ${oa.map((n) => LABEL[n] || n).join(" → ")}  becomes  ${ob.map((n) => LABEL[n] || n).join(" → ")}`);
    for (const key of ["mass_line", "fast_coins", "fast_minutes"]) {
      const a = valueOf(base, key);
      const b = valueOf(draft, key);
      if (a !== b) out.push(`${LABEL[key].replace(/ \(.*$/, "")}: ${a === null ? "private default" : a} → ${b === null ? "private default" : b}`);
    }
    return out;
  }
  /** The numbers of a preview side in a line. */
  const sideText = (s) => (s ? `${s.passed ?? 0} passed · ${s.held ?? 0} held · ${s["not read yet"] ?? 0} not read yet` : "");
  /** One check's count for the node badge and the hour. */
  function checkCounts(status, names) {
    let held = 0;
    const examples = [];
    for (const n of names) {
      const c = status && status.checks && status.checks[n];
      if (!c) continue;
      held += Number.isFinite(c.held) ? c.held : 0;
      for (const e of Array.isArray(c.examples) ? c.examples : []) examples.push(e);
    }
    examples.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { held, examples: examples.slice(0, 5) };
  }
  /** A version's line, whatever shape the engine's list has (an object with a number, or the number itself). */
  function versionLine(v) {
    if (v && typeof v === "object") return { n: v.version ?? v.n ?? v.id ?? null, text: [v.applied_at ? new Date(v.applied_at).toLocaleString() : null, v.applied_by || v.who || null].filter(Boolean).join(" · ") };
    return { n: Number.isInteger(v) ? v : null, text: "" };
  }
  const safeLink = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);

  /**
   * The operator (2026-10-25): the gate's wires on the map control the gate. A check node with a wire coming into it is on; take away every wire into it and
   * its checks are staged off; wire it back in and they are staged on. Through the same Preview and Apply, logged, with undo.
   */
  function wiredChecks(wires) {
    const out = new Set();
    for (const w of Array.isArray(wires) ? wires : []) if (Array.isArray(w) && CHECKS_OF[w[2]]) out.add(w[2]);
    return out;
  }
  const isGateWire = (w) => Array.isArray(w) && !!CHECKS_OF[w[2]];
  /** What the operator's wire edits stage on the gate: each check node newly unwired is switched off, newly wired switched on. */
  function gateMapEdits(g, before, after) {
    let next = g;
    const said = [];
    for (const id of Object.keys(CHECKS_OF)) {
      const was = before.has(id);
      const now = after.has(id);
      if (was === now) continue;
      for (const name of CHECKS_OF[id]) if (isCheckOn(next, name) !== now) next = setCheck(next, name, now);
      said.push(`${CHECKS_OF[id].map((n) => LABEL[n] || n).join(" and ")}: ${now ? "on (wired in)" : "off (its wire taken out)"}`);
    }
    return { next, said };
  }
  window.PinrGate = { BUILT_ORDER, orderOf, setOrder, chainOrder, wiredChecks, isGateWire, gateMapEdits, clone, CHECKS_OF, VALUES_OF, LABEL, MATCH_KINDS, isCheckOn, setCheck, matchOf, setMatch, valueOf, setValue, diffGraph, sideText, checkCounts, versionLine, safeLink, ALL_CHECKS };
  if (typeof document === "undefined") return;

  let state = null; // GET /api/control/gate
  window.PinrGate.current = () => state; // for the badge layer
  let problem = null;
  let draft = null; // the staged graph, or null
  let preview = null; // the last preview answer for the draft
  let busy = false;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const toastMsg = (m) => { if (typeof toast === "function") toast(m); };
  const working = () => draft || (state && state.graph) || {};

  // The page's own map has no node for the fast-launcher check: add one beside the others the first time (it is part of the user's drawing afterwards).
  function ensureFastNode(g) {
    const live = g === undefined; // no graph given: the page's own map, drawn again after
    if (live) g = typeof G === "undefined" ? null : G;
    if (!g || !Array.isArray(g.nodes) || g.nodes.some((n) => n.id === "g_fast")) return;
    const serial = g.nodes.find((n) => n.id === "g_serial");
    if (!serial) return;
    g.nodes.push({ id: "g_fast", x: serial.x, y: serial.y + 125, title: "Fast launcher?", kind: "rule", status: "live", ins: [], outs: [], note: "Many coins in a short time. The rate stays private (no numbers on pages)." });
    if (live && typeof render === "function") render();
  }
  /** The fast-launcher node gets the chain's pins and wires (serial "no" into it, its "no" on to Passed, its "yes" to Held), so its wire can switch it like the others. */
  function wireFastNode(g) {
    const live = g === undefined;
    if (live) g = typeof G === "undefined" ? null : G;
    if (!g || !Array.isArray(g.wires)) return;
    const fast = g.nodes.find((n) => n.id === "g_fast");
    const held = g.nodes.find((n) => n.id === "g_held");
    if (!fast || (fast.ins && fast.ins.length)) return; // the operator's own node, or already wired: left as it is
    fast.ins = ["flow:no"];
    fast.outs = ["flow:yes", "flow:no"];
    if (held && Array.isArray(held.ins) && !held.ins.includes("flow:fast")) held.ins.push("flow:fast");
    const key = (w) => w.join("|");
    g.wires = g.wires.filter((w) => key(w) !== "g_serial|no|g_pass|no");
    for (const w of [["g_serial", "no", "g_fast", "no"], ["g_fast", "no", "g_pass", "no"], ["g_fast", "yes", "g_held", "fast"]]) if (!g.wires.some((x) => key(x) === key(w))) g.wires.push(w);
    if (live && typeof render === "function") render();
  }
  // The built-in map as the page really starts (the map plus what this file adds to it): what a submission's changes are worked out against until a map is accepted (submit.js).
  window.PinrBuiltInMap = () => {
    const g = defaultGraph();
    ensureFastNode(g);
    wireFastNode(g);
    return g;
  };

  async function call(path, method, body) {
    const r = await fetch(path, method === "GET" ? { cache: "no-store" } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, j };
  }

  async function poll() {
    try {
      const r = await call("/api/control/gate", "GET");
      if (!r.ok) throw new Error((r.j && r.j.error) || `the service answered ${r.status}`);
      state = r.j;
      if (onMap === null && typeof G !== "undefined") { onMap = wiredChecks(G.wires); chainAt = chainOrder(G.wires); } // the map as it stood when the gate first answered
      problem = null;
    } catch (e) {
      problem = e.message || "no answer";
    }
    paintNodes();
    paintWires();
    const panel = document.getElementById("panel");
    if (panel && !panel.contains(document.activeElement)) paintPanel();
    paintBar();
  }

  function paintNodes() {
    for (const e of document.querySelectorAll("#world .node")) {
      const id = e.dataset.id;
      const st = state && state.status;
      let b = e.querySelector(".lg");
      let text = null;
      if (st && CHECKS_OF[id]) {
        const names = CHECKS_OF[id];
        const c = checkCounts(st, names);
        const off = names.every((n) => !isCheckOn(working(), n));
        text = off ? "check switched off" : `${c.held} held this hour`;
        e.classList.toggle("lg-off", off);
      } else if (st && id === "g_in") text = `${st.coins_in_per_min ?? "?"} coins a minute in`;
      else if (st && id === "g_pass") text = `${st.coins_passed_per_min ?? "?"} a minute passed · ${st.passed ?? 0} this hour`;
      else if (st && id === "g_held") text = `${st.held ?? 0} held this hour · ${st.not_read_yet ?? 0} not read yet`;
      if (text === null) {
        if (b) b.remove();
        e.classList.remove("lg-off");
        continue;
      }
      if (!b) {
        b = el("div", "lg");
        e.insertBefore(b, e.querySelector(".nb") || null);
      }
      b.textContent = text;
    }
  }

  // Coins a minute on the wires that leave "in" and "passed".
  function paintWires() {
    const svg = document.getElementById("wires");
    if (!svg || !state || !state.status || typeof G === "undefined") return;
    for (const t of svg.querySelectorAll("text.lgw")) t.remove();
    const label = { g_in: state.status.coins_in_per_min, g_pass: state.status.coins_passed_per_min };
    const paths = svg.querySelectorAll("path[data-w]");
    const seen = new Set();
    for (const p of paths) {
      const w = G.wires[+p.dataset.w];
      if (!w || !(w[0] in label) || seen.has(w[0]) || typeof p.getTotalLength !== "function") continue;
      const v = label[w[0]];
      if (!Number.isFinite(v)) continue;
      seen.add(w[0]);
      const pt = p.getPointAtLength(p.getTotalLength() / 2);
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("class", "lgw");
      t.setAttribute("x", String(pt.x));
      t.setAttribute("y", String(pt.y - 6));
      t.setAttribute("text-anchor", "middle");
      t.textContent = `${v}/min`;
      svg.append(t);
    }
  }

  function field(label, input, hint) {
    const row = el("div", "lvrow");
    row.append(el("b", "", label));
    row.append(input);
    if (hint) row.append(el("span", "lvnote", hint));
    return row;
  }
  function stage(g) {
    draft = diffGraph(state.graph, g).length ? g : null;
    if (!draft) mapSaid = [];
    preview = null;
    paintPanel();
    paintNodes();
    paintBar();
  }

  function gateBox(id) {
    const box = el("div", "lvbox");
    box.id = "gatectl";
    if (!state) return box;
    const g = working();
    box.append(el("h3", "", "Gate settings (staged)"));
    box.append(el("div", "lvnote", "Edits here are staged: nothing changes on the server until you Preview and then Apply."));
    for (const name of CHECKS_OF[id] || []) {
      const on = isCheckOn(g, name);
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = on;
      cb.onchange = () => stage(setCheck(working(), name, cb.checked));
      box.append(field(LABEL[name], cb, on ? "on" : "off"));
      if (name === "lookalike_picture") {
        const cur = matchOf(g);
        const m = el("div", "lvrow");
        m.append(el("b", "", "Match kinds"));
        for (const k of MATCH_KINDS) {
          const c = el("input");
          c.type = "checkbox";
          c.checked = !!cur && cur.includes(k);
          c.onchange = () => stage(setMatch(working(), k, c.checked));
          const lab = el("label", "", k);
          lab.prepend(c);
          m.append(lab);
        }
        if (!cur) m.append(el("span", "lvnote", "as built"));
        box.append(m);
      }
    }
    for (const key of VALUES_OF[id] || []) {
      const inp = el("input");
      inp.type = "number";
      inp.step = key === "fast_minutes" ? "any" : "1";
      inp.min = "0";
      const v = valueOf(g, key);
      inp.value = v === null ? "" : String(v);
      inp.placeholder = "private default";
      inp.onchange = () => {
        const t = inp.value.trim();
        if (t !== "" && !Number.isFinite(Number(t))) return toastMsg("A number, or empty for the private default");
        stage(setValue(working(), key, t === "" ? null : Number(t)));
      };
      box.append(field(LABEL[key].replace(/ \(.*$/, ""), inp, "empty: private default"));
    }
    const st = state.status;
    if (st) {
      const c = checkCounts(st, CHECKS_OF[id] || []);
      box.append(el("div", "lvnote", `Held this hour: ${c.held}. Examples:`));
      const ex = el("div", "lvlog");
      if (!c.examples.length) ex.append(el("div", "", "none yet"));
      for (const e of c.examples) {
        const row = el("div");
        const href = safeLink(e.link);
        if (href) {
          const a = el("a", "", `${String(e.coin).slice(0, 4)}…${String(e.coin).slice(-4)}`);
          a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer nofollow";
          row.append(a);
        } else row.append(el("span", "", String(e.coin).slice(0, 12)));
        if (e.at) row.append(el("span", "", new Date(e.at).toLocaleTimeString()));
        if (window.PinrAsk && typeof e.coin === "string") {
          const ask = el("button", "", "ask PINRai");
          ask.onclick = () => window.PinrAsk.open(e.coin);
          row.append(ask);
        }
        ex.append(row);
      }
      box.append(ex);
    }
    return box;
  }

  function history() {
    const box = el("div", "lvbox lvlog");
    box.id = "gatehist";
    box.append(el("h3", "", `Gate versions${state ? ` (now ${state.version})` : ""}`));
    const vs = state && Array.isArray(state.versions) ? state.versions.slice().reverse().slice(0, 15) : [];
    if (!vs.length) box.append(el("div", "", state ? "No versions yet." : "No live data."));
    for (const v of vs) {
      const L = versionLine(v);
      const row = el("div");
      row.append(el("span", "", `${L.n !== null ? "v" + L.n : "version"}${L.text ? " · " + L.text : ""}`));
      if (L.n !== null && state && L.n !== state.version) {
        const u = el("button", "", "undo to this");
        u.onclick = () => undoTo(L.n);
        row.append(u);
      } else if (L.n !== null) row.append(el("span", "", "in force"));
      box.append(row);
    }
    return box;
  }

  function paintPanel() {
    const panel = document.getElementById("panel");
    if (!panel) return;
    for (const x of panel.querySelectorAll("#gatectl")) x.remove();
    const id = typeof sel !== "undefined" && sel && sel.type === "node" ? sel.id : null;
    if (id && CHECKS_OF[id]) panel.append(gateBox(id));
    const sw = typeof sel !== "undefined" && sel && sel.type === "wire" && typeof G !== "undefined" ? G.wires[sel.id] : null;
    if (isGateWire(sw) && state) {
      const box = el("div", "lvbox");
      box.id = "gatectl";
      box.append(el("h3", "", "This wire switches a gate check (staged, then Apply)"));
      const names = CHECKS_OF[sw[2]];
      box.append(el("div", "lvnote", `${names.map((n) => LABEL[n] || n).join(" and ")}: ${names.every((n) => isCheckOn(working(), n)) ? "on" : "off"}. Taking away every wire into this check switches it off; wiring it back in switches it on. Nothing changes on the server until Preview and Apply.`));
      panel.append(box);
    }
    // Gate versions sit on the "Change log" tab now, with the change log (logtab.js).
  }
  window.PinrGate.historyBox = () => history();

  // ---- the Apply bar
  function bar() {
    let b = document.getElementById("gatebar");
    if (!b) {
      b = el("div");
      b.id = "gatebar";
      document.body.append(b);
    }
    return b;
  }
  function paintBar() {
    const b = bar();
    b.replaceChildren();
    if (!draft || !state) return void (b.hidden = true);
    b.hidden = false;
    const lines = diffGraph(state.graph, draft);
    b.append(el("b", "", `${lines.length} change${lines.length === 1 ? "" : "s"} staged (not applied)`));
    if (mapSaid.length) b.append(el("div", "gl", `From your wires on the map: ${mapSaid.join("; ")}`));
    for (const l of lines) b.append(el("div", "gl", l));
    if (preview && preview.problems) {
      b.append(el("div", "gl bad", "The server refused this:"));
      for (const p of preview.problems) b.append(el("div", "gl bad", typeof p === "string" ? p : JSON.stringify(p)));
    } else if (preview) {
      b.append(el("div", "gl", `Over the last day's ${preview.coins} coins: before ${sideText(preview.before)}`));
      b.append(el("div", "gl", `after ${sideText(preview.after)} · ${preview.changed_count} coin${preview.changed_count === 1 ? "" : "s"} change`));
      const checks = new Set([...Object.keys((preview.before && preview.before.by_check) || {}), ...Object.keys((preview.after && preview.after.by_check) || {})]);
      for (const c of checks) {
        const a = preview.before.by_check[c] ?? 0;
        const z = preview.after.by_check[c] ?? 0;
        if (a !== z) b.append(el("div", "gl", `${LABEL[c] || c}: held ${a} → ${z}`));
      }
      if (Array.isArray(preview.order_before) && Array.isArray(preview.order_after) && preview.order_before.join() !== preview.order_after.join()) {
        b.append(el("div", "gl", `The server: the checks will run ${preview.order_after.map((n) => LABEL[n] || n).join(" → ")} (was ${preview.order_before.map((n) => LABEL[n] || n).join(" → ")}); every check that is on still runs.`));
      }
      for (const c of (preview.changed || []).slice(0, 5)) b.append(el("div", "gl", `${String(c.coin).slice(0, 4)}…${String(c.coin).slice(-4)}: ${c.before} → ${c.after}`));
    }
    const row = el("div", "gbtn");
    const pv = el("button", "", preview && !preview.problems ? "Preview again" : "Preview");
    pv.disabled = busy;
    pv.onclick = doPreview;
    row.append(pv);
    if (preview && !preview.problems && preview.preview_id) {
      const ap = el("button", "go", "Apply");
      ap.disabled = busy;
      ap.onclick = doApply;
      row.append(ap);
    }
    const dc = el("button", "", "Discard");
    dc.onclick = () => { draft = null; preview = null; paintPanel(); paintNodes(); paintBar(); };
    row.append(dc);
    b.append(row);
  }
  async function doPreview() {
    busy = true; paintBar();
    try {
      const r = await call("/api/control/gate/preview", "POST", { graph: draft });
      preview = r.ok ? r.j : { problems: (r.j && r.j.problems) || [(r.j && r.j.error) || `the service answered ${r.status}`] };
    } catch (e) { preview = { problems: [e.message] }; }
    busy = false; paintBar();
  }
  async function doApply() {
    busy = true; paintBar();
    try {
      const r = await call("/api/control/gate/apply", "POST", { preview_id: preview.preview_id });
      if (!r.ok) { preview = { problems: [(r.j && r.j.error) || `the service answered ${r.status}`] }; }
      else { toastMsg("Applied: gate version " + ((r.j.gate && r.j.gate.version) ?? "")); draft = null; preview = null; }
    } catch (e) { preview = { problems: [e.message] }; }
    busy = false;
    await poll();
  }
  async function undoTo(version) {
    if (!confirm(`Put gate version ${version} back? It is applied as a new version, and every version is kept.`)) return;
    try {
      const r = await call("/api/control/gate/undo", "POST", { version });
      toastMsg(r.ok ? "Gate version put back" : "Not undone: " + ((r.j && r.j.error) || r.status));
    } catch (e) { toastMsg("Not undone: " + e.message); }
    await poll();
  }

  // ---- the operator's wire edits on the gate's chain stage check changes
  let onMap = null;
  let chainAt = null; // the chain's order of checks when the page first looked
  let mapTimer = 0;
  let mapSaid = [];
  function lookAtMap() {
    if (typeof G === "undefined" || !state || !state.graph) return;
    if (typeof drag !== "undefined" && drag) return void (mapTimer = setTimeout(lookAtMap, 300));
    const now = wiredChecks(G.wires);
    const chain = chainOrder(G.wires);
    if (onMap === null) return void ((onMap = now), (chainAt = chain));
    const edits = gateMapEdits(working(), onMap, now);
    let next = edits.next;
    const said = edits.said;
    // Reordering the chain of check nodes (the engine's gate order): the checks run in the map's chain order, the ones left off it after them as built.
    if (chainAt && chain.length && chain.join() !== chainAt.join()) {
      next = setOrder(next, chain);
      said.push(`order of the checks: ${chain.map((n) => LABEL[n] || n).join(" → ")}`);
    }
    onMap = now;
    chainAt = chain;
    if (!said.length) return;
    mapSaid = [...mapSaid, ...said].slice(-6);
    stage(next);
    toastMsg(`Staged on the gate from the map: ${said.join("; ")}. Preview and Apply to make it live.`);
  }
  const baseSave = window.save;
  if (typeof baseSave === "function") window.save = function () { const r = baseSave.apply(this, arguments); clearTimeout(mapTimer); mapTimer = setTimeout(lookAtMap, 350); return r; };
  const baseRender = window.render;
  if (typeof baseRender === "function") window.render = function () { const r = baseRender.apply(this, arguments); paintNodes(); paintWires(); return r; };
  const baseWires = window.drawWires;
  if (typeof baseWires === "function") window.drawWires = function () { const r = baseWires.apply(this, arguments); paintWires(); return r; };
  const basePanel = window.renderPanel;
  if (typeof basePanel === "function") window.renderPanel = function () { const r = basePanel.apply(this, arguments); paintPanel(); return r; };

  ensureFastNode();
  wireFastNode();
  poll();
  setInterval(poll, EVERY_MS);
})();
