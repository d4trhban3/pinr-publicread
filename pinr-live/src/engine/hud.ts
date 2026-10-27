/**
 * Frame-time counter. Measures what the screen actually delivers, so we can prove 120fps
 * instead of assuming it. Shown only with ?hud in the URL (always on in dev).
 */
export class FrameHud {
  private samples = new Float32Array(180);
  private n = 0;
  private i = 0;
  private el: HTMLElement;
  private lastPaint = 0;
  /** Extra line shown under the frame stats. */
  extra = "";
  /** Smoothed script time per frame, ms. Shows our own cost separately from the screen's frame rate. */
  cpu = 0;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  push(dtMs: number, now: number): void {
    this.samples[this.i] = dtMs;
    this.i = (this.i + 1) % this.samples.length;
    this.n = Math.min(this.n + 1, this.samples.length);
    if (now - this.lastPaint > 250) {
      this.lastPaint = now;
      this.paint();
    }
  }

  private paint(): void {
    const s = Array.from(this.samples.subarray(0, this.n)).sort((a, b) => a - b);
    if (s.length < 10) return;
    const median = s[Math.floor(s.length / 2)]!;
    const p99 = s[Math.floor(s.length * 0.99)]!;
    const fps = 1000 / median;
    // A frame is "dropped" if it took clearly longer than a typical one.
    const dropped = s.filter((x) => x > median * 1.5).length;
    this.el.textContent = `${fps.toFixed(0)} fps · med ${median.toFixed(1)} ms · p99 ${p99.toFixed(1)} ms · drops ${dropped}/${s.length} · cpu ${this.cpu.toFixed(2)} ms` + (this.extra ? `\n${this.extra}` : "");
  }
}
