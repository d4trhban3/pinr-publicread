// the design's control service (control/server.mjs) with a made-up Access key pair; no network.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { makeApp, accessVerifier, checkChange } from "./server.mjs";

const results = [];
const kase = async (n, title, fn) => {
  let ok = false, text;
  try { [ok, text] = await fn(); } catch (e) { text = "CRASH " + e.message; }
  results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}. ${title}: ${text}`);
};

const TEAM = "https://made-up-team.cloudflareaccess.com", AUD = "made-up-aud";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
const other = await generateKeyPair("RS256");
const sign = (claims, key = privateKey) => new SignJWT({ email: "operator@example.com", ...claims }).setProtectedHeader({ alg: "RS256", kid: "k1" })
  .setIssuedAt().setExpirationTime("10m").setIssuer(claims.iss || TEAM).setAudience(claims.aud || AUD).sign(key);
const verify = accessVerifier({ team_domain: TEAM, aud: AUD }, createLocalJWKSet({ keys: [jwk] }));
const d = mkdtempSync(join(tmpdir(), "ctl-"));
const files = { controlFile: join(d, "control.json"), logFile: join(d, "changes.jsonl"), engineStatus: join(d, "status-engine.json"), tradesStatus: join(d, "t.json") };
writeFileSync(files.engineStatus, JSON.stringify({ sources: { jupiter: { calls: 10, ok: 10 } } }));
files.pinraiDir = join(d, "pinrbot"); (await import("node:fs")).mkdirSync(files.pinraiDir);
writeFileSync(join(files.pinraiDir, "MadeUpCoin1111111111111111111111111111111111.json"), JSON.stringify({ status: "read", model: "m1", cost_usd: 0.01,
  items: [{ kind: "misleading_claim", why: "the model's own sentence", reviewed: true, evidence: ["c1"] }], dropped: [] }));
files.gateFile = join(d, "gate.json"); files.gateVersions = join(d, "gate-versions"); files.gateStatus = join(d, "status-gate.json");
const previewed = [];
const preview = async (g) => { previewed.push(g); return g.checks?.nope ? { valid: false, problems: ["unknown check: nope"] }
  : { valid: true, problems: [], coins: 10, before: { held: 6 }, after: { held: g.checks?.serial_launcher?.on === false ? 4 : 6 }, changed_count: 2, changed: [] }; };
files.teachFile = join(d, "PINRAI-TEACHING.jsonl");
files.pinradsDir = join(d, "pinr-live", ".data", "ads");
const asked = [];
const ask = async (r) => { asked.push(r); return { status: "answered", answer: "observed: the creator sold", evidence: [{ id: "c1" }], unknown_ids: [], cost_usd: 0.001, model: "m1" }; };
files.routingFile = join(d, "routing.json"); files.routingVersions = join(d, "routing-versions"); files.routingCatalog = join(d, "routing-catalog.json");
writeFileSync(files.routingCatalog, JSON.stringify({ fields: { picture: { sources: ["jupiter", "ipfs"] } }, discovery: { bags: {} } }));
const routePreview = async (r) => (r.routes?.picture?.length ? { valid: true, problems: [], changes: [{ field: "picture", before: ["jupiter", "ipfs"], after: r.routes.picture }], changed_count: 1 }
  : { valid: false, problems: ["picture: needs at least one source"] });
let wiresCalls = 0, wiresFail = false;
const wires = async () => { wiresCalls++; if (wiresFail) throw new Error("engine unreadable");
  return { as_of: "2026-10-26T03:00:00Z", window_s: 300, nodes: { a_token: { state: "live", last_at: "2026-10-26T02:59:00Z" } },
           wires: { "s_jup|token data|a_token|Jupiter": { state: "live", per_min: 12, last_at: "2026-10-26T02:59:00Z", sample: { id: "MadeUp" } } } }; };
let clock = 1_000_000;
const app = makeApp({ verify, origin: "https://pinr.io", ...files, preview, ask, routePreview, wires, now: () => clock, fetchFn: async () => ({ ok: true, json: async () => ({ ok: true, tokens: 1 }) }) });
const server = createServer((q, s) => app(q, s));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
import { request as httpRequest } from "node:http";
// pinr.io's own page sends JSON with its own Origin; a test may send other headers.
const call = (path, { method = "GET", token, body, headers } = {}) => new Promise((resolve, reject) => {
  const h = headers || { "content-type": "application/json", origin: "https://pinr.io" };
  const data = body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body));
  const len = data === undefined ? {} : { "content-length": Buffer.byteLength(data) };   // a browser always sends the length (a DELETE body too)
  const r = httpRequest(base + path, { method, headers: { ...(token ? { "cf-access-jwt-assertion": token } : {}), ...len, ...h } }, (res) => {
    let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { try { resolve([res.statusCode, JSON.parse(t)]); } catch (e) { reject(new Error(method + " " + path + " " + res.statusCode + " [" + t + "]")); } });
  });
  r.on("error", reject);
  if (data !== undefined) r.write(data);
  r.end();
});

const good = await sign({});
await kase(1, "Refused without a valid Access token: none, another key, wrong AUD, wrong issuer, expired", async () => {
  const bad = [undefined, "not-a-token", await sign({}, other.privateKey), await sign({ aud: "another-aud" }), await sign({ iss: "https://evil.example" }),
    await new SignJWT({ email: "x" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(TEAM).setAudience(AUD).setIssuedAt(1).setExpirationTime(2).sign(privateKey)];
  const codes = [];
  for (const t of bad) {
    codes.push((await call("/api/control/status", { token: t }))[0]);
    codes.push((await call("/api/control/set", { method: "POST", token: t, body: { key: "trades_ws_max_coins", value: 300 } }))[0]);
  }
  const untouched = (() => { try { readFileSync(files.controlFile); return false; } catch { return true; } })();
  return [codes.every((c) => c === 403) && untouched, `${codes.length} requests, every one ${[...new Set(codes)]}; the control file never written: ${untouched}`];
});

await kase(2, "Status with a valid token: engine, feed, trades, control and who", async () => {
  const [code, body] = await call("/api/control/status", { token: good });
  return [code === 200 && body.who === "operator@example.com" && body.engine.sources.jupiter.calls === 10 && body.feed.tokens === 1, `${code}; who ${body.who}; engine jupiter calls ${body.engine?.sources?.jupiter?.calls}; feed ${JSON.stringify(body.feed)}`];
});

await kase(3, "Set: only a fixed list of keys and values; every change logged with who and when", async () => {
  const rejected = [];
  for (const [k, v] of [["trades_ws_max_coins", 5000], ["trades_ws_max_coins", "300"], ["sources.other.on", false], ["sources.jupiter.on", "no"],
                        ["sources.jupiter.pace_per_min", 0], ["anything", 1], ["sources.../../x.on", true]]) {
    rejected.push((await call("/api/control/set", { method: "POST", token: good, body: { key: k, value: v } }))[0]);
  }
  const [c1, b1] = await call("/api/control/set", { method: "POST", token: good, body: { key: "trades_ws_max_coins", value: 300 } });
  const [c2, b2] = await call("/api/control/set", { method: "POST", token: good, body: { key: "sources.pumpfun-coins.on", value: false } });
  const cfg = JSON.parse(readFileSync(files.controlFile, "utf8"));
  const log = readFileSync(files.logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return [rejected.every((c) => c === 400) && c1 === 200 && c2 === 200 && cfg.trades_ws_max_coins === 300 && cfg.sources["pumpfun-coins"].on === false
    && log.length === 2 && log[0].who === "operator@example.com" && log[0].before === null && log[1].after === false && b2.change.id,
    `7 bad changes refused (${[...new Set(rejected)]}); two accepted; the file holds them; the log has ${log.length} entries with who and when`];
});

await kase(4, "Undo puts a key back as it was, and is logged too", async () => {
  const log = readFileSync(files.logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const [c, b] = await call("/api/control/undo", { method: "POST", token: good, body: { id: log[1].id } });
  const cfg = JSON.parse(readFileSync(files.controlFile, "utf8"));
  const after = readFileSync(files.logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const none = (await call("/api/control/undo", { method: "POST", token: good, body: { id: "no-such-id" } }))[0];
  return [c === 200 && cfg.sources["pumpfun-coins"].on === undefined && after.length === 3 && after[2].undo_of === log[1].id && none === 404,
    `undo of the Pump.fun switch: ${c}, the key gone again (back to its default); logged as undo_of; an unknown id: ${none}`];
});

await kase(5, "Anything else is refused: other paths, other methods, a large body", async () => {
  const a = (await call("/api/control/../../etc/passwd", { token: good }))[0];
  const b = (await call("/api/control/set", { token: good }))[0];
  const c = (await call("/api/control/set", { method: "POST", token: good, body: "x".repeat(5000) }))[0];
  const e = (await call("/elsewhere", { token: good }))[0];
  return [a === 404 && b === 404 && c === 413 && e === 404 && checkChange("trades_ws_max_coins", 150).ok === 150, `path walk ${a}; GET on set ${b}; 5 KB body ${c}; outside /api/control/ ${e}`];
});

await kase(6, "the gate graph's staged apply, versions and undo", async () => {
  const noTok = (await call("/api/control/gate/preview", { method: "POST", body: { graph: {} } }))[0];
  const [bc, bb] = await call("/api/control/gate/preview", { method: "POST", token: good, body: { graph: { checks: { nope: {} } } } });
  const [pc, pb] = await call("/api/control/gate/preview", { method: "POST", token: good, body: { graph: { checks: { serial_launcher: { on: false } } } } });
  const stale = (await call("/api/control/gate/apply", { method: "POST", token: good, body: { preview_id: "made-up" } }))[0];
  const [ac, ab] = await call("/api/control/gate/apply", { method: "POST", token: good, body: { preview_id: pb.preview_id } });
  const again = (await call("/api/control/gate/apply", { method: "POST", token: good, body: { preview_id: pb.preview_id } }))[0];
  const [p2c, p2] = await call("/api/control/gate/preview", { method: "POST", token: good, body: { graph: {} } });
  await call("/api/control/gate/apply", { method: "POST", token: good, body: { preview_id: p2.preview_id } });
  const [uc, ub] = await call("/api/control/gate/undo", { method: "POST", token: good, body: { version: 1 } });
  const [gc, gb] = await call("/api/control/gate", { token: good });
  return [noTok === 403 && bc === 422 && bb.problems[0] === "unknown check: nope" && pc === 200 && pb.before.held === 6 && pb.after.held === 4 && stale === 404
    && ac === 200 && ab.gate.version === 1 && ab.gate.applied_by === "operator@example.com" && again === 404 && uc === 200 && ub.gate.version === 3
    && ub.gate.restores === 1 && gc === 200 && gb.version === 3 && JSON.stringify(gb.graph) === JSON.stringify({ checks: { serial_launcher: { on: false } } })
    && gb.versions.join() === "3,2,1",
    `no token ${noTok}; an invalid graph ${bc} (${bb.problems}); preview ${pc}: held ${pb.before.held} → ${pb.after.held}; apply without a preview ${stale}; apply ${ac} → version ${ab.gate.version} by ${ab.gate.applied_by}; the same preview again ${again}; undo to version 1 → version ${ub.gate.version}; versions kept ${gb.versions}`];
});

await kase(7, "the team's X1: a change only from pinr.io's own page", async () => {
  const body = { key: "sources.dexscreener.on", value: false, x: "=" };
  const tries = [
    ["a form from another site", { "content-type": "text/plain", origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
    ["JSON from another site", { "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
    ["a form from pinr.io", { "content-type": "application/x-www-form-urlencoded", origin: "https://pinr.io" }],
    ["JSON, no origin, cross-site", { "content-type": "application/json", "sec-fetch-site": "cross-site" }],
    ["JSON, no origin, no fetch site (a script)", { "content-type": "application/json" }]];
  const codes = [];
  for (const [, h] of tries) codes.push((await call("/api/control/set", { method: "POST", token: good, body, headers: h }))[0]);
  const gp = (await call("/api/control/gate/preview", { method: "POST", token: good, body: { graph: {} }, headers: tries[0][1] }))[0];
  const cfg = JSON.parse(readFileSync(files.controlFile, "utf8"));
  const same = (await call("/api/control/set", { method: "POST", token: good, body: { key: "sources.dexscreener.on", value: true }, headers: { "content-type": "application/json; charset=utf-8", "sec-fetch-site": "same-origin" } }))[0];
  const own = (await call("/api/control/set", { method: "POST", token: good, body: { key: "sources.dexscreener.pace_per_min", value: 100 } }))[0];
  return [codes.every((c) => c === 403) && gp === 403 && cfg.sources?.dexscreener?.on !== false && same === 200 && own === 200,
    `${tries.map(([w], i) => `${w}: ${codes[i]}`).join("; ")}; gate preview from another site: ${gp}; the switch untouched; same-origin JSON: ${same}; pinr.io's own: ${own}`];
});

