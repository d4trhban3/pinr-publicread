import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanEvidence, cleanGate, cleanPinrai, MAX_ROWS, readEvidence, SOURCES } from "./evidence";

const M = "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const W = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const row = (o: object = {}) => ({ from: { kind: "token", id: M }, to: { kind: "wallet", id: W }, what: "created by", value: null, unit: null, at: null, first_read: "2026-10-22T10:00:00Z", read: "2026-10-22T11:00:00Z", source: "Solana chain", link: `https://solscan.io/account/${W}`, onchain: true, ...o });
const doc = (rows: unknown[], extra: object = {}) => ({ contract: "evidence/1", mint: M, as_of: "2026-10-22T11:00:05Z", rows, ...extra });

describe("the per-coin evidence file", () => {
  it("reads a row into milliseconds, ● true and a link", () => {
    const e = cleanEvidence(doc([row()]), M)!;
    expect(e.rows[0]).toMatchObject({ what: "created by", onchain: true, link: `https://solscan.io/account/${W}`, firstReadMs: Date.parse("2026-10-22T10:00:00Z"), readMs: Date.parse("2026-10-22T11:00:00Z"), atMs: null, source: "Solana chain" });
    expect(e.asOfMs).toBe(Date.parse("2026-10-22T11:00:05Z"));
  });
  it("is not a file for this coin unless the contract and the mint match", () => {
    expect(cleanEvidence({ ...doc([row()]), contract: "1.0" }, M)).toBeNull();
    expect(cleanEvidence(doc([row()]), "another")).toBeNull();
    expect(cleanEvidence(doc([row()], { rows: "no" }), M)).toBeNull();
    expect(cleanEvidence(null, M)).toBeNull();
  });
  it("keeps a link only when it is https, and drops credentials and other schemes", () => {
    const links = ["http://x.example/a", "javascript:alert(1)", "https://u:p@x.example/", "ftp://x.example", "not a url", 5, null];
    for (const l of links) expect(cleanEvidence(doc([row({ link: l })]), M)!.rows[0]!.link).toBeNull();
    expect(cleanEvidence(doc([row({ link: "https://x.example/a" })]), M)!.rows[0]!.link).toBe("https://x.example/a");
  });
  it("drops a bad row alone and keeps the rest", () => {
    const e = cleanEvidence(doc([row(), { what: "x" }, row({ what: "" }), row({ from: { kind: "token" } }), 7, row({ what: "funded" })]), M)!;
    expect(e.rows.map((r) => r.what)).toEqual(["created by", "funded"]);
  });
  it("treats ● as true only for true or 1, and reads seconds or ISO times", () => {
    const e = cleanEvidence(doc([row({ onchain: false }), row({ what: "a", onchain: 1 }), row({ what: "b", onchain: "yes" }), row({ what: "c", at: 1_761_000_000 })]), M)!;
    expect(e.rows.map((r) => r.onchain)).toEqual([false, true, false, true]);
    expect(e.rows[3]!.atMs).toBe(1_761_000_000_000);
  });
  it("passes a small record of plain values and drops anything nested", () => {
    const e = cleanEvidence(doc([row({ what: "holds", value: { amount: 12.5, dev: true, program: "Tokenkeg", nested: { a: 1 }, list: [1] } })]), M)!;
    expect(e.rows[0]!.value).toEqual({ amount: 12.5, dev: true, program: "Tokenkeg" });
  });
  it("keeps a short list of words (what a contract owner can do) as one line", () => {
    const e = cleanEvidence(doc([row({ what: "owned by (contract owner)", value: { can: ["change the buy and sell tax rates", "add and remove addresses on a blacklist"], template: "AgentTokenV4 (verified)", mixed: ["a", 1] } })]), M)!;
    expect(e.rows[0]!.value).toEqual({ can: "change the buy and sell tax rates; add and remove addresses on a blacklist", template: "AgentTokenV4 (verified)" });
  });
  it("strips control characters, bounds the text, and caps the rows", () => {
    const e = cleanEvidence(doc([row({ what: "a\u0000b\n".repeat(80) })]), M)!;
    expect(e.rows[0]!.what.length).toBeLessThanOrEqual(120);
    expect(e.rows[0]!.what).not.toMatch(/[\u0000-\u001f]/);
    expect(cleanEvidence(doc(Array.from({ length: MAX_ROWS + 50 }, (_, i) => row({ what: `w${i}` }))), M)!.rows).toHaveLength(MAX_ROWS);
  });
  it("reads a coin's file from the folder, and gives null for none, a bad name or broken text", () => {
    const dir = mkdtempSync(join(tmpdir(), "evid-"));
    writeFileSync(join(dir, `${M}.json`), JSON.stringify(doc([row()])));
    writeFileSync(join(dir, "B7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump.json"), "{broken");
    expect(readEvidence(M, dir)!.rows).toHaveLength(1);
    expect(readEvidence("C7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump", dir)).toBeNull();
    expect(readEvidence("B7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump", dir)).toBeNull();
    expect(readEvidence("../etc/passwd", dir)).toBeNull();
  });
  it("names only a public source from the fixed list; any other words become none", () => {
    for (const s of SOURCES) expect(cleanEvidence(doc([row({ source: s })]), M)!.rows[0]!.source).toBe(s);
    for (const s of ["getTokenLargestAccounts", "creator (from curve)", "Helius", "solana chain", "", null, 5]) expect(cleanEvidence(doc([row({ source: s })]), M)!.rows[0]!.source).toBeNull();
    expect(SOURCES).toEqual(["Solana chain", "Pump.fun", "DexScreener", "GeckoTerminal", "Jupiter", "X", "launchpad record", "Base chain", "BNB chain", "GoPlus"]);
  });
});

