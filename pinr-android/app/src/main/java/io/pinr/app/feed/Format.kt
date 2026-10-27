package io.pinr.app.feed

import java.math.BigDecimal
import java.math.RoundingMode
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** How figures read on screen, as on the site and the iPhone app. Missing is always a dash, never a zero. */
object Format {
    /** "as of 2:32 PM": when a figure that is not current was read (the site's formatAsOf, en-US, the phone's clock). */
    fun asOf(ms: Long, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String =
        "as of " + java.time.format.DateTimeFormatter.ofPattern("h:mm a", Locale.US).withZone(zone).format(java.time.Instant.ofEpochMilli(ms))

    const val DASH = "—"

    /** "$376.11M", "$1.20K", "$950"; a dash when missing. */
    fun usdCompact(v: Double?): String {
        if (v == null || !v.isFinite() || v < 0) return DASH
        val units = listOf(1e12 to "T", 1e9 to "B", 1e6 to "M", 1e3 to "K")
        for ((size, suffix) in units) {
            if (v >= size * 0.999995) return "$" + fixed(v / size, 2) + suffix // so $999,999 reads $1.00M, not $1000.00K
        }
        return "$" + fixed(v, if (v < 10) 2 else 0)
    }

    /**
     * Money on a tile (MC, ATH), exactly the site's `money()` (pinr-live/src/world/discoverlist.ts): B and M with two
     * decimals, K with one, under $1,000 rounded to whole dollars; zero, below zero or missing is a dash.
     */
    /** A count of trades, short: 87, 1,240, 12.4K, 1.2M (the site's `countShort`). */
    fun countShort(n: Int): String {
        val v = n.toDouble()
        return when {
            v < 10_000 -> String.format(java.util.Locale.US, "%,d", n)
            v < 1_000_000 -> String.format(java.util.Locale.US, if (v < 100_000) "%.1fK" else "%.0fK", v / 1000)
            else -> String.format(java.util.Locale.US, "%.1fM", v / 1_000_000)
        }
    }

    /** the hour's trades beside the market cap on a tile: "20 tx/1h", or "— tx" when no source counts them (missing stays missing). */
    fun tilePlusTrades(mc: String, flow: Token.Flow?, hour: Int? = null): String =
        // The engine's own hourly count first, then the feed's.
        "$mc · " + ((hour ?: flow?.trades1h)?.let { "${countShort(it)} tx/1h" } ?: "— tx")

    fun money(v: Double?): String {
        if (v == null || !v.isFinite() || v <= 0) return DASH
        return when {
            v >= 1e9 -> "$" + fixed(v / 1e9, 2) + "B"
            v >= 1e6 -> "$" + fixed(v / 1e6, 2) + "M"
            v >= 1e3 -> "$" + fixed(v / 1e3, 1) + "K"
            v < 0.01 -> "<$0.01" // a small real amount is never "$0" (checklist 7)
            v < 1 -> "$" + fixed(v, 2)
            else -> "$" + Math.round(v)
        }
    }

    /**
     * The score and coverage corner of a tile, as the site's (cards.ts with model.ts `statusLook`): a flagged coin shows
     * its label over "no data"; a coin with nothing read (coverage 0) or no score number shows a dash; the coverage
     * figure is a dash at 0, and its word is "unscored" then.
     */
    data class Corner(val score: String, val numeric: Boolean, val flagged: Boolean, val coverage: String, val word: String)

    fun corner(t: Token): Corner {
        val cov = if (t.coverage > 0) coverage(t.coverage) else DASH
        val label = t.label
        if (label != null) return Corner(label.text, numeric = false, flagged = true, coverage = cov, word = "no data")
        val word = if (t.coverage > 0) "coverage" else "unscored"
        val s = t.score
        return if (t.coverage <= 0 || s == null) Corner(DASH, false, false, cov, word) else Corner(s.toString(), true, false, cov, word)
    }

    /**
     * The site's formatPrice (world/format.ts): two decimals from a dollar up (thousands commas past 1,000), three
     * significant digits below a dollar ("$0.000457", "$0.0345", "$0.500"); a dash when missing.
     */
    fun price(v: Double?): String {
        if (v == null || !v.isFinite() || v <= 0) return DASH
        if (v >= 1000) return "$" + String.format(Locale.US, "%,.2f", BigDecimal(v).setScale(2, RoundingMode.HALF_UP))
        val decimals = minOf(14, maxOf(2, 2 - Math.floor(Math.log10(v)).toInt()))
        return "$" + fixed(v, if (v >= 1) 2 else decimals)
    }

    /** The site's formatPriceCompact: under $0.0001 the count of zeros after the point as a subscript ("$0.0₄495"). */
    fun priceCompact(v: Double?): String {
        if (v == null || !v.isFinite() || v <= 0) return DASH
        if (v >= 0.0001) return price(v)
        val zeros = -Math.floor(Math.log10(v)).toInt() - 1
        val digits = Math.round(v * Math.pow(10.0, (zeros + 3).toDouble())).toString().padStart(3, '0').take(3)
        val sub = zeros.toString().map { "₀₁₂₃₄₅₆₇₈₉"[it - '0'] }.joinToString("")
        return "$0.0$sub$digits"
    }

    /** The site's formatPriceChange: "+$0.00000012", "−$1.20". */
    fun priceChange(d: Double?): String {
        if (d == null || !d.isFinite()) return DASH
        val a = price(Math.abs(d))
        return (if (d < 0) "−" else "+") + (if (a == DASH) "$0.00" else a)
    }

    /** The trades list's dollars (tradeslist.ts `money2`): money() from $1,000, else the compact price. */
    fun money2(v: Double): String = if (v >= 1000) money(v) else priceCompact(v)

    /** The site's ageText: "41m", "3h", "2d"; a dash when missing. */
    fun ageText(minutes: Double?): String {
        if (minutes == null || !minutes.isFinite()) return DASH
        return when {
            minutes < 60 -> "${maxOf(1L, Math.round(minutes))}m"
            minutes < 60 * 48 -> "${Math.round(minutes / 60)}h"
            else -> "${Math.round(minutes / 1440)}d"
        }
    }

    /** The site's scoredAgo: "just now", "41 min ago", "5 h ago", "2 days ago"; null when missing. */
    fun scoredAgo(atMs: Long?, nowMs: Long = System.currentTimeMillis()): String? {
        if (atMs == null || atMs <= 0) return null
        val min = maxOf(0L, (nowMs - atMs) / 60_000)
        if (min < 1) return "just now"
        if (min < 60) return "$min min ago"
        val h = min / 60
        if (h < 24) return "$h h ago"
        val d = h / 24
        return "$d ${if (d == 1L) "day" else "days"} ago"
    }

    /** The trades list's age: "12s", "5m", "3h" (tradeslist.ts). */
    fun tradeAgo(ago: Long): String = when {
        ago < 90 -> "${ago}s"
        ago < 5400 -> "${Math.round(ago / 60.0)}m"
        else -> "${Math.round(ago / 3600.0)}h"
    }

    /** The word beside a flagged coin on a Discover row (copynote.ts `flagWord`): a copy not confirmed from the chain is "unchecked". */
    fun flagWord(t: Token): String = if (t.label == NoScoreLabel.Vamp && t.copyOf?.chainProven != true) "unchecked" else "confirmed"

    /** "+38.4%", "−12.0%", "+1,250%" (the site's signedPct); a dash when missing. Under a day: "+38.4% · 5h". */
    fun change(pct: Double?, windowHours: Double? = null): String {
        if (pct == null || !pct.isFinite()) return DASH
        val a = abs(pct)
        val body = if (a >= 1000) String.format(Locale.US, "%,d", a.roundToLong()) else fixed(a, 1)
        var s = (if (pct < 0) "−" else "+") + body + "%"
        if (windowHours != null && windowHours.isFinite() && windowHours > 0 && windowHours < 23) {
            s += " · ${maxOf(1, windowHours.roundToInt())}h"
        }
        return s
    }

    /** Coverage as a whole percent: "45%". */
    fun coverage(v: Double): String = "${v.roundToInt()}%"

    /** What the score place shows: the label for a flagged token, the number, or a dash. */
    fun score(t: Token): String = t.label?.text ?: t.score?.toString() ?: DASH

    /** The name (masked by the name filter), or a shortened address when there is none ("7xKX…9fQa"). */
    fun title(t: Token): String {
        if (NameFilter.masks(t)) return NameFilter.MASKED_NAME
        t.name?.let { return it }
        val a = t.address
        return if (a.length > 10) a.take(4) + "…" + a.takeLast(4) else a
    }

    fun ticker(t: Token): String = if (NameFilter.masks(t)) NameFilter.MASKED_TICKER else t.ticker ?: DASH

    /**
     * The site's `toFixed`: rounds the number's exact stored value, halves up. (Java's own formatter rounds the printed
     * value instead, so 112.05, stored as 112.0499…, would read "112.1" here and "112.0" on the site.)
     */
    fun fixed(v: Double, digits: Int): String = BigDecimal(v).setScale(digits, RoundingMode.HALF_UP).toPlainString()
}
