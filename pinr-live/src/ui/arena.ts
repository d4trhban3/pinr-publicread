import { chainName } from "../world/chainname";
import type { ArenaCoin, ArenaGroup } from "../../server/arena";
import { ageText, money, signedPct } from "../world/discoverlist";
import { shortAddress } from "../world/livefeed";
import { attachPageGestures, createPlacer, type GestureOptions, type Placement } from "./pageoverlay";
import { tagChips } from "../world/tags";

/**
 * the PvP Arena. Each contested coin's versions side by side (copy hiding is off on this page only), ranked strictly by the last 30
 * minutes' volume, then X presence, then the chart, so you see which version is drawing the money. Observed figures only: a dash is a figure no
 * source gave, never a zero; "earliest launch" is what the launch times show, not a judgement.
 */
export interface ArenaOptions extends GestureOptions {
  fetchArena(): Promise<{ groups: ArenaGroup[]; asOfMs: number } | null>;
  /** A version was tapped: open its DeepScan page. */
  onOpen(address: string): void;
}
export interface ArenaPage {
  el: HTMLElement;
  place(p: Placement | null, live: boolean): void;
  update(nowSec: number): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const dash = "—";
const usd = (v: number | null): string => (v === null ? dash : money(v));

function memberRow(m: ArenaCoin, rank: number, onOpen: (a: string) => void): HTMLElement {
  const row = el("button", `arrow${rank === 1 ? " lead" : ""}`);
  row.type = "button";
  const name = m.name ?? shortAddress(m.address); // a member off the lists that no source named shows its address (W1), never a blank
  row.setAttribute("aria-label", `Open ${name}`);
  row.addEventListener("click", () => onOpen(m.address));
  const pic = el("span", "arpic");
  const initial = (m.name ?? "?").trim().charAt(0).toUpperCase() || "?";
  if (m.imageUrl) {
    const img = el("img");
    img.src = m.imageUrl;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    // a picture that does not load is asked of PINR's own picture server once (as the tiles do), then shows the name's first letter, never
    // the browser's broken-image mark (checklist 5)
    img.addEventListener("error", () => {
      const own = `/api/img?a=${encodeURIComponent(m.address)}`;
      if (!img.src.includes("/api/img")) img.src = own;
      else pic.textContent = initial;
    });
    pic.append(img);
  } else pic.textContent = initial;
  const who = el("span", "arwho");
  who.append(el("b", undefined, `${rank}. ${name}`), el("span", "artick", m.ticker ? `$${m.ticker.replace(/^\$/, "")}` : dash));
  const meta = [m.launchpad ?? (m.chain ? chainName(m.chain) : ""), m.launchedAtMs ? `${ageText(Math.max(0, (Date.now() - m.launchedAtMs) / 60_000))} old` : ""].filter(Boolean).join(" · ");
  who.append(el("span", "armeta", meta || dash));
  if (m.earliest) who.append(el("span", "archip", "earliest launch"));
  if (m.tags?.length) {
    const t = el("span", "artags"); // its tags, here too
    t.append(...tagChips(m.tags));
    who.append(t);
  }
  const fig = (label: string, value: string, cls = ""): HTMLElement => {
    const f = el("span", `arfig ${cls}`);
    f.append(el("span", "arlab", label), el("span", "arval", value));
    return f;
  };
  const x = m.xPosts !== null ? `${m.xPosts} post${m.xPosts === 1 ? "" : "s"}` : m.hasX ? "linked" : dash;
  const chg = m.change24hPct === null ? dash : signedPct(m.change24hPct);
  row.append(
    pic,
    who,
    // not read yet is a dash, never "$0 · 0 tx" (checklist 7); an older server without the flag counts as read
    fig("30 min", m.recentKnown === false ? dash : m.recentAtLeast ? `${money(m.recentUsd)}+ · ${m.recentTrades}+ tx` : `${money(m.recentUsd)} · ${m.recentTrades} tx`, "arhot"),
    fig("24h vol", usd(m.volume24hUsd)),
    fig("X", x),
    fig("24h", chg, m.change24hPct === null ? "" : m.change24hPct >= 0 ? "up" : "down"),
    fig("MC", usd(m.valuationUsd)),
  );
  return row;
}

export function createArenaPage(opts: ArenaOptions): ArenaPage {
  const root = el("div", "arenapage");
  root.id = "arena";
  const frame = el("div", "dframe");
  const scroller = el("div", "dscroll arscroll");
  frame.append(scroller);
  root.append(frame);
  const page = el("div", "arpage");
  scroller.append(page);
  attachPageGestures(root, scroller, opts);
  const place = createPlacer(root, frame, scroller, () => {});
  const head = el("div", "arhead");
  head.append(el("h1", undefined, "PvP Arena"), el("p", "arsub", "Every version of a contested coin, side by side. Ranked by the last 30 minutes' volume, then X, then the chart. Observed figures, not a verdict."));
  const list = el("div", "arlist");
  const foot = el("p", "arfoot");
  page.append(head, list, foot);

  let live = false;
  let lastAsk = 0;
  let asking = false;
  let key = "";
  async function load(): Promise<void> {
    if (asking) return;
    asking = true;
    lastAsk = Date.now();
    const got = await opts.fetchArena().catch(() => null);
    asking = false;
    if (!got) {
      if (!list.childElementCount) list.replaceChildren(el("p", "arempty", "The Arena is not read yet. PINR asks again shortly."));
      return;
    }
    const k = JSON.stringify(got.groups);
    if (k === key) return;
    key = k;
    if (!got.groups.length) {
      list.replaceChildren(el("p", "arempty", "No active battles right now: no coin has two or more versions trading in the last 30 minutes."));
    } else {
      list.replaceChildren(
        ...got.groups.map((g) => {
          const card = el("section", "argroup");
          const h = el("div", "argh");
          h.append(el("b", undefined, `${g.title ?? dash}${g.ticker ? ` $${g.ticker.replace(/^\$/, "")}` : ""}`), el("span", "arghv", `${g.members.length} versions · ${money(g.recentUsd)} in 30 min`));
          card.append(h, ...g.members.map((m, i) => memberRow(m, i + 1, opts.onOpen)));
          return card;
        }),
      );
    }
    foot.textContent = `Read ${new Date(got.asOfMs).toLocaleTimeString()}. Copy hiding is off on this page only; everywhere else PINR shows one version of each family.`;
  }
  return {
    el: root,
    place(p, isLive) {
      place(p, isLive);
      if (isLive && !live) void load();
      live = isLive;
    },
    update() {
      if (live && Date.now() - lastAsk > 15_000) void load();
    },
  };
}
