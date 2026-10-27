import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import { AD_PICTURE_MAX_BYTES, AD_SLOTS, formProblem, type AdSlot } from "../src/world/adsform.ts";

/**
 * PINRads applications, as the site's server keeps them for the operator. One application is one line of
 * `applications.jsonl` (appended, never rewritten); its picture, re-drawn here as a small WebP so no visitor's file is ever kept or served,
 * is `pictures/<id>.webp`. the engine's control service reads both, read-only, and lists them on /control. Nothing here is published.
 * Spam: at most PER_VISITOR applications a visitor a day and PER_DAY in all; a visitor is a salted one-way code of their address, kept
 * only for the count, in `limits.json`, and never with an application.
 */
export const PER_VISITOR = 3;
export const PER_DAY = 200;

export interface AdRecord {
  v: 1;
  id: string;
  at: string;
  slot: AdSlot;
  name: string;
  link: string;
  contact: string;
  picture: string | null;
}
export type AdAnswer = { status: number; body: { ok: true; id: string } | { ok: false; words: string } };

// eslint-disable-next-line no-control-regex
const plain = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const PICTURE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;

export class AdsDesk {
  private salt: string;
  private limits: { day: string; total: number; by: Record<string, number> };

  constructor(
    private dir: string,
    private now: () => Date = () => new Date(),
  ) {
    // Applicants' contacts are private: the folders are the site account's alone (700) and every file 600. the engine's control service runs as the
    // same account and reads them; no other account on the server can.
    mkdirSync(join(dir, "pictures"), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    chmodSync(join(dir, "pictures"), 0o700);
    if (basename(dirname(dir)) === ".data") chmodSync(dirname(dir), 0o700); // pinr-live/.data, the site's own private folder
    const saltFile = join(dir, ".salt");
    if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(24).toString("hex"), { mode: 0o600 });
    this.salt = readFileSync(saltFile, "utf8").trim();
    this.limits = { day: "", total: 0, by: {} };
    try {
      const l = JSON.parse(readFileSync(join(dir, "limits.json"), "utf8")) as typeof this.limits;
      if (l && typeof l.day === "string" && typeof l.total === "number" && typeof l.by === "object") this.limits = l;
    } catch {
      /* no counts yet */
    }
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /** Reads one application as the form sent it, keeps it, and answers in plain words. */
  async accept(raw: unknown, visitor: string): Promise<AdAnswer> {
    const day = this.today();
    if (this.limits.day !== day) this.limits = { day, total: 0, by: {} };
    const who = createHash("sha256").update(`${this.salt}|${visitor}`).digest("hex").slice(0, 32);
    if ((this.limits.by[who] ?? 0) >= PER_VISITOR) return { status: 429, body: { ok: false, words: `You have sent ${PER_VISITOR} applications today. Please try again tomorrow.` } };
    if (this.limits.total >= PER_DAY) return { status: 429, body: { ok: false, words: "PINR has received all the applications it can take today. Please try again tomorrow." } };
    const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const a = { slot: plain(o.slot, 4) as AdSlot, name: plain(o.name, 60), link: plain(o.link, 200), contact: plain(o.contact, 120) };
    const problem = formProblem(a);
    if (problem || !AD_SLOTS.includes(a.slot)) return { status: 400, body: { ok: false, words: problem ?? "Choose an ad space." } };
    const id = randomBytes(6).toString("hex");
    let picture: string | null = null;
    if (o.picture !== null && o.picture !== undefined && o.picture !== "") {
      const m = typeof o.picture === "string" ? PICTURE.exec(o.picture) : null;
      if (!m) return { status: 400, body: { ok: false, words: "The picture must be a PNG, JPEG, WebP or GIF." } };
      const bytes = Buffer.from(m[2]!, "base64");
      if (bytes.length > AD_PICTURE_MAX_BYTES) return { status: 413, body: { ok: false, words: "The picture can be at most 3 MB." } };
      try {
        const small = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false }).rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
        writeFileSync(join(this.dir, "pictures", `${id}.webp`), small, { mode: 0o600 });
        picture = `${id}.webp`;
      } catch {
        return { status: 400, body: { ok: false, words: "The picture could not be read. Try a PNG or JPEG." } };
      }
    }
    const rec: AdRecord = { v: 1, id, at: this.now().toISOString(), ...a, picture };
    appendFileSync(join(this.dir, "applications.jsonl"), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    this.limits.by[who] = (this.limits.by[who] ?? 0) + 1;
    this.limits.total++;
    writeFileSync(join(this.dir, "limits.json"), JSON.stringify(this.limits), { mode: 0o600 });
    return { status: 200, body: { ok: true, id } };
  }
}
