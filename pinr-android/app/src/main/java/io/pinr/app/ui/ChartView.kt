package io.pinr.app.ui

import io.pinr.app.feed.jsTrim
import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.pinr.app.feed.Candle
import io.pinr.app.feed.ChartColor
import io.pinr.app.feed.ChartEvent
import io.pinr.app.feed.DrawKind
import io.pinr.app.feed.DrawMath
import io.pinr.app.feed.DrawPoint
import io.pinr.app.feed.Drawing
import io.pinr.app.feed.Format
import io.pinr.app.feed.Ind
import io.pinr.app.feed.IndId
import io.pinr.app.feed.IndSpecs
import io.pinr.app.feed.Metric
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import org.json.JSONArray
import org.json.JSONObject

/** The site's chart types (terminalbase.ts KINDS) and price scales (SCALES). */
enum class ChartKind(val label: String) { Candles("Candles"), Heikin("Heikin-Ashi"), Line("Line"), Area("Area") }
enum class ScaleMode(val label: String) { Normal("Normal"), Log("Log"), Percent("%") }

fun chartColor(c: ChartColor) = Color(c.argb)

/**
 * The terminal's choices kept on this phone, as the site keeps them in the browser: the chart type, scale and axis, the
 * indicators with their settings (the site's `pinr.ind` shape) and each coin's drawings.
 */
class ChartPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("pinr", Context.MODE_PRIVATE)
    var kind by mutableStateOf(ChartKind.entries.firstOrNull { it.name == prefs.getString("pinr.chart.kind", null) } ?: ChartKind.Candles)
        private set
    var scale by mutableStateOf(ScaleMode.entries.firstOrNull { it.name == prefs.getString("pinr.chart.scale", null) } ?: ScaleMode.Normal)
        private set
    var mcapAxis by mutableStateOf(prefs.getBoolean("pinr.chart.mcap", false))
        private set
    var ind by mutableStateOf(IndSpecs.parse(prefs.getString("pinr.ind", null)))
        private set

    fun chooseKind(k: ChartKind) { kind = k; prefs.edit().putString("pinr.chart.kind", k.name).apply() }
    fun chooseScale(s: ScaleMode) { scale = s; prefs.edit().putString("pinr.chart.scale", s.name).apply() }
    fun chooseAxis(mcap: Boolean) { mcapAxis = mcap; prefs.edit().putBoolean("pinr.chart.mcap", mcap).apply() }
    fun setInd(id: IndId, st: IndSpecs.State) { ind = ind + (id to st); prefs.edit().putString("pinr.ind", IndSpecs.write(ind)).apply() }

    /** A coin's drawings (at most 80, as the site keeps), read back safely: anything malformed is dropped. */
    fun drawings(address: String): List<Drawing> = try {
        val a = JSONArray(prefs.getString("pinr.draw.$address", "[]"))
        (0 until minOf(a.length(), 80)).mapNotNull { i ->
            val o = a.optJSONObject(i) ?: return@mapNotNull null
            val k = DrawKind.entries.firstOrNull { it.name == o.optString("kind") } ?: return@mapNotNull null
            fun pt(n: String) = o.optJSONObject(n)?.let { p -> val t = p.optDouble("t"); val v = p.optDouble("p"); if (t.isFinite() && v.isFinite()) DrawPoint(t, v) else null }
            val pa = pt("a") ?: return@mapNotNull null
            val pb = pt("b"); val pc = pt("c")
            if ((k.needs >= 2 && pb == null) || (k.needs >= 3 && pc == null)) return@mapNotNull null
            val text = o.optString("text").replace(Regex("[\\u0000-\\u001f]"), " ").jsTrim().take(60)
            if (k == DrawKind.Text && text.isEmpty()) return@mapNotNull null
            Drawing(o.optString("id", "d$i"), k, pa, pb, pc, ChartColor.entries.firstOrNull { it.name == o.optString("color") } ?: ChartColor.Lime, o.optInt("width", 2).coerceIn(1, 3), text.ifEmpty { null })
        }
    } catch (e: Exception) { emptyList() }

    fun saveDrawings(address: String, list: List<Drawing>) {
        val a = JSONArray()
        list.take(80).forEach { d ->
            fun pt(p: DrawPoint) = JSONObject().put("t", p.t).put("p", p.p)
            a.put(JSONObject().put("id", d.id).put("kind", d.kind.name).put("a", pt(d.a)).apply {
                d.b?.let { put("b", pt(it)) }; d.c?.let { put("c", pt(it)) }; put("color", d.color.name); put("width", d.width); d.text?.let { put("text", it) }
            })
        }
        prefs.edit().apply { if (list.isEmpty()) remove("pinr.draw.$address") else putString("pinr.draw.$address", a.toString()) }.apply()
    }
}

