import { scoreShown, setScoreShown } from "./hub";
setScoreShown(true); // these tests cover the score's own behaviour: the switch (world/hub.ts) is on for them
import { describe, expect, it } from "vitest";
import { applySnapshot, applyTailPage, GONE_AFTER_MS, importances, tapeSurge, shortAddress, surgeFor, type FeedSnapshot } from "./livefeed";
import { makeStore, statusLook, avatarChar, type Item } from "./model";
import { rankDiscover } from "./discoverlist";
import { MASKED_NAME, MASKED_TICKER, moderation } from "./moderation";
import { selectAndRank } from "./filters";
import type { WireToken } from "../../server/translate";

const tok = (over: Partial<WireToken> = {}): WireToken => ({
  address: "0x09d4c98ddba3ec74964faafce969b2130f13ffff",
  chain: "bsc",
  launchpad: "fourmeme",
  name: null,
  ticker: null,
  imageUrl: null,
  score: 20,
  coverage: 45,
  noScoreLabel: null,
  note: "No project presence",
  valuationUsd: 4500,
  volume24hUsd: null,
  change24hPct: null,
  priceSeries: null,
  launchedAtMs: null,
  asOfMs: null,
  rank: null,
  priceUsd: null,
  liquidityUsd: null,
  quotePair: null,
  changeWindowH: null,
  priceSource: null,
  flow: null,
  lastTradeMs: null,
  ...over,
});
const snap = (tokens: WireToken[]): FeedSnapshot => ({ contract: "1.0", mode: "replay", asOfMs: 1, files: tokens.length, tokens, cut: 0, problems: [] });
const load = (tokens: WireToken[]) => {
  const store = makeStore();
  const by = new Map<string, Item>();
  applySnapshot(store, by, snap(tokens), 1_800_000_000_000);
  return { store, by };
};

