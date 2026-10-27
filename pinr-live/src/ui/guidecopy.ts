/**
 * The words of the PINR guide (the centre page), exactly as the operator approved them: a design decision, from
 * HUB-COPY-DRAFT-2026-10-14.md with three changes. Plain sections in one list: to move, cut or add a section, edit this
 * list only; the page draws whatever is here, in this order. Public wording follows PINR's public copy rules (no promises,
 * no "safe", no score mechanics): change a word here only on the operator's say-so.
 */
export interface GuideBlock {
  /** "p" is a paragraph, "li" a bullet. */
  kind: "p" | "li";
  /** A short bold opening (a page name, a kind of trader), or none. */
  lead?: string;
  text: string;
}

export interface GuideSection {
  title: string;
  blocks: GuideBlock[];
}

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    title: "Where everything is",
    blocks: [
      {
        kind: "p",
        lead: "Discover",
        text: "is the search page and the market pulse: Trending, Top Movers, Fresh Launches and PINRscore lists, each card showing the coin, its market cap and all-time high, a small chart, and the score with its coverage.",
      },
      { kind: "p", lead: "PINR", text: "is the home page: every scored coin as a tile, biggest and most active first, so you see what the scanner is looking at." },
      {
        kind: "p",
        lead: "PINRbot DeepScan",
        text: "is one page per coin: the live chart on top, then the dossier below it: the score, the recent trades, the checks, the facts, the written read, the coin's own links and what the posts about it say.",
      },
      { kind: "p", lead: "Wallet / Profile", text: "reads a wallet's public holdings. It cannot sign, send or approve anything." },
      { kind: "p", lead: "PvP Arena", text: "sits above PINR: every version of a contested coin side by side, the leader first." },
      { kind: "p", text: "PINR is the centre of the map. The compass in the centre of the footer opens the whole map. The PINR GUIDE button in the centre of the header opens this guide or the Whitepaper. The footer takes you to the main pages." },
    ],
  },
  {
    title: "Why the site is laid out this way",
    blocks: [
      {
        kind: "p",
        text: "Every page answers one question. PINR: what is moving. Discover: where is the coin I am looking for. DeepScan: what is the evidence for this one coin. Wallet: what do I hold. Everything starts at a coin, and every figure on the way carries where it came from and when it was read, so you can check it yourself instead of trusting a label.",
      },
    ],
  },
  {
    title: "What a score is, and is not",
    blocks: [
      {
        kind: "p",
        text: "PINR's summary, from 1 to 99, of what its checks found. Beside every score is its **coverage**: how much of the picture was actually read. A score with low coverage is an early, partial look. A high score means \"no bad pattern found\". It does not say the coin is good, and it does not say what the price will do. When PINR has not read something, the page says \"not read\" and the reason. It never fills a gap with a guess, and a dash means \"not measured\".",
      },
    ],
  },
  {
    title: "How PINR scans",
    blocks: [
      {
        kind: "p",
        text: "New launches are watched as they appear. A coin gets scored on its own; the busiest coins are scored first, so the list you see is led by what the market is paying attention to. A first score is often chain-only and early, and it is read again as more can be read. Social posts are read separately: what a post claims is set beside what the chain shows, the lines are shown to you, and they never change a score.",
      },
    ],
  },
  {
    title: "The data, one kind at a time",
    blocks: [
      {
        kind: "li",
        lead: "Chain facts:",
        text: "who created the coin, who paid for the launch, how many coins that wallet launched before, the pool and what it holds. Source: the public Solana chain, with a link to the explorer for each figure.",
      },
      { kind: "li", lead: "Launchpad facts:", text: "the coin's own record on its launchpad (its name, picture, links, market cap, all-time high). Source: the launchpad." },
      { kind: "li", lead: "Market figures:", text: "price, liquidity, volume, pair. Source: the market data service named on each figure, with the time it was read." },
      { kind: "li", lead: "Social lines:", text: "what the coin's linked posts say, shown with a link to the post, never scored." },
      { kind: "p", text: "Every figure shows its source, how long ago it was read, and where to look. If a figure has no source, it says \"no source\" and is not used." },
    ],
  },
  {
    title: "What PINR does for each kind of trader",
    blocks: [
      {
        kind: "p",
        lead: "New to this:",
        text: "start on PINR or Discover, tap a coin, read the score with its coverage first, then scroll the dossier from the top. The plain words (Strong, Fair, Weak, Clear, Not read) are there so you do not need to know what a check does.",
      },
      {
        kind: "p",
        lead: "Everyday trader:",
        text: "use Fresh Launches and Top Movers to find coins fast, and read the checks and the recent trades before you decide anything. Compare the market cap with the all-time high.",
      },
      {
        kind: "p",
        lead: "Experienced:",
        text: "the chart has timeframes, indicators and drawing tools, and every dossier figure links to its source so you can verify it. Use the facts list for the launcher's history.",
      },
      {
        kind: "p",
        lead: "Large holders:",
        text: "watch who launched the coin, how long it has traded and how much liquidity sits behind it, and look at the top-holder check once it is read. A coin with low coverage tells you what has not been looked at yet.",
      },
      {
        kind: "p",
        lead: "Funds and desks:",
        text: "the whole site is a research tool built on sourced, timestamped readings. Nothing on it is advice or a recommendation, and every number with a source line can be traced to its source.",
      },
    ],
  },
  {
    title: "What PINR does not do",
    blocks: [
      {
        kind: "p",
        text: "It does not tell you what to buy or sell. It does not predict price. It does not move your wallet. It shows what was read, from where, and when, and it says plainly what it could not read.",
      },
    ],
  },
];