/** How a readout value is written (terminal.ts legend): "price" with its $, "plain" the same without it, "num" two decimals. */
enum class Digits { Price, Plain, Num }

/** What the chart shows of an indicator in the readout: its name, colour and latest value. */
data class IndRow(val name: String, val color: Color, val last: Double, val digits: Digits)

/** One drawn line of an indicator. */
private data class Series(val name: String, val color: Color, val vals: DoubleArray, val dashed: Boolean = false, val width: Float = 1f, val shift: Int = 0, val digits: Digits = Digits.Num)

/** A pane of its own (RSI, MACD, Stochastic, ATR, OBV). */
private data class SubPane(val lines: List<Series>, val hist: DoubleArray? = null, val guides: List<Double> = emptyList(), val extraRows: List<Series> = emptyList())

/** The rows the readout shows for the indicators switched on (the site's legend). */
fun indicatorRows(c: List<Candle>, ind: Map<IndId, IndSpecs.State>): List<IndRow> {
    val (over, vol, panes) = build(c, ind)
    fun last(v: DoubleArray) = v.lastOrNull { it.isFinite() } ?: Double.NaN
    // The supertrend's second (falling) half is one indicator on the site: one row, its line's latest value.
    val overRows = over.filter { it.shift == 0 && !it.name.endsWith(" ") }.map { s0 ->
        val v = if (s0.name.startsWith("Supertrend")) last(DoubleArray(s0.vals.size) { i -> if (s0.vals[i].isFinite()) s0.vals[i] else over.firstOrNull { it.name == s0.name + " " }?.vals?.get(i) ?: Double.NaN }) else last(s0.vals)
        IndRow(s0.name, s0.color, v, Digits.Price)
    }
    return overRows + vol.map { IndRow(it.name, it.color, last(it.vals), Digits.Plain) } +
        panes.flatMap { p -> (p.lines + p.extraRows).map { IndRow(it.name, it.color, last(it.vals), it.digits) } }
}

