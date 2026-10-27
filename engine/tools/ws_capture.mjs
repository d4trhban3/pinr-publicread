// one short sample of the launchpad programs' logs over a standard Solana websocket (logsSubscribe with
// `mentions`), saved so the trade decoder is built against real messages. Node 24's built-in WebSocket; nothing to
// install. The node's address comes from the engine's .env and is never printed.
//   node tools/ws_capture.mjs <seconds> <out.json> [node]      node: chainstack (default) | helius | shyft
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(readFileSync(join(ENGINE, ".env"), "utf8").split("\n")
  .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const NODES = {
  chainstack: () => (env.CHAINSTACK_SOLANA_URL || "").replace(/^https:\/\//, "wss://"),
  helius: () => env.HELIUS_API_KEY && "wss://mainnet.helius-rpc.com/?api-key=" + env.HELIUS_API_KEY,
  shyft: () => env.SHYFT_API_KEY && "wss://rpc.shyft.to?api_key=" + env.SHYFT_API_KEY,
};
const PROGRAMS = { pumpfun: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", launchlab: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj" };

const [secs = "20", out = "/tmp/ws_capture.json", which = "chainstack"] = process.argv.slice(2);
const url = NODES[which]?.();
if (!url || !url.startsWith("wss://")) { console.log(`${which}: no websocket address in the .env`); process.exit(1); }

const subs = {}, got = { pumpfun: [], launchlab: [] }, errors = [];
const t0 = Date.now();
const ws = new WebSocket(url);
ws.onopen = () => {
  let id = 1;
  for (const [name, prog] of Object.entries(PROGRAMS)) {
    subs[id] = name;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: id++, method: "logsSubscribe", params: [{ mentions: [prog] }, { commitment: "confirmed" }] }));
  }
};
const bySub = {};
ws.onmessage = (ev) => {
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
  if (m.id && subs[m.id]) { if (m.error) errors.push({ program: subs[m.id], error: m.error }); else bySub[m.result] = subs[m.id]; return; }
  if (m.method === "logsNotification") {
    const name = bySub[m.params.subscription];
    const v = m.params.result.value;
    if (name) got[name].push({ at: Date.now() - t0, slot: m.params.result.context.slot, signature: v.signature, err: v.err, logs: v.logs });
  }
};
ws.onerror = (e) => errors.push({ socket: String(e.message || e.type) });
ws.onclose = (e) => { if (Date.now() - t0 < Number(secs) * 1000) errors.push({ closed: e.code, reason: e.reason }); };
setTimeout(() => {
  try { ws.close(); } catch {}
  writeFileSync(out, JSON.stringify({ node: which, seconds: Number(secs), at: new Date(t0).toISOString(), errors, ...got }));
  const n = (k) => got[k].length, ok = (k) => got[k].filter((x) => !x.err).length;
  console.log(JSON.stringify({ node: which, seconds: Number(secs), pumpfun: n("pumpfun"), pumpfun_ok: ok("pumpfun"), launchlab: n("launchlab"), launchlab_ok: ok("launchlab"), errors }));
  process.exit(0);
}, Number(secs) * 1000);
