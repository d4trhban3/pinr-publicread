import type { PumpCoin, PumpfunUniverse } from "./pumpfun.ts";
import { dexscreener, type QuoteFetch } from "./quotes.ts";
import { visibleText } from "../src/world/visibletext.ts";
import { isPumpCurve, pumpCurveOf } from "./pumpcurve.ts";

/**
 * PumpPortal's free data socket: every new Pump.fun and bonk.fun coin the moment it is created, and every graduation.
 *
 * ONE connection for the whole of PINR (this feed server, on the server), with only the two free subscriptions: `subscribeNewToken` and
 * `subscribeMigration`. The metered trade streams (SOL per message) are never sent. PumpPortal's written rules: one connection, at most 200
 * subscribe messages a second, repeat offenders banned for an hour, the socket may drop at any time. So: two subscribe messages per connection,
 * a reconnect that waits longer after each failure (2 s doubling to 2 minutes, reset once a connection has stayed up a minute), and a watchdog
 * that reconnects when nothing has arrived for two minutes (Pump.fun makes a coin every few seconds, so silence means a dead socket) or when a
 * handshake has not been answered in 30 s. It is off unless `PINR_PUMPPORTAL=on` (the server's `.env` only).
 *
 * The event shape was read on one short test connection (2026-10-18, no key needed for the free methods): a create carries `mint`, `name`,
 * `symbol`, `traderPublicKey` (the creator), `bondingCurveKey`, `marketCapSol`, `uri` (the metadata document) and `pool` ("pump", "bonk");
 * a graduation carries `mint`, `txType: "migrate"` and `pool` ("pump-amm"). There is no time in either: the time PINR received it is used,
 * within about a second of creation. The market cap is in SOL; it is shown in dollars only with a SOL price read from DexScreener (once a
 * minute), and a coin that arrives before any SOL price is known waits for it, never priced by a guess. The picture is not read here (it
 * would be one more read per coin); the coin's own record or GeckoTerminal's pool gives it later, and until then it is missing.
 */
export const PUMPPORTAL_URL = "wss://pumpportal.fun/api/data";
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOL_MINT = "So11111111111111111111111111111111111111112";
/** A Pump.fun or bonk.fun coin's whole supply: one billion tokens, fixed on the curve. */
const SUPPLY = 1_000_000_000;
const SOL_EVERY_MS = 60_000;
/** A SOL price older than this is not used: the coins wait for a fresh one. */
const SOL_STALE_MS = 10 * 60_000;
const BACKOFF_FIRST_MS = 2_000;
const BACKOFF_MAX_MS = 120_000;
const STABLE_MS = 60_000;
const SILENT_MS = 120_000;
/** A handshake not answered in this long is given up and tried again. */
const HANDSHAKE_MS = 30_000;
const PENDING_MAX = 500;

export type Launchpad = "pump" | "bonk";

/** The minimal socket the feed needs (Node's own WebSocket in the server, a fake in tests). */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export type SocketMaker = (url: string) => SocketLike;

/** A create event, before it has a dollar figure. */
export interface NewCoin {
  mint: string;
  name: string;
  symbol: string;
  creator: string | null;
  curve: string | null;
  capSol: number;
  launchpad: Launchpad;
  atMs: number;
}

const clean = (v: unknown, max: number): string => (typeof v === "string" ? visibleText(v).slice(0, max) : "");
const addr = (v: unknown): string | null => (typeof v === "string" && MINT.test(v) ? v : null);

/** One socket message into what it says: a new coin, a graduation, PumpPortal's own notice, or nothing usable. */
export function parseEvent(data: unknown, atMs: number): { kind: "create"; coin: NewCoin } | { kind: "migrate"; mint: string } | { kind: "notice" } | { kind: "other" } {
  let j: unknown;
  try {
    j = JSON.parse(typeof data === "string" ? data : String(data));
  } catch {
    return { kind: "other" };
  }
  if (typeof j !== "object" || j === null) return { kind: "other" };
  const r = j as Record<string, unknown>;
  if (typeof r.message === "string" && r.mint === undefined) return { kind: "notice" };
  const mint = addr(r.mint);
  if (!mint) return { kind: "other" };
  if (r.txType === "migrate") return { kind: "migrate", mint };
  if (r.txType !== "create") return { kind: "other" };
  const launchpad: Launchpad | null = r.pool === "pump" ? "pump" : r.pool === "bonk" ? "bonk" : null;
  const capSol = typeof r.marketCapSol === "number" && Number.isFinite(r.marketCapSol) && r.marketCapSol > 0 ? r.marketCapSol : null;
  if (!launchpad || capSol === null) return { kind: "other" };
  return { kind: "create", coin: { mint, name: clean(r.name, 60), symbol: clean(r.symbol, 24), creator: addr(r.traderPublicKey), curve: addr(r.bondingCurveKey), capSol, launchpad, atMs } };
}

