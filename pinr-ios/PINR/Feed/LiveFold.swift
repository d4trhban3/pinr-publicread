import Foundation

/// a trade the stream brings is folded into the coin's tile at once, as the site does
/// (`world/livefeed.ts`): its price becomes the trade's price, its market cap is scaled by newPrice / oldPrice (supply is fixed; a coin with
/// no cap keeps none), its line and ribbon take the trade. The figures a slower list message brings do not undo it for a minute.
enum LiveFold {
    /// How long a trade's price is kept over a list price that is older than it.
    static let holdSeconds: TimeInterval = 60
}

extension Token {
    /// This coin at `price`: the price, the market cap scaled by the move (only when both an old price and a cap are known), and the line's newest point.
    func repriced(to price: Double) -> Token {
        guard price > 0, price.isFinite else { return self }
        var t = self
        if let old = priceUsd, old > 0, let cap = valuationUsd, cap >= 0 { t.valuationUsd = cap * price / old }
        t.priceUsd = price
        t.priceSeries = priceSeries.map { LiveCandle.head($0, price: price) }
        return t
    }

    /// This coin after one trade: repriced, the ribbon's figures and trade counts taking it (dollars, or a count where the feed gave counts),
    /// and the time of its last trade.
    func folded(_ trade: LiveTick) -> Token {
        // As the site (livefeed.ts): only a trade at least as new as the coin's last one sets the price and the time; an older one still counts in the ribbon.
        let newest = lastTrade.map { trade.at >= $0 } ?? true
        var t = newest ? repriced(to: trade.price) : self
        if newest { t.lastTrade = trade.at }
        if let f = flow, let buy = trade.isBuy {
            let amount = f.isCount ? 1 : (trade.usd.flatMap { $0 > 0 && $0.isFinite ? $0 : nil } ?? 0)
            t.flow = Flow(buy5m: f.buy5m + (buy ? amount : 0), sell5m: f.sell5m + (buy ? 0 : amount),
                          buy1h: f.buy1h + (buy ? amount : 0), sell1h: f.sell1h + (buy ? 0 : amount),
                          trades5m: f.trades5m + 1, trades1h: f.trades1h + 1, isCount: f.isCount, complete: f.complete)
        }
        return t
    }
}
