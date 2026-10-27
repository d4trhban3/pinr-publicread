package io.pinr.app.feed

import kotlin.math.abs
import kotlin.math.log10
import org.json.JSONArray
import org.json.JSONObject

// What the feed server answers for ONE coin (pinr-live/server/server.ts, market.ts, trades.ts, events.ts, metrics.ts,
// dossier.ts), as the site and the iPhone app read it. Every reader is lenient: a bad row is dropped, never guessed.

/** One candle: open, high, low, close at a time (seconds), and the dollar volume. */
data class Candle(val t: Long, val open: Double, val high: Double, val low: Double, val close: Double, val volume: Double)

/** The chart's timeframes, as the site's terminal offers them. */
enum class Timeframe(val code: String) { M1("1m"), M5("5m"), M15("15m"), H1("1h"), H4("4h"), D1("1D") }

data class CandleSet(val candles: List<Candle>, val source: String?, val status: Status, val asOfMs: Long? = null,
    /** The size of the candles when the feed gave a different one than asked. */
    val bucketSec: Long? = null) {
    /** Stale: the source is busy and these are the last good candles, read at [asOfMs]. */
    enum class Status { Ok, Stale, None, Busy, Error }

    /** Candles to draw: a good answer, or a stale one (which then says when it was read). */
    val drawable: Boolean get() = (status == Status.Ok || status == Status.Stale) && candles.size >= 2

    /** When the candles were read, for a stale answer only; null means they are current. */
    val asOf: Long? get() = if (status == Status.Stale) asOfMs else null

    /** The candles the chart draws: the newest 80, as on the site. */
    val shown: List<Candle> get() = candles.takeLast(80)

    /** The price range of the candles drawn, so they fill the chart's height. */
    val range: ClosedFloatingPointRange<Double>?
        get() {
            val lo = shown.minOfOrNull { it.low } ?: return null
            val hi = shown.maxOf { it.high }
            if (lo <= 0) return null
            return lo..maxOf(hi, lo * 1.0001)
        }

    /** The site's rule for the lite chart: a log scale when the highest price drawn is over six times the lowest. */
    val logScale: Boolean get() = range?.let { it.endInclusive / it.start > 6 } ?: false
}

/** A dated engine event on the chart (a score or flag change): plain text only. */
data class ChartEvent(val t: Long, val kind: String, val tone: String, val text: String)

/** One trade on the tape: when (seconds), buy or sell, and its size in dollars. */
data class Trade(val t: Long, val buy: Boolean, val usd: Double)

/** The tape (`/api/trades`, the site's TradesView): the trades oldest first, as the file holds them. */
data class TradesView(
    val none: Boolean,
    val trades: List<Trade>,
    val complete: Boolean,
    val coversFrom: Long?,
    val asOf: Long?,
    val summary: Token.Flow?,
)

/** The engine's PINR Index line for one coin: the score over time, a smoothed companion line and the gap between them. */
data class Metric(
    val timeframe: String,
    val series: List<Pair<Long, Double>>,
    val signal: List<Pair<Long, Double>>,
    val histogram: List<Pair<Long, Double>>,
    val levels: List<Double>,
)

object CoinWire {
    private fun obj(body: String): JSONObject? = try { JSONObject(body) } catch (e: Exception) { null }
    private fun JSONObject.str(k: String): String? = (opt(k) as? String)?.takeIf { it.isNotEmpty() }
    private fun num(v: Any?): Double? = (v as? Number)?.toDouble()?.takeIf { it.isFinite() }

