package io.pinr.app.feed

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * Chart maths for the terminal, line for line the site's (pinr-live/src/world/indicators.ts): standard public chart
 * calculations on candles. Each returns one value per candle, or NaN while there is not yet enough history (the chart
 * skips NaN: nothing is invented). PINR's own PINR Index line is NOT here: it is calculated only in the engine.
 */
object Ind {
    /** The change over the last 24 hours of candles: from the open of the first candle inside the window to the last close (change24h). */
    fun change24h(c: List<Candle>): Double? {
        if (c.size < 2) return null
        val last = c.last(); val cutoff = last.t - 24 * 3600
        val first = c.firstOrNull { it.t >= cutoff } ?: c.first()
        return if (first.open.isFinite() && first.open > 0 && last.close.isFinite()) (last.close / first.open - 1) * 100 else Double.NaN
    }

    private fun nan(n: Int) = DoubleArray(n) { Double.NaN }

    /** Heikin-Ashi candles: smoother candles built from the averages of each candle and the one before it. */
    fun heikinAshi(c: List<Candle>): List<Candle> {
        val out = ArrayList<Candle>(c.size)
        var po = Double.NaN; var pc = Double.NaN
        for (k in c) {
            val hc = (k.open + k.high + k.low + k.close) / 4
            val ho = if (po.isNaN()) (k.open + k.close) / 2 else (po + pc) / 2
            out += Candle(k.t, ho, max(k.high, max(ho, hc)), min(k.low, min(ho, hc)), hc, k.volume)
            po = ho; pc = hc
        }
        return out
    }

    fun sma(c: List<Candle>, n: Int): DoubleArray {
        val out = DoubleArray(c.size); var sum = 0.0
        for (i in c.indices) { sum += c[i].close; if (i >= n) sum -= c[i - n].close; out[i] = if (i >= n - 1) sum / n else Double.NaN }
        return out
    }

    /** Exponential moving average of a list; starts from the average of the first `n` real values. */
    fun emaOf(v: DoubleArray, n: Int): DoubleArray {
        val out = nan(v.size); val k = 2.0 / (n + 1); var prev = Double.NaN; var seen = 0; var sum = 0.0
        for (i in v.indices) {
            val x = v[i]
            if (!x.isFinite()) continue
            seen++
            if (seen <= n) { sum += x; if (seen == n) { prev = sum / n; out[i] = prev } } else { prev = x * k + prev * (1 - k); out[i] = prev }
        }
        return out
    }

    fun ema(c: List<Candle>, n: Int) = emaOf(DoubleArray(c.size) { c[it].close }, n)

    fun vwap(c: List<Candle>): DoubleArray {
        var pv = 0.0; var vol = 0.0
        return DoubleArray(c.size) { i -> val k = c[i]; pv += (k.high + k.low + k.close) / 3 * k.volume; vol += k.volume; if (vol > 0) pv / vol else Double.NaN }
    }

    data class Bands(val mid: DoubleArray, val upper: DoubleArray, val lower: DoubleArray)
    fun bollinger(c: List<Candle>, n: Int = 20, k: Double = 2.0): Bands {
        val mid = sma(c, n); val up = nan(c.size); val lo = nan(c.size)
        for (i in c.indices) {
            if (!mid[i].isFinite()) continue
            var s = 0.0
            for (j in i - n + 1..i) s += (c[j].close - mid[i]).pow(2)
            val sd = sqrt(s / n); up[i] = mid[i] + k * sd; lo[i] = mid[i] - k * sd
        }
        return Bands(mid, up, lo)
    }

    /** Relative Strength Index (Wilder's smoothing), 0 to 100. */
    fun rsi(c: List<Candle>, n: Int = 14): DoubleArray {
        val out = nan(c.size)
        if (c.size <= n) return out
        var gain = 0.0; var loss = 0.0
        for (i in 1..n) { val d = c[i].close - c[i - 1].close; if (d >= 0) gain += d else loss -= d }
        gain /= n; loss /= n
        fun at() = if (loss == 0.0) (if (gain == 0.0) 50.0 else 100.0) else 100 - 100 / (1 + gain / loss)
        out[n] = at()
        for (i in n + 1 until c.size) {
            val d = c[i].close - c[i - 1].close
            gain = (gain * (n - 1) + max(d, 0.0)) / n; loss = (loss * (n - 1) + max(-d, 0.0)) / n
            out[i] = at()
        }
        return out
    }