describe("live feed: real results into tiles", () => {
  it("shows what the engine gave and marks everything else missing", () => {
    const { store } = load([tok()]);
    const it = store.items[0]!;
    expect(it).toMatchObject({ value: "20", coverage: 45, status: "ok", flagKind: null, hasFlow: false, tag: "", address: "0x09d4c98ddba3ec74964faafce969b2130f13ffff" });
    expect(it.name).toBe("0x09d4…ffff"); // no name given: the address, not an invented name
    expect(it.ticker).toBe("—");
    expect(Number.isNaN(it.volume24h) && Number.isNaN(it.change24h) && Number.isNaN(it.ageMin)).toBe(true);
    expect(it.mcap).toBe(4500);
    expect(it.chart).toEqual([]);
  });

  it("never shows the engine's own error words as a finding; a coin with no name shows its short address (W4)", () => {
    const { store } = load([tok({ note: "Technical error, retrying; serial launcher" })]);
    const it = store.items[0]!;
    expect(it.findings).toEqual(["serial launcher"]);
    expect(it.name).toBe("0x09d4…ffff");
    expect(load([tok({ note: "Technical error, retrying" })]).store.items[0]!.findings).toEqual([]);
  });
  it("a no-score label becomes a flagged tile with no number", () => {
    const { store } = load([tok({ score: null, noScoreLabel: "MAYHEM", note: null, coverage: 0 })]);
    const it = store.items[0]!;
    expect(it).toMatchObject({ status: "flag", flagKind: "MAYHEM", value: "—" });
    expect(statusLook(it)).toMatchObject({ kind: "flag", text: "MAYHEM", numeric: false });
  });

  it("while the score is hidden a verdict label is not shown, and a copy's label (VAMP) stays as a fact", () => {
    setScoreShown(false);
    try {
      const { store } = load([tok({ address: "0x" + "1".repeat(40), score: null, noScoreLabel: "MAYHEM", note: null, coverage: 0 }), tok({ address: "0x" + "2".repeat(40), score: null, noScoreLabel: "VAMP", note: null, coverage: 0 })]);
      const m = store.items.find((i) => i.address === "0x" + "1".repeat(40))!;
      const v = store.items.find((i) => i.address === "0x" + "2".repeat(40))!;
      expect(m).toMatchObject({ status: "ok", flagKind: null });
      expect(statusLook(m).kind).toBe("hidden");
      expect(v).toMatchObject({ status: "flag", flagKind: "VAMP" });
      expect(statusLook(v)).toMatchObject({ kind: "flag", text: "VAMP" });
    } finally {
      setScoreShown(true);
    }
  });

  it("no number and no coverage is a dash, never a zero", () => {
    const { store } = load([tok({ score: null, coverage: 0, note: null })]);
    expect(statusLook(store.items[0]!)).toMatchObject({ text: "—", numeric: false });
  });

  it("a second reading updates the same tile in place and reports a real score move", () => {
    const { store, by } = load([tok({ score: 20 })]);
    const id = store.items[0]!.id;
    applySnapshot(store, by, snap([tok({ score: 31 })]), 1_800_000_060_000);
    expect(store.items.length).toBe(1);
    const it = store.items[0]!;
    expect(it.id).toBe(id);
    expect(it.value).toBe("31");
    expect(it.note).toBe("Score moved +11");
    expect(it.noteSeq).toBe(1);
    expect(it.spike).toBeGreaterThan(0.25);
    applySnapshot(store, by, snap([tok({ score: 31 })]), 1_800_000_120_000);
    expect(it.noteSeq).toBe(1); // nothing changed: no event
    applySnapshot(store, by, snap([tok({ score: 25 })]), 1_800_000_180_000);
    expect(it.note).toBe("Score moved −6");
  });

  it("finds the same token again by address regardless of letter case", () => {
    const { store, by } = load([tok({ address: "0xABCDEF0000000000000000000000000000000001" })]);
    applySnapshot(store, by, snap([tok({ address: "0xabcdef0000000000000000000000000000000001", score: 22 })]), 2);
    expect(store.items.length).toBe(1);
  });

  it("a name, picture or price series that arrives later is written into the same tile", () => {
    const { store, by } = load([tok()]);
    applySnapshot(store, by, snap([tok({ name: "Zorin", ticker: "$ZRN", priceSeries: [2, 3, 4], change24hPct: 100, launchedAtMs: 1_800_000_000_000 - 30 * 60000 })]), 1_800_000_000_000);
    const it = store.items[0]!;
    expect(it).toMatchObject({ name: "Zorin", ticker: "$ZRN", change24h: 100 });
    expect(it.chart).toEqual([1, 1.5, 2]);
    expect(Math.round(it.ageMin)).toBe(30);
  });

  it("tile size comes only from the token's own valuation; unknown valuation is the smallest tile", () => {
    const b = importances([tok({ valuationUsd: 1000 }), tok({ valuationUsd: 1_000_000 }), tok({ valuationUsd: null })]);
    expect(b[1]!).toBeGreaterThan(b[0]!);
    expect(b[2]).toBe(0.12);
    expect(Math.max(...b)).toBeLessThanOrEqual(0.74);
    expect(importances([tok({ valuationUsd: null })])).toEqual([0.12]);
  });

  it("the Discover list copes with missing 24h figures: no crash, tokens with data first, New Launches empty without launch times", () => {
    const { store } = load([tok({ address: "0xa" + "0".repeat(39), change24hPct: -40 }), tok({ address: "0xb" + "0".repeat(39), change24hPct: null }), tok({ address: "0xc" + "0".repeat(39), change24hPct: 12 })]);
    const movers = rankDiscover("movers", store.items, "");
    expect(movers.map((i) => i.change24h).filter(Number.isFinite)).toEqual([-40, 12]);
    expect(Number.isNaN(movers[2]!.change24h)).toBe(true);
    expect(rankDiscover("fresh", store.items, "")).toEqual([]);
    expect(selectAndRank("new", store.items)).toEqual([]);
    expect(selectAndRank("trending", store.items).length).toBeGreaterThan(0);
  });

  it("the roster is live: a token whose file is gone leaves, and the store says it changed", () => {
    const { store, by } = load([tok({ address: "0xa" + "0".repeat(39) }), tok({ address: "0xb" + "0".repeat(39) })]);
    const rev = store.rev;
    expect(store.items.length).toBe(2);
    applySnapshot(store, by, snap([tok({ address: "0xb" + "0".repeat(39) })]), 5);
    // missing for a moment: still there (lists churn)
    expect(store.items.length).toBe(2);
    applySnapshot(store, by, snap([tok({ address: "0xb" + "0".repeat(39) })]), 5 + GONE_AFTER_MS + 1);
    expect(store.items.map((i) => i.address)).toEqual(["0xb" + "0".repeat(39)]);
    expect(by.size).toBe(1);
    expect(store.rev).toBeGreaterThan(rev);
    applySnapshot(store, by, snap([tok({ address: "0xb" + "0".repeat(39) }), tok({ address: "0xc" + "0".repeat(39) })]), 5 + GONE_AFTER_MS + 6);
    expect(store.items.length).toBe(2);
  });

  it("price history from the market source fills the chart and says where it came from", () => {
    const { store } = load([tok({ priceSeries: [2, 3, 4], change24hPct: 120, changeWindowH: 6, volume24hUsd: 5000, priceSource: "GeckoTerminal" })]);
    const it = store.items[0]!;
    expect(it).toMatchObject({ changeWindowH: 6, priceSource: "GeckoTerminal", volume24h: 5000, change24h: 120 });
    expect(it.chart).toEqual([1, 1.5, 2]);
    const none = load([tok()]).store.items[0]!;
    expect(Number.isNaN(none.changeWindowH)).toBe(true);
    expect(none.priceSource).toBe("");
  });

  it("surges come only from real changes between two readings", () => {
    const p = { score: 30, coverage: 50, flag: null, mcap: 1000 };
    expect(surgeFor(p, { ...p })).toBeNull();
    expect(surgeFor(p, { ...p, score: 41 })).toMatchObject({ text: "Score moved +11", side: 1, scoreDelta: 11 });
    expect(surgeFor(p, { ...p, score: 22 })).toMatchObject({ text: "Score moved −8", side: 0, scoreDelta: -8 });
    expect(surgeFor(p, { ...p, mcap: 1100 })).toMatchObject({ text: "Market cap +10%", side: 1 });
    expect(surgeFor(p, { ...p, mcap: 1050 })).toBeNull(); // under the threshold
    expect(surgeFor(p, { ...p, mcap: 800 })).toMatchObject({ text: "Market cap −20%", side: 0 });
    expect(surgeFor(p, { ...p, coverage: 65 })).toMatchObject({ text: "Coverage +15%", side: 1 });
    expect(surgeFor(p, { ...p, coverage: 55 })).toBeNull();
    expect(surgeFor(p, { ...p, flag: "MAYHEM", score: NaN })).toMatchObject({ text: "Flag raised: MAYHEM", side: 0 });
    // already flagged and still flagged is not news
    expect(surgeFor({ ...p, flag: "MAYHEM" }, { ...p, flag: "MAYHEM" })).toBeNull();
    // missing data on either side is never read as a move
    expect(surgeFor({ ...p, mcap: NaN }, { ...p, mcap: 5000 })).toBeNull();
    expect(surgeFor({ ...p, score: NaN }, { ...p, score: 40 })).toBeNull();
  });

  it("says nothing about the score or coverage while the switch is off", () => {
    const p = { score: 30, coverage: 50, flag: null, mcap: 1000 };
    setScoreShown(false);
    try {
      expect(surgeFor(p, { ...p, score: 41 })).toBeNull();
      expect(surgeFor(p, { ...p, coverage: 75 })).toBeNull();
      expect(surgeFor(p, { ...p, score: 41, coverage: 75, mcap: 1100 })).toMatchObject({ text: "Market cap +10%" });
      expect(surgeFor(p, { ...p, score: 41, flag: "VAMP" })).toMatchObject({ text: "Flag raised: VAMP" });
    } finally {
      setScoreShown(true);
    }
  });

  it("nothing surges on the very first load, but a token joining later does, and a market-cap move on the screen swells the tile", () => {
    const { store, by } = load([tok({ address: "0xa" + "0".repeat(39), valuationUsd: 1000 })]);
    expect(store.items[0]!.note).toBeNull();
    expect(store.items[0]!.spike).toBe(0);
    applySnapshot(store, by, snap([tok({ address: "0xa" + "0".repeat(39), valuationUsd: 1300 }), tok({ address: "0xb" + "0".repeat(39) })]), 9);
    const a = store.items[0]!;
    const b = store.items[1]!;
    expect(a.note).toBe("Market cap +30%");
    expect(a.spike).toBeGreaterThan(0.3);
    expect(b.note).toBe("New in the roster");
  });

  it("one unreadable token is skipped and counted; the others still load and no half-made tile is left behind", () => {
    const store = makeStore();
    const by = new Map<string, Item>();
    const bad = { ...tok({ address: "0xbad" + "0".repeat(37) }) } as WireToken;
    Object.defineProperty(bad, "name", {
      get() {
        throw new Error("boom");
      },
    });
    const noAddress = { ...tok(), address: undefined } as unknown as WireToken;
    const origError = console.error;
    console.error = () => {};
    try {
      applySnapshot(store, by, snap([tok({ address: "0xa" + "0".repeat(39) }), bad, noAddress, tok({ address: "0xb" + "0".repeat(39) })]), 1);
    } finally {
      console.error = origError;
    }
    expect(store.skipped).toBe(2);
    expect(store.items.map((i) => i.address)).toEqual(["0xa" + "0".repeat(39), "0xb" + "0".repeat(39)]);
    expect(by.size).toBe(2);
    expect(store.items.every((i) => i.name !== "")).toBe(true);
  });

  it("small helpers", () => {
    expect(shortAddress("0x09d4c98ddba3ec74964faafce969b2130f13ffff")).toBe("0x09d4…ffff");
    expect(shortAddress("short")).toBe("short");
    expect(avatarChar("Zorin")).toBe("Z");
    expect(avatarChar("0x09d4…ffff")).toBe("·");
  });

  it("real trades switch the buy and sell streaks on, with the real mix of buys and sells", () => {
    const flow = { buy5m: 30, sell5m: 10, buy1h: 60, sell1h: 140, n5m: 8, n1h: 40, lastAt: 1_800_000_000 - 20, complete: true, asOf: 1_800_000_000 };
    const { by } = load([tok({ flow })]);
    const it = [...by.values()][0]!;
    expect(it.hasFlow).toBe(true);
    expect(it.buyShare).toBeCloseTo(0.75, 10); // the last 5 minutes: 30 of 40 dollars were buys
    expect(it.restBuy).toBeCloseTo(0.3, 10); // the last hour: 60 of 200
  });

  it("falls back to the hour's mix when the last 5 minutes are quiet, and shows nothing without trades", () => {
    const hourOnly = { buy5m: 0, sell5m: 0, buy1h: 90, sell1h: 10, n5m: 0, n1h: 12, lastAt: 1_799_999_000, complete: false, asOf: 1_800_000_000 };
    const quiet = { buy5m: 0, sell5m: 0, buy1h: 0, sell1h: 0, n5m: 0, n1h: 0, lastAt: 1_799_000_000, complete: true, asOf: 1_800_000_000 };
    const a = [...load([tok({ flow: hourOnly })]).by.values()][0]!;
    expect(a.hasFlow).toBe(true);
    expect(a.buyShare).toBeCloseTo(0.9, 10);
    const b = [...load([tok({ flow: quiet })]).by.values()][0]!;
    expect(b.hasFlow).toBe(false);
    expect([...load([tok()]).by.values()][0]!.hasFlow).toBe(false);
  });

  it("one or two trades say too little: the streaks show an even mix, not a strong lean", () => {
    const thin = { buy5m: 0.17, sell5m: 0, buy1h: 0.17, sell1h: 0, n5m: 1, n1h: 1, lastAt: 1_799_999_990, complete: true, asOf: 1_800_000_000 };
    const it = [...load([tok({ flow: thin })]).by.values()][0]!;
    expect(it.hasFlow).toBe(true); // it did trade
    expect(it.buyShare).toBe(0.5);
    expect(it.restBuy).toBe(0.5);
  });
});

