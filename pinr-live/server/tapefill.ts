import type { Tape } from "./tape.ts";
import type { WireToken } from "./translate.ts";
import { isVamp } from "./vamp.ts";

/**
 * What the tape adds to a token the app has been asked about: the live buy/sell mix in dollars (the ribbons), the time of its last
 * trade and its newest event line. Solana tokens only. A token the tape has not read is returned untouched (its tile keeps the mix
 * DexScreener's counts gave it, or nothing): no mix, no line, nothing made up. No price line is built from the tape any more: a
 * page of trades is too short to stand for 24 hours.
 */
export class TapeFill {
  constructor(private tape: Tape) {}

  apply(tokens: WireToken[]): WireToken[] {
    return tokens.map((t) => {
      if (t.chain !== "solana" || isVamp(t)) return t;
      const flow = this.tape.flow(t.address);
      const last = this.tape.lastTradeMs(t.address);
      const ev = this.tape.event(t.address);
      if (!flow && last === null && !ev) return t;
      return { ...t, flow: flow ?? t.flow, lastTradeMs: last ?? t.lastTradeMs, tapeEvent: ev ? { kind: ev.kind, usd: ev.usd, atMs: ev.atSec * 1000 } : null };
    });
  }
}
