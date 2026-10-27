import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** a design decision, round 2: the phone's media load after the tiles and only at phone width; nothing of it on a desktop. */
const html = readFileSync(join(import.meta.dirname, "..", "index.html"), "utf8");
const main = readFileSync(join(import.meta.dirname, "main.ts"), "utf8");

describe("the phone's background media", () => {
  it("the page names neither the video nor its poster as something to fetch: both are data attributes the code sets at phone width", () => {
    const video = /<video[\s\S]*?<\/video>/.exec(html)![0];
    expect(video).toMatch(/data-src="\/art\/pinr-bg-creep240\.mp4"/);
    expect(video).toMatch(/data-poster="\/art\/pinr-system-teaser-mobile-poster\.jpg"/);
    expect(video).not.toMatch(/\s(src|poster)="/);
  });
  it("the video's source is set only at phone width, once the first tiles are in, and never when the phone asks to save data", () => {
    // Light mode shows the light teaser at every width, so the (dark) video is wanted only at phone width in dark mode.
    expect(main).toMatch(/const video = phoneBg\.matches && !lightBg\(\);/);
    expect(main).toMatch(/if \(video && poster && bgVid\.getAttribute\("poster"\) !== poster\) bgVid\.poster = poster;/);
    expect(main).toMatch(/if \(video && tilesUp && !saveData\(\) && src && bgVid\.getAttribute\("src"\) !== src\) bgVid\.src = src;/);
    expect(main).toMatch(/connection\?\.saveData === true \|\| matchMedia\("\(prefers-reduced-data: reduce\)"\)\.matches/);
    expect(main).toMatch(/feed\.tick\(store, dt\);\n[^\n]*\n  if \(!tilesUp && store\.items\.length > 0\) \{\n    tilesUp = true;\n    syncBgSource\(\);/);
  });
});
