import type { FlowSummary } from "../../server/trades";
import { money } from "../world/discoverlist";
import { formatPriceCompact } from "../world/format";

/**
 * Recent trades (Pump.fun's trade list for a Solana coin, the engine's file otherwise): a buy/sell pressure summary and a list of the newest trades (time, side, size in dollars).
 * Shared by the DeepScan page's trades list. It shows only what is in the file: no file means "no trades known", and a file
 * the engine marked incomplete says so (a gap in its live stream means some trades may be missing).
 */
export interface TradesView {
  none: boolean;
  trades: [number, "buy" | "sell", number][];
  complete: boolean;
  coversFrom: number | null;
  asOf: number | null;
  summary: FlowSummary | null;
}
export type TradesState = "loading" | "ok" | "error";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const money2 = (n: number): string => (n >= 1000 ? money(n) : formatPriceCompact(n));
const clock = (t: number): string => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** One pressure line: how much was bought and sold over a window, as a bar. */
function pressure(label: string, buy: number, sell: number, n: number, atLeast = false): HTMLElement {
  const row = el("div", "trp");
  const total = buy + sell;
  const head = el("div", "trph");
  head.append(el("span", "trpl", label), el("span", "trpn", `${atLeast ? "at least " : ""}${n === 1 ? "1 trade" : `${n} trades`}`));
  const bar = el("div", "trpbar");
  if (total > 0) {
    const b = el("i", "trpb");
    b.style.width = `${(buy / total) * 100}%`;
    bar.append(b);
  }
  const nums = el("div", "trpv");
  nums.append(el("b", "up", `Buys ${atLeast ? "at least " : ""}${money2(buy)}`), el("b", "down", `Sells ${atLeast ? "at least " : ""}${money2(sell)}`));
  row.append(head, bar, nums);
  return row;
}

/**
 * The windows a trades view may show. When only the newest trades were read (the list is capped), the hour is a floor, not a measurement
 * ("at least"); and when the list does not even reach back five minutes, both windows are the same read, so ONE line is shown, never two
 * equal-looking windows.
 */
export function pressureWindows(v: TradesView, nowS: number): { label: string; buy: number; sell: number; n: number; atLeast: boolean }[] {
  const s = v.summary;
  if (!s) return [];
  const capped = !v.complete;
  const covered = v.coversFrom ? Math.max(0, nowS - v.coversFrom) : null;
  if (capped && (covered === null || covered < 300)) {
    const label = covered === null ? "Newest trades" : `Newest trades (${covered < 90 ? `last ${Math.round(covered)} s` : `last ${Math.round(covered / 60)} min`})`;
    return [{ label, buy: s.buy1h, sell: s.sell1h, n: s.n1h, atLeast: true }];
  }
  // A capped list that still reaches back a full hour or more holds every trade of the hour: the hour is then a measurement, not a floor.
  const hourFloor = capped && covered !== null && covered < 3600;
  return [
    { label: "Last 5 minutes", buy: s.buy5m, sell: s.sell5m, n: s.n5m, atLeast: false },
    { label: hourFloor ? "Last hour (at least)" : "Last hour", buy: s.buy1h, sell: s.sell1h, n: s.n1h, atLeast: hourFloor },
  ];
}

/** Fill `host` with the trades view. `limit` is how many of the newest trades to list. */
/** What a coin with no trade read says: true of any chain, and not "give it a few seconds" on a coin that never traded. */
export const NO_TRADES_READ = "No trades read yet.";
export const TAPE_LINES = 10;
export const TAPE_LINES_MORE = 40;
export function renderTrades(host: HTMLElement, state: TradesState, v: TradesView | null, limit = TAPE_LINES): void {
  // Ten lines by default and a control to show more.
  const expanded = host.dataset.more === "1";
  host.replaceChildren();
  if (state === "loading") return void host.append(el("p", "trnote", "Loading trades…"));
  if (state === "error" || !v) return void host.append(el("p", "trnote", "Trades are not read yet. PINR asks again shortly."));
  if (v.none || !v.trades.length) {
    host.append(el("p", "trnote", v.none ? NO_TRADES_READ : "No trades in the list yet."));
    return;
  }
  const nowS = Date.now() / 1000;
  for (const w of pressureWindows(v, nowS)) host.append(pressure(w.label, w.buy, w.sell, w.n, w.atLeast));
  // The receipt of these counts and dollars: Pump.fun's trade list, and how long ago it was read.
  if (v.asOf) host.append(el("div", "dsrcpt", `Pump.fun · read ${Math.max(0, Math.round(nowS - v.asOf))} s ago`));
  if (!v.complete) host.append(el("p", "trnote warn", "Only the newest trades could be read for this coin, so the list may not reach back to the start of the window. This is not a full tape."));
  const list = el("div", "trlist");
  const shownN = expanded ? Math.max(limit, TAPE_LINES_MORE) : limit;
  for (const [t, side, usd] of v.trades.slice(-shownN).reverse()) {
    const row = el("div", "trrow");
    const ago = Math.max(0, Math.round(nowS - t));
    row.append(el("span", "trt", clock(t)), el("b", side === "buy" ? "trs up" : "trs down", side === "buy" ? "Buy" : "Sell"), el("span", "trv", money2(usd)), el("i", "tra", ago < 90 ? `${ago}s` : ago < 5400 ? `${Math.round(ago / 60)}m` : `${Math.round(ago / 3600)}h`));
    list.append(row);
  }
  host.append(list);
  if (v.trades.length > limit) {
    const more = el("button", "trmore", expanded ? "Show fewer" : "Show more");
    more.type = "button";
    more.addEventListener("click", () => {
      host.dataset.more = expanded ? "0" : "1";
      renderTrades(host, state, v, limit);
    });
    host.append(more);
  }
  if (v.coversFrom) host.append(el("p", "trnote", `Trades since ${new Date(v.coversFrom * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}. Sizes are in US dollars at the time of the trade.`));
}