await kase(8, "PINRai's switch and daily cap from /control", async () => {
  const bad = [];
  for (const [k, v] of [["pinrai.on", "yes"], ["pinrai.daily_dollar_cap", 0], ["pinrai.daily_dollar_cap", 26], ["pinrai.daily_dollar_cap", 1.005], ["pinrai.model", "x"]])
    bad.push((await call("/api/control/set", { method: "POST", token: good, body: { key: k, value: v } }))[0]);
  const a = (await call("/api/control/set", { method: "POST", token: good, body: { key: "pinrai.on", value: true } }))[0];
  const b = (await call("/api/control/set", { method: "POST", token: good, body: { key: "pinrai.daily_dollar_cap", value: 5 } }))[0];
  const cfg = JSON.parse(readFileSync(files.controlFile, "utf8"));
  return [bad.every((c) => c === 400) && a === 200 && b === 200 && cfg.pinrai.on === true && cfg.pinrai.daily_dollar_cap === 5,
    `5 bad values refused (${[...new Set(bad)]}); on ${a}, cap $5 ${b}; the file holds ${JSON.stringify(cfg.pinrai)}`];
});

await kase(9, "the team's ruling: the model's sentences only on /control, behind Access", async () => {
  const noTok = (await call("/api/control/pinrai?coin=MadeUpCoin1111111111111111111111111111111111"))[0];
  const [c, b] = await call("/api/control/pinrai?coin=MadeUpCoin1111111111111111111111111111111111", { token: good });
  const walk = (await call("/api/control/pinrai?coin=../../.env", { token: good }))[0];
  const none = (await call("/api/control/pinrai?coin=MadeUpNtherCoin11111111111111111111111111111", { token: good }))[0];
  return [noTok === 403 && c === 200 && b.items[0].why === "the model's own sentence" && walk === 400 && none === 404,
    `no token ${noTok}; with the operator's token ${c}: why "${b.items?.[0]?.why}"; a path instead of an address ${walk}; a coin with no reading ${none}`];
});