private fun build(c: List<Candle>, ind: Map<IndId, IndSpecs.State>): Triple<List<Series>, List<Series>, List<SubPane>> {
    val over = ArrayList<Series>(); val vol = ArrayList<Series>(); val panes = ArrayList<SubPane>()
    if (c.size < 2) return Triple(over, vol, panes)
    fun st(id: IndId) = ind[id]!!
    fun on(id: IndId) = st(id).on
    fun n(id: IndId, k: String) = st(id).params[k]!!
    fun col(id: IndId) = chartColor(st(id).color)
    fun name(id: IndId) = IndSpecs.label(IndSpecs.spec(id), st(id))
    if (on(IndId.Sma)) over += Series(name(IndId.Sma), col(IndId.Sma), Ind.sma(c, n(IndId.Sma, "n")))
    if (on(IndId.Ema)) over += Series(name(IndId.Ema), col(IndId.Ema), Ind.ema(c, n(IndId.Ema, "n")))
    if (on(IndId.Ema2)) over += Series(name(IndId.Ema2), col(IndId.Ema2), Ind.ema(c, n(IndId.Ema2, "n")))
    if (on(IndId.Vwap)) over += Series(name(IndId.Vwap), col(IndId.Vwap), Ind.vwap(c), dashed = true)
    if (on(IndId.Bb)) {
        val b = Ind.bollinger(c, n(IndId.Bb, "n"), n(IndId.Bb, "k").toDouble())
        over += Series("BB mid", col(IndId.Bb), b.mid, dashed = true); over += Series("BB up", col(IndId.Bb), b.upper); over += Series("BB low", col(IndId.Bb), b.lower)
    }
    if (on(IndId.Supertrend)) {
        val s = Ind.supertrend(c, n(IndId.Supertrend, "n"), n(IndId.Supertrend, "k").toDouble())
        over += Series(name(IndId.Supertrend), Brand.lime, DoubleArray(c.size) { if (s.up[it]) s.line[it] else Double.NaN }, width = 2f)
        over += Series(name(IndId.Supertrend) + " ", Brand.mandarin, DoubleArray(c.size) { if (!s.up[it]) s.line[it] else Double.NaN }, width = 2f, shift = 0)
    }
    if (on(IndId.Ichimoku)) {
        val k = n(IndId.Ichimoku, "k")
        val i = Ind.ichimoku(c, n(IndId.Ichimoku, "t"), k, n(IndId.Ichimoku, "s"))
        over += Series("Tenkan", chartColor(ChartColor.Blue), i.tenkan); over += Series("Kijun", chartColor(ChartColor.Orange), i.kijun)
        over += Series("Span A", chartColor(ChartColor.Lime), i.spanA, shift = k); over += Series("Span B", chartColor(ChartColor.Purple), i.spanB, dashed = true, shift = k)
    }
    if (on(IndId.Vma)) vol += Series(name(IndId.Vma), col(IndId.Vma), Ind.volumeAverage(c, n(IndId.Vma, "n")))
    if (on(IndId.Rsi)) panes += SubPane(listOf(Series(name(IndId.Rsi), col(IndId.Rsi), Ind.rsi(c, n(IndId.Rsi, "n")), digits = Digits.Num)), guides = listOf(70.0, 30.0))
    if (on(IndId.Macd)) {
        val m = Ind.macd(c, n(IndId.Macd, "f"), n(IndId.Macd, "s"), n(IndId.Macd, "g"))
        panes += SubPane(
            listOf(Series("MACD", chartColor(ChartColor.Blue), m.line, digits = Digits.Plain), Series("Signal", chartColor(ChartColor.Yellow), m.signal, digits = Digits.Plain)),
            hist = m.hist, extraRows = listOf(Series("Hist", Brand.lime, m.hist, digits = Digits.Plain)),
        )
    }
    if (on(IndId.Stoch)) {
        val s = Ind.stochastic(c, n(IndId.Stoch, "n"), n(IndId.Stoch, "k"), n(IndId.Stoch, "d"))
        panes += SubPane(listOf(Series("%K", chartColor(ChartColor.Blue), s.k), Series("%D", chartColor(ChartColor.Yellow), s.d)), guides = listOf(80.0, 20.0))
    }
    if (on(IndId.Atr)) panes += SubPane(listOf(Series(name(IndId.Atr), col(IndId.Atr), Ind.atr(c, n(IndId.Atr, "n")), digits = Digits.Plain)))
    if (on(IndId.Obv)) panes += SubPane(listOf(Series("OBV", col(IndId.Obv), Ind.obv(c), digits = Digits.Plain)))
    return Triple(over, vol, panes)
}

/** Where a value sits between the bottom (0) and the top (1) of a range on the chosen scale. */
private fun frac(v: Double, lo: Double, hi: Double, log: Boolean): Float =
    if (hi <= lo) 0.5f else if (log && lo > 0 && v > 0) ((ln(v) - ln(lo)) / (ln(hi) - ln(lo))).toFloat() else ((v - lo) / (hi - lo)).toFloat()

