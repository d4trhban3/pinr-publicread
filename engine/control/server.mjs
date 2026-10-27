// pinr.io/control's service, the server side. Listens on 127.0.0.1 only; pinr.io/api/control/* reaches it
// through Cloudflare Access, and EVERY request is refused (403) unless its Cf-Access-Jwt-Assertion verifies against the
// team's Access keys, issuer and AUD (control/access.json). Nothing here reads or writes a key.
//   GET  /api/control/status  per source, engine and feed, rolling hour; the trade feed; the control file in force
//   GET  /api/control/status  ... and `viewer`: {"email" (from the verified Access token), "can_apply": true only when this
//                              viewer's changes would be accepted (a valid token, asked from pinr.io's own page)}
//   POST /api/control/set     {"key", "value"}: one setting, from a fixed list; logged with who and when
//   POST /api/control/undo    {"id"}: puts that change's key back as it was before; logged too
//   POST /api/control/pinrai/ask    {"coin", "question", "history"?}: PINRai's private answer from that coin's evidence (245)
//   GET  /api/control/routing  the routing in force (each field's sources in wire order, each
//                              launchpad's discovery), the catalog, the versions; POST .../routing/preview {routing},
//                              .../routing/apply {preview_id}, .../routing/undo {version}: staged, validated, logged
//   GET  /api/control/pinrai/teach  the operator's teaching examples; POST {"coin", "text"} keeps one; DELETE {"id"} removes one
import { createServer } from "node:http";
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createRemoteJWKSet, jwtVerify } from "jose";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, "..");
export const PORT = 8790;
export const WIRES_CACHE_MS = 5_000;
export const PINRADS_FIELDS = ["v", "id", "at", "slot", "name", "link", "contact", "picture"];   // a design decision, the site's record
export const PINRADS_MAX = 200;
const MAX_BODY = 4096;
const ASK_MAX_BODY = 32768;          // a question with its earlier turns (stage3/pinrai_ask.py cuts each to its own length)
const TEACH_MAX = 2000;              // characters a teaching example may hold (stage3/pinrbot.py TEACH_MAX)
const COIN_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** PINRai's answer from the engine (stage3/pinrai_ask.py), the request as JSON on its standard input. */
/** the engine's measured node and wire states (scanner/wires.py merges each process's counts). */
export function engineWires({ timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("python3", [join(ENGINE, "scanner", "wires.py"), "state"], { timeout: timeoutMs, maxBuffer: 4_000_000 }, (err, out) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

export function engineAsk(request, { timeoutMs = 240_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("python3", [join(ENGINE, "stage3", "pinrai_ask.py"), "ask"], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const t = setTimeout(() => { p.kill(); reject(new Error("timeout")); }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", () => { clearTimeout(t); try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    p.stdin.end(JSON.stringify(request));
  });
}

// The sources an engine reader is counted under (stage2/solana_rpc.py LABELS) and the feed's own. "other" (coins' own
// metadata and picture hosts) is not switchable: it is every coin's own address, not one source.
export const SOURCES = ["pumpfun-coins", "pumpfun-trades", "dexscreener", "geckoterminal", "coingecko", "raydium", "raydium-launchlab",
  "jupiter", "helius-history", "helius", "shyft", "shyft-parse", "chainstack", "public", "publicnode-solana", "stonkfun", "ipfs",
  "goplus", "rdap", "ankr", "base-public", "bsc-public", "publicnode", "drpc", "tenderly", "blastapi", "nodereal", "x-api",
  "helius_official", "alchemy_official"];                 // the operator's official keys, their own nodes

/** The one change a set may make: [key, value] → the checked value, or an error word. */
export function checkChange(key, value) {
  if (key === "pinrai.on") return typeof value === "boolean" ? { ok: value } : { error: "pinrai.on: true or false" };   // a design decision
  if (key === "pinrai.daily_dollar_cap") {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 25 && Math.round(value * 100) === value * 100
      ? { ok: value } : { error: "pinrai.daily_dollar_cap: dollars above 0, at most 25, in cents" };
  }
  if (key === "trades_ws_max_coins") {
    return Number.isInteger(value) && value >= 1 && value <= 1000 ? { ok: value } : { error: "trades_ws_max_coins: a whole number 1 to 1000" };
  }
  const m = typeof key === "string" ? key.match(/^sources\.([a-z0-9_-]{2,40})\.(on|pace_per_min)$/) : null;
  if (!m || !SOURCES.includes(m[1])) return { error: "unknown key" };
  if (m[2] === "on") return typeof value === "boolean" ? { ok: value } : { error: "on: true or false" };
  if (value === null) return { ok: null };
  return Number.isInteger(value) && value >= 1 && value <= 6000 ? { ok: value } : { error: "pace_per_min: null or a whole number 1 to 6000" };
}

function getPath(obj, key) {
  return key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}
function setPath(obj, key, value) {
  const parts = key.split(".");
  let o = obj;
  for (const k of parts.slice(0, -1)) { if (!o[k] || typeof o[k] !== "object") o[k] = {}; o = o[k]; }
  if (value === undefined) delete o[parts.at(-1)]; else o[parts.at(-1)] = value;
}

/** the engine's preview of a proposed gate graph (scanner/gategraph.py), as JSON; refuses on a timeout. */
export function enginePreview(graph, { gateFile = join(HERE, "gate.json") } = {}) {
  return new Promise((resolve, reject) => {
    const tmp = join(HERE, `.preview-${randomUUID()}.json`);
    writeFileSync(tmp, JSON.stringify(graph));
    execFile("python3", [join(ENGINE, "scanner", "gategraph.py"), "preview", tmp], { timeout: 120_000, env: { ...process.env, PINR_GATE_FILE: gateFile } },
      (err, stdout) => { try { unlinkSync(tmp); } catch {} try { if (err) throw err; resolve(JSON.parse(stdout)); } catch (e) { reject(e); } });
  });
}

/** the engine's validation and before/after of a proposed routing (scanner/routing.py), as JSON. */
export function routingPreview(routing, { routingFile = join(HERE, "routing.json") } = {}) {
  return new Promise((resolve, reject) => {
    const tmp = join(HERE, `.routing-preview-${randomUUID()}.json`);
    writeFileSync(tmp, JSON.stringify(routing));
    execFile("python3", [join(ENGINE, "scanner", "routing.py"), "preview", tmp], { timeout: 60_000, env: { ...process.env, PINR_ROUTING_FILE: routingFile } },
      (err, stdout) => { try { unlinkSync(tmp); } catch {} try { if (err) throw err; resolve(JSON.parse(stdout)); } catch (e) { reject(e); } });
  });
}

/** the team's X1 (1eeb96ea): a change only from pinr.io's own page: a JSON body, and the browser's own word that the request
 *  comes from that origin (Origin, or Sec-Fetch-Site same-origin). A form or a page elsewhere cannot send either. */
export function sameSite(req, origin) {
  const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") return false;
  const o = req.headers["origin"], sfs = req.headers["sec-fetch-site"];
  if (o !== undefined) return o === origin;
  return sfs === "same-origin";
}

/** the team 2026-10-25: may this viewer's changes go through? Only from the verified Access token (the caller has one, or no
 *  answer at all) and pinr.io's own page: the same origin rule a change must pass (`sameSite`, less its JSON body rule). */
export function fromSite(req, origin) {
  const o = req.headers["origin"], sfs = req.headers["sec-fetch-site"];
  if (o !== undefined) return o === origin;
  return sfs === "same-origin";
}

export function makeApp({ verify, origin = "https://pinr.io", controlFile = join(HERE, "control.json"), logFile = join(HERE, "changes.jsonl"),
                          pinraiDir = join(ENGINE, "index", "pinrbot"), teachFile = join(ENGINE, "PINRAI-TEACHING.jsonl"),
                          pinradsDir = join(ENGINE, "..", "..", "pinr-live", ".data", "ads"),
                          ask = engineAsk, wires = engineWires,
                          routingFile = join(HERE, "routing.json"), routingVersions = join(HERE, "routing-versions"),
                          routingCatalog = join(HERE, "routing-catalog.json"), routePreview = (r) => routingPreview(r, { routingFile }),
                          gateFile = join(HERE, "gate.json"), gateVersions = join(HERE, "gate-versions"), gateStatus = join(HERE, "status-gate.json"),
                          preview = (g) => enginePreview(g, { gateFile }),
                          engineStatus = join(HERE, "status-engine.json"), tradesStatus = join(ENGINE, "frontend-feed", "ticks", "_status.json"),
                          feedHealth = "http://127.0.0.1:8787/api/health", fetchFn = fetch, now = () => Date.now() } = {}) {
  const wiresCache = { at: 0, body: null };
  const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; } };
  const writeWhole = (p, body) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p + ".tmp", JSON.stringify(body, null, 1)); renameSync(p + ".tmp", p); };
  const log = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
  const apply = (key, value, who, extra = {}) => {
    const cfg = readJson(controlFile, {});
    const before = getPath(cfg, key);
    setPath(cfg, key, value);
    cfg.updated_at = new Date(now()).toISOString(); cfg.updated_by = who;
    writeWhole(controlFile, cfg);
    const entry = { id: randomUUID(), at: cfg.updated_at, who, key, before: before === undefined ? null : before, after: value, ...extra };
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
    return entry;
  };

  const teachings = () => (existsSync(teachFile) ? readFileSync(teachFile, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((t) => t && typeof t.id === "string") : []);

  const previews = new Map();                             // preview id -> {graph, result, at}; kept 15 minutes
  const gateNow = () => readJson(gateFile, { version: 0, graph: {} });
  const applyGraph = (graph, who, extra) => {
    const cur = gateNow();
    mkdirSync(gateVersions, { recursive: true });
    if (cur.version > 0) writeWhole(join(gateVersions, `v${cur.version}.json`), cur);
    const next = { version: (cur.version || 0) + 1, graph, applied_at: new Date(now()).toISOString(), applied_by: who, ...extra };
    writeWhole(gateFile, next);
    writeWhole(join(gateVersions, `v${next.version}.json`), next);
    const entry = { id: randomUUID(), at: next.applied_at, who, key: "gate_graph", before: cur.version || null, after: next.version, ...extra };
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
    return { change: entry, gate: next };
  };

  const routes = new Map();                               // routing preview id -> {routing, result, at}; kept 15 minutes
  const routingNow = () => readJson(routingFile, { version: 0, routing: null });
  const applyRouting = (routing, who, extra) => {
    const cur = routingNow();
    mkdirSync(routingVersions, { recursive: true });
    if (cur.version > 0) writeWhole(join(routingVersions, `v${cur.version}.json`), cur);
    const next = { version: (cur.version || 0) + 1, routing, applied_at: new Date(now()).toISOString(), applied_by: who, ...extra };
    writeWhole(routingFile, next);
    writeWhole(join(routingVersions, `v${next.version}.json`), next);
    const entry = { id: randomUUID(), at: next.applied_at, who, key: "routing", before: cur.version || null, after: next.version, ...extra };
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
    return { change: entry, routing: next };
  };

  return async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/control/")) return send(404, { error: "not found" });
    let who;
    try {
      who = await verify(req.headers["cf-access-jwt-assertion"]);
    } catch {
      return send(403, { error: "refused: no valid Cloudflare Access token" });
    }
    if (req.method === "GET" && url.pathname === "/api/control/status") {
      let feed = null;
      try { const r = await fetchFn(feedHealth, { signal: AbortSignal.timeout(3000) }); feed = r.ok ? await r.json() : null; } catch {}
      return send(200, { as_of: new Date(now()).toISOString(), engine: readJson(engineStatus, null), feed, trades: readJson(tradesStatus, null),
                         control: readJson(controlFile, {}), gate: readJson(gateStatus, null), recent_changes: log().slice(-20).reverse(), who,
                         viewer: { email: who, can_apply: fromSite(req, origin) } });
    }
    if (req.method === "GET" && url.pathname === "/api/control/wires") {
      // LIVE (data crossed in the last few minutes: items/min, last time, a real sample) or NOT LIVE with the
      // reason, measured where the data crosses in the engine; read-only, behind Access, cached a few seconds.
      if (!wiresCache.at || now() - wiresCache.at > WIRES_CACHE_MS) {
        try { wiresCache.body = await wires(); wiresCache.at = now(); }
        catch { return send(503, { error: "the engine's wire states could not be read" }); }
      }
      return send(200, wiresCache.body);
    }
    if (req.method === "GET" && url.pathname === "/api/control/pinrads") {
      // PINRads applications for the operator, behind the Access check, read-only, newest first. the site's form
      // appends them in pinr-live/.data/ads (git-ignored; the site serves only dist/); a line that is not an object is skipped.
      const file = join(pinradsDir, "applications.jsonl");
      const apps = (existsSync(file) ? readFileSync(file, "utf8").split("\n") : []).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((a) => a && typeof a === "object" && !Array.isArray(a))
        .map((a) => Object.fromEntries(PINRADS_FIELDS.filter((k) => k in a).map((k) => [k, a[k]])));
      apps.sort((x, y) => String(y.at || "").localeCompare(String(x.at || "")));
      return send(200, { applications: apps.slice(0, PINRADS_MAX), total: apps.length, who });
    }
    if (req.method === "GET" && url.pathname === "/api/control/pinrads/picture") {
      // The picture an application carries, as the site's site re-encoded it (WebP, <id>.webp); only that exact name is read.
      const id = url.searchParams.get("id") || "";
      if (!/^[0-9a-f]{12}$/.test(id)) return send(400, { error: "id: 12 hex characters" });
      const pic = join(pinradsDir, "pictures", id + ".webp");
      if (!existsSync(pic)) return send(404, { error: "no picture" });
      res.writeHead(200, { "content-type": "image/webp", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      return res.end(readFileSync(pic));
    }
    if (req.method === "GET" && url.pathname === "/api/control/pinrai") {
      // the team's ruling on 4a740852: the model's own sentences only here, behind the Access check, never on a public page.
      const coin = url.searchParams.get("coin") || "";
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(coin)) return send(400, { error: "coin: a Solana address" });
      const r = readJson(join(pinraiDir, coin + ".json"), null);
      if (!r || typeof r !== "object") return send(404, { error: "no PINRai reading for this coin" });
      return send(200, { coin, status: r.status, read_at: r.read_at, model: r.model, cost_usd: r.cost_usd,
        items: (r.items || []).map((it) => ({ kind: it.kind, why: it.why, reviewed: !!it.reviewed, evidence: it.evidence })),
        dropped: r.dropped || [], pending: r.pending || [], review: r.review || null, who });
    }
    if (req.method === "GET" && url.pathname === "/api/control/routing") {
      let versions = [];
      try { versions = readdirSync(routingVersions).filter((f) => /^v\d+\.json$/.test(f)).map((f) => Number(f.slice(1, -5))).sort((a, b) => b - a); } catch {}
      return send(200, { ...routingNow(), catalog: readJson(routingCatalog, null), versions, who });
    }
    if (req.method === "GET" && url.pathname === "/api/control/pinrai/teach") return send(200, { teaching: teachings(), who });
    if (req.method === "GET" && url.pathname === "/api/control/gate") {
      let versions = [];
      try { versions = readdirSync(gateVersions).filter((f) => /^v\d+\.json$/.test(f)).map((f) => Number(f.slice(1, -5))).sort((a, b) => b - a); } catch {}
      return send(200, { ...gateNow(), versions, status: readJson(gateStatus, null), who });
    }
    const POSTS = ["/api/control/set", "/api/control/undo", "/api/control/gate/preview", "/api/control/gate/apply", "/api/control/gate/undo",
      "/api/control/pinrai/ask", "/api/control/pinrai/teach", "/api/control/routing/preview", "/api/control/routing/apply", "/api/control/routing/undo"];
    const isDelete = req.method === "DELETE" && url.pathname === "/api/control/pinrai/teach";
    if (!isDelete && (req.method !== "POST" || !POSTS.includes(url.pathname))) return send(404, { error: "not found" });
    if (!sameSite(req, origin)) return send(403, { error: "refused: a change only from pinr.io's own page (JSON, same origin)" });
    const limit = url.pathname === "/api/control/pinrai/ask" ? ASK_MAX_BODY : MAX_BODY;
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > limit) return send(413, { error: "body too large" }); }
    let body;
    try { body = JSON.parse(raw); } catch { return send(400, { error: "JSON body expected" }); }
    if (url.pathname === "/api/control/pinrai/ask") {
      // the answer stays here, behind the Access check; nothing public is written. His words are data to PINRai.
      if (!COIN_RE.test(String(body?.coin || ""))) return send(400, { error: "coin: a Solana address" });
      if (typeof body.question !== "string" || !body.question.trim()) return send(400, { error: "question: some words" });
      const history = Array.isArray(body.history) ? body.history : [];
      let r;
      try { r = await ask({ coin: body.coin, question: body.question, history }); } catch { return send(502, { error: "PINRai did not answer in time" }); }
      return send(200, { ...r, coin: body.coin, who });
    }
    if (url.pathname === "/api/control/pinrai/teach" && isDelete) {
      const all = teachings();
      const keep = all.filter((t) => t.id !== body?.id);
      if (keep.length === all.length) return send(404, { error: "no such teaching example" });
      mkdirSync(dirname(teachFile), { recursive: true });
      writeFileSync(teachFile + ".tmp", keep.map((t) => JSON.stringify(t) + "\n").join(""));
      renameSync(teachFile + ".tmp", teachFile);
      return send(200, { removed: body.id, teaching: keep, who });
    }
    if (url.pathname === "/api/control/pinrai/teach") {
      if (!COIN_RE.test(String(body?.coin || ""))) return send(400, { error: "coin: a Solana address" });
      if (typeof body.text !== "string" || !body.text.trim() || body.text.length > TEACH_MAX) return send(400, { error: `text: 1 to ${TEACH_MAX} characters` });
      const t = { id: randomUUID(), at: new Date(now()).toISOString(), who, coin: body.coin, text: body.text.trim() };
      mkdirSync(dirname(teachFile), { recursive: true });
      appendFileSync(teachFile, JSON.stringify(t) + "\n");
      return send(200, { kept: t, teaching: teachings(), who });
    }
    if (url.pathname === "/api/control/routing/preview") {
      if (!body || typeof body.routing !== "object" || body.routing === null || Array.isArray(body.routing)) return send(400, { error: "a routing object expected" });
      let result;
      try { result = await routePreview(body.routing); } catch { return send(502, { error: "the engine's preview did not answer" }); }
      if (!result.valid) return send(422, { valid: false, problems: result.problems });
      const id = randomUUID();
      for (const [k, v] of routes) if (now() - v.at > 15 * 60_000) routes.delete(k);
      routes.set(id, { routing: body.routing, result, at: now(), who });
      return send(200, { preview_id: id, ...result });
    }
    if (url.pathname === "/api/control/routing/apply") {
      const p = routes.get(body?.preview_id);
      if (!p || now() - p.at > 15 * 60_000) return send(404, { error: "no such preview (or older than 15 minutes): preview again" });
      routes.delete(body.preview_id);
      return send(200, applyRouting(p.routing, who, { from_preview: body.preview_id }));
    }
    if (url.pathname === "/api/control/routing/undo") {
      const v = Number.isInteger(body?.version) ? readJson(join(routingVersions, `v${body.version}.json`), null) : null;
      if (!v || typeof v.routing !== "object") return send(404, { error: "no such version" });
      let result;
      try { result = await routePreview(v.routing); } catch { return send(502, { error: "the engine's preview did not answer" }); }
      if (!result.valid) return send(422, { valid: false, problems: result.problems });
      return send(200, applyRouting(v.routing, who, { restores: body.version }));
    }
    if (url.pathname === "/api/control/gate/preview") {
      if (!body || typeof body.graph !== "object" || body.graph === null || Array.isArray(body.graph)) return send(400, { error: "a graph object expected" });
      let result;
      try { result = await preview(body.graph); } catch { return send(502, { error: "the engine's preview did not answer" }); }
      if (!result.valid) return send(422, { valid: false, problems: result.problems });
      const id = randomUUID();
      for (const [k, v] of previews) if (now() - v.at > 15 * 60_000) previews.delete(k);
      previews.set(id, { graph: body.graph, result, at: now(), who });
      return send(200, { preview_id: id, ...result });
    }
    if (url.pathname === "/api/control/gate/apply") {
      const p = previews.get(body?.preview_id);
      if (!p || now() - p.at > 15 * 60_000) return send(404, { error: "no such preview (or older than 15 minutes): preview again" });
      previews.delete(body.preview_id);
      return send(200, applyGraph(p.graph, who, { from_preview: body.preview_id }));
    }
    if (url.pathname === "/api/control/gate/undo") {
      const v = Number.isInteger(body?.version) ? readJson(join(gateVersions, `v${body.version}.json`), null) : null;
      if (!v || typeof v.graph !== "object") return send(404, { error: "no such version" });
      let result;
      try { result = await preview(v.graph); } catch { return send(502, { error: "the engine's preview did not answer" }); }
      if (!result.valid) return send(422, { valid: false, problems: result.problems });
      return send(200, applyGraph(v.graph, who, { restores: body.version }));
    }
    // the team's W1 on cb95edd6: while a trade_feed wire is applied it sets the feed's coin count; this setting would change nothing
    const wired = (key) => key === "trades_ws_max_coins" && routingNow().routing?.trade_feed && typeof routingNow().routing.trade_feed === "object";
    const WIRED = { error: "trades_ws_max_coins: the trade feed's wire (Routes) sets its coin count while it is applied; change it there" };
    if (url.pathname === "/api/control/set") {
      if (wired(body?.key)) return send(409, WIRED);
      const c = checkChange(body?.key, body?.value);
      if (c.error) return send(400, { error: c.error });
      return send(200, { change: apply(body.key, c.ok, who), control: readJson(controlFile, {}) });
    }
    const target = log().find((e) => e.id === body?.id);
    if (!target) return send(404, { error: "no such change" });
    if (wired(target.key)) return send(409, WIRED);
    const c = target.before === null ? { ok: undefined } : checkChange(target.key, target.before);
    if (c.error) return send(400, { error: c.error });
    return send(200, { change: apply(target.key, c.ok, who, { undo_of: target.id }), control: readJson(controlFile, {}) });
  };
}

/** The Access check: the token's signature against the team's published keys, its issuer and its AUD. Returns the email. */
export function accessVerifier({ team_domain, aud }, jwks = createRemoteJWKSet(new URL(`${team_domain}/cdn-cgi/access/certs`))) {
  return async (token) => {
    if (typeof token !== "string" || !token) throw new Error("no token");
    const { payload } = await jwtVerify(token, jwks, { issuer: team_domain, audience: aud });
    return typeof payload.email === "string" ? payload.email : String(payload.sub || "unknown");
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const access = JSON.parse(readFileSync(join(HERE, "access.json"), "utf8"));
  const app = makeApp({ verify: accessVerifier(access), origin: access.origin || "https://pinr.io" });
  createServer((req, res) => { app(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch {} }); })
    .listen(PORT, "127.0.0.1", () => console.log(`pinr control on http://127.0.0.1:${PORT} (Access: ${access.team_domain})`));
}