describe("tape events", () => {
  it("say what happened in plain words with the measured dollars", () => {
    expect(tapeSurge({ kind: "large_buy", usd: 540, atMs: 1 }).text).toBe("Large buy $540");
    expect(tapeSurge({ kind: "large_sell", usd: 1500, atMs: 1 })).toMatchObject({ text: "Large sell $1.5K", side: 0 });
    expect(tapeSurge({ kind: "volume_surge", usd: 2400, atMs: 1 }).text).toBe("Volume surge $2.4K");
  });
});

describe("the rest of the scored set", () => {
  const A = tok({ address: "0x" + "a".repeat(40), valuationUsd: 90000 });
  const T1 = tok({ address: "0x" + "1".repeat(40), valuationUsd: 500, score: 61 });
  const T2 = tok({ address: "0x" + "2".repeat(40), valuationUsd: 400, score: 35 });
  it("a page of the rest joins the store quietly, with its score", () => {
    const { store, by } = load([A]);
    applyTailPage(store, by, [A], [T1, T2], 1_800_000_000_000);
    expect(store.items.length).toBe(3);
    const it = by.get(T1.address)!;
    expect(it.value).toBe("61");
    expect(it.note).toBeNull();
  });
  it("tokens of the rest stay while a sweep still holds them, and go after five minutes once nothing does", () => {
    const { store, by } = load([A]);
    applyTailPage(store, by, [A], [T1], 1_800_000_000_000);
    const keep = new Set([T1.address.toLowerCase()]);
    applySnapshot(store, by, snap([A]), 1_800_000_000_000 + GONE_AFTER_MS * 3, keep);
    expect(by.has(T1.address.toLowerCase())).toBe(true);
    applySnapshot(store, by, snap([A]), 1_800_000_000_000 + GONE_AFTER_MS * 3);
    applySnapshot(store, by, snap([A]), 1_800_000_000_000 + GONE_AFTER_MS * 5);
    expect(by.has(T1.address.toLowerCase())).toBe(false);
  });
  it("the PINRscore filter ranks across the whole set, the rest included", () => {
    const { store, by } = load([A]);
    applyTailPage(store, by, [A], [T1, T2], 1_800_000_000_000);
    const ids = selectAndRank("pinrscore", store.items, 90, 0, "desc").map((r) => store.items.find((i) => i.id === r.id)!.value);
    expect(ids).toEqual(["61", "35", "20"].sort((a, b) => Number(b) - Number(a)));
  });

  it("the social notice follows the feed's social_check and clears when the check lands", () => {
    const A = "0x" + "a".repeat(40);
    const { store, by } = load([tok({ address: A, score: 30, coverage: 20, socialNotChecked: true })]);
    expect(by.get(A)!.socialNotChecked).toBe(true);
    applySnapshot(store, by, snap([tok({ address: A, score: 41, coverage: 24 })]), 1_800_000_005_000);
    expect(by.get(A)!.socialNotChecked).toBe(false);
  });
  it("an early score shows as early; the full score replaces it; neither raises a 'Score moved' line", () => {
    const A = "0xe" + "0".repeat(39);
    const { store, by } = load([tok({ address: A, score: 30, coverage: 20, early: true })]);
    expect(by.get(A)!.early).toBe(true);
    applySnapshot(store, by, snap([tok({ address: A, score: 41, coverage: 24, early: true })]), 1_800_000_005_000);
    expect(by.get(A)!.note).toBeNull();
    applySnapshot(store, by, snap([tok({ address: A, score: 18, coverage: 70 })]), 1_800_000_010_000);
    expect(by.get(A)!.early).toBe(false);
    expect(by.get(A)!.value).toBe("18");
    expect(by.get(A)!.note).toBeNull();
  });

  it("an early file that disappears shows 'no score yet' at once, with no error and no stale number", () => {
    const A = "0xe" + "0".repeat(39);
    const B = "0xf" + "0".repeat(39);
    const { store, by } = load([tok({ address: A, score: 30, coverage: 20, early: true }), tok({ address: B })]);
    applySnapshot(store, by, snap([tok({ address: B })]), 1_800_000_005_000);
    const it = by.get(A)!;
    expect(it.early).toBe(false);
    expect(it.value).toBe("—");
    expect(it.coverage).toBe(0);
    expect(statusLook(it).text).toBe("—");
    // it comes back later with a new early file: a plain re-appearance
    applySnapshot(store, by, snap([tok({ address: A, score: 25, coverage: 16, early: true }), tok({ address: B })]), 1_800_000_010_000);
    expect(by.get(A)!.early).toBe(true);
    expect(by.get(A)!.value).toBe("25");
  });

  it("a full score never carries the early mark", () => {
    const { by } = load([tok()]);
    expect([...by.values()][0]!.early).toBe(false);
  });

  it("a mix counted in trades is flagged as a count; a dollar mix is not", () => {
    const fl = { buy5m: 6, sell5m: 2, buy1h: 40, sell1h: 30, n5m: 8, n1h: 70, lastAt: null, complete: true, asOf: 1 };
    const { by } = load([tok({ flow: { ...fl, basis: "count" } }), tok({ address: "0xd" + "0".repeat(39), flow: fl })]);
    const [a, b] = [...by.values()];
    expect(a!.hasFlow && a!.flowCount).toBe(true);
    expect(b!.hasFlow && b!.flowCount).toBe(false);
  });
});

