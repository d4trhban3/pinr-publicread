import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { artHashes, versionArt } from "../artversions";

const root = join(import.meta.dirname, "..");

describe("every /art/ address changes with its file (no stale picture or video in any cache)", () => {
  it("adds the file's own content hash, leaves an unknown file and an already versioned one alone", () => {
    const h = new Map([["a.svg", "0123456789"]]);
    expect(versionArt('src="/art/a.svg" url("/art/a.svg")', h)).toBe('src="/art/a.svg?v=0123456789" url("/art/a.svg?v=0123456789")');
    expect(versionArt('"/art/b.svg"', h)).toBe('"/art/b.svg"');
    expect(versionArt('"/art/a.svg?v=0123456789"', h)).toBe('"/art/a.svg?v=0123456789"');
  });

  it("the built site: every /art/ address in the page, the code and the styles carries its current file's hash", async () => {
    const out = mkdtempSync(join(tmpdir(), "pinr-art-"));
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await build({ root, mode: "production", logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
    } finally {
      process.env.NODE_ENV = env;
    }
    const files = [join(out, "index.html"), ...readdirSync(join(out, "assets")).filter((f) => /\.(js|css)$/.test(f)).map((f) => join(out, "assets", f))];
    const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const hashes = artHashes(join(root, "public"));
    const found = [...text.matchAll(/\/art\/([\w.-]+\.(?:svg|jpe?g|png|webp|gif|mp4|webm))(\?v=([0-9a-f]{10}))?/g)];
    expect(found.length).toBeGreaterThan(8);
    for (const m of found) expect(m[3], m[0]).toBe(hashes.get(m[1]!));
  }, 60_000);
});

describe("a changed picture changes the name of the style or code that points at it", () => {
  it("the built code's file name changes when the GUIDE wordmark's content changes (no cache can keep the old code)", async () => {
    const { artVersions } = await import("../artversions");
    const { cpSync, mkdtempSync: mk, writeFileSync } = await import("node:fs");
    const pub = mk(join(tmpdir(), "pinr-pub-"));
    cpSync(join(root, "public"), pub, { recursive: true });
    const cssName = async (): Promise<string> => {
      const out = mk(join(tmpdir(), "pinr-art2-"));
      const env = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        await build({ root, configFile: false, publicDir: pub, mode: "production", logLevel: "silent", plugins: [artVersions(pub)], build: { outDir: out, emptyOutDir: true, target: "es2022" } });
      } finally {
        process.env.NODE_ENV = env;
      }
      return readdirSync(join(out, "assets")).find((f) => f.endsWith(".js"))!;
    };
    const before = await cssName();
    writeFileSync(join(pub, "art", "guide-wordmark-dark.svg"), readFileSync(join(pub, "art", "guide-wordmark-dark.svg"), "utf8") + "\n<!-- changed -->\n");
    const after = await cssName();
    expect(after).not.toBe(before);
  }, 120_000);
});
