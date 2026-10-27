/**
 * Where a visitor's browser may load a coin's picture straight from the picture's own host, instead of through the server's /api/img (the team: the server's
 * one address must not be the bottleneck). Only well-known picture hosts are named here (a creator can put a picture on any host, and a host of
 * their choosing would see every visitor's address): any other picture still goes through the server. The same list is the policy's `img-src`.
 */
export const DIRECT_IMAGE_HOSTS: readonly string[] = [
  "ipfs.io",
  "gateway.pinata.cloud",
  "*.mypinata.cloud",
  "images.pump.fun",
  "pbs.twimg.com",
  "gateway.irys.xyz",
  "*.myfilebase.com",
  "storage.googleapis.com",
  "*.axiom-cdn.io",
  "metadata.j7tracker.io",
  "cf-ipfs.com",
  "arweave.net",
  "gmgn.ai",
];
const hostRe = (h: string): RegExp => new RegExp(`^${h.replace(/\./g, "\\.").replace(/^\*\\\./, "([a-z0-9-]+\\.)+")}$`, "i");
const RES = DIRECT_IMAGE_HOSTS.map(hostRe);
/** The picture's address for the browser when its host is on the list (https only, no credentials), else null: the server serves it. */
export function directImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || u.href.length > 400) return null;
    return RES.some((r) => r.test(u.hostname)) ? u.href : null;
  } catch {
    return null;
  }
}