describe("hiding coins and masking rude names", () => {
  const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const reset = (): void => {
    moderation.unhideAll();
    moderation.setFilterNames(true);
  };
  it("a hidden coin never joins the store, and leaves it when hidden later; no score is touched", () => {
    reset();
    const { store, by } = load([tok({ address: A, name: "Alpha", score: 41 }), tok({ address: B, name: "Beta", score: 52 })]);
    expect(store.items.map((i) => i.name)).toEqual(["Alpha", "Beta"]);
    moderation.hide(A);
    applySnapshot(store, by, snap([tok({ address: A, name: "Alpha", score: 41 }), tok({ address: B, name: "Beta", score: 52 })]), 1_800_000_010_000);
    expect(store.items.map((i) => i.name)).toEqual(["Beta"]);
    expect(store.items[0]!.value).toBe("52");
    expect(by.has(A)).toBe(false);
    reset();
  });
  it("a rude name, its ticker and its picture are masked while the filter is on, and shown again when it is off", () => {
    reset();
    const { store, by } = load([tok({ address: A, name: "Wet Ass Pussy", ticker: "$WAP", imageUrl: "/api/img?a=A" })]);
    const it = store.items[0]!;
    expect([it.name, it.ticker, it.image]).toEqual([MASKED_NAME, MASKED_TICKER, null]);
    expect(it.raw?.name).toBe("Wet Ass Pussy");
    moderation.setFilterNames(false);
    applySnapshot(store, by, snap([tok({ address: A, name: "Wet Ass Pussy", ticker: "$WAP", imageUrl: "/api/img?a=A" })]), 1_800_000_010_000);
    expect([it.name, it.ticker, it.image]).toEqual(["Wet Ass Pussy", "$WAP", "/api/img?a=A"]);
    reset();
  });
  it("a harmless name is left alone", () => {
    reset();
    const { store } = load([tok({ address: B, name: "Document Dog", ticker: "$DOC" })]);
    expect(store.items[0]!.name).toBe("Document Dog");
  });
});