const COIN = "MadeUpCoin1111111111111111111111111111111111";
await kase(10, "Ask PINRai, private and only from pinr.io's own page", async () => {
  const noTok = (await call("/api/control/pinrai/ask", { method: "POST", body: { coin: COIN, question: "who sold?" } }))[0];
  const form = (await call("/api/control/pinrai/ask", { method: "POST", token: good, headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://pinr.io" }, body: "coin=x" }))[0];
  const elsewhere = (await call("/api/control/pinrai/ask", { method: "POST", token: good, headers: { "content-type": "application/json", origin: "https://evil.example" }, body: { coin: COIN, question: "q" } }))[0];
  const badCoin = (await call("/api/control/pinrai/ask", { method: "POST", token: good, body: { coin: "../../etc/passwd", question: "q" } }))[0];
  const noQ = (await call("/api/control/pinrai/ask", { method: "POST", token: good, body: { coin: COIN, question: "  " } }))[0];
  const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? "pinrai" : "founder", text: "x".repeat(1000) }));
  const before = asked.length;
  const [c, b] = await call("/api/control/pinrai/ask", { method: "POST", token: good, body: { coin: COIN, question: "who sold?", history } });
  const huge = (await call("/api/control/pinrai/ask", { method: "POST", token: good, body: { coin: COIN, question: "x".repeat(40000) } }))[0];
  const sent = asked[before] || {};
  return [noTok === 403 && form === 403 && elsewhere === 403 && badCoin === 400 && noQ === 400 && c === 200 && b.answer === "observed: the creator sold"
          && b.who === "operator@example.com" && sent.coin === COIN && sent.history.length === 6 && huge === 413 && asked.length === before + 1,
    `no token ${noTok}; a form ${form}; another site ${elsewhere}; a path for a coin ${badCoin}; no question ${noQ}; a question with 6 earlier turns (6 KB) ${c}: "${b.answer}" for ${b.who}; 40 KB ${huge}; the engine asked once`];
});

