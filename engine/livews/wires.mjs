// the logs feed's wire meters, in the same file shape as scanner/wires.py (control/wires/<name>.json), so the
// control service merges them with the Python services'. Counts per minute over the window, the last time, one real sample.
// Only a named service writes (a test counts in memory and writes nothing); a failure to count or write never stops a trade.
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ENGINE } from "./trades.mjs";

export const FLUSH_MS = 15_000, WINDOW_S = 300, SAMPLE_MAX = 400;
const wires = new Map();
let proc = null, lastFlush = 0, dir = join(ENGINE, "control", "wires");

export function name(n, d) { proc = String(n).replace(/[^A-Za-z0-9_-]/g, "") || null; if (d) dir = d; }

const short = (v) => { const s = JSON.stringify(v); return s.length <= SAMPLE_MAX ? v : s.slice(0, SAMPLE_MAX) + "…"; };

export function meter(wire, n = 1, sample, now = Date.now()) {
  try {
    if (!Number.isInteger(n) || n <= 0) return;
    const w = wires.get(wire) || { buckets: {} };
    const m = Math.floor(now / 60000);
    w.buckets[m] = (w.buckets[m] || 0) + n;
    for (const k of Object.keys(w.buckets)) if (+k < m - WINDOW_S / 60) delete w.buckets[k];
    w.last_at = now / 1000;
    if (sample !== undefined) w.sample = short(sample);
    wires.set(wire, w);
    flush(now);
  } catch {}
}

export function flush(now = Date.now(), force = false) {
  try {
    if (!proc) return null;
    if (!force && now - lastFlush < FLUSH_MS) return null;
    lastFlush = now;
    const body = { process: proc, pid: process.pid, written_at: now / 1000, nodes: {}, wires: Object.fromEntries(wires) };
    mkdirSync(dir, { recursive: true });
    const p = join(dir, proc + ".json"), tmp = p + ".tmp" + process.pid;
    writeFileSync(tmp, JSON.stringify(body)); renameSync(tmp, p);
    return p;
  } catch { return null; }
}
