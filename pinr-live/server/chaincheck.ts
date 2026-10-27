import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { USER_AGENT } from "./pumpfun.ts";

/**
 * The creator check for a Pump.fun coin: who made it, read from Pump.fun's own coin record (`coins-v2/<mint>`, field `creator`; free, no
 * key; read, do not parse the chain ourselves). A VAMP is only a copy if its creator is a different wallet from the
 * original's. Reads are one coin per request, sparing (the app's whole Pump.fun budget is 17 requests a minute, see DATA-LINKING.md),
 * remembered forever (a coin's creator does not change), and a coin whose record cannot be read is simply "not checked", never guessed.
 */
/** Asks Pump.fun for one coin's record: its creator wallet, null where the record has none or Pump.fun does not know the coin. */
export type CreatorRpc = (mint: string) => Promise<{ status: "ok"; creator: string | null } | { status: "limited" } | { status: "error" }>;

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function pumpfunCreatorRpc(base = "https://frontend-api-v3.pump.fun/coins-v2"): CreatorRpc {
  return async (mint) => {
    try {
      const res = await fetch(`${base}/${mint}`, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(12_000) });
      if (res.status === 429) return { status: "limited" };
      if (res.status === 404) return { status: "ok", creator: null };
      if (!res.ok) return { status: "error" };
      const body = (await res.json()) as { mint?: unknown; creator?: unknown } | null;
      if (!body || typeof body !== "object" || body.mint !== mint) return { status: "error" };
      return { status: "ok", creator: typeof body.creator === "string" && WALLET.test(body.creator) ? body.creator : null };
    } catch {
      return { status: "error" };
    }
  };
}

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class ChainCreators {
  /** coin -> creator wallet from Pump.fun's record, or null = the record could not be read (asked again after a day) */
  private known = new Map<string, { creator: string | null; at: number }>();
  private pausedUntil = 0;
  private dirty = false;
  stat = { reads: 0, errors: 0 };

  constructor(
    private rpc: CreatorRpc = pumpfunCreatorRpc(),
    private now: () => number = Date.now,
  ) {}

  /** The recorded creator for a coin, "unreadable" when it was tried and failed, or undefined when never tried. */
  creator(mint: string): string | null | undefined {
    const e = this.known.get(mint);
    return e === undefined ? undefined : e.creator;
  }
  wants(mint: string): boolean {
    const e = this.known.get(mint);
    return e === undefined || (e.creator === null && this.now() - e.at > 24 * 3600_000);
  }

  /** Read the creator of the first coin (one request per call). Returns false when Pump.fun is limiting us (so the caller waits). */
  async read(items: { mint: string }[]): Promise<boolean> {
    if (this.now() < this.pausedUntil) return false;
    const it = items.find((i) => MINT.test(i.mint) && this.wants(i.mint));
    if (!it) return true;
    this.stat.reads++;
    const r = await this.rpc(it.mint);
    if (r.status === "limited") {
      this.pausedUntil = this.now() + 60_000;
      return false;
    }
    if (r.status === "error") {
      this.stat.errors++;
      this.pausedUntil = this.now() + 15_000;
      return false;
    }
    this.known.set(it.mint, { creator: r.creator, at: this.now() });
    this.dirty = true;
    return true;
  }

  saveTo(file: string): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, known: [...this.known] }));
      renameSync(tmp, file);
    } catch {
      /* a failed save only means these are read again */
    }
  }
  loadFrom(file: string): number {
    try {
      if (!existsSync(file)) return 0;
      const doc = JSON.parse(readFileSync(file, "utf8")) as { v?: number; known?: [string, { creator: string | null; at: number }][] };
      if (doc.v !== 1 || !Array.isArray(doc.known)) return 0;
      for (const [k, v] of doc.known) if (typeof k === "string" && v && typeof v.at === "number") if (!this.known.has(k)) this.known.set(k, v);
      return this.known.size;
    } catch {
      return 0;
    }
  }
}
