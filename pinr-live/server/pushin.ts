import { createServer, type Server } from "node:http";

/**
 * the engine's trade feed hands each trade to the feed server the moment it hears it, with no file
 * and no timer (the engine's half: builder/push). `POST /internal/ticks` with `{"contract": "ticks-1", "mint", "ticks": [tick, ...]}`, each tick in the tick
 * file's own shape; answered 204 at once. It listens on its own port, bound to 127.0.0.1 only: the Cloudflare tunnel forwards the public site to the
 * feed's own port from localhost, so a "localhost only" check there could not tell a visitor from the engine; this port is never forwarded.
 */
export const PUSH_PORT = 8792;
export const MAX_BODY = 256 * 1024;
export const MAX_TICKS = 500;

export type TicksIn = (mint: string, ticks: unknown[]) => void;

/** The body's checks: the contract, a mint string, a list of at most MAX_TICKS ticks. The ticks themselves are checked by the tick parser. */
export function readPush(body: string): { mint: string; ticks: unknown[] } | null {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof j !== "object" || j === null) return null;
  const o = j as Record<string, unknown>;
  if (o.contract !== "ticks-1" || typeof o.mint !== "string" || !Array.isArray(o.ticks) || o.ticks.length > MAX_TICKS) return null;
  return { mint: o.mint, ticks: o.ticks };
}

export function startPushIn(onTicks: TicksIn, port = PUSH_PORT): Server {
  const stat = { calls: 0, refused: 0 };
  const srv = createServer((req, res) => {
    const end = (code: number): void => void res.writeHead(code).end();
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/internal/ticks") return end(404);
    let size = 0;
    const parts: Buffer[] = [];
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) over = true; // the rest is read and dropped, then refused with 413
      else parts.push(c);
    });
    req.on("end", () => {
      if (over) return end(413);
      const got = readPush(Buffer.concat(parts).toString("utf8"));
      if (!got) return (stat.refused++, end(400));
      stat.calls++;
      end(204); // answered first: the engine never waits on the stream
      onTicks(got.mint, got.ticks);
    });
    req.on("error", () => undefined);
  });
  (srv as Server & { stat?: typeof stat }).stat = stat;
  srv.on("error", (e) => console.log(`push: not listening (${(e as Error).message})`));
  srv.listen(port, "127.0.0.1");
  return srv;
}
