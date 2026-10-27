import { CHART_N, HIST_N, liveImportance, SIM, type FlagKind, type Feed, type Item, type Store } from "../world/model";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `buy` is the share of trades that become buys while this event is fresh (0.5 = even). */
const EVENTS: { text: string; scoreSign: 1 | -1 | 0; buy: number }[] = [
  { text: "Score moved", scoreSign: 1, buy: 0.78 },
  { text: "Score moved", scoreSign: -1, buy: 0.22 },
  { text: "Flag raised", scoreSign: 0, buy: 0.2 },
  { text: "Volume surge", scoreSign: 0, buy: 0.5 },
  { text: "Large buy", scoreSign: 0, buy: 0.95 },
  { text: "Large sell", scoreSign: 0, buy: 0.05 },
];

/** TESTS ONLY (the app itself shows no simulated data any more). Random, clearly fake data. Seeded so every run of the app looks the same while we tune it. */
export class SimFeed implements Feed {
  private rnd: () => number;
  private untilEvent = 0.8;
  private untilCheck = 3;
  private started = false;

  constructor(seed = 11) {
    this.rnd = mulberry32(seed);
  }

  private clampScore(n: number): number {
    // Rules: a token never scores 0 and never 100. Clamp to 1..99.
    return Math.min(99, Math.max(1, Math.round(n)));
  }

  /** Mostly well covered, about 1 in 6 thin, and two with nothing loaded. */
  private coverageFor(i: number): number {
    if (i === 17 || i === 83) return 0;
    return this.rnd() < 0.17 ? Math.round(12 + this.rnd() * 40) : Math.round(62 + this.rnd() * 38);
  }

