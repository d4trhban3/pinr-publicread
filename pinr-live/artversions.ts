import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/**
 * Every picture, video and drawing the page loads from `/art/` carries `?v=` and the first 10 hex of its own content's SHA-256, written
 * in at build time (index.html, the code and the styles). A changed file gets a new address, so no browser or Cloudflare cache can keep
 * showing the old one. An unchanged file keeps
 * its address and stays cached. Files are served as before; the server ignores the query.
 */
export const ART_URL = /\/art\/([\w.-]+\.(?:svg|jpe?g|png|webp|gif|mp4|webm))(?![\w.?-])/g;

export function artHashes(publicDir: string): Map<string, string> {
  const dir = join(publicDir, "art");
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) out.set(f, createHash("sha256").update(readFileSync(join(dir, f))).digest("hex").slice(0, 10));
  return out;
}

/** Add `?v=<hash>` to every `/art/<file>` address in this text whose file exists (an unknown file is left as it is). */
export function versionArt(text: string, hashes: ReadonlyMap<string, string>): string {
  return text.replace(ART_URL, (m, f: string) => (hashes.has(f) ? `${m}?v=${hashes.get(f)}` : m));
}

export function artVersions(publicDir: string): Plugin {
  let hashes = new Map<string, string>();
  return {
    name: "pinr-art-versions",
    apply: "build",
    // Before Vite's own steps, so the styles and the code are versioned BEFORE their file names are hashed: a changed picture then
    // changes the name of every file that points at it, and no cache can keep the old one (a style edited after naming kept its old
    // name, and Cloudflare kept serving the old style: the team found the lime blade still bare on the server).
    enforce: "pre",
    buildStart() {
      hashes = artHashes(publicDir);
    },
    transformIndexHtml(html) {
      return versionArt(html, hashes);
    },
    transform(code, id) {
      if (!/\/src\/.*\.(ts|css)$/.test(id)) return null;
      const out = versionArt(code, hashes);
      return out === code ? null : { code: out, map: null };
    },
  };
}
