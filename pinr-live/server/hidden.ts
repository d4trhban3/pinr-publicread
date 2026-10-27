import type { WireToken } from "./translate.ts";
import { chainOf } from "./chains.ts";

/**
 * Coins pinr.io does not show for now.
 *
 *  - A VAMP (a coin the engine labels as a copy of another) forms a group with the coin the server's picture desk found it copies, and the more
 *    active of the two shows, even if that is the VAMP (its page is then the label only). A VAMP whose original was not found stays off.
 *  - A developer's duplicate relaunches (the engine's label "Duplicate relauncher (N copies)") form a group with the unlabelled coins by the
 *    same developer wallet with the same name and ticker. Only ONE coin of the group shows: the one with the most transactions in the last
 *    30 minutes, then the most dollar volume in the last 30 minutes, then the most recent trade, then the address. The choice is
 *    made again at every rebuild, so the shown coin can switch. A coin whose last 30 minutes cannot be read counts as no recent activity.
 *
 *  - Coins with the very same picture file, coins with the very same name and ticker (copy waves), and coins the gate's result ties together (an earlier look-alike, a creator's same-name relaunches), form groups too:
 *    one shows, the most active.
 *
 * Left off means: not on the first page, the later pages, the stream, search, Discover, any list or any total the server serves. The engine still
 * scans and scores them and keeps their files. A direct request for one gets only its label and a short notice.
 */
export const HIDDEN_NOTICE = "PINR is not showing this coin for now.";
/** What an unlabelled coin of a hidden group is called when asked for directly. */
export const GROUP_LABEL = "Copy group";
export const WINDOW_MS = 30 * 60_000;
const DUP_PREFIX = "duplicate relauncher";

export interface Activity {
  /** transactions in the last 30 minutes */
  n: number;
  /** dollars traded in the last 30 minutes */
  usd: number;
  /** true when the kept trades do not reach back across the whole window (a busy coin's file keeps its newest 500): n and usd are then at least these */
  atLeast?: boolean;
}
export const NO_ACTIVITY: Activity = { n: 0, usd: 0 };

type Hideable = Pick<WireToken, "noScoreLabel" | "note">;

export const isDuplicateLabel = (t: Hideable): boolean => typeof t.note === "string" && t.note.trim().toLowerCase().startsWith(DUP_PREFIX);
export const isVampCoin = (t: Hideable): boolean => t.noScoreLabel === "VAMP";

/** The label that makes this coin a candidate for hiding, or null. */
export function hiddenLabel(t: Hideable): string | null {
  if (isVampCoin(t)) return "VAMP";
  return isDuplicateLabel(t) ? (t.note as string).trim() : null;
}

/** Who made the coin (its launcher wallet) for a coin the engine scored, or null when it cannot be read. */
export type LauncherOf = (addressLower: string) => string | null;

export interface Plan {
  /** each copy group: lower-case addresses (a duplicate group, or a VAMP with the coin it copies; groups that share a coin are one) */
  groups: string[][];
  /** label by address for the members that carry one (a "Duplicate relauncher" label, or VAMP) */
  labels: Map<string, string>;
  /** the VAMPs among the members: they are label-only, so they lose a tie */
  vamps: Set<string>;
  /** the address as the sources spell it (case matters to them), for every member */
  cases: Map<string, string>;
}

const nameKey = (t: Pick<WireToken, "name" | "ticker">): string => `${(t.name ?? "").trim().toLowerCase()}|${(t.ticker ?? "").trim().toLowerCase()}`;
/** the team (2026-10-25): copy families are found within one chain only; a Base coin is never hidden by a Solana coin of the same name or picture. */
const chainKey = (t: Pick<WireToken, "chain" | "address">, k: string): string => `${chainOf(t) ?? "?"}|${k}`;
/** With no activity figure, the earliest-launched coin of a family shows (the original, as in 237); a coin with no launch time counts as the newest. */
const launchedOf = (t: Pick<WireToken, "launchedAtMs"> | undefined): number => (t && typeof t.launchedAtMs === "number" && Number.isFinite(t.launchedAtMs) ? t.launchedAtMs : Infinity);