    data class Macd(val line: DoubleArray, val signal: DoubleArray, val hist: DoubleArray)
    fun macd(c: List<Candle>, fast: Int = 12, slow: Int = 26, signal: Int = 9): Macd {
        val f = ema(c, fast); val s = ema(c, slow)
        val line = DoubleArray(c.size) { if (f[it].isFinite() && s[it].isFinite()) f[it] - s[it] else Double.NaN }
        val sig = emaOf(line, signal)
        return Macd(line, sig, DoubleArray(c.size) { if (line[it].isFinite() && sig[it].isFinite()) line[it] - sig[it] else Double.NaN })
    }

    /** Simple moving average of any list; a window with a missing value gives NaN. */
    fun smaOf(v: DoubleArray, n: Int): DoubleArray = DoubleArray(v.size) { i ->
        if (i < n - 1) Double.NaN else { var s = 0.0; for (j in i - n + 1..i) s += v[j]; s / n }
    }

    fun volumeAverage(c: List<Candle>, n: Int) = smaOf(DoubleArray(c.size) { c[it].volume }, n)

    data class Stoch(val k: DoubleArray, val d: DoubleArray)
    fun stochastic(c: List<Candle>, n: Int = 14, smooth: Int = 3, dN: Int = 3): Stoch {
        val raw = DoubleArray(c.size) { i ->
            if (i < n - 1) Double.NaN else {
                var hi = Double.NEGATIVE_INFINITY; var lo = Double.POSITIVE_INFINITY
                for (j in i - n + 1..i) { hi = max(hi, c[j].high); lo = min(lo, c[j].low) }
                if (hi == lo) 50.0 else (c[i].close - lo) / (hi - lo) * 100
            }
        }
        val k = if (smooth > 1) smaOf(raw, smooth) else raw
        return Stoch(k, smaOf(k, dN))
    }

    /** Average True Range (Wilder). */
    fun atr(c: List<Candle>, n: Int = 14): DoubleArray {
        val out = nan(c.size)
        if (c.size <= n) return out
        fun tr(i: Int): Double { val k = c[i]; val p = c[i - 1].close; return max(k.high - k.low, max(abs(k.high - p), abs(k.low - p))) }
        var sum = 0.0
        for (i in 1..n) sum += tr(i)
        var a = sum / n; out[n] = a
        for (i in n + 1 until c.size) { a = (a * (n - 1) + tr(i)) / n; out[i] = a }
        return out
    }

    fun obv(c: List<Candle>): DoubleArray {
        var total = 0.0
        return DoubleArray(c.size) { i ->
            if (i > 0) { val d = c[i].close - c[i - 1].close; if (d > 0) total += c[i].volume else if (d < 0) total -= c[i].volume }
            total
        }
    }

    data class Super(val line: DoubleArray, val up: BooleanArray)
    fun supertrend(c: List<Candle>, n: Int = 10, mult: Double = 3.0): Super {
        val a = atr(c, n); val line = nan(c.size); val up = BooleanArray(c.size) { true }
        var fu = Double.NaN; var fl = Double.NaN; var trendUp = true
        for (i in c.indices) {
            if (!a[i].isFinite()) continue
            val k = c[i]; val mid = (k.high + k.low) / 2
            val bu = mid + mult * a[i]; val bl = mid - mult * a[i]
            val pc = if (i > 0) c[i - 1].close else k.close
            fu = if (!fu.isFinite() || bu < fu || pc > fu) bu else fu
            fl = if (!fl.isFinite() || bl > fl || pc < fl) bl else fl
            if (trendUp && k.close < fl) trendUp = false else if (!trendUp && k.close > fu) trendUp = true
            line[i] = if (trendUp) fl else fu; up[i] = trendUp
        }
        return Super(line, up)
    }

    data class Ichi(val tenkan: DoubleArray, val kijun: DoubleArray, val spanA: DoubleArray, val spanB: DoubleArray)
    /** Ichimoku lines; spanA and spanB come UNSHIFTED (the chart draws them `kijun` candles ahead). */
    fun ichimoku(c: List<Candle>, t: Int = 9, k: Int = 26, s: Int = 52): Ichi {
        fun mid(i: Int, n: Int): Double {
            if (i < n - 1) return Double.NaN
            var hi = Double.NEGATIVE_INFINITY; var lo = Double.POSITIVE_INFINITY
            for (j in i - n + 1..i) { hi = max(hi, c[j].high); lo = min(lo, c[j].low) }
            return (hi + lo) / 2
        }
        val tk = DoubleArray(c.size) { mid(it, t) }; val kj = DoubleArray(c.size) { mid(it, k) }
        return Ichi(tk, kj, DoubleArray(c.size) { if (tk[it].isFinite() && kj[it].isFinite()) (tk[it] + kj[it]) / 2 else Double.NaN }, DoubleArray(c.size) { mid(it, s) })
    }
}