/** The geometry a tap needs to turn a screen spot back into a time and a price (and the other way round). */
class ChartGeometry(val w: Float, val h0: Float, val x: (Double) -> Float, val t: (Float) -> Double, val y: (Double) -> Float, val p: (Float) -> Double)

/**
 * The site's terminal chart (ui/terminal.ts, terminalind.ts, terminaldraw.ts) on the app's own canvas: price (64%, less as
 * indicator panes are added), volume (16%), PINR Index line (20%) and a pane for each switched-on pane indicator (15% each),
 * one time axis at the bottom. The chart type, scale and axis (price or market cap) as chosen; the indicators over the
 * price, on the volume and in their panes; the drawings, and the points of one being placed.
 */
@Composable
fun TerminalChartCanvas(
    candles0: List<Candle>, kind: ChartKind, scale: ScaleMode, axisK: Double, events: List<ChartEvent>, metric: Metric?,
    ind: Map<IndId, IndSpecs.State>, drawings: List<Drawing>, pending: List<DrawPoint>, pendingKind: DrawKind?, selected: String?,
    barSeconds: Double, onTap: (ChartGeometry, Offset) -> Unit, modifier: Modifier,
) {
    val m = rememberTextMeasurer()
    val mcap = axisK != 1.0
    // The drawn candles in the axis units in use (price, or market cap = price × supply).
    val base = if (kind == ChartKind.Heikin) Ind.heikinAshi(candles0) else candles0
    val c = if (mcap) base.map { Candle(it.t, it.open * axisK, it.high * axisK, it.low * axisK, it.close * axisK, it.volume) } else base
    val (over, volLines, panes) = build(c, ind)
    var geo by mutableStateOf<ChartGeometry?>(null)
    val axisStyle = TextStyle(color = Brand.paper.copy(alpha = 0.8f), fontSize = 9.5.sp, fontFamily = FontFamily.Monospace)
    val muteStyle = TextStyle(color = Brand.mute, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
    fun fmtAxis(v: Double) = (if (mcap) Format.money(v) else Format.priceCompact(v)).removePrefix("$")
    val last = c.last()
    Canvas(
        modifier.semantics { contentDescription = "Price chart. Last ${if (mcap) "market cap" else "price"} ${fmtAxis(last.close)}." }
            .pointerInput(c.size, pendingKind, drawings.size) { detectTapGestures { pos -> geo?.let { onTap(it, pos) } } },
    ) {
        val axisW = 58.dp.toPx(); val timeH = 20.dp.toPx()
        val w = size.width - axisW; val total = size.height - timeH
        val extra = panes.size
        val f0 = max(0.28f, 0.64f - 0.13f * extra); val fs = listOf(f0, 0.16f, 0.2f) + List(extra) { 0.15f }
        val sum = fs.sum(); val hs = fs.map { it / sum * total }
        val tops = hs.runningFold(0f) { a, b -> a + b }
        val h0 = hs[0]
        // Price range: what is drawn (candles and the over-price indicators), 8% room top and bottom.
        val ref = c.first().open
        fun sv(v: Double) = if (scale == ScaleMode.Percent) (v / ref - 1) * 100 else v
        var lo = c.minOf { it.low }; var hi = c.maxOf { it.high }
        for (s in over) for (v in s.vals) if (v.isFinite()) { lo = min(lo, v); hi = max(hi, v) }
        hi = max(hi, lo * 1.0001)
        val log = scale == ScaleMode.Log
        val pad = if (log) 0.0 else (hi - lo) * 0.087
        val plo = if (log) lo / 1.06 else lo - pad; val phi = if (log) hi * 1.06 else hi + pad
        fun py(v: Double) = h0 * (1 - frac(v, plo, phi, log))
        fun pFromY(yy: Float): Double { val f = 1 - yy / h0; return if (log && plo > 0) Math.exp(ln(plo) + f * (ln(phi) - ln(plo))) else plo + f * (phi - plo) }
        val n = c.size; val step = w / (n + 6)
        val tStep = if (n >= 2) (c[n - 1].t - c[0].t).toDouble() / (n - 1) else barSeconds
        fun xt(t: Double) = step * 0.5f + ((t - c[0].t) / tStep).toFloat() * step
        fun tFromX(xx: Float) = c[0].t + ((xx - step * 0.5f) / step) * tStep
        geo = ChartGeometry(w, h0, ::xt, ::tFromX, ::py, ::pFromY)
        // Time ticks through every pane, one axis at the bottom.
        val span = ((n - 1 + 6) * tStep).toLong()
        val steps = longArrayOf(60, 300, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800)
        val ts = steps.firstOrNull { span / it <= 4 } ?: steps.last()
        val fmt = SimpleDateFormat("HH:mm", Locale.US); val day = SimpleDateFormat("d", Locale.US)
        var tt = (c[0].t / ts + 1) * ts
        while (tt <= c[0].t + span) {
            val x = xt(tt.toDouble())
            if (x in 0f..w) {
                drawLine(Brand.fg.copy(alpha = 0.05f), Offset(x, 0f), Offset(x, total), 1f)
                val hm = fmt.format(Date(tt * 1000))
                val r = m.measure(if (hm == "00:00") day.format(Date(tt * 1000)) else hm, muteStyle)
                drawText(r, topLeft = Offset((x - r.size.width / 2).coerceIn(0f, w - r.size.width), total + 4.dp.toPx()))
            }
            tt += ts
        }
        // Price axis: round steps in the scale's own units ("%" shows the change from the first candle).
        val tickLo = if (scale == ScaleMode.Percent) sv(plo) else plo; val tickHi = if (scale == ScaleMode.Percent) sv(phi) else phi
        val ticks = if (log) logTicks(plo, phi) else niceTicks(tickLo, tickHi, 6)
        for (v in ticks) {
            val price = if (scale == ScaleMode.Percent) ref * (1 + v / 100) else v
            val yy = py(price)
            if (yy < 0 || yy > h0) continue
            drawLine(Brand.fg.copy(alpha = 0.05f), Offset(0f, yy), Offset(w, yy), 1f)
            val label = if (scale == ScaleMode.Percent) Format.fixed(v, 2) + "%" else fmtAxis(v)
            val r = m.measure(label, axisStyle)
            drawText(r, topLeft = Offset(w + 6.dp.toPx(), yy - r.size.height / 2))
        }
        clipRect(0f, 0f, w, h0) {
            for (e in events) { val x = xt(e.t.toDouble()); drawLine(toneColor(e.tone).copy(alpha = 0.6f), Offset(x, 0f), Offset(x, h0), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f))) }
            when (kind) {
                ChartKind.Line, ChartKind.Area -> {
                    val path = Path().apply { c.forEachIndexed { i, k -> if (i == 0) moveTo(xt(k.t.toDouble()), py(k.close)) else lineTo(xt(k.t.toDouble()), py(k.close)) } }
                    if (kind == ChartKind.Area) {
                        val fill = Path().apply { addPath(path); lineTo(xt(c.last().t.toDouble()), h0); lineTo(xt(c.first().t.toDouble()), h0); close() }
                        drawPath(fill, androidx.compose.ui.graphics.Brush.verticalGradient(listOf(Brand.lime.copy(alpha = 0.28f), Brand.lime.copy(alpha = 0f)), 0f, h0))
                    }
                    drawPath(path, Brand.lime, style = Stroke(2.dp.toPx()))
                }
                else -> {
                    val body = max(1.5.dp.toPx(), step * 0.62f)
                    for (k in c) {
                        val x = xt(k.t.toDouble()); val col = if (k.close >= k.open) Brand.lime else Brand.mandarin
                        drawLine(col, Offset(x, py(k.high)), Offset(x, py(k.low)), 1.dp.toPx())
                        val top = py(max(k.open, k.close)); val bot = py(min(k.open, k.close))
                        drawRect(col, Offset(x - body / 2, top), Size(body, max(1f, bot - top)))
                    }
                }
            }
            for (s in over) line(s, c, ::xt, ::py)
            // Drawings are kept in price; on a market-cap axis they are drawn at price x supply (the site's kEff).
            fun pd(p: Double) = py(p * axisK)
            for (d in drawings) drawDrawing(m, d, ::xt, ::pd, w, h0, d.id == selected, barSeconds)
            for (pp in pending) drawCircle(Brand.lime, 4.dp.toPx(), Offset(xt(pp.t), pd(pp.p)))
        }
        val up = last.close >= last.open; val lc = if (up) Brand.lime else Brand.mandarin
        val ly = py(last.close)
        drawLine(lc, Offset(0f, ly), Offset(w, ly), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 3.dp.toPx())))
        axisTag(m, if (scale == ScaleMode.Percent) Format.fixed(sv(last.close), 2) + "%" else fmtAxis(last.close), lc, w, ly)

        // Volume pane, with its scale and the volume average.
        val y1 = tops[1]; val y2 = tops[2]; val sep = Brand.fg.copy(alpha = 0.1f)
        drawLine(sep, Offset(0f, y1), Offset(size.width, y1), 1f)
        val vTop = c.maxOf { it.volume }
        if (vTop > 0) {
            val vHi = vTop * 1.1
            fun vy(v: Double) = y1 + hs[1] * (1 - (v / vHi).toFloat())
            val bw = max(1f, step * 0.62f)
            for (k in c) { val x = xt(k.t.toDouble()); drawRect((if (k.close >= k.open) Brand.lime else Brand.mandarin).copy(alpha = 0.55f), Offset(x - bw / 2, vy(k.volume)), Size(bw, y2 - vy(k.volume))) }
            for (s in volLines) line(s, c, ::xt, ::vy)
            for (v in niceTicks(0.0, vHi, 3)) { val r = m.measure(volumeLabel(v), axisStyle); drawText(r, topLeft = Offset(w + 6.dp.toPx(), (vy(v) - r.size.height / 2).coerceIn(y1, y2 - r.size.height))) }
        }
        // PINR Index line pane (fixed 0 to 100).
        val y3 = tops[3]
        drawLine(sep, Offset(0f, y2), Offset(size.width, y2), 1f)
        fun my(v: Double) = y2 + hs[2] * (1 - (v / 100.0).toFloat().coerceIn(0f, 1f))
        for (v in listOf(40.0, 80.0)) { val r = m.measure(Format.fixed(v, 2), axisStyle); drawText(r, topLeft = Offset(w + 6.dp.toPx(), my(v) - r.size.height / 2)) }
        if (metric != null) {
            clipRect(0f, y2, w, y3) {
                for (lv in metric.levels) drawLine(Brand.fg.copy(alpha = 0.25f), Offset(0f, my(lv)), Offset(w, my(lv)), 1f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 4f)))
                val hMax = metric.histogram.maxOfOrNull { kotlin.math.abs(it.second) }?.takeIf { it > 0 } ?: 1.0
                val hb = max(1f, step * 0.62f)
                for ((t, v) in metric.histogram) { if (v == 0.0) continue; val bh = (kotlin.math.abs(v) / hMax).toFloat() * hs[2] * 0.26f; drawRect((if (v >= 0) Brand.lime else Brand.mandarin).copy(alpha = 0.4f), Offset(xt(t.toDouble()) - hb / 2, y2 + hs[2] * 0.98f - bh), Size(hb, bh)) }
                fun ser(p: List<Pair<Long, Double>>, col: Color) { if (p.size >= 2) drawPath(Path().apply { p.forEachIndexed { i, (t, v) -> if (i == 0) moveTo(xt(t.toDouble()), my(v)) else lineTo(xt(t.toDouble()), my(v)) } }, col, style = Stroke(2.dp.toPx())) }
                ser(metric.signal, SIGNAL_PURPLE); ser(metric.series, Brand.lime)
            }
            axisTag(m, Format.fixed(metric.series.last().second, 2), Brand.lime, w, my(metric.series.last().second))
        }
        // The indicators' own panes, each on its own scale, with its guide lines and last value.
        panes.forEachIndexed { i, p ->
            val top = tops[3 + i]; val ph = hs[3 + i]
            drawLine(sep, Offset(0f, top), Offset(size.width, top), 1f)
            val all = p.lines.flatMap { s -> s.vals.filter { it.isFinite() } } + (p.hist?.filter { it.isFinite() } ?: emptyList()) + p.guides
            if (all.isEmpty()) return@forEachIndexed
            val qlo = all.min(); val qhi = max(all.max(), qlo + 1e-9)
            fun qy(v: Double) = top + ph * 0.08f + ph * 0.84f * (1 - frac(v, qlo, qhi, false))
            clipRect(0f, top, w, top + ph) {
                for (g in p.guides) drawLine(Brand.fg.copy(alpha = 0.25f), Offset(0f, qy(g)), Offset(w, qy(g)), 1f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 4f)))
                p.hist?.let { hv -> val hb = max(1f, step * 0.62f); val z = qy(0.0); hv.forEachIndexed { j, v -> if (v.isFinite()) { val yy = qy(v); drawRect((if (v >= 0) Brand.lime else Brand.mandarin).copy(alpha = 0.5f), Offset(xt(c[j].t.toDouble()) - hb / 2, min(yy, z)), Size(hb, max(1f, kotlin.math.abs(yy - z)))) } } }
                for (s in p.lines) line(s, c, ::xt, ::qy)
            }
            p.lines.firstOrNull()?.let { s -> s.vals.lastOrNull { it.isFinite() }?.let { v -> axisTag(m, Format.fixed(v, 2), s.color, w, qy(v)) } }
        }
    }
}