/** The coin a VAMP copies, as the server's picture desk found it (address as spelled), or null when none was found. */
export type CopyOf = (addressLower: string) => string | null;
/** The coins the gate found a coin to be a copy of or a relaunch with, as the sources spell them; [] when none. */
export type GateOf = (addressLower: string) => string[];

/** The groups of one snapshot. Cheap to keep until the snapshot changes; the winners are chosen afresh by `chooseHidden`. */
export function planGroups(all: readonly WireToken[], launcherOf: LauncherOf, copyOf: CopyOf = () => null, gateOf: GateOf = () => []): Plan {
  const steps = planSteps(all, launcherOf, copyOf, gateOf);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Coins handled between two pauses of the stepped plan. */
export const PLAN_STEP = 2000;
/**
 * The same plan made in steps: it pauses every PLAN_STEP coins so the server answers its visitors between them. On the server
 * the whole plan over 58,000 coins held every request up 0.8 to 2.4 s once a minute. `planGroupsStepped` drives it with a breath between steps.
 */
export function* planSteps(all: readonly WireToken[], launcherOf: LauncherOf, copyOf: CopyOf = () => null, gateOf: GateOf = () => []): Generator<void, Plan, void> {
  let n = 0;
  const due = (): boolean => ++n % PLAN_STEP === 0;
  const labels = new Map<string, string>();
  const vamps = new Set<string>();
  const cases = new Map<string, string>();
  const byName = new Map<string, string[]>();
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const add = (x: string): void => void (parent.has(x) || parent.set(x, x));
  const union = (x: string, y: string): void => {
    add(x);
    add(y);
    parent.set(find(x), find(y));
  };
  const dups: string[] = [];
  for (const t of all) {
    if (due()) yield;
    const a = t.address.toLowerCase();
    cases.set(a, t.address);
    if (isVampCoin(t)) {
      vamps.add(a);
      labels.set(a, "VAMP");
      add(a);
      // the coin it copies: the VAMP and that coin are one group, the more active one shows
      const orig = copyOf(a);
      if (orig && orig.toLowerCase() !== a) {
        cases.set(orig.toLowerCase(), orig);
        union(a, orig.toLowerCase());
      }
      continue;
    }
    const k = nameKey(t);
    if (k !== "|") (byName.get(chainKey(t, k)) ?? byName.set(chainKey(t, k), []).get(chainKey(t, k))!).push(a);
    if (isDuplicateLabel(t)) {
      dups.push(a);
      labels.set(a, (t.note as string).trim());
      add(a);
    }
  }
  const tokenOf = new Map(all.map((t) => [t.address.toLowerCase(), t]));
  // The gate's result: a coin and the look-alike or same-creator relaunch it found are one group, when both are listed here. A coin the site does not
  // list can never stand in for one that is (it would hide them all and show nothing), so only listed coins join.
  for (const t of all) {
    if (due()) yield;
    if (isVampCoin(t)) continue;
    const a = t.address.toLowerCase();
    for (const r of gateOf(a)) {
      const other = r.toLowerCase();
      if (other === a || !tokenOf.has(other)) continue;
      // the team (2026-10-25): families are within one chain. A BNB coin's gate naming an earlier Solana coin of the same name never hides the
      // Solana coin (the team, 2026-10-25: "Walmart" on Solana was hidden by a BNB "Walmart" the gate held).
      if (chainOf(t) !== chainOf(tokenOf.get(other)!)) continue;
      cases.set(other, tokenOf.get(other)!.address);
      union(a, other);
    }
  }
  const byLauncher = new Map<string, string>(); // developer wallet to a member of that developer's group
  for (const a of dups) {
    const w = launcherOf(a);
    if (!w) continue; // developer unknown: it stands alone
    if (byLauncher.has(w)) union(a, byLauncher.get(w)!);
    else byLauncher.set(w, a);
    // the developer's other launches of the same name and ticker (the unlabelled first launch among them) belong to the group, never another developer's
    for (const other of byName.get(chainKey(tokenOf.get(a)!, nameKey(tokenOf.get(a)!))) ?? []) if (other !== a && !labels.has(other) && launcherOf(other) === w) union(a, other);
  }
  // Look-alikes the listing itself shows: coins with the very same picture file are one family, and so are
  // coins with the very same name and ticker, whoever launched them. The gate finds the same from the token data; this holds while its files are not
  // there, and for coins it has not read.
  const byPicture = new Map<string, string[]>();
  const byNameTicker = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string): void => void (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  for (const t of all) {
    if (due()) yield;
    if (isVampCoin(t)) continue;
    const a = t.address.toLowerCase();
    if (t.imageUrl) push(byPicture, chainKey(t, t.imageUrl), a);
    if ((t.name ?? "").trim() && (t.ticker ?? "").trim()) push(byNameTicker, chainKey(t, nameKey(t)), a);
  }
  for (const members of [...byPicture.values(), ...byNameTicker.values()]) {
    if (due()) yield;
    for (let i = 1; i < members.length; i++) {
      cases.set(members[i]!, tokenOf.get(members[i]!)!.address);
      cases.set(members[0]!, tokenOf.get(members[0]!)!.address);
      union(members[0]!, members[i]!);
    }
  }
  const comps = new Map<string, string[]>();
  for (const x of parent.keys()) {
    if (due()) yield;
    (comps.get(find(x)) ?? comps.set(find(x), []).get(find(x))!).push(x);
  }
  return { groups: [...comps.values()], labels, vamps, cases };
}

/**
 * The coins left off: every member of a copy group except its most active one. `activityOf` gives the last 30 minutes of a coin (the caller returns
 * NO_ACTIVITY for one it cannot read). A coin that stands alone (a labelled duplicate with no group-mate)
 * is its own group and shows (a lone VAMP does not: it stays off). A tie goes to the more recent trade, then to a coin that is not a VAMP, then to the address. Returns address (lower case) to label.
 */
export function chooseHidden(plan: Plan, tokens: ReadonlyMap<string, Pick<WireToken, "lastTradeMs" | "launchedAtMs">>, activityOf: (addressLower: string) => Activity): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of plan.groups) {
    // A VAMP whose original was not found has nothing to compare with: it stays off. Only a duplicate with no group-mate stands alone and shows.
    if (g.length === 1 && plan.vamps.has(g[0]!)) {
      out.set(g[0]!, "VAMP");
      continue;
    }
    const ranked = g
      .map((a) => ({ a, act: activityOf(a), born: launchedOf(tokens.get(a)), last: tokens.get(a)?.lastTradeMs ?? 0, v: plan.vamps.has(a) ? 1 : 0 }))
      .sort((x, y) => y.act.n - x.act.n || y.act.usd - x.act.usd || x.born - y.born || y.last - x.last || x.v - y.v || (x.a < y.a ? -1 : 1));
    for (const r of ranked.slice(1)) out.set(r.a, plan.labels.get(r.a) ?? GROUP_LABEL);
  }
  return out;
}

