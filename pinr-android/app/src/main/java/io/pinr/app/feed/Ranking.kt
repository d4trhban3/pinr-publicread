package io.pinr.app.feed

import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * The PINR page's filters, as on the site (pinr-live/src/world/filters.ts) and the iPhone app. A filter chooses which
 * tiles show and ranks them, best first; the page shows the top of that ranking.
 */
enum class PinrFilter(val label: String, val hint: String) {
    Trending("Trending", "Most active right now"),
    Movers("Movers", "Biggest score swings"),
    New("New Launches", "Under an hour old"),
    PinrScore("PINRscore", "Real, scored projects by score"),
}

object Ranking {
    /** How many tiles the page shows (the site's base). */
    const val PAGE_SIZE = 90
    /** A launch younger than this is a New Launch. */
    const val NEW_LAUNCH_MINUTES = 60.0
    /** Seconds for the "just traded" boost to halve. */
    const val RECENT_HALF_LIFE = 90.0

    /**
     * the design's featured rule, as the site's: coins whose launchpad holds "pump" (Pump.fun, PumpSwap) come first, ranked by the filter's own
     * order; coins of other launchpads fill the room left. Used by the PINR page's re-rank only.
     */
    fun rankFeatured(
        filter: PinrFilter, tokens: List<Token>, moved: Map<String, Int> = emptyMap(),
        nowMs: Long = System.currentTimeMillis(), limit: Int = PAGE_SIZE,
    ): List<Token> {
        val isPump = { t: Token -> t.launchpad?.lowercase()?.contains("pump") == true }
        val first = rank(filter, tokens.filter(isPump), moved, nowMs, limit)
        if (first.size >= limit) return first
        return first + rank(filter, tokens.filterNot(isPump), moved, nowMs, limit - first.size)
    }

    /**
     * The top [limit] of a filter's ranking. The token list's own order (the feed's) breaks ties; [moved] is each
     * token's score change since the app opened (for Movers).
     */
    fun rank(
        filter: PinrFilter, tokens: List<Token>, moved: Map<String, Int> = emptyMap(),
        nowMs: Long = System.currentTimeMillis(), limit: Int = PAGE_SIZE,
    ): List<Token> {
        val weights = baseWeights(tokens)
        val rows = tokens.indices.toList()
        // Highest first (or lowest, ascending); a missing measure goes last; ties keep the feed's order.
        fun sorted(sub: List<Int>, ascending: Boolean = false, measure: (Int) -> Double?): List<Token> =
            sub.map { it to measure(it) }.sortedWith { a, b ->
                val x = a.second
                val y = b.second
                when {
                    x != null && y != null && x != y -> if (ascending) x.compareTo(y) else y.compareTo(x)
                    x == null && y != null -> 1
                    x != null && y == null -> -1
                    else -> a.first.compareTo(b.first)
                }
            }.map { tokens[it.first] }

        return when (filter) {
            PinrFilter.PinrScore -> sorted(rows.filter { scoreOf(tokens[it]) != null }) { scoreOf(tokens[it])?.toDouble() }
            PinrFilter.New -> sorted(rows.filter { (ageMinutes(tokens[it], nowMs) ?: Double.MAX_VALUE) < NEW_LAUNCH_MINUTES }, ascending = true) {
                ageMinutes(tokens[it], nowMs)
            }
            PinrFilter.Movers -> sorted(rows) { abs(moved[tokens[it].id] ?: 0).toDouble() }
            PinrFilter.Trending -> {
                // The tile page's own order: coins scored in the last 24 hours first, newest-scored first (ties in the
                // feed's order); then unscored coins first met in the last 24 hours, newest first; then the rest by what is moving.
                val at = { i: Int -> recentAt(tokens[i], nowMs) }
                fun newest(pick: (Int) -> Boolean) = rows.filter { pick(it) && at(it) != null }
                    .sortedWith(compareByDescending<Int> { at(it)!! }.thenBy { it })
                val recent = newest { scoreOf(tokens[it]) != null } + newest { scoreOf(tokens[it]) == null }
                recent.map { tokens[it] } + sorted(rows.filter { at(it) == null }) { trendScore(tokens[it], weights[it], nowMs) }
            }
        }.take(limit)
    }

    /** How long a coin counts as just seen or just scored (the site's `RECENT_MS`, the team's ruling on a design decision). */
    const val RECENT_MS = 24 * 3600_000L

    /**
     * When a coin counts from, if that was within the last 24 hours and not in the future: a scored coin from when it was last scored, an
     * unscored one from when PINR first met it, else from its launch (never from its `as_of`, which a "technical error, retrying" coin
     * moves on every retry). The site's `firstPageKey` input.
     */
    fun recentAt(t: Token, nowMs: Long): Long? =
        (if (scoreOf(t) != null) t.asOfMs else (t.seenAtMs ?: t.launchedAtMs))?.takeIf { nowMs - it <= RECENT_MS && it <= nowMs + 60_000 }

    /** The PINRscore as a number, or null (unscored, flagged, nothing loaded): never zero. */
    fun scoreOf(t: Token): Int? = if (t.label == null && t.coverage > 0) t.score else null

    /** True when PINR has read the token: a score, a label, or some coverage. */
    fun isRead(t: Token): Boolean = t.score != null || t.label != null || t.coverage > 0

    fun ageMinutes(t: Token, nowMs: Long): Double? = t.launchedAtMs?.let { max(0.0, (nowMs - it) / 60_000.0) }

    /** Long-term weight from market cap, on a log scale across the set: 0.2 to 0.74; 0.12 when unknown (the site's `importances`). */
    fun baseWeights(tokens: List<Token>): List<Double> {
        val logs = tokens.map { t -> t.valuationUsd?.takeIf { it > 0 }?.let(::log10) }
        val known = logs.filterNotNull()
        val lo = known.minOrNull() ?: return logs.map { 0.12 }
        val hi = known.max()
        return logs.map { l -> l?.let { 0.2 + 0.54 * (if (hi > lo) (it - lo) / (hi - lo) else 0.5) } ?: 0.12 }
    }

    /** What is happening now (the site's `trendScore`): busy and just-traded count most; size breaks ties. */
    fun trendScore(t: Token, base: Double, nowMs: Long): Double {
        val recent = t.lastTradeMs?.let { 0.6 * 0.5.pow(max(0.0, (nowMs - it) / 1000.0) / RECENT_HALF_LIFE) } ?: 0.0
        val busy = t.flow?.let { if (it.trades5m > 0) min(1.0, log10(1.0 + it.trades5m) / 2.5) else 0.0 } ?: 0.0
        return 0.4 * base + recent + 0.9 * busy
    }
}
