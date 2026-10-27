package io.pinr.app.feed

import kotlin.math.abs

/** The Discover tabs, as on the site (pinr-live/src/world/discoverlist.ts). */
enum class DiscoverTab(val label: String, val hint: String) {
    Trending("Trending", "Most active right now"),
    Movers("Top Movers", "Largest 24h moves"),
    Fresh("Fresh Launches", "Under an hour old"),
    PinrScore("PINRscore", "Scored tokens, by PINRscore"),
    BaseBnb("Base/BNB", "Base and BNB Chain coins, newest first"),
}

object DiscoverRanking {
    /** Rows the list shows (DISCOVER_ROWS). */
    const val ROWS = 30
    /** An address is searched only from this many characters on. */
    const val ADDRESS_QUERY_MIN = 6

    /** The rows for a tab, or for a search: a search looks through every coin and ranks the biggest first (rankDiscover). */
    fun rank(tab: DiscoverTab, tokens: List<Token>, query: String = "", nowMs: Long = System.currentTimeMillis()): List<Token> {
        val q = query.jsTrim().lowercase().removePrefix("$")
        if (q.isNotEmpty()) {
            val w = Ranking.baseWeights(tokens)
            return tokens.indices.filter { matches(tokens[it], q) }
                .sortedWith(compareByDescending<Int> { w[it] }.thenBy { it })
                .take(ROWS).map { tokens[it] }
        }
        return when (tab) {
            // A coin with no price change ranks below every coin that has one: missing is not zero, and not a move.
            DiscoverTab.Movers -> tokens.indices.sortedWith { a, b ->
                val x = tokens[a].change24hPct?.let(::abs)
                val y = tokens[b].change24hPct?.let(::abs)
                when {
                    x != null && y != null && x != y -> y.compareTo(x)
                    x == null && y != null -> 1
                    x != null && y == null -> -1
                    else -> a.compareTo(b)
                }
            }.take(ROWS).map { tokens[it] }
            DiscoverTab.Trending -> Ranking.rank(PinrFilter.Trending, tokens, nowMs = nowMs, limit = ROWS)
            DiscoverTab.Fresh -> Ranking.rank(PinrFilter.New, tokens, nowMs = nowMs, limit = ROWS)
            DiscoverTab.PinrScore -> Ranking.rank(PinrFilter.PinrScore, tokens, nowMs = nowMs, limit = ROWS)
            DiscoverTab.BaseBnb -> baseBnb(tokens)
        }
    }

    /**
     * Base and BNB Chain coins, newest first (the time PINR first met the coin, else its launch; a coin with neither goes last),
     * ties in the feed's order. The server has already left out quiet coins and copies (within one chain); the caller applies the person's hides.
     */
    fun baseBnb(tokens: List<Token>): List<Token> {
        val chains = setOf("base", "bsc")
        val rows = tokens.indices.filter { tokens[it].chain?.lowercase() in chains }
        return rows.sortedWith { a, b ->
            val x = tokens[a].seenAtMs ?: tokens[a].launchedAtMs
            val y = tokens[b].seenAtMs ?: tokens[b].launchedAtMs
            when {
                x != null && y != null && x != y -> y.compareTo(x)
                x == null && y != null -> 1
                x != null && y == null -> -1
                else -> a.compareTo(b)
            }
        }.take(ROWS).map { tokens[it] }
    }

    fun matches(t: Token, q: String): Boolean =
        t.name?.lowercase()?.contains(q) == true || t.ticker?.lowercase()?.contains(q) == true ||
            (q.length >= ADDRESS_QUERY_MIN && t.address.lowercase().contains(q))
}

/** The lite chart's line: the feed's last-day price series, on a log scale when it spans a lot (the site's rule). */
data class LiteChart(val points: List<Double>, val logScale: Boolean, val rising: Boolean, val label: String?) {
    companion object {
        fun of(t: Token): LiteChart? {
            if (t.label == NoScoreLabel.Vamp) return null
            val s = t.priceSeries?.takeIf { it.size >= 2 } ?: return null
            val lo = s.min(); val hi = s.max()
            return LiteChart(s, lo > 0 && hi / lo > 6, s.last() >= s.first(), t.priceSource?.let { if (it.startsWith("PINR")) "$it · tracked" else "1h · $it" })
        }
    }
}
