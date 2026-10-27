import { describe, expect, it } from "vitest";
import { translate } from "./translate.ts";

const good = (over: Record<string, unknown> = {}) => ({
  mint: "0xabc0000000000000000000000000000000001234",
  chain: "bsc",
  launchpad: "fourmeme",
  score: 20,
  display: "20",
  label: "No project presence",
  coverage: 0.452,
  flags: ["internal evidence text"],
  receipts: [{ what: "x" }],
  readings: { liquidity_depth: 12 },
  ...over,
});

describe("data contract: the translator", () => {
  it("turns a normal engine result into a tile-ready token", () => {
    const { token, problems } = translate(good());
    expect(problems).toEqual([]);
    expect(token).toMatchObject({ address: "0xabc0000000000000000000000000000000001234", chain: "bsc", launchpad: "fourmeme", score: 20, coverage: 45, noScoreLabel: null, note: "No project presence" });
  });

  it("keeps the engine's inner workings server-side: only allow-listed fields come out", () => {
    const { token } = translate(good());
    const keys = Object.keys(token!);
    for (const secret of ["readings", "receipts", "flags", "escalations", "notes", "creator", "real_money_usd"]) expect(keys).not.toContain(secret);
  });

  it("missing stays missing: absent optional fields are null, never zero", () => {
    const { token } = translate(good());
    expect(token).toMatchObject({ name: null, ticker: null, imageUrl: null, valuationUsd: null, volume24hUsd: null, change24hPct: null, priceSeries: null, launchedAtMs: null, asOfMs: null });
  });

  it("a no-score label shows the label and never a number", () => {
    for (const l of ["VAMP", "BOT/RUG", "MAYHEM", "HONEYPOT"]) {
      const { token } = translate(good({ score: null, display: l, label: l, coverage: 0 }));
      expect(token).toMatchObject({ score: null, noScoreLabel: l, note: null });
    }
  });

  it("if a file gives both a no-score label and a number, the number is dropped and it is reported", () => {
    const { token, problems } = translate(good({ score: 61, label: "VAMP", display: "VAMP" }));
    expect(token!.score).toBeNull();
    expect(token!.noScoreLabel).toBe("VAMP");
    expect(problems.some((p) => p.severity === "error" && p.field === "score")).toBe(true);
  });

  it("zero coverage with no number is allowed and stays a plain 'no number'", () => {
    const { token } = translate(good({ score: null, display: "—", label: null, coverage: 0 }));
    expect(token).toMatchObject({ score: null, coverage: 0, noScoreLabel: null });
  });

  it("leaves a token out (with the reason) when a required field is broken", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ mint: "" }, "mint"],
      [{ score: 0 }, "score"],
      [{ score: 100 }, "score"],
      [{ score: 55.5 }, "score"],
      [{ score: "55" }, "score"],
      [{ coverage: 45 }, "coverage"],
      [{ coverage: -0.1 }, "coverage"],
      [{ label: 7 }, "label"],
    ];
    for (const [over, field] of cases) {
      const { token, problems } = translate(good(over));
      expect(token, JSON.stringify(over)).toBeNull();
      expect(problems.some((p) => p.severity === "error" && p.field === field)).toBe(true);
    }
    const noScoreKey: Record<string, unknown> = good();
    delete noScoreKey.score;
    expect(translate(noScoreKey).token).toBeNull();
    expect(translate("nope").token).toBeNull();
    expect(translate(null).token).toBeNull();
  });

  it("reads the optional fields the development side may add, and ignores bad ones with a warning", () => {
    const ok = translate(
      good({ name: "Zorin", ticker: "ZRN", image_url: "https://x/y.png", valuation_usd: 2160000, volume_24h_usd: 21890000, change_24h_pct: 62.9, launched_at: "2026-10-05T12:00:00Z", price_series: [1, 1.2, 0.9, 1.6], as_of: 1790000000000 }),
    );
    expect(ok.problems).toEqual([]);
    expect(ok.token).toMatchObject({ name: "Zorin", ticker: "$ZRN", imageUrl: "https://x/y.png", valuationUsd: 2160000, volume24hUsd: 21890000, change24hPct: 62.9, priceSeries: [1, 1.2, 0.9, 1.6] });
    expect(ok.token!.launchedAtMs).toBe(Date.parse("2026-10-05T12:00:00Z"));
    const bad = translate(good({ valuation_usd: "lots", change_24h_pct: -150, price_series: [1, 0, 2], launched_at: "yesterday", ticker: 5 }));
    expect(bad.token).toMatchObject({ valuationUsd: null, change24hPct: null, priceSeries: null, launchedAtMs: null, ticker: null });
    expect(bad.problems.filter((p) => p.severity === "warning").length).toBe(5);
  });

  it("accepts the older Solana files that call the launchpad 'venue' and carry no chain", () => {
    const { token } = translate({ mint: "FQwMB6D", venue: "Pump.fun curve", score: null, display: "MAYHEM", label: "MAYHEM", coverage: 0, flags: [], receipts: [] });
    expect(token).toMatchObject({ launchpad: "Pump.fun curve", chain: null, noScoreLabel: "MAYHEM" });
  });
});