/** Log-scale steps: 1, 2 and 5 times each power of ten inside the range. */
private fun logTicks(lo: Double, hi: Double): List<Double> {
    if (lo <= 0 || hi <= lo) return emptyList()
    val out = ArrayList<Double>()
    var p = Math.pow(10.0, Math.floor(Math.log10(lo)))
    while (p <= hi) { for (k in listOf(1.0, 2.0, 5.0)) { val v = p * k; if (v in lo..hi) out += v }; p *= 10 }
    return out.ifEmpty { niceTicks(lo, hi, 4) }
}

private fun DrawScope.line(s: Series, c: List<Candle>, xt: (Double) -> Float, y: (Double) -> Float) {
    val path = Path(); var pen = false
    val stepT = if (c.size >= 2) (c.last().t - c.first().t).toDouble() / (c.size - 1) else 60.0
    s.vals.forEachIndexed { i, v ->
        if (!v.isFinite()) { pen = false; return@forEachIndexed }
        val x = xt(c[0].t + (i + s.shift) * stepT)
        if (pen) path.lineTo(x, y(v)) else { path.moveTo(x, y(v)); pen = true }
    }
    drawPath(path, s.color, style = Stroke(s.width.dp.toPx(), pathEffect = if (s.dashed) PathEffect.dashPathEffect(floatArrayOf(5f, 4f)) else null))
}

