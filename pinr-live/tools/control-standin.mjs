// D5: a STAND-IN for the engine's control service, in the formats the control service uses, so /control can be
// built and checked here without the server or Cloudflare Access. It is not the real service: no Access check, no files written, everything invented and kept in
// memory. Listens on 127.0.0.1 only. Start it, then run the feed server with PINR_CONTROL=on (it passes /api/control/* to 127.0.0.1:8790).
//
//   node tools/control-standin.mjs [port]     (default 8790; STANDIN_FALLBACK=largest_holders,... shows the nodes-fallback warning; STANDIN_CAN_APPLY=1 says this viewer's changes are accepted)
//
// Formats it follows: status (242), gate (243 phase 1), routing (243 phase 2), Ask PINRai and teachings (245). A preview that leaves no launchpad on, or the
// picture check on with no match kind, is refused with `problems`, as the server does.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const submissions = [
  { id: "0a1b2c3d4e5f", at: "2026-10-26T14:02:00Z", by: "operator@example.test", note: "Send the evidence builder straight to the coin list.", diff: { text: "Wire added: Evidence builder (evidence file) to /api/tokens (coin list)." }, status: "under evaluation", reason: null, decided_at: null },
  { id: "9f8e7d6c5b4a", at: "2026-10-25T09:30:00Z", by: "operator@example.test", note: "", diff: { text: "Wire removed: Picture pass (picture) to /api/tokens (picture)." }, status: "declined", reason: "That wire carries every coin's picture to the lists; removing it blanks the tiles.", decided_at: "2026-10-25T10:00:00Z" },
];
const WHO = "stand-in@pinr.local";
const now = () => new Date().toISOString();
const hourAgo = () => new Date(Date.now() - 3600e3).toISOString();
const src = (calls, errors = 0) => ({ calls, ok: calls - errors, errors, http429: 0, timeouts: 0, last_ok: now() });

// ---- status and live settings (242)
let control = { sources: {}, trades_ws_max_coins: 120, pinrai: { on: true, daily_dollar_cap: 5 } };
const changes = [];
let changeId = 0;
function setKey(key, value) {
  const path = key.split(".");
  let o = control;
  for (const k of path.slice(0, -1)) o = o[k] ??= {};
  const before = o[path.at(-1)] ?? null;
  o[path.at(-1)] = value;
  changes.push({ id: ++changeId, at: now(), who: WHO, key, before, after: value });
}

// ---- the gate (243 phase 1)
let gateVersion = 1;
let gateGraph = { checks: { lookalike_picture: { on: true, match: ["file"] } }, values: { mass_line: null, fast_coins: null, fast_minutes: null } };
const gateVersions = [{ version: 1, applied_at: hourAgo(), applied_by: WHO }];
const gateStatus = () => ({
  as_of: now(), window_s: 3600, coins_in_per_min: 18, coins_passed_per_min: 7, passed: 410, held: 640, not_read_yet: 25, graph: gateVersion,
  checks: {
    lookalike_name_ticker: { held: 301, examples: [{ coin: "PNRSamp1eCoinC111111111111111111111111pump", at: now(), link: "https://solscan.io/token/PNRSamp1eCoinC111111111111111111111111pump" }] },
    lookalike_picture: { held: 120, examples: [] }, same_creator_relaunch: { held: 90, examples: [] }, serial_launcher: { held: 129, examples: [] }, fast_launcher: { held: 0, examples: [] },
  },
});

