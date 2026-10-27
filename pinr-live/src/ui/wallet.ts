import { chainName } from "../world/chainname";
import { scoreShown } from "../world/hub";
import { SCORE_NOTICE, makeScoreTag } from "./scorenotice";
import type { WalletView } from "../../server/wallet";
import { money } from "../world/discoverlist";
import { formatPriceCompact } from "../world/format";
import type { Item } from "../world/model";
import { scoreColor } from "../world/scorecolor";
import { avatarColors, cleanAddress, parseProfile, shortAddr, VIEW_ONLY_POINTS, VIEW_ONLY_TITLE, WALLET_KEY, type WalletProfile } from "../world/wallet";
import { attachPageGestures, createPlacer, type GestureOptions, type Placement } from "./pageoverlay";

/**
 * Wallet. VIEW ONLY: a lookup of a public address typed or pasted in. The site never connects to a wallet, so there is no
 * connect button, no wallet library and no wallet request anywhere (see world/wallet.ts and the test that scans the code).
 */
export interface WalletOptions extends GestureOptions {
  /** Which tracked tokens this address holds (public balances, from the feed server). Null when it could not be asked. */
  fetchWallet(address: string): Promise<WalletView | null>;
  items(): readonly Item[];
  /** A holding was tapped: open it. */
  onOpenToken(item: Item): void;
}

export interface WalletPage {
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

const CHECK_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v5c0 4.4 2.9 8.3 7 10 4.1-1.7 7-5.6 7-10V6z"/><path d="m9 12 2.2 2.2L15.5 10"/></svg>';
/** Dollars for a holding: whole-dollar style from $1 up, and the exact small amount below it (never a misleading "$0"). */
const usd = (v: number): string => (v >= 1 ? money(v) : formatPriceCompact(v));
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 });

