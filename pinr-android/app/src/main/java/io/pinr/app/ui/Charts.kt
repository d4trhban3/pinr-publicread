package io.pinr.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
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
import io.pinr.app.feed.ChartEvent
import io.pinr.app.feed.Format
import io.pinr.app.feed.Metric
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min

// The charts are drawn on Compose's own canvas (PLAN.md: no chart library), in the site's look: lime up, mandarin down.

/** Where a price sits between the bottom (0) and the top (1) of a range, on a linear or log scale. */
private fun frac(v: Double, lo: Double, hi: Double, log: Boolean): Float {
    if (hi <= lo) return 0.5f
    return if (log && lo > 0) ((ln(v) - ln(lo)) / (ln(hi) - ln(lo))).toFloat() else ((v - lo) / (hi - lo)).toFloat()
}

fun toneColor(tone: String): Color = when (tone) { "good" -> Brand.lime; "bad" -> Brand.mandarin; else -> Brand.lilac }

/**
 * The site's lite chart (Discover card): three faint gridlines, a light line with a soft fill under it (lime when it ends
 * up, mandarin when down) and a dot at the last price; or candles. Whose data it is sits small in the corner.
 */
@Composable
fun LitePlot(points: List<Double>, candles: List<Candle>?, lo: Double, hi: Double, log: Boolean, label: String?, modifier: Modifier) {
    val measurer = rememberTextMeasurer()
    val rising = (points.lastOrNull() ?: 0.0) >= (points.firstOrNull() ?: 0.0)
    val tone = if (rising) Brand.lime else Brand.mandarin
    Canvas(modifier.semantics { contentDescription = "Price chart" }) {
        for (i in 1..3) {
            val y = size.height * i / 4f
            drawLine(Brand.fg.copy(alpha = 0.08f), Offset(0f, y), Offset(size.width, y), 1f)
        }
        fun y(v: Double) = size.height * (1 - frac(v, lo, hi, log)) * 0.92f + size.height * 0.04f
        if (candles != null) {
            drawCandles(candles, size.width, ::y)
        } else if (points.size >= 2) {
            val step = size.width / (points.size - 1)
            val line = Path().apply { points.forEachIndexed { i, v -> if (i == 0) moveTo(0f, y(v)) else lineTo(i * step, y(v)) } }
            val fill = Path().apply { addPath(line); lineTo(size.width, size.height); lineTo(0f, size.height); close() }
            drawPath(fill, Brush.verticalGradient(listOf(tone.copy(alpha = 0.32f), tone.copy(alpha = 0f))))
            drawPath(line, Brand.paper.copy(alpha = 0.9f), style = Stroke(1.3.dp.toPx(), cap = StrokeCap.Round))
            drawCircle(tone, 3.dp.toPx(), Offset(size.width, y(points.last())))
        }
        label?.let { cornerLabel(measurer, it) }
    }
}

private fun DrawScope.cornerLabel(m: TextMeasurer, text: String) {
    val r = m.measure(text, TextStyle(color = Brand.mute, fontSize = 9.sp, fontFamily = FontFamily.Monospace))
    drawText(r, topLeft = Offset(size.width - r.size.width - 4.dp.toPx(), size.height - r.size.height - 2.dp.toPx()))
}

private fun DrawScope.drawCandles(c: List<Candle>, width: Float, y: (Double) -> Float) {
    if (c.isEmpty()) return
    val step = width / c.size
    val body = max(1.5.dp.toPx(), step * 0.62f)
    c.forEachIndexed { i, k ->
        val x = step * i + step / 2
        val col = if (k.close >= k.open) Brand.lime else Brand.mandarin
        drawLine(col, Offset(x, y(k.high)), Offset(x, y(k.low)), 1.dp.toPx())
        val top = y(max(k.open, k.close)); val bot = y(min(k.open, k.close))
        drawRect(col, Offset(x - body / 2, top), Size(body, max(1f, bot - top)))
    }
}

/**
 * The terminal's price chart at phone width (ui/terminal.ts): candles or a line, the price axis on the right, faint
 * gridlines, the score and flag events as dashed lines, and a dashed line at the last price with its lime tag.
 */
