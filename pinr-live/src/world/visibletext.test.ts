import { describe, expect, it } from "vitest";
import { visibleText } from "./visibletext";
import { translate } from "../../server/translate.ts";
import { rankDiscover } from "./discoverlist";

describe("names and tickers lose their invisible characters", () => {
  it("takes out the word joiner in the Arena's \"Blind Ape\" and the other zero-width and blank characters", () => {
    expect(visibleText("Blind⁠ Ape")).toBe("Blind Ape");
    expect(visibleText("​P‌U‍M﻿P­")).toBe("PUMP");
    expect(visibleText("‮EPA‬")).toBe("EPA");
    expect(visibleText("ㅤ⠀ᅟ")).toBe("");
    expect(visibleText("  Two \t spaces\u0007 ")).toBe("Two spaces");
  });
  it("keeps emoji whole, accents and other scripts as they are", () => {
    expect(visibleText("Fam \u{1F468}‍\u{1F469}‍\u{1F467}")).toBe("Fam \u{1F468}‍\u{1F469}‍\u{1F467}");
    expect(visibleText("❤️ Love")).toBe("❤️ Love");
    expect(visibleText("Café 狗 Пёс")).toBe("Café 狗 Пёс");
  });
  it("an engine file's name and ticker arrive clean, and a search with a hidden character still finds the coin", () => {
    const { token } = translate({ mint: "0xabc0000000000000000000000000000000001234", chain: "bsc", score: 20, display: "20", label: "x", coverage: 0.4, name: "Blind\u2060 Ape", ticker: "AP\u200bE" });
    expect(token!.name).toBe("Blind Ape");
    expect(token!.ticker).toBe("$APE");
    const { token: blank } = translate({ mint: "0xabc0000000000000000000000000000000001234", chain: "bsc", score: 20, display: "20", label: "x", coverage: 0.4, name: "\u2060\u200b" });
    expect(blank!.name).toBeNull();
    const items = [{ id: 1, name: "Blind Ape", ticker: "$APE", address: null, chain: "solana" }] as unknown as Parameters<typeof rankDiscover>[1];
    expect(rankDiscover("trending", items, "Blind\u2060 Ape").length).toBe(1);
  });
});
