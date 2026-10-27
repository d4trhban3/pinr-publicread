import { describe, expect, it } from "vitest";
import { cleanTileLinks } from "./linkview";
import { translate } from "./translate";
import { directImageUrl, DIRECT_IMAGE_HOSTS } from "./imagehosts";

describe("a coin's own links on the tiles", () => {
  it("keeps clean web addresses, X and Telegram on their own hosts only", () => {
    expect(cleanTileLinks({ x: "https://x.com/abc", telegram: "t.me/abc", website: "https://abc.example/" })).toEqual({ x: "https://x.com/abc", telegram: "https://t.me/abc", website: "https://abc.example/" });
    expect(cleanTileLinks({ twitter: "twitter.com/abc" })).toEqual({ x: "https://twitter.com/abc" });
    expect(cleanTileLinks({ x: "https://evil.example/x.com/abc", telegram: "https://x.com/t.me", website: "javascript:alert(1)" })).toBeUndefined();
  });
  it("drops credentials, odd schemes, a host with no dot and very long addresses; none gives undefined", () => {
    expect(cleanTileLinks({ website: "https://u:p@abc.example/" })).toBeUndefined();
    expect(cleanTileLinks({ website: "ftp://abc.example" })).toBeUndefined();
    expect(cleanTileLinks({ website: "localhost" })).toBeUndefined();
    expect(cleanTileLinks({ website: "https://abc.example/" + "a".repeat(300) })).toBeUndefined();
    expect(cleanTileLinks(null)).toBeUndefined();
    expect(cleanTileLinks([])).toBeUndefined();
    expect(cleanTileLinks({ x: 5, website: "" })).toBeUndefined();
  });
  it("reaches the token from a feed file's `links`", () => {
    const raw = { mint: `0x${"1".padStart(40, "0")}`, score: 30, display: "30", label: null, coverage: 0.5, links: { x: "https://x.com/abc", website: "https://abc.example", source: "Solana chain", read_at: "2026-10-22T00:00:00Z" } };
    expect(translate(raw).token?.links).toEqual({ x: "https://x.com/abc", website: "https://abc.example/" });
    expect("links" in translate({ ...raw, links: undefined }).token!).toBe(false);
  });
});

describe("pictures straight from their own host", () => {
  it("sends the browser straight to a listed host over https", () => {
    expect(directImageUrl("https://ipfs.io/ipfs/Qm123")).toBe("https://ipfs.io/ipfs/Qm123");
    expect(directImageUrl("https://images.pump.fun/coin-image/abc?x=1")).toContain("images.pump.fun");
    expect(directImageUrl("https://pump.mypinata.cloud/ipfs/Qm1")).toContain("pump.mypinata.cloud");
    expect(directImageUrl("https://desperate-moccasin-minnow.myfilebase.com/ipfs/Qm")).toContain("myfilebase.com");
  });
  it("keeps every other host, a plain http address and a lookalike on the server", () => {
    for (const u of ["http://ipfs.io/x", "https://46-225-60-163.sslip.io/a.png", "https://ipfs.io.evil.example/a", "https://evilipfs.io/a", "https://u:p@ipfs.io/a", "https://mypinata.cloud.evil.example/a", "ftp://ipfs.io/a", "data:image/png;base64,AAA", "not a url", "", null, undefined]) expect(directImageUrl(u as never)).toBeNull();
  });
  it("names only hosts, not paths or schemes, in the list the policy uses", () => {
    for (const h of DIRECT_IMAGE_HOSTS) expect(h).toMatch(/^(\*\.)?[a-z0-9.-]+\.[a-z]+$/);
  });
});
