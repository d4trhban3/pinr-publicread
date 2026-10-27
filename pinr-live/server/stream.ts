import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { WireToken } from "./translate.ts";

/**
 * Live changes by stream: one Server-Sent Events route, `/api/stream`, that keeps every open page's copy of the token lists
 * current, so the page reads `/api/tokens` and `/api/tokens/rest` once when it opens and never polls while the stream is up.
 *
 * Every rebuild of the first page (at most every 2 s) and of the scored set (every 30 s) is compared with the one before, and only what changed is
 * sent, as one `changes` message:
 *   - `seen`: a coin new to the first page (PumpPortal's socket, the trigger, a pool page), sent whole;
 *   - `score`: a coin whose score, label or early mark changed (a result file landed), only the fields that changed;
 *   - `graduation`: a coin whose launchpad line changed (it left its curve), only the fields that changed;
 *   - `tick`: any other change (price, market cap, chart line, trades), only the fields that changed;
 *   - `gone`: addresses that left the first page;
 *   - `rest` and `restGone`: rows of the scored set that changed or left, sent whole (they change rarely);
 *   - `meta`: the list's own header (mode, time, files, market block) when it changed;
 *   - `trades`: curve coins' own trades from the engine's websocket, each once: address, time, side, dollar price and amount.
 * A field that disappeared is sent as null. Messages carry the id `<boot>.<seq>`; the last 150 are kept, so a page that reconnects (the browser
 * sends the last id it saw) gets what it missed, and one that is too far behind, or from before a restart, gets `reset` and reads the lists again.
 * A comment line every 25 s keeps the stream from looking idle to the tunnel. Standard HTTP and the browser's own EventSource; no library
 * (`BUILD-OR-BUY-2026-10-18-sse.md`).
 */
export type Row = Partial<WireToken> & { address: string };
export interface Changes {
  boot: string;
  seq: number;
  seen: Row[];
  score: Row[];
  graduation: Row[];
  tick: Row[];
  gone: string[];
  rest: Row[];
  restGone: string[];
  meta?: Record<string, unknown>;
  trades?: StreamTrade[];
}
export interface StreamTrade {
  address: string;
  atMs: number;
  side: "buy" | "sell";
  priceUsd: number;
  usd: number;
}

const KEEP = 150;
const PING_MS = 25_000;
export const MAX_CLIENTS = 1000;
const SCORE_KEYS = ["score", "noScoreLabel", "early", "socialNotChecked", "coverage"];

/** Each field of a row as its JSON text, so two rebuilds compare field by field. */
const fieldsOf = (r: Row): Map<string, string> => new Map(Object.entries(r).map(([k, v]) => [k, JSON.stringify(v ?? null)]));

/**
 * Each row's text, worked out once per row object: the tile hub and the full hub are handed the same rest list (about 50,000 rows on the server),
 * and the text was worked out twice for every row at each rebuild (the profile on 2026-10-25 put it among the server's top costs).
 */
const rowTexts = new WeakMap<object, string>();
function rowText(r: object): string {
  let t = rowTexts.get(r);
  if (t === undefined) {
    t = JSON.stringify(r);
    rowTexts.set(r, t);
  }
  return t;
}

export class StreamHub {
  readonly boot = randomBytes(4).toString("hex");
  seq = 0;
  private first: Map<string, Map<string, string>> | null = null;
  private rest: Map<string, string> | null = null;
  private meta = "";
  private log: { seq: number; text: string }[] = [];
  private clients = new Set<ServerResponse>();
  private ping: ReturnType<typeof setInterval> | undefined;
  stat = { messages: 0, bytes: 0, resets: 0, refused: 0 };

  constructor(private max = MAX_CLIENTS) {}

  get size(): number {
    return this.clients.size;
  }

  private empty(): Changes {
    return { boot: this.boot, seq: this.seq, seen: [], score: [], graduation: [], tick: [], gone: [], rest: [], restGone: [] };
  }