    /** Rows of six finite numbers with positive prices and high at or above low, oldest first; anything else is dropped. */
    fun candles(body: String): CandleSet? {
        val o = obj(body) ?: return null
        val rows = (o.opt("candles") as? JSONArray)?.let { a ->
            (0 until a.length()).mapNotNull { i ->
                val r = a.opt(i) as? JSONArray ?: return@mapNotNull null
                if (r.length() != 6) return@mapNotNull null
                val v = (0 until 6).map { num(r.opt(it)) ?: return@mapNotNull null }
                val (t, op, hi, lo) = v
                val cl = v[4]; val vol = v[5]
                if (t <= 0 || op <= 0 || hi <= 0 || lo <= 0 || cl <= 0 || vol < 0 || hi < lo) return@mapNotNull null
                Candle(t.toLong(), op, hi, lo, cl, vol)
            }.sortedBy { it.t }
        } ?: emptyList()
        // A stale answer needs its candles and its real read time, or it could pass as current; the contract says a
        // client that does not know a status treats it as busy, so anything else unknown (or missing) is busy: no chart.
        val asOf = num(o.opt("asOfMs"))?.takeIf { it > 0 }?.toLong()
        val st = when (o.str("status")) {
            "ok" -> CandleSet.Status.Ok
            "stale" -> if (rows.isNotEmpty() && asOf != null) CandleSet.Status.Stale else CandleSet.Status.Busy
            "none" -> CandleSet.Status.None
            "busy" -> CandleSet.Status.Busy
            "error" -> CandleSet.Status.Error
            else -> CandleSet.Status.Busy
        }
        val bucket = num(o.opt("bucketSec"))?.takeIf { it > 0 && it.isFinite() }?.toLong()
        return CandleSet(rows, o.str("source"), st, if (st == CandleSet.Status.Stale) asOf else null, bucket)
    }

    /** Each entry read once; one that cannot be read, or has no real date, is dropped. */
    fun events(body: String): List<ChartEvent>? {
        val a = obj(body)?.opt("events") as? JSONArray ?: return null
        return (0 until a.length()).mapNotNull { i ->
            val e = a.opt(i) as? JSONObject ?: return@mapNotNull null
            val t = num(e.opt("t"))?.takeIf { it > 0 } ?: return@mapNotNull null
            ChartEvent(t.toLong(), e.str("kind") ?: return@mapNotNull null, e.str("tone") ?: "", e.str("text") ?: return@mapNotNull null)
        }.sortedBy { it.t }
    }

    /** Each row read once: [time, "buy" or "sell", dollars above zero]; anything else is dropped. */
    fun trades(body: String): TradesView? {
        val o = obj(body) ?: return null
        val rows = (o.opt("trades") as? JSONArray)?.let { a ->
            (0 until a.length()).mapNotNull { i ->
                val r = a.opt(i) as? JSONArray ?: return@mapNotNull null
                if (r.length() != 3) return@mapNotNull null
                val t = num(r.opt(0))?.takeIf { it > 0 } ?: return@mapNotNull null
                val side = r.opt(1) as? String
                val usd = num(r.opt(2))?.takeIf { it > 0 } ?: return@mapNotNull null
                if (side != "buy" && side != "sell") return@mapNotNull null
                Trade(t.toLong(), side == "buy", usd)
            }
        } ?: emptyList()
        val summary = (o.opt("summary") as? JSONObject)?.let { s ->
            val f = listOf("buy5m", "sell5m", "buy1h", "sell1h", "n5m", "n1h").map { num(s.opt(it))?.takeIf { v -> v >= 0 } ?: return@let null }
            Token.Flow(f[0], f[1], f[2], f[3], f[4].toInt(), f[5].toInt(), s.opt("basis") == "count", s.opt("complete") == true)
        }
        return TradesView(
            none = (o.opt("none") as? Boolean ?: true) && rows.isEmpty(),
            trades = rows,
            complete = o.opt("complete") as? Boolean ?: false,
            coversFrom = num(o.opt("coversFrom"))?.takeIf { it > 0 }?.toLong(),
            asOf = num(o.opt("asOf"))?.takeIf { it > 0 }?.toLong(),
            summary = summary,
        )
    }

