import { describe, expect, it } from "vitest";
import { BEARING, needleAngle, PART } from "./compass";
import { PAGE_ORDER, pageFrames } from "../world/sitemap";

describe("compass", () => {
  it("every page has a bearing and a lit part", () => {
    for (const id of PAGE_ORDER) {
      expect(id in BEARING).toBe(true);
      expect(PART[id]).toBeTruthy();
    }
  });
  it("bearings agree with where the page sits on the map", () => {
    const f = pageFrames(378, 675);
    const c = f.pinr;
    for (const id of PAGE_ORDER) {
      const b = BEARING[id];
      if (b === null) continue;
      const dx = f[id].x - c.x;
      const dy = f[id].y - c.y;
      const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
      const diff = Math.abs((((deg + 360) % 360) - b + 540) % 360 - 180);
      expect(diff).toBeLessThan(20);
    }
  });
  it("the blade turns so its tip faces the page and rests upright at PINR, the middle", () => {
    expect(needleAngle("arena")).toBe(180);
    expect(needleAngle("deepscan")).toBe(360);
    expect(needleAngle("pinr")).toBe(0);
  });
});