// ---- routing (243 phase 2); `followed` false for the feed's fields until the feed follows them
const field = (owner, words, sources) => ({ owner, words, sources, default: sources.slice(), followed: owner !== "feed" });
const catalog = {
  fields: {
    picture: field("engine", "a coin's picture", ["jupiter", "ipfs", "pumpfun"]),
    links: field("engine", "a coin's own links (X, website, Telegram)", ["ipfs", "pumpfun"]),
    token_data: field("engine", "token data for the gate", ["jupiter"]),
    price: field("feed", "a coin's price", ["pumpportal", "jupiter", "dexscreener", "geckoterminal", "pumpfun", "tape"]),
    volume: field("feed", "a coin's 24-hour volume", ["dexscreener", "geckoterminal", "pumpfun", "tape"]),
    liquidity: field("feed", "a coin's liquidity", ["dexscreener", "jupiter", "geckoterminal"]),
    candles: field("feed", "a coin's chart candles", ["pumpfun", "tape", "geckoterminal"]),
  },
  sources: { jupiter: "Jupiter (token list, icons, prices)", ipfs: "the coin's own metadata file (IPFS gateways)", pumpfun: "Pump.fun's own API", pumpportal: "PumpPortal's free stream", dexscreener: "DexScreener", geckoterminal: "GeckoTerminal", tape: "PINR's own trade tape" },
  discovery: {
    pumpfun: { owner: "feed", words: "Pump.fun and PumpSwap coins (the app's pool)", default: true, followed: false },
    launchlab: { owner: "engine", words: "Raydium LaunchLab's own list", default: true, followed: true },
    bags: { owner: "engine", words: "Bags' own launch feed", default: true, followed: true },
    jupiter_recent: { owner: "engine", words: "Jupiter's recent list", default: true, followed: true },
    stonkfun: { owner: "engine", words: "Stonk.fun's own ten-minute list", default: true, followed: true },
  },
  nodes: {
    owner: "engine", followed: true, words: "which Solana node answers each kind of read, top wire first",
    kinds: { largest_holders: { words: "a coin's largest holders" }, token_accounts: { words: "a wallet's token accounts" }, transactions: { words: "transactions and their signatures" }, other: { words: "every other read" } },
    names: { public: "Solana's public node", publicnode: "PublicNode", shyft: "Shyft", chainstack: "Chainstack", helius_official: "Helius", rpc_a: "RPC provider A" },
  },
  trade_feed: { owner: "engine", followed: true, words: "the live trade feed's websocket: its first node, the overflow, and how many coins it watches", names: { public: "Solana's public node", publicnode: "PublicNode", chainstack: "Chainstack" }, max_nodes: 2, coins: [1, 1000] },
};
const nodesEffective = { largest_holders: ["public", "helius_official"], token_accounts: ["public", "shyft"], transactions: ["helius_official", "public"], other: ["public", "publicnode", "chainstack"] };
let routeVersion = 0;
let routing = null;
const routeVersions = [];

// ---- Ask PINRai and teachings (245)
const teaching = [{ id: "t1", at: hourAgo(), who: WHO, coin: "PNRSamp1eCoinA111111111111111111111111pump", text: "A sample teaching: a fee wallet is worth a closer look only when the same wallet also sold." }];

const previews = new Map();
let previewId = 0;
const keep = (kind, payload) => {
  const id = `p${++previewId}`;
  previews.set(id, { kind, payload, at: Date.now() });
  return id;
};
const take = (id, kind) => {
  const p = previews.get(id);
  if (!p || p.kind !== kind || Date.now() - p.at > 15 * 60e3) return null;
  previews.delete(id);
  return p.payload;
};

