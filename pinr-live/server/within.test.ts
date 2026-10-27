import { describe, expect, it } from "vitest";
import { within } from "./within";

describe("a wait with a ceiling (DEBUG, 26 Oct: a 10 s wait on a chart source that never answers)", () => {
  it("a fetch that never answers gives the fallback after the ceiling, not after its own timeout", async () => {
    const never = new Promise<string>(() => undefined);
    const t0 = Date.now();
    expect(await within(never, 60, "busy")).toBe("busy");
    expect(Date.now() - t0).toBeLessThan(400);
  });
  it("a quick answer is returned as it is, and a failure gives the fallback", async () => {
    expect(await within(Promise.resolve("ok"), 500, "busy")).toBe("ok");
    expect(await within(Promise.reject(new Error("boom")), 500, "busy")).toBe("busy");
  });
});
