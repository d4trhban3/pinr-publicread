// The status badge on every node, from what the server and the site say now, not from what was drawn. The drawn status is only the
// fallback for a node the live data says nothing about. The pure part is on window.PinrBadges so it can be tested; nothing the server sends goes on the page as markup.
(function () {
  "use strict";
  const EVERY_MS = 5000;
  const FEED_EVERY_MS = 60000;
  const FEED_NODES = ["p_tokens", "p_evid", "w_home", "w_coin"]; // served by this very site: live while its feed answers with coins
  const GATE_NODES = ["g_in", "g_vamp", "g_dup", "g_serial", "g_fast", "g_pass", "g_held", "w_gate"];
  const AI_NODES = ["e_ai", "s_claude"];

  /**
   * What a node's badge says now: { text: "live" | "blocked" | "hidden", why } from ctx = { status (the control service's answer), gate (its gate answer), feed ({ scoreShown, tokens }) },
   * or null when the live data says nothing about this node (its drawn status stays).
   */
  function liveStatus(id, ctx, L, G) {
    const c = ctx || {};
    const status = c.status && typeof c.status === "object" ? c.status : null;
    const names = L && (L.SRC[id] || (id === "e_x" ? L.SRC.s_x : null));
    if (names && status && status.engine && status.engine.sources) {
      const ctl = status.control || {};
      if (names.every((n) => !L.isOn(ctl, n))) return { text: "hidden", why: "switched off in the control file" };
      const total = L.sum(status.engine.sources, names);
      if (total.calls === 0) return null;
      const st = L.stateOf(total, false);
      // Blocked is when most calls fail. A source that answered most calls and refused some is rate-limited, not blocked (the team, 26 Oct: GeckoTerminal "199 calls, 71 err").
      if (st === "red" && total.errors * 2 <= total.calls) return { text: "live", why: `${total.errors} of ${total.calls} calls were refused this hour and the other ${total.calls - total.errors} answered: rate-limited, not blocked` };
      return st === "red" ? { text: "blocked", why: `${total.errors} of ${total.calls} calls failed this hour` } : { text: "live", why: `${total.calls} calls this hour` };
    }
    if (AI_NODES.includes(id) && status && status.control && status.control.pinrai && typeof status.control.pinrai.on === "boolean") {
      return status.control.pinrai.on ? { text: "live", why: "PINRai is on" } : { text: "hidden", why: "PINRai is switched off" };
    }
    if (id === "e_score" && c.feed && typeof c.feed.scoreShown === "boolean") {
      return c.feed.scoreShown ? { text: "live", why: "the site shows the PINRscore" } : { text: "hidden", why: "the site does not show the PINRscore" };
    }
    if (GATE_NODES.includes(id) && c.gate && c.gate.status) {
      const checks = G && G.CHECKS_OF[id];
      if (checks && c.gate.graph && checks.every((n) => !G.isCheckOn(c.gate.graph, n))) return { text: "hidden", why: "its check is switched off" };
      return { text: "live", why: "the gate is reporting" };
    }
    if (FEED_NODES.includes(id) && c.feed && Number.isFinite(c.feed.tokens)) {
      return c.feed.tokens > 0 ? { text: "live", why: `the site's feed has ${c.feed.tokens} coins` } : { text: "blocked", why: "the site's feed has no coins" };
    }
    return null;
  }

  /**
   * Notes the map's operator drew that went stale (his saved copy keeps the old default text): while a node's note is still exactly the old default it is shown as the
   * new text; a note he edited himself is never touched. In memory only: it is saved with the drawing the next time he saves.
   */
  const STALE_NOTES = {
    s_lists: { was: "Raydium LaunchLab (in use), Bags, Clanker, Zora. Keyless.", alt: "LaunchLab, Bags and Stonk.fun lists are read (switches under Routes). Clanker and Zora: not yet. Keyless.", now: "LaunchLab, Bags, Stonk.fun, Clanker, Zora and Virtuals lists are read (switches under Routes). Keyless.", status: { was: "building", now: "live" } },
    s_bnb: { was: "Four.meme and Flap: their APIs refuse servers, so read the chain's published events on a free public node.", now: "Four.meme and Flap coins are found from the chain's own factory events (SQD Portal first, a public node as the fallback).", status: { was: "planned", now: "live" } },
    s_pump: { was: "Cloudflare bot check since 23 Oct. Never worked around; readers rest 10 min on a refusal.", now: "Coin records, holders, trades and candles are read when it answers; a refusal is counted and shows on its wires as NOT LIVE with the error.", status: { was: "blocked", now: "live" } },
    s_x: { was: "Only for coins that pass the gate. At the operator's cap.", now: "Only for coins that pass the gate. At the operator's cap. Its calls are counted here; switching it off stops the X check." },
    s_claude: { was: "The funded key (CLAUDE_DEFAULT_API) on the server. Daily cap set by the operator.", now: "The funded key (CLAUDE_DEFAULT_API). PINRai's reads and Ask PINRai spend from it, under the operator's daily cap." },
    a_pic: { was: "Jupiter first; Pump.fun skipped while it refuses. 300 of 505 coins have a picture (23 Oct).", now: "Jupiter first, then the coin's own metadata file; Pump.fun skipped while it refuses. Order set under Routes." },
    e_ai: { was: "Reads developer intent from the evidence. Every read shows its receipts. the team reads it before it goes live (234).", now: "Reads developer intent for coins that passed the gate; every read has its receipts. Ask PINRai (header) questions it (245)." },
    w_apps: { was: "Parked until after launch.", now: "Active again. Live while an iPhone or Android app asks the feed.", status: { was: "planned", now: "building" } },
    s_pp: { was: "New Pump.fun and LetsBonk coins, free. Trades on it are paid: not used.", now: "New Pump.fun and LetsBonk coins at creation, free, into the feed server's pool. Trades on it are paid: not used.", status: { was: "planned", now: "live" } },
    e_score: { was: "Kept, hidden from every page (231).", now: "Shown on the PINR page, Discovery and DeepScan (244)." }
  };
  function freshNotes(nodes) {
    let n = 0;
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const s = node && STALE_NOTES[node.id];
      if (s && (node.note === s.was || (s.alt && node.note === s.alt))) {
        node.note = s.now;
        if (s.status && node.status === s.status.was) node.status = s.status.now;
        n++;
      }
    }
    return n;
  }

  window.PinrBadges = { liveStatus, STALE_NOTES, freshNotes };
  if (typeof document === "undefined") return;

  let feed = null; // { scoreShown, tokens } from the site's own public list
  async function pollFeed() {
    try {
      const r = await fetch("/api/tokens", { cache: "no-store" });
      const j = await r.json();
      feed = { scoreShown: typeof j.scoreShown === "boolean" ? j.scoreShown : null, tokens: Array.isArray(j.tokens) ? j.tokens.length : null };
    } catch { feed = null; }
    paint();
    if (typeof window.drawWires === "function") window.drawWires();
  }
  const ctx = () => ({
    status: window.PinrLive && window.PinrLive.current ? window.PinrLive.current() : null,
    gate: window.PinrGate && window.PinrGate.current ? window.PinrGate.current() : null,
    feed,
  });
  const drawnOf = (id) => (typeof nodeById === "function" ? nodeById(id) : null);

  function paint() {
    if (typeof STATUS === "undefined" || !window.PinrLive || !window.PinrGate) return;
    const c = ctx();
    for (const e of document.querySelectorAll("#world .node")) {
      const id = e.dataset.id;
      const n = drawnOf(id);
      const pill = e.querySelector(".st");
      if (!pill || !n) continue;
      const drawn = STATUS[n.status] || STATUS.live;
      // a node with measured wires (livewires.js) shows what crossed them; the server's counts next; the drawn status last.
      const live = (window.PinrWires && window.PinrWires.nodeLive && window.PinrWires.nodeLive(id)) || liveStatus(id, c, window.PinrLive, window.PinrGate);
      const use = live && STATUS[live.text] ? STATUS[live.text] : drawn;
      pill.textContent = use[0];
      pill.dataset.s = live && STATUS[live.text] ? live.text : n.status || "live";
      e.style.setProperty("--s", `var(${use[1]})`);
      pill.title = live ? `From the live status: ${live.why}. Drawn as: ${drawn[0]}.` : `Drawn status (nothing live says otherwise): ${drawn[0]}.`;
    }
    notePanel(c);
  }
  // For the wires (routes.js): the score engine's wires are solid while the site shows the PINRscore; a wire from a node whose live badge is off is dotted.
  window.PinrBadges.scoreLive = () => !!(feed && feed.scoreShown === true);
  window.PinrBadges.liveText = (id) => {
    if (!window.PinrLive || !window.PinrGate) return null;
    const l = liveStatus(id, ctx(), window.PinrLive, window.PinrGate);
    return l ? l.text : null;
  };
  function notePanel(c) {
    const panel = document.getElementById("panel");
    if (!panel) return;
    for (const x of panel.querySelectorAll("#livebadge")) x.remove();
    const id = typeof sel !== "undefined" && sel && sel.type === "node" ? sel.id : null;
    const n = id ? drawnOf(id) : null;
    if (!n) return;
    const live = (window.PinrWires && window.PinrWires.nodeLive && window.PinrWires.nodeLive(id)) || liveStatus(id, c, window.PinrLive, window.PinrGate);
    const d = document.createElement("div");
    d.id = "livebadge";
    d.className = "lvnote";
    d.textContent = live ? `Badge now: ${live.text} (${live.why}). The status you drew is only a fallback.` : "Badge: the status you drew (the live data says nothing about this node).";
    panel.append(d);
  }

  if (typeof G !== "undefined" && G && freshNotes(G.nodes) && typeof window.render === "function") window.render();
  const baseRender = window.render;
  if (typeof baseRender === "function") window.render = function () { const r = baseRender.apply(this, arguments); paint(); return r; };
  const basePanel = window.renderPanel;
  if (typeof basePanel === "function") window.renderPanel = function () { const r = basePanel.apply(this, arguments); paint(); return r; };
  paint();
  pollFeed();
  setInterval(paint, EVERY_MS);
  setInterval(pollFeed, FEED_EVERY_MS);
})();
