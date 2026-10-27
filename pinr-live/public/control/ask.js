// "Ask PINRai" on /control: pick a coin, ask in plain words, read PINRai's answer as text with the evidence it names linked, and keep the
// operator's own corrections as teachings. Talks only to the engine's /api/control/pinrai/ask and /teach (through the feed server, behind Cloudflare Access) and
// reads the public coin list from /api/tokens. Everything the server or the model sends goes on the page as text, never as markup; a link is only https.
// The pure parts are on window.PinrAsk so they can be tested.
(function () {
  "use strict";
  const ASK = "/api/control/pinrai/ask";
  const TEACH = "/api/control/pinrai/teach";
  const MAX_TEACH = 2000;
  const MAX_QUESTION = 2000;
  const KEEP_TURNS = 8; // how many earlier turns go back with a question
  const WAIT_MS = 175000; // the model may take a minute or more

  const ADDR = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
  const short = (a) => `${String(a).slice(0, 4)}…${String(a).slice(-4)}`;
  const safeLink = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);

  /** Coins whose name, ticker or address matches the words typed (an address typed whole matches itself even if the list lacks it). At most 8. */
  function matchCoins(query, tokens) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for (const t of Array.isArray(tokens) ? tokens : []) {
      if (!t || typeof t.address !== "string") continue;
      const hay = `${t.name || ""} ${t.ticker || ""} ${t.address}`.toLowerCase();
      if (hay.includes(q)) out.push({ address: t.address, name: String(t.name || "").slice(0, 40), ticker: String(t.ticker || "").slice(0, 20) });
      if (out.length >= 8) break;
    }
    const raw = String(query || "").trim();
    if (ADDR.test(raw) && !out.some((c) => c.address === raw)) out.unshift({ address: raw, name: "", ticker: "" });
    return out;
  }

  /** The earlier turns that go back with a question: the last few, role operator or pinrai, text only. */
  function historyOf(turns) {
    return (Array.isArray(turns) ? turns : [])
      .filter((t) => t && (t.role === "founder" || t.role === "pinrai") && typeof t.text === "string" && t.text.trim())
      .slice(-KEEP_TURNS)
      .map((t) => ({ role: t.role, text: t.text }));
  }

  /** A question the page will send: trimmed, 1 to 2,000 characters; null when it would be refused. */
  function questionOf(text) {
    const t = String(text || "").trim();
    return t && t.length <= MAX_QUESTION ? t : null;
  }
  /** A teaching the server will keep: 1 to 2,000 characters. */
  function teachingOf(text) {
    const t = String(text || "").trim();
    return t && t.length <= MAX_TEACH ? t : null;
  }

  /** One evidence line as words: "what: value · source · date" and its https link (null when none or not https). */
  function evidenceLine(e) {
    const v = e && e.value !== null && e.value !== undefined && typeof e.value !== "object" ? String(e.value) : "";
    const when = e && e.as_of ? new Date(e.as_of) : null;
    const date = when && Number.isFinite(when.getTime()) ? when.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
    const text = [`${e && e.id ? String(e.id).slice(0, 12) + " · " : ""}${e && e.what ? String(e.what).slice(0, 200) : "evidence"}${v ? `: ${v.slice(0, 200)}` : ""}`, e && e.source ? String(e.source).slice(0, 60) : "", date].filter(Boolean).join(" · ");
    return { text, mark: e && e.on_chain ? "●" : "○", href: safeLink(e && e.link) };
  }

  /** What the server answered, ready to draw: the answer text, the evidence lines, the count of named ids that were not in the evidence (never shown as evidence), and the cost. */
  function answerView(r) {
    const x = r && typeof r === "object" ? r : {};
    const ok = x.status === "answered";
    return {
      ok,
      status: typeof x.status === "string" ? x.status.slice(0, 200) : "no status",
      answer: ok && typeof x.answer === "string" ? x.answer : "",
      evidence: ok && Array.isArray(x.evidence) ? x.evidence.slice(0, 40).map(evidenceLine) : [],
      unknown: Array.isArray(x.unknown_ids) ? x.unknown_ids.length : 0,
      cost: Number.isFinite(x.cost_usd) ? x.cost_usd : null,
      model: typeof x.model === "string" ? x.model.slice(0, 60) : null,
    };
  }
  const costText = (c) => (c === null ? "" : `this answer cost $${c < 0.01 ? c.toFixed(4) : c.toFixed(2)}`);

  /** A saved teaching as one line of words. */
  function teachingLine(t) {
    const when = t && t.at ? new Date(t.at) : null;
    const date = when && Number.isFinite(when.getTime()) ? when.toISOString().slice(0, 16).replace("T", " ") : "";
    return `${date}${t && t.who ? " · " + String(t.who).slice(0, 60) : ""}${t && t.coin ? " · " + short(t.coin) : ""}`;
  }

  window.PinrAsk = { ADDR, matchCoins, historyOf, questionOf, teachingOf, evidenceLine, answerView, costText, teachingLine, safeLink, MAX_TEACH, KEEP_TURNS };
  if (typeof document === "undefined") return;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const toastMsg = (m) => { if (typeof toast === "function") toast(m); };
  async function api(method, path, body, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 15000);
    try {
      const r = await fetch(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal, cache: "no-store" });
      let j = null;
      try { j = await r.json(); } catch { /* not JSON */ }
      if (!r.ok) throw new Error((j && j.error) || `the service answered ${r.status}`);
      return j;
    } catch (e) {
      throw new Error(e && e.name === "AbortError" ? "no answer in time" : (e && e.message) || "no answer");
    } finally { clearTimeout(timer); }
  }

  let coin = null; // { address, name, ticker }
  let turns = []; // { role, text, view? } the chat so far (this page only; nothing is kept in the browser)
  let tokens = null;
  let busy = false;
  let cap = null;
  let usage = null; // status.pinrai, when the server reports it

  const panel = el("section");
  panel.id = "askpanel";
  panel.hidden = true;
  const head = el("div", "askhead");
  head.append(el("b", "", "Ask PINRai"));
  const close = el("button", "", "close");
  close.onclick = () => (panel.hidden = true);
  head.append(close);
  const pick = el("div", "askpick");
  const search = el("input");
  search.type = "text"; search.placeholder = "Find a coin: name, ticker or address"; search.maxLength = 80;
  const hits = el("div", "askhits");
  const chosen = el("div", "askchosen");
  pick.append(search, hits, chosen);
  const log = el("div", "asklog");
  const form = el("div", "askform");
  const q = el("textarea");
  q.placeholder = "Ask in plain words (PINRai answers from this coin's evidence)"; q.maxLength = MAX_QUESTION; q.rows = 2;
  const send = el("button", "go", "Ask");
  form.append(q, send);
  const spend = el("div", "asknote");
  const teachBox = el("div", "askteach");
  panel.append(head, pick, log, form, spend, teachBox);

  function paintChosen() {
    chosen.textContent = coin ? `Asking about ${coin.name || short(coin.address)}${coin.ticker ? " " + coin.ticker : ""} · ${short(coin.address)}` : "No coin picked yet.";
    send.disabled = busy || !coin;
  }
  function paintSpend(cost, view) {
    const bits = [];
    if (cost) bits.push(cost);
    if (cap !== null) bits.push(`daily cap $${cap}`);
    const u = window.PinrLive && window.PinrLive.aiUsage ? window.PinrLive.aiUsage(view) : "";
    if (u) bits.push(u);
    spend.textContent = bits.join(" · ");
  }
  function paintLog() {
    log.replaceChildren();
    for (const t of turns) {
      const row = el("div", "askturn " + t.role);
      row.append(el("div", "askwho", t.role === "founder" ? "You" : "PINRai"));
      row.append(el("div", "asktext", t.text));
      if (t.role === "pinrai" && t.view) {
        const v = t.view;
        if (v.evidence.length) {
          const ev = el("div", "askev");
          ev.append(el("div", "askwho", "Evidence it rests on"));
          for (const e of v.evidence) {
            const line = el("div", "askevline");
            line.append(`${e.mark} `);
            if (e.href) {
              const a = el("a", "", e.text);
              a.href = e.href; a.target = "_blank"; a.rel = "noopener noreferrer nofollow";
              line.append(a);
            } else line.append(e.text);
            ev.append(line);
          }
          row.append(ev);
        }
        if (v.unknown) row.append(el("div", "asknote", `PINRai named ${v.unknown} item${v.unknown === 1 ? "" : "s"} that are not in the evidence; they are not shown as evidence.`));
        const tag = [window.PinrAsk.costText(v.cost), v.model].filter(Boolean).join(" · ");
        if (tag) row.append(el("div", "asknote", tag));
      }
      if (t.role === "founder" && t.coin) {
        const b = el("button", "", "Save as teaching");
        b.title = "PINRai reads this on later coins as an example, never as evidence";
        b.onclick = () => saveTeaching(t, b);
        row.append(b);
      }
      log.append(row);
    }
    log.scrollTop = log.scrollHeight;
  }
  async function saveTeaching(t, btn) {
    const text = teachingOf(t.text);
    if (!text) return toastMsg(`A teaching is 1 to ${MAX_TEACH} characters`);
    btn.disabled = true;
    try {
      await api("POST", TEACH, { coin: t.coin, text });
      btn.textContent = "Saved";
      toastMsg("Saved as a teaching");
      loadTeachings();
    } catch (e) { btn.disabled = false; toastMsg("Not saved: " + e.message); }
  }
  async function ask() {
    const question = questionOf(q.value);
    if (!coin || !question || busy) return;
    const history = historyOf(turns);
    turns.push({ role: "founder", text: question, coin: coin.address });
    q.value = "";
    busy = true; send.disabled = true; send.textContent = "Asking…";
    paintLog();
    try {
      const r = await api("POST", ASK, { coin: coin.address, question, history }, WAIT_MS);
      const v = window.PinrAsk.answerView(r);
      turns.push({ role: "pinrai", text: v.ok ? v.answer : `No answer: ${v.status}`, view: v });
      paintSpend(window.PinrAsk.costText(v.cost), usage);
    } catch (e) {
      turns.push({ role: "pinrai", text: `No answer: ${e.message}`, view: null });
    }
    busy = false; send.textContent = "Ask"; paintChosen(); paintLog();
  }
  async function loadTeachings() {
    teachBox.replaceChildren(el("h3", "", "Saved teachings"));
    let list = [];
    try {
      const j = await api("GET", TEACH);
      list = Array.isArray(j && j.teaching) ? j.teaching : [];
    } catch (e) { teachBox.append(el("div", "asknote", "Not read: " + e.message)); return; }
    if (!list.length) teachBox.append(el("div", "asknote", "None saved yet."));
    for (const t of list.slice(0, 50)) {
      const row = el("div", "askteachrow");
      row.append(el("div", "askwho", window.PinrAsk.teachingLine(t)));
      row.append(el("div", "asktext", typeof t.text === "string" ? t.text : ""));
      const rm = el("button", "", "remove");
      rm.onclick = async () => {
        if (!window.confirm("Remove this teaching? PINRai stops reading it on later coins.")) return;
        try { await api("DELETE", TEACH, { id: t.id }); toastMsg("Removed"); loadTeachings(); }
        catch (e) { toastMsg("Not removed: " + e.message); }
      };
      row.append(rm);
      teachBox.append(row);
    }
  }
  function choose(c) {
    coin = c;
    search.value = "";
    hits.replaceChildren();
    turns = [];
    paintChosen(); paintLog();
  }
  async function loadTokens() {
    if (tokens) return;
    try {
      const r = await fetch("/api/tokens", { cache: "no-store" });
      const j = await r.json();
      tokens = Array.isArray(j && j.tokens) ? j.tokens : [];
    } catch { tokens = []; }
  }
  search.oninput = async () => {
    await loadTokens();
    hits.replaceChildren();
    for (const c of matchCoins(search.value, tokens)) {
      const b = el("button", "", `${c.name || short(c.address)}${c.ticker ? " " + c.ticker : ""} · ${short(c.address)}`);
      b.onclick = () => choose(c);
      hits.append(b);
    }
  };
  send.onclick = ask;
  q.onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask(); };

  async function open(address) {
    panel.hidden = false;
    if (typeof address === "string" && ADDR.test(address)) choose({ address, name: "", ticker: "" });
    else paintChosen();
    try {
      const r = await fetch("/api/control/status", { cache: "no-store" });
      const j = await r.json();
      cap = j && j.control && j.control.pinrai && Number.isFinite(j.control.pinrai.daily_dollar_cap) ? j.control.pinrai.daily_dollar_cap : null;
      usage = j && j.pinrai ? j.pinrai : null;
      paintSpend("", usage);
    } catch { /* the bar says it */ }
    loadTeachings();
  }
  window.PinrAsk.open = open;

  const bar = document.querySelector("header");
  if (bar) {
    const b = el("button", "", "Ask PINRai");
    b.id = "bAsk";
    b.title = "Ask PINRai about a coin (private)";
    b.onclick = () => (panel.hidden ? open() : (panel.hidden = true));
    const sp = bar.querySelector(".sp");
    bar.insertBefore(b, sp || null);
  }
  document.body.append(panel);
  paintChosen();
})();
