import { describe, expect, it } from "vitest";
import { buildDossier } from "./dossier.ts";
import { intentFrom, plainSource, plainValue, receiptLink } from "./intentview.ts";

const SIG = "5".repeat(88);
const good = {
  status: "read",
  read_at: "2026-10-21T20:00:00Z",
  model: "claude-haiku-5-5",
  cost_usd: 0.002,
  dropped: [{ kind: "misleading_claim", reason: "no receipt" }],
  calibration_version: "v1",
  review: { model: "x", status: "ok", verdicts: [{ kind: "vesting_lock", verdict: "supported", reason: "the lock is on chain" }] },
  items: [
    {
      kind: "vesting_lock",
      why: "The team tokens are locked for a year.",
      evidence: [],
      receipts: [
        { id: 1, what: "vesting lock", value: "12 months", source: `tx ${SIG}`, as_of: "2026-10-21T19:00:00Z", on_chain: true },
        { id: 2, what: "the dev's post", value: "<b>locked</b>", source: "https://x.com/dev/status/1", as_of: "2026-10-21T19:01:00Z", on_chain: false },
        { id: 3, what: "a note", source: "Pump.fun record", as_of: 1_792_000_000 },
        { what: "", source: "nothing" },
      ],
    },
    { kind: "not_a_kind", why: "ignored", receipts: [] },
  ],
};

describe("PINRbot's read on DeepScan", () => {
  it("shows a read coin: plain kind, receipts (no note from the model) with links only where a post address or a transaction is named", () => {
    const v = intentFrom({ pinrbot: good })!;
    expect(v.kept).toBe(false);
    expect(v.items).toHaveLength(1);
    const it = v.items[0]!;
    expect([it.label, it.reviewed]).toEqual(["A vesting lock", true]);
    expect(it.receipts.map((r) => r.link)).toEqual([`https://solscan.io/tx/${SIG}`, "https://x.com/dev/status/1", undefined]);
    expect(it.receipts[0]!.onChain).toBe(true);
    expect(it.receipts[1]!.value).toBe("<b>locked</b>"); // kept as text; the page sets it with textContent, never as HTML
    expect(it.receipts).toHaveLength(3); // the receipt with no name is dropped
  });
  it("never carries the dropped items, the cost, the model, the calibration or the review's reasons", () => {
    const text = JSON.stringify(intentFrom({ pinrbot: good }));
    for (const w of ["dropped", "cost_usd", "claude-haiku", "calibration", "The team tokens are locked", "favour", "the lock is on chain", "no receipt", "not_a_kind"]) expect(text).not.toContain(w);
  });
  it('shows nothing for "off", "not read", a missing or malformed reading', () => {
    for (const status of ["off", "not read: no key", "not read yet", ""]) expect(intentFrom({ pinrbot: { ...good, status } })).toBeNull();
    for (const bad of [undefined, null, "read", 5, []]) expect(intentFrom({ pinrbot: bad })).toBeNull();
    expect(intentFrom(null)).toBeNull();
  });
  it("marks a kept earlier reading, and says so when it found nothing", () => {
    const v = intentFrom({ pinrbot: { status: "kept reading of 2026-10-21", items: [] } })!;
    expect(v.kept).toBe(true);
    expect(v.items).toEqual([]);
  });
  it("shows a held finding at once with its evidence, marked not reviewed, and never its note", () => {
    const held = { kind: "impersonation", why: "SECRET NOTE", evidence: [], receipts: [{ what: "the coin's text", value: "official PINR token", source: "Pump.fun", as_of: "2026-10-21T19:00:00Z" }] };
    const v = intentFrom({ pinrbot: { status: "read", items: [], pending: [held] } })!;
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ label: "Impersonation of another project", reviewed: false });
    expect(v.items[0]!.receipts[0]).toMatchObject({ what: "the coin's text", value: "official PINR token", source: "Pump.fun" });
    expect(JSON.stringify(v)).not.toContain("SECRET NOTE");
    // a counted item the review has not called supported is shown, not reviewed; one it called supported is reviewed
    const both = intentFrom({ pinrbot: { ...good, items: [...good.items, { kind: "gradual_selling", receipts: [] }] } })!;
    expect(both.items.map((i) => [i.label, i.reviewed])).toEqual([["A vesting lock", true], ["Gradual selling by the developer", false]]);
    expect(intentFrom({ pinrbot: { status: "read", items: [{ kind: "survived_30d", reviewed: true, receipts: [] }] } })!.items[0]!.reviewed).toBe(true);
  });
  it("a held kind already counted is not shown twice, and a read with nothing has no items", () => {
    const v = intentFrom({ pinrbot: { status: "read", items: [{ kind: "vesting_lock", receipts: [] }], pending: [{ kind: "vesting_lock", receipts: [] }] } })!;
    expect(v.items).toHaveLength(1);
    expect(intentFrom({ pinrbot: { status: "read", items: [], pending: [] } })!.items).toEqual([]);
  });
  it("gives a link only for an https post address or a transaction signature", () => {
    expect(receiptLink("http://x.com/a")).toBeUndefined();
    expect(receiptLink("javascript:alert(1)")).toBeUndefined();
    expect(receiptLink("tx short")).toBeUndefined();
    expect(receiptLink(`CREATE tx ${SIG}`)).toBe(`https://solscan.io/tx/${SIG}`);
    expect(receiptLink(`Pump.fun creation transaction ${SIG}`)).toBe(`https://solscan.io/tx/${SIG}`);
  });
});