describe("the server's evidence-hub flag on a snapshot", () => {
  it("makes the page follow the flag the feed states, and leaves the switch alone when the snapshot says nothing", () => {
    const snap = (extra: object): FeedSnapshot => ({ contract: "1", mode: "feed", asOfMs: 1, files: 0, tokens: [], problems: [], ...extra }) as FeedSnapshot;
    try {
      const store = { items: [] } as never;
      applySnapshot(store, new Map(), snap({ scoreShown: false }), 1);
      expect(scoreShown()).toBe(false);
      applySnapshot(store, new Map(), snap({}), 2);
      expect(scoreShown()).toBe(false);
      applySnapshot(store, new Map(), snap({ scoreShown: true }), 3);
      expect(scoreShown()).toBe(true);
    } finally {
      setScoreShown(true);
    }
  });
});

describe("the coin's own price line kept for the coin page (urgent chart fix)", () => {
  it("fills the line from a snapshot and keeps it when a later snapshot has none, until a new one comes", () => {
    const store = makeStore();
    const byAddress = new Map<string, Item>();
    const snap = (priceSeries: number[] | null): FeedSnapshot => ({ contract: "1", mode: "feed", asOfMs: 1, files: 1, tokens: [tok({ priceSeries, priceUsd: priceSeries ? priceSeries[priceSeries.length - 1]! : 3 })], problems: [] }) as FeedSnapshot;
    applySnapshot(store, byAddress, snap([1, 2, 3]), 1);
    const it = [...byAddress.values()][0]!;
    expect(it.series).toEqual([1, 2, 3]);
    applySnapshot(store, byAddress, snap(null), 2);
    expect(it.series).toEqual([1, 2, 3]);
    applySnapshot(store, byAddress, snap([2, 3, 4]), 3);
    expect(it.series).toEqual([2, 3, 4]);
  });
});
