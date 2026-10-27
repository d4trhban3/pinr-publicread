import { describe, expect, it } from "vitest";
import type { Evidence, EvidenceRow, Gate } from "../../server/evidence";
import { describe as say, earlierBy, GROUPS, gateView, LINKED, orbitGroups, pinraiView } from "./orbit";

const M = "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const W = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const F = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const NOW = Date.parse("2026-10-22T12:00:00Z");
const row = (o: Partial<EvidenceRow>): EvidenceRow => ({ from: { kind: "token", id: M }, to: { kind: "wallet", id: W }, what: "created by", value: null, unit: null, atMs: null, firstReadMs: null, readMs: NOW - 5 * 60_000, source: "Solana chain", link: `https://solscan.io/account/${W}`, onchain: true, ...o });

describe("Orbit's groups", () => {
  it("has six groups in ring order, and each says 'not checked yet' when empty (never 'clean')", () => {
    const g = orbitGroups(null, NOW);
    expect(g.map((x) => x.id)).toEqual(["creator", "funders", "holders", "pool", "socials", "links"]);
    for (const x of g) {
      expect(x.facts).toEqual([]);
      expect(x.empty).toMatch(/not checked yet/);
    }
    expect(GROUPS.map((x) => x.empty).join(" ")).not.toMatch(/clean|safe|no risk|verified|trust/i);
  });
  it("puts each kind of row in its group, in plain words", () => {
    const ev: Evidence = {
      contract: "evidence/1",
      asOfMs: NOW,
      rows: [
        row({}),
        row({ what: "launched by" }),
        row({ what: "fee receiver at launch" }),
        row({ from: { kind: "wallet", id: W }, to: { kind: "launchpad", id: "count" }, what: "coins launched (the launchpad's list)", value: 12, unit: "coins", onchain: false }),
        row({ from: { kind: "wallet", id: W }, to: { kind: "wallet", id: F }, what: "bought in the creation block" }),
        row({ from: { kind: "wallet", id: F }, to: { kind: "wallet", id: W }, what: "funded", value: 2.5, unit: "SOL", atMs: NOW - 3 * 86_400_000 }),
        row({ from: { kind: "wallet", id: F }, to: { kind: "token", id: M }, what: "holds", value: { amount: 1_500_000, dev: true }, onchain: false }),
        row({ to: { kind: "pool", id: F }, what: "trades in pool" }),
        row({ to: { kind: "x", id: "https://x.com/a" }, what: "lists its own link", onchain: false, link: "https://x.com/a" }),
        row({ to: { kind: "document", id: "https://ipfs.io/x" }, what: "metadata document" }),
        row({ what: "something new" }),
      ],
    };
    const g = Object.fromEntries(orbitGroups(ev, NOW).map((x) => [x.id, x.facts.map((f) => f.text)]));
    expect(g.creator).toHaveLength(5);
    expect(g.creator![0]).toBe("Created by 9xQeWv…VFin");
    expect(g.creator![3]).toContain("has launched 12 coins (the launchpad's list)");
    expect(g.creator![4]).toBe("Linked wallet 5tzFki…uAi9 · bought in the creation block");
    expect(g.funders).toEqual(["5tzFki…uAi9 sent 2.5 SOL to 9xQeWv…VFin"]);
    expect(g.holders![0]).toContain("holds 1.50M of it · the source marks it: dev");
    expect(g.pool).toEqual(["Trades in the pool 5tzFki…uAi9"]);
    expect(g.socials).toEqual(["Lists its own X account"]);
    expect(g.links).toEqual(["Metadata document", "something new"]);
  });
  it("places Base and BNB rows (CHAINS) in their groups, in plain words, with Zora's owners_can always shown", () => {
    const T = "0x811e5292e33c3f65edc2a9564ce4362290c34444";
    const A = "0x654be32783991bb995720b3bb1d29295dd92fe03";
    const tok = { kind: "token", id: T };
    const wal = { kind: "wallet", id: A };
    const ev: Evidence = {
      contract: "evidence/1",
      asOfMs: NOW,
      rows: [
        row({ from: wal, to: tok, what: "holds", value: { share: 0.99997700085, note: "Four.meme launchpad (its curve holds the unsold supply)" }, unit: "tokens" }),
        row({ from: wal, to: tok, what: "holds", value: { share: 2.29991407603e-5 }, unit: "tokens" }),
        row({ from: wal, to: tok, what: "holds (dev team)", value: { wallets: 9948.97, share: 0.87 }, unit: "tokens / share" }),
        row({ from: tok, to: { kind: "count", id: "holders" }, what: "holders counted", value: 1234, unit: "wallets" }),
        row({ from: wal, to: tok, what: "dev moves", value: { members: 1, acquired: 22999.14 }, unit: "tokens / seconds" }),
        row({ from: tok, to: wal, what: "dev team: reward admin" }),
        row({ from: wal, to: tok, what: "bought at launch", value: { eth: 0.5, tokens: 9948.97 }, unit: "ETH / tokens" }),
        row({ from: wal, to: { kind: "contract", id: "launch service" }, what: "is a contract (a launch service, not a person)" }),
        row({ from: tok, to: wal, what: "owned by (contract owner)", value: { can: "change the buy and sell tax rates; withdraw tokens", template: "AgentTokenV4 (verified)" } }),
        row({ from: tok, to: wal, what: "creator rewards paid to" }),
        row({ from: tok, to: wal, what: "tax paid to" }),
        row({ from: tok, to: { kind: "launchpad", id: "Four.meme" }, what: "launched on" }),
        row({ from: tok, to: { kind: "pool", id: A }, what: "trades in pool (Uniswap v4)" }),
        row({ from: tok, to: { kind: "locker", id: "Clanker locker" }, what: "liquidity locked", value: 1, unit: "share of pool value" }),
        row({ from: tok, to: { kind: "contract", id: A }, what: "liquidity held by Zora's hook", value: { locked_share: 1, owners_can: "move it into another pool on Zora's approved list; no one can withdraw it" } }),
        row({ from: tok, to: { kind: "check", id: "tax" }, what: "trading tax", value: { buy_pct: 1, sell_pct: 3 }, unit: "percent" }),
        row({ from: tok, to: { kind: "pool", id: A }, what: "trades in pool", value: { lp_burned_share: 1 } }),
        row({ from: tok, to: { kind: "zora", id: "basefolio" }, what: "creator's Zora profile", onchain: false }),
        row({ from: wal, to: { kind: "x", id: "https://x.com/777humdrum777" }, what: "creator's linked account", value: { username: "777humdrum777", followers: 805 }, onchain: false }),
        row({ from: tok, to: { kind: "contract", id: A }, what: "copy of the template", value: "FlapTaxTokenV3 (verified, no mint/pause/blacklist)" }),
        row({ from: tok, to: { kind: "check", id: "GoPlus" }, what: "GoPlus security check (a lead)", value: "nothing flagged", unit: "flags", onchain: false }),
      ],
    };
    const g = Object.fromEntries(orbitGroups(ev, NOW).map((x) => [x.id, x.facts.map((f) => f.text)]));
    const short = say(row({ to: wal })).text.replace("Created by ", "");
    expect(g.holders).toEqual([
      `${short} holds 99.99% of the supply · Four.meme launchpad (its curve holds the unsold supply)`,
      `${short} holds 0.0023% of the supply`,
      "The dev team's wallets hold 87% of it",
      "1,234 wallets hold this coin",
    ]);
    expect(g.creator).toEqual([
      `The creator's tokens moved · 1 wallet, 23.0K tokens acquired`,
      `Dev team wallet, reward admin: ${short}`,
      `${short} bought at launch · 9.9K tokens for 0.5 ETH`,
      `${short} is a contract (a launch service, not a person)`,
      `Contract owner: ${short} · AgentTokenV4 (verified) · the owner can: change the buy and sell tax rates; withdraw tokens`,
      `Creator rewards go to ${short}`,
      `Tax goes to ${short}`,
    ]);
    expect(g.pool).toEqual([
      "Launched on Four.meme",
      `Trades in the Uniswap v4 pool ${short}`,
      "Liquidity locked: 100% of the pool · Clanker locker",
      "Zora's hook holds 100% of the pool's liquidity; its owners can move it into another pool on Zora's approved list; no one can withdraw it",
      "Trading tax: buy 1%, sell 3%",
      `Trades in the pool ${short} · 100% of its LP tokens burned`,
    ]);
    expect(g.socials).toEqual(["Creator's Zora profile @basefolio", "Creator's linked account @777humdrum777 · 805 followers"]);
    expect(g.links).toEqual(["Contract is a copy of FlapTaxTokenV3 (verified, no mint/pause/blacklist)", "GoPlus check (a lead): nothing flagged"]);
    expect(Object.values(g).flat().join(" ")).not.toMatch(/\b(safe|scam|rug|danger|risky|trust)\b/i);
  });
  it("never shows a small real amount as 0 (CHAINS: gas-money funding of 0.001 BNB read \"sent 0 BNB\")", () => {
    const f = (v: number) => say(row({ from: { kind: "wallet", id: F }, to: { kind: "wallet", id: W }, what: "funded", value: v, unit: "BNB" })).text;
    expect(f(0.001)).toContain("sent 0.001 BNB");
    expect(f(0.00099895)).toContain("sent 0.000999 BNB");
    expect(f(0.0000001)).toContain("sent 0.0000001 BNB");
    expect(f(2.5)).toContain("sent 2.5 BNB");
    expect(f(0)).toContain("sent 0 BNB"); // a real zero stays a zero
  });
  it("carries ●/○, the read age, when it happened, the source and the link", () => {
    const g = orbitGroups({ contract: "evidence/1", asOfMs: NOW, rows: [row({ what: "funded", from: { kind: "wallet", id: F }, atMs: NOW - 2 * 3_600_000, onchain: false })] }, NOW);
    expect(g[1]!.facts[0]).toMatchObject({ onchain: false, readText: "read 5 min ago", happenedText: "happened 2 h ago", source: "Solana chain", link: `https://solscan.io/account/${W}` });
  });
  it("leaves the X check's own text out, and never writes a verdict word", () => {
    const t = say(row({ what: "X check", value: "the account is a scam and unsafe" }));
    expect(t.text).toBe("X check ran");
    const all = ["created by", "launched by", "funded", "holds", "trades in pool", "lists its own link", "X check", "market pair"].map((w) => say(row({ what: w, value: { amount: 5, dev: true } })).text).join(" ");
    expect(all).not.toMatch(/safe|scam|rug|bad|good|avoid|dangerous|risk|flag|penalt|score/i);
  });
  it("places all four of the engine's plain linked facts under Creator, naming the wallet", () => {
    const rows = LINKED.map((w, i) => row({ from: { kind: "wallet", id: W }, to: { kind: "wallet", id: i % 2 ? F : "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs" }, what: w, value: null, source: "Solana chain" }));
    const g = orbitGroups({ contract: "evidence/1", asOfMs: NOW, rows }, NOW);
    expect(g[0]!.facts.map((f) => f.text)).toEqual([
      "Linked wallet 7vfCXT…voxs · bought in the creation block",
      "Linked wallet 5tzFki…uAi9 · funded by the creator before launch",
      "Linked wallet 7vfCXT…voxs · received tokens from the creator",
      "Linked wallet 5tzFki…uAi9 · linked to the creator",
    ]);
    expect(g[5]!.facts).toEqual([]);
    expect(g[0]!.facts.map((f) => f.text).join(" ")).not.toMatch(/window|share|threshold|%|rule/i);
  });
});

