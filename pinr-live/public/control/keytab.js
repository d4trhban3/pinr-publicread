// The "Key" tab on /control (the operator: "my control page needs a better key ... i have no key for what each style line means"): what each wire colour,
// each line style, each node status and each node kind means, drawn with the page's own colours, in a panel beside Routes and Change log; and a small
// legend for the line styles, always in the corner. Built from the page's own tables (PINS, STATUS, KINDS), so the key never drifts from the map.
(function () {
  "use strict";
  const SVG = "http://www.w3.org/2000/svg";
  /** The line styles the map uses, each with the class its wires get (routes.js, blueprint.js) and what it means. */
  const LINE_STYLES = [
    ["lwlive", "LIVE", "Solid, marked “LIVE n/min”: data crossed it in the last few minutes, measured. Click it for the count, the last time and a sample."],
    ["lwbuild", "", "Dashed: BUILDING. Not measured yet: an engine wire whose meter is still being built, or a source the visitor’s browser reads itself."],
    ["lwnot", "NOT LIVE", "Dotted, marked “NOT LIVE”: measured and nothing crossed lately, or its source refused, or its node is planned, blocked or hidden. Click it for the reason."],
    ["rtlive", "live", "Before the meters are read: solid and thicker, marked “live”: a route the server follows now (it changes what the server reads)."],
    ["rtlive", "", "Solid: a wire into a gate check (taking it away stages that check off: Preview and Apply), or a PINRscore wire while the site shows the score."],
    ["dash", "", "Dashed, marked “not routed”: a route wire whose source is out of that field’s order."],
    ["dash rtgrey", "", "Dashed and faded: a route the server cannot follow yet; it cannot be changed."],
    ["dash", "", "Dashed: drawing only. Saved in your browser; nothing on the server changes."],
    ["fromoff", "", "Dotted and faint: it comes from a blocked, hidden or planned node."],
    ["sel", "", "Thick and glowing: the wire you selected."],
  ];
  window.PinrKey = { LINE_STYLES };
  if (typeof document === "undefined") return; // under the tests: only the table above
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  function sample(cls, color, label) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 64 16");
    svg.setAttribute("class", "keyline");
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", "M2 8 H62");
    p.setAttribute("stroke", color);
    p.setAttribute("class", cls);
    svg.append(p);
    if (label) {
      const t = document.createElementNS(SVG, "text");
      t.setAttribute("x", "32");
      t.setAttribute("y", "6");
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("class", label === "live" || label === "LIVE" ? "keytext live" : label === "NOT LIVE" ? "keytext bad" : "keytext");
      t.textContent = label;
      svg.append(t);
    }
    return svg;
  }
  const row = (left, text) => {
    const r = el("div", "keyrow");
    r.append(left, el("span", "", text));
    return r;
  };
  function paint(panel) {
    const head = el("div", "askhead");
    head.append(el("b", "", "Key"));
    const close = el("button", "", "close");
    close.onclick = () => (panel.hidden = true);
    head.append(close);
    const parts = [head];
    if (typeof PINS !== "undefined") {
      const box = el("div", "rtfield");
      box.append(el("b", "", "Wire colours: what flows along it"));
      for (const [k, v] of Object.entries(PINS)) box.append(row(sample("", `var(${v[1]})`), v[0]));
      parts.push(box);
    }
    const ls = el("div", "rtfield");
    ls.append(el("b", "", "Line styles: is it live?"));
    for (const [cls, label, words] of LINE_STYLES) ls.append(row(sample(cls, "var(--ink)", label), words));
    parts.push(ls);
    if (typeof STATUS !== "undefined") {
      const box = el("div", "rtfield");
      box.append(el("b", "", "Node status (the badge on each node)"));
      const said = { live: "running and reporting", building: "being built", blocked: "refused or stopped (e.g. Pump.fun’s check)", hidden: "kept, not shown", planned: "not built yet" };
      for (const [k, v] of Object.entries(STATUS)) {
        const pill = el("span", "st", v[0]);
        pill.dataset.s = k;
        pill.style.setProperty("--s", `var(${v[1]})`);
        box.append(row(pill, said[k] || k));
      }
      box.append(el("div", "asknote", "A badge follows what the server reports where it reports it; otherwise it shows the status you drew."));
      parts.push(box);
    }
    if (typeof KINDS !== "undefined") {
      const box = el("div", "rtfield");
      box.append(el("b", "", "Node kinds (the colour of a node’s header)"));
      for (const v of Object.values(KINDS)) {
        const sw = el("span", "keykind");
        sw.style.background = `var(${v[1]})`;
        box.append(row(sw, v[0]));
      }
      parts.push(box);
    }
    panel.replaceChildren(...parts);
  }
  const panel = el("section");
  panel.id = "keypanel";
  panel.hidden = true;
  document.body.append(panel);
  const open = () => {
    panel.hidden = false;
    for (const id of ["routespanel", "logpanel"]) { const p = document.getElementById(id); if (p) p.hidden = true; } // one side panel at a time
    paint(panel);
  };
  const header = document.querySelector("header");
  if (header) {
    const b = el("button", "", "Key");
    b.id = "bKey";
    b.title = "What each colour, line style and badge means";
    b.onclick = () => (panel.hidden ? open() : (panel.hidden = true));
    const after = document.getElementById("bLog") || document.getElementById("bRoutes");
    if (after && after.parentNode === header) after.after(b);
    else header.insertBefore(b, header.querySelector(".sp") || null);
    for (const id of ["bRoutes", "bLog"]) { const x = document.getElementById(id); if (x) x.addEventListener("click", () => (panel.hidden = true)); }
  }
  // The small legend that is always there: the three line styles that matter most; a click opens the whole key.
  const corner = el("div");
  corner.id = "keycorner";
  corner.title = "Open the whole key";
  // the three measured states.
  corner.append(row(sample("lwlive", "var(--ink)"), "LIVE: data crossed lately"), row(sample("lwbuild", "var(--ink)"), "BUILDING: not measured or not built yet"), row(sample("lwnot", "var(--ink)"), "NOT LIVE: measured and nothing crossed, refused, or off"));
  corner.onclick = open;
  document.body.append(corner);
})();