@Composable
fun PriceChart(candles: List<Candle>, line: Boolean, events: List<ChartEvent>, modifier: Modifier) {
    val m = rememberTextMeasurer()
    val lo = candles.minOf { it.low }
    val hi = max(candles.maxOf { it.high }, lo * 1.0001)
    val last = candles.last().close
    val axis = TextStyle(color = Brand.paper.copy(alpha = 0.8f), fontSize = 9.5.sp, fontFamily = FontFamily.Monospace)
    Canvas(
        modifier.semantics {
            contentDescription = "Price chart. Last price ${Format.price(last)}. High ${Format.price(hi)}, low ${Format.price(lo)}."
        },
    ) {
        val axisW = 58.dp.toPx()
        val timeH = 16.dp.toPx()
        val w = size.width - axisW
        val h = size.height - timeH
        fun y(v: Double) = h * (1 - frac(v, lo, hi, false)) * 0.9f + h * 0.05f
        // The price axis: eight steps, labelled at the right without the dollar sign, as the site's.
        for (i in 0..7) {
            val v = lo + (hi - lo) * i / 7
            val yy = y(v)
            drawLine(Brand.fg.copy(alpha = 0.05f), Offset(0f, yy), Offset(w, yy), 1f)
            val t = m.measure(Format.priceCompact(v).removePrefix("$"), axis)
            drawText(t, topLeft = Offset(w + 4.dp.toPx(), yy - t.size.height / 2))
        }
        val t0 = candles.first().t; val t1 = candles.last().t
        fun x(t: Long) = if (t1 > t0) w * (t - t0).toFloat() / (t1 - t0) else w / 2
        for (e in events) if (e.t in t0..t1) {
            drawLine(toneColor(e.tone).copy(alpha = 0.6f), Offset(x(e.t), 0f), Offset(x(e.t), h), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)))
        }
        if (line) {
            val step = w / max(1, candles.size - 1)
            drawPath(Path().apply { candles.forEachIndexed { i, k -> if (i == 0) moveTo(0f, y(k.close)) else lineTo(i * step, y(k.close)) } }, Brand.lime, style = Stroke(1.5.dp.toPx()))
        } else {
            drawCandles(candles, w, ::y)
        }
        // The last price: a dashed line and the lime tag on the axis.
        val ly = y(last)
        drawLine(Brand.mandarin.copy(alpha = 0.8f), Offset(0f, ly), Offset(w, ly), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 6f)))
        val tag = m.measure(Format.priceCompact(last).removePrefix("$"), TextStyle(color = Brand.ink, fontSize = 9.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold))
        drawRoundRect(Brand.lime, Offset(w + 2.dp.toPx(), ly - tag.size.height / 2 - 1.dp.toPx()), Size(tag.size.width + 6.dp.toPx(), tag.size.height + 2.dp.toPx()), CornerRadius(2.dp.toPx()))
        drawText(tag, topLeft = Offset(w + 5.dp.toPx(), ly - tag.size.height / 2))
        // Three times along the bottom.
        val fmt = SimpleDateFormat("HH:mm", Locale.US)
        for (i in 0..2) {
            val tt = t0 + (t1 - t0) * i / 2
            val s = m.measure(fmt.format(Date(tt * 1000)), TextStyle(color = Brand.mute, fontSize = 10.sp, fontFamily = FontFamily.Monospace))
            drawText(s, topLeft = Offset((x(tt) - s.size.width / 2).coerceIn(0f, w - s.size.width), h + 2.dp.toPx()))
        }
    }
}

/** Volume under the chart: one bar a candle, lime or mandarin at half strength, the top value on the axis. */
@Composable
fun VolumeBars(candles: List<Candle>, modifier: Modifier) {
    val m = rememberTextMeasurer()
    val top = candles.maxOf { it.volume }
    Canvas(modifier) {
        val axisW = 58.dp.toPx()
        val w = size.width - axisW
        val step = w / candles.size
        candles.forEachIndexed { i, k ->
            val bh = if (top > 0) (k.volume / top).toFloat() * size.height else 0f
            drawRect((if (k.close >= k.open) Brand.lime else Brand.mandarin).copy(alpha = 0.55f), Offset(step * i + step * 0.19f, size.height - bh), Size(max(1f, step * 0.62f), bh))
        }
        val t = m.measure(Format.money(top).removePrefix("$"), TextStyle(color = Brand.mute, fontSize = 9.sp, fontFamily = FontFamily.Monospace))
        drawText(t, topLeft = Offset(w + 4.dp.toPx(), 0f))
    }
}