/** A new coin as a pool coin, priced with a known SOL price. Its figures are labelled PumpPortal's (the SOL market cap) and read at receipt. */
export function toPumpCoin(c: NewCoin, solUsd: number): PumpCoin {
  const capUsd = c.capSol * solUsd;
  return {
    mint: c.mint,
    name: c.name,
    symbol: c.symbol,
    image: null,
    creator: c.creator,
    createdMs: c.atMs,
    lastTradeMs: null,
    capUsd,
    priceUsd: capUsd / SUPPLY,
    athCapUsd: null,
    graduated: false,
    twitter: null,
    telegram: null,
    website: null,
    seenMs: c.atMs,
    curve: c.curve,
    figSource: "PumpPortal",
    figAtMs: c.atMs,
    launchpad: c.launchpad,
  };
}

export interface PumpPortalStats {
  source: string;
  connected: boolean;
  connects: number;
  drops: number;
  created: number;
  bonk: number;
  graduated: number;
  waitingForSolPrice: number;
  solUsd: number | null;
  solAtMs: number | null;
  lastEventAgeS: number | null;
}

export class PumpPortalFeed {
  private ws: SocketLike | null = null;
  private retryMs = BACKOFF_FIRST_MS;
  private openedAt = 0;
  private startedAt = 0;
  private lastEventMs = 0;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watch: ReturnType<typeof setInterval> | undefined;
  private solTimer: ReturnType<typeof setInterval> | undefined;
  private sol: { usd: number; atMs: number } | null = null;
  private pending = new Map<string, NewCoin>();
  private stat = { connects: 0, drops: 0, created: 0, bonk: 0, graduated: 0, curveFixed: 0, notALaunch: 0 };
  /** Pump.fun creates whose curve did not match, waiting for their one check on chain (at most CHECK_QUEUE, CHECK_AT_ONCE at a time). */
  private checking = new Map<string, NewCoin>();
  private inFlight = 0;

