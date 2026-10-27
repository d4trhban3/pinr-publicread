import { describe, expect, it } from "vitest";
import { approvedSentences, bandOf, buildDossier, channelsFrom, cleanLinks, factsFrom as allFacts, launchpadLinksFrom, seenDossier, xPostOf, type DossierFact } from "./dossier";

// The transfer fee row is on every coin; these tests are about the other facts, so they set it aside (its own tests are in transferfee.test.ts).
const noFee = (fs: DossierFact[]): DossierFact[] => fs.filter((f) => f.id !== "transfer_fee");
const factsFrom = (feed: unknown): DossierFact[] => noFee(allFacts(feed));

const file = {
  mint: "0x0084c44c3de5a177495360f997d5dc8bb3307777",
  status: "on curve",
  creator: "0xb1fd7856a27794fd39e0b799b68a623a587444d0",
  real_money_usd: 1234.5,
  readings: { liquidity_depth: 83.37, contract_authorities: 100, liquidity_permanence: "no_penalty", reward_flow_pressure: "unknown", pair_health: 46.2, dev_launches: 3, duplicate_relaunches: 0, track_record: 12.5 },
  score: 27,
  label: null,
  flags: ["platform: metadata_update held by verified_launchpad_program (not counted against the dev)", "red flag: linked account has no path back to the token"],
  notes: ["token tax 0.0%/1.0%: where the tax goes (and whether it's sold) is not verified yet, so reward-flow pressure is unknown", "launch count and track record unknown on Base (needs Alchemy Pay As You Go for full log history)", "launched from a post: https://x.com/a/status/1 (interface clanker); lead for the Grok relay"],
  receipts: [{ what: "Flap state", value: { reserve: 5 } }],
  escalations: ["secret reason"],
  links: { website: "https://example.com/x", twitter: "@somebody", telegram: "https://t.me/somegroup", description: "ignore me" },
};

