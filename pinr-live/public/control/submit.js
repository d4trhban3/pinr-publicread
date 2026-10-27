// "Submit" and "Submissions" on /control: the operator rearranges wires on the map and clicks Submit; the rewired map goes to the crew
// for evaluation. Submit works out the changes against the last ACCEPTED map (GET /api/control/map/accepted; the built-in map until one is accepted), says them in
// plain words, and POSTs { v, map, diff, note } to /api/control/submissions. It changes nothing live. The Submissions tab lists what was sent, newest first, with
// the crew's status (received, under evaluation, accepted, declined with a reason). Everything is set as text: nothing from the server becomes markup.
// The pure part (diffMaps) is on window.PinrSubmit so it can be tested.
(function () {
  "use strict";
  const NOTE_MAX = 2000;
  const wkey = (w) => `${w[0]}|${w[1]}|${w[2]}|${w[3]}`;
  const titleOf = (g, id) => {
    const n = ((g && g.nodes) || []).find((x) => x.id === id);
    return n && n.title ? n.title : id;
  };
  const end = (g, id, pin) => `${titleOf(g, id)} (${pin})`;
  const real = (g) => ((g && g.nodes) || []).filter((n) => n && n.kind !== "comment");

  /**
   * The changes from `base` to `now` (maps as the page holds them: { nodes: [...], wires: [[from, fromPin, to, toPin], ...] }), as data and as plain words.
   * A wire "moved" when one end stayed (the same source pin, or the same target pin) and the other end changed.
   */
  function diffMaps(base, now) {
    const bw = new Map(((base && base.wires) || []).map((w) => [wkey(w), w]));
    const nw = new Map(((now && now.wires) || []).map((w) => [wkey(w), w]));
    let added = [...nw].filter(([k]) => !bw.has(k)).map(([, w]) => w);
    let removed = [...bw].filter(([k]) => !nw.has(k)).map(([, w]) => w);
    const moved = [];
    for (const side of [[0, 1], [2, 3]]) {
      for (const r of [...removed]) {
        const i = added.findIndex((a) => a[side[0]] === r[side[0]] && a[side[1]] === r[side[1]]);
        if (i < 0) continue;
        // only when exactly one wire left this pin and one arrived, so a pin with several wires is not guessed at
        const leaving = removed.filter((x) => x[side[0]] === r[side[0]] && x[side[1]] === r[side[1]]).length;
        const arriving = added.filter((x) => x[side[0]] === r[side[0]] && x[side[1]] === r[side[1]]).length;
        if (leaving !== 1 || arriving !== 1) continue;
        moved.push({ was: r, now: added[i] });
        removed = removed.filter((x) => x !== r);
        added = added.filter((x) => x !== added[i]);
      }
    }
    const bn = new Map(real(base).map((n) => [n.id, n]));
    const nn = new Map(real(now).map((n) => [n.id, n]));
    const nodesAdded = [...nn].filter(([id]) => !bn.has(id)).map(([, n]) => ({ id: n.id, title: n.title || n.id }));
    const nodesRemoved = [...bn].filter(([id]) => !nn.has(id)).map(([, n]) => ({ id: n.id, title: n.title || n.id }));
    const nodesChanged = [];
    for (const [id, n] of nn) {
      const b = bn.get(id);
      if (!b) continue;
      if ((b.title || "") !== (n.title || "")) nodesChanged.push({ id, what: "renamed", was: b.title || "", now: n.title || "" });
      if ((b.status || "") !== (n.status || "")) nodesChanged.push({ id, what: "status", was: b.status || "", now: n.status || "" });
    }
    const ref = (g, w) => `${end(g, w[0], w[1])} to ${end(g, w[2], w[3])}`;
    const lines = [];
    for (const w of added) lines.push(`Wire added: ${ref(now, w)}.`);
    for (const w of removed) lines.push(`Wire removed: ${ref(base, w)}.`);
    for (const m of moved) lines.push(`Wire moved: was ${ref(base, m.was)}; now ${ref(now, m.now)}.`);
    for (const n of nodesAdded) lines.push(`Node added: ${n.title}.`);
    for (const n of nodesRemoved) lines.push(`Node removed: ${n.title}.`);
    for (const c of nodesChanged) lines.push(c.what === "renamed" ? `Node renamed: "${c.was}" is now "${c.now}".` : `Node status: ${titleOf(now, c.id)} was ${c.was || "none"}, now ${c.now || "none"}.`);
    const toObj = (g, w) => ({ from: w[0], fromPort: w[1], to: w[2], toPort: w[3] });
    return {
      wires_added: added.map((w) => toObj(now, w)),
      wires_removed: removed.map((w) => toObj(base, w)),
      wires_moved: moved.map((m) => ({ was: toObj(base, m.was), now: toObj(now, m.now) })),
      nodes_added: nodesAdded,
      nodes_removed: nodesRemoved,
      nodes_changed: nodesChanged,
      text: lines.length ? lines.join("\n") : "No changes from the last accepted map.",
      count: lines.length,
    };
  }

  window.PinrSubmit = { diffMaps, wkey, NOTE_MAX };
  if (typeof document === "undefined") return;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const when = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  };
  const STATUS_WORDS = { received: "Received", "under evaluation": "Under evaluation", accepted: "Accepted", declined: "Declined" };
  const PANELS = ["routespanel", "logpanel", "keypanel", "adspanel"];
  const mk = (id) => {
    const p = document.createElement("section");
    p.id = id;
    p.className = "subpanel";
    p.hidden = true;
    document.body.append(p);
    return p;
  };
  const submitPanel = mk("submitpanel");
  const subsPanel = mk("subspanel");
  const closeHead = (title, panel) => {
    const head = el("div", "askhead");
    const close = el("button", "", "close");
    close.onclick = () => (panel.hidden = true);
    head.append(el("b", "", title), close);
    return head;
  };
  const current = () => ({ nodes: JSON.parse(JSON.stringify(G.nodes)), wires: JSON.parse(JSON.stringify(G.wires)), rev: G.rev });

  /** The map the changes are worked out against: the last accepted one, or the built-in map when none has been accepted. */
  async function baseline() {
    try {
      const r = await fetch("/api/control/map/accepted", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (j && j.map && Array.isArray(j.map.nodes) && Array.isArray(j.map.wires)) return { map: j.map, label: `the last accepted map${j.at ? ` (${when(j.at)})` : ""}` };
      }
      if (r.status === 404) return { map: typeof window.PinrBuiltInMap === "function" ? window.PinrBuiltInMap() : defaultGraph(), label: "the built-in map (none accepted yet)" };
    } catch (e) {
      /* falls through */
    }
    return null;
  }

  async function paintSubmit() {
    if (submitPanel.hidden) return;
    submitPanel.replaceChildren(closeHead("Submit this map", submitPanel), el("p", "admeta", "Reading the last accepted map…"));
    const base = await baseline();
    if (submitPanel.hidden) return;
    if (!base) return submitPanel.replaceChildren(closeHead("Submit this map", submitPanel), el("p", "admeta", "The last accepted map is not read yet, so the changes cannot be worked out. This page asks again when you open it."));
    const now = current();
    const d = diffMaps(base.map, now);
    const intro = el("p", "admeta", `Compared with ${base.label}. Submitting sends this map and these changes to the crew to evaluate; it changes nothing live.`);
    const diff = el("pre", "subdiff", d.text);
    const note = el("textarea", "subnote");
    note.placeholder = "A note for the crew (why, what you want)";
    note.maxLength = NOTE_MAX;
    const counter = el("span", "admeta", `0 / ${NOTE_MAX}`);
    note.oninput = () => (counter.textContent = `${note.value.length} / ${NOTE_MAX}`);
    const btn = el("button", "subgo", "Submit");
    const out = el("p", "admeta", "");
    btn.disabled = d.count === 0;
    if (d.count === 0) out.textContent = "Nothing to submit: this map matches the last accepted one.";
    btn.onclick = async () => {
      btn.disabled = true;
      out.textContent = "Sending…";
      try {
        const r = await fetch("/api/control/submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 1, map: now, diff: d, note: note.value.slice(0, NOTE_MAX) }) });
        const j = r.ok ? await r.json() : null;
        if (j && j.id) {
          out.textContent = `Received (${j.id}). The crew will evaluate it; nothing changed live. See it under Submissions.`;
          if (!subsPanel.hidden) void paintSubs();
        } else {
          out.textContent = `Not sent (answer ${r.status}). Nothing was lost: try again.`;
          btn.disabled = false;
        }
      } catch (e) {
        out.textContent = "Not sent (no answer). Nothing was lost: try again.";
        btn.disabled = false;
      }
    };
    submitPanel.replaceChildren(closeHead("Submit this map", submitPanel), intro, el("b", "", `${d.count} change${d.count === 1 ? "" : "s"}`), diff, note, counter, btn, out);
  }

  function subRow(s) {
    const r = el("div", "subrow");
    const status = typeof s.status === "string" ? s.status : "received";
    const head = el("div", "subhead");
    head.append(el("span", `substatus s-${status.replace(/ /g, "-")}`, STATUS_WORDS[status] || status), el("span", "admeta", `${when(s.at)}${s.by ? ` · ${s.by}` : ""}`));
    r.append(head);
    if (s.reason) r.append(el("p", "subreason", `Reason: ${s.reason}`));
    if (s.note) r.append(el("p", "subnotetext", `Note: ${s.note}`));
    const text = s.diff && typeof s.diff.text === "string" ? s.diff.text : "";
    if (text) r.append(el("pre", "subdiff", text));
    return r;
  }
  async function paintSubs() {
    if (subsPanel.hidden) return;
    const head = closeHead("Map submissions", subsPanel);
    const note = el("p", "admeta", "Newest first. A submission changes nothing live; the crew sets its status.");
    let list;
    try {
      const r = await fetch("/api/control/submissions", { cache: "no-store" });
      const j = r.ok ? await r.json() : null;
      const subs = j && Array.isArray(j.submissions) ? j.submissions : null;
      if (!subs) list = el("p", "admeta", "The submissions are not read yet. This page asks again shortly.");
      else if (!subs.length) list = el("p", "admeta", "No submissions yet.");
      else {
        list = el("div", "adlist");
        list.append(...subs.map(subRow));
      }
    } catch (e) {
      list = el("p", "admeta", "The submissions are not read yet. This page asks again shortly.");
    }
    if (!subsPanel.hidden) subsPanel.replaceChildren(head, note, list);
  }

  const header = document.querySelector("header");
  if (header) {
    const add = (id, text, title, panel, paint) => {
      const b = document.createElement("button");
      b.id = id;
      b.textContent = text;
      b.title = title;
      b.onclick = () => {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
          for (const other of [...PANELS, "submitpanel", "subspanel"]) {
            const p = document.getElementById(other);
            if (p && p !== panel) p.hidden = true; // one side panel at a time
          }
          void paint();
        }
      };
      const after = document.getElementById("bAds") || document.getElementById("bKey") || document.getElementById("bLog");
      if (after && after.parentNode === header) after.after(b);
      else header.insertBefore(b, header.querySelector(".sp") || null);
      return b;
    };
    add("bSubs", "Submissions", "The maps sent to the crew, with their status", subsPanel, paintSubs);
    add("bSubmit", "Submit", "Send this map to the crew to evaluate (changes nothing live)", submitPanel, paintSubmit);
    for (const id of ["bRoutes", "bLog", "bKey", "bAds"]) {
      const other = document.getElementById(id);
      if (other) other.addEventListener("click", () => ((submitPanel.hidden = true), (subsPanel.hidden = true)));
    }
  }
  setInterval(() => void paintSubs(), 30000);
})();
