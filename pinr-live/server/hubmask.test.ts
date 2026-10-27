import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maskDossier, maskEvents, observedBand, maskToken, scoreServed } from "./hubmask";
import type { WireToken } from "./translate";
import { EMPTY } from "./dossier";

const tok = (o: Partial<WireToken> = {}): WireToken => ({ address: "A", chain: "solana", launchpad: "Pump.fun", name: "Coin", ticker: "$C", imageUrl: null, score: 61, coverage: 80, early: true, noScoreLabel: null, note: null, valuationUsd: 5, volume24hUsd: 1, change24hPct: 2, priceSeries: null, launchedAtMs: 1, asOfMs: 1, rank: 1, priceUsd: 1, liquidityUsd: 1, quotePair: null, changeWindowH: null, priceSource: null, flow: null, lastTradeMs: null, ...o }) as WireToken;

describe("the server's evidence-hub switch", () => {
  it("is off unless the setting says on, and no request can change it", () => {
    expect(scoreServed({})).toBe(false);
    expect(scoreServed({ PINR_SHOW_SCORE: "off" })).toBe(false);
    expect(scoreServed({ PINR_SHOW_SCORE: "on" })).toBe(true);
  });
  it("strips the score, coverage, early flag and score labels, and keeps the market facts", () => {
    const m = maskToken(tok({ noScoreLabel: "HONEYPOT", note: "Serial launcher (83 launches)" }), false);
    expect(m).toMatchObject({ score: null, coverage: 0, noScoreLabel: null, note: null, valuationUsd: 5, volume24hUsd: 1, priceUsd: 1 });
    expect("early" in m).toBe(false);
    expect(JSON.stringify(m)).not.toMatch(/61|HONEYPOT|Serial/);
  });
  it("keeps VAMP as a fact about the coin", () => {
    expect(maskToken(tok({ score: null, coverage: 0, noScoreLabel: "VAMP", note: "copy of $X" }), false)).toMatchObject({ noScoreLabel: "VAMP", note: "copy of $X" });
  });
  it("passes everything through when the switch is on", () => {
    const t = tok();
    expect(maskToken(t, true)).toBe(t);
  });
  it("leaves PINRbot's reading out of the dossier while off, and keeps the rest", () => {
    const d = { ...EMPTY, available: true, intent: { items: [] } } as never;
    const m = maskDossier(d, false);
    expect("intent" in m).toBe(false);
    expect(m.available).toBe(true);
    expect(maskDossier(d, true)).toBe(d);
  });
  it("leaves score moves, flags, verdict notes out of the chart events while off, and keeps a measured surge", () => {
    const ev = [
      { t: 1, kind: "score_up", from: 23, to: 25 },
      { t: 2, kind: "score_down", from: 25, to: 20 },
      { t: 3, kind: "flag_raised" },
      { t: 4, kind: "flag_cleared" },
      { t: 5, kind: "verified" },
      { t: 6, kind: "note" },
      { t: 7, kind: "surge" },
    ];
    expect(maskEvents(ev, false)).toEqual([{ t: 7, kind: "surge" }]);
    expect(maskEvents(ev, true)).toBe(ev);
  });
  it("answers the metric route with null while off (route wiring)", () => {
    const src = readFileSync(join(import.meta.dirname, "server.ts"), "utf8");
    expect(src).toMatch(/metric: scoreServed\(\) \? readMetric\(token\.address\) : null/);
    expect(src).toMatch(/events: maskEvents\(readEvents\(token\.address\)\)/);
  });
  it("sends the observed word, never the band, in the dossier's checks while off", () => {
    const d = { ...EMPTY, available: true, checks: [{ name: "A", band: "Strong" }, { name: "B", band: "Fair" }, { name: "C", band: "Weak", reason: "r" }, { name: "D", band: "Clear" }, { name: "E", band: "Not read" }] } as never;
    const m = maskDossier(d, false);
    expect(m.checks.map((c) => c.band)).toEqual(["observed", "observed", "worth a closer look", "observed", "not checked yet"]);
    expect(m.checks[2]).toMatchObject({ name: "C", reason: "r" });
    expect(JSON.stringify(m)).not.toMatch(/Strong|Fair|Weak|Clear|Not read/);
    expect(observedBand("worth a closer look")).toBe("worth a closer look");
  });
});

describe("sanePrice: no served token carries an impossible price", () => {
  it("a price above $1e9 is missing, whichever source set it; a normal one and a missing one are untouched", async () => {
    const { sanePrice, maskToken } = await import("./hubmask.ts");
    const t = (p: number | null) => ({ address: "0x1", priceUsd: p }) as never;
    expect((sanePrice(t(7.825974141792293e41)) as { priceUsd: number | null }).priceUsd).toBeNull();
    expect((sanePrice(t(2.2e-7)) as { priceUsd: number | null }).priceUsd).toBe(2.2e-7);
    expect((sanePrice(t(null)) as { priceUsd: number | null }).priceUsd).toBeNull();
    expect((maskToken(t(7.8e41), true) as { priceUsd: number | null }).priceUsd).toBeNull();      // with the score shown too
  });
});
