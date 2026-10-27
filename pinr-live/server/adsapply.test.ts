import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { formProblem } from "../src/world/adsform.ts";
import { AdsDesk, PER_DAY, PER_VISITOR } from "./adsapply.ts";

const good = { slot: "A1", name: "Moon Project", link: "https://moon.example", contact: "@moon" };
const lines = (dir: string): Record<string, unknown>[] =>
  existsSync(join(dir, "applications.jsonl"))
    ? readFileSync(join(dir, "applications.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

describe("PINRads applications", () => {
  it("keeps a good application as one line, its picture re-drawn as a small WebP, and never keeps the visitor's address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pinr-ads-"));
    const desk = new AdsDesk(dir, () => new Date("2026-10-26T02:00:00Z"));
    const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#6c4dfb" } }).png().toBuffer();
    const a = await desk.accept({ ...good, picture: `data:image/png;base64,${png.toString("base64")}` }, "203.0.113.7");
    expect(a.status).toBe(200);
    const rec = lines(dir)[0]!;
    expect(rec).toMatchObject({ v: 1, slot: "A1", name: "Moon Project", link: "https://moon.example/".replace(/\/$/, ""), contact: "@moon", at: "2026-10-26T02:00:00.000Z" });
    expect(rec.picture).toBe(`${rec.id}.webp`);
    const meta = await sharp(join(dir, "pictures", rec.picture as string)).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(512);
    const everything = readFileSync(join(dir, "applications.jsonl"), "utf8") + readFileSync(join(dir, "limits.json"), "utf8");
    expect(everything).not.toContain("203.0.113.7");
  });
  it("refuses what the form refuses, in the form's words, and keeps nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pinr-ads-"));
    const desk = new AdsDesk(dir);
    for (const [bad, words] of [
      [{ ...good, slot: "Z9" }, /Choose an ad space/],
      [{ ...good, name: " " }, /project's name/],
      [{ ...good, link: "http://moon.example" }, /starting with https/],
      [{ ...good, link: "javascript:alert(1)" }, /starting with https/],
      [{ ...good, contact: "" }, /a way to reach you/],
      [{ ...good, picture: "data:text/html;base64,PGgxPg==" }, /PNG, JPEG, WebP or GIF/],
      [{ ...good, picture: "data:image/png;base64,bm90IGEgcGljdHVyZQ==" }, /could not be read/],
    ] as const) {
      const r = await desk.accept(bad, "v");
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.body.ok).toBe(false);
      expect((r.body as { words: string }).words).toMatch(words);
    }
    expect(lines(dir)).toEqual([]);
    expect(readdirSync(join(dir, "pictures"))).toEqual([]);
  });
  it("takes at most a few a day from one visitor and a fixed number in all, counted again the next day and across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pinr-ads-"));
    let now = new Date("2026-10-26T02:00:00Z");
    let desk = new AdsDesk(dir, () => now);
    for (let i = 0; i < PER_VISITOR; i++) expect((await desk.accept(good, "one")).status).toBe(200);
    expect((await desk.accept(good, "one")).status).toBe(429);
    desk = new AdsDesk(dir, () => now); // a restart keeps the day's counts
    expect((await desk.accept(good, "one")).status).toBe(429);
    expect((await desk.accept(good, "two")).status).toBe(200);
    now = new Date("2026-10-27T00:00:01Z");
    expect((await desk.accept(good, "one")).status).toBe(200);
    for (let i = 0; i < PER_DAY; i++) await desk.accept(good, `v${i}`);
    expect((await desk.accept(good, "late")).status).toBe(429);
  });
  it("the form and the server check the same things", () => {
    expect(formProblem(good as never)).toBeNull();
    expect(formProblem({ ...good, name: "x".repeat(61) } as never)).toMatch(/at most 60/);
  });
  it("keeps applicants' details private to the site's own account (folders 700, files 600)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pinr-ads-"));
    const data = join(root, ".data");
    mkdirSync(data, { mode: 0o755 });
    const dir = join(data, "ads");
    const desk = new AdsDesk(dir);
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#d6ff3c" } }).png().toBuffer();
    const r = await desk.accept({ ...good, picture: `data:image/png;base64,${png.toString("base64")}` }, "v");
    const mode = (p: string): number => statSync(p).mode & 0o777;
    expect(mode(data)).toBe(0o700);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "pictures"))).toBe(0o700);
    for (const f of ["applications.jsonl", "limits.json", ".salt", `pictures/${(r.body as { id: string }).id}.webp`]) expect(mode(join(dir, f))).toBe(0o600);
  });
});