  constructor(
    private universe: PumpfunUniverse,
    private makeSocket: SocketMaker = (url) => new WebSocket(url) as unknown as SocketLike,
    private get?: QuoteFetch,
    private now: () => number = Date.now,
    /** Whether an address holds a Pump.fun account: true, false, or null when the check could not be made. Without one, an unmatched create is dropped. */
    private curveExists?: CurveCheck,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    void this.readSol();
    this.solTimer = setInterval(() => void this.readSol(), SOL_EVERY_MS);
    this.watch = setInterval(() => this.checkSilence(), 15_000);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.watch);
    clearInterval(this.solTimer);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  }

  /** Opens the one connection (never a second while one is open) and subscribes to the two free event kinds. */
  connect(): void {
    if (this.stopped || this.ws) return;
    let ws: SocketLike;
    try {
      ws = this.makeSocket(PUMPPORTAL_URL);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    this.startedAt = this.now();
    this.stat.connects++;
    ws.onopen = () => {
      this.openedAt = this.now();
      this.lastEventMs = this.now();
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
    };
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onerror = () => {
      /* the close that follows decides what happens */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stat.drops++;
      // A connection that stayed up a minute was healthy: start the wait again from the shortest.
      if (this.openedAt && this.now() - this.openedAt >= STABLE_MS) this.retryMs = BACKOFF_FIRST_MS;
      this.openedAt = 0;
      this.retry();
    };
  }

  private retry(): void {
    if (this.stopped) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(BACKOFF_MAX_MS, this.retryMs * 2);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  /** Nothing for two minutes on an open socket, or a handshake unanswered for 30 s: close it, and the reconnect follows. */
  checkSilence(): void {
    const silent = this.openedAt > 0 && this.now() - this.lastEventMs > SILENT_MS;
    const stuck = this.openedAt === 0 && this.now() - this.startedAt > HANDSHAKE_MS;
    const ws = this.ws;
    if (ws && (silent || stuck)) {
      try {
        ws.close();
      } catch {
        /* closing anyway */
      }
      // A socket that closes at once runs its own close handler, which clears `this.ws`: use the one in hand, never `this.ws` again (a crash loop on 2026-10-23).
      ws.onclose?.();
    }
  }

  onMessage(data: unknown): void {
    this.lastEventMs = this.now();
    const ev = parseEvent(data, this.now());
    if (ev.kind === "create") {
      this.stat.created++;
      if (ev.coin.launchpad === "bonk") this.stat.bonk++;
      // A coin already held with a launch over a minute older is not new: a create naming it is not its launch (PUMP as "Mega Jack").
      const had = this.universe.coin(ev.coin.mint);
      if (had && had.createdMs < ev.coin.atMs - 60_000) {
        this.stat.notALaunch++;
        return;
      }
      // A Pump.fun create must name the mint's own curve. PumpPortal sometimes sends another coin's curve: the mint's own is then checked once on chain.
      if (ev.coin.launchpad === "pump" && !(ev.coin.curve && isPumpCurve(ev.coin.mint, ev.coin.curve))) {
        this.check(ev.coin);
        return;
      }
      this.accept(ev.coin);
    } else if (ev.kind === "migrate") {
      this.stat.graduated++;
      this.pending.delete(ev.mint);
      this.universe.graduate(ev.mint);
    }
  }

  /** A create taken: priced when a SOL price is known, otherwise held until one is. */
  private accept(coin: NewCoin): void {
    const sol = this.solUsd();
    if (sol === null) {
      this.pending.set(coin.mint, coin);
      if (this.pending.size > PENDING_MAX) this.pending.delete(this.pending.keys().next().value!);
    } else this.universe.ingest([toPumpCoin(coin, sol)]);
  }

  /** One unmatched Pump.fun create: kept with its own curve when that curve is a Pump.fun account, dropped when it is not (or cannot be read). */
  private check(coin: NewCoin): void {
    const own = pumpCurveOf(coin.mint);
    if (!own || !this.curveExists || this.checking.has(coin.mint) || this.checking.size >= CHECK_QUEUE) {
      this.stat.notALaunch++;
      return;
    }
    this.checking.set(coin.mint, { ...coin, curve: own });
    this.drain();
  }

  private drain(): void {
    while (this.inFlight < CHECK_AT_ONCE && this.checking.size) {
      const [mint, coin] = this.checking.entries().next().value!;
      this.checking.delete(mint);
      this.inFlight++;
      void this.curveExists!(coin.curve!)
        .catch(() => null)
        .then((yes) => {
          this.inFlight--;
          if (yes === true) {
            this.stat.curveFixed++;
            this.accept(coin);
          } else this.stat.notALaunch++;
          if (!this.stopped) this.drain();
        });
    }
  }

  /** The SOL price, when one fresh enough is known. */
  solUsd(): number | null {
    return this.sol && this.now() - this.sol.atMs < SOL_STALE_MS ? this.sol.usd : null;
  }

  /** SOL's dollar price from DexScreener's deepest pair (free, 300 a minute; once a minute here), then the coins that waited for it. */
  async readSol(): Promise<void> {
    try {
      const ans = await dexscreener.fetch("solana", [SOL_MINT], this.get ?? defaultGet);
      const q = ans.status === "ok" ? ans.quotes.get(SOL_MINT.toLowerCase()) : undefined;
      if (q && q.priceUsd > 0) this.sol = { usd: q.priceUsd, atMs: this.now() };
    } catch {
      /* the last good price stays until it is stale */
    }
    const sol = this.solUsd();
    if (sol !== null && this.pending.size) {
      this.universe.ingest([...this.pending.values()].map((c) => toPumpCoin(c, sol)));
      this.pending.clear();
    }
  }

  stats(): PumpPortalStats {
    return {
      source: "PumpPortal",
      connected: !!this.ws && this.openedAt > 0,
      ...this.stat,
      waitingForSolPrice: this.pending.size,
      solUsd: this.sol?.usd ?? null,
      solAtMs: this.sol?.atMs ?? null,
      lastEventAgeS: this.lastEventMs ? Math.max(0, Math.round((this.now() - this.lastEventMs) / 1000)) : null,
    };
  }
}

/** Whether an address holds an account owned by the Pump.fun program. */
export type CurveCheck = (address: string) => Promise<boolean | null>;
const CHECK_QUEUE = 50;
const CHECK_AT_ONCE = 2;
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
/** The public Solana node (keyless, free; the engine reads it too): one getAccountInfo, no data, for a create whose curve did not match. */
export const publicCurveCheck: CurveCheck = async (address) => {
  const r = await fetch("https://api.mainnet-beta.solana.com", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "PINR-live/1.0 (read-only)" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { result?: { value?: { owner?: string } | null } };
  if (!j.result) return null;
  return j.result.value?.owner === PUMP_PROGRAM;
};

const defaultGet: QuoteFetch = (url) => fetch(url, { headers: { accept: "application/json", "user-agent": "PINR-live/1.0 (read-only market data)" }, signal: AbortSignal.timeout(10_000) });
