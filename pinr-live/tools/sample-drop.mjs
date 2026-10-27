// D4: a small SAMPLE drop folder, made up from scratch in the engine's formats, so the feed server, the
// site and the tests can run on sample data instead of the engine's live folder. Nothing here is real: the addresses, names and numbers are invented
// (never a key, never engine output). Times are written fresh, so the quiet marks (which must be under 15 minutes old) count.
//
//   node tools/sample-drop.mjs [folder]      (default: .sample-drop, git-ignored)
//   then: npm run feed:sample                 (the feed server on the sample folder, port 8787)
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SAMPLE_COINS = [
  { mint: "PNRSamp1eCoinA111111111111111111111111pump", name: "Sample Frog", ticker: "SFROG", score: 62, coverage: 0.71, cap: 182000, launchedH: 30, lastTradeMin: 2 },
  { mint: "PNRSamp1eCoinB111111111111111111111111pump", name: "Sample Moon", ticker: "SMOON", score: 34, coverage: 0.55, cap: 41000, launchedH: 6, lastTradeMin: 1 },
  { mint: "PNRSamp1eCoinC111111111111111111111111pump", name: "Sample Copy", ticker: "SFROG", score: null, coverage: 0.2, cap: 9000, launchedH: 3, lastTradeMin: 5, label: "VAMP" },
  { mint: "PNRSamp1eCoinD111111111111111111111111pump", name: "Sample Sleepy", ticker: "SNAP", score: 48, coverage: 0.6, cap: 12000, launchedH: 80, lastTradeMin: 60 * 30 },
  { mint: "0x5a3b1e000000000000000000000000000000c0e2", name: "Sample Zora", ticker: "SZORA", score: null, coverage: 0, cap: 88000, launchedH: 2, lastTradeMin: 4, chain: "base", launchpad: "Zora" },
  { mint: "0x5a3b1e000000000000000000000000000000c0e3", name: "Sample Virtuals", ticker: "SVIRT", score: null, coverage: 0, cap: 240000, launchedH: 9, lastTradeMin: 2, chain: "base", launchpad: "Virtuals" },
  { mint: "0x5a3b1e000000000000000000000000000000c0e4", name: "Sample Four", ticker: "SFOUR", score: null, coverage: 0, cap: 31000, launchedH: 1, lastTradeMin: 1, chain: "bsc", launchpad: "Four.meme" },
  { mint: "0x5a3b1e000000000000000000000000000000c0e1", name: "Sample Base", ticker: "SBASE", score: 71, coverage: 0.8, cap: 520000, launchedH: 200, lastTradeMin: 3, chain: "base", launchpad: "Clanker" },
];
/** The coin the engine marks quiet (no trade in 24 hours): on no list, found by its address. */
export const SAMPLE_QUIET = "PNRSamp1eCoinD111111111111111111111111pump";
/** The coin with an evidence file, a gate result and a PINRai reading. */
export const SAMPLE_EVIDENCE = "PNRSamp1eCoinA111111111111111111111111pump";

export function writeSampleDrop(root, now = Date.now()) {
  const iso = (ms) => new Date(ms).toISOString();
  const drop = join(root, "frontend-feed");
  mkdirSync(join(drop, "evidence"), { recursive: true });
  for (const c of SAMPLE_COINS) {
    writeFileSync(join(drop, `${c.mint}.json`), JSON.stringify({
      mint: c.mint, score: c.score, display: c.score === null ? (c.label ?? "—") : String(c.score), coverage: c.coverage, label: c.label ?? null,
      chain: c.chain ?? "solana", launchpad: c.launchpad ?? "Pump.fun curve", name: c.name, ticker: c.ticker,
      valuation_usd: c.cap, launched_at: iso(now - c.launchedH * 3600e3), as_of: iso(now - 60e3), facts: [],
      price_usd: c.cap / 1e9, volume_24h_usd: Math.round(c.cap * 0.4), liquidity_usd: Math.round(c.cap * 0.15), change_24h_pct: c.score === null ? null : c.score - 50,
      price_series: Array.from({ length: 24 }, (_, i) => +((c.cap / 1e9) * (1 + Math.sin(i / 3) * 0.08)).toPrecision(6)),
    }, null, 1));
  }
  const W = "PNRSamp1eCreator11111111111111111111111111";
  writeFileSync(join(drop, "evidence", `${SAMPLE_EVIDENCE}.json`), JSON.stringify({
    contract: "evidence/1", mint: SAMPLE_EVIDENCE, as_of: iso(now - 60e3),
    rows: [{ from: { kind: "token", id: SAMPLE_EVIDENCE }, to: { kind: "wallet", id: W }, what: "created by", value: null, unit: null, at: iso(now - 30 * 3600e3), first_read: iso(now - 29 * 3600e3), read: iso(now - 600e3), source: "Solana chain", link: `https://solscan.io/account/${W}`, onchain: true }],
    gate: { status: "passed", words: [], items: [], creator: { id: W, link: `https://solscan.io/account/${W}`, launch_count: 2, other_coins: [] }, launched_at: iso(now - 30 * 3600e3), source: "Jupiter", read: iso(now - 900e3) },
    pinrai: { status: "read", read_at: iso(now - 300e3), model: "sample", dropped: 0, pending: 0, items: [{ kind: "gradual_selling", words: "the developer sold gradually", reviewed: true, receipts: [{ source: "Solana chain", value: 1.25, link: "https://solscan.io/tx/sample", as_of: iso(now - 3600e3), onchain: true }] }] },
  }, null, 1));
  writeFileSync(join(drop, "_quiet.json"), JSON.stringify({ contract: "quiet-1", as_of: iso(now - 30e3), window_s: 86400, quiet: { [SAMPLE_QUIET]: { since: iso(now - 26 * 3600e3), checked: iso(now - 120e3), by: "DexScreener" } } }, null, 1));
  mkdirSync(join(root, "results"), { recursive: true });
  return { drop, results: join(root, "results") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(process.argv[2] ?? ".sample-drop");
  const out = writeSampleDrop(root);
  console.log(`Sample drop written to ${out.drop} (${SAMPLE_COINS.length} coins, one evidence file, one quiet mark).`);
}