    /** A metric with fewer than two points has nothing to draw: it is absent, not a flat line. */
    fun metric(body: String): Metric? {
        val m = obj(body)?.opt("metric") as? JSONObject ?: return null
        fun points(k: String): List<Pair<Long, Double>> = (m.opt(k) as? JSONArray)?.let { a ->
            (0 until a.length()).mapNotNull { i ->
                val r = a.opt(i) as? JSONArray ?: return@mapNotNull null
                if (r.length() != 2) return@mapNotNull null
                val t = num(r.opt(0))?.takeIf { it > 0 } ?: return@mapNotNull null
                val v = num(r.opt(1)) ?: return@mapNotNull null
                t.toLong() to v
            }.sortedBy { it.first }
        } ?: emptyList()
        val series = points("series")
        if (series.size < 2) return null
        val levels = (m.opt("levels") as? JSONArray)?.let { a -> (0 until a.length()).mapNotNull { num(a.opt(it)) } } ?: emptyList()
        return Metric(m.str("timeframe") ?: "", series, points("signal"), points("histogram"), levels)
    }
}

/** The site's pressure windows (ui/tradeslist.ts `pressureWindows`): one line when only the newest trades were read. */
data class PressureWindow(val label: String, val buy: Double, val sell: Double, val n: Int, val atLeast: Boolean)

fun pressureWindows(v: TradesView, nowS: Long): List<PressureWindow> {
    val s = v.summary ?: return emptyList()
    val capped = !v.complete
    val covered = v.coversFrom?.let { maxOf(0L, nowS - it) }
    if (capped && (covered == null || covered < 300)) {
        val label = if (covered == null) "Newest trades" else "Newest trades (${if (covered < 90) "last $covered s" else "last ${Math.round(covered / 60.0)} min"})"
        return listOf(PressureWindow(label, s.buy1h, s.sell1h, s.trades1h, true))
    }
    // A capped list that still reaches back a full hour or more holds every trade of the hour.
    val hourFloor = capped && covered != null && covered < 3600
    return listOf(
        PressureWindow("Last 5 minutes", s.buy5m, s.sell5m, s.trades5m, false),
        PressureWindow(if (hourFloor) "Last hour (at least)" else "Last hour", s.buy1h, s.sell1h, s.trades1h, hourFloor),
    )
}

/**
 * "Similar tokens" (world/similar.ts, as the iPhone app): same chain, from measured facts only: market cap and age
 * close to this coin's (in tenfold steps), the same launchpad counting as closer. Never the score.
 */
object Similar {
    fun tokens(base: Token, all: List<Token>, count: Int = 5, nowMs: Long = System.currentTimeMillis()): List<Token> {
        val chain = base.chain?.lowercase()?.takeIf { it.isNotEmpty() } ?: return emptyList()
        val myPad = base.launchpad?.lowercase() ?: ""
        val myAge = base.launchedAtMs?.let { (nowMs - it) / 60_000.0 }
        val scored = ArrayList<Triple<Token, Double, Int>>()
        all.forEachIndexed { i, t ->
            if (t.id == base.id || t.chain?.lowercase() != chain) return@forEachIndexed
            val cap = tenfold(base.valuationUsd, t.valuationUsd)
            val age = tenfold(myAge, t.launchedAtMs?.let { (nowMs - it) / 60_000.0 })
            val samePad = myPad.isNotEmpty() && myPad == (t.launchpad?.lowercase() ?: "")
            // At least one measured likeness besides the chain; more than about 30 times apart in size is not similar.
            if (cap == null && age == null && !samePad) return@forEachIndexed
            if (cap != null && cap > 1.5) return@forEachIndexed
            scored += Triple(t, (cap ?: 1.0) + (age ?: 1.0) * 0.6 + (if (samePad) 0.0 else 0.5), i)
        }
        return scored.sortedWith(compareBy({ it.second }, { it.third })).take(count).map { it.first }
    }

    /** 0 when equal, growing in tenfold steps apart; null when either is missing. */
    fun tenfold(a: Double?, b: Double?): Double? {
        if (a == null || b == null || !a.isFinite() || !b.isFinite() || a <= 0 || b <= 0) return null
        return abs(log10(a / b))
    }
}