describe("the gate section of the evidence file", () => {
  const O = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
  const coin = (c: string, at = "2026-10-23T12:00:00Z") => ({ coin: c, launched_at: at, link: `https://solscan.io/token/${c}` });
  const gate = () => ({
    status: "held",
    words: ["an earlier-launched coin by another creator has the same name and ticker"],
    items: [
      { kind: "earlier_lookalike", words: "an earlier-launched coin by another creator has the same name and ticker", same: "name and ticker", coin: O, launched_at: "2026-10-23T12:00:00Z", link: `https://solscan.io/token/${O}`, creator: W, creator_link: `https://solscan.io/account/${W}` },
      { kind: "same_creator_relaunch", words: "the same creator launched another coin with the same name", same: ["name", "ticker"], coins: [coin(O)] },
      { kind: "serial_launcher", words: "this coin's creator has launched 6 coins (Jupiter's count)", launch_count: 6 },
      { kind: "not_read_yet", words: "the look-alike check has not been read yet" },
    ],
    creator: { id: W, link: `https://solscan.io/account/${W}`, launch_count: 6, launch_count_source: "Jupiter", other_coins: [coin(O)] },
    launched_at: "2026-10-23T12:03:00Z",
    source: "Jupiter",
    read: "2026-10-23T12:05:00Z",
  });
  it("reads a coin that has only a gate result (no rows) into its section", () => {
    const e = cleanEvidence({ ...doc([]), gate: gate() }, M)!;
    expect(e.rows).toEqual([]);
    expect(e.gate).toMatchObject({ status: "held", source: "Jupiter", launchedAtMs: Date.parse("2026-10-23T12:03:00Z"), readMs: Date.parse("2026-10-23T12:05:00Z") });
    expect(e.gate!.items.map((i) => i.kind)).toEqual(["earlier_lookalike", "same_creator_relaunch", "serial_launcher", "not_read_yet"]);
    expect(e.gate!.items[0]).toMatchObject({ same: "name and ticker", coin: O, creator: W, link: `https://solscan.io/token/${O}` });
    expect(e.gate!.creator).toMatchObject({ id: W, launchCount: 6, otherCoins: [{ coin: O }] });
  });
  it("has no gate when the file has none, or when the section is not a gate", () => {
    expect(cleanEvidence(doc([row()]), M)!.gate).toBeUndefined();
    expect(cleanGate(null)).toBeNull();
    expect(cleanGate({ status: "maybe" })).toBeNull();
    expect(cleanGate({ status: "passed" })).toMatchObject({ status: "passed", words: [], items: [], creator: null });
  });
  it("keeps links to https only, coins to real addresses, the source to Jupiter, and drops a bad item alone", () => {
    const g = gate();
    g.items[0] = { ...g.items[0]!, link: "http://x.example/a", coin: "../x", creator_link: "javascript:alert(1)" } as never;
    g.items.push({ kind: "weird", words: "x" } as never, { kind: "serial_launcher", words: "" } as never, 5 as never);
    (g as { source: string }).source = "Helius";
    const c = cleanGate(g)!;
    expect(c.items).toHaveLength(4);
    expect(c.items[0]).toMatchObject({ link: null, coin: null, creatorLink: null });
    expect(c.source).toBeNull();
  });
  it("bounds the lists: ten other coins, and strips control characters from the words", () => {
    const g = gate();
    g.creator.other_coins = Array.from({ length: 30 }, () => coin(O));
    g.words = ["a\u0000b".repeat(100)];
    const c = cleanGate(g)!;
    expect(c.creator!.otherCoins).toHaveLength(10);
    expect(c.words[0]!.length).toBeLessThanOrEqual(200);
    expect(c.words[0]).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe("evidence for Base and BNB Chain coins", () => {
  const E = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
  const O = "0x" + "1".repeat(40);
  it("reads an 0x coin's file whatever the case of its address, and an 0x address in a gate item", () => {
    const d = { contract: "evidence/1", mint: E.toLowerCase(), as_of: "2026-10-23T12:00:00Z", rows: [], gate: { status: "held", words: ["x"], items: [{ kind: "earlier_lookalike", words: "an earlier-launched coin has the same name and ticker", same: "name and ticker", coin: O, launched_at: "2026-10-23T11:00:00Z", link: `https://basescan.org/token/${O}`, creator: O, creator_link: `https://basescan.org/address/${O}` }], creator: { id: O, link: `https://basescan.org/address/${O}`, launch_count: 3, other_coins: [{ coin: O, launched_at: "2026-10-23T10:00:00Z", link: `https://basescan.org/token/${O}` }] }, launched_at: "2026-10-23T12:00:00Z", source: "Jupiter", read: "2026-10-23T12:01:00Z" } };
    const e = cleanEvidence(d, E)!;
    expect(e.gate!.items[0]).toMatchObject({ coin: O, creator: O });
    expect(e.gate!.creator!.otherCoins[0]!.coin).toBe(O);
    expect(cleanEvidence(d, "0x" + "9".repeat(40))).toBeNull(); // another coin's file is not this one's
  });
});

describe("PINRai's reading in the evidence file", () => {
  const good = { status: "read", read_at: "2026-10-24T10:00:00Z", model: "claude-x", dropped: 1, pending: 2, items: [{ kind: "gradual_selling", words: "the developer sold gradually", reviewed: true, receipts: [{ source: "Solana chain", value: 12.5, link: "https://solscan.io/tx/abc", as_of: "2026-10-24T09:00:00Z", onchain: true }, { source: "Somewhere", value: null, link: "http://evil.example/x", as_of: null, onchain: false }, { note: "empty" }] }, { kind: "", words: "no kind" }, { kind: "k", why: "model text only" }, 5] };
  it("keeps good items and receipts, drops bad ones alone, keeps only https links, and never carries a cost or the model's text", () => {
    const p = cleanPinrai({ ...good, cost: 0.4, dollars: 3 })!;
    expect(p).toMatchObject({ status: "read" });
    expect(Object.keys(p).sort()).toEqual(["items", "readMs", "status"]); // no model, set-aside or waiting counts in public
    expect(p.items).toHaveLength(1);
    expect(p.items[0]!.receipts).toHaveLength(1);
    expect(p.items[0]!.receipts[0]).toMatchObject({ source: "Solana chain", value: 12.5, link: "https://solscan.io/tx/abc", onchain: true });
    expect(JSON.stringify(p)).not.toMatch(/cost|dollars|model text|evil|claude-x/);
  });
  it("accepts only the three statuses, and is absent from a file without a section", () => {
    expect(cleanPinrai(null)).toBeNull();
    expect(cleanPinrai({ status: "not read: because", items: [] })).toBeNull();
    expect(cleanPinrai({ status: "off", items: [] })!.status).toBe("off");
    expect(cleanEvidence(doc([row()]), M)!.pinrai).toBeUndefined();
    expect(cleanEvidence(doc([row()], { pinrai: good }), M)!.pinrai!.status).toBe("read");
  });
});

describe("a bot launch and a fast launcher in the gate section", () => {
  it("reads the bot status, the wallets with their label and source, and the fast launcher's coins", () => {
    const e = cleanEvidence(doc([row({})], { gate: { status: "bot", words: [], items: [
      { kind: "bot_launch", words: "bought in the creation block by known volume-bot wallets", wallets: [{ id: W, link: `https://solscan.io/account/${W}`, label: "volume bot", source: "a public label list" }, { id: "not an address" }] },
      { kind: "fast_launcher", words: "this coin's creator launched 15 coins in quick succession", count: 15, coins: [{ coin: M, launched_at: "2026-10-25T18:57:39Z", link: `https://solscan.io/token/${M}` }] },
    ] } } as never), M)!;
    expect(e.gate!.status).toBe("bot");
    const bot = e.gate!.items.find((i) => i.kind === "bot_launch") as { wallets: unknown[] };
    expect(bot.wallets).toEqual([{ id: W, link: `https://solscan.io/account/${W}`, label: "volume bot", source: "a public label list" }]);
    const fast = e.gate!.items.find((i) => i.kind === "fast_launcher") as { count: number; coins: unknown[] };
    expect(fast.count).toBe(15);
    expect(fast.coins).toHaveLength(1);
  });
});
