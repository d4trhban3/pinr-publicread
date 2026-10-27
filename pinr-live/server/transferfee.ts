/**
 * A coin's transfer fee: the `transfer_fee` fact in the feed file (contract, "Transfer fee"). Shown on every coin's DeepScan and,
 * when the coin has a fee, on its tile, with whether it is a launchpad rewards program's fee within that program's standard rate or outside that norm.
 * Plain words only: what the fee is and whose program it belongs to, never a verdict. Nothing here is a score; the engine scores it.
 * the team's rulings (2026-10-17): B1 at or below the standard is "rewards", only above is "above rate"; U1 a verified rewards fee whose standard
 * is not known is `standard_unknown` (shown as rewards, the standard said to be unread); R1 a standard read from the program's own settings, or,
 * where it keeps none, the rate its newest verified launches agree on, labelled "observed" with those launches as receipts.
 * No node imports: the page uses the same wording.
 */
export type FeeKind = "none" | "rewards_standard" | "standard_unknown" | "outside_norm";

export interface TransferFee {
  /** the fee in force now, in percent of each transfer (0 when the coin has none) */
  pct: number;
  kind: FeeKind;
  /** the rewards program's public name, when the fee belongs to one */
  program?: string;
  /** that program's standard rate in percent, when known */
  standardPct?: number;
  /** where the standard comes from: the program's own on-chain settings, or the rate its newest verified launches agree on */
  standardBasis?: "settings" | "observed";
  /** for an observed standard: links to the launches it was observed on (its receipts) */
  standardLinks?: string[];
}

const PROGRAM_OK = /^[\w .\-()]{1,40}$/;
const isPct = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
const isHttps = (v: unknown): v is string => {
  if (typeof v !== "string" || v.length > 300) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * The fee from one `transfer_fee` fact, or null when the fact breaks the contract's rules (then the page shows a dash, never a guess).
 * The receipt (source, read_at, link) is checked by the dossier like every fact; this checks only the fee's own fields.
 */
export function feeFromFact(f: Record<string, unknown>): TransferFee | null {
  if (f.unit !== "percent" || !isPct(f.value)) return null;
  const pct = f.value;
  const kind = f.fee_kind;
  const program = typeof f.program === "string" && PROGRAM_OK.test(f.program.trim()) ? f.program.trim() : undefined;
  if (f.program !== undefined && program === undefined) return null;
  const standardPct = isPct(f.standard_pct) ? f.standard_pct : undefined;
  if (f.standard_pct !== undefined && standardPct === undefined) return null;
  // the standard: its rate and its basis come together; an observed one carries 1 to 10 launch links, a settings one none
  const basis = f.standard_basis === "settings" || f.standard_basis === "observed" ? f.standard_basis : undefined;
  if (f.standard_basis !== undefined && basis === undefined) return null;
  if ((standardPct === undefined) !== (basis === undefined)) return null;
  const links = f.standard_links;
  if (basis === "observed" && !(Array.isArray(links) && links.length >= 1 && links.length <= 10 && links.every(isHttps))) return null;
  if (basis !== "observed" && links !== undefined) return null;
  // a standard belongs to a program
  if (standardPct !== undefined && program === undefined) return null;
  const standard = standardPct !== undefined && basis ? { standardPct, standardBasis: basis, ...(basis === "observed" ? { standardLinks: (links as string[]).slice() } : {}) } : {};

  if (kind === "none") return pct === 0 && program === undefined ? { pct: 0, kind } : null;
  if (pct === 0) return null;
  // B1: at or below the program's standard
  if (kind === "rewards_standard") return program !== undefined && standardPct !== undefined && pct <= standardPct ? { pct, kind, program, ...standard } : null;
  // U1: a verified program's fee whose standard was not read
  if (kind === "standard_unknown") return program !== undefined && standardPct === undefined ? { pct, kind, program } : null;
  // any other fee: no program, or above the program's standard
  if (kind === "outside_norm") return program === undefined || (standardPct !== undefined && pct > standardPct) ? { pct, kind, ...(program ? { program } : {}), ...standard } : null;
  return null;
}

/** The `transfer_fee` fact of a feed file, or undefined when the file has none (not read). Null when it is there but breaks the rules. */
export function feeFromFeed(feed: unknown): TransferFee | null | undefined {
  const facts = typeof feed === "object" && feed !== null ? (feed as Record<string, unknown>).facts : undefined;
  if (!Array.isArray(facts)) return undefined;
  const f = facts.find((x) => typeof x === "object" && x !== null && (x as Record<string, unknown>).id === "transfer_fee") as Record<string, unknown> | undefined;
  return f ? feeFromFact(f) : undefined;
}

const pctText = (p: number): string => `${Number(p.toFixed(2))}%`;
const std = (f: TransferFee): string => (f.standardBasis === "observed" ? "observed standard" : "standard");

/** DeepScan's line: the rate, then whose fee it is. */
export function feeLong(f: TransferFee): string {
  if (f.kind === "none") return "None";
  if (f.kind === "rewards_standard") return f.pct === f.standardPct ? `${pctText(f.pct)} · ${f.program}, at its ${std(f)} rate` : `${pctText(f.pct)} · ${f.program}, below its ${std(f)} ${pctText(f.standardPct!)}`;
  if (f.kind === "standard_unknown") return `${pctText(f.pct)} · ${f.program}; its standard rate was not read`;
  if (f.program) return `${pctText(f.pct)} · above ${f.program}'s ${std(f)} ${pctText(f.standardPct!)}`;
  return `${pctText(f.pct)} · not a launchpad rewards fee`;
}

/** The tile's short value (the row's label is "Fee"); empty when the coin has no fee (the tile shows no row). the team's words, short enough for a tile even at "12.5%". */
export function feeShort(f: TransferFee): string {
  if (f.kind === "none") return "";
  if (f.kind === "rewards_standard" || f.kind === "standard_unknown") return `${pctText(f.pct)} rewards`;
  if (f.program) return `${pctText(f.pct)} above rate`;
  return `${pctText(f.pct)} not rewards`;
}
