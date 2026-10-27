import type { Evidence } from "../../server/evidence";
import type { Item } from "../world/model";
import { gateView, orbitGroups, pinraiView, type OrbitGroup } from "../world/orbit";

/**
 * The token page as Orbit: the coin in the middle, six groups around it (creator, funders, holders, pool, socials, links), and
 * under the picture each group's facts, each with ● (read on chain) or ○ (reported), its age and its link. The paper trail comes from the feed
 * server's `/api/evidence` (server/evidence.ts). Words are the doctor's ("not checked yet"), never a verdict.
 */
export interface OrbitOptions {
  /** The coin's evidence; `null` when there is none yet or it could not be read. */
  fetchEvidence(address: string): Promise<Evidence | null>;
}
export interface Orbit {
  el: HTMLElement;
  setItem(it: Item | null | undefined): void;
}

const SVG = "http://www.w3.org/2000/svg";
const SHOWN = 8;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function se<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (cls) e.setAttribute("class", cls);
  return e;
}

export function createOrbit(opts: OrbitOptions): Orbit {
  const root = el("section", "orbit");
  root.hidden = true;
  const head = el("h2", "orbith", "Evidence");
  const note = el("p", "orbitnote", "What PINR has found linked to this coin. ● read on chain · ○ reported by the source named. A group says “not checked yet” when nothing is recorded for it.");
  const gate = el("div", "orbgate");
  gate.hidden = true;
  const figure = el("div", "orbitfig");
  const lists = el("div", "orbitlists");
  const ai = el("div", "orbgate orbai");
  ai.hidden = true;
  root.append(head, note, gate, ai, figure, lists);

  let item: Item | null = null;
  let epoch = 0;

  function ring(groups: OrbitGroup[], loading: boolean): SVGSVGElement {
    const svg = se("svg", { viewBox: "0 0 340 340", role: "img", "aria-label": "The coin and what is linked to it" }, "orbitsvg");
    const cx = 170;
    const cy = 170;
    groups.forEach((_g, i) => {
      const a = (-90 + i * 60) * (Math.PI / 180);
      const x = cx + Math.cos(a) * 112;
      const y = cy + Math.sin(a) * 112;
      svg.append(se("line", { x1: cx, y1: cy, x2: x, y2: y }, "orbspoke"));
    });
    svg.append(se("circle", { cx, cy, r: 38 }, "orbcoin"));
    const t = se("text", { x: cx, y: cy + 5, "text-anchor": "middle" }, "orbcointxt");
    t.textContent = (item?.raw?.ticker ?? "").slice(0, 8);
    svg.append(t);
    groups.forEach((g, i) => {
      const a = (-90 + i * 60) * (Math.PI / 180);
      const x = cx + Math.cos(a) * 112;
      const y = cy + Math.sin(a) * 112;
      const node = se("g", { tabindex: 0, role: "button", "aria-label": `${g.label}: ${g.facts.length ? g.facts.length + " facts" : "not checked yet"}` }, `orbnode${g.facts.length ? "" : " empty"}`);
      node.setAttribute("data-group", g.id);
      node.append(se("circle", { cx: x, cy: y, r: 26 }, "orbdot"));
      const n = se("text", { x, y: y + 5, "text-anchor": "middle" }, "orbcount");
      n.textContent = loading ? "…" : g.facts.length ? String(g.facts.length) : "○";
      const l = se("text", { x, y: y + (Math.sin(a) > 0.2 ? 44 : -34), "text-anchor": "middle" }, "orblabel");
      l.textContent = g.label;
      node.append(n, l);
      const go = (): void => {
        const target = lists.querySelector<HTMLElement>(`[data-group="${g.id}"]`);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
        target?.classList.add("flash");
        setTimeout(() => target?.classList.remove("flash"), 900);
      };
      node.addEventListener("click", go);
      node.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
          e.preventDefault();
          go();
        }
      });
      svg.append(node);
    });
    return svg;
  }

  function listOf(g: OrbitGroup, loading: boolean): HTMLElement {
    const box = el("div", "orbgroup");
    box.setAttribute("data-group", g.id);
    const h = el("h3", "orbgh");
    h.append(el("span", undefined, g.label), el("em", undefined, g.facts.length ? String(g.facts.length) : ""));
    box.append(h);
    if (!g.facts.length) {
      box.append(el("p", "orbnone", loading ? "Reading…" : g.empty));
      return box;
    }
    const rows = el("div", "orbrows");
    const draw = (all: boolean): void => {
      rows.replaceChildren();
      for (const f of all ? g.facts : g.facts.slice(0, SHOWN)) {
        const row = el("div", "orbrow");
        // ● read on chain, ○ reported; an on-chain row with no receipt link keeps its ● and says so beside it.
        const dot = el("span", `orbd ${f.onchain ? "on" : "off"}`, f.onchain ? "●" : "○");
        dot.title = f.onchain ? "Read on chain" : "Reported, not read on chain";
        const text = el("span", "orbtext", f.text);
        const meta = el("span", "orbmeta", [f.happenedText, f.readText, f.source, f.onchain && !f.link ? "no receipt link yet" : ""].filter(Boolean).join(" · "));
        row.append(dot, text, meta);
        if (f.link) {
          const a = el("a", "orblink", "see it");
          a.href = f.link;
          a.target = "_blank";
          a.rel = "noopener noreferrer nofollow";
          row.append(a);
        }
        rows.append(row);
      }
      if (!all && g.facts.length > SHOWN) {
        const more = el("button", "orbmore", `Show all ${g.facts.length}`);
        more.type = "button";
        more.addEventListener("click", () => draw(true));
        rows.append(more);
      }
    };
    draw(false);
    box.append(rows);
    return box;
  }

  /** The gate's result: what was observed at launch, in plain words, with links. Hidden when the file has none. */
  function drawGate(ev: Evidence | null): void {
    const v = gateView(ev?.gate, Date.now());
    gate.hidden = v === null;
    if (!v) return gate.replaceChildren();
    const h = el("h3", "orbgateh", "At launch");
    const first = el("p", "orbgatehead", v.headline);
    const list = el("div", "orbgatelist");
    for (const l of v.lines) {
      const row = el("div", "orbgaterow");
      row.append(el("span", "orbgatewords", l.words));
      if (l.when) row.append(el("span", "orbgatewhen", l.when));
      for (const k of l.links) {
        const a = el("a", "orblink", k.label);
        a.href = k.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        row.append(a);
      }
      list.append(row);
    }
    gate.replaceChildren(h, first, list);
    if (v.others.length) {
      const box = el("div", "orbgateothers");
      box.append(el("span", "orbgateotherl", "The creator's other coins"));
      for (const o of v.others.slice(0, 5)) {
        if (o.href) {
          const a = el("a", "orblink", `${o.label}${o.when ? ` · ${o.when}` : ""}`);
          a.href = o.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer nofollow";
          box.append(a);
        } else box.append(el("span", "orbgatecoin", `${o.label}${o.when ? ` · ${o.when}` : ""}`));
      }
      gate.append(box);
    }
    if (v.readText) gate.append(el("p", "orbgateread", v.readText));
  }

  /** PINRai's reading: observed words, each with the receipts it stands on. Hidden when the file has none. */
  function drawPinrai(ev: Evidence | null): void {
    const v = pinraiView(ev?.pinrai, Date.now());
    ai.hidden = v === null;
    if (!v) return ai.replaceChildren();
    const list = el("div", "orbgatelist");
    for (const l of v.lines) {
      const row = el("div", "orbgaterow orbairow");
      row.append(el("span", "orbgatewords", l.words));
      if (l.reviewed) row.append(el("span", "orbgatewhen", "second look done"));
      for (const r of l.receipts) {
        const rc = el("span", "orbaireceipt", `${r.mark} `);
        if (r.href) {
          const a = el("a", "orblink", r.text);
          a.href = r.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer nofollow";
          rc.append(a);
        } else rc.append(r.text);
        if (r.when) rc.append(` · ${r.when}`);
        if (r.mark === "●" && !r.href) rc.append(" · no receipt link yet");
        row.append(rc);
      }
      list.append(row);
    }
    ai.replaceChildren(el("h3", "orbgateh", "PINRai's reading"), el("p", "orbgatehead", v.headline), list);
    if (v.readText) ai.append(el("p", "orbgateread", v.readText));
  }

  function render(ev: Evidence | null, loading: boolean): void {
    drawGate(loading ? null : ev);
    drawPinrai(loading ? null : ev);
    const groups = orbitGroups(ev, Date.now());
    figure.replaceChildren(ring(groups, loading));
    lists.replaceChildren(...groups.map((g) => listOf(g, loading)));
  }

  function setItem(it: Item | null | undefined): void {
    const next = it ?? null;
    if (next === item && !root.hidden) return;
    item = next;
    const my = ++epoch;
    // A copy (VAMP) has no data anywhere, only its label: no Orbit for it.
    if (!next || !next.address || (next.status === "flag" && next.flagKind === "VAMP")) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    render(null, true);
    void opts.fetchEvidence(next.address).then((ev) => {
      if (my === epoch) render(ev, false);
    });
  }

  return { el: root, setItem };
}