await kase(11, "teaching examples kept, listed and removed by the operator only", async () => {
  const noTok = (await call("/api/control/pinrai/teach", { method: "POST", body: { coin: COIN, text: "t" } }))[0];
  const listNoTok = (await call("/api/control/pinrai/teach"))[0];
  const [k1, b1] = await call("/api/control/pinrai/teach", { method: "POST", token: good, body: { coin: COIN, text: " a serial launcher outweighs a sympathetic story " } });
  const tooLong = (await call("/api/control/pinrai/teach", { method: "POST", token: good, body: { coin: COIN, text: "x".repeat(2001) } }))[0];
  const empty = (await call("/api/control/pinrai/teach", { method: "POST", token: good, body: { coin: COIN, text: " " } }))[0];
  const [l, lb] = await call("/api/control/pinrai/teach", { token: good });
  const delElsewhere = (await call("/api/control/pinrai/teach", { method: "DELETE", token: good, headers: { "content-type": "application/json", origin: "https://evil.example" }, body: { id: b1.kept?.id } }))[0];
  const [del, db] = await call("/api/control/pinrai/teach", { method: "DELETE", token: good, body: { id: b1.kept?.id } });
  const again = (await call("/api/control/pinrai/teach", { method: "DELETE", token: good, body: { id: b1.kept?.id } }))[0];
  const file = readFileSync(files.teachFile, "utf8");
  return [noTok === 403 && listNoTok === 403 && k1 === 200 && b1.kept.text === "a serial launcher outweighs a sympathetic story" && b1.kept.who === "operator@example.com"
          && tooLong === 400 && empty === 400 && l === 200 && lb.teaching.length === 1 && delElsewhere === 403 && del === 200 && db.teaching.length === 0
          && again === 404 && file === "",
    `no token ${noTok}/${listNoTok}; kept ${k1} "${b1.kept?.text}" by ${b1.kept?.who}; 2,001 characters ${tooLong}; empty ${empty}; listed ${lb.teaching?.length}; removed from another site ${delElsewhere}; removed ${del}, then again ${again}; the file left empty`];
});