/**
 * while the score and PINRbot are hidden (world/hub.ts), the guide says only what the site shows. The approved text above is kept untouched
 * for the day the switch is turned on; this is the wording used while it is off. It is NEW public copy (it only removes claims that would be false and
 * names the doctor's words): the operator should read it. Sections about the score are left out; blocks that mention it are reworded.
 */
const HUB_TITLES_DROPPED = new Set(["What a score is, and is not", "How PINR scans"]);
const HUB_BLOCKS: Record<string, { lead?: string; text: string }> = {
  Discover: {
    lead: "Discover",
    text: "is the search page and the market pulse: Trending, Top Movers and Fresh Launches lists, each card showing the coin, its market cap and all-time high, a small chart and its trade ribbon.",
  },
  PINR: { lead: "PINR", text: "is the home page: every coin the scanner is looking at as a tile, biggest and most active first, so you see what the scanner is looking at." },
  "Social lines:": { lead: "Social lines:", text: "what the coin's linked posts say, shown with a link to the post." },
  "PINRbot DeepScan": {
    lead: "DeepScan",
    text: "is one page per coin: a chart on top with links to full charts elsewhere, then the key stats, the recent trades, the checks, the facts, the written read, the coin's own links and what the posts about it say.",
  },
  "New to this:": {
    lead: "New to this:",
    text: "start on PINR or Discover, tap a coin, then scroll the page from the top. The plain words (observed, not checked yet, worth a closer look) are there so you do not need to know what a check does.",
  },
  "Large holders:": {
    lead: "Large holders:",
    text: "watch who launched the coin, how long it has traded and how much liquidity sits behind it, and look at the top-holder check once it is read. A check that says \"not checked yet\" tells you what has not been looked at yet.",
  },
};

/** The guide's sections as the site shows them now: the approved text, or the hidden-score wording. */
export function guideSections(shown: boolean): GuideSection[] {
  if (shown) return GUIDE_SECTIONS;
  return GUIDE_SECTIONS.filter((s) => !HUB_TITLES_DROPPED.has(s.title)).map((s) => ({
    title: s.title,
    blocks: s.blocks.map((b) => {
      const alt = HUB_BLOCKS[b.lead ?? ""];
      return alt ? { kind: b.kind, lead: alt.lead, text: alt.text } : b;
    }),
  }));
}

