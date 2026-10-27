package io.pinr.app.feed

/**
 * The terminal's watchlist (the star) and price alerts (the bell), kept on this device only, as on the site
 * (pinr-live/src/world/watchlist.ts) and the iPhone app. A coin is known by its address. Alerts are checked while PINR is open.
 */
data class PriceAlert(val id: String, val key: String, val ticker: String, val level: Double, val dir: String, val created: Long)

object Watch {
    const val MAX_WATCH = 100
    const val MAX_ALERTS = 50

    /** Which way an alert at [level] points from the price now; null when it cannot be said or the price is already there. */
    fun alertDir(level: Double, current: Double?): String? {
        if (!level.isFinite() || level <= 0 || current == null || !current.isFinite() || current <= 0 || level == current) return null
        return if (level > current) "up" else "down"
    }

    fun toggle(list: List<String>, key: String): List<String> {
        if (key.isEmpty()) return list
        return if (key in list) list - key else (listOf(key) + list).take(MAX_WATCH)
    }

    fun add(alerts: List<PriceAlert>, a: PriceAlert): List<PriceAlert> =
        (listOf(a) + alerts.filterNot { it.key == a.key && it.level == a.level && it.dir == a.dir }).take(MAX_ALERTS)

    /** Every alert against the prices now; a coin with no price fires nothing (a missing price is never a move). */
    fun check(alerts: List<PriceAlert>, price: (String) -> Double?): Pair<List<PriceAlert>, List<PriceAlert>> {
        val (fired, waiting) = alerts.partition { a ->
            val p = price(a.key)
            p != null && p.isFinite() && p > 0 && (if (a.dir == "up") p >= a.level else p <= a.level)
        }
        return fired to waiting
    }

    /** "Alert: $STREAM rose to $0.002000 (+1 more)" (the site's toast). */
    fun toast(fired: List<PriceAlert>): String? {
        val a = fired.firstOrNull() ?: return null
        return "Alert: ${a.ticker} ${if (a.dir == "up") "rose to" else "fell to"} ${Format.price(a.level)}" + if (fired.size > 1) " (+${fired.size - 1} more)" else ""
    }
}