await kase(12, "routing staged, validated, applied, versioned and undone", async () => {
  const noTok = (await call("/api/control/routing"))[0];
  const elsewhere = (await call("/api/control/routing/preview", { method: "POST", token: good, headers: { "content-type": "application/json", origin: "https://evil.example" }, body: { routing: { routes: { picture: ["ipfs"] } } } }))[0];
  const [g0, b0] = await call("/api/control/routing", { token: good });
  const [bad, bb] = await call("/api/control/routing/preview", { method: "POST", token: good, body: { routing: { routes: { picture: [] } } } });
  const [p1, pb1] = await call("/api/control/routing/preview", { method: "POST", token: good, body: { routing: { routes: { picture: ["ipfs", "jupiter"] }, discovery: { bags: true } } } });
  const untouched = (() => { try { readFileSync(files.routingFile); return false; } catch { return true; } })();
  const [a1, ab1] = await call("/api/control/routing/apply", { method: "POST", token: good, body: { preview_id: pb1.preview_id } });
  const reuse = (await call("/api/control/routing/apply", { method: "POST", token: good, body: { preview_id: pb1.preview_id } }))[0];
  const [, pb2] = await call("/api/control/routing/preview", { method: "POST", token: good, body: { routing: { routes: { picture: ["jupiter"] }, discovery: { bags: true } } } });
  await call("/api/control/routing/apply", { method: "POST", token: good, body: { preview_id: pb2.preview_id } });
  const [u, ub] = await call("/api/control/routing/undo", { method: "POST", token: good, body: { version: 1 } });
  const [g3, b3] = await call("/api/control/routing", { token: good });
  const logged = readFileSync(files.logFile, "utf8").split("\n").filter((l) => l.includes('"routing"')).length;
  return [noTok === 403 && elsewhere === 403 && g0 === 200 && b0.version === 0 && b0.catalog?.fields?.picture && bad === 422 && bb.problems[0].startsWith("picture")
          && p1 === 200 && pb1.changed_count === 1 && untouched && a1 === 200 && ab1.routing.version === 1 && ab1.routing.applied_by === "operator@example.com"
          && reuse === 404 && u === 200 && ub.routing.version === 3 && ub.routing.restores === 1 && JSON.stringify(b3.routing.routes.picture) === '["ipfs","jupiter"]'
          && JSON.stringify(b3.versions) === "[3,2,1]" && logged === 3,
    `no token ${noTok}; another site ${elsewhere}; read ${g0} (version ${b0.version}, catalog shown); a field with no source ${bad}: "${bb.problems?.[0]}"; preview ${p1} (${pb1.changed_count} change, nothing written yet: ${untouched}); applied ${a1} as version ${ab1.routing?.version} by ${ab1.routing?.applied_by}; the same preview again ${reuse}; undo to version 1 ${u} → version ${ub.routing?.version}, picture ${JSON.stringify(b3.routing?.routes?.picture)}; versions ${JSON.stringify(b3.versions)}; ${logged} changes logged`];
});