/** The colours drawings and indicators may take (world/drawmath.ts COLORS, the dark look). */
enum class ChartColor(val argb: Long) { Lime(0xFFD6FF3C), White(0xFFF4EEFF), Purple(0xFFB980FF), Orange(0xFFFF8C1A), Blue(0xFF6FD3FF), Yellow(0xFFFFD24A) }

/** The indicator catalogue (world/indicatorspecs.ts), word for word: names, where each is drawn, its settings and limits, its colour. */
enum class IndId { Sma, Ema, Ema2, Vwap, Bb, Supertrend, Ichimoku, Vma, Rsi, Macd, Stoch, Atr, Obv }

object IndSpecs {
    data class Param(val key: String, val label: String, val def: Int, val min: Int = 1, val max: Int = 500)
    enum class Where { Over, Volume, Pane }
    data class Spec(val id: IndId, val name: String, val where: Where, val params: List<Param>, val color: ChartColor, val pickColor: Boolean)

    private fun p(k: String, l: String, d: Int, mn: Int = 1, mx: Int = 500) = Param(k, l, d, mn, mx)
    val SPECS = listOf(
        Spec(IndId.Sma, "SMA", Where.Over, listOf(p("n", "Period", 20)), ChartColor.Yellow, true),
        Spec(IndId.Ema, "EMA", Where.Over, listOf(p("n", "Period", 50)), ChartColor.Purple, true),
        Spec(IndId.Ema2, "EMA", Where.Over, listOf(p("n", "Period", 9)), ChartColor.Blue, true),
        Spec(IndId.Vwap, "VWAP", Where.Over, emptyList(), ChartColor.White, true),
        Spec(IndId.Bb, "Bollinger", Where.Over, listOf(p("n", "Period", 20, 2), p("k", "Width", 2, 1, 5)), ChartColor.Blue, true),
        Spec(IndId.Supertrend, "Supertrend", Where.Over, listOf(p("n", "Period", 10, 2, 100), p("k", "Multiplier", 3, 1, 10)), ChartColor.Lime, false),
        Spec(IndId.Ichimoku, "Ichimoku", Where.Over, listOf(p("t", "Fast", 9, 2, 100), p("k", "Medium", 26, 2, 200), p("s", "Slow", 52, 2, 300)), ChartColor.Blue, false),
        Spec(IndId.Vma, "Volume average", Where.Volume, listOf(p("n", "Period", 20)), ChartColor.White, true),
        Spec(IndId.Rsi, "RSI", Where.Pane, listOf(p("n", "Period", 14, 2, 100)), ChartColor.Purple, true),
        Spec(IndId.Macd, "MACD", Where.Pane, listOf(p("f", "Fast", 12, 2, 100), p("s", "Slow", 26, 3, 200), p("g", "Signal", 9, 2, 100)), ChartColor.Blue, false),
        Spec(IndId.Stoch, "Stochastic", Where.Pane, listOf(p("n", "Period", 14, 2, 100), p("k", "Smoothing", 3, 1, 20), p("d", "%D", 3, 1, 20)), ChartColor.Blue, false),
        Spec(IndId.Atr, "ATR", Where.Pane, listOf(p("n", "Period", 14, 2, 100)), ChartColor.White, true),
        Spec(IndId.Obv, "OBV", Where.Pane, emptyList(), ChartColor.Lime, true),
    )
    fun spec(id: IndId) = SPECS.first { it.id == id }

    data class State(val on: Boolean, val params: Map<String, Int>, val color: ChartColor)
    fun defaults(): Map<IndId, State> = SPECS.associate { s -> s.id to State(false, s.params.associate { it.key to it.def }, s.color) }

    /** A setting kept inside its limits, as a whole number; a bad value falls back to the default (clampParam). */
    fun clamp(q: Param, v: Double?): Int = if (v == null || !v.isFinite()) q.def else min(q.max, max(q.min, Math.round(v).toInt()))

    /** A stored value as the site's Number() reads it: a number, a number written as text ("" is 0), true 1, false 0. */
    private fun number(v: Any?): Double? = when (v) {
        is Number -> v.toDouble()
        is Boolean -> if (v) 1.0 else 0.0
        is String -> v.jsNumber()
        else -> null
    }