export function createWalletPage(opts: WalletOptions): WalletPage {
  const root = el("div", "walletpage");
  root.id = "wallet";
  const frame = el("div", "dframe");
  const scroller = el("div", "dscroll wlscroll");
  frame.append(scroller);
  root.append(frame);
  const page = el("div", "wlpage");
  scroller.append(page);
  attachPageGestures(root, scroller, opts);
  root.addEventListener("pointerdown", () => (pressing = true), true);
  const release = (): void => void setTimeout(() => (pressing = false), 0);
  root.addEventListener("pointerup", release, true);
  root.addEventListener("pointercancel", release, true);
  const place = createPlacer(root, frame, scroller, () => {});

  // ------------------------------------------------------------------ state ---
  let profile: WalletProfile | null = null;
  try {
    profile = parseProfile(JSON.parse(localStorage.getItem(WALLET_KEY) ?? "null"));
  } catch {
    /* blocked storage: start empty */
  }
  let view: WalletView | null = null;
  let viewState: "idle" | "loading" | "ok" | "error" = "idle";
  let viewAt = 0;
  let lastUpdate = 0;
  let epoch = 0;
  let builtKey = "";
  /** True while a finger or button is down on the page: the page is not rebuilt under it, or the press would land on a button that no longer exists. */
  let pressing = false;

  const save = (): void => {
    try {
      if (profile) localStorage.setItem(WALLET_KEY, JSON.stringify(profile));
      else localStorage.removeItem(WALLET_KEY);
    } catch {
      /* kept for this visit only */
    }
  };

  // ---------------------------------------------------------------- actions ---
  function setProfile(next: WalletProfile | null): void {
    profile = next;
    save();
    view = null;
    viewState = next ? "loading" : "idle";
    epoch++;
    builtKey = "";
    if (next) void loadView();
    render();
  }
  async function loadView(): Promise<void> {
    const p = profile;
    if (!p) return;
    const e = epoch;
    viewAt = Date.now();
    const got = await opts.fetchWallet(p.address);
    if (e !== epoch) return;
    view = got;
    viewState = got && got.status !== "error" ? "ok" : "error";
    builtKey = "";
    if (!pressing) render(); // while a press is down the next update rebuilds the page instead

  }
  function clearProfile(): void {
    setProfile(null);
  }
  const copy = async (text: string, btn: HTMLElement): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Hold to copy";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1600);
  };

  // ---------------------------------------------------------------- pieces ---
  function safetyCard(compactView: boolean): HTMLElement {
    const card = el("section", "wlsafe");
    const head = el("div", "wlsafeh");
    const icon = el("span", "wlsafei");
    icon.innerHTML = CHECK_ICON;
    head.append(icon, el("b", undefined, VIEW_ONLY_TITLE));
    card.append(head);
    if (compactView) {
      card.append(el("p", "wlsafep", "PINR only looks up this public address. It does not connect to your wallet."));
      const more = el("details", "wlmore");
      more.append(el("summary", undefined, "What view-only means"));
      const ul = el("ul");
      for (const t of VIEW_ONLY_POINTS) ul.append(el("li", undefined, t));
      more.append(ul);
      card.append(more);
    } else {
      const ul = el("ul", "wlsafeul");
      for (const t of VIEW_ONLY_POINTS) ul.append(el("li", undefined, t));
      card.append(ul);
    }
    return card;
  }

  function watchCard(): HTMLElement {
    const sec = el("section", "dssec wlsec");
    sec.append(el("h2", "dsh", "Look up an address"));
    sec.append(el("p", "wlhint", "Paste any wallet address to see which tokens PINR tracks it holds. Nothing is connected and no wallet app is involved."));
    const row = el("div", "wlrow");
    const input = el("input", "wlinput");
    input.type = "text";
    input.placeholder = "0x… or a Solana address";
    input.autocomplete = "off";
    input.spellcheck = false;
    const go = el("button", "wlgo", "View");
    go.type = "button";
    const err = el("p", "wlmsg");
    const run = (): void => {
      const c = cleanAddress(input.value);
      if (!c) {
        err.textContent = "That is not a wallet address. Check it and try again.";
        return;
      }
      setProfile({ chain: c.chain, address: c.address, at: Date.now() });
    };
    go.addEventListener("click", run);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
    row.append(input, go);
    sec.append(row, err);
    return sec;
  }

  function profileCard(p: WalletProfile): HTMLElement {
    const card = el("section", "wlprofile");
    const [c1, c2, c3] = avatarColors(p.address);
    const av = el("div", "wlavatar");
    av.style.background = `radial-gradient(circle at 30% 25%, ${c1}, ${c2} 55%, ${c3})`;
    const who = el("div", "wlwho");
    who.append(el("b", "wladdr", shortAddr(p.address)));
    const chips = el("div", "wlchips");
    chips.append(el("span", "wlchip", p.chain === "solana" ? "Solana" : "BNB Chain · Base"));
    chips.append(el("span", "wlchip", "Viewing only"));
    who.append(chips);
    const actions = el("div", "wlactions");
    const cp = el("button", "wlsmall", "Copy");
    cp.type = "button";
    cp.addEventListener("click", () => void copy(p.address, cp));
    const dc = el("button", "wlsmall wlwarn", "Clear");
    dc.type = "button";
    dc.addEventListener("click", clearProfile);
    actions.append(cp, dc);
    card.append(av, who, actions);
    return card;
  }

  function holdingsCard(): HTMLElement {
    const sec = el("section", "dssec wlsec");
    sec.append(el("h2", "dsh", "Tracked tokens held"));
    if (viewState === "loading" || viewState === "idle") return sec.appendChild(el("p", "wlhint", "Reading the chain…")), sec;
    if (viewState === "error" || !view) return sec.appendChild(el("p", "wlhint", "This wallet's balances are not read yet. PINR asks again shortly.")), sec;
    if (view.status === "partial") sec.append(el("p", "wlhint", `Not read yet on ${view.unavailable.map(chainName).join(", ")}. What is shown is real; it may be incomplete.`));
    if (!view.holdings.length) {
      sec.append(el("p", "wlhint", "This wallet holds none of the tokens PINR tracks right now."));
      return sec;
    }
    const total = el("div", "wltotal");
    total.append(el("span", "dsstatl", "Value of tracked tokens held"), el("b", undefined, view.totalUsd !== null ? usd(view.totalUsd) : "—"));
    sec.append(total);
    // The notice beside every score: one visible line over the list, since a phone shows no hover text.
    if (scoreShown() && view.holdings.some((h) => h.score !== null)) sec.append(el("p", "wlhint", SCORE_NOTICE));
    for (const h of view.holdings) {
      const found = opts.items().find((i) => i.address?.toLowerCase() === h.address.toLowerCase());
      const row = el("button", "wlhold");
      row.type = "button";
      const n = el("span", "wlholdn");
      n.append(el("b", undefined, h.name ?? shortAddr(h.address)), el("i", undefined, `${h.ticker ?? ""} · ${compact.format(h.balance)}`));
      const right = el("span", "wlholdv");
      right.append(el("b", undefined, h.usd !== null ? usd(h.usd) : "no price"));
      // no score or verdict label while the score is hidden (not deleted); a copy (VAMP) keeps its label as a fact.
      const sc = el("i", undefined, scoreShown() ? (h.noScoreLabel ?? (h.score !== null ? String(h.score) : "—")) : h.noScoreLabel === "VAMP" ? "VAMP" : "");
      if (scoreShown() && h.score !== null) sc.style.color = scoreColor(h.score);
      else if (h.noScoreLabel && (scoreShown() || h.noScoreLabel === "VAMP")) sc.style.color = "var(--mandarin)";
      right.append(sc);
      if (scoreShown() && h.score !== null) {
        const tag = makeScoreTag();
        tag.hidden = false;
        right.append(tag);
      }
      row.append(n, right);
      row.disabled = !found;
      row.addEventListener("click", () => found && opts.onOpenToken(found));
      sec.append(row);
    }
    sec.append(el("p", "wlhint", "Only tokens PINR tracks are listed. Tokens without a price are left out of the total."));
    return sec;
  }

  // ----------------------------------------------------------------- render ---
  function render(): void {
    page.replaceChildren();
    const top = el("div", "wltop");
    top.append(el("h1", "wltitle", "Wallet"), el("p", "wlsub", profile ? "What this public address holds." : "Look up what a public wallet address holds."));
    page.append(top);
    if (!profile) {
      page.append(safetyCard(false), watchCard());
      return;
    }
    page.append(profileCard(profile), safetyCard(true), holdingsCard(), el("p", "dsfine", "Everything here is read from public blockchain data for this one address. PINR is a research tool, not investment advice."));
  }

  // -------------------------------------------------------------- start up ---
  render();
  if (profile) {
    viewState = "loading";
    void loadView();
  }

  return {
    el: root,
    place,
    update(nowSec) {
      if (nowSec - lastUpdate < 1) return;
      lastUpdate = nowSec;
      if (!profile) return;
      const age = Date.now() - viewAt;
      if (viewState !== "loading" && age > (viewState === "error" ? 10_000 : 60_000)) void loadView();
      const key = `${profile.address}|${viewState}|${view?.holdings.map((h) => h.address + h.balance + (h.usd ?? "")).join(",") ?? ""}`;
      if (key !== builtKey && !pressing) {
        builtKey = key;
        render();
      }
    },
  };
}
