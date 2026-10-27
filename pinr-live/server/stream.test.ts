import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListCopy, type StreamChanges } from "../src/world/livefeed";
import { StreamHub, type Row } from "./stream";

/** the lists read once, then kept current by one Server-Sent Events stream of changes. */
const row = (address: string, over: Partial<Row> = {}): Row => ({ address, name: address, score: null, noScoreLabel: null, coverage: 0, launchpad: "Pump.fun curve", priceUsd: 1, valuationUsd: 1000, priceSeries: null, imageUrl: null, ...over });
const meta = (over: Record<string, unknown> = {}) => ({ contract: "1.1", mode: "feed", asOfMs: 1, files: 1, problems: [], market: null, ...over });

class FakeRes extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  out = "";
  ended = false;
  writeHead(code: number, h: Record<string, string>): this {
    this.status = code;
    this.headers = h;
    return this;
  }
  write(t: string): boolean {
    this.out += t;
    return true;
  }
  end(t?: string): void {
    if (t) this.out += t;
    this.ended = true;
  }
}
const fakeReq = (headers: Record<string, string> = {}) => Object.assign(new EventEmitter(), { headers }) as unknown as IncomingMessage;
/** The `changes` messages in a stream's text, parsed. */
const messages = (text: string): { id: string; data: StreamChanges }[] =>
  [...text.matchAll(/id: (\S+)\nevent: changes\ndata: (.*)\n\n/g)].map((m) => ({ id: m[1]!, data: JSON.parse(m[2]!) as StreamChanges }));

afterEach(() => vi.useRealTimers());