  /** A first-page rebuild: what changed since the last one goes out. The first call only records the starting point. Returns the seq the rows are at. */
  publishFirst(rows: readonly Row[], meta: Record<string, unknown>): number {
    const next = new Map(rows.map((r) => [r.address.toLowerCase(), fieldsOf(r)]));
    const metaText = JSON.stringify(meta);
    if (!this.first) {
      this.first = next;
      this.meta = metaText;
      return this.seq;
    }
    const c = this.empty();
    for (const r of rows) {
      const key = r.address.toLowerCase();
      const now = next.get(key)!;
      const was = this.first.get(key);
      if (!was) {
        c.seen.push(r);
        continue;
      }
      const patch: Record<string, unknown> = { address: r.address };
      let changed = false;
      for (const [k, v] of now) if (was.get(k) !== v) ((patch[k] = JSON.parse(v)), (changed = true));
      for (const k of was.keys()) if (!now.has(k)) ((patch[k] = null), (changed = true));
      if (!changed) continue;
      if (SCORE_KEYS.some((k) => k in patch)) c.score.push(patch as Row);
      else if ("launchpad" in patch) c.graduation.push(patch as Row);
      else c.tick.push(patch as Row);
    }
    for (const key of this.first.keys()) if (!next.has(key)) c.gone.push(key);
    if (metaText !== this.meta) c.meta = meta;
    this.first = next;
    this.meta = metaText;
    if (c.seen.length || c.score.length || c.graduation.length || c.tick.length || c.gone.length || c.meta) this.send(c);
    return this.seq;
  }

  /** A rebuild of the scored set: changed and departed rows go out whole. The first call only records the starting point. */
  publishRest(rows: readonly Row[]): void {
    const next = new Map(rows.map((r) => [r.address.toLowerCase(), rowText(r)]));
    if (!this.rest) {
      this.rest = next;
      return;
    }
    const c = this.empty();
    for (const r of rows) {
      const key = r.address.toLowerCase();
      if (this.rest.get(key) !== next.get(key)) c.rest.push(r);
    }
    for (const key of this.rest.keys()) if (!next.has(key)) c.restGone.push(key);
    this.rest = next;
    if (c.rest.length || c.restGone.length) this.send(c);
  }

  /** Curve coins' new trades: one message, each trade once. */
  publishTrades(trades: readonly StreamTrade[]): void {
    if (!trades.length) return;
    this.send({ ...this.empty(), trades: [...trades] });
  }

  private send(c: Changes): void {
    c.seq = ++this.seq;
    const text = `id: ${this.boot}.${c.seq}\nevent: changes\ndata: ${JSON.stringify(c)}\n\n`;
    this.log.push({ seq: c.seq, text });
    if (this.log.length > KEEP) this.log.shift();
    this.stat.messages++;
    for (const res of this.clients) this.write(res, text);
  }

  private write(res: ServerResponse, text: string): void {
    try {
      res.write(text);
      this.stat.bytes += Buffer.byteLength(text);
    } catch {
      this.clients.delete(res);
    }
  }

  /** Where a page is: from the browser's Last-Event-ID on a reconnect, else from `?boot=&since=` (the lists it just read). Null when unknown. */
  static position(req: IncomingMessage, url: URL): { boot: string; seq: number } | null {
    const last = req.headers["last-event-id"];
    const fromHeader = typeof last === "string" ? /^([0-9a-f]{8})\.(\d{1,12})$/.exec(last) : null;
    if (fromHeader) return { boot: fromHeader[1]!, seq: Number(fromHeader[2]) };
    const boot = url.searchParams.get("boot") ?? "";
    const since = url.searchParams.get("since") ?? "";
    return /^[0-9a-f]{8}$/.test(boot) && /^\d{1,12}$/.test(since) ? { boot, seq: Number(since) } : null;
  }

  /** Open one page's stream: what it missed, or `reset` when that cannot be given, then every change as it happens. */
  attach(req: IncomingMessage, res: ServerResponse, from: { boot: string; seq: number } | null): void {
    if (this.clients.size >= this.max) {
      this.stat.refused++;
      // The page falls back to the decision-200 polls and tries again later.
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return void res.end('{"error":"stream full"}');
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 5000\n\n");
    const oldest = this.log[0]?.seq ?? this.seq + 1;
    const fits = from !== null && from.boot === this.boot && from.seq <= this.seq && from.seq >= oldest - 1;
    if (!fits) {
      this.stat.resets++;
      res.write(`event: reset\ndata: ${JSON.stringify({ boot: this.boot, seq: this.seq })}\n\n`);
    } else for (const m of this.log) if (m.seq > from.seq) res.write(m.text);
    this.clients.add(res);
    const drop = (): void => void this.clients.delete(res);
    req.on("close", drop);
    res.on("error", drop);
    if (!this.ping) this.ping = setInterval(() => this.keepAlive(), PING_MS);
  }

  keepAlive(): void {
    for (const res of this.clients) this.write(res, ": ping\n\n");
  }

  stats(): { clients: number; seq: number; messages: number; bytes: number; resets: number; refused: number } {
    return { clients: this.clients.size, seq: this.seq, ...this.stat };
  }
}