/** The PINR Index line pane: the histogram (lime above zero, mandarin below), the line in lime, its signal in lilac, its levels. */
@Composable
fun MetricPlot(metric: Metric, modifier: Modifier) {
    val m = rememberTextMeasurer()
    Canvas(modifier) {
        val all = metric.series.map { it.second } + metric.signal.map { it.second } + metric.histogram.map { it.second } + metric.levels + 0.0
        val lo = all.min(); val hi = max(all.max(), lo + 1e-9)
        val t0 = metric.series.first().first; val t1 = metric.series.last().first
        val w = size.width - 58.dp.toPx()
        fun x(t: Long) = if (t1 > t0) w * (t - t0).toFloat() / (t1 - t0) else w / 2
        fun y(v: Double) = size.height * (1 - frac(v, lo, hi, false))
        for (l in metric.levels) drawLine(Brand.fg.copy(alpha = 0.15f), Offset(0f, y(l)), Offset(w, y(l)), 1f)
        val bw = max(1f, w / max(1, metric.histogram.size) * 0.6f)
        // A zero in the histogram is no bar (not a flat sliver).
        for ((t, v) in metric.histogram) {
            if (v == 0.0) continue
            val a = y(0.0); val b = y(v)
            drawRect((if (v >= 0) Brand.lime else Brand.mandarin).copy(alpha = 0.4f), Offset(x(t) - bw / 2, min(a, b)), Size(bw, max(1f, kotlin.math.abs(a - b))))
        }
        fun line(p: List<Pair<Long, Double>>, c: Color) {
            if (p.size < 2) return
            drawPath(Path().apply { p.forEachIndexed { i, (t, v) -> if (i == 0) moveTo(x(t), y(v)) else lineTo(x(t), y(v)) } }, c, style = Stroke(1.5.dp.toPx()))
        }
        line(metric.series, Brand.lime)
        line(metric.signal, Brand.lilac)
        // The last value's tag on the axis, as the site's pane ("24.00").
        val last = metric.series.last().second
        val tag = m.measure(Format.fixed(last, 2), TextStyle(color = Brand.ink, fontSize = 9.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold))
        val ly = y(last).coerceIn(tag.size.height / 2f, size.height - tag.size.height / 2f)
        drawRoundRect(Brand.lime, Offset(w + 2.dp.toPx(), ly - tag.size.height / 2 - 1.dp.toPx()), Size(tag.size.width + 6.dp.toPx(), tag.size.height + 2.dp.toPx()), CornerRadius(2.dp.toPx()))
        drawText(tag, topLeft = Offset(w + 5.dp.toPx(), ly - tag.size.height / 2))
    }
}

/** The site's signal line colour (terminalbase.ts SIGNAL_PURPLE), a mid purple that reads on both looks. */
val SIGNAL_PURPLE = Color(0xFF8F5CFF)

/**
 * Round axis steps, as the site's chart library picks them: 1, 2, 2.5 or 5 times a power of ten, so that about
 * [target] labels fit. Returns the tick values inside [lo, hi].
 */
fun niceTicks(lo: Double, hi: Double, target: Int): List<Double> {
    if (!(hi > lo) || target < 1) return emptyList()
    val raw = (hi - lo) / target
    val mag = Math.pow(10.0, Math.floor(Math.log10(raw)))
    val step = listOf(1.0, 2.0, 2.5, 5.0, 10.0).map { it * mag }.first { it >= raw }
    val out = ArrayList<Double>()
    var v = Math.ceil(lo / step) * step
    while (v <= hi + step * 1e-9) { out += v; v += step }
    return out
}

/**
 * The volume scale's labels: the site's chart formats every scale with `fmtAxis` (terminal.ts: the compact price
 * without the $), so volume reads "200,000.00", "500.00".
 */
fun volumeLabel(v: Double): String = Format.priceCompact(v).removePrefix("$") // zero reads "—", as the site's fmtAxis(0)

/** Round time steps for the time axis, in seconds. */
private val TIME_STEPS = longArrayOf(60, 300, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800)

/**
 * The site's terminal chart (ui/terminal.ts): one chart in three panes sharing one time axis at the bottom: prices
 * (64%), volume (16%) and the PINR Index line (20%, a fixed 0 to 100 scale, the score in lime and its signal in purple, the
 * histogram behind). Round steps on every axis; the last price dotted in its candle's colour with its tag; six bars of
 * room after the newest candle; the score and flag events as dashed lines.
 */