/**
 * The last pass, over the coins about to be served on the first page (scored coins AND the launchpad coins the pool adds, which are in no feed file so
 * `planGroups` never sees them): coins with the very same picture file, or the very same name and ticker, are one family and only the most active shows
 * . Returns the
 * losers by lower-case address. Cheap and bounded: one pass, no file or network read.
 */
export function finalFamilies(list: readonly WireToken[], activityOf: (addressLower: string) => Activity): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const byKey = new Map<string, string>();
  const join = (key: string, a: string): void => {
    parent.has(a) || parent.set(a, a);
    const first = byKey.get(key);
    if (first === undefined) byKey.set(key, a);
    else parent.set(find(a), find(first));
  };
  const tokenOf = new Map<string, WireToken>();
  for (const t of list) {
    if (isVampCoin(t) || !t.address) continue;
    const a = t.address.toLowerCase();
    tokenOf.set(a, t);
    if (t.imageUrl) join(`p|${chainKey(t, t.imageUrl)}`, a);
    if ((t.name ?? "").trim() && (t.ticker ?? "").trim()) join(`n|${chainKey(t, nameKey(t))}`, a);
  }
  const groups = new Map<string, string[]>();
  for (const a of tokenOf.keys()) if (parent.has(a)) (groups.get(find(a)) ?? groups.set(find(a), []).get(find(a))!).push(a);
  const out = new Map<string, string>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const ranked = g
      .map((a) => ({ a, act: activityOf(a), born: launchedOf(tokenOf.get(a)), last: tokenOf.get(a)!.lastTradeMs ?? 0, cap: tokenOf.get(a)!.valuationUsd ?? 0 }))
      .sort((x, y) => y.act.n - x.act.n || y.act.usd - x.act.usd || x.born - y.born || y.last - x.last || y.cap - x.cap || (x.a < y.a ? -1 : 1));
    for (const r of ranked.slice(1)) out.set(r.a, GROUP_LABEL);
  }
  return out;
}