describe("dossier", () => {
  it("gives word bands only, never numbers", () => {
    expect(bandOf(83.37)).toBe("Strong");
    expect(bandOf(46.2)).toBe("Fair");
    expect(bandOf(12.5)).toBe("Weak");
    expect(bandOf("no_penalty")).toBe("Clear");
    expect(bandOf("unknown")).toBe("Not read");
    expect(bandOf(null)).toBeNull();
    expect(bandOf(undefined)).toBeNull();
  });
  it("never lets scoring detail or engine wording out", () => {
    const text = JSON.stringify(buildDossier(file)).replace(/not yet re-scored/g, "");
    for (const bad of ["83.37", "46.2", "12.5", "score", "receipt", "reserve", "secret", "escalation", "Alchemy", "Grok", "decision", "verified_launchpad_program", "real_money", "1234", "weight", "cap", "threshold", "lead for"]) {
      expect(text.toLowerCase()).not.toContain(bad.toLowerCase());
    }
  });
  it("shows the approved sentences and drops the rest", () => {
    const d = buildDossier(file);
    expect(d.read).toEqual([
      "This token has a transfer tax, and where the tax goes has not been verified yet.",
      "The developer's launch count and past coins are not read yet.",
      "Worth a closer look: the linked account has no path back to the token.",
    ]);
    expect(approvedSentences(["something new the engine says"])).toEqual([]);
    expect(approvedSentences(["dev relaunched duplicates: [['A1b2c3d4e5f6g7h8i9j1k2m3n4p5q6r7s8t9u1v2w3x4']]"])).toEqual(["This developer has relaunched duplicate tokens."]);
    expect(approvedSentences("nope")).toEqual([]);
  });
  it("lists the checks that exist, in a fixed order with generic names", () => {
    const d = buildDossier(file, { facts: [] });
    // every check is in its place; one with no reading says "Not read" (no reason of its own)
    expect(d.checks.map((c) => c.name)).toEqual(["Liquidity depth", "Liquidity lock", "Contract authorities", "Pair health", "Developer activity", "Creator holdings", "Developer's past coins", "Reward flow", "Top holders", "Social link"]);
    expect(d.checks.find((c) => c.name === "Reward flow")!.band).toBe("Not read");
    expect(d.checks.find((c) => c.name === "Developer activity")).toEqual({ name: "Developer activity", band: "Not read" });
  });
  it("holds back the check bands for a flagged token", () => {
    const d = buildDossier({ ...file, label: "MAYHEM", score: null });
    expect(d.checks).toEqual([]);
    expect(d.held).toBe("flagged");
    expect(d.facts.length).toBeGreaterThan(0);
  });
  it("a file with no facts shows dashes with 'no source', never a figure from the result file", () => {
    const d = buildDossier(file);
    expect(noFee(d.facts).map((f) => [f.label, f.value, f.noSource])).toEqual([["Launcher wallet", "—", true], ["Launches by the launcher", "—", true], ["Duplicate relaunches", "—", true]]);
    expect(JSON.stringify(d)).not.toContain("0xb1fd7856a27794fd39e0b799b68a623a587444d0");
  });
  it("rebuilds links and refuses anything unsafe", () => {
    expect(cleanLinks(file.links)).toEqual([
      { label: "Website", url: "https://example.com/x" },
      { label: "X", url: "https://x.com/somebody" },
      { label: "Telegram", url: "https://t.me/somegroup" },
    ]);
    expect(cleanLinks({ website: "javascript:alert(1)", twitter: "https://evil.com/somebody", telegram: "x" })).toEqual([]);
    expect(cleanLinks({ website: "https://user:pw@example.com" })).toEqual([]);
    expect(cleanLinks(null)).toEqual([]);
  });
  it("reads a Solana result: venue instead of status, unknown fields ignored", () => {
    const sol = {
      mint: "3idYNqXE4fAJJNUHujGTbQNHCzhH52HwZyGoXBJ2bznW",
      venue: "Pump.fun curve",
      frame: "live scan",
      creator: "XxFawerSahdeB2LWQxKoTXQQwpaQc6dRMSaeiEG98qG",
      real_money_usd: "1.02",
      label: "Pumped and dumped",
      score: 25,
      readings: { liquidity_depth: 0, contract_authorities: 100, authority_holders: { mint: "renounced" }, pump_retained: 55, dev_launches: null },
      notes: ["this token's CREATE was not paid by the on-chain creator (third-party launch tool?): launch count unknown"],
    };
    const d = buildDossier(sol, { facts: [] });
    expect(noFee(d.facts).every((f) => f.noSource)).toBe(true);
    expect(d.checks.filter((c) => c.band !== "Not read").map((c) => [c.name, c.band])).toEqual([["Liquidity depth", "Weak"], ["Contract authorities", "Strong"]]); // the rest were never read: "Not read" 
    expect(d.read).toEqual(["The launch was paid for by a different wallet than the creator (a third-party launch tool may have been used), so the developer's launch count is unknown."]);
    const text = JSON.stringify(d);
    for (const bad of ["authority_holders", "renounced", "pump_retained", "live scan", "1.02", "Pumped"]) expect(text).not.toContain(bad);
  });
  it("facts from the feed carry source, time and link; the launch count says whose count it is, from the feed's own label", () => {
    const W1 = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const W2 = "HDtLFRnUpfnDjVvza14Z1YUXpPpuDa5Gn33SPRYwhhFA";
    const feed = {
      facts: [
        { id: "launched_at", label: "Launched", value: "2026-10-13T17:49:11Z", unit: "time", source: "Pump.fun", read_at: "2026-10-13T17:53:30+00:00", link: "https://solscan.io/tx/abc" },
        { id: "launcher", label: "Launcher wallet", value: W1, unit: "wallet", source: "Pump.fun", read_at: "2026-10-13T17:53:31+00:00", link: `https://solscan.io/account/${W1}` },
        { id: "fee_wallet", label: "Fee wallet (the curve's creator)", value: W2, unit: "wallet", source: "Pump.fun", read_at: "2026-10-13T17:53:31+00:00", link: `https://solscan.io/account/${W2}` },
        { id: "dev_launches", label: "Launches by the fee wallet", value: 460, minimum: true, unit: "tokens created", source: "Pump.fun", read_at: "2026-10-13T17:53:40+00:00", link: `https://pump.fun/profile/${W2}` },
        { id: "mystery", label: "Whatever", value: 1, unit: "x", source: "Pump.fun", read_at: "2026-10-13T17:53:40+00:00", link: "https://pump.fun/x" },
      ],
    };
    const f = factsFrom(feed);
    expect(f.map((x) => x.label)).toEqual(["Launched", "Launcher wallet", "Fee wallet (the curve's creator)", "Launches by the fee wallet"]);
    expect(f[1]).toMatchObject({ value: "9xQeWv…VFin", copy: W1, source: "Pump.fun", link: `https://solscan.io/account/${W1}` });
    expect(f[1]!.readAtMs).toBe(Date.parse("2026-10-13T17:53:31+00:00"));
    expect(f[3]!.value).toBe("460+");
    expect(f.every((x) => !x.noSource)).toBe(true);
  });
  it("a fact missing any of source, time or link, or naming a source off the list, is a dash with 'no source'", () => {
    const base = { id: "dev_launches", label: "Launches by the launcher", value: 12, unit: "tokens created", source: "Pump.fun", read_at: "2026-10-13T17:53:40Z", link: "https://pump.fun/profile/x" };
    const bad = [
      { ...base, source: undefined },
      { ...base, source: "Helius" },
      { ...base, read_at: "yesterday" },
      { ...base, link: undefined },
      { ...base, link: "http://pump.fun/profile/x" },
      { ...base, link: "javascript:alert(1)" },
      { ...base, value: "twelve" },
    ];
    for (const f of bad) expect(factsFrom({ facts: [f] })).toEqual([{ id: "dev_launches", label: "Launches by the launcher", value: "—", noSource: true }]);
    expect(factsFrom({ facts: [base] })[0]).toMatchObject({ value: "12", source: "Pump.fun" });
  });
  it("the feed names the X account `x`; an older result file names it `twitter`; both are read", () => {
    expect(cleanLinks({ x: "https://x.com/feedacct" })).toEqual([{ label: "X", url: "https://x.com/feedacct" }]);
    expect(channelsFrom({ x: "@feedacct" }).find((c) => c.id === "x")).toMatchObject({ status: "listed", url: "https://x.com/feedacct" });
    expect(cleanLinks({ twitter: "@old" })).toEqual([{ label: "X", url: "https://x.com/old" }]);
  });
  it("the feed's links replace the result file's, and are cleaned the same way", () => {
    const d = buildDossier(file, { links: { website: "https://example.org/a", twitter: "@feed", source: "Pump.fun", read_at: "2026-10-13T17:53:20Z" } });
    expect(d.links).toEqual([{ label: "Website", url: "https://example.org/a" }, { label: "X", url: "https://x.com/feed" }]);
  });
  it("no file content means not available", () => {
    expect(buildDossier(null).available).toBe(false);
    expect(buildDossier("x").available).toBe(false);
  });

  it("channels: what the token lists, what it does not, and unknown when the links were not read", () => {
    const c = channelsFrom({ website: "https://example.com/x", twitter: "@somebody", telegram: null, farcaster: "SomeBody" });
    expect(c.map((x) => [x.id, x.status])).toEqual([["x", "listed"], ["telegram", "not_listed"], ["website", "listed"], ["farcaster", "listed"]]);
    expect(c.find((x) => x.id === "farcaster")!.url).toBe("https://warpcast.com/somebody");
    expect(c.find((x) => x.id === "telegram")!.url).toBeUndefined();
    // a Solana-style result has no links at all: nothing was read, which is not the same as "lists nothing"
    expect(channelsFrom(undefined).every((x) => x.status === "unknown")).toBe(true);
    // unsafe links never become listed
    expect(channelsFrom({ website: "javascript:alert(1)", twitter: "https://evil.com/a" }).every((x) => x.status === "not_listed")).toBe(true);
    expect(buildDossier({ ...file, links: undefined }).channels.every((x) => x.status === "unknown")).toBe(true);
  });
  // A reading the engine marks unknown now also says "Not read" (launch item 7), with no reason; a reason is only ever the feed's own.
  it("sections the feed lists in not_read show 'Not read' and its fixed reason, never a band or 'Clear'; the rest keep their band; no sentence is matched", () => {
    const hidden = { ...file, readings: { ...file.readings, dev_conduct: "no_penalty", creator_holdings: 40, track_record: 12.5 }, notes: ["dev hidden behind a launch bot (pump.fun)"] };
    // without a not_read in the feed, nothing is guessed from the engine's sentences
    const none = buildDossier(hidden, { facts: [] });
    expect(none.checks.some((c) => c.band === "Not read" && c.reason !== undefined)).toBe(false);
    expect(none.checks.find((x) => x.name === "Developer activity")!.band).toBe("Clear");
    const d = buildDossier(hidden, { facts: [], not_read: { dev_conduct: "dev not identified", track_record: "launch count not stated", liquidity_permanence: "could not be read", pair_health: "made-up reason" } });
    expect(d.checks.find((x) => x.name === "Developer activity")).toEqual({ name: "Developer activity", band: "Not read", reason: "dev not identified" });
    expect(d.checks.find((x) => x.name === "Developer's past coins")).toEqual({ name: "Developer's past coins", band: "Not read", reason: "launch count not stated" });
    expect(d.checks.find((x) => x.name === "Liquidity lock")).toEqual({ name: "Liquidity lock", band: "Not read", reason: "could not be read" });
    expect(d.checks.find((x) => x.name === "Pair health")).toEqual({ name: "Pair health", band: "Not read" }); // a reason outside the fixed list is not shown
    expect(d.checks.find((x) => x.name === "Creator holdings")!.band).toBe("Fair"); // a graded section not in not_read keeps its band
  });
  it("Top holders: not read says its reason, read and clear says Clear, a fired brake is graded (Weak) and named by the approved sentence; an old file without the key says Not read, with no reason", () => {
    const row = (d: ReturnType<typeof buildDossier>) => d.checks.find((x) => x.name === "Top holders");
    expect(row(buildDossier({ ...file, readings: { ...file.readings, top_holders: "unknown" } }, { facts: [], not_read: { top_holders: "could not be read" } }))).toEqual({ name: "Top holders", band: "Not read", reason: "could not be read" });
    expect(row(buildDossier({ ...file, readings: { ...file.readings, top_holders: "no_penalty" } }, { facts: [] }))).toEqual({ name: "Top holders", band: "Clear" });
    const fired = buildDossier({ ...file, readings: { ...file.readings, top_holders: 0 }, notes: ["top holders: the rug-circle brake fired (45% of the top 20 are wallets PINR remembers from earlier rugs)"] }, { facts: [] });
    expect(row(fired)).toEqual({ name: "Top holders", band: "Weak" });
    expect(fired.read).toContain("Top holders · a limit applied on who holds this coin; see the score's flags");
    expect(JSON.stringify(fired)).not.toMatch(/45%|rug-circle|remembers/);
    expect(row(buildDossier(file, { facts: [] }))).toEqual({ name: "Top holders", band: "Not read" });
  });

  it("dev_wallet is a known fact id and takes the feed's label", () => {
    const W = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const f = factsFrom({ facts: [{ id: "dev_wallet", label: "Wallet scored as the developer (the fees were moved here)", value: W, unit: "wallet", source: "Solana chain", read_at: "2026-10-13T17:53:31Z", link: `https://solscan.io/account/${W}` }] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ id: "dev_wallet", label: "Wallet scored as the developer (the fees were moved here)", source: "Solana chain", copy: W });
  });
  it("an X link that is a post is shown as a post by its author, never as the token's account", () => {
    expect(xPostOf("https://x.com/someone/status/1234567890")).toEqual({ author: "someone", url: "https://x.com/someone/status/1234567890" });
    expect(xPostOf("https://x.com/someone")).toBeNull();
    expect(xPostOf("http://x.com/someone/status/1")).toBeNull();
    expect(xPostOf("https://evil.com/someone/status/1")).toBeNull();
    expect(cleanLinks({ x: "https://x.com/someone/status/1234567890" })).toEqual([{ label: "X post by @someone", url: "https://x.com/someone/status/1234567890" }]);
    const ch = channelsFrom({ x: "https://x.com/someone/status/1234567890" }).find((c) => c.id === "x")!;
    expect(ch).toMatchObject({ status: "listed", post: "someone", url: "https://x.com/someone/status/1234567890" });
    expect(channelsFrom({ x: "https://x.com/someone" }).find((c) => c.id === "x")!.post).toBeUndefined();
  });
  it("an old-format feed file (no `facts` at all): only where the engine says the developer is hidden, an ungraded developer section says 'Not read · not yet re-scored'; everything else keeps its grade or 'Clear'", () => {
    const old = { ...file, readings: { ...file.readings, dev_conduct: "no_penalty", creator_holdings: "unknown", track_record: 12.5 } };
    // developer not hidden: nothing is relabelled
    for (const feed of [null, {}, { name: "x" }]) {
      const d = buildDossier(old, feed);
      expect(d.checks.find((x) => x.name === "Developer activity")!.band).toBe("Clear");
      expect(d.checks.find((x) => x.name === "Creator holdings")!.band).toBe("Not read");
      expect(d.checks.some((x) => x.band === "Not read" && x.reason !== undefined)).toBe(false);
    }
    // developer hidden (the engine's sentence), old format
    const hidden = { ...old, notes: ["dev hidden behind a launch bot (pump.fun)"] };
    for (const feed of [null, {}]) {
      const d = buildDossier(hidden, feed);
      expect(d.checks.find((x) => x.name === "Developer activity")).toEqual({ name: "Developer activity", band: "Not read", reason: "not yet re-scored" });
      expect(d.checks.find((x) => x.name === "Creator holdings")).toEqual({ name: "Creator holdings", band: "Not read", reason: "not yet re-scored" });
      expect(d.checks.find((x) => x.name === "Developer's past coins")!.band).toBe("Weak"); // graded: keeps its band
      expect(d.checks.find((x) => x.name === "Liquidity lock")!.band).toBe("Clear");
    }
    // a new-format file never uses the sentences
    expect(buildDossier(hidden, { facts: [] }).checks.some((x) => x.band === "Not read" && x.reason !== undefined)).toBe(false);
  });
  it("an X link that is a post is shown as a post by its author, never as the token's account", () => {
    expect(xPostOf("https://x.com/someone/status/1234567890")).toEqual({ author: "someone", url: "https://x.com/someone/status/1234567890" });
    expect(xPostOf("https://x.com/someone")).toBeNull();
    expect(xPostOf("http://x.com/someone/status/1")).toBeNull();
    expect(xPostOf("https://evil.com/someone/status/1")).toBeNull();
    expect(cleanLinks({ x: "https://x.com/someone/status/1234567890" })).toEqual([{ label: "X post by @someone", url: "https://x.com/someone/status/1234567890" }]);
    const ch = channelsFrom({ x: "https://x.com/someone/status/1234567890" }).find((c) => c.id === "x")!;
    expect(ch).toMatchObject({ status: "listed", post: "someone", url: "https://x.com/someone/status/1234567890" });
    expect(channelsFrom({ x: "https://x.com/someone" }).find((c) => c.id === "x")!.post).toBeUndefined();
  });
  it("the five ids added (price, market cap, liquidity, 24-hour volume, venue) are shown with their receipts", () => {
    const base = { source: "DexScreener", read_at: "2026-10-13T17:53:40Z", link: "https://dexscreener.com/solana/abc" };
    const f = factsFrom({
      facts: [
        { id: "price_usd", label: "Price", value: 0.00000601, unit: "USD", ...base },
        { id: "market_cap", label: "Market cap", value: 36238, unit: "USD", ...base },
        { id: "liquidity_usd", label: "Liquidity", value: 15538.4, unit: "USD", source: "Solana chain", read_at: "2026-10-13T17:53:40Z", link: "https://solscan.io/account/vault" },
        { id: "volume_24h", label: "24-hour volume", value: 13200, unit: "USD", ...base },
        { id: "venue", label: "Trading venue", value: "PumpSwap (graduated)", unit: "text", source: "Solana chain", read_at: "2026-10-13T17:53:40Z", link: "https://pump.fun/coin/x" },
        { id: "venue", label: "dup" },
      ],
    });
    expect(f.map((x) => [x.id, x.value, x.source])).toEqual([
      ["price_usd", "$0.00000601", "DexScreener"],
      ["market_cap", "$36,238", "DexScreener"],
      ["liquidity_usd", "$15,538", "Solana chain"],
      ["volume_24h", "$13,200", "DexScreener"],
      ["venue", "PumpSwap (graduated)", "Solana chain"],
    ]);
    expect(factsFrom({ facts: [{ id: "venue", label: "Trading venue", value: "<script>", unit: "text", ...base }] })[0]).toMatchObject({ value: "—", noSource: true });
  });

  it("Jupiter's token data, Stonk.fun's records and DexScreener's promotion are shown with their receipts, in their units", () => {
    const at = "2026-10-18T15:51:00Z";
    const jup = { source: "Jupiter", read_at: at, link: "https://jup.ag/tokens/M" };
    const stonk = { source: "Stonk.fun", read_at: at, link: "https://www.stonkfun.xyz/token/M" };
    const dex = { source: "DexScreener", read_at: at, link: "https://dexscreener.com/solana/M" };
    const f = factsFrom({
      facts: [
        { id: "holder_count", label: "Holders", value: 1532, unit: "wallets", ...jup },
        { id: "top_holders_share", label: "Top holders' share", value: 23.456, unit: "percent", ...jup },
        { id: "dev_mints", label: "Coins minted by the dev (Jupiter's count)", value: 4, unit: "tokens created", ...jup },
        { id: "organic_score", label: "Organic score", value: 71.8, unit: "of 100", band: "medium", ...jup },
        { id: "jupiter_verified", label: "Verified on Jupiter", value: "no", unit: "text", ...jup },
        { id: "buys_24h", label: "Buys (24 h)", value: 812, unit: "trades", ...jup },
        { id: "mint_authority_jupiter", label: "Mint authority (Jupiter's audit)", value: "disabled", unit: "text", ...jup },
        { id: "launchpad_transfer_fee", label: "Transfer fee (Stonk.fun's record)", value: 125, unit: "basis points", ...stonk },
        { id: "rewards_paid", label: "Rewards paid to holders", value: 12.3456, unit: "SOL", basis: "ledger", ...stonk },
        { id: "rewards_last_payout", label: "Last payout", value: "2026-10-18T15:40:00Z", unit: "time", ...stonk },
        { id: "fee_share_creator", label: "Fee share to the creator", value: 5000, unit: "basis points", ...stonk },
        { id: "dex_paid_orders", label: "Paid DexScreener orders", value: 2, unit: "orders", kinds: ["tokenProfile", "communityTakeover", "<b>"], ...dex },
        { id: "dex_boosts", label: "DexScreener boosts", value: 0, unit: "boosts", ...dex },
      ],
    });
    expect(f.map((x) => [x.id, x.value, x.source])).toEqual([
      ["holder_count", "1,532", "Jupiter"],
      ["top_holders_share", "23.46%", "Jupiter"],
      ["dev_mints", "4", "Jupiter"],
      ["organic_score", "72 of 100", "Jupiter"],
      ["jupiter_verified", "no", "Jupiter"],
      ["buys_24h", "812", "Jupiter"],
      ["mint_authority_jupiter", "disabled", "Jupiter"],
      ["launchpad_transfer_fee", "1.25%", "Stonk.fun"],
      ["rewards_paid", "12.35 SOL", "Stonk.fun"],
      ["rewards_last_payout", "2026-10-18 15:40 UTC", "Stonk.fun"],
      ["fee_share_creator", "50%", "Stonk.fun"],
      ["dex_paid_orders", "2", "DexScreener"],
      ["dex_boosts", "0", "DexScreener"],
    ]);
    expect(f.find((x) => x.id === "organic_score")!.lines).toEqual(["Jupiter's band: medium"]);
    expect(f.find((x) => x.id === "dex_paid_orders")!.lines).toEqual(["Kinds: tokenProfile, communityTakeover"]);
    expect(f.find((x) => x.id === "dex_boosts")!.lines).toBeUndefined();
  });
  it("a figure outside its unit's range, or a source off the list, is a dash with 'no source', never a number", () => {
    const r = { read_at: "2026-10-18T15:51:00Z", link: "https://jup.ag/tokens/M" };
    const f = factsFrom({
      facts: [
        { id: "top_holders_share", value: 140, unit: "percent", source: "Jupiter", ...r },
        { id: "organic_score", value: 101, unit: "of 100", band: "made up", source: "Jupiter", ...r },
        { id: "launchpad_transfer_fee", value: 12.5, unit: "basis points", source: "Stonk.fun", ...r },
        { id: "holder_count", value: 10, unit: "wallets", source: "Helius", ...r },
      ],
    });
    expect(f.map((x) => [x.id, x.value, !!x.noSource])).toEqual([
      ["holder_count", "—", true],
      ["top_holders_share", "—", true],
      ["organic_score", "—", true],
      ["launchpad_transfer_fee", "—", true],
    ]);
  });
  it("launchpad_links is Stonk.fun's list beside the coin's own links, cleaned, with its receipt; absent when empty, unsourced or untimed", () => {
    const feed = { facts: [], links: { website: "https://own.example/" }, launchpad_links: { website: "https://stonk.example/", x: "https://x.com/stonkcoin", telegram: "javascript:alert(1)", source: "Stonk.fun", read_at: "2026-10-18T15:51:00Z" } };
    expect(launchpadLinksFrom(feed)).toEqual({ source: "Stonk.fun", readAtMs: Date.parse("2026-10-18T15:51:00Z"), links: [{ label: "Website", url: "https://stonk.example/" }, { label: "X", url: "https://x.com/stonkcoin" }] });
    const d = buildDossier({ score: 10, readings: {} }, feed);
    expect(d.links).toEqual([{ label: "Website", url: "https://own.example/" }]);
    expect(d.launchpadLinks?.links.length).toBe(2);
    expect(seenDossier({ ...feed, seen: true }).launchpadLinks?.source).toBe("Stonk.fun");
    expect(launchpadLinksFrom({ launchpad_links: {} })).toBeUndefined();
    expect(launchpadLinksFrom({ launchpad_links: { website: "https://a.example/", source: "Pump.fun", read_at: "2026-10-18T15:51:00Z" } })).toBeUndefined();
    expect(launchpadLinksFrom({ launchpad_links: { website: "https://a.example/", source: "Stonk.fun" } })).toBeUndefined();
    expect(buildDossier({ score: 10, readings: {} }, { facts: [] }).launchpadLinks).toBeUndefined();
  });
});
