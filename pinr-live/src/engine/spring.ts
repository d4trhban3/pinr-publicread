/**
 * Critically damped spring, closed-form solution.
 * Exact for any dt, so motion is identical at 60, 120 or 240 fps and can never blow up.
 * `omega` is the stiffness in rad/s: higher = snappier (about 8 is soft, 20 is tight).
 */
export interface Spring {
  x: number;
  v: number;
  target: number;
}

export function makeSpring(x = 0): Spring {
  return { x, v: 0, target: x };
}

export function stepSpring(s: Spring, omega: number, dt: number): void {
  const e = Math.exp(-omega * dt);
  const d = s.x - s.target;
  const t = (s.v + omega * d) * dt;
  s.x = s.target + (d + t) * e;
  s.v = (s.v - omega * t) * e;
}

export function springSettled(s: Spring, eps = 1e-4): boolean {
  return Math.abs(s.x - s.target) < eps && Math.abs(s.v) < eps;
}
