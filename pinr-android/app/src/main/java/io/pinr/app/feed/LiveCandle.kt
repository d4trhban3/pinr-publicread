package io.pinr.app.feed

/**
 * Live charts (a design decision, the site's `livecandle.ts`): the chart moves between reads, from what the change stream brings.
 * One price is folded into the candle of its time: the newest
 * candle's high, low and close move, or a new candle opens at the last close. A price tick carries no traded amount, so it adds
 * no volume; a trade adds its own. A chart is only extended from price ticks alone, never started; a trade may start one.
 */
object LiveCandle {
    fun seconds(tf: Timeframe): Long = when (tf) {
        Timeframe.M1 -> 60L
        Timeframe.M5 -> 300L
        Timeframe.M15 -> 900L
        Timeframe.H1 -> 3600L
        Timeframe.H4 -> 14400L
        Timeframe.D1 -> 86400L
    }

    /**
     * The candles with the price folded in, or null when nothing changes (a price that is not a number, a time older than the
     * newest candle, a chart that is not current, or a chart with no candle yet that may not be started).
     */
    fun fold(set: CandleSet, tf: Timeframe, price: Double, atMs: Long, usd: Double? = null, start: Boolean = false): CandleSet? {
        if (set.status != CandleSet.Status.Ok || !(price > 0) || !price.isFinite()) return null
        // The size the feed gave (a young curve coin's finest candles), else the one asked.
        val step = set.bucketSec ?: seconds(tf)
        val amount = usd?.takeIf { it > 0 && it.isFinite() } ?: 0.0
        val slot = Math.floorDiv(atMs / 1000, step) * step
        val last = set.candles.lastOrNull()
        if (last == null) {
            if (!start) return null
            return set.copy(candles = listOf(Candle(slot, price, price, price, price, amount)))
        }
        if (slot < last.t) return null
        val next = if (slot == last.t) {
            set.candles.dropLast(1) + Candle(last.t, last.open, maxOf(last.high, price), minOf(last.low, price), price, last.volume + amount)
        } else {
            set.candles + Candle(slot, last.close, maxOf(last.close, price), minOf(last.close, price), price, amount)
        }
        return set.copy(candles = next)
    }

    /** A tracked line with the live price as its newest point: only on a line that already has two points, and only when the price moved. */
    fun head(series: List<Double>, price: Double?): List<Double> {
        if (series.size < 2 || price == null || !(price > 0) || !price.isFinite() || series.last() == price) return series
        return (series + price).takeLast(500)
    }

    /**
     * What a chart does when the stream has spoken: every price or trade the stream brought for this coin since the chart last
     * looked (the site's `onPrice`), folded into the newest candle. A price alone has no volume and never starts a chart; a trade
     * adds its dollars and may. [seen] is the store's tick count at the chart's last look (negative at first, so a chart does not
     * take in what came before it opened); returns the new count and the new set (null: unchanged). A coin whose own price did
     * not arrive changes nothing: a quiet minute grows no candles.
     */
    fun advance(set: CandleSet, tf: Timeframe, id: String, store: FeedStore, seen: Int): Pair<Int, CandleSet?> {
        var out = set
        var changed = false
        val ticks = store.recentTicks
        val count = store.tickCount
        val fresh = if (seen < 0) 0 else minOf(count - seen, ticks.size)
        if (fresh > 0) for (t in ticks.takeLast(fresh)) if (t.address == id) {
            fold(out, tf, t.price, t.atMs, t.usd, start = t.usd != null)?.let { out = it; changed = true }
        }
        return count to (if (changed) out else null)
    }
}

/** One price the change stream brought for a coin: a price tick ([usd] null) or one of a curve coin's own trades. */
data class LiveTick(val address: String, val atMs: Long, val price: Double, val usd: Double?, val isBuy: Boolean? = null)
