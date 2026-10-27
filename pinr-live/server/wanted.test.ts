import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KEEP_S, MAX_ENTRIES, VISITOR_COINS_PER_HOUR, Wanted, WRITE_GAP_MS } from "./wanted.ts";
import { MAX_AGE_MS, readBudget } from "./budgetmeter.ts";

const A = "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const B = "B7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const NOW = 1_800_000_000_000;
const dir = (): string => mkdtempSync(join(tmpdir(), "wanted-"));
const read = (p: string): Record<string, number> => JSON.parse(readFileSync(p, "utf8"));

describe("the site's wanted list", () => {
  it("writes {mint: unix seconds} for a valid mint, whole, with no temporary file left", () => {
    const p = join(dir(), "w.json");
    const w = new Wanted(p, () => NOW);
    w.add(A);
    expect(read(p)).toEqual({ [A]: NOW / 1000 });
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });
  it("ignores a malformed address and writes nothing when switched off", () => {
    const p = join(dir(), "w.json");
    const w = new Wanted(p, () => NOW);
    for (const bad of ["", "short", "0x" + "a".repeat(40), `${A}'; drop`, "../x"]) w.add(bad);
    expect(w.size).toBe(0);
    expect(existsSync(p)).toBe(false);
    const off = new Wanted(null, () => NOW);
    off.add(A);
    expect(off.size).toBe(0);
  });
  it("writes at most once a second: a second coin waits for the next flush", () => {
    const p = join(dir(), "w.json");
    let t = NOW;
    const w = new Wanted(p, () => t);
    w.add(A);
    t += 300;
    w.add(B);
    expect(Object.keys(read(p))).toEqual([A]);
    t += WRITE_GAP_MS;
    w.flush();
    expect(Object.keys(read(p)).sort()).toEqual([A, B].sort());
    expect(w.writes).toBe(2);
  });
  it("drops entries older than a day, keeps the newest 2000, and loads the file's own earlier entries on start", () => {
    const p = join(dir(), "w.json");
    writeFileSync(p, JSON.stringify({ [A]: NOW / 1000 - KEEP_S - 5, [B]: NOW / 1000 - 10, junk: 5, ["C".repeat(40)]: "x" }));
    const w = new Wanted(p, () => NOW);
    expect(w.size).toBe(1); // only B survives: A is a day old, the others are not entries
    let t = NOW;
    const big = new Wanted(join(dir(), "b.json"), () => t);
    for (let i = 0; i < MAX_ENTRIES + 50; i++) {
      t += 1;
      big.add(`${"D".repeat(30)}${[...String(i).padStart(10, "0")].map((c) => "ABCDEFGHJK"[Number(c)]).join("")}`);
    }
    t += WRITE_GAP_MS;
    big.flush();
    expect(big.size).toBeLessThanOrEqual(MAX_ENTRIES);
  });
  it("never throws when the folder is missing: the write is counted and tried again", () => {
    const w = new Wanted(join(dir(), "no", "such", "w.json"), () => NOW);
    expect(() => w.add(A)).not.toThrow();
    expect(w.failures).toBe(1);
    expect(w.writes).toBe(0);
  });
});

describe("the wanted list's per-visitor limit (item 39)", () => {
  const mintN = (i: number): string => `${"F".repeat(30)}${[...String(i).padStart(10, "0")].map((c) => "ABCDEFGHJK"[Number(c)]).join("")}`;
  it("takes only so many different coins an hour from one visitor, the same coin again costing nothing", () => {
    let t = NOW;
    const w = new Wanted(join(dir(), "w.json"), () => t);
    for (let i = 0; i < VISITOR_COINS_PER_HOUR + 10; i++) {
      t += 1;
      w.add(mintN(i), "1.2.3.4");
    }
    expect(w.size).toBe(VISITOR_COINS_PER_HOUR);
    w.add(mintN(0), "1.2.3.4"); // one it already added: still fine, nothing new
    expect(w.size).toBe(VISITOR_COINS_PER_HOUR);
  });
  it("counts each visitor on its own, and starts the count over after an hour", () => {
    let t = NOW;
    const w = new Wanted(join(dir(), "w.json"), () => t);
    for (let i = 0; i < VISITOR_COINS_PER_HOUR; i++) w.add(mintN(i), "a");
    w.add(mintN(900), "a"); // over a's limit
    w.add(mintN(901), "b"); // another visitor is unaffected
    expect(w.size).toBe(VISITOR_COINS_PER_HOUR + 1);
    t += 3_600_001;
    w.add(mintN(902), "a");
    expect(w.size).toBe(VISITOR_COINS_PER_HOUR + 2);
  });
  it("never writes the visitor anywhere", () => {
    const p = join(dir(), "w.json");
    const w = new Wanted(p, () => NOW);
    w.add(mintN(1), "203.0.113.9");
    expect(readFileSync(p, "utf8")).not.toContain("203.0.113.9");
  });
});

describe("the public PINRbot budget meter", () => {
  const day = new Date(NOW).toISOString().slice(0, 10);
  const file = (o: unknown): string => {
    const p = join(dir(), "_pinrbot-budget.json");
    writeFileSync(p, typeof o === "string" ? o : JSON.stringify(o));
    return p;
  };
  const good = { day, used_pct: 36.6, status: "on", as_of: new Date(NOW - 60_000).toISOString() };
  it("gives a whole percentage and the status, and nothing else", () => {
    expect(readBudget(file(good), NOW)).toEqual({ status: "on", usedPct: 37, asOfMs: NOW - 60_000 });
    expect(readBudget(file({ ...good, status: "off", used_pct: 12 }), NOW)).toMatchObject({ status: "off", usedPct: 0 });
    expect(JSON.stringify(readBudget(file({ ...good, cap_usd: 25, spent_usd: 9 }), NOW))).not.toMatch(/usd|cap|spent/i);
  });
  it("gives nothing for a missing, old, other-day, out-of-range or malformed file", () => {
    expect(readBudget("/no/such/file.json", NOW)).toBeNull();
    expect(readBudget(file("not json"), NOW)).toBeNull();
    expect(readBudget(file({ ...good, day: "2020-01-01" }), NOW)).toBeNull();
    expect(readBudget(file({ ...good, as_of: new Date(NOW - MAX_AGE_MS - 1000).toISOString() }), NOW)).toBeNull();
    for (const used_pct of [-1, 101, "40", null]) expect(readBudget(file({ ...good, used_pct }), NOW)).toBeNull();
    expect(readBudget(file({ ...good, status: "maybe" }), NOW)).toBeNull();
  });
});