    /** "SMA 20", "Bollinger 20, 2", "VWAP" (labelOf). */
    fun label(s: Spec, st: State) = if (s.params.isEmpty()) s.name else s.name + " " + s.params.joinToString(", ") { st.params[it.key].toString() }

    /** Saved choices (the site's key names: on, params, color), read back safely. */
    fun parse(json: String?): Map<IndId, State> {
        val out = defaults().toMutableMap()
        val v = try { JSONTokener(json ?: return out).nextValue() } catch (e: Exception) { return out }
        // The first format: a plain list of the names that were on.
        if (v is JSONArray) {
            for (i in 0 until v.length()) SPECS.firstOrNull { it.id.name.lowercase() == v.opt(i) }?.let { out[it.id] = out.getValue(it.id).copy(on = true) }
            return out
        }
        val o = v as? JSONObject ?: return out
        for (s in SPECS) {
            val r = o.optJSONObject(s.id.name.lowercase()) ?: continue
            val ps = r.optJSONObject("params")
            out[s.id] = State(
                r.opt("on") == true,
                s.params.associate { q -> q.key to clamp(q, ps?.opt(q.key)?.takeIf { it != JSONObject.NULL }?.let { number(it) ?: Double.NaN }) },
                ChartColor.entries.firstOrNull { it.name.lowercase() == r.optString("color") } ?: s.color,
            )
        }
        return out
    }

    fun write(states: Map<IndId, State>): String = JSONObject().apply {
        states.forEach { (id, st) -> put(id.name.lowercase(), JSONObject().put("on", st.on).put("params", JSONObject(st.params)).put("color", st.color.name.lowercase())) }
    }.toString()
}

/**
 * The chart's drawing tools (world/drawmath.ts): a point is a TIME and a PRICE, not a screen spot, so a drawing stays put
 * when the timeframe changes or new candles arrive.
 */
enum class DrawKind(val label: String, val needs: Int, val hints: List<String>) {
    H("Horizontal line", 1, listOf("Tap the chart where the line goes")),
    V("Vertical line", 1, listOf("Tap the chart where the line goes")),
    Trend("Trend line", 2, listOf("Tap the first point", "Tap the second point")),
    Ray("Ray", 2, listOf("Tap the start", "Tap a point it passes through")),
    Channel("Parallel channel", 3, listOf("Tap the first point", "Tap the second point", "Tap where the parallel line passes")),
    Rect("Rectangle", 2, listOf("Tap the first corner", "Tap the opposite corner")),
    Fib("Fibonacci retracement", 2, listOf("Tap the first point (a high or low)", "Tap the second point")),
    Measure("Measure", 2, listOf("Tap where to start measuring", "Tap where to stop")),
    Text("Text note", 1, listOf("Tap where the note goes")),
}

data class DrawPoint(val t: Double, val p: Double)
data class Drawing(val id: String, val kind: DrawKind, val a: DrawPoint, val b: DrawPoint? = null, val c: DrawPoint? = null, val color: ChartColor = ChartColor.Lime, val width: Int = 2, val text: String? = null)

object DrawMath {
    /** The Fibonacci retracement levels drawn (0 at the second point, 1 at the first). */
    val FIB_LEVELS = listOf(0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0)

    data class Measured(val pct: Double, val bars: Long, val seconds: Double)
    fun measure(a: DrawPoint, b: DrawPoint, barSeconds: Double) = Measured(if (a.p > 0) (b.p / a.p - 1) * 100 else Double.NaN, if (barSeconds > 0) Math.round(abs(b.t - a.t) / barSeconds) else 0, abs(b.t - a.t))

    /** "1d 4h", "3h 20m", "45m". */
    fun durationText(seconds: Double): String {
        if (!seconds.isFinite() || seconds < 0) return ""
        val m = Math.round(seconds / 60); val d = m / 1440; val h = (m % 1440) / 60; val mm = m % 60
        return when { d > 0 -> if (h > 0) "${d}d ${h}h" else "${d}d"; h > 0 -> if (mm > 0) "${h}h ${mm}m" else "${h}h"; else -> "${mm}m" }
    }

    /** Where a channel's parallel line sits: the baseline a-b shifted vertically to pass through c (channelShift). */
    fun channelShift(a: DrawPoint, b: DrawPoint, c: DrawPoint): Double = if (b.t == a.t) c.p - a.p else c.p - (a.p + (b.p - a.p) * (c.t - a.t) / (b.t - a.t))
}
