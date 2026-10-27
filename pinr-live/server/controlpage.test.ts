import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "./staticsite";

/** The blueprint page served at /control: the operator's editable node map, unchanged, as a static page. */
const dir = join(import.meta.dirname, "..", "public", "control");
const html = readFileSync(join(dir, "index.html"), "utf8");
const js = readFileSync(join(dir, "blueprint.js"), "utf8");
const liveJs = readFileSync(join(dir, "live.js"), "utf8");
const win: { PinrLive?: any } = {};
vm.runInNewContext(liveJs, { window: win, setInterval: () => 0 }); // no `document`: only the pure parts are defined
const L = win.PinrLive;
const gateWin: { PinrGate?: any } = {};
vm.runInNewContext(readFileSync(join(dir, "gate.js"), "utf8"), { window: gateWin });
const GT = gateWin.PinrGate;

describe("the /control blueprint page", () => {
  it("is the operator's node map: a title, the node map's stage, its edit panel, and its script as a file", () => {
    expect(html).toMatch(/<title>[^<]*<\/title>/);
    expect(html).toContain('id="view"');
    expect(html).toContain('id="panel"');
    expect(html).toContain('<script src="/control/blueprint.js"></script>');
    expect(html).toContain('<script src="/control/live.js"></script>');
    expect(js.startsWith('"use strict";')).toBe(true);
    expect(js).toContain("localStorage");
  });
  it("runs under the site's security policy: no inline script and no inline event handler (script-src is 'self')", () => {
    expect(SECURITY_HEADERS["content-security-policy"]).toContain("script-src 'self';");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
  });
  it("loads nothing from another site", () => {
    expect(html).not.toMatch(/(src|href)=["']https?:\/\//);
    expect(js).not.toMatch(/fetch\(|XMLHttpRequest|new WebSocket|import\(/);
  });
  it("the live layer talks only to the site's own /api/control/* and puts nothing the server sends on the page as markup", () => {
    expect(liveJs).not.toMatch(/https?:\/\//);
    expect(liveJs).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function/);
    const paths = [...liveJs.matchAll(/["'`](\/api\/[a-z/]+)["'`]/g)].map((m) => m[1]);
    expect(new Set(paths)).toEqual(new Set(["/api/control/status", "/api/control/set", "/api/control/undo"]));
  });
});

describe("the live layer's reading of the engine's status", () => {
  const src = (o: Record<string, number | string | null>) => ({ calls: 0, ok: 0, errors: 0, http429: 0, timeouts: 0, last_ok: null, ...o });
  it("adds the counters of the sources a node stands for", () => {
    const t = L.sum({ helius: src({ calls: 10, ok: 9, errors: 1, last_ok: "2026-10-23T10:00:00Z" }), shyft: src({ calls: 5, ok: 5, last_ok: "2026-10-23T10:05:00Z", http429: 2 }) }, L.SRC.s_rpc);
    expect(t).toMatchObject({ calls: 15, ok: 14, errors: 1, http429: 2, seen: 2, last_ok: "2026-10-23T10:05:00Z" });
    expect(L.sum({}, ["jupiter"]).seen).toBe(0);
    expect(L.sum(null, ["jupiter"]).calls).toBe(0);
  });
  it("colours a node: red for a source with no good call or a third failing, amber for a 429 or a timeout, off, idle, else ok", () => {
    expect(L.stateOf(L.sum({ a: src({ calls: 12, ok: 0, errors: 12 }) }, ["a"]), false)).toBe("red");
    expect(L.stateOf(L.sum({ a: src({ calls: 10, ok: 6, errors: 4 }) }, ["a"]), false)).toBe("red");
    expect(L.stateOf(L.sum({ a: src({ calls: 100, ok: 97, errors: 3, http429: 3 }) }, ["a"]), false)).toBe("warn");
    expect(L.stateOf(L.sum({ a: src({ calls: 100, ok: 100, timeouts: 1 }) }, ["a"]), false)).toBe("warn");
    expect(L.stateOf(L.sum({ a: src({ calls: 100, ok: 99, errors: 1 }) }, ["a"]), false)).toBe("ok");
    expect(L.stateOf(L.sum({}, ["a"]), false)).toBe("idle");
    expect(L.stateOf(L.sum({ a: src({ calls: 100, ok: 0, errors: 100 }) }, ["a"]), true)).toBe("off"); // switched off wins
  });
  it("maps the blueprint's source nodes to the control service's own source names", () => {
    expect(L.SRC.s_pump).toEqual(["pumpfun-coins", "pumpfun-trades"]);
    expect(L.SRC.s_dex).toEqual(["dexscreener"]);
    expect(L.SRC.s_jup).toEqual(["jupiter"]);
    expect(L.TRADES_NODE).toBe("s_ws");
  });
  it("says which edits are live and which are drawing only", () => {
    expect(L.NOTE_ALL).toMatch(/Live settings/);
    expect(L.NOTE_ALL).toMatch(/drawing only/);
    expect(L.modeNote(null, false)).toBe(L.NOTE_ALL);
    expect(L.modeNote({ type: "node", id: "s_dex" }, true)).toMatch(/^Drawing only: this node's .* change nothing on the server\. The controls further down are live/);
    expect(L.modeNote({ type: "node", id: "a_pool" }, false)).not.toMatch(/controls further down/);
    expect(L.modeNote({ type: "wire", id: 3 }, false)).toBe("Drawing only: this wire is saved in your browser and changes nothing on the server.");
    expect(L.modeNote({ type: "wire", id: 3 }, false, true)).toMatch(/^This wire is live: drawing or removing it stages the change/);
    expect(L.DRAWING_TOAST).toMatch(/Drawing only/);
  });
  it("says only 'Read only' or 'Live control' in its note: live only once the controls are confirmed live and answer", () => {
    expect(L.liveLabel({ as_of: "x" }, null)).toBe("Read only"); // the status answering is not enough
    expect(L.liveLabel({ as_of: "x", viewer: { can_apply: false } }, null)).toBe("Read only");
    expect(L.liveLabel({ as_of: "x", viewer: { can_apply: "yes" } }, null)).toBe("Read only");
    expect(L.liveLabel({ as_of: "x", viewer: { can_apply: true } }, "the service answered 403")).toBe("Read only");
    expect(L.liveLabel({ as_of: "x", viewer: { can_apply: true } }, null)).toBe("Live control");
    expect(liveJs).toMatch(/id = "livehelp"/); // the explanation moved to the panel's help text
  });
  it("reads the control file's switches and paces, and says an age in words", () => {
    const ctl = { sources: { jupiter: { on: false, pace_per_min: 30 }, helius: { on: true } } };
    expect(L.isOn(ctl, "jupiter")).toBe(false);
    expect(L.isOn(ctl, "helius")).toBe(true);
    expect(L.isOn(ctl, "unlisted")).toBe(true);
    expect(L.isOn(null, "x")).toBe(true);
    expect(L.paceOf(ctl, "jupiter")).toBe(30);
    expect(L.paceOf(ctl, "helius")).toBeNull();
    expect(L.ageText("2026-10-23T10:00:00Z", Date.parse("2026-10-23T10:00:20Z"))).toBe("20 s ago");
    expect(L.ageText("2026-10-23T10:00:00Z", Date.parse("2026-10-23T10:10:00Z"))).toBe("10 min ago");
    expect(L.ageText(null)).toBe("no good read yet");
    expect(L.badgeText({ calls: 60, errors: 4, http429: 3, timeouts: 0 }, "warn")).toBe("60 calls · 4 err · 3×429");
    expect(L.badgeText({}, "off")).toBe("switched off");
  });
});

describe("PINRai's node on /control", () => {
  it("reads the switch (off unless on) and the cap from the control file", () => {
    expect(L.aiOn({})).toBe(false);
    expect(L.aiOn({ pinrai: { on: true } })).toBe(true);
    expect(L.aiOn({ pinrai: { on: "yes" } })).toBe(false);
    expect(L.aiCap({ pinrai: { daily_dollar_cap: 5 } })).toBe(5);
    expect(L.aiCap({})).toBeNull();
  });
  it("accepts only a cap the server accepts: above 0, at most 25, whole cents", () => {
    for (const ok of ["5", "7.50", "0.01", "25"]) expect(L.capValue(ok)).toBe(Number(ok));
    for (const bad of ["", "0", "25.01", "26", "-1", "1.234", "abc", "5e1", "$5"]) expect(L.capValue(bad)).toBeNull();
  });
  it("shows spend and coins read only when the server reports them", () => {
    expect(L.aiUsage(null)).toMatch(/not reported by the server yet/);
    expect(L.aiUsage({ used_pct: 41.6, coins_read: 1 })).toBe("today's spend: 42% of the cap · 1 coin read today");
  });
});

describe("the gate page's logic", () => {
  it("maps the blueprint's gate nodes to the engine's checks, and the private settings to their checks", () => {
    expect(GT.CHECKS_OF.g_vamp).toEqual(["lookalike_name_ticker", "lookalike_picture"]);
    expect(GT.CHECKS_OF.g_dup).toEqual(["same_creator_relaunch"]);
    expect(GT.CHECKS_OF.g_serial).toEqual(["serial_launcher"]);
    expect(GT.CHECKS_OF.g_fast).toEqual(["fast_launcher"]);
    expect(GT.VALUES_OF.g_serial).toEqual(["mass_line"]);
    expect(GT.VALUES_OF.g_fast).toEqual(["fast_coins", "fast_minutes"]);
    expect(GT.ALL_CHECKS).toHaveLength(5);
  });
  it("reads a check missing from the graph as on, and sets one without touching the original", () => {
    const g = { checks: { lookalike_picture: { on: true, match: ["file"] } }, values: { mass_line: null } };
    expect(GT.isCheckOn(g, "serial_launcher")).toBe(true);
    expect(GT.isCheckOn({}, "serial_launcher")).toBe(true);
    const off = GT.setCheck(g, "serial_launcher", false);
    expect(GT.isCheckOn(off, "serial_launcher")).toBe(false);
    expect(GT.isCheckOn(g, "serial_launcher")).toBe(true);
    expect(GT.setCheck(g, "lookalike_picture", false).checks.lookalike_picture).toEqual({ on: false, match: ["file"] });
  });
  it("edits the picture check's match kinds in a fixed order, and says 'as built' when the graph names none", () => {
    expect(GT.matchOf({})).toBeNull();
    const a = GT.setMatch({}, "near", true);
    expect(a.checks.lookalike_picture).toEqual({ on: true, match: ["near"] });
    expect(GT.setMatch(a, "address", true).checks.lookalike_picture.match).toEqual(["address", "near"]);
    expect(GT.setMatch(a, "near", false).checks.lookalike_picture.match).toEqual([]);
  });
  it("sets a private value, or null for the private default", () => {
    expect(GT.valueOf({}, "fast_coins")).toBeNull();
    expect(GT.setValue({}, "fast_coins", 7).values.fast_coins).toBe(7);
    expect(GT.setValue({ values: { fast_coins: 7 } }, "fast_coins", null).values.fast_coins).toBeNull();
  });
  it("lists what differs between the graph in force and the staged one, and nothing when they are the same", () => {
    const base = { checks: { lookalike_picture: { on: true, match: ["file"] } }, values: { mass_line: null } };
    expect(GT.diffGraph(base, GT.clone ? GT.clone(base) : JSON.parse(JSON.stringify(base)))).toEqual([]);
    expect(GT.diffGraph({}, { checks: { serial_launcher: { on: true } } })).toEqual([]); // on is on, set or missing
    const d = GT.diffGraph(base, GT.setValue(GT.setMatch(GT.setCheck(base, "serial_launcher", false), "near", true), "mass_line", 9));
    expect(d).toEqual(["Serial launcher: on → off", "Picture match kinds: file → file, near", "Count line: private default → 9"]);
  });
  it("adds up a node's checks for the hour and keeps the latest five examples", () => {
    const status = { checks: { a: { held: 3, examples: [{ coin: "x", at: "2026-10-24T10:00:00Z", link: "https://s" }] }, b: { held: 4, examples: [{ coin: "y", at: "2026-10-24T11:00:00Z" }] } } };
    const c = GT.checkCounts(status, ["a", "b", "missing"]);
    expect(c.held).toBe(7);
    expect(c.examples.map((e: { coin: string }) => e.coin)).toEqual(["y", "x"]);
    expect(GT.checkCounts(null, ["a"])).toEqual({ held: 0, examples: [] });
  });
  it("reads a preview side and a version line, and only lets an https link through", () => {
    expect(GT.sideText({ passed: 5, held: 3, "not read yet": 1 })).toBe("5 passed · 3 held · 1 not read yet");
    expect(GT.versionLine({ version: 3, applied_by: "a@b" })).toMatchObject({ n: 3, text: "a@b" });
    expect(GT.versionLine(4)).toEqual({ n: 4, text: "" });
    expect(GT.safeLink("https://solscan.io/token/x")).toBe("https://solscan.io/token/x");
    for (const bad of ["http://x", "javascript:alert(1)", null, 5]) expect(GT.safeLink(bad)).toBeNull();
  });
  it("talks only to the gate's own /api/control/gate paths, shows server text as text, and writes no private value", () => {
    const src = readFileSync(join(dir, "gate.js"), "utf8").replace("http://www.w3.org/2000/svg", ""); // the SVG namespace is a name, not an address the page loads
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function|https?:\/\//);
    const paths = [...src.matchAll(/["'`](\/api\/[a-z/]+)["'`]/g)].map((m) => m[1]);
    expect(new Set(paths)).toEqual(new Set(["/api/control/gate", "/api/control/gate/preview", "/api/control/gate/apply", "/api/control/gate/undo"]));
    expect(src).not.toMatch(/(mass_line|fast_coins|fast_minutes)\s*[:=]\s*\d/);
  });
});

describe("Ask PINRai on /control", () => {
  const askSrc = readFileSync(join(dir, "ask.js"), "utf8");
  const askWin: { PinrAsk?: any } = {};
  vm.runInNewContext(askSrc, { window: askWin });
  const A = askWin.PinrAsk;
  const tokens = [
    { address: "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump", name: "Moon Frog", ticker: "$FROG" },
    { address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", name: "Other", ticker: "$OTH" },
    { name: "no address" },
  ];
  it("is loaded by the page and is the only new script", () => {
    expect(html).toMatch(/<script src="\/control\/ask\.js"><\/script>/);
  });
  it("finds a coin by name, ticker or address, and takes a pasted address the list lacks", () => {
    expect(A.matchCoins("frog", tokens).map((c: any) => c.name)).toEqual(["Moon Frog"]);
    expect(A.matchCoins("$oth", tokens)).toHaveLength(1);
    expect(A.matchCoins("", tokens)).toEqual([]);
    const lone = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
    expect(A.matchCoins(lone, tokens)[0]).toMatchObject({ address: lone });
    expect(A.matchCoins("moon", null)).toEqual([]);
  });
  it("sends the last few turns only, with the roles the server knows", () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "pinrai" : "founder", text: `t${i}` }));
    turns.push({ role: "system", text: "x" } as any, { role: "founder", text: "  " });
    const h = A.historyOf(turns);
    expect(h).toHaveLength(A.KEEP_TURNS);
    expect(h[h.length - 1]).toEqual({ role: "pinrai", text: "t11" });
    expect(h.every((t: any) => Object.keys(t).sort().join() === "role,text")).toBe(true);
  });
  it("sends a question or a teaching only of 1 to 2,000 characters", () => {
    expect(A.questionOf("  why?  ")).toBe("why?");
    expect(A.questionOf("   ")).toBeNull();
    expect(A.questionOf("x".repeat(2001))).toBeNull();
    expect(A.teachingOf("x".repeat(2000))).toHaveLength(2000);
    expect(A.teachingOf("x".repeat(2001))).toBeNull();
    expect(A.teachingOf("")).toBeNull();
  });
  it("draws an answer as text with its evidence, links only https, the unknown ids counted and never shown as evidence", () => {
    const v = A.answerView({
      status: "answered", answer: "<b>bold</b> stays text", cost_usd: 0.0123, model: "m",
      evidence: [
        { id: "e1", what: "fee payout", value: "1.2 SOL", source: "Solana chain", as_of: "2026-10-24T17:10:00Z", on_chain: true, link: "https://solscan.io/tx/abc" },
        { id: "e2", what: "post", value: null, source: "X", as_of: null, on_chain: false, link: "javascript:alert(1)" },
      ],
      unknown_ids: ["z9", "z8"],
    });
    expect(v.ok).toBe(true);
    expect(v.answer).toBe("<b>bold</b> stays text"); // the page puts it in with textContent
    expect(v.evidence[0]).toMatchObject({ mark: "●", href: "https://solscan.io/tx/abc" });
    expect(v.evidence[0].text).toBe("e1 · fee payout: 1.2 SOL · Solana chain · 2026-10-24 17:10 UTC");
    expect(v.evidence[1]).toMatchObject({ mark: "○", href: null });
    expect(v.unknown).toBe(2);
    expect(A.costText(v.cost)).toBe("this answer cost $0.01");
  });
  it("shows no answer and no evidence when the server did not answer, only its words", () => {
    const v = A.answerView({ status: "cap reached", answer: "should not show", evidence: [{ what: "x" }] });
    expect(v).toMatchObject({ ok: false, status: "cap reached", answer: "", evidence: [] });
    expect(A.answerView(null).ok).toBe(false);
  });
  it("talks only to the engine's ask and teach paths and the public coin list, and puts nothing on the page as markup", () => {
    const src = askSrc;
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function|https?:\/\//);
    const paths = [...src.matchAll(/["'`](\/api\/[a-z/]+)["'`]/g)].map((m) => m[1]);
    expect(new Set(paths)).toEqual(new Set(["/api/control/pinrai/ask", "/api/control/pinrai/teach", "/api/tokens", "/api/control/status"]));
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB/); // the chat is not kept in the browser
  });
  it("describes a saved teaching as words", () => {
    expect(A.teachingLine({ at: "2026-10-24T17:10:00Z", who: "operator@example.com", coin: "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump" })).toBe("2026-10-24 17:10 · operator@example.com · A7rR…pump");
  });
});

describe("the node badges from the live status", () => {
  const badgeSrc = readFileSync(join(dir, "badges.js"), "utf8");
  const bw: { PinrBadges?: any } = {};
  vm.runInNewContext(badgeSrc, { window: bw });
  const B = bw.PinrBadges;
  const src = (calls: number, errors = 0) => ({ calls, ok: calls - errors, errors, http429: 0, timeouts: 0, last_ok: "2026-10-24T20:00:00Z" });
  const ctx = (o: any = {}) => ({ status: { engine: { sources: { raydium: src(10), jupiter: src(10, 8), "x-api": src(4) } }, control: { pinrai: { on: true } } }, gate: { status: { held: 1 }, graph: {} }, feed: { scoreShown: true, tokens: 200 }, ...o });
  const S = (id: string, c: any) => B.liveStatus(id, c, L, GT);
  it("says live for a source that is being called, blocked when most calls fail, hidden when switched off", () => {
    expect(S("s_lists", ctx())).toMatchObject({ text: "live" });
    expect(S("s_jup", ctx())).toMatchObject({ text: "blocked" });
    expect(S("s_lists", ctx({ status: { engine: { sources: { raydium: src(10) } }, control: { sources: { raydium: { on: false }, "raydium-launchlab": { on: false } } } } }))).toMatchObject({ text: "hidden" });
  });
  it("says rate-limited, not blocked, for a source that answered most of its calls (GeckoTerminal: 199 calls, 71 refused)", () => {
    const g = (calls: number, errors: number) => ctx({ status: { engine: { sources: { raydium: src(calls, errors) } }, control: {} } });
    expect(S("s_lists", g(199, 71))).toMatchObject({ text: "live", why: expect.stringMatching(/71 of 199 calls were refused.*128 answered: rate-limited, not blocked/) });
    expect(S("s_lists", g(10, 8))).toMatchObject({ text: "blocked" });
  });
  it("says nothing for a source with no calls this hour, so its drawn status stays", () => {
    expect(S("s_pump", ctx())).toBeNull();
  });
  it("follows PINRai's switch for PINRai and the Claude API", () => {
    expect(S("e_ai", ctx())).toMatchObject({ text: "live" });
    expect(S("s_claude", ctx())).toMatchObject({ text: "live" });
    expect(S("e_ai", ctx({ status: { engine: { sources: {} }, control: { pinrai: { on: false } } } }))).toMatchObject({ text: "hidden" });
    expect(S("e_ai", ctx({ status: { engine: { sources: {} }, control: {} } }))).toBeNull();
  });
  it("follows the site's own flag for the PINRscore engine (hidden before 244, shown after)", () => {
    expect(S("e_score", ctx())).toMatchObject({ text: "live" });
    expect(S("e_score", ctx({ feed: { scoreShown: false, tokens: 5 } }))).toMatchObject({ text: "hidden" });
    expect(S("e_score", ctx({ feed: null }))).toBeNull();
  });
  it("says live for the gate nodes and the At launch block while the gate reports, hidden for a switched-off check", () => {
    expect(S("g_pass", ctx())).toMatchObject({ text: "live" });
    expect(S("w_gate", ctx())).toMatchObject({ text: "live" });
    expect(S("w_gate", ctx({ gate: null }))).toBeNull();
    const off = ctx({ gate: { status: {}, graph: { checks: { serial_launcher: { on: false } } } } });
    expect(S("g_serial", off)).toMatchObject({ text: "hidden" });
    expect(S("g_dup", off)).toMatchObject({ text: "live" });
  });
  it("says live for what the site's own feed serves, blocked when it has no coins, nothing when the feed is unknown", () => {
    expect(S("p_tokens", ctx())).toMatchObject({ text: "live" });
    expect(S("w_home", ctx({ feed: { scoreShown: true, tokens: 0 } }))).toMatchObject({ text: "blocked" });
    expect(S("w_coin", ctx({ feed: null }))).toBeNull();
    expect(S("a_mac", ctx())).toBeNull();
  });
  it("is loaded by the page, never uses markup, and fetches only the site's own coin list", () => {
    expect(html).toMatch(/<script src="\/control\/badges\.js"><\/script>/);
    expect(badgeSrc).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function|https?:\/\//);
    expect(new Set([...badgeSrc.matchAll(/["'`](\/api\/[a-z/]+)["'`]/g)].map((m) => m[1]))).toEqual(new Set(["/api/tokens"]));
  });
});

describe("Routes on /control", () => {
  const rtSrc = readFileSync(join(dir, "routes.js"), "utf8");
  const rw: { PinrRoutes?: any } = {};
  vm.runInNewContext(rtSrc, { window: rw });
  const R = rw.PinrRoutes;
  const catalog = {
    fields: {
      picture: { owner: "engine", words: "a coin's picture", sources: ["jupiter", "ipfs", "pumpfun"], default: ["jupiter", "ipfs", "pumpfun"] },
      price: { owner: "feed", words: "a coin's price", sources: ["jupiter", "dexscreener", "geckoterminal"], default: ["dexscreener", "jupiter", "geckoterminal"] },
      candles: { owner: "feed", words: "a coin's chart candles", sources: ["pumpfun", "tape", "geckoterminal"], default: ["pumpfun", "tape", "geckoterminal"] },
    },
    sources: { jupiter: "Jupiter", ipfs: "the coin's own metadata file" },
    discovery: { pumpfun: { owner: "feed", words: "Pump.fun coins", default: true }, bags: { owner: "engine", words: "Bags", default: true } },
  };
  const base = () => R.effective(null, catalog);
  it("is loaded by the page and talks only to the engine's routing paths", () => {
    expect(html).toMatch(/<script src="\/control\/routes\.js"><\/script>/);
    expect(rtSrc.replace("http://www.w3.org/2000/svg", "")).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function|https?:\/\//); // the SVG namespace is a name, not an address
    const paths = [...rtSrc.matchAll(/["'`](\/api\/[a-z/]+)["'`]/g)].map((m) => m[1]);
    expect(new Set(paths)).toEqual(new Set(["/api/control/routing", "/api/control/routing/undo", "/api/control/routing/preview", "/api/control/routing/apply"]));
  });
  it("with no file in force every field has its default order and every launchpad is on", () => {
    expect(base().routes.picture).toEqual(["jupiter", "ipfs", "pumpfun"]);
    expect(base().discovery).toEqual({ pumpfun: true, bags: true });
    const part = R.effective({ routes: { picture: ["ipfs"] }, discovery: { bags: false } }, catalog);
    expect(part.routes.picture).toEqual(["ipfs"]);
    expect(part.routes.price).toEqual(catalog.fields.price.default);
    expect(part.discovery).toEqual({ pumpfun: true, bags: false });
  });
  it("reorders, removes and adds, never leaving a field empty or using a source it may not use or twice", () => {
    let r = R.moveSource(base(), "picture", 2, -1);
    expect(r.routes.picture).toEqual(["jupiter", "pumpfun", "ipfs"]);
    expect(R.moveSource(base(), "picture", 0, -1).routes.picture).toEqual(base().routes.picture);
    r = R.removeSource(R.removeSource(base(), "picture", 0), "picture", 0);
    expect(r.routes.picture).toEqual(["pumpfun"]);
    expect(R.removeSource(r, "picture", 0).routes.picture).toEqual(["pumpfun"]);
    expect(R.addSource(r, "picture", "ipfs", catalog).routes.picture).toEqual(["pumpfun", "ipfs"]);
    expect(R.addSource(r, "picture", "tape", catalog).routes.picture).toEqual(["pumpfun"]);
    expect(R.addSource(r, "picture", "pumpfun", catalog).routes.picture).toEqual(["pumpfun"]);
    expect(base().routes.picture).toEqual(["jupiter", "ipfs", "pumpfun"]); // the original is untouched
  });
  it("says what the server would refuse: no source, a foreign source, a repeat, no launchpad on", () => {
    expect(R.problemsOf(base(), catalog)).toEqual([]);
    const bad = base();
    bad.routes.picture = [];
    bad.routes.price = ["jupiter", "jupiter", "tape"];
    bad.discovery = { pumpfun: false, bags: false };
    const p = R.problemsOf(bad, catalog).join(" | ");
    expect(p).toMatch(/picture needs at least one source/);
    expect(p).toMatch(/price: a source it cannot use/);
    expect(p).toMatch(/price: a source twice/);
    expect(p).toMatch(/at least one launchpad must stay on/);
  });
  it("lists the staged changes in words, and only the ones that differ", () => {
    const after = R.setLaunchpad(R.moveSource(base(), "picture", 1, -1), "bags", false);
    const lines = R.diffRouting(base(), after, catalog);
    expect(lines).toEqual(["a coin's picture: jupiter → ipfs → pumpfun  becomes  ipfs → jupiter → pumpfun", "Bags: on  becomes  off"]);
    expect(R.diffRouting(base(), base(), catalog)).toEqual([]);
  });
  it("marks a map wire live when its route is in force and followed, 'not routed' when it is out, greyed when the feed does not follow the field, nothing when it is not a route", () => {
    const key = "s_jup|picture|a_pic|Jupiter";
    expect(R.wireMark(key, base(), catalog)).toEqual({ kind: "live", text: "live" });
    const out = R.removeSource(base(), "picture", 0);
    expect(R.wireMark(key, out, catalog)).toEqual({ kind: "off", text: "not routed" });
    const candle = "s_pump|candles|p_chart|Pump.fun candles";
    expect(R.wireMark(candle, base(), catalog)).toEqual({ kind: "unfollowed", text: "feed not following yet" }); // an Air that does not say: the feed's are not followed
    const fed = JSON.parse(JSON.stringify(catalog));
    fed.fields.candles.followed = true;
    expect(R.wireMark(candle, base(), fed)).toEqual({ kind: "live", text: "live" });
    fed.fields.picture.followed = false;
    expect(R.wireMark(key, base(), fed)).toEqual({ kind: "unfollowed", text: "feed not following yet" });
    expect(R.wireMark("s_x|posts|e_x|posts", base(), catalog)).toBeNull();
  });
  it("reads the engine's followed flag on a field or launchpad, and without it counts the engine's as followed and the feed's as not", () => {
    expect(R.followedOf({ owner: "feed", followed: true })).toBe(true);
    expect(R.followedOf({ owner: "engine", followed: false })).toBe(false);
    expect(R.followedOf({ owner: "engine" })).toBe(true);
    expect(R.followedOf({ owner: "feed" })).toBe(false);
    expect(R.followedOf(undefined)).toBe(false);
  });
  it("reads the engine's preview changes as words", () => {
    expect(R.changeLine({ field: "picture", words: "a coin's picture", owner: "engine", before: ["jupiter", "ipfs"], after: ["ipfs", "jupiter"] })).toBe("a coin's picture: jupiter → ipfs  becomes  ipfs → jupiter (the engine follows at once)");
    expect(R.changeLine({ launchpad: "bags", words: "Bags", owner: "engine", before: true, after: false })).toBe("Bags: on  becomes  off (the engine follows at once)");
  });
  it("puts a launchpad switch on the nodes that are launchpads", () => {
    expect(R.NODE_LAUNCHPADS.s_pump).toEqual(["pumpfun"]);
    expect(R.NODE_LAUNCHPADS.s_lists).toContain("bags");
  });
});

describe("stale notes on the map", () => {
  const bSrc = readFileSync(join(dir, "badges.js"), "utf8");
  const nw: { PinrBadges?: any } = {};
  vm.runInNewContext(bSrc, { window: nw });
  const B = nw.PinrBadges;
  it("shows the new text for a note that is still the old default, and never touches one the operator edited", () => {
    const nodes = [
      { id: "e_score", note: B.STALE_NOTES.e_score.was },
      { id: "e_ai", note: "my own words about PINRai" },
      { id: "s_x", note: B.STALE_NOTES.s_x.now },
      { id: "g_in", note: "unchanged" },
    ];
    expect(B.freshNotes(nodes)).toBe(1);
    expect(nodes[0]!.note).toBe("Shown on the PINR page, Discovery and DeepScan (244).");
    expect(nodes[1]!.note).toBe("my own words about PINRai");
    expect(B.freshNotes(nodes)).toBe(0); // a second time changes nothing
  });
  it("a saved map's hand-drawn Pump.fun blocked, BNB planned and launchpad-list notes become what the engine's counters show, and an edited one stays (DEBUG 26 Oct)", () => {
    const nodes = [
      { id: "s_pump", note: B.STALE_NOTES.s_pump.was, status: "blocked" },
      { id: "s_bnb", note: B.STALE_NOTES.s_bnb.was, status: "planned" },
      { id: "s_lists", note: B.STALE_NOTES.s_lists.alt, status: "building" },
    ];
    expect(B.freshNotes(nodes)).toBe(3);
    expect(nodes.map((n: any) => n.status)).toEqual(["live", "live", "live"]);
    expect(nodes[2]!.note).not.toContain("not yet");
    const own = [{ id: "s_pump", note: "my own words", status: "blocked" }];
    expect(B.freshNotes(own)).toBe(0);
    expect(own[0]!.status).toBe("blocked");
  });
  it("the drawn defaults no longer carry the stale words, and match the new text", () => {
    const bp = readFileSync(join(dir, "blueprint.js"), "utf8");
    for (const stale of ["hidden from every page", "before it goes live (234)", "(in use), Bags, Clanker, Zora", "300 of 505"]) expect(bp).not.toContain(stale);
    for (const [id, s] of Object.entries(B.STALE_NOTES) as [string, { was: string; now: string }][]) {
      expect(bp, id).toContain(s.now);
      expect(s.was).not.toBe(s.now);
    }
  });
});

describe("Solana node order and the trade feed on the Routes panel (243 phase 2, the engine's rest)", () => {
  const rtSrc = readFileSync(join(dir, "routes.js"), "utf8");
  const rw: { PinrRoutes?: any } = {};
  vm.runInNewContext(rtSrc, { window: rw });
  const R = rw.PinrRoutes;
  const catalog = {
    fields: { picture: { owner: "engine", words: "picture", sources: ["jupiter", "ipfs"], default: ["jupiter", "ipfs"], followed: true } },
    discovery: { bags: { owner: "engine", words: "Bags", default: true, followed: true } },
    nodes: { owner: "engine", followed: true, kinds: { largest_holders: { words: "largest holders" }, other: { words: "every other read" } }, names: { public: "Public", shyft: "Shyft", helius_official: "Helius" } },
    trade_feed: { owner: "engine", followed: true, names: { public: "Public", chainstack: "Chainstack" }, max_nodes: 2, coins: [1, 1000] },
  };
  const eff = { largest_holders: ["public", "helius_official"], other: ["public"] };
  it("shows the routing's own node order, else the engine's order in force, and carries every kind once one is changed", () => {
    const base = R.effective(null, catalog);
    expect(base.nodes).toBeUndefined(); // absent = today's order
    const shown = R.nodesShown(base, catalog, eff);
    expect(shown).toEqual(eff);
    const moved = R.withNodes(base, "largest_holders", R.moveIn(shown.largest_holders, 1, -1), shown);
    expect(moved.nodes).toEqual({ largest_holders: ["helius_official", "public"], other: ["public"] });
    expect(R.diffRouting(base, moved, catalog, eff)).toEqual(["largest holders: Public → Helius  becomes  Helius → Public"]); // the unchanged kind is no change
    expect(R.diffRouting(base, moved, catalog)).toEqual(["largest holders: today's order  becomes  Helius → Public", "every other read: today's order  becomes  Public"]); // without the engine's order, each kind is said as new
  });
  it("says what the server would refuse for nodes and the trade feed", () => {
    const base = R.effective(null, catalog);
    const bad = { ...base, nodes: { largest_holders: [], other: ["public", "public"] }, trade_feed: { nodes: ["public", "public"], coins: 0 } };
    const p = R.problemsOf(bad, catalog).join(" | ");
    expect(p).toMatch(/largest holders needs at least one node/);
    expect(p).toMatch(/every other read: a node twice/);
    expect(p).toMatch(/overflow must be another node/);
    expect(p).toMatch(/watches 1 to 1000 coins/);
    expect(R.problemsOf({ ...base, trade_feed: { nodes: ["public", "chainstack"], coins: 120 } }, catalog)).toEqual([]);
  });
  it("stages the trade feed, and reads the engine's preview lines for nodes and the trade feed", () => {
    const tf = R.withTradeFeed(R.effective(null, catalog), ["chainstack", "public"], 200);
    expect(tf.trade_feed).toEqual({ nodes: ["chainstack", "public"], coins: 200 });
    expect(R.diffRouting(R.effective(null, catalog), tf, catalog)).toEqual(["the trade feed: today's settings  becomes  Chainstack, then Public · 200 coins"]);
    expect(R.changeLine({ nodes: "other", words: "every other read", owner: "engine", before: ["public"], after: ["shyft", "public"] })).toBe("every other read: public  becomes  shyft → public (the engine follows at once)");
    expect(R.changeLine({ trade_feed: true, words: "the trade feed", owner: "engine", before: null, after: { nodes: ["public"], coins: 120 } })).toBe("the trade feed: today's  becomes  public · 120 coins (the engine follows at once)");
  });
});

describe("the Routes panel's warnings from the server", () => {
  const rw: { PinrRoutes?: any } = {};
  vm.runInNewContext(readFileSync(join(dir, "routes.js"), "utf8"), { window: rw });
  const R = rw.PinrRoutes;
  const catalog = { nodes: { kinds: { largest_holders: { words: "a coin's largest holders" }, transactions: { words: "transactions and their signatures" } } } };
  it("says which kinds of read fell back to today's order, and nothing when none did", () => {
    expect(R.fallbackLine([], catalog)).toBeNull();
    expect(R.fallbackLine(undefined, catalog)).toBeNull();
    expect(R.fallbackLine(["largest_holders"], catalog)).toBe("Not as wired: a coin's largest holders is served in today's order, because every node wired for it has lost its address on the server.");
    expect(R.fallbackLine(["largest_holders", "transactions"], catalog)).toMatch(/largest holders, transactions and their signatures are served in today's order, because every node wired for them/);
  });
  it("knows when a trade feed wire is applied (its node's coin setting then moves to Routes)", () => {
    expect(R.tradeFeedApplied({ routing: { trade_feed: { nodes: ["public"], coins: 100 } } })).toBe(true);
    expect(R.tradeFeedApplied({ routing: { routes: {} } })).toBe(false);
    expect(R.tradeFeedApplied(null)).toBe(false);
  });
});

describe("the Change log tab", () => {
  const logSrc = readFileSync(join(dir, "logtab.js"), "utf8");
  it("is loaded after Routes, sits beside it, and uses the live and gate layers' own boxes", () => {
    expect(html).toMatch(/<script src="\/control\/routes\.js"><\/script>\s*<script src="\/control\/logtab\.js"><\/script>/);
    expect(logSrc).toMatch(/routesBtn\.after\(b\)/);
    expect(logSrc).toMatch(/PinrLive\.logBox/);
    expect(logSrc).toMatch(/PinrGate\.historyBox/);
    expect(logSrc).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function|fetch\(|https?:\/\//);
  });
  it("is off the main side panel: neither the change log nor the gate versions are appended there any more", () => {
    expect(liveJs).not.toMatch(/panel\.append\(log\(\)\)/);
    expect(readFileSync(join(dir, "gate.js"), "utf8")).not.toMatch(/panel\.append\(history\(\)\)/);
  });
});

describe("the operator's wire edits on the map stage route changes (243 phase 2)", () => {
  const rw: { PinrRoutes?: any } = {};
  vm.runInNewContext(readFileSync(join(dir, "routes.js"), "utf8"), { window: rw });
  const R = rw.PinrRoutes;
  const catalog = {
    fields: {
      picture: { owner: "engine", words: "a coin's picture", sources: ["jupiter", "ipfs", "pumpfun"], default: ["jupiter", "ipfs"], followed: true },
      price: { owner: "feed", words: "a coin's price", sources: ["dexscreener", "geckoterminal", "jupiter"], default: ["dexscreener", "jupiter"], followed: true },
      volume: { owner: "feed", words: "volume", sources: ["dexscreener", "geckoterminal"], default: ["dexscreener"], followed: true },
      liquidity: { owner: "feed", words: "liquidity", sources: ["dexscreener"], default: ["dexscreener"], followed: false },
      candles: { owner: "feed", words: "candles", sources: ["pumpfun", "tape", "geckoterminal"], default: ["pumpfun", "tape"], followed: true },
    },
    sources: { jupiter: "Jupiter", ipfs: "IPFS", pumpfun: "Pump.fun", dexscreener: "DexScreener", geckoterminal: "GeckoTerminal" },
    discovery: {},
  };
  it("knows which map wires are routes: a source node into an input that feeds a field the source may fill", () => {
    expect(R.routesOfWire(["s_jup", "picture", "a_pic", "Jupiter"], catalog)).toEqual([["picture", "jupiter"]]);
    expect(R.routesOfWire(["s_pump", "anything", "a_pic", "a new pin"], catalog)).toEqual([["picture", "pumpfun"]]);
    expect(R.routesOfWire(["s_gtc", "candles", "p_tokens", "prices"], catalog)).toEqual([["price", "geckoterminal"], ["volume", "geckoterminal"]]); // not liquidity: not its source
    expect(R.routesOfWire(["s_dex", "links", "a_pic", "x"], catalog)).toEqual([]); // DexScreener does not fill the picture
    expect(R.routesOfWire(["a_pool", "coin list", "a_token", "run"], catalog)).toEqual([]); // not a source
  });
  it("stages a drawn route at the end of the field's order, and a removed one out of it (never the last; never an unfollowed field)", () => {
    const base = R.effective(null, catalog);
    const before = R.routesOnMap([["s_jup", "picture", "a_pic", "Jupiter"], ["s_dex", "price, volume", "p_tokens", "prices"]], catalog);
    const drawn = R.routesOnMap([["s_jup", "picture", "a_pic", "Jupiter"], ["s_dex", "price, volume", "p_tokens", "prices"], ["s_pump", "x", "a_pic", "y"]], catalog);
    const a = R.mapEdits(base, before, drawn, catalog);
    expect(a.next.routes.picture).toEqual(["jupiter", "ipfs", "pumpfun"]);
    expect(a.said).toEqual(["a coin's picture: Pump.fun added (last)"]);
    const removed = R.routesOnMap([["s_jup", "picture", "a_pic", "Jupiter"]], catalog);
    const b = R.mapEdits(base, before, removed, catalog);
    expect(b.next.routes.price).toEqual(["jupiter"]);
    expect(b.next.routes.volume).toEqual(["dexscreener"]); // its last source stays
    expect(b.next.routes.liquidity).toEqual(["dexscreener"]); // not followed: untouched
    expect(b.said).toEqual(["a coin's price: DexScreener taken out"]);
    expect(R.mapEdits(base, before, before, catalog).said).toEqual([]);
  });
  it("marks any route wire, not only the drawn ones it knew before", () => {
    expect(R.wireMark(["s_pump", "x", "a_pic", "y"], R.effective(null, catalog), catalog)).toEqual({ kind: "off", text: "not routed" });
    expect(R.wireMark("s_jup|picture|a_pic|Jupiter", R.effective(null, catalog), catalog)).toEqual({ kind: "live", text: "live" });
  });
});

describe("the gate's wires on the map control the gate", () => {
  it("knows a check node is on while a wire comes into it, and stages it off or on when that changes", () => {
    const wires = [["g_in", "check", "g_vamp", "check"], ["g_vamp", "no", "g_dup", "no"], ["g_dup", "no", "g_serial", "no"], ["g_serial", "no", "g_fast", "no"], ["g_fast", "no", "g_pass", "no"]];
    const before = GT.wiredChecks(wires);
    expect([...before].sort()).toEqual(["g_dup", "g_fast", "g_serial", "g_vamp"]);
    const cut = GT.wiredChecks(wires.filter((w) => w[2] !== "g_dup"));
    const off = GT.gateMapEdits({ checks: {} }, before, cut);
    expect(GT.isCheckOn(off.next, "same_creator_relaunch")).toBe(false);
    expect(GT.isCheckOn(off.next, "serial_launcher")).toBe(true);
    expect(off.said).toHaveLength(1);
    const back = GT.gateMapEdits(off.next, cut, before);
    expect(GT.isCheckOn(back.next, "same_creator_relaunch")).toBe(true);
    const both = GT.gateMapEdits({ checks: {} }, before, GT.wiredChecks(wires.filter((w) => w[2] !== "g_vamp")));
    expect(GT.isCheckOn(both.next, "lookalike_name_ticker")).toBe(false); // the look-alike node holds both of its checks
    expect(GT.isCheckOn(both.next, "lookalike_picture")).toBe(false);
    expect(GT.gateMapEdits({ checks: {} }, before, before).said).toEqual([]);
  });
  it("tells a gate wire from the others", () => {
    expect(GT.isGateWire(["g_vamp", "no", "g_dup", "no"])).toBe(true);
    expect(GT.isGateWire(["g_serial", "no", "g_pass", "no"])).toBe(false); // into Passed: not a check
    expect(GT.isGateWire(null)).toBe(false);
  });
});

describe("the gate's order of checks from the map's chain (the engine's gate order)", () => {
  it("reads the chain's order from the wires, and fills in the checks left off it as built", () => {
    const built = [["g_in", "check", "g_vamp", "check"], ["g_vamp", "no", "g_dup", "no"], ["g_dup", "no", "g_serial", "no"], ["g_serial", "no", "g_fast", "no"]];
    expect(GT.chainOrder(built)).toEqual(["lookalike_name_ticker", "lookalike_picture", "same_creator_relaunch", "serial_launcher", "fast_launcher"]);
    const moved = [["g_in", "check", "g_serial", "no"], ["g_serial", "no", "g_vamp", "check"], ["g_vamp", "no", "g_dup", "no"]];
    expect(GT.chainOrder(moved)).toEqual(["serial_launcher", "lookalike_name_ticker", "lookalike_picture", "same_creator_relaunch"]);
    expect(GT.orderOf(GT.setOrder({ checks: {} }, GT.chainOrder(moved)))).toEqual(["serial_launcher", "lookalike_name_ticker", "lookalike_picture", "same_creator_relaunch", "fast_launcher"]);
    expect(GT.orderOf({ order: ["nonsense", "fast_launcher", "fast_launcher"] })).toEqual(["fast_launcher", "serial_launcher", "same_creator_relaunch", "lookalike_name_ticker", "lookalike_picture"]);
  });
  it("says a new order among the staged changes, only when the order really changes", () => {
    const base = { checks: {} };
    const a = GT.diffGraph(base, GT.setOrder(base, ["lookalike_picture"]));
    expect(a.join(" ")).toMatch(/^Order of the checks: .* becomes /);
    expect(GT.diffGraph(base, GT.setOrder(base, GT.BUILT_ORDER))).toEqual([]);
  });
});
describe("the badge's hover", () => {
  it("says who Live control is for, and why a browser may show Read only", () => {
    expect(L.hoverOf("Live control", null)).toMatch(/Anyone Cloudflare Access lets in sees this; there is no per-person list/);
    expect(L.hoverOf("Read only", "the service answered 403")).toMatch(/\(the service answered 403\).*Safari before 16\.4/);
  });
});

describe("the Key tab (the operator: \"too many similar colors and i have no key for what each style line means\")", () => {
  const keySrc = readFileSync(join(dir, "keytab.js"), "utf8");
  const kw: { PinrKey?: any } = {};
  vm.runInNewContext(keySrc, { window: kw });
  const blocks = [...html.matchAll(/--pin-coins:[^}]*/g)].map((m) => m[0]);
  const vars = (b: string, pre: string) => Object.fromEntries([...b.matchAll(new RegExp(`--(${pre}-[a-z]+):(#[0-9A-Fa-f]{6})`, "g"))].map((m) => [m[1], m[2]!.toUpperCase()]));
  it("is loaded by the page after the change log, and puts nothing on the page as markup", () => {
    expect(html.indexOf("/control/keytab.js")).toBeGreaterThan(html.indexOf("/control/logtab.js"));
    expect(keySrc).not.toMatch(/innerHTML|insertAdjacentHTML|fetch\(/);
  });
  it("gives every pin type its own colour, in dark and in both light blocks, none the same as a status colour", () => {
    expect(blocks.length).toBe(3);
    for (const b of blocks) {
      const pins = Object.values(vars(b, "pin"));
      const st = vars(b, "st");
      expect(pins).toHaveLength(8);
      expect(new Set(pins).size).toBe(8);
      for (const c of [st["st-live"], st["st-building"], st["st-blocked"]]) expect(pins).not.toContain(c);
    }
    const pinsTable = js.match(/const PINS=\{[^;]*\};/)![0];
    const used = [...pinsTable.matchAll(/"(--[a-z-]+)"\]/g)].map((m) => m[1]);
    expect(used).toHaveLength(9);
    expect(new Set(used).size).toBe(9); // nine pin types, nine colours (flow is the ink colour)
  });
  it("names every line style the map draws, with what it means", () => {
    const classes = kw.PinrKey.LINE_STYLES.map((r: string[]) => r[0]).join(" ");
    for (const c of ["rtlive", "dash", "rtgrey", "fromoff", "sel"]) expect(classes).toContain(c);
    const words = kw.PinrKey.LINE_STYLES.map((r: string[]) => r[2]).join(" ");
    expect(words).toMatch(/server follows/);
    expect(words).toMatch(/drawing only/i);
    expect(words).toMatch(/blocked, hidden or planned/);
    for (const c of ["dash", "rtlive", "rtgrey", "fromoff", "sel"]) expect(readFileSync(join(dir, "live.css"), "utf8")).toContain(`#wires path.${c}{`);
  });
  it("gives each node status its own sign and its own colour", () => {
    const status = js.match(/const STATUS=\{[^;]*\};/)![0];
    expect(status).toMatch(/● live.*◐ building.*✕ blocked.*◌ hidden.*○ planned/);
    expect(status).toContain("--st-live");
    expect(status).toContain("--st-blocked");
  });
});

describe("the team's map: every pin wired, and new wires added to a saved map once", () => {
  const part = js.slice(js.indexOf("function defaultGraph(){"), js.indexOf("// ---------------------------------------------------------------- state"));
  const M = new Function(part + "; return { defaultGraph, addNewDefaults, MAP_REV };")();
  const name = (p: string) => (p.includes(":") ? p.slice(p.indexOf(":") + 1) : p);
  it("leaves no input or output without a wire, except the coin page's end (the visitor)", () => {
    const g = M.defaultGraph();
    const loose: string[] = [];
    for (const n of g.nodes.filter((n: any) => n.kind !== "comment")) {
      for (const p of n.ins) if (!g.wires.some((w: string[]) => w[2] === n.id && w[3] === name(p))) loose.push(`${n.id} in ${p}`);
      for (const p of n.outs) if (!g.wires.some((w: string[]) => w[0] === n.id && w[1] === name(p))) loose.push(`${n.id} out ${p}`);
    }
    expect(loose).toEqual(["w_coin out flow:shows"]);
    for (const w of g.wires) {
      expect(g.nodes.find((n: any) => n.id === w[0]).outs.map(name)).toContain(w[1]);
      expect(g.nodes.find((n: any) => n.id === w[2]).ins.map(name)).toContain(w[3]);
    }
    const score = g.wires.filter((w: string[]) => w[0] === "e_score" || w[2] === "e_score").map((w: string[]) => w.join(" "));
    expect(score).toEqual(expect.arrayContaining(["e_build evidence file e_score evidence", "a_mac chain rows e_score evidence", "e_score score p_tokens score", "e_score score w_coin score shown"]));
  });
  it("adds the new wires and pins to a saved map once, keeping the viewer's own edits, and never puts back a wire he took out after", () => {
    const saved = M.defaultGraph();
    delete saved.rev;
    saved.wires = saved.wires.filter((w: string[]) => w[0] !== "e_score" && w[2] !== "e_score" && !(w[0] === "s_pump" && w[1] === "holders"));
    for (const n of saved.nodes) if (n.id === "p_tokens" || n.id === "w_coin") n.ins = n.ins.filter((p: string) => !p.includes("score"));
    saved.nodes.find((n: any) => n.id === "e_x").title = "His own name";
    saved.wires.push(["s_x", "posts", "w_links", "links"]); // his own wire
    saved.nodes = saved.nodes.filter((n: any) => n.id !== "a_mac"); // a node he deleted
    expect(M.addNewDefaults(saved)).toBe(4); // a_mac's wire is not added: he deleted the node
    expect(saved.rev).toBe(M.MAP_REV);
    expect(saved.nodes.find((n: any) => n.id === "p_tokens").ins).toContain("evidence:score");
    expect(saved.nodes.find((n: any) => n.id === "e_x").title).toBe("His own name");
    expect(saved.wires.some((w: string[]) => w.join("|") === "s_x|posts|w_links|links")).toBe(true);
    saved.wires = saved.wires.filter((w: string[]) => w.join("|") !== "e_score|score|w_coin|score shown");
    expect(M.addNewDefaults(saved)).toBe(0);
    expect(saved.wires.some((w: string[]) => w.join("|") === "e_score|score|w_coin|score shown")).toBe(false);
    expect(M.addNewDefaults(M.defaultGraph())).toBe(0); // the map of now already has them
  });
  it("draws the score wires solid only while the site shows the PINRscore, and a wire from an off node by its live badge", () => {
    const routes = readFileSync(join(dir, "routes.js"), "utf8");
    expect(routes).toMatch(/scoreLive = \(w\[0\] === "e_score" \|\| w\[2\] === "e_score"\) && .*B\.scoreLive\(\)/);
    const badges = readFileSync(join(dir, "badges.js"), "utf8");
    expect(badges).toContain("feed.scoreShown === true");
  });
});

describe("every wire in one of three measured states", () => {
  const src = readFileSync(join(dir, "livewires.js"), "utf8");
  const ww: { PinrWires?: any } = {};
  vm.runInNewContext(src, { window: ww });
  const P = ww.PinrWires;
  const now = 10_000_000;
  const m = { startedMs: now - 3_600_000, liveMs: 300_000 };
  const live = { state: "live", perMin: 4, last10: 31, lastMs: now - 12_000, sample: "So11111111111111111111111111111111111111112", error: null, errorMs: null };
  it("is loaded after the routes layer, talks only to the site's own control path, and puts nothing on the page as markup", () => {
    expect(html.indexOf("/control/livewires.js")).toBeGreaterThan(html.indexOf("/control/routes.js"));
    expect(src).toContain('fetch("/api/control/sitewires"');
    expect(src.replaceAll("http://www.w3.org/2000/svg", "")).not.toMatch(/https?:\/\//);
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function/);
  });
  it("LIVE with the count and the last time; NOT LIVE with the reason when measured and quiet or refused; BUILDING when not measured", () => {
    const w = ["p_tokens", "coin list", "w_home", "coin list"];
    expect(P.keyOf(w)).toBe("p_tokens>w_home:coin list");
    expect(P.wireState(w, live, { status: "live" }, now, m)).toMatchObject({ state: "live", text: "LIVE 4/min" });
    expect(P.wireState(w, live, { status: "live" }, now, m).why).toMatch(/31 in the last 10 minutes; the last 12 s ago/);
    expect(P.wireState(w, { ...live, state: "quiet", lastMs: now - 900_000 }, null, now, m)).toMatchObject({ state: "notlive", text: "NOT LIVE" });
    expect(P.wireState(w, { ...live, state: "quiet", lastMs: now - 900_000 }, null, now, m).why).toMatch(/Nothing crossed in the last 5 minutes; the last at .* \(15 min ago\)/);
    expect(P.wireState(w, { ...live, state: "quiet", lastMs: null }, null, now, m).why).toMatch(/since the feed server started 60 min ago/);
    expect(P.wireState(w, { ...live, state: "error", error: "HTTP 429", errorMs: now - 5000 }, null, now, m).why).toMatch(/refused 5 s ago: HTTP 429/);
    expect(P.wireState(["a_pool", "coin list", "a_mac", "coin list"], undefined, { status: "live" }, now, m)).toMatchObject({ state: "building" });
    expect(P.wireState(["s_gtc", "candles", "w_chart", "GeckoTerminal"], undefined, { status: "live" }, now, m).why).toMatch(/browser reads this source itself/);
    expect(P.wireState(["s_x", "posts", "e_x", "posts"], undefined, { status: "planned", note: "Waiting for the key." }, now, m)).toMatchObject({ state: "notlive", why: "Its node is planned: Waiting for the key." });
  });
  it("a node is live while any measured wire is, not live when all measured ones are quiet, and drawn when none is measured", () => {
    const wires = [["p_tokens", "coin list", "w_apps", "coin list"], ["p_evid", "evidence", "w_apps", "evidence"], ["a_pool", "coin list", "a_mac", "coin list"]];
    expect(P.nodeState("w_apps", wires, { "p_tokens>w_apps:coin list": live }, now)).toMatchObject({ text: "live" });
    expect(P.nodeState("w_apps", wires, { "p_tokens>w_apps:coin list": { ...live, state: "quiet" } }, now)).toMatchObject({ text: "notlive" });
    expect(P.nodeState("a_mac", wires, {}, now)).toBeNull();
    expect(P.joinReadings({ k: live }, { k: { state: "quiet" }, e: { state: "live" }, bad: 3 })).toEqual({ k: live, e: { state: "live" } });
  });
  it("a wire that runs in bursts and is quiet within its gap stays LIVE and says so in the engine's words (between_runs)", () => {
    const e = P.fromEngine({ wires: { "s_x|posts|e_x|posts": { state: "live", per_min: 0, last_at: "2026-10-26T02:56:00Z", sample: null, reason: "runs in bursts about every 8 min; the last 4 min ago", between_runs: true }, "a|p|b|q": { state: "live", per_min: 3, last_at: "2026-10-26T02:59:00Z", reason: "ignored without the flag" } } });
    const t = Date.parse("2026-10-26T03:00:00Z");
    expect(P.wireState(["s_x", "posts", "e_x", "posts"], e.wires["s_x>e_x:posts"], null, t, m)).toMatchObject({ state: "live", text: "LIVE · between runs", why: "Runs in bursts about every 8 min; the last 4 min ago." });
    expect(P.wireState(["a", "p", "b", "q"], e.wires["a>b:q"], null, t, m)).toMatchObject({ state: "live", text: "LIVE 3/min" });
  });
  it("reads the engine's engine wires in its own shape: LIVE, NOT LIVE with its reason, refused, and its node heartbeats", () => {
    const e = P.fromEngine({
      as_of: "2026-10-26T03:00:00Z",
      wires: {
        "s_jup|token data|a_token|Jupiter": { state: "live", per_min: 12, last_at: "2026-10-26T02:59:00Z", sample: { id: "MadeUp" } },
        "s_x|posts|e_x|posts": { state: "not live", per_min: 0, last_at: "2026-10-26T02:00:00Z", sample: null, reason: "no data for 60 min" },
        "s_rpc|chain reads|a_mac|chain reads": { state: "not live", per_min: 0, last_at: null, reason: "HTTP 429 from the node" },
        bad: { state: "live" },
      },
      nodes: { a_token: { state: "live", last_at: "2026-10-26T02:59:30Z" }, e_x: { state: "not live", last_at: "2026-10-26T02:00:00Z", reason: "no heartbeat for 60 min" } },
    });
    expect(Object.keys(e.wires).sort()).toEqual(["s_jup>a_token:Jupiter", "s_rpc>a_mac:chain reads", "s_x>e_x:posts"]);
    expect(e.wires["s_jup>a_token:Jupiter"]).toMatchObject({ state: "live", perMin: 12, last10: null, sample: '{"id":"MadeUp"}' });
    const t = Date.parse("2026-10-26T03:00:00Z");
    expect(P.wireState(["s_jup", "token data", "a_token", "Jupiter"], e.wires["s_jup>a_token:Jupiter"], null, t, m).why).toMatch(/^12 a minute; the last 60 s ago/);
    expect(P.wireState(["s_x", "posts", "e_x", "posts"], e.wires["s_x>e_x:posts"], null, t, m).why).toMatch(/^No data for 60 min; the last at/);
    expect(P.wireState(["s_rpc", "chain reads", "a_mac", "chain reads"], e.wires["s_rpc>a_mac:chain reads"], null, t, m)).toMatchObject({ state: "notlive", why: "Its source refused: HTTP 429 from the node." });
    expect(e.nodes.a_token).toMatchObject({ text: "live" });
    expect(e.nodes.e_x).toMatchObject({ text: "notlive", why: "no heartbeat for 60 min" });
    expect(P.fromEngine(null)).toEqual({ wires: {}, nodes: {} });
  });
  it("the stale apps and PumpPortal nodes: active again in the map of now, and in a map saved with the old note", () => {
    expect(js).toContain('N("w_apps",1880,900,"iPhone and Android apps","site","building"');
    expect(js).toMatch(/N\("s_pp",[^)]*"source","live"/);
    const bw: { PinrBadges?: any } = {};
    vm.runInNewContext(readFileSync(join(dir, "badges.js"), "utf8"), { window: bw });
    const nodes = [{ id: "w_apps", status: "planned", note: "Parked until after launch." }, { id: "s_pp", status: "planned", note: "New Pump.fun and LetsBonk coins, free. Trades on it are paid: not used." }];
    expect(bw.PinrBadges.freshNotes(nodes)).toBe(2);
    expect(nodes.map((n) => n.status)).toEqual(["building", "live"]);
  });
});


describe("Submit and Submissions on /control", () => {
  const src = readFileSync(join(dir, "submit.js"), "utf8");
  const ww: { PinrSubmit?: any } = {};
  vm.runInNewContext(src, { window: ww });
  const P = ww.PinrSubmit;
  const node = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, kind: "reader", status: "live", ins: [], outs: [], ...extra });
  const base = { nodes: [{ id: "z1", kind: "comment", title: "Zone" }, node("a", "Coin pool"), node("b", "Token reader"), node("c", "/api/tokens"), node("d", "Evidence store")], wires: [["a", "coin list", "b", "run"], ["b", "token data", "c", "coin list"]] };
  it("is loaded after the PINRads tab, talks only to the control paths, sends nothing live, and puts nothing on the page as markup", () => {
    expect(html.indexOf("/control/submit.js")).toBeGreaterThan(html.indexOf("/control/adstab.js"));
    expect(src).toContain('"/api/control/submissions"');
    expect(src).toContain('"/api/control/map/accepted"');
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function/);
    expect(src.replaceAll("http://www.w3.org/2000/svg", "")).not.toMatch(/https?:\/\//);
  });
  it("says no changes when the map matches, and lists a wire added and a wire removed in plain words with the nodes' own titles", () => {
    expect(P.diffMaps(base, base).text).toBe("No changes from the last accepted map.");
    expect(P.diffMaps(base, base).count).toBe(0);
    const now = { nodes: base.nodes, wires: [["a", "coin list", "b", "run"], ["a", "coin list", "d", "evidence file"]] };
    const d = P.diffMaps(base, now);
    expect(d.wires_added).toEqual([{ from: "a", fromPort: "coin list", to: "d", toPort: "evidence file" }]);
    expect(d.wires_removed).toEqual([{ from: "b", fromPort: "token data", to: "c", toPort: "coin list" }]);
    expect(d.text.split("\n")).toEqual(["Wire added: Coin pool (coin list) to Evidence store (evidence file).", "Wire removed: Token reader (token data) to /api/tokens (coin list)."]);
  });
  it("calls a wire moved when one end stayed, and says where it was and where it is", () => {
    const now = { nodes: base.nodes, wires: [["a", "coin list", "b", "run"], ["b", "token data", "d", "evidence file"]] };
    const d = P.diffMaps(base, now);
    expect(d.wires_moved).toEqual([{ was: { from: "b", fromPort: "token data", to: "c", toPort: "coin list" }, now: { from: "b", fromPort: "token data", to: "d", toPort: "evidence file" } }]);
    expect(d.wires_added).toEqual([]);
    expect(d.wires_removed).toEqual([]);
    expect(d.text).toBe("Wire moved: was Token reader (token data) to /api/tokens (coin list); now Token reader (token data) to Evidence store (evidence file).");
  });
  it("lists nodes added, removed, renamed and a changed status, and ignores zones and positions", () => {
    const now = { nodes: [{ id: "z1", kind: "comment", title: "Other zone" }, node("a", "Coin pool", { x: 500 }), node("b", "Token data reader", { status: "building" }), node("c", "/api/tokens"), node("e", "New reader")], wires: base.wires };
    const d = P.diffMaps(base, now);
    expect(d.nodes_added).toEqual([{ id: "e", title: "New reader" }]);
    expect(d.nodes_removed).toEqual([{ id: "d", title: "Evidence store" }]);
    expect(d.text.split("\n")).toEqual(['Node added: New reader.', 'Node removed: Evidence store.', 'Node renamed: "Token reader" is now "Token data reader".', "Node status: Token data reader was live, now building."]);
  });
  it("does not guess at a pin that several wires left or reached: those stay added and removed", () => {
    const b2 = { nodes: base.nodes, wires: [["a", "coin list", "b", "run"], ["a", "coin list", "c", "coin list"]] };
    const n2 = { nodes: base.nodes, wires: [["a", "coin list", "d", "evidence file"], ["a", "coin list", "d", "other"]] };
    const d = P.diffMaps(b2, n2);
    expect(d.wires_moved).toEqual([]);
    expect(d.wires_added).toHaveLength(2);
    expect(d.wires_removed).toHaveLength(2);
  });
});
