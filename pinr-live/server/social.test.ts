import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSocial, plain, readSocial } from "./social.ts";

const MINT = "CCbWVGWaAxXVKXGUGfTxhJQgVNqsUK8sFUpPBERgpump";
const claim = (over: Record<string, unknown> = {}) => ({ claim_id: "c1", post_url: "https://x.com/someone/status/1", handle: "someone", posted_at: "2026-10-14T02:37:20Z", read_at: "2026-10-14T02:42:41Z", quote: "MC: $36,238", result: "UNVERIFIABLE", line: 'Post says: "MC: $36,238". Dossier shows: no fact for this. Result: UNVERIFIABLE (x).', dossier_link: null, ...over });
const file = (over: Record<string, unknown> = {}) => ({ schema_version: "1", version: 2, scanned_at: "2026-10-14T02:42:41Z", claims: [claim()], flags: [], gaps: ["no Telegram link known"], totals: {}, ...over });

describe("the social scan file", () => {
  it("builds the section from named fields only", () => {
    const s = buildSocial({ ...file(), secret: "x", rules: "private rules" })!;
    expect(s.claims).toHaveLength(1);
    expect(s.claims[0]).toMatchObject({ result: "UNVERIFIABLE", handle: "someone", removed: false, postUrl: "https://x.com/someone/status/1", postedAtMs: Date.parse("2026-10-14T02:37:20Z"), readAtMs: Date.parse("2026-10-14T02:42:41Z"), dossierLink: null });
    expect(s.totals).toEqual({ MATCHES: 0, DIVERGES: 0, UNVERIFIABLE: 1, "NOT CHECKABLE": 0 });
    expect(JSON.stringify(s)).not.toMatch(/secret|private rules/);
  });
  it("refuses a file that is not a scan, a claim with an unknown result or no line, and unsafe links and markup", () => {
    expect(buildSocial(null)).toBeNull();
    expect(buildSocial({ claims: [] })).toBeNull();
    const s = buildSocial(file({ claims: [claim({ result: "PROBABLY" }), claim({ line: "" }), claim({ post_url: "javascript:alert(1)", dossier_link: "http://x.com/a", line: "<b>Post says</b> hi <script>x</script>" })] }))!;
    expect(s.claims).toHaveLength(1);
    expect(s.claims[0]!.postUrl).toBeNull();
    expect(s.claims[0]!.dossierLink).toBeNull();
    expect(s.claims[0]!.line).not.toMatch(/[<>]/);
    expect(plain("a\u0000b\n\n c", 10)).toBe("a b c");
  });
  it("the flag 'the linked X account names another coin' is worded here from its fields, with its receipt", () => {
    const s = buildSocial(file({ flags: [{ flag: "linked_x_account_names_another_coin", other_coin: { name: "Other Coin", ticker: "$OTH", mint: "abc" }, source: "an X post", read_at: "2026-10-14T01:00:00Z", link: "https://x.com/a/status/9" }] }))!;
    expect(s.flags).toEqual([{ kind: "linked_x_account_names_another_coin", text: "The linked X account names another coin: Other Coin ($OTH).", source: "an X post", readAtMs: Date.parse("2026-10-14T01:00:00Z"), link: "https://x.com/a/status/9" }]);
  });
  it("the flag 'the launchpad's X link is another account's post' says how long before the coin existed", () => {
    const f = (m: number | undefined) => buildSocial(file({ flags: [{ flag: "launchpad_x_link_is_another_accounts_post", handle: "Goodcallouts", minutes_before_launch: m, source: "Pump.fun", read_at: "2026-10-14T02:51:21Z", link: "https://x.com/g/status/1" }] }))!.flags[0]!.text;
    expect(f(-2.8)).toBe("The coin's X link is a post by @Goodcallouts, not the coin's own account, written 3 minutes before the coin existed.");
    expect(f(-190)).toContain("3 hours before the coin existed");
    expect(f(12)).toContain("12 minutes after the launch");
    expect(f(undefined)).toBe("The coin's X link is a post by @Goodcallouts, not the coin's own account.");
    expect(buildSocial(file({ flags: [{ flag: "something_new" }] }))!.flags).toEqual([]);
  });
  it("reads one file per mint from the folder, and nothing for an unknown or malformed address", () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-"));
    writeFileSync(join(dir, `${MINT}.json`), JSON.stringify(file()));
    expect(readSocial(MINT, dir)!.version).toBe(2);
    expect(readSocial("B" + MINT.slice(1), dir)).toBeNull();
    expect(readSocial("../../etc/passwd", dir)).toBeNull();
    writeFileSync(join(dir, `${"C".repeat(40)}.json`), "not json");
    expect(readSocial("C".repeat(40), dir)).toBeNull();
  });
  it("a claim that is NOT CHECKABLE is only counted: never its words, never its link", () => {
    const s = buildSocial(file({ claims: [claim(), claim({ claim_id: "c2", result: "NOT CHECKABLE", line: "Post says: \"find it on the airdrop page\". Result: NOT CHECKABLE", post_url: "https://x.com/promo/status/5" }), claim({ claim_id: "c3", result: "NOT CHECKABLE" })] }))!;
    expect(s.claims.map((c) => c.result)).toEqual(["UNVERIFIABLE"]);
    expect(s.totals["NOT CHECKABLE"]).toBe(2);
    expect(JSON.stringify(s)).not.toContain("airdrop");
  });
  it("a post the file marks removed has no link; only allow-listed kinds of links become links", () => {
    const s = buildSocial(file({ claims: [claim({ post_status: "removed" }), claim({ post_removed_seen_at: "2026-10-14T03:00:00Z" }), claim({ post_url: "https://evil.example/phish", dossier_link: "https://solscan.io/account/abc" }), claim({ post_url: "https://t.me/group/12", dossier_link: "https://pump.fun/coin/x" })] }))!;
    expect(s.claims.map((c) => [c.removed, c.postUrl, c.dossierLink])).toEqual([
      [true, null, null],
      [true, null, null],
      [false, null, "https://solscan.io/account/abc"],
      [false, "https://t.me/group/12", "https://pump.fun/coin/x"],
    ]);
    expect(buildSocial(file({ flags: [{ flag: "launchpad_x_link_is_another_accounts_post", handle: "a", source: "s", read_at: "2026-10-14T03:00:00Z", link: "https://evil.example/x" }] }))!.flags[0]!.link).toBeNull();
  });
});