describe("the score time (a design decision (d))", () => {
  it("reads scored_at when the file has it, and leaves it absent when it does not", () => {
    const base = { mint: "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump", score: 40, display: "40", coverage: 0.5, label: null, as_of: "2026-10-25T03:00:00Z" };
    expect(translate({ ...base, scored_at: "2026-10-24T01:00:00Z" }).token!.scoredAtMs).toBe(Date.parse("2026-10-24T01:00:00Z"));
    expect("scoredAtMs" in translate(base).token!).toBe(false);
    const bad = translate({ ...base, scored_at: "yesterday" });
    expect(bad.token && "scoredAtMs" in bad.token).toBe(false);
    expect(bad.problems.some((p) => p.field === "scored_at")).toBe(true);
  });
});

describe("checklist 7: the engine's own status words never leave the server", () => {
  it("drops \"Technical error, retrying\" from the served note, keeping any observed part", () => {
    expect(translate(good({ label: "Technical error, retrying" })).token!.note).toBeNull();
    expect(translate(good({ label: "Technical error, retrying; serial launcher" })).token!.note).toBe("serial launcher");
    expect(translate(good({ label: "No project presence" })).token!.note).toBe("No project presence");
  });
});

describe("the engine's tags", () => {
  it("keeps the known tags in their order, leaves out the unknown ones, and notes a wrong field", () => {
    expect(translate(good({ tags: ["serial_launcher", "vamp", "nonsense"] })).token!.tags).toEqual(["vamp", "serial_launcher"]);
    expect(translate(good({})).token!.tags).toBeUndefined();
    const r = translate(good({ tags: "bot" }));
    expect(r.token!.tags).toBeUndefined();
    expect(r.problems.some((p) => p.field === "tags")).toBe(true);
  });
});

describe("an impossible price is missing, never shown", () => {
  it("price_usd above $1e9 per token is left out and noted; a normal price stays", async () => {
    const { MAX_PRICE_USD } = await import("./translate.ts");
    expect(MAX_PRICE_USD).toBe(1e9);
  });
});

describe("the engine's all-time high (ENGINE, 26 Oct: ath_cap_usd, ath_source, ath_tx in the coin's feed file)", () => {
  const TX = "5KtP9mQ4yF7vZcWx2dLh8sNaB3eRjU6gTq1oVpYkXz9HnDuCfMrSwEiAbG4LtJy7NvKcQhPe2XdRfTmZ8aUoBs3W";
  const solana = (over: Record<string, unknown> = {}) => good({ mint: "So11111111111111111111111111111111111111112", chain: "solana", as_of: "2026-10-26T12:00:00Z", ...over });
  it("takes the peak market cap in dollars with its source, its read time and its transaction link", () => {
    const { token } = translate(solana({ ath_cap_usd: 69_000, ath_at: "2026-10-26T09:00:00Z", ath_source: "Pump.fun", ath_tx: TX }));
    expect(token).toMatchObject({ athUsd: 69_000, athSource: "Pump.fun", athAtMs: Date.parse("2026-10-26T12:00:00Z"), athLink: `https://solscan.io/tx/${TX}` });
  });
  it("leaves it out when any part is missing or wrong: no source, a source not on the public list, a cap of 0, no read time; a bad tx gives no link", () => {
    for (const over of [{ ath_cap_usd: 5e4 }, { ath_cap_usd: 5e4, ath_source: "CoinGecko" }, { ath_cap_usd: 0, ath_source: "Pump.fun" }, { ath_cap_usd: 5e4, ath_source: "Pump.fun", as_of: undefined }]) {
      const { token } = translate(solana(over));
      expect(token).not.toHaveProperty("athUsd");
    }
    const { token } = translate(solana({ ath_cap_usd: 5e4, ath_source: "Solana chain", ath_tx: "not a signature" }));
    expect(token).toMatchObject({ athUsd: 5e4, athSource: "Solana chain" });
    expect(token).not.toHaveProperty("athLink");
  });
});
