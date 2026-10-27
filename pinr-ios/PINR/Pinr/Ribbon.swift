import Foundation

/// A tile's ribbon: trade streaks, lime for buys and mandarin for sells, in the real mix
/// (pinr-live/src/world/livefeed.ts and flow.ts). No trades in the last hour: no ribbon.
struct Ribbon: Equatable, Sendable {
    /// Share of buys, 0...1.
    let buyShare: Double
    /// How fast the streaks travel, in ribbon lengths a second: calm coins drift, busy ones rush.
    let speed: Double
    /// True when the mix is counted in trades, not dollars (drawn faint).
    let isCount: Bool

    /// Below this many trades a mix means little, so the streaks show an even mix (they still show it trades).
    static let minTrades = 3

    init?(_ flow: Token.Flow?) {
        guard let f = flow, f.trades1h > 0 else { return nil }
        func share(_ b: Double, _ s: Double) -> Double { b + s > 0 ? b / (b + s) : 0.5 }
        let hour = f.trades1h >= Self.minTrades ? share(f.buy1h, f.sell1h) : 0.5
        buyShare = f.trades5m >= Self.minTrades ? share(f.buy5m, f.sell5m) : hour
        let busy = f.trades5m > 0 ? min(1, log10(1 + Double(f.trades5m)) / 2.5) : 0
        speed = 0.05 + 0.35 * busy
        isCount = f.isCount
    }

    /// Streaks on one ribbon length (fixed, so a faster ribbon never looks thicker).
    static let streaks = 12

    /// Where streak `i` is at time `t` (0 = oldest edge, 1 = now) and whether it is a buy.
    func streak(_ i: Int, at t: Double) -> (u: Double, buy: Bool) {
        let seed = Self.hash(i)
        let u = (seed + t * speed).truncatingRemainder(dividingBy: 1)
        return (u, Self.hash(i + 7919) < buyShare)
    }

    /// Each streak's height in the band (0 top, 1 bottom) and its size (0 small, 1 big): fixed per streak.
    static func lane(_ i: Int) -> (y: Double, size: Double) { (hash(i + 104_729), hash(i + 1_299_709)) }

    /// How far a trade of this size (0...1) rides from the line, in tile heights: up (negative) for a buy, down for a sell; near "now" (u = 1) it swoops further.
    static let sizeRange = 0.17, swoop = 0.6
    static func sizeOffset(_ size: Double, buy: Bool, u: Double) -> Double {
        let s = min(1, max(0, size))
        let tail = u > 0.82 ? swoop * pow((u - 0.82) / 0.18, 2) : 0
        return (buy ? -1 : 1) * s * sizeRange * (1 + tail)
    }

    /// A fixed spread in 0..<1 for each streak, the same on every frame.
    private static func hash(_ i: Int) -> Double {
        let x = sin(Double(i) * 12.9898 + 78.233) * 43758.5453
        return x - x.rounded(.down)
    }
}
