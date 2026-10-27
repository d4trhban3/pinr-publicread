import { describe, expect, it } from "vitest";
import { padOf } from "../src/world/marks";
import { translate } from "./translate";

const MINT = "So1aNaTestMint1111111111111111111111111111";
const seenFile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  mint: MINT,
  score: null,
  display: "not scored yet",
  coverage: 0,
  label: null,
  seen: true,
  seen_at: "2026-10-18T03:00:00Z",
  seen_by: "stonkfun_list",
  chain: "solana",
  launchpad: "LaunchLab curve (StonkFun (reward mode))",
  name: "Seen Coin",
  ticker: "SEEN",
  ...over,
});

describe("a coin the trigger has seen, not scored yet", () => {
  it("is served with no score, says 'Not scored yet', and keeps when and where it was seen", () => {
    const r = translate(seenFile());
    expect(r.problems).toEqual([]);
    expect(r.token).toMatchObject({ score: null, coverage: 0, seen: true, seenBy: "stonkfun_list", note: "Not scored yet", launchpad: "LaunchLab curve (StonkFun (reward mode))" });
    expect(r.token!.seenAtMs).toBe(Date.parse("2026-10-18T03:00:00Z"));
  });

  it("never marks a scored file as seen, and a 'seen' that is not true is noted, not shown", () => {
    const scored = translate(seenFile({ score: 40, display: "40", coverage: 0.5 }));
    expect(scored.token!.seen).toBeUndefined();
    expect(scored.token!.note).toBeNull();
    expect(scored.problems.some((p) => p.field === "seen")).toBe(true);
    const f = translate(seenFile({ seen: false }));
    expect(f.token!.seen).toBeUndefined();
    expect(translate(seenFile({ seen_by: "elsewhere" })).token!.seenBy).toBeUndefined();
  });

  it("wears its launchpad's mark: Stonk.fun, a LaunchLab curve not yet named, Pump.fun", () => {
    expect(padOf({ launchpad: "LaunchLab curve (StonkFun (reward mode))" })).toBe("stonk");
    expect(padOf({ launchpad: "LaunchLab curve" })).toBe("launchlab");
    expect(padOf({ launchpad: "Pump.fun curve" })).toBe("pump");
  });
});

describe("the order: seen or scored in the last 24 hours first, newest first", () => {
  it("the feed server's first page: recent coins newest first, then the engine's roster unchanged", async () => {
    const { orderRoster } = await import("./feed");
    const now = Date.parse("2026-10-18T12:00:00Z");
    const tok = (address: string, over: Record<string, unknown>) => translate({ mint: address, score: 40, display: "40", coverage: 0.5, label: null, ...over }).token!;
    const list = [
      tok("A111111111111111111111111111111111", { roster_rank: 0, as_of: "2026-10-16T12:00:00Z" }), // ranked first, scored 2 days ago
      tok("B111111111111111111111111111111111", { roster_rank: 1, as_of: "2026-10-16T12:00:00Z" }),
      translate(seenFile({ mint: "C111111111111111111111111111111111", seen_at: "2026-10-18T11:00:00Z" })).token!, // seen an hour ago
      tok("D111111111111111111111111111111111", { as_of: "2026-10-18T11:30:00Z" }), // scored 30 minutes ago, no rank
      translate(seenFile({ mint: "E111111111111111111111111111111111", seen_at: "2026-10-17T10:00:00Z" })).token!, // seen 26 hours ago
    ];
    const r = orderRoster(list, 3, now);
    expect(r.tokens.map((t) => t.address[0])).toEqual(["D", "C", "A"]);
    expect(r.rest.map((t) => t.address[0])).toEqual(["B", "E"]);
  });

  it("the tile page's own order, and only in its default direction", async () => {
    const { selectAndRank } = await import("../src/world/filters");
    const now = Date.parse("2026-10-18T12:00:00Z");
    const item = (id: number, over: Record<string, unknown>) => ({ id, base: 0.5, hist: [0.5], histAge: 0, moved: 0, ageMin: 100, status: "ok", flagKind: null, coverage: 50, value: "40", ...over }) as never;
    // scored in the last day first (newest-scored), then unscored new in the last day (newest), then the rest by what is moving.
    const items = [
      item(1, { base: 0.9, ageMin: 3000 }), // scored long ago, old coin: the rest
      item(2, { value: "—", seenAtMs: now - 3600_000 }), // unscored, met an hour ago
      item(3, { scoredAtMs: now - 600_000 }), // scored 10 minutes ago
      item(4, { scoredAtMs: now - 30 * 3600_000, ageMin: 3000 }), // scored 30 hours ago: the rest
      item(5, { scoredAtMs: now - 7200_000 }), // scored 2 hours ago
      item(6, { value: "—", ageMin: 20 }), // unscored launchpad coin, launched 20 minutes ago
    ];
    expect(selectAndRank("trending", items, 10, now, "default").map((r) => r.id)).toEqual([3, 5, 6, 2, 1, 4]);
    expect(selectAndRank("trending", items, 10, now, "desc").map((r) => r.id)[0]).toBe(1);
  });
});

describe("DeepScan for a coin seen, not scored yet", () => {
  it("is built from its feed file alone: the fee 'not read yet' while the mint is unread, never 'none'; the fee once read; no checks", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readDossier } = await import("./dossier");
    const results = mkdtempSync(join(tmpdir(), "res-"));
    const feed = mkdtempSync(join(tmpdir(), "feed-"));
    writeFileSync(join(feed, `${MINT}.json`), JSON.stringify(seenFile()));
    const d = readDossier(MINT, [results], feed);
    expect(d.available).toBe(true);
    expect(d.seen).toBe(true);
    expect(d.checks).toEqual([]);
    expect(d.facts).toEqual([{ id: "transfer_fee", label: "Transfer fee", value: "—", notRead: true }]);
    const fee = { id: "transfer_fee", label: "Transfer fee", value: 1, unit: "percent", fee_kind: "rewards_standard", fee_case: "rewards_standard", program: "StonkFun reward mode", standard_pct: 3, standard_basis: "settings", source: "Solana chain", read_at: "2026-10-18T03:01:00Z", link: `https://solscan.io/token/${MINT}` };
    writeFileSync(join(feed, `${MINT}.json`), JSON.stringify(seenFile({ facts: [fee] })));
    expect(readDossier(MINT, [results], feed).facts[0]).toMatchObject({ value: "1% · StonkFun reward mode, below its standard 3%", source: "Solana chain" });
    // a feed file that is not a seen one, with no result file: no evidence, as before
    writeFileSync(join(feed, `${MINT}.json`), JSON.stringify({ ...seenFile(), seen: undefined }));
    expect(readDossier(MINT, [results], feed).available).toBe(false);
  });
});
