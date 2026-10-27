import { afterEach, describe, expect, it } from "vitest";
import { labelShown, observedWords, scoreShown, setScoreShown } from "./hub";
import { statusLook } from "./model";

afterEach(() => setScoreShown(false));

describe("the evidence hub switch", () => {
  it("is off by default: the score is hidden, not deleted", () => {
    expect(scoreShown()).toBe(false);
  });
  it("leaves the score slot empty while hidden, and brings the numbers back when switched on", () => {
    const it = { status: "ok" as const, flagKind: null, coverage: 80, value: "61" };
    expect(statusLook(it)).toEqual({ kind: "hidden", text: "", numeric: false });
    setScoreShown(true);
    expect(statusLook(it)).toMatchObject({ kind: "ok", text: "61", numeric: true });
  });
  it("keeps a copy's label (VAMP) as a fact and hides every other score label while hidden", () => {
    expect(statusLook({ status: "flag", flagKind: "VAMP", coverage: 0, value: "—" })).toMatchObject({ kind: "flag", text: "VAMP" });
    expect(statusLook({ status: "flag", flagKind: "HONEYPOT", coverage: 0, value: "—" }).kind).toBe("hidden");
    expect(labelShown("VAMP")).toBe(true);
    for (const l of ["BOT/RUG", "MAYHEM", "HONEYPOT", "Pumped and dumped", null]) expect(labelShown(l)).toBe(false);
    setScoreShown(true);
    expect(labelShown("HONEYPOT")).toBe(true);
  });
  it("says a check's band as what was observed, never a verdict", () => {
    expect(observedWords("Weak")).toBe("worth a closer look");
    for (const b of ["Strong", "Fair", "Clear"]) expect(observedWords(b)).toBe("observed");
    for (const b of ["Not read", "No data", "anything else"]) expect(observedWords(b)).toBe("not checked yet");
  });
  it("leaves a word the server already said as it is", () => {
    for (const w of ["observed", "worth a closer look", "not checked yet"]) expect(observedWords(w)).toBe(w);
  });
  it("never shows the words of a verdict among them", () => {
    for (const b of ["Strong", "Fair", "Weak", "Clear", "Not read", "No data"]) expect(observedWords(b)).not.toMatch(/safe|bad|scam|rug|good|avoid|dangerous|risk|flag|penalt|score/i);
  });
});
