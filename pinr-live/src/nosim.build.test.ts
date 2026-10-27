import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";

/**
 * no simulated data on pinr.io. The made-up tokens, their charts and their wording live only in dev mode and in tests; this
 * builds the site the way the server ships it and checks that none of it is in the code a visitor downloads.
 */
describe("the production build has no simulated data", () => {
  it("carries no simulated chart, made-up token, SIM tag or simulated search wording", async () => {
    const out = mkdtempSync(join(tmpdir(), "pinr-prod-"));
    // Vitest runs with NODE_ENV=test, which would make the build keep its dev-only code: build as the server's deploy does, then put it back.
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await build({ root: join(import.meta.dirname, ".."), mode: "production", logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
    } finally {
      process.env.NODE_ENV = env;
    }
    const js = readdirSync(join(out, "assets"))
      .filter((f) => f.endsWith(".js") && f.startsWith("index-"))
      .map((f) => readFileSync(join(out, "assets", f), "utf8"))
      .join("\n");
    expect(js.length).toBeGreaterThan(10_000);
    for (const marker of [/simulat/i, /made-up token/i, /"SIM"/, /No chart for/]) expect(marker.test(js), `the build carries ${String(marker)}`).toBe(false);
  }, 60_000);
});