@Composable
fun TerminalPanes(candles: List<Candle>, line: Boolean, events: List<ChartEvent>, metric: Metric?, modifier: Modifier) {
    val m = rememberTextMeasurer()
    val axisStyle = TextStyle(color = Brand.paper.copy(alpha = 0.8f), fontSize = 9.5.sp, fontFamily = FontFamily.Monospace)
    val muteStyle = TextStyle(color = Brand.mute, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
    val lo0 = candles.minOf { it.low }
    val hi0 = max(candles.maxOf { it.high }, lo0 * 1.0001)
    val last = candles.last()
    Canvas(
        modifier.semantics {
            contentDescription = "Price chart. Last price ${Format.price(last.close)}. High ${Format.price(hi0)}, low ${Format.price(lo0)}."
        },
    ) {
        val axisW = 58.dp.toPx()
        val timeH = 20.dp.toPx()
        val w = size.width - axisW
        val total = size.height - timeH
        val sep = Brand.fg.copy(alpha = 0.1f)
        val h0 = total * 0.64f; val h1 = total * 0.16f; val h2 = total * 0.20f
        val y1 = h0; val y2 = h0 + h1
        // Price pane: 8% room at the top and the bottom, as the site's scale margins.
        val pad = (hi0 - lo0) * 0.087
        val lo = lo0 - pad; val hi = hi0 + pad
        fun py(v: Double) = h0 * (1 - frac(v, lo, hi, false))
        // Time: the bars spread across the width with six bars of room after the newest.
        val n = candles.size
        val step = w / (n + 6)
        val tStep = if (n >= 2) (candles[n - 1].t - candles[0].t).toDouble() / (n - 1) else 60.0
        fun xt(t: Long) = (step * 0.5f + ((t - candles[0].t) / tStep).toFloat() * step)
        // Time ticks, round, about four across, drawn as faint lines through every pane.
        val span = ((n - 1 + 6) * tStep).toLong()
        val ts = TIME_STEPS.firstOrNull { span / it <= 4 } ?: TIME_STEPS.last()
        val fmt = SimpleDateFormat("HH:mm", Locale.US)
        val day = SimpleDateFormat("d", Locale.US)
        var tt = (candles[0].t / ts + 1) * ts
        while (tt <= candles[0].t + span) {
            val x = xt(tt)
            if (x in 0f..w) {
                drawLine(Brand.fg.copy(alpha = 0.05f), Offset(x, 0f), Offset(x, total), 1f)
                val d = Date(tt * 1000)
                // A tick at midnight shows the day of the month, as the site's time axis does.
                val hm = fmt.format(d)
                val label = if (hm == "00:00") day.format(d) else hm
                val r = m.measure(label, muteStyle)
                drawText(r, topLeft = Offset((x - r.size.width / 2).coerceIn(0f, w - r.size.width), total + 4.dp.toPx()))
            }
            tt += ts
        }
        // Price axis: round steps, without the dollar sign.
        for (v in niceTicks(lo, hi, 6)) {
            val yy = py(v)
            if (yy < 0 || yy > h0) continue
            drawLine(Brand.fg.copy(alpha = 0.05f), Offset(0f, yy), Offset(w, yy), 1f)
            val r = m.measure(Format.priceCompact(v).removePrefix("$"), axisStyle)
            drawText(r, topLeft = Offset(w + 6.dp.toPx(), yy - r.size.height / 2))
        }
        for (e in events) {
            val x = xt(e.t)
            if (x in 0f..w) drawLine(toneColor(e.tone).copy(alpha = 0.6f), Offset(x, 0f), Offset(x, h0), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)))
        }
        if (line) {
            drawPath(Path().apply { candles.forEachIndexed { i, k -> if (i == 0) moveTo(xt(k.t), py(k.close)) else lineTo(xt(k.t), py(k.close)) } }, Brand.lime, style = Stroke(2.dp.toPx()))
        } else {
            val body = max(1.5.dp.toPx(), step * 0.62f)
            for (k in candles) {
                val x = xt(k.t)
                val col = if (k.close >= k.open) Brand.lime else Brand.mandarin
                drawLine(col, Offset(x, py(k.high)), Offset(x, py(k.low)), 1.dp.toPx())
                val top = py(max(k.open, k.close)); val bot = py(min(k.open, k.close))
                drawRect(col, Offset(x - body / 2, top), Size(body, max(1f, bot - top)))
            }
        }
        // The last price: a dotted line in its candle's colour, and the tag on the axis.
        val up = last.close >= last.open
        val lc = if (up) Brand.lime else Brand.mandarin
        val ly = py(last.close)
        drawLine(lc, Offset(0f, ly), Offset(w, ly), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 3.dp.toPx())))
        tag(m, Format.priceCompact(last.close).removePrefix("$"), lc, w, ly)

        // Volume pane.
        drawLine(sep, Offset(0f, y1), Offset(size.width, y1), 1f)
        val vTop = candles.maxOf { it.volume }
        if (vTop > 0) {
            val vHi = vTop * 1.1
            fun vy(v: Double) = y1 + h1 * (1 - (v / vHi).toFloat())
            val bw = max(1f, step * 0.62f)
            for (k in candles) {
                val x = xt(k.t)
                drawRect((if (k.close >= k.open) Brand.lime else Brand.mandarin).copy(alpha = 0.55f), Offset(x - bw / 2, vy(k.volume)), Size(bw, y2 - vy(k.volume)))
            }
            // Every step, the zero too (it reads "—" at the foot of the pane, as on the site).
            for (v in niceTicks(0.0, vHi, 3)) {
                val r = m.measure(volumeLabel(v), axisStyle)
                drawText(r, topLeft = Offset(w + 6.dp.toPx(), (vy(v) - r.size.height / 2).coerceIn(y1, y2 - r.size.height)))
            }
        }

        // PINR Index line pane: a fixed 0 to 100 scale, as the site's.
        drawLine(sep, Offset(0f, y2), Offset(size.width, y2), 1f)
        fun my(v: Double) = y2 + h2 * (1 - (v / 100.0).toFloat().coerceIn(0f, 1f))
        for (v in listOf(40.0, 80.0)) {
            val r = m.measure(Format.fixed(v, 2), axisStyle)
            drawText(r, topLeft = Offset(w + 6.dp.toPx(), my(v) - r.size.height / 2))
        }
        if (metric != null) {
            for (lv in metric.levels) drawLine(Brand.fg.copy(alpha = 0.25f), Offset(0f, my(lv)), Offset(w, my(lv)), 1f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 4f)))
            clipRect(0f, y2, w, total) {
                val hb = max(1f, step * 0.62f)
                // The histogram sits low in the pane, behind the lines (the site's metric scale margins).
                val hMax = metric.histogram.maxOfOrNull { kotlin.math.abs(it.second) }?.takeIf { it > 0 } ?: 1.0
                val base = y2 + h2 * 0.98f
                for ((t, v) in metric.histogram) {
                    if (v == 0.0) continue
                    val bh = (kotlin.math.abs(v) / hMax).toFloat() * h2 * 0.26f
                    drawRect((if (v >= 0) Brand.lime else Brand.mandarin).copy(alpha = 0.4f), Offset(xt(t) - hb / 2, base - bh), Size(hb, bh))
                }
                fun series(p: List<Pair<Long, Double>>, c: Color) {
                    if (p.size < 2) return
                    drawPath(Path().apply { p.forEachIndexed { i, (t, v) -> if (i == 0) moveTo(xt(t), my(v)) else lineTo(xt(t), my(v)) } }, c, style = Stroke(2.dp.toPx()))
                }
                series(metric.signal, SIGNAL_PURPLE)
                series(metric.series, Brand.lime)
            }
            tag(m, Format.fixed(metric.series.last().second, 2), Brand.lime, w, my(metric.series.last().second))
        }
    }
}

/** A value's tag on the right axis: the text on a coloured chip. */
private fun DrawScope.tag(m: TextMeasurer, text: String, color: Color, w: Float, y: Float) {
    // Dark text on lime, light text on mandarin, as the site's tags.
    val ink = if (color == Brand.mandarin) Color.White else Brand.ink
    val r = m.measure(text, TextStyle(color = ink, fontSize = 9.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold))
    val yy = y.coerceIn(r.size.height / 2f + 1f, size.height - r.size.height / 2f - 1f)
    drawRoundRect(color, Offset(w + 2.dp.toPx(), yy - r.size.height / 2 - 1.dp.toPx()), Size(r.size.width + 8.dp.toPx(), r.size.height + 2.dp.toPx()), CornerRadius(2.dp.toPx()))
    drawText(r, topLeft = Offset(w + 6.dp.toPx(), yy - r.size.height / 2))
}