describe("the dossier with the new fields", () => {
  const raw = { mint: "M", score: 50, display: "50", label: null, readings: { top_holders: 80, liquidity_depth: 30 }, pinrbot: good };
  const feed = {
    check_sources: {
      top_holders: { source: "Pump.fun", read_at: "2026-10-21T20:00:00Z", url: "https://pump.fun/coin/M" },
      liquidity_depth: { source: "Made-up Source", read_at: "2026-10-21T20:00:00Z", url: "https://example.com/x" },
    },
    facts: [
      { id: "funding_source", value: "fresh dev wallet, funded by a busy wallet", unit: "text", source: "Solana chain", read_at: "2026-10-21T20:00:00Z", link: "https://solscan.io/tx/abc" },
    ],
  };
  it("puts a complete receipt on the check, and none where the source is off the list or a part is missing", () => {
    const d = buildDossier(raw, feed);
    const by = Object.fromEntries(d.checks.map((c) => [c.name, c]));
    expect(by["Top holders"]).toMatchObject({ source: "Pump.fun", link: "https://pump.fun/coin/M" });
    expect(by["Top holders"]!.readAtMs).toBeGreaterThan(0);
    expect(by["Liquidity depth"]!.source).toBeUndefined();
  });
  it("shows the funding-source answer with its receipt, and 'not read yet' when it has no link", () => {
    const f = buildDossier(raw, feed).facts.find((x) => x.id === "funding_source")!;
    expect(f).toMatchObject({ value: "fresh dev wallet, funded by a busy wallet", source: "Solana chain", link: "https://solscan.io/tx/abc" });
    const nr = buildDossier(raw, { facts: [{ id: "funding_source", value: "not read", unit: "text" }] }).facts.find((x) => x.id === "funding_source")!;
    expect(nr).toMatchObject({ value: "—", notRead: true });
    const odd = buildDossier(raw, { facts: [{ ...feed.facts[0], value: "<script>x</script>" }] }).facts.find((x) => x.id === "funding_source")!;
    expect(odd).toMatchObject({ value: "—", noSource: true });
  });
  it("carries PINRbot's read, but not on a flagged coin", () => {
    expect(buildDossier(raw, feed).intent?.items).toHaveLength(1);
    expect(buildDossier({ ...raw, label: "BOT/RUG", display: "BOT/RUG" }, feed).intent).toBeUndefined();
    expect(buildDossier({ ...raw, pinrbot: undefined }, feed).intent).toBeUndefined();
  });
});

describe("receipts in plain words (checklists 7 and 13: no raw engine notes on the page)", () => {
  it("turns the engine's record text into words, and a chain read named by its method into \"Solana chain\"", () => {
    const wallets = JSON.stringify({ "75atx2W4poAzyULnLz1MQPN3CHBLmuv4Zs281BxbA52G": "bundled buy (same block as creation)", GGHfu6SWwA3YUuBXdBah7ZYZ3sFgHZtjKQnwnC2HUqxc: "bundled buy (same block as creation)", "7hvGwqntiXMYSCRTqhnVpQNRSB2VisxzcFD9g9RaBNK": "funded sniper" });
    expect(plainValue(wallets)).toBe("2 wallets: bundled buy (same block as creation); 1 wallet: funded sniper");
    expect(plainValue(JSON.stringify({ members: 8, acquired: 179798195.48765, half_out_after_s: 4 }))).toBe("8 wallets · 179.8M tokens acquired · half sent on after 4 s");
    expect(plainValue(JSON.stringify({ members: 1, acquired: 22999, half_out_after_s: null }))).toBe("1 wallet · 23.0K tokens acquired"); // missing stays missing
    expect(plainValue("0")).toBe("0");
    expect(plainValue("{not json")).toBeNull(); // never shown as code
    expect(plainSource("getTokenAccountsByOwner 3yu2JV3GTS8TCYNw11qmWwcfH7ZH2P7EDRPySxLi6PZQ")).toBe("Solana chain");
    expect(plainSource("dev group token accounts")).toBe("dev group token accounts");
    const v = intentFrom({ pinrbot: { status: "read", items: [{ kind: "coordinated_manipulation", receipts: [{ what: "dev conduct (group)", source: "getTokenAccountsByOwner abc", value: 1 }] }] } })!;
    expect(v.items[0]!.receipts[0]).toMatchObject({ what: "developer activity (group)", source: "Solana chain" });
    for (const v of [wallets, JSON.stringify({ members: 8, acquired: 1, half_out_after_s: 4 })]) expect(plainValue(v)).not.toMatch(/[{}"_]/);
  });
});
