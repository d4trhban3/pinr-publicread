package io.pinr.app.feed

/**
 * a trade the stream brings is folded into the coin's tile at once, as the site does
 * (`world/livefeed.ts`): its price becomes the trade's price, its market cap is scaled by newPrice / oldPrice (supply is fixed; a coin with no
 * cap keeps none), its line and ribbon take the trade. The figures a slower list message brings do not undo it for a minute.
 */
object LiveFold {
    /** How long a trade's price is kept over a list price that is older than it. */
    const val HOLD_MS = 60_000L
}

/** This coin at [price]: the price, the market cap scaled by the move (only when both an old price and a cap are known), and the line's newest point. */
fun Token.repricedTo(price: Double): Token {
    if (!(price > 0) || !price.isFinite()) return this
    val old = priceUsd
    val cap = valuationUsd
    return copy(
        valuationUsd = if (old != null && old > 0 && cap != null && cap >= 0) cap * price / old else cap,
        priceUsd = price,
        priceSeries = priceSeries?.let { LiveCandle.head(it, price) },
    )
}

/**
 * This coin after one trade: repriced, the ribbon's figures and trade counts taking it (dollars, or a count where the feed gave counts), and the time
 * of its last trade. A price alone (no dollars, no side) only reprices.
 */
fun Token.foldedTrade(trade: LiveTick): Token {
    // As the site (livefeed.ts): only a trade at least as new as the coin's last one sets the price and the time; an older one still counts in the ribbon.
    val last = lastTradeMs
    val newest = last == null || trade.atMs >= last
    val withTime = if (newest) repricedTo(trade.price).copy(lastTradeMs = trade.atMs) else this
    val f = flow
    val buy = trade.isBuy
    if (f == null || buy == null) return withTime
    val amount = if (f.isCount) 1.0 else trade.usd?.takeIf { it > 0 && it.isFinite() } ?: 0.0
    return withTime.copy(
        flow = f.copy(
            buy5m = f.buy5m + if (buy) amount else 0.0, sell5m = f.sell5m + if (buy) 0.0 else amount,
            buy1h = f.buy1h + if (buy) amount else 0.0, sell1h = f.sell1h + if (buy) 0.0 else amount,
            trades5m = f.trades5m + 1, trades1h = f.trades1h + 1,
        ),
    )
}
