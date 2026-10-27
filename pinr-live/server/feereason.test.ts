import { describe, expect, it } from "vitest";
import { factsFrom } from "./dossier";
import { reasonItem } from "./feereason";

const MINT = "So1aNaTestMint1111111111111111111111111111";
const W1 = "DevWa11et1111111111111111111111111111111111";
const W2 = "DevWa11et2222222222222222222222222222222222";
const COLLECTOR = "Co11ector111111111111111111111111111111111";
const receipt = { source: "Solana chain", read_at: "2026-10-17T12:00:00Z", link: `https://solscan.io/token/${MINT}` };
const fee = (over: Record<string, unknown>): Record<string, unknown> => ({ id: "transfer_fee", label: "Transfer fee", unit: "percent", ...receipt, ...over });
const first = (facts: unknown[]): ReturnType<typeof factsFrom>[number] => factsFrom({ facts })[0]!;

describe("the fee's case on DeepScan", () => {
  it("names the case in plain words: reason found, no reason (with why), not checked yet", () => {
    expect(first([fee({ value: 5, fee_kind: "outside_norm", fee_case: "reason_found", holders_paid: 42 })]).lines).toEqual([
      "Reason found on chain: the fees were paid back to 42 holders outside the dev group, and the contract's powers are renounced.",
    ]);
    expect(first([fee({ value: 5, fee_kind: "outside_norm", fee_case: "not_checked" })]).lines).toEqual([
      "Reason not checked yet: the fee's history could not be read. It is checked again at the next look.",
    ]);
    // the team's T1 ruling: a list of short items, held powers first, none dropped
    const why = [
      { kind: "holders_reached", holders: 0 },
      { kind: "power_held", power: "mint", holder: "dev" },
      { kind: "power_held", power: "freeze", holder: "dev" },
      { kind: "dev_payouts", wallets: 2, transfers: 7 },
      { kind: "power_held", power: "permanent_delegate", holder: "linked" },
      { kind: "power_held", power: "fee_rate_control", holder: "unexplained" },
      { kind: "paid_not_holding", wallets: 1 },
      { kind: "paid_unread", wallets: 2 },
      { kind: "not_traced", transfers: 4 },
      { kind: "no_withdrawal_seen" },
      { kind: "something_new", note: "x" },
    ];
    const f = first([fee({ value: 15, fee_kind: "outside_norm", fee_case: "no_reason", reason_why: why })]);
    expect(f.lines).toEqual([
      "No reason found on chain:",
      "• mint held by the dev",
      "• freeze held by the dev",
      "• permanent delegate held by a linked wallet",
      "• fee-rate control held by an unexplained wallet",
      "• fees reached 0 holders outside the dev group",
      "• fees paid to the dev group: 7 transfers to 2 wallets",
      "• 1 paid wallet did not hold the coin",
      "• 2 paid wallets could not be read",
      "• 4 transfers not traced to this coin's fees",
      "• no withdrawal of withheld fees seen",
      "• another finding this page cannot name yet",
    ]);
    expect(f.badge).toBe("High fee");
  });

  it("shows 'High fee' only over 10%, and never when a reason was found", () => {
    const at = (value: number, fee_case: string): unknown => first([fee({ value, fee_kind: "outside_norm", fee_case })]).badge;
    expect([at(10, "no_reason"), at(10.5, "no_reason"), at(25, "not_checked"), at(25, "reason_found"), at(9, "not_checked")]).toEqual([undefined, "High fee", "High fee", undefined, undefined]);
  });

  it("a case that does not fit the fee is left out (the fee still shows); a rewards fee or no fee adds no line", () => {
    const wrong = first([fee({ value: 5, fee_kind: "outside_norm", fee_case: "rewards_standard" })]);
    expect(wrong.value).toBe("5% · not a launchpad rewards fee");
    expect(wrong.lines).toBeUndefined();
    expect(first([fee({ value: 0, fee_kind: "none", fee_case: "none" })]).lines).toBeUndefined();
    expect(first([fee({ value: 1, fee_kind: "rewards_standard", program: "Stonk.fun reward mode", standard_pct: 1, standard_basis: "settings", fee_case: "reason_found" })]).lines).toBeUndefined();
    expect(first([fee({ value: 5, fee_kind: "outside_norm", fee_case: "something" })]).lines).toBeUndefined();
  });

  it("names an item it does not know as such rather than drop it, and a power without its holder still shows", () => {
    expect(reasonItem({ kind: "power_held", power: "pause" }).text).toBe("pause held");
    expect(reasonItem({ kind: "power_held", power: "rug" }).text).toBe("another finding this page cannot name yet");
    expect(reasonItem("text").text).toBe("another finding this page cannot name yet");
    expect(reasonItem({ kind: "no_withdraw_authority" }).text).toBe("no wallet can withdraw the fees the coin holds back");
    expect(reasonItem({ kind: "withdrawn", amount: 1234.5 }).text).toBe("1,234.5 of the coin withdrawn as withheld fees");
    expect(first([fee({ value: 5, fee_kind: "outside_norm", fee_case: "no_reason", reason_why: "an old sentence" })]).lines).toEqual(["No reason found on chain."]);
  });

  it("fees paid to the dev group: a row of its own right after the fee, with the wallets to look at", () => {
    const dev = { id: "fee_dev_payouts", label: "Fees paid to the dev group", value: 7, unit: "transfers", wallets: [W1, W2], source: "Solana chain", read_at: receipt.read_at, link: `https://solscan.io/account/${COLLECTOR}` };
    const facts = factsFrom({ facts: [fee({ value: 5, fee_kind: "outside_norm", fee_case: "no_reason" }), dev] });
    expect(facts[1]).toMatchObject({ id: "fee_dev_payouts", value: "7 transfers to 2 wallets", link: dev.link });
    expect(facts[1]!.moreLinks!.links.map((l) => l.url)).toEqual([`https://solscan.io/account/${W1}`, `https://solscan.io/account/${W2}`]);
    expect(factsFrom({ facts: [{ ...dev, wallets: ["0xnot"] }] })[1]).toMatchObject({ value: "—", noSource: true });
    expect(factsFrom({ facts: [{ ...dev, link: undefined }] })[1]).toMatchObject({ value: "—", noSource: true });
    expect(factsFrom({ facts: [] }).some((f) => f.id === "fee_dev_payouts")).toBe(false);
  });
});
