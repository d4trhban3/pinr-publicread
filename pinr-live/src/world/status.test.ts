import { setScoreShown } from "./hub";
setScoreShown(true); // these tests cover the score's own behaviour: the switch (world/hub.ts) is on for them
import { describe, expect, it } from "vitest";
import { statusLook, THIN_BELOW, type Item } from "./model";
import { SimFeed } from "../testing/simfeed";
import { makeStore } from "./model";

type S = Pick<Item, "status" | "flagKind" | "coverage" | "value">;
const base: S = { status: "ok", flagKind: null, coverage: 80, value: "64" };

describe("status looks", () => {
  it("a normal token shows its real score and coverage", () => {
    expect(statusLook(base)).toEqual({ kind: "ok", text: "64", numeric: true });
  });

  it("low coverage is still a real score, just marked thin", () => {
    const l = statusLook({ ...base, coverage: THIN_BELOW - 1 });
    expect(l.kind).toBe("thin");
    expect(l.text).toBe("64");
    expect(statusLook({ ...base, coverage: THIN_BELOW }).kind).toBe("ok");
  });

  it("zero coverage shows a dash, never a score", () => {
    const l = statusLook({ ...base, coverage: 0 });
    expect(l.text).toBe("—");
    expect(l.numeric).toBe(false);
  });

  it("missing stays missing: scanning and failed readings show a dash, never a number or a zero", () => {
    for (const status of ["checking", "error"] as const) {
      const l = statusLook({ ...base, status });
      expect(l.text).toBe("—");
      expect(l.numeric).toBe(false);
      expect(l.text).not.toMatch(/\d/);
    }
  });

  it("a proven flag shows its label with evidence and NO number, whatever score it had", () => {
    for (const k of ["BOT", "RUG", "VAMP"] as const) {
      const l = statusLook({ ...base, status: "flag", flagKind: k, value: "87" });
      expect(l.text).toBe(k);
      expect(l.numeric).toBe(false);
      expect(l.text).not.toMatch(/\d/);
    }
  });

  it("all five looks are distinct, so no status can be mistaken for another", () => {
    const kinds = new Set([
      statusLook(base).kind,
      statusLook({ ...base, coverage: 20 }).kind,
      statusLook({ ...base, status: "checking" }).kind,
      statusLook({ ...base, status: "error" }).kind,
      statusLook({ ...base, status: "flag", flagKind: "RUG" }).kind,
    ]);
    expect(kinds.size).toBe(5);
  });
});

describe("simulated statuses", () => {
  const run = (seconds: number) => {
    const store = makeStore();
    const feed = new SimFeed();
    for (let t = 0; t < seconds * 30; t++) feed.tick(store, 1 / 30);
    return store;
  };

  it("starts with a mix: flagged, failed and thin tokens, and two with nothing loaded", () => {
    const s = run(0.1);
    expect(s.items.filter((i) => i.status === "flag").length).toBe(7);
    expect(s.items.filter((i) => i.status === "error").length).toBeGreaterThanOrEqual(3);
    expect(s.items.filter((i) => i.coverage === 0).length).toBe(2);
    expect(s.items.filter((i) => i.coverage > 0 && i.coverage < THIN_BELOW).length).toBeGreaterThan(10);
  });

  it("flagged tokens never change, never score and never move: no more data is spent on them", () => {
    const s = run(0.1);
    const flagged = s.items.filter((i) => i.status === "flag").map((i) => ({ id: i.id, v: i.value, base: i.base }));
    const s2 = run(120);
    for (const f of flagged) {
      const it = s2.items.find((i) => i.id === f.id)!;
      expect(it.status).toBe("flag");
      expect(it.spike).toBe(0);
      expect(it.note).toBeNull();
    }
  });

  it("scanning tokens always finish: nothing stays 'scanning' forever, and every flag stays labelled", () => {
    const s = run(200);
    expect(s.items.filter((i) => i.status === "flag").every((i) => i.flagKind !== null)).toBe(true);
    expect(s.items.filter((i) => i.status === "checking").length).toBeLessThan(12);
  });

  it("scanning tokens do not generate events while being read", () => {
    const store = makeStore();
    const feed = new SimFeed();
    feed.tick(store, 0.01);
    const it = store.items[2]!;
    it.status = "checking";
    it.statusLeft = 1000;
    for (let t = 0; t < 30 * 120; t++) feed.tick(store, 1 / 30);
    expect(it.spike).toBe(0);
    expect(it.noteSeq).toBe(0);
  });
});