await kase(13, "the official keys switch on and off and take a pace like any source", async () => {
  const ok = ["helius_official", "alchemy_official"].map((n) => [checkChange(`sources.${n}.on`, false), checkChange(`sources.${n}.pace_per_min`, 60)]);
  const unknown = checkChange("sources.made_up_key.on", false);
  return [ok.every(([a, b]) => a.ok === false && b.ok === 60) && unknown.error === "unknown key",
    `helius_official and alchemy_official: off ${JSON.stringify(ok.map(([a]) => a))}, pace ${JSON.stringify(ok.map(([, b]) => b))}; a name not listed: ${unknown.error}`];
});

await kase(14, "the team's W1 on cb95edd6: the coin-count setting while a trade-feed wire is applied", async () => {
  const before = readFileSync(files.routingFile, "utf8");
  writeFileSync(files.routingFile, JSON.stringify({ version: 9, routing: { routes: {}, discovery: {}, trade_feed: { nodes: ["public"], coins: 60 } } }));
  const [w, wb] = await call("/api/control/set", { method: "POST", token: good, body: { key: "trades_ws_max_coins", value: 200 } });
  const other = (await call("/api/control/set", { method: "POST", token: good, body: { key: "sources.jupiter.on", value: true } }))[0];
  writeFileSync(files.routingFile, before);
  const back = (await call("/api/control/set", { method: "POST", token: good, body: { key: "trades_ws_max_coins", value: 200 } }))[0];
  return [w === 409 && /Routes/.test(wb.error) && other === 200 && back === 200,
    `with the wire applied: ${w} ("${wb.error}"); another setting meanwhile: ${other}; with no trade-feed wire: ${back}`];
});

await kase(15, "the team 2026-10-25: the viewer's own field on the status", async () => {
  const [a, ab] = await call("/api/control/status", { token: good, headers: { origin: "https://pinr.io" } });
  const [b, bb] = await call("/api/control/status", { token: good, headers: { "sec-fetch-site": "same-origin" } });
  const [c, cb] = await call("/api/control/status", { token: good, headers: { "sec-fetch-site": "none" } });
  const [d, db] = await call("/api/control/status", { token: good, headers: { origin: "https://evil.example" } });
  const none = (await call("/api/control/status", { headers: { origin: "https://pinr.io" } }))[0];
  const forged = (await call("/api/control/status", { headers: { origin: "https://pinr.io", "cf-access-authenticated-user-email": "operator@example.com" } }))[0];
  const set = (await call("/api/control/set", { method: "POST", token: good, headers: { "content-type": "application/json", "sec-fetch-site": "none" }, body: { key: "trades_ws_max_coins", value: 100 } }))[0];
  return [a === 200 && ab.viewer?.email === ab.who && ab.viewer.can_apply === true && bb.viewer.can_apply === true && cb.viewer.can_apply === false
          && db.viewer.can_apply === false && none === 403 && forged === 403 && set === 403,
    `from pinr.io: ${ab.viewer?.email}, can apply ${ab.viewer?.can_apply}; same-origin fetch ${bb.viewer?.can_apply}; the API opened directly ${cb.viewer?.can_apply} (and a change from there ${set}); another site ${db.viewer?.can_apply}; no token ${none}; only an email header ${forged}`];
});