const port = Number(process.argv[2]) || 8790;
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = (code, o) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
    let b = {};
    try { b = body ? JSON.parse(body) : {}; } catch { return j(400, { error: "the body is not JSON" }); }
    const path = (req.url ?? "").split("?")[0];
    const m = req.method;
    // PINRads, as the engine's builder/pinrads reads it: the site's own .data/ads (or STANDIN_ADS_DIR), newest first, at most 200.
    // Map submissions, as ENGINE stores them (invented here, in memory): list newest first, one record, the last accepted map (none: 404).
    if (m === "POST" && path === "/api/control/submissions") {
      if (b.v !== 1 || !b.map || !b.diff) return j(400, { error: "not a map submission" });
      const rec = { id: Math.random().toString(16).slice(2, 14).padEnd(12, "0"), at: new Date().toISOString(), by: "operator@example.test", note: String(b.note || "").slice(0, 2000), diff: b.diff, status: "received", reason: null, decided_at: null, map: b.map };
      submissions.unshift(rec);
      return j(200, { id: rec.id, status: "received", at: rec.at });
    }
    if (m === "GET" && path === "/api/control/submissions") return j(200, { submissions: submissions.slice(0, 200).map(({ map: _m, ...rest }) => rest) });
    if (m === "GET" && path === "/api/control/map/accepted") return j(404, { error: "no map accepted yet" });
    if (m === "GET" && path === "/api/control/pinrads") {
      const dir = process.env.STANDIN_ADS_DIR || join(import.meta.dirname, "..", ".data", "ads");
      const file = join(dir, "applications.jsonl");
      const all = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      return j(200, { applications: all.reverse().slice(0, 200), total: all.length });
    }
    if (m === "GET" && path === "/api/control/pinrads/picture") {
      const id = new URL(req.url ?? "", "http://x").searchParams.get("id") ?? "";
      if (!/^[0-9a-f]{12}$/.test(id)) return j(400, { error: "bad id" });
      const f = join(process.env.STANDIN_ADS_DIR || join(import.meta.dirname, "..", ".data", "ads"), "pictures", `${id}.webp`);
      if (!existsSync(f)) return j(404, { error: "no picture" });
      res.writeHead(200, { "content-type": "image/webp" });
      return res.end(readFileSync(f));
    }
    if (m === "GET" && path === "/api/control/status") {
      return j(200, { as_of: now(), who: WHO, engine: { sources: { dexscreener: src(120, 2), jupiter: src(60), raydium: src(40), ipfs: src(80, 30), "x-api": src(12) }, nodes_effective: routing?.nodes ?? nodesEffective, nodes_fallback: (process.env.STANDIN_FALLBACK || "").split(",").filter(Boolean) }, feed: {}, trades: { coins: 42 }, control, gate: gateStatus(), pinrai: { used_pct: 12, coins_read: 4 }, recent_changes: changes.slice(-20).reverse(), ...(process.env.STANDIN_CAN_APPLY ? { viewer: { can_apply: true } } : {}) });
    }
    if (m === "POST" && path === "/api/control/set") {
      if (b.key === "trades_ws_max_coins" && routing?.trade_feed) return j(409, { error: "trades_ws_max_coins: the trade feed wire is applied on /control (Routes); change the coins there" });
      setKey(String(b.key), b.value);
      return j(200, { control });
    }
    if (m === "POST" && path === "/api/control/undo") {
      const c = changes.find((x) => x.id === b.id);
      if (!c) return j(404, { error: "no such change" });
      setKey(c.key, c.before);
      changes.at(-1).undo_of = c.id;
      return j(200, { control });
    }
    if (m === "GET" && path === "/api/control/gate") return j(200, { version: gateVersion, graph: gateGraph, applied_at: gateVersions.at(-1).applied_at, applied_by: WHO, versions: gateVersions, status: gateStatus(), who: WHO });
    if (m === "POST" && path === "/api/control/gate/preview") {
      const pic = b.graph?.checks?.lookalike_picture;
      if (pic && pic.on !== false && Array.isArray(pic.match) && pic.match.length === 0) return j(422, { problems: ["the picture check is on with no match kind"] });
      const BUILT = ["serial_launcher", "fast_launcher", "same_creator_relaunch", "lookalike_name_ticker", "lookalike_picture"];
      const ord = (g) => { const own = Array.isArray(g?.order) ? g.order.filter((n, i, a) => BUILT.includes(n) && a.indexOf(n) === i) : []; return [...own, ...BUILT.filter((n) => !own.includes(n))]; };
      if (Array.isArray(b.graph?.order) && b.graph.order.some((n) => !BUILT.includes(n))) return j(422, { problems: ["order: a check the gate does not know"] });
      return j(200, { preview_id: keep("gate", b.graph), order_before: ord(gateGraph), order_after: ord(b.graph), coins: 1200, before: { passed: 410, held: 640, not_read_yet: 25, by_check: { serial_launcher: 129 } }, after: { passed: 380, held: 670, not_read_yet: 25, by_check: { serial_launcher: 159 } }, changed_count: 30, changed: [] });
    }
    if (m === "POST" && path === "/api/control/gate/apply") {
      const g = take(b.preview_id, "gate");
      if (!g) return j(409, { error: "the preview is gone or too old: preview again" });
      gateGraph = g;
      gateVersions.push({ version: ++gateVersion, applied_at: now(), applied_by: WHO });
      return j(200, { version: gateVersion });
    }
    if (m === "POST" && path === "/api/control/gate/undo") {
      gateVersions.push({ version: ++gateVersion, applied_at: now(), applied_by: WHO });
      return j(200, { version: gateVersion });
    }
    if (m === "GET" && path === "/api/control/routing") return j(200, { version: routeVersion || null, routing, catalog, versions: routeVersions, who: WHO });
    if (m === "POST" && path === "/api/control/routing/preview") {
      const r = b.routing;
      if (!r || !r.routes || !r.discovery) return j(422, { problems: ["a routing needs routes and discovery"] });
      const problems = [];
      if (!Object.values(r.discovery).some(Boolean)) problems.push("every launchpad is off: at least one must stay on");
      const changesOut = [];
      for (const [f, d] of Object.entries(catalog.fields)) {
        const a = routing?.routes?.[f] ?? d.default;
        const z = r.routes[f] ?? [];
        if (a.join() === z.join()) continue;
        if (!d.followed) problems.push(`${d.words}: the feed does not follow this yet`);
        changesOut.push({ field: f, words: d.words, owner: d.owner, before: a, after: z });
      }
      for (const [l, d] of Object.entries(catalog.discovery)) {
        const a = routing?.discovery?.[l] ?? d.default;
        if (a === r.discovery[l]) continue;
        if (!d.followed) problems.push(`${d.words}: the feed does not follow this yet`);
        changesOut.push({ launchpad: l, words: d.words, owner: d.owner, before: a, after: r.discovery[l] });
      }
      if (r.nodes) {
        for (const k of Object.keys(catalog.nodes.kinds)) {
          const lst = r.nodes[k];
          if (!Array.isArray(lst) || !lst.length) problems.push(`nodes.${k}: needs at least one node`);
          else if ((routing?.nodes?.[k] ?? nodesEffective[k]).join() !== lst.join()) changesOut.push({ nodes: k, words: catalog.nodes.kinds[k].words, owner: "engine", before: routing?.nodes?.[k] ?? nodesEffective[k], after: lst });
        }
      }
      if (r.trade_feed) {
        const t = r.trade_feed;
        if (!Array.isArray(t.nodes) || t.nodes.length < 1 || t.nodes.length > 2) problems.push("trade_feed.nodes: one or 2 nodes (the first, then the overflow)");
        if (!Number.isInteger(t.coins) || t.coins < 1 || t.coins > 1000) problems.push("trade_feed.coins: a whole number from 1 to 1000");
        if (JSON.stringify(t) !== JSON.stringify(routing?.trade_feed ?? null)) changesOut.push({ trade_feed: true, words: catalog.trade_feed.words, owner: "engine", before: routing?.trade_feed ?? null, after: t });
      }
      if (problems.length) return j(422, { problems });
      return j(200, { preview_id: keep("routing", r), changes: changesOut, changed_count: changesOut.length });
    }
    if (m === "POST" && path === "/api/control/routing/apply") {
      const r = take(b.preview_id, "routing");
      if (!r) return j(409, { error: "the preview is gone or too old: preview again" });
      routing = r;
      routeVersions.push({ version: ++routeVersion, applied_at: now(), applied_by: WHO });
      return j(200, { change: {}, routing });
    }
    if (m === "POST" && path === "/api/control/routing/undo") {
      routeVersions.push({ version: ++routeVersion, applied_at: now(), applied_by: WHO });
      return j(200, { routing });
    }
    if (m === "POST" && path === "/api/control/pinrai/ask") {
      if (!control.pinrai.on) return j(200, { status: "off", answer: "", evidence: [], unknown_ids: [], cost_usd: 0, model: null });
      const q = String(b.question ?? "").slice(0, 200);
      return setTimeout(() => j(200, {
        status: "answered", coin: b.coin, who: WHO, asked_at: now(), model: "stand-in", cost_usd: 0.0123, unknown_ids: ["z9"],
        answer: `Observed (stand-in): the fee wallet received 1.25 SOL after the first sells.\nNot checked yet: whether that wallet is the developer's own.\n(You asked: ${q})`,
        evidence: [{ id: "e1", what: "fee payout", value: "1.25 SOL", source: "Solana chain", as_of: hourAgo(), on_chain: true, link: "https://solscan.io/tx/sample" }, { id: "d1", what: "post on X", value: null, source: "X", as_of: hourAgo(), on_chain: false }],
      }), 600);
    }
    if (path === "/api/control/pinrai/teach") {
      if (m === "GET") return j(200, { teaching });
      if (m === "POST") {
        const text = String(b.text ?? "").trim();
        if (!text || text.length > 2000) return j(422, { error: "a teaching is 1 to 2,000 characters" });
        teaching.push({ id: `t${teaching.length + 1}${Date.now() % 1000}`, at: now(), who: WHO, coin: b.coin ?? null, text });
        return j(200, { ok: true });
      }
      if (m === "DELETE") {
        const i = teaching.findIndex((t) => t.id === b.id);
        if (i < 0) return j(404, { error: "no such teaching" });
        teaching.splice(i, 1);
        return j(200, { ok: true });
      }
    }
    j(404, { error: "not found (stand-in)" });
  });
}).listen(port, "127.0.0.1", () => console.log(`Control stand-in on http://127.0.0.1:${port} (not the real service: invented data, no Access check).`));