/** Runs the stepped plan to its end with a breath (setImmediate) between steps, so requests are answered meanwhile. */
export async function planGroupsStepped(all: readonly WireToken[], launcherOf: LauncherOf, copyOf: CopyOf = () => null, gateOf: GateOf = () => []): Promise<Plan> {
  const steps = planSteps(all, launcherOf, copyOf, gateOf);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    await new Promise<void>((ok) => setImmediate(ok));
  }
}

/** The members of the groups with more than one coin: the coins whose activity the board needs. */
export function groupMembers(plan: Plan): string[] {
  return plan.groups.flatMap((g) => (g.length > 1 ? g : []));
}

/**
 * Last-30-minute activity of the coins in copy groups. Tick-file figures (the engine's trade feed) are read on the spot. For a coin without one
 * the board asks Pump.fun's trade list, ONE coin at a time and at most one ask every 15 seconds (inside the shared read limit), and keeps the answer
 * five minutes. A coin it could not read counts as no recent activity: never a guess.
 */
export class ActivityBoard {
  private cache = new Map<string, { a: Activity | null; atMs: number }>();
  private pending = false;
  private lastAskMs = 0;
  static readonly KEEP_MS = 5 * 60_000;
  static readonly ASK_GAP_MS = 15_000;

  constructor(
    private src: {
      ticks: (addrLower: string) => Activity | null;
      /** read the coin's newest page and give its activity (null when it could not be read) */
      tape: (addrLower: string) => Promise<Activity | null>;
    },
    private now: () => number = Date.now,
  ) {}

  activityOf = (addrLower: string): Activity => this.src.ticks(addrLower) ?? this.cache.get(addrLower)?.a ?? NO_ACTIVITY;
  /** Whether a coin's last 30 minutes were actually read (its tick file, or a tape read that answered): a zero is real only then (checklist 7). */
  known = (addrLower: string): boolean => this.src.ticks(addrLower) !== null || !!this.cache.get(addrLower)?.a;

  /** Call at every rebuild with the group members: starts at most one ask when one is due. */
  refresh(members: readonly string[]): void {
    const t = this.now();
    if (this.pending || t - this.lastAskMs < ActivityBoard.ASK_GAP_MS) return;
    let pick: string | null = null;
    let oldest = Infinity;
    for (const a of members) {
      if (this.src.ticks(a)) continue;
      const at = this.cache.get(a)?.atMs ?? 0;
      if (t - at >= ActivityBoard.KEEP_MS && at < oldest) (pick = a, (oldest = at));
    }
    if (!pick) return;
    const asked = pick;
    this.pending = true;
    this.lastAskMs = t;
    void this.src
      .tape(asked)
      .then((a) => this.cache.set(asked, { a, atMs: this.now() }))
      .catch(() => this.cache.set(asked, { a: null, atMs: this.now() }))
      .finally(() => {
        this.pending = false;
      });
  }
}
