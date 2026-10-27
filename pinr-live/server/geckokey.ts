import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Fetcher } from "./market.ts";

/**
 * The operator's free CoinGecko Demo key for the onchain data (GeckoTerminal's own, at CoinGecko's address).
 * The Demo plan has its own allowance, not the home address's (CoinGecko's pricing page, read 2026-10-25: 100 calls a minute, 10,000 a month), so
 * only a viewer's chart read goes through it, at most PER_DAY calls a day (about 9,000 a month) and MONTH_CAP a month, counted in a file so a restart
 * cannot reset them. Past either, or while it rests after a refusal, the free route answers as before. The key itself is never logged or shown.
 */
export const DEMO_API = "https://api.coingecko.com/api/v3/onchain";
export const DEMO_HEADER = "x-cg-demo-api-key";
export const PER_DAY = 300;
export const MONTH_CAP = 9_500;
export const KEY_REST_MS = 60_000;

/** The key from the environment, else from the engine's own .env; null when there is none. */
export function demoKeyFrom(envValue: string | undefined, engineEnvFile: string): string | null {
  const clean = (v: string | undefined): string | null => {
    const s = (v ?? "").trim().replace(/^["']|["']$/g, "");
    return s ? s : null;
  };
  if (clean(envValue)) return clean(envValue);
  try {
    const m = /^COINGECKO_API=(.*)$/m.exec(readFileSync(engineEnvFile, "utf8"));
    return clean(m?.[1]);
  } catch {
    return null;
  }
}

export class GeckoKeyRoute {
  private day = "";
  private month = "";
  private today = 0;
  private thisMonth = 0;
  private restUntil = 0;
  calls = 0;
  refused = 0;

  constructor(
    readonly fetch: Fetcher,
    readonly api: string = DEMO_API,
    private file: string | null = null,
    private now: () => number = Date.now,
    private perDay = PER_DAY,
    private monthCap = MONTH_CAP,
  ) {
    try {
      if (file && existsSync(file)) {
        const d = JSON.parse(readFileSync(file, "utf8")) as { day?: string; today?: number; month?: string; thisMonth?: number };
        this.day = String(d.day ?? "");
        this.today = Number(d.today) || 0;
        this.month = String(d.month ?? "");
        this.thisMonth = Number(d.thisMonth) || 0;
      }
    } catch {
      /* a damaged count file starts from zero */
    }
  }

  private roll(): void {
    const iso = new Date(this.now()).toISOString();
    if (iso.slice(0, 10) !== this.day) (this.day = iso.slice(0, 10)), (this.today = 0);
    if (iso.slice(0, 7) !== this.month) (this.month = iso.slice(0, 7)), (this.thisMonth = 0);
  }

  /** May a viewer's chart read go through the key now? */
  mayCall(): boolean {
    this.roll();
    return this.now() >= this.restUntil && this.today < this.perDay && this.thisMonth < this.monthCap;
  }

  /** One call made through the key (counted whatever the answer, so the month can never run over). */
  used(): void {
    this.roll();
    this.today++;
    this.thisMonth++;
    this.calls++;
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ day: this.day, today: this.today, month: this.month, thisMonth: this.thisMonth }));
    } catch {
      /* the count is kept in memory */
    }
  }

  /** The key's allowance said "too many": the free route answers for a minute. */
  rest(): void {
    this.refused++;
    this.restUntil = this.now() + KEY_REST_MS;
  }

  stats(): { today: number; perDay: number; month: number; monthCap: number; calls: number; refused: number; restingS: number } {
    this.roll();
    return { today: this.today, perDay: this.perDay, month: this.thisMonth, monthCap: this.monthCap, calls: this.calls, refused: this.refused, restingS: Math.max(0, Math.round((this.restUntil - this.now()) / 1000)) };
  }
}