describe("the stream's changes (server)", () => {
  it("the first rebuild only records the start; then each kind of change is named, and only changed fields are sent", () => {
    const hub = new StreamHub();
    const res = new FakeRes();
    expect(hub.publishFirst([row("A"), row("B"), row("C"), row("D")], meta())).toBe(0);
    hub.attach(fakeReq(), res as unknown as ServerResponse, { boot: hub.boot, seq: 0 });
    const seq = hub.publishFirst([row("A", { priceUsd: 2 }), row("B", { score: 41, coverage: 0.6 }), row("C", { launchpad: "PumpSwap (graduated)" }), row("E")], meta({ asOfMs: 2 }));
    expect(seq).toBe(1);
    const [m] = messages(res.out);
    expect(m!.id).toBe(`${hub.boot}.1`);
    expect(m!.data).toMatchObject({
      seq: 1,
      seen: [row("E")],
      score: [{ address: "B", score: 41, coverage: 0.6 }],
      graduation: [{ address: "C", launchpad: "PumpSwap (graduated)" }],
      tick: [{ address: "A", priceUsd: 2 }],
      gone: ["d"],
      meta: { asOfMs: 2 },
    });
    // A rebuild with nothing changed sends nothing; a field that disappears is sent as null.
    hub.publishFirst([row("A", { priceUsd: 2 }), row("B", { score: 41, coverage: 0.6 }), row("C", { launchpad: "PumpSwap (graduated)" }), row("E")], meta({ asOfMs: 2 }));
    expect(messages(res.out).length).toBe(1);
    const { imageUrl: _drop, ...noImage } = row("E");
    void _drop;
    hub.publishFirst([row("A", { priceUsd: 2 }), row("B", { score: 41, coverage: 0.6 }), row("C", { launchpad: "PumpSwap (graduated)" }), noImage], meta({ asOfMs: 2 }));
    expect(messages(res.out)[1]!.data.tick).toEqual([{ address: "E", imageUrl: null }]);
  });

  it("the scored set: the first rebuild records, then changed and departed rows go out whole", () => {
    const hub = new StreamHub();
    const res = new FakeRes();
    hub.publishRest([row("R1"), row("R2")]);
    hub.attach(fakeReq(), res as unknown as ServerResponse, { boot: hub.boot, seq: 0 });
    hub.publishRest([row("R1", { score: 55 }), row("R3")]);
    expect(messages(res.out)[0]!.data).toMatchObject({ rest: [row("R1", { score: 55 }), row("R3")], restGone: ["r2"] });
  });

  it("a page gets what it missed, from its list's position or the browser's Last-Event-ID; too far behind, another boot or no position gets reset", () => {
    const hub = new StreamHub();
    hub.publishFirst([row("A")], meta());
    for (let i = 2; i <= 4; i++) hub.publishFirst([row("A", { priceUsd: i })], meta());
    const replay = new FakeRes();
    hub.attach(fakeReq(), replay as unknown as ServerResponse, { boot: hub.boot, seq: 1 });
    expect(replay.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(replay.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(replay.out.startsWith("retry: 5000\n\n")).toBe(true);
    expect(messages(replay.out).map((m) => m.data.seq)).toEqual([2, 3]);
    const url = new URL(`http://x/api/stream?boot=${hub.boot}&since=1`);
    expect(StreamHub.position(fakeReq({ "last-event-id": `${hub.boot}.2` }), url)).toEqual({ boot: hub.boot, seq: 2 });
    expect(StreamHub.position(fakeReq(), url)).toEqual({ boot: hub.boot, seq: 1 });
    expect(StreamHub.position(fakeReq(), new URL("http://x/api/stream?since=abc"))).toBeNull();
    for (const from of [null, { boot: "00000000", seq: 1 }, { boot: hub.boot, seq: 99 }]) {
      const r = new FakeRes();
      hub.attach(fakeReq(), r as unknown as ServerResponse, from);
      expect(r.out).toContain("event: reset\n");
      expect(messages(r.out)).toEqual([]);
    }
  });

  it("keeps the stream alive every 25 s, forgets a page that left, and refuses beyond its limit (the page then polls)", () => {
    vi.useFakeTimers();
    const hub = new StreamHub(1);
    hub.publishFirst([row("A")], meta());
    const req = fakeReq();
    const res = new FakeRes();
    hub.attach(req, res as unknown as ServerResponse, { boot: hub.boot, seq: 0 });
    vi.advanceTimersByTime(25_000);
    expect(res.out).toContain(": ping\n\n");
    const full = new FakeRes();
    hub.attach(fakeReq(), full as unknown as ServerResponse, { boot: hub.boot, seq: 0 });
    expect(full.status).toBe(503);
    req.emit("close");
    expect(hub.size).toBe(0);
  });
});

describe("the page's copy of the list (client)", () => {
  it("read once, then every change applied, ends equal to the server's own list", () => {
    const hub = new StreamHub();
    const res = new FakeRes();
    const before = [row("A"), row("B", { imageUrl: "/api/img?a=B" }), row("C")];
    const after = [row("A", { priceUsd: 3, priceSeries: [1, 2, 3] }), row("B", { score: 70, coverage: 0.8 }), row("D")];
    const at = hub.publishFirst(before, meta());
    const copy = new ListCopy();
    copy.load({ ...meta(), tokens: before, stream: { boot: hub.boot, seq: at } } as never);
    hub.attach(fakeReq(), res as unknown as ServerResponse, copy.pos);
    hub.publishFirst(after, meta({ asOfMs: 9 }));
    for (const m of messages(res.out)) expect(copy.apply(m.data)).toEqual({ rest: [], restGone: [] });
    expect(copy.snapshot()!.tokens.sort((a, b) => a.address.localeCompare(b.address))).toEqual(after);
    expect(copy.snapshot()!.asOfMs).toBe(9);
  });

  it("an old change is ignored; a skipped number or another boot asks for the lists again", () => {
    const copy = new ListCopy();
    copy.load({ ...meta(), tokens: [row("A")], stream: { boot: "aaaaaaaa", seq: 5 } } as never);
    const c = (seq: number, boot = "aaaaaaaa"): StreamChanges => ({ boot, seq, seen: [], score: [], graduation: [], tick: [{ address: "A", priceUsd: seq }], gone: [], rest: [], restGone: [] });
    expect(copy.apply(c(5))).toBeNull();
    expect(copy.apply(c(7))).toBe("reset");
    expect(copy.apply(c(6, "bbbbbbbb"))).toBe("reset");
    expect(copy.apply(c(6))).toEqual({ rest: [], restGone: [] });
    expect(copy.snapshot()!.tokens[0]!.priceUsd).toBe(6);
  });
});
