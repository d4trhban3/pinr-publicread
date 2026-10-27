/**
 * Why a coin's transfer fee is what it is: which case applied, in plain words, for DeepScan's fee line.
 * Server only: the engine sends its reasons as short coded items and the words are the page's own, so no starting
 * value of the rules (how many holders count, where "High fee" begins) is sent to the page as a number of the rule.
 */
import type { TransferFee } from "./transferfee.ts";

export type FeeCase = "none" | "rewards_standard" | "standard_unknown" | "reason_found" | "no_reason" | "not_checked";
const CASES: readonly FeeCase[] = ["none", "rewards_standard", "standard_unknown", "reason_found", "no_reason", "not_checked"];

/** "High fee" is shown only above this rate, and only where no reason was found or it was not checked yet. */
const HIGH_FEE_OVER_PCT = 10;

/** The five powers the reason names (rules section 16), in the page's words. */
const POWERS: Record<string, string> = {
  mint: "mint",
  freeze: "freeze",
  pause: "pause",
  permanent_delegate: "permanent delegate",
  fee_rate_control: "fee-rate control",
};
const HOLDERS: Record<string, string> = { dev: "the dev", linked: "a linked wallet", unexplained: "an unexplained wallet" };

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e7;

/**
 * One item of `reason_why`  in plain words. An item the page cannot name is
 * still shown, as such, so the list never looks shorter than the engine's.
 */
export function reasonItem(it: unknown): { order: number; text: string } {
  const o = typeof it === "object" && it !== null ? (it as Record<string, unknown>) : {};
  if (o.kind === "power_held" && typeof o.power === "string" && POWERS[o.power]) {
    const by = typeof o.holder === "string" && HOLDERS[o.holder] ? ` by ${HOLDERS[o.holder]}` : "";
    return { order: 0, text: `${POWERS[o.power]} held${by}` };
  }
  if (o.kind === "holders_reached" && count(o.holders)) return { order: 1, text: `fees reached ${plural(o.holders, "holder", "holders")} outside the dev group` };
  if (o.kind === "dev_payouts" && count(o.wallets) && count(o.transfers))
    return { order: 1, text: `fees paid to the dev group: ${plural(o.transfers, "transfer", "transfers")} to ${plural(o.wallets, "wallet", "wallets")}` };
  if (o.kind === "paid_not_holding" && count(o.wallets)) return { order: 1, text: `${plural(o.wallets, "paid wallet", "paid wallets")} did not hold the coin` };
  if (o.kind === "paid_unread" && count(o.wallets)) return { order: 1, text: `${plural(o.wallets, "paid wallet", "paid wallets")} could not be read` };
  if (o.kind === "not_traced" && count(o.transfers)) return { order: 1, text: `${plural(o.transfers, "transfer", "transfers")} not traced to this coin's fees` };
  if (o.kind === "withdrawn" && typeof o.amount === "number" && Number.isFinite(o.amount) && o.amount >= 0)
    return { order: 1, text: `${Number(o.amount.toPrecision(6)).toLocaleString("en-US")} of the coin withdrawn as withheld fees` };
  if (o.kind === "no_withdrawal_seen") return { order: 1, text: "no withdrawal of withheld fees seen" };
  if (o.kind === "no_withdraw_authority") return { order: 1, text: "no wallet can withdraw the fees the coin holds back" };
  return { order: 2, text: "another finding this page cannot name yet" };
}

export interface FeeCaseView {
  /** plain sentences shown under the fee */
  lines: string[];
  /** "High fee", only over the line and only with no reason found or not checked yet */
  highFee: boolean;
}

/**
 * The case line for a fee that passed the contract's checks. A `fee_case` that does not fit the fee's `fee_kind` is ignored (the fee still
 * shows; its case is missing, not guessed). The three cases a rewards fee or no fee can have add nothing: the fee's own words already say it.
 */
export function feeCaseView(f: Record<string, unknown>, fee: TransferFee): FeeCaseView {
  const c = typeof f.fee_case === "string" && (CASES as readonly string[]).includes(f.fee_case) ? (f.fee_case as FeeCase) : null;
  const fits = c !== null && (fee.kind === "outside_norm" ? c === "reason_found" || c === "no_reason" || c === "not_checked" : c === fee.kind);
  if (!c || !fits || fee.kind !== "outside_norm") return { lines: [], highFee: false };
  const highFee = c !== "reason_found" && fee.pct > HIGH_FEE_OVER_PCT;
  if (c === "not_checked") return { lines: ["Reason not checked yet: the fee's history could not be read. It is checked again at the next look."], highFee };
  if (c === "reason_found") {
    const n = typeof f.holders_paid === "number" && Number.isInteger(f.holders_paid) && f.holders_paid > 0 ? f.holders_paid : null;
    return {
      lines: [`Reason found on chain: the fees were paid back to ${n !== null ? plural(n, "holder", "holders") : "holders"} outside the dev group, and the contract's powers are renounced.`],
      highFee: false,
    };
  }
  // held powers first, then the payout findings, each in the engine's order within its group; none dropped
  const items = Array.isArray(f.reason_why) ? f.reason_why.map(reasonItem) : [];
  const why = items.map((x, i) => ({ ...x, i })).sort((a, b) => a.order - b.order || a.i - b.i).map((x) => x.text);
  return { lines: [why.length ? "No reason found on chain:" : "No reason found on chain.", ...why.map((w) => `• ${w}`)], highFee };
}

export interface DevPayouts {
  transfers: number;
  wallets: string[];
}

const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The `fee_dev_payouts` fact's own fields (its receipt is checked by the dossier like every fact), or null when they break the contract. */
export function devPayoutsFrom(f: Record<string, unknown>): DevPayouts | null {
  if (f.unit !== "transfers" || typeof f.value !== "number" || !Number.isInteger(f.value) || f.value < 1 || f.value > 1e7) return null;
  const w = f.wallets;
  if (!Array.isArray(w) || w.length < 1 || w.length > 10 || !w.every((x) => typeof x === "string" && SOLANA.test(x))) return null;
  return { transfers: f.value, wallets: [...new Set(w as string[])] };
}