  /** Made-up but believable token names, all different: two syllables each. The screen says SIMULATED DATA. */
  private makeNames(n: number): { name: string; ticker: string }[] {
    const a = ["Zo", "Ke", "Mi", "Lu", "Ta", "Vo", "Ne", "Ra", "Si", "Qu", "Bo", "Fa", "Hu", "Jo", "Wy", "Ex"];
    const b = ["rin", "vo", "lax", "dar", "mus", "pho", "lin", "ron", "ta", "nix", "gus", "kel"];
    const all: string[] = [];
    for (const x of a) for (const y of b) all.push(x + y);
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(this.rnd() * (i + 1));
      [all[i], all[j]] = [all[j]!, all[i]!];
    }
    return all.slice(0, n).map((w) => ({ name: w, ticker: `$${w.toUpperCase()}` }));
  }

  /** A made-up 24h price path: starts at 1, ends where the 24h change says, wanders in between (a bridge, so it always lands). */
  private makeChart(change: number): number[] {
    const n = CHART_N;
    const end = Math.max(0.001, 1 + change / 100);
    const walk: number[] = [0];
    for (let i = 1; i < n; i++) walk.push(walk[i - 1]! + (this.rnd() + this.rnd() + this.rnd() - 1.5));
    const last = walk[n - 1]!;
    const bend = 0.6 + this.rnd() * 1.1;
    // Wiggle scales with the size of the move, so a +5,000% run is as jagged as it should be and a +3% day is calm.
    const vol = 0.03 + 0.11 * Math.min(3, Math.abs(Math.log(end)));
    return walk.map((w, i) => {
      const t = i / (n - 1);
      return Math.exp(Math.log(end) * Math.pow(t, bend) + (w - t * last) * vol);
    });
  }

  private seed(store: Store): void {
    const names = this.makeNames(SIM.tokens);
    for (let i = 0; i < SIM.tokens; i++) {
      // Most tokens are quiet; a few matter a lot.
      const base = 0.12 + Math.pow(this.rnd(), 2.2) * 0.62;
      const it: Item = {
        id: store.nextId++,
        name: names[i]!.name,
        ticker: names[i]!.ticker,
        image: null,
        detail: "Simulated token",
        early: false,
        value: String(this.clampScore(8 + this.rnd() * 86)),
        // Most tokens have most readings in; a few are thin, and a couple have nothing yet.
        coverage: this.coverageFor(i),
        base,
        spike: 0,
        note: null,
        noteSeq: 0,
        noteLeft: 0,
        // No invented past: the ribbon starts flat at the card's resting importance.
        hist: new Array<number>(HIST_N).fill(base),
        histAge: 0,
        buyShare: 0.5, // set just below, once the resting lean is known
        restBuy: 0.5,
        evSide: 1,
        status: "ok",
        flagKind: null,
        statusLeft: 0,
        // About 1 in 6 tokens launched within the hour; the rest are older.
        ageMin: this.rnd() < 0.17 ? Math.round(2 + this.rnd() * 56) : Math.round(90 + this.rnd() * 20000),
        // Start with a spread of recent movement so Movers has something to rank from the first second.
        moved: Math.round((this.rnd() - 0.5) * Math.pow(this.rnd(), 1.5) * 60),
        mcap: 0,
        ath: NaN,
        volume24h: 0,
        change24h: 0,
        chart: [],
        hasFlow: true,
        address: null,
        tag: "",
        changeWindowH: 24,
        priceSource: "",
        priceUsd: NaN,
        liquidity: NaN,
        quotePair: "",
        findings: [],
      };
      // SIMULATED market figures: heavier tokens are bigger; moves have a long tail (a few huge, most small).
      it.mcap = Math.round(30_000 * Math.pow(100, this.rnd()) * (0.5 + base * 2));
      it.volume24h = Math.round(it.mcap * (0.15 + this.rnd() * 4));
      // Gains can be enormous; a fall can never pass -100%.
      const up = this.rnd() < 0.55;
      it.change24h = Math.round((up ? 2 + Math.pow(this.rnd(), 3) * (it.ageMin < 60 ? 9000 : 900) : -(2 + Math.pow(this.rnd(), 1.6) * 88)) * 10) / 10;
      it.chart = this.makeChart(it.change24h);
      // Every token has its own long-run lean, so the field shows a mix of buyers and sellers from the start.
      it.restBuy = Math.min(0.78, Math.max(0.22, 0.5 + (this.rnd() - 0.5) * 0.7));
      it.buyShare = it.restBuy;
      store.items.push(it);
    }
    // A handful are proven BOT / RUG / VAMP (labelled, no score), and a few have a failed reading.
    const kinds: FlagKind[] = ["RUG", "BOT", "VAMP", "RUG", "BOT", "RUG", "VAMP"];
    kinds.forEach((k, n) => {
      const it = store.items[6 + n * 19]!;
      it.status = "flag";
      it.flagKind = k;
    });
    [11, 40, 97].forEach((n, k) => {
      const it = store.items[n]!;
      it.status = "error";
      it.statusLeft = 20 + k * 9; // each retries after its own wait
    });
  }

  tick(store: Store, dt: number): void {
    if (!this.started) {
      this.started = true;
      this.seed(store);
    }
    const decay = Math.pow(0.5, dt / SIM.spikeHalfLife);
    const lean = Math.pow(0.5, dt / SIM.buyShareHalfLife);
    const movedDecay = Math.pow(0.5, dt / SIM.movedHalfLife);
    for (const it of store.items) {
      it.spike *= decay;
      it.buyShare = it.restBuy + (it.buyShare - it.restBuy) * lean;
      it.moved *= movedDecay;
      it.ageMin += dt / 60;
      it.histAge += dt;
      while (it.histAge >= SIM.histEvery) {
        it.histAge -= SIM.histEvery;
        it.hist.shift();
        it.hist.push(liveImportance(it));
      }
      if (it.noteLeft > 0) {
        it.noteLeft -= dt;
        if (it.noteLeft <= 0) it.note = null;
      }
    }

    // PINRbot keeps reading tokens: now and then one goes into "checking", then comes back with fresh numbers
    // (or a failed reading); a failed reading retries after a while. Flagged tokens are frozen: no more data is spent on them.
    for (const it of store.items) {
      if (it.status !== "checking" && it.status !== "error") continue;
      it.statusLeft -= dt;
      if (it.statusLeft > 0) continue;
      if (it.status === "error") {
        it.status = "checking";
        it.statusLeft = 3 + this.rnd() * 2;
      } else if (this.rnd() < 0.15) {
        it.status = "error";
        it.statusLeft = 18 + this.rnd() * 10;
      } else {
        it.status = "ok";
        // A thin token usually comes back with more of its readings loaded.
        if (it.coverage < 55) it.coverage = Math.min(100, it.coverage + Math.round(15 + this.rnd() * 35));
      }
    }
    this.untilCheck -= dt;
    if (this.untilCheck <= 0) {
      this.untilCheck = 2.2 + this.rnd() * 2.6;
      const pool = store.items.filter((i) => i.status === "ok");
      const pick = pool[Math.floor(this.rnd() * pool.length)];
      if (pick) {
        pick.status = "checking";
        pick.statusLeft = 3.5 + this.rnd() * 2.5;
      }
    }

    this.untilEvent -= dt;
    if (this.untilEvent > 0) return;
    this.untilEvent = SIM.eventEvery * (0.4 + this.rnd() * 1.2);
    const tok = store.items[Math.floor(this.rnd() * store.items.length)];
    if (!tok || tok.status !== "ok") return; // flagged, scanning and failed tokens stay quiet
    const ev = EVENTS[Math.floor(this.rnd() * EVENTS.length)]!;
    tok.spike = Math.min(0.75, tok.spike + SIM.spikeMin + this.rnd() * (SIM.spikeMax - SIM.spikeMin));
    let text = ev.text;
    if (ev.scoreSign !== 0) {
      const mag = Math.round(2 + this.rnd() * 16);
      tok.value = String(this.clampScore(Number(tok.value) + ev.scoreSign * mag));
      tok.moved += ev.scoreSign * mag;
      text = `${ev.text} ${ev.scoreSign > 0 ? "+" : "−"}${mag}`;
    }
    tok.buyShare = ev.buy;
    // A buy-heavy event nudges the simulated price up, a sell-heavy one down.
    tok.change24h = Math.max(-99.9, Math.round((tok.change24h + (ev.buy - 0.5) * (1 + this.rnd() * 3)) * 10) / 10);
    tok.chart[tok.chart.length - 1] = Math.max(0.001, 1 + tok.change24h / 100);
    tok.mcap = Math.round(tok.mcap * (1 + (ev.buy - 0.5) * 0.02));
    // Red flags and selling are mandarin; good news and buying are lime.
    tok.evSide = ev.buy >= 0.5 ? 1 : 0;
    tok.note = text;
    tok.noteSeq++;
    tok.noteLeft = SIM.noteSeconds;
  }
}