describe("the gate's result on the coin page", () => {
  const O = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
  const gate = (over: Partial<Gate> = {}): Gate => ({
    status: "held",
    words: ["an earlier-launched coin by another creator has the same name and ticker"],
    items: [{ kind: "earlier_lookalike", words: "an earlier-launched coin by another creator has the same name and ticker", same: "name and ticker", coin: O, launchedAtMs: NOW - 3 * 60_000, link: `https://solscan.io/token/${O}`, creator: W, creatorLink: `https://solscan.io/account/${W}` }],
    creator: { id: W, link: `https://solscan.io/account/${W}`, launchCount: 6, otherCoins: [{ coin: O, launchedAtMs: NOW - 86_400_000, link: `https://solscan.io/token/${O}` }] },
    launchedAtMs: NOW,
    source: "Jupiter",
    readMs: NOW - 120_000,
    ...over,
  });
  it("says how long before this coin the look-alike launched, with links to see it and its creator", () => {
    const v = gateView(gate(), NOW)!;
    expect(v.headline).toBe("Observed at launch:");
    expect(v.lines[0]).toMatchObject({ words: "an earlier-launched coin by another creator has the same name and ticker", when: "launched 3 min earlier" });
    expect(v.lines[0]!.links.map((l) => l.href)).toEqual([`https://solscan.io/token/${O}`, `https://solscan.io/account/${W}`]);
    expect(v.others[0]).toMatchObject({ label: "5tzF…uAi9", when: "launched 1 day ago", href: `https://solscan.io/token/${O}` });
    expect(v.readText).toBe("read 2 min ago · Jupiter");
  });
  it("is nothing without a gate, 'not checked yet' when not read, and plain when nothing matched", () => {
    expect(gateView(undefined, NOW)).toBeNull();
    expect(gateView(gate({ status: "not read yet", items: [{ kind: "not_read_yet", words: "the look-alike check has not been read yet" }], words: [] }), NOW)!.headline).toBe("Not checked yet.");
    const passed = gateView(gate({ status: "passed", items: [], words: [], creator: null }), NOW)!;
    expect(passed.headline).toBe("Nothing matching was found at launch.");
    expect(passed.lines).toEqual([]);
  });
  it("measures earlier only from two launch times, with the other one earlier", () => {
    expect(earlierBy(NOW, NOW - 3 * 60_000)).toBe("3 min earlier");
    expect(earlierBy(NOW, NOW - 5 * 3_600_000)).toBe("5 h earlier");
    expect(earlierBy(NOW, NOW - 4 * 86_400_000)).toBe("4 days earlier");
    expect(earlierBy(NOW, NOW + 60_000)).toBeNull();
    expect(earlierBy(null, NOW)).toBeNull();
    expect(earlierBy(NOW, null)).toBeNull();
  });
  it("never uses a verdict word of its own", () => {
    const v = gateView(gate({ status: "passed", items: [], words: [] }), NOW)!;
    const own = [v.headline, gateView(gate(), NOW)!.headline, gateView(gate({ status: "not read yet", words: [], items: [] }), NOW)!.headline, "launched 3 min earlier", "see the earlier coin"].join(" ");
    expect(own).not.toMatch(/held|blocked|bad|scam|rug|fake|copy|flag|safe|danger|penalt|verdict/i);
    expect(v.headline).toBeTruthy();
  });
});

