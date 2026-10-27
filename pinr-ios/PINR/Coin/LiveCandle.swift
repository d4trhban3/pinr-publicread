import Foundation

/// Live charts (a design decision, the site's `livecandle.ts`): the chart moves between reads, from what the change stream brings.
/// One price is folded into the candle of its time: the newest
/// candle's high, low and close move, or a new candle opens at the last close. A price tick carries no traded amount, so it
/// adds no volume; a trade adds its own. A chart is only extended from price ticks alone, never started; a trade may start one.
enum LiveCandle {
    static func seconds(_ tf: Timeframe) -> Double {
        switch tf {
        case .m1: 60
        case .m5: 300
        case .m15: 900
        case .h1: 3600
        case .h4: 14400
        case .d1: 86400
        }
    }

    /// The candles with the price folded in, or nil when nothing changes (a price that is not a number, a time older than the
    /// newest candle, a chart that is not current, or a chart that has no candle yet and may not be started).
    static func fold(_ set: CandleSet, _ tf: Timeframe, price: Double, at: Date, usd: Double? = nil, start: Bool = false) -> CandleSet? {
        guard set.status == .ok, price > 0, price.isFinite else { return nil }
        // The size the feed gave (a young curve coin's finest candles), else the one asked.
        let step = set.bucketSec ?? seconds(tf)
        let amount = (usd.map { $0 > 0 && $0.isFinite ? $0 : 0 }) ?? 0
        let slot = Date(timeIntervalSince1970: (at.timeIntervalSince1970 / step).rounded(.down) * step)
        var candles = set.candles
        guard let last = candles.last else {
            guard start else { return nil }
            candles.append(Candle(time: slot, open: price, high: price, low: price, close: price, volume: amount))
            return CandleSet(candles: candles, source: set.source, status: set.status, asOf: set.asOf, bucketSec: set.bucketSec)
        }
        if slot < last.time { return nil }
        if slot == last.time {
            candles[candles.count - 1] = Candle(time: last.time, open: last.open, high: max(last.high, price), low: min(last.low, price),
                                                close: price, volume: last.volume + amount)
        } else {
            let open = last.close
            candles.append(Candle(time: slot, open: open, high: max(open, price), low: min(open, price), close: price, volume: amount))
        }
        return CandleSet(candles: candles, source: set.source, status: set.status, asOf: set.asOf, bucketSec: set.bucketSec)
    }

    /// A tracked line with the live price as its newest point: only on a line that already has two points, and only when the price moved.
    static func head(_ series: [Double], price: Double?) -> [Double] {
        guard series.count >= 2, let price, price > 0, price.isFinite, series[series.count - 1] != price else { return series }
        return Array((series + [price]).suffix(500))
    }

    /// What a chart does when the stream has spoken: every price or trade the stream brought for this coin since the chart last
    /// looked (the site's `onPrice`), folded into the newest candle. A price alone has no volume and never starts a chart; a trade
    /// adds its dollars and may. `seen` is how many the chart has taken in (the store's `tickCount` at its last look; negative at
    /// first, so a chart does not take in what came before it opened). A coin whose own price did not arrive changes nothing: a
    /// quiet minute grows no candles. Nil when nothing changed.
    @MainActor static func advance(_ set: CandleSet, _ tf: Timeframe, id: String, store: FeedStore, seen: inout Int) -> CandleSet? {
        var out = set
        var changed = false
        let fresh = seen < 0 ? 0 : min(store.tickCount - seen, store.recentTicks.count)
        seen = store.tickCount
        if fresh > 0 {
            for t in store.recentTicks.suffix(fresh) where t.address == id {
                if let next = fold(out, tf, price: t.price, at: t.at, usd: t.usd, start: t.usd != nil) { out = next; changed = true }
            }
        }
        return changed ? out : nil
    }
}

/// One price the change stream brought for a coin: a price tick (`usd` nil) or, for a curve coin, one of its own trades
///  with its size in dollars.
struct LiveTick: Equatable, Sendable {
    let address: String
    let at: Date
    let price: Double
    let usd: Double?
    /// True for a buy, false for a sell, nil when the message did not say (a price alone).
    var isBuy: Bool? = nil
}
