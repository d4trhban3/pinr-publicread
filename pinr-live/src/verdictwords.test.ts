import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** a doctor, not a judge. These exact verdict words never come back on the site or in either app. */
const BANNED = ["Flagged ", "\"Flagged\"", "Hide bots and rugs", "bot, rug or honeypot", "This token is flagged", "Red flag:"];
const ROOTS = ["src", "server", "public", "../pinr-ios/PINR", "../pinr-android/app/src/main"];
const EXT = /\.(ts|js|html|css|swift|kt)$/;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (EXT.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe("verdict words", () => {
  it("none of the exact old strings is left in any shipped file of the site or the apps", () => {
    const hits: string[] = [];
    for (const root of ROOTS) for (const f of files(root)) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(l)) return; // a comment is not on screen
        for (const b of BANNED) if (l.includes(b)) hits.push(`${f}:${i + 1}: ${b}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
