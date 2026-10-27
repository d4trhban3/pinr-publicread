// the launchpads' events and accounts read by their own published IDLs (stage2/idl/: Pump.fun's pump.json
// and pump_amm.json, Raydium's raydium_launchpad.json, copied unchanged 2026-10-25), the same reading as scanner/sqd.py's
// Idl: each event's 8-byte tag, then its fields in the IDL's order (Borsh, as Anchor writes them). Nothing about a layout
// is written here by hand. A field the bytes end before (an older, shorter event) is absent, never filled in.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "./b58.mjs";

const IDL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "stage2", "idl");
export const IDL_PATHS = { pump: join(IDL_DIR, "pump.json"), pump_amm: join(IDL_DIR, "pump_amm.json"), launchlab: join(IDL_DIR, "raydium_launchpad.json") };

class Short extends Error {}
const FIXED = { u8: [1, "readUInt8"], i8: [1, "readInt8"], u16: [2, "readUInt16LE"], i16: [2, "readInt16LE"], u32: [4, "readUInt32LE"], i32: [4, "readInt32LE"],
                u64: [8, "readBigUInt64LE"], i64: [8, "readBigInt64LE"] };

export class Idl {
  constructor(path) {
    const d = JSON.parse(readFileSync(path, "utf8"));
    this.types = Object.fromEntries((d.types || []).map((t) => [t.name, t.type]));
    this.events = new Map((d.events || []).filter((e) => e.discriminator).map((e) => [Buffer.from(e.discriminator).toString("hex"), e.name]));
    this.accounts = new Map((d.accounts || []).filter((a) => a.discriminator).map((a) => [a.name, Buffer.from(a.discriminator).toString("hex")]));
  }
  read(t, b, p) {
    if (typeof t === "string") {
      if (FIXED[t]) { const [n, fn] = FIXED[t]; if (p + n > b.length) throw new Short(); const v = b[fn](p); return [typeof v === "bigint" ? Number(v) : v, p + n]; }
      if (t === "u128" || t === "i128") {
        if (p + 16 > b.length) throw new Short();
        let v = 0n; for (let k = 15; k >= 0; k--) v = (v << 8n) | BigInt(b[p + k]);
        if (t === "i128" && v >= 1n << 127n) v -= 1n << 128n;
        return [Number(v), p + 16];
      }
      if (t === "bool") { if (p + 1 > b.length) throw new Short(); return [b[p] !== 0, p + 1]; }
      if (t === "pubkey") { if (p + 32 > b.length) throw new Short(); return [bs58(b.subarray(p, p + 32)), p + 32]; }
      if (t === "string" || t === "bytes") {
        let n; [n, p] = this.read("u32", b, p); if (p + n > b.length) throw new Short();
        const raw = b.subarray(p, p + n); return [t === "string" ? raw.toString("utf8") : raw.toString("hex"), p + n];
      }
      throw new Error("unknown type " + t);
    }
    if (t.vec) { let n; [n, p] = this.read("u32", b, p); const out = []; for (let k = 0; k < n; k++) { let v; [v, p] = this.read(t.vec, b, p); out.push(v); } return [out, p]; }
    if (t.option) { let f; [f, p] = this.read("u8", b, p); return f === 0 ? [null, p] : this.read(t.option, b, p); }
    if (t.array) { const [inner, n] = t.array, out = []; for (let k = 0; k < n; k++) { let v; [v, p] = this.read(inner, b, p); out.push(v); } return [out, p]; }
    if (t.defined) return this.struct(this.types[typeof t.defined === "string" ? t.defined : t.defined.name], b, p);
    throw new Error("unknown type " + JSON.stringify(t));
  }
  struct(spec, b, p) {
    if (spec.kind === "enum") {                                       // a variant's number, then its fields if it has any
      let i; [i, p] = this.read("u8", b, p);
      const v = (spec.variants || [])[i]; if (!v) throw new Error("unknown variant");
      if (v.fields && v.fields.length && v.fields[0] && typeof v.fields[0] === "object" && "name" in v.fields[0]) {
        let inner; [inner, p] = this.struct({ kind: "struct", fields: v.fields }, b, p); return [{ [v.name]: inner }, p];
      }
      return [v.name, p];
    }
    if (spec.kind !== "struct") throw new Error("not a struct");
    const out = {};
    for (const f of spec.fields || []) [out[f.name], p] = this.read(f.type, b, p);
    return [out, p];
  }
  /** [event name, fields] for one event's bytes, or null when its tag is not one of the IDL's events. */
  event(data) {
    const name = this.events.get(Buffer.from(data.subarray(0, 8)).toString("hex"));
    if (!name) return null;
    const out = {}; let p = 8;
    for (const f of this.types[name]?.fields || []) {
      try { [out[f.name], p] = this.read(f.type, data, p); } catch (e) { if (e instanceof Short) break; throw e; }
    }
    return [name, out];
  }
  /** An account's fields by the IDL's account name, or null when its first 8 bytes are not that account's tag. */
  account(name, data) {
    if (!data || data.length < 8 || Buffer.from(data.subarray(0, 8)).toString("hex") !== this.accounts.get(name)) return null;
    const out = {}; let p = 8;
    for (const f of this.types[name]?.fields || []) {
      try { [out[f.name], p] = this.read(f.type, data, p); } catch (e) { if (e instanceof Short) break; throw e; }
    }
    return out;
  }
}
