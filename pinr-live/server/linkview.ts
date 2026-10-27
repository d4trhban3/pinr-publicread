/**
 * The coin's own links (X, Telegram, website) as the tiles and the coin page show them (the engine's `links` in a feed file, the Pump.fun record's own
 * twitter, telegram and website fields). The creator wrote them, so only a plain web address survives: https or http, no user or password, a
 * host with a dot, at most 200 characters; X and Telegram only on their own hosts. Stored as https where the host allows it.
 */
export interface TileLinks {
  x?: string;
  telegram?: string;
  website?: string;
}
const MAX = 200;
function web(v: unknown, hosts?: RegExp): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || !u.hostname.includes(".")) return null;
    if (hosts && !hosts.test(u.hostname)) return null;
    const out = hosts ? `https://${u.host}${u.pathname}${u.search}` : u.href;
    return out.length <= MAX ? out : null;
  } catch {
    return null;
  }
}
/** Clean links from a feed file's `links` or a launchpad record; undefined when there are none. */
export function cleanTileLinks(raw: unknown): TileLinks | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const l = raw as Record<string, unknown>;
  const x = web(l.x ?? l.twitter, /^(www\.|mobile\.)?(x|twitter)\.com$/i);
  const telegram = web(l.telegram, /^(www\.)?(t|telegram)\.me$/i);
  const website = web(l.website);
  if (!x && !telegram && !website) return undefined;
  return { ...(x ? { x } : {}), ...(telegram ? { telegram } : {}), ...(website ? { website } : {}) };
}
