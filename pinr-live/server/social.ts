import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { visibleText } from "../src/world/visibletext.ts";

/**
 * The social scan of a coin, read from the scanner's file `marketing/scan-output/<mint>.json` (format: marketing/SOCIAL-SCANNER-DESIGN.md
 * section 4). Read-only and an ALLOW-LIST: a new object is built from named fields only, every text cleaned and capped, every link https only.
 * Nothing here feeds a score or a band; the page shows it as "Social (not scored)".
 */
export type SocialResult = "MATCHES" | "DIVERGES" | "UNVERIFIABLE" | "NOT CHECKABLE";
const RESULTS: readonly string[] = ["MATCHES", "DIVERGES", "UNVERIFIABLE", "NOT CHECKABLE"];

export interface SocialClaim {
  /** "Post says ... Dossier shows ... Result ...", plain text, as the scanner wrote it */
  line: string;
  result: SocialResult;
  handle: string | null;
  postUrl: string | null;
  /** the scanner saw the post removed: it is kept as a record, with no link */
  removed: boolean;
  postedAtMs: number | null;
  readAtMs: number | null;
  /** the dossier fact the claim was compared with, when there is one */
  dossierLink: string | null;
}
export interface SocialFlag {
  kind: "linked_x_account_names_another_coin" | "launchpad_x_link_is_another_accounts_post";
  /** plain words for the page, built here from the flag's fields (never the scanner's free text) */
  text: string;
  source: string | null;
  readAtMs: number | null;
  link: string | null;
}
export interface Social {
  /** which run of this coin's scan the file holds */
  version: number | null;
  scannedAtMs: number | null;
  claims: SocialClaim[];
  flags: SocialFlag[];
  /** what could not be read, as the scanner said it (cleaned), at most five */
  gaps: string[];
  totals: Record<SocialResult, number>;
}

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Plain text only: control characters and markup characters out, whitespace squeezed, capped. */
export function plain(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = visibleText(v.replace(/[<>]/g, " "));
  return t ? t.slice(0, max) : null;
}
const httpsLink = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".") && u.href.length <= 240 ? u.href : null;
  } catch {
    return null;
  }
};
/**
 * Links the page may make from a scan file: only the allow-listed kinds (a post on X or Telegram, a launchpad's page, a chain explorer or
 * DexScreener / GeckoTerminal page), never any https address that happens to be in the file.
 */
const LINK_HOSTS = /^(www\.)?(x\.com|twitter\.com|t\.me|pump\.fun|bonk\.fun|letsbonk\.fun|raydium\.io|clanker\.world|flap\.sh|four\.meme|bankr\.bot|solscan\.io|etherscan\.io|basescan\.org|bscscan\.com|dexscreener\.com|geckoterminal\.com)$/i;
export function allowedLink(v: unknown): string | null {
  const l = httpsLink(v);
  if (!l) return null;
  try {
    return LINK_HOSTS.test(new URL(l).hostname) ? l : null;
  } catch {
    return null;
  }
}
const timeMs = (v: unknown): number | null => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
const handleOk = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9_]{1,15}$/.test(v) ? v : null);

function minutesWords(m: number): string {
  const n = Math.abs(m);
  const t = n >= 120 ? `${Math.round(n / 60)} hours` : n >= 1.5 ? `${Math.round(n)} minutes` : `${n.toFixed(1)} minutes`;
  return m < 0 ? `${t} before the coin existed` : `${t} after the launch`;
}

function flagFrom(raw: unknown): SocialFlag | null {
  if (typeof raw !== "object" || raw === null) return null;
  const f = raw as Record<string, unknown>;
  const source = plain(f.source, 120);
  const readAtMs = timeMs(f.read_at);
  const link = allowedLink(f.link);
  if (f.flag === "linked_x_account_names_another_coin") {
    const oc = typeof f.other_coin === "object" && f.other_coin !== null ? (f.other_coin as Record<string, unknown>) : {};
    const name = plain(oc.name, 60);
    const ticker = plain(oc.ticker, 20);
    const who = [name, ticker ? `(${ticker})` : null].filter(Boolean).join(" ");
    return { kind: "linked_x_account_names_another_coin", text: `The linked X account names another coin${who ? `: ${who}` : ""}.`, source, readAtMs, link };
  }
  if (f.flag === "launchpad_x_link_is_another_accounts_post") {
    const handle = handleOk(f.handle);
    const mins = typeof f.minutes_before_launch === "number" && Number.isFinite(f.minutes_before_launch) ? f.minutes_before_launch : null;
    return {
      kind: "launchpad_x_link_is_another_accounts_post",
      text: `The coin's X link is a post by ${handle ? `@${handle}` : "another account"}, not the coin's own account${mins !== null ? `, written ${minutesWords(mins)}` : ""}.`,
      source,
      readAtMs,
      link,
    };
  }
  return null;
}

/** Clean one scan file's content into what the page may show, or null when it is not a scan file. */
export function buildSocial(raw: unknown): Social | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema_version !== "1" && r.schema_version !== 1) return null;
  const claims: SocialClaim[] = [];
  const totals: Record<SocialResult, number> = { MATCHES: 0, DIVERGES: 0, UNVERIFIABLE: 0, "NOT CHECKABLE": 0 };
  for (const c of Array.isArray(r.claims) ? r.claims : []) {
    if (typeof c !== "object" || c === null) continue;
    const o = c as Record<string, unknown>;
    const result = typeof o.result === "string" && RESULTS.includes(o.result) ? (o.result as SocialResult) : null;
    const line = plain(o.line, 600);
    if (!result || !line) continue;
    totals[result]++;
    // A claim that is not checkable (a promise, an airdrop call, an opinion) is only ever COUNTED: never its words, never its link.
    if (result === "NOT CHECKABLE") continue;
    const removed = (typeof o.post_status === "string" && o.post_status !== "present") || (typeof o.post_removed_seen_at === "string" && o.post_removed_seen_at !== "");
    claims.push({ line, result, handle: handleOk(o.handle), postUrl: removed ? null : allowedLink(o.post_url), removed, postedAtMs: timeMs(o.posted_at), readAtMs: timeMs(o.read_at), dossierLink: allowedLink(o.dossier_link) });
  }
  const flags = (Array.isArray(r.flags) ? r.flags : []).map(flagFrom).filter((f): f is SocialFlag => f !== null);
  const gaps = (Array.isArray(r.gaps) ? r.gaps : []).map((g) => plain(g, 240)).filter((g): g is string => g !== null).slice(0, 5);
  return { version: typeof r.version === "number" && Number.isInteger(r.version) ? r.version : null, scannedAtMs: timeMs(r.scanned_at), claims, flags, gaps, totals };
}

const SCAN_DIR = resolve(import.meta.dirname, "..", "..", "marketing", "scan-output");

/** The scan of one coin, or null when none was run (the page then says so; it never guesses). */
export function readSocial(mint: string, dir: string = SCAN_DIR): Social | null {
  if (!MINT.test(mint)) return null;
  const file = join(dir, `${mint}.json`);
  if (!existsSync(file)) return null;
  try {
    return buildSocial(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}
