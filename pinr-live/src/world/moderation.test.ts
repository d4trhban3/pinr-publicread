import { describe, expect, it } from "vitest";
import { isRude, MASKED_NAME, MASKED_TICKER, Moderation, type KeyValueStore } from "./moderation";

const mem = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe("the rude-name filter (the iPhone app's rules)", () => {
  it("catches rude names, with letter swaps, any case, inside a word", () => {
    for (const n of ["Wet Ass Pussy", "FUCK U CAT", "BootyDickPussy", "$SHITTER", "Sh1t Inu", "fuck cat", "Nice Fucking Token"]) expect(isRude(n), n).toBe(true);
  });
  it("leaves harmless names: a $ ticker, words across a space, short stems inside words, allowed names", () => {
    for (const n of ["$HIT", "RIP Satoshi Tajiri", "Document", "Analytics", "Cockatoo", "Moby Dick", "Sxunthorpe", "Grape", "Titsy".replace("s", "")]) expect(isRude(n), n).toBe(false);
  });
  it("is quiet about nothing", () => {
    expect(isRude(null)).toBe(false);
    expect(isRude("")).toBe(false);
  });
});

describe("what a person has hidden", () => {
  it("is kept in the browser and read back, case-blind", () => {
    const s = mem();
    const a = new Moderation(s);
    a.hide("AbC123");
    const b = new Moderation(s);
    expect(b.isHidden("abc123")).toBe(true);
    expect(b.isHidden("other")).toBe(false);
    expect(b.hiddenCount).toBe(1);
    b.unhide("ABC123");
    expect(new Moderation(s).hiddenCount).toBe(0);
    b.hide("x");
    b.unhideAll();
    expect(new Moderation(s).hiddenCount).toBe(0);
  });
  it("starts with the name filter on, remembers it switched off, and masks only while on", () => {
    const s = mem();
    const m = new Moderation(s);
    expect(m.filterNames).toBe(true);
    expect(m.masks("Wet Ass Pussy", "$WAP")).toBe(true);
    expect(m.masks("Fine Coin", "$FINE")).toBe(false);
    m.setFilterNames(false);
    expect(m.masks("Wet Ass Pussy", "$WAP")).toBe(false);
    expect(new Moderation(s).filterNames).toBe(false);
    expect(MASKED_NAME).toBe("Name hidden");
    expect(MASKED_TICKER).toBe("$•••");
  });
  it("tells listeners and bumps its revision on every change; works with no storage at all", () => {
    const m = new Moderation(null);
    let n = 0;
    m.onChange(() => n++);
    m.hide("x");
    m.setFilterNames(false);
    m.unhideAll();
    expect(n).toBe(3);
    expect(m.rev).toBe(3);
  });
  it("ignores damaged saved data", () => {
    const s = mem();
    s.setItem("pinr.hidden", "{not json");
    expect(new Moderation(s).hiddenCount).toBe(0);
    s.setItem("pinr.hidden", '{"a":1}');
    expect(new Moderation(s).hiddenCount).toBe(0);
  });
});