await kase(16, "PINRads applications and their pictures on /control, behind Access, newest first, read-only", async () => {
  const { mkdirSync: mk, statSync } = await import("node:fs");
  const file = join(files.pinradsDir, "applications.jsonl");
  const [e0, b0] = await call("/api/control/pinrads", { token: good });                    // no file yet: an empty list
  mk(join(files.pinradsDir, "pictures"), { recursive: true });
  const rows = [{ v: 1, id: "aaaaaaaaaaa1", at: "2026-10-26T01:00:00Z", slot: "A1", name: "Alpha", link: "https://alpha.example", contact: "a@alpha.example", picture: null, extra: "dropped" },
                { v: 1, id: "bbbbbbbbbbb2", at: "2026-10-26T03:00:00Z", slot: "C4", name: "Beta", link: "https://beta.example", contact: "@beta", picture: "bbbbbbbbbbb2.webp" }];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n[1,2]\n");
  writeFileSync(join(files.pinradsDir, "pictures", "bbbbbbbbbbb2.webp"), Buffer.from("RIFF0000WEBPVP8 "));
  const before = statSync(file).mtimeMs;
  const [ok, body] = await call("/api/control/pinrads", { token: good });
  const none = (await call("/api/control/pinrads", {}))[0];
  const post = (await call("/api/control/pinrads", { method: "POST", token: good, body: {} }))[0];
  const raw = (path, token) => new Promise((resolve) => httpRequest(base + path, { headers: token ? { "cf-access-jwt-assertion": token } : {} },
    (r) => { const b = []; r.on("data", (c) => b.push(c)); r.on("end", () => resolve([r.statusCode, r.headers["content-type"], Buffer.concat(b)])); }).end());
  const [p1, ct, pb] = await raw("/api/control/pinrads/picture?id=bbbbbbbbbbb2", good);
  const p2 = (await raw("/api/control/pinrads/picture?id=../../x", good))[0];
  const p3 = (await raw("/api/control/pinrads/picture?id=ccccccccccc3", good))[0];
  const p4 = (await raw("/api/control/pinrads/picture?id=bbbbbbbbbbb2"))[0];
  const untouched = statSync(file).mtimeMs === before;
  const ids = (body.applications || []).map((a) => a.id);
  return [e0 === 200 && b0.applications.length === 0 && ok === 200 && ids.join() === "bbbbbbbbbbb2,aaaaaaaaaaa1" && body.total === 2
          && !("extra" in body.applications[1]) && body.applications[0].name === "Beta" && none === 403 && post === 404 && untouched
          && p1 === 200 && ct === "image/webp" && pb.toString().startsWith("RIFF") && p2 === 400 && p3 === 404 && p4 === 403,
    `no file: ${b0.applications?.length} listed; two and two bad lines: ${ids} (newest first), total ${body.total}, an unknown field dropped; no token ${none}; a POST ${post}; file unchanged ${untouched}; picture ${p1} ${ct}, a path in the id ${p2}, none ${p3}, no token ${p4}`];
});

await kase(17, "the engine's measured wire states on /control, behind Access, cached a few seconds", async () => {
  const [a, ab] = await call("/api/control/wires", { token: good });
  const [b] = await call("/api/control/wires", { token: good });
  const callsCached = wiresCalls;
  clock += 6_000; wiresFail = true;
  const [c, cb] = await call("/api/control/wires", { token: good });
  const none = (await call("/api/control/wires", {}))[0];
  wiresFail = false;
  const w = ab.wires?.["s_jup|token data|a_token|Jupiter"];
  return [a === 200 && b === 200 && w?.state === "live" && w.per_min === 12 && w.sample?.id === "MadeUp" && callsCached === 1 && c === 503 && cb.error && none === 403,
    `live wire ${w?.state} ${w?.per_min}/min with its sample; a second read within 5 s asked the engine ${callsCached} time in all; the engine unreadable: ${c}; no token ${none}`];
});

server.close();
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passing`);
process.exit(passed === results.length ? 0 : 1);