describe("PINRai's reading on the coin page", () => {
  const base = { status: "read" as const, readMs: NOW - 120_000, items: [{ kind: "gradual_selling", words: "the developer sold gradually", reviewed: true, receipts: [{ source: "Solana chain", value: 12.5, link: "https://solscan.io/tx/abc", asOfMs: NOW - 3_600_000, onchain: true }, { source: "X", value: null, link: null, asOfMs: null, onchain: false }] }] };
  it("shows the engine's words with their receipts, marked on chain or reported, linked when they have a link", () => {
    const v = pinraiView(base, NOW)!;
    expect(v.headline).toBe("Observed in the evidence:");
    expect(v.lines[0]).toMatchObject({ words: "the developer sold gradually", reviewed: true });
    expect(v.lines[0]!.receipts.map((r) => r.mark)).toEqual(["●", "○"]);
    expect(v.lines[0]!.receipts[0]).toMatchObject({ text: "Solana chain: 12.5", href: "https://solscan.io/tx/abc" });
    expect(v.lines[0]!.receipts[1]!.href).toBeNull();
    expect(v.readText).toBe("read 2 min ago");
  });
  it("an on-chain receipt with no link keeps its ● (read on chain); only a reported one is ○", () => {
    const v = pinraiView({ ...base, items: [{ kind: "gradual_selling", words: "the developer sold gradually", reviewed: true, receipts: [{ source: "Base chain", value: 1, link: null, asOfMs: NOW - 60_000, onchain: true }, { source: "X", value: null, link: null, asOfMs: null, onchain: false }] }] }, NOW)!;
    expect(v.lines[0]!.receipts.map((r) => [r.mark, r.href])).toEqual([["●", null], ["○", null]]);
  });
  it("says so plainly when nothing was found, when off, when not read yet, and shows nothing without a reading", () => {
    expect(pinraiView(undefined, NOW)).toBeNull();
    expect(pinraiView({ ...base, items: [] }, NOW)!.headline).toMatch(/no sign of the developer's intent was found/);
    expect(pinraiView({ ...base, status: "off" }, NOW)!.headline).toBe("PINRai is switched off.");
    expect(pinraiView({ ...base, status: "not read yet" }, NOW)!.lines).toEqual([]);
    expect(pinraiView({ ...base, status: "not read yet" }, NOW)!.headline).toBe("Not read yet.");
  });
});

describe("the gate view of a bot launch", () => {
  it("says it is a bot launch PINR does not list, and links each wallet with its label and source", () => {
    const g: Gate = { status: "bot", words: [], items: [{ kind: "bot_launch", words: "bought in the creation block by known volume-bot wallets", wallets: [{ id: W, link: `https://solscan.io/account/${W}`, label: "volume bot", source: "a public label list" }] }], creator: null, launchedAtMs: null, source: null, readMs: NOW - 60_000 };
    const v = gateView(g, NOW)!;
    expect(v.headline).toBe("Observed at launch: a bot launch. PINR does not list it.");
    expect(v.lines[0]!.words).toMatch(/volume-bot wallets/);
    expect(v.lines[0]!.links[0]).toEqual({ label: "volume bot 9xQe…VFin (a public label list)", href: `https://solscan.io/account/${W}` });
  });
});

describe("a coin whose funding the engine did not trace says why", () => {
  it("Funders reads the note when it has no facts; with funding facts, or no note, it is as before", async () => {
    const { orbitGroups } = await import("./orbit");
    const note = "Funding not traced: the launcher is a mass launcher and the fee wallet is brand new.";
    const f = (ev: unknown) => orbitGroups(ev as never, 1_000_000).find((g) => g.id === "funders")!;
    expect(f({ rows: [], fundingNote: note }).empty).toBe(note);
    expect(f({ rows: [] }).empty).toBe("Where the creator's money came from: not checked yet.");
    expect(f(null).empty).toBe("Where the creator's money came from: not checked yet.");
  });
});
