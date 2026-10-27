import { describe, expect, it } from "vitest";
import { isFeatured, rankFeatured } from "./filters";
import { HIST_N, SIM, type Item } from "./model";

/** the PINR page features Pump.fun and PumpSwap coins; other launchpads only in the room left after them. */
const NOW = 1_800_000_000_000;
let next = 1;
const item = (launchpad: string | undefined, seenAgoMin: number): Item =>
  ({ id: next++, name: "x", ticker: "X", image: "/api/img?a=x", detail: "", value: "—", coverage: 0, early: false, base: 0.3, spike: 0, note: null, noteSeq: 0, noteLeft: 0,
     hist: new Array(HIST_N).fill(0.12), histAge: 0, buyShare: 0.5, restBuy: 0.5, evSide: 1, status: "ok", flagKind: null, statusLeft: 0, ageMin: 10, moved: 0, mcap: 1000,
     ath: NaN, volume24h: NaN, change24h: NaN, chart: [], changeWindowH: NaN, priceSource: "", priceUsd: 1, liquidity: NaN, quotePair: "", findings: [], hasFlow: false,
     address: `A${next}`, tag: "", launchpad, seen: true, seenAtMs: NOW - seenAgoMin * 60_000 }) as unknown as Item;
void SIM;

describe("featured coins", () => {
  it("Pump.fun and PumpSwap are featured; bonk.fun, Stonk.fun, LaunchLab and an unknown launchpad are not", () => {
    expect(["Pump.fun curve", "PumpSwap (graduated)"].map((l) => isFeatured({ launchpad: l }))).toEqual([true, true]);
    expect(["bonk.fun LaunchLab curve", "LaunchLab curve (StonkFun (reward mode))", undefined].map((l) => isFeatured({ launchpad: l }))).toEqual([false, false, false]);
  });
  it("the page ranks featured coins first, even when another launchpad's coin is newer; the others fill only the room left", () => {
    const bonk = item("bonk.fun LaunchLab curve", 1);
    const pumps = [item("Pump.fun curve", 5), item("PumpSwap (graduated)", 9), item("Pump.fun curve", 3)];
    const ids = rankFeatured("trending", [bonk, ...pumps], 10, NOW, "default").map((r) => r.id);
    expect(ids).toEqual([pumps[2]!.id, pumps[0]!.id, pumps[1]!.id, bonk.id]);
    expect(rankFeatured("trending", [bonk, ...pumps], 3, NOW, "default").map((r) => r.id)).not.toContain(bonk.id);
    const r = rankFeatured("trending", [bonk, ...pumps], 10, NOW, "default");
    expect(r[0]!.imp).toBeGreaterThan(r[3]!.imp); // sizes counted over the whole page
  });
});
