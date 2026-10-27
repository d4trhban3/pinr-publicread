import { describe, expect, it } from "vitest";
import { factsFrom } from "./dossier";
import { feeFromFact, feeLong, feeShort } from "./transferfee";
import { translate } from "./translate";
import { stripVamp } from "./vamp";

const MINT = "So1aNaTestMint1111111111111111111111111111";
const receipt = { source: "Solana chain", read_at: "2026-10-17T12:00:00Z", link: `https://solscan.io/token/${MINT}` };
const fact = (over: Record<string, unknown>): Record<string, unknown> => ({ id: "transfer_fee", label: "Transfer fee", unit: "percent", ...receipt, ...over });

describe("the transfer fee", () => {
  it("reads every kind, and the plain words say what the fee is and whose it is", () => {
    const P = { program: "Stonk.fun reward mode", standard_pct: 1, standard_basis: "settings" };
    const none = feeFromFact(fact({ value: 0, fee_kind: "none" }))!;
    const reward = feeFromFact(fact({ value: 1, fee_kind: "rewards_standard", ...P }))!;
    const below = feeFromFact(fact({ value: 0.5, fee_kind: "rewards_standard", ...P }))!;
    const unknown = feeFromFact(fact({ value: 5, fee_kind: "standard_unknown", program: "Stonk.fun reward mode" }))!;
    const above = feeFromFact(fact({ value: 5, fee_kind: "outside_norm", ...P }))!;
    const other = feeFromFact(fact({ value: 2.5, fee_kind: "outside_norm" }))!;
    const observed = feeFromFact(fact({ value: 1, fee_kind: "rewards_standard", ...P, standard_basis: "observed", standard_links: ["https://solscan.io/token/A", "https://solscan.io/token/B"] }))!;
    expect([none, reward, below, unknown, above, other, observed].map(feeLong)).toEqual([
      "None",
      "1% · Stonk.fun reward mode, at its standard rate",
      "0.5% · Stonk.fun reward mode, below its standard 1%",
      "5% · Stonk.fun reward mode; its standard rate was not read",
      "5% · above Stonk.fun reward mode's standard 1%",
      "2.5% · not a launchpad rewards fee",
      "1% · Stonk.fun reward mode, at its observed standard rate",
    ]);
    // B1: at or below the standard is "rewards"; U1: an unknown standard shows as rewards; only above is "above rate"
    expect([none, reward, below, unknown, above, other].map(feeShort)).toEqual(["", "1% rewards", "0.5% rewards", "5% rewards", "5% above rate", "2.5% not rewards"]);
    expect(observed.standardLinks).toEqual(["https://solscan.io/token/A", "https://solscan.io/token/B"]);
  });

  it("refuses a fee whose fields disagree: nothing is guessed", () => {
    const bad = [
      { value: 0, fee_kind: "outside_norm" }, // a kind with a fee needs a fee
      { value: 1, fee_kind: "none" }, // "none" is 0 only
      { value: 2, fee_kind: "rewards_standard", program: "Stonk.fun reward mode", standard_pct: 1, standard_basis: "settings" }, // above the standard is not standard
      { value: 1, fee_kind: "rewards_standard" }, // a rewards fee names its program and rate
      { value: 1, fee_kind: "rewards_standard", program: "Stonk.fun reward mode" }, // without its rate it is standard_unknown
      { value: 1, fee_kind: "outside_norm", program: "Stonk.fun reward mode", standard_pct: 1, standard_basis: "settings" }, // at the standard is not outside it
      { value: 1, fee_kind: "outside_norm", program: "Stonk.fun reward mode" }, // above an unknown standard cannot be said
      { value: 1, fee_kind: "standard_unknown" }, // a program's fee names the program
      { value: 1, fee_kind: "standard_unknown", program: "Stonk.fun reward mode", standard_pct: 1, standard_basis: "settings" }, // a known standard is not unknown
      { value: 1, fee_kind: "rewards_standard", program: "Stonk.fun reward mode", standard_pct: 1 }, // a standard says where it comes from
      { value: 1, fee_kind: "rewards_standard", program: "Stonk.fun reward mode", standard_pct: 1, standard_basis: "observed" }, // an observed one carries its launches
      { value: 1, fee_kind: "rewards_standard", program: "Stonk.fun reward mode", standard_pct: 1, standard_basis: "observed", standard_links: ["http://x.io"] },
      { value: 1, fee_kind: "rewards_standard", program: "Stonk.fun reward mode", standard_pct: 1, standard_basis: "settings", standard_links: ["https://x.io"] },
      { value: 1, fee_kind: "outside_norm", standard_pct: 1, standard_basis: "settings" }, // a standard belongs to a program
      { value: 101, fee_kind: "outside_norm" },
      { value: -1, fee_kind: "outside_norm" },
      { value: "1", fee_kind: "outside_norm" },
      { value: 1, fee_kind: "high" },
      { value: 1, fee_kind: "outside_norm", unit: "USD" },
      { value: 1, fee_kind: "rewards_standard", program: "<b>x</b>", standard_pct: 1, standard_basis: "settings" },
    ];
    for (const b of bad) expect(feeFromFact(fact(b)), JSON.stringify(b)).toBeNull();
  });

  it("DeepScan shows it first on every coin: not read yet, a dash without a whole receipt, or the fee with its receipt", () => {
    expect(factsFrom({ facts: [] })[0]).toEqual({ id: "transfer_fee", label: "Transfer fee", value: "—", notRead: true });
    expect(factsFrom({})[0]).toMatchObject({ id: "transfer_fee", notRead: true }); // a file from before facts
    expect(factsFrom({ facts: [fact({ value: 1, fee_kind: "outside_norm", link: undefined })] })[0]).toMatchObject({ value: "—", noSource: true });
    expect(factsFrom({ facts: [fact({ value: 1, fee_kind: "none" })] })[0]).toMatchObject({ value: "—", noSource: true });
    expect(factsFrom({ facts: [fact({ value: 0, fee_kind: "none" })] })[0]).toMatchObject({ value: "None", source: "Solana chain", link: receipt.link });
    const obs = factsFrom({ facts: [fact({ value: 1, fee_kind: "rewards_standard", program: "Stonk.fun reward mode", standard_pct: 1, standard_basis: "observed", standard_links: ["https://solscan.io/token/A"] })] })[0]!;
    expect(obs).toMatchObject({ value: "1% · Stonk.fun reward mode, at its observed standard rate", moreLinks: { lead: "Standard observed on", links: [{ label: "launch 1", url: "https://solscan.io/token/A" }] } });
  });

  it("the tile gets it from the feed file; a copy (VAMP) never does", () => {
    const file = { mint: MINT, chain: "solana", score: 40, display: "40", label: null, coverage: 0.6, facts: [fact({ value: 3, fee_kind: "outside_norm" })] };
    const t = translate(file).token!;
    expect(t.transferFee).toEqual({ pct: 3, kind: "outside_norm" });
    expect(stripVamp(t).transferFee).toBeUndefined();
    expect(translate({ ...file, facts: [fact({ value: 3, fee_kind: "none" })] }).token!.transferFee).toBeUndefined();
  });
});