/** A value's tag on the right axis: dark text on lime, light text on mandarin and the other colours' own. */
private fun DrawScope.axisTag(m: TextMeasurer, text: String, color: Color, w: Float, y: Float) {
    val ink = if (color == Brand.lime) Brand.ink else Color.White
    val r = m.measure(text, TextStyle(color = ink, fontSize = 9.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold))
    val yy = y.coerceIn(r.size.height / 2f + 1f, size.height - r.size.height / 2f - 1f)
    drawRoundRect(color, Offset(w + 2.dp.toPx(), yy - r.size.height / 2 - 1.dp.toPx()), Size(r.size.width + 8.dp.toPx(), r.size.height + 2.dp.toPx()), CornerRadius(2.dp.toPx()))
    drawText(r, topLeft = Offset(w + 6.dp.toPx(), yy - r.size.height / 2))
}

/** One drawing, as the site's drawing layer draws it; a selected one shows its handles. */
private fun DrawScope.drawDrawing(m: TextMeasurer, d: Drawing, xt: (Double) -> Float, py: (Double) -> Float, w: Float, h: Float, sel: Boolean, barSeconds: Double) {
    val col = chartColor(d.color); val sw = d.width.dp.toPx()
    val a = Offset(xt(d.a.t), py(d.a.p)); val b = d.b?.let { Offset(xt(it.t), py(it.p)) }
    val label = TextStyle(color = col, fontSize = 10.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
    when (d.kind) {
        DrawKind.H -> drawLine(col, Offset(0f, a.y), Offset(w, a.y), sw)
        DrawKind.V -> drawLine(col, Offset(a.x, 0f), Offset(a.x, h), sw)
        DrawKind.Trend -> drawLine(col, a, b!!, sw)
        DrawKind.Ray -> { val dx = b!!.x - a.x; val dy = b.y - a.y; val k = if (dx == 0f) 1f else (w - a.x) / dx * (if (dx < 0) -1 else 1); val end = if (dx == 0f) b else Offset(a.x + dx * kotlin.math.abs(k) * 4, a.y + dy * kotlin.math.abs(k) * 4); drawLine(col, a, end, sw) }
        DrawKind.Channel -> {
            val shift = DrawMath.channelShift(d.a, d.b!!, d.c!!)
            drawLine(col, a, b!!, sw)
            drawLine(col, Offset(a.x, py(d.a.p + shift)), Offset(b.x, py(d.b.p + shift)), sw)
            drawPath(Path().apply { moveTo(a.x, a.y); lineTo(b.x, b.y); lineTo(b.x, py(d.b.p + shift)); lineTo(a.x, py(d.a.p + shift)); close() }, col.copy(alpha = 0.08f))
        }
        DrawKind.Rect -> { val tl = Offset(min(a.x, b!!.x), min(a.y, b.y)); val sz = Size(kotlin.math.abs(b.x - a.x), kotlin.math.abs(b.y - a.y)); drawRect(col.copy(alpha = 0.1f), tl, sz); drawRect(col, tl, sz, style = Stroke(sw)) }
        DrawKind.Fib -> for (lv in DrawMath.FIB_LEVELS) {
            val p = d.b!!.p + (d.a.p - d.b.p) * lv; val yy = py(p)
            drawLine(col.copy(alpha = if (lv == 0.0 || lv == 1.0) 1f else 0.7f), Offset(min(a.x, b!!.x), yy), Offset(max(a.x, b.x), yy), sw / 1.5f)
            drawText(m.measure(Format.fixed(lv, 3).trimEnd('0').trimEnd('.'), label), topLeft = Offset(min(a.x, b.x) + 2, yy - 14.dp.toPx()))
        }
        DrawKind.Measure -> {
            val r = DrawMath.measure(d.a, d.b!!, barSeconds); val up = r.pct >= 0; val mc = if (up) Brand.lime else Brand.mandarin
            val tl = Offset(min(a.x, b!!.x), min(a.y, b.y)); val sz = Size(kotlin.math.abs(b.x - a.x), kotlin.math.abs(b.y - a.y))
            drawRect(mc.copy(alpha = 0.14f), tl, sz)
            val t = m.measure("${Format.change(r.pct)} · ${r.bars} bars · ${DrawMath.durationText(r.seconds)}", label.copy(color = mc))
            drawText(t, topLeft = Offset(tl.x, (if (up) tl.y else tl.y + sz.height) - (if (up) t.size.height + 2f else -2f)))
        }
        DrawKind.Text -> drawText(m.measure(d.text ?: "", label.copy(fontSize = 12.sp)), topLeft = a)
    }
    if (sel) listOfNotNull(a, b, d.c?.let { Offset(xt(it.t), py(it.p)) }).forEach { drawCircle(Brand.paper, 4.dp.toPx(), it); drawCircle(col, 2.5.dp.toPx(), it) }
}
