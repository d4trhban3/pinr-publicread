package io.pinr.app.feed

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.max

/**
 * The chart's indicators and drawing maths against the SITE's own code: `indicators-site.json` is what pinr-live's
 * world/indicators.ts, indicatorspecs.ts and drawmath.ts return for a fixed 90-candle series and fixed cases
 * (generator kept beside it as indicators-site.gen.ts.txt). Every value must agree; "not yet" (NaN) must agree too.
 */
class IndicatorsTest {
    private val site = JSONObject(javaClass.classLoader!!.getResource("indicators-site.json")!!.readText())
    private val candles = site.getJSONArray("candles").let { a ->
        (0 until a.length()).map { i -> a.getJSONArray(i).let { Candle(it.getLong(0), it.getDouble(1), it.getDouble(2), it.getDouble(3), it.getDouble(4), it.getDouble(5)) } }
    }

    private fun same(key: String, ours: DoubleArray) {
        val want = site.getJSONArray(key)
        assertEquals("$key length", want.length(), ours.size)
        for (i in 0 until want.length()) {
            if (want.isNull(i)) { assertTrue("$key[$i] should be not-yet, was ${ours[i]}", !ours[i].isFinite()); continue }
            val w = want.getDouble(i)
            assertTrue("$key[$i]: site $w, app ${ours[i]}", abs(w - ours[i]) <= 1e-9 * max(1.0, abs(w)))
        }
    }

    @Test fun everyIndicatorMatchesTheSite() {
        same("sma20", Ind.sma(candles, 20))
        same("ema9", Ind.ema(candles, 9))
        same("vwap", Ind.vwap(candles))
        Ind.bollinger(candles, 20, 2.0).let { same("bbMid", it.mid); same("bbUp", it.upper); same("bbLo", it.lower) }
        same("rsi14", Ind.rsi(candles, 14))
        Ind.macd(candles, 12, 26, 9).let { same("macdLine", it.line); same("macdSignal", it.signal); same("macdHist", it.hist) }
        same("volAvg20", Ind.volumeAverage(candles, 20))
        Ind.stochastic(candles, 14, 3, 3).let { same("stochK", it.k); same("stochD", it.d) }
        same("atr14", Ind.atr(candles, 14))
        same("obv", Ind.obv(candles))
        Ind.ichimoku(candles, 9, 26, 52).let { same("tenkan", it.tenkan); same("kijun", it.kijun); same("spanA", it.spanA); same("spanB", it.spanB) }
    }

    /** The token bar's move: the last 24 hours of candles, from the first open inside the window to the last close. */
    @Test fun change24hMatchesTheSite() {
        val ch = site.getJSONArray("ch")
        val c2 = candles.mapIndexed { i, k -> k.copy(t = 1_760_000_000L + i * 1800L) }
        assertEquals(ch.getDouble(0), Ind.change24h(candles)!!, 1e-9)
        assertEquals(ch.getDouble(1), Ind.change24h(c2)!!, 1e-9)
        assertTrue(ch.isNull(2)); assertEquals(null, Ind.change24h(candles.take(1)))
    }

    @Test fun supertrendLineAndSideMatchTheSite() {
        val s = Ind.supertrend(candles, 10, 3.0)
        same("superLine", s.line)
        val up = site.getJSONArray("superUp")
        for (i in 0 until up.length()) assertEquals("superUp[$i]", up.getBoolean(i), s.up[i])
    }

    @Test fun heikinAshiMatchesTheSite() {
        val ha = Ind.heikinAshi(candles)
        val want = site.getJSONArray("ha")
        for (i in 0 until want.length()) {
            val w = want.getJSONArray(i)
            listOf(ha[i].open, ha[i].high, ha[i].low, ha[i].close).forEachIndexed { j, v -> assertEquals("ha[$i][$j]", w.getDouble(j), v, 1e-12) }
        }
    }

    @Test fun labelsReadAsTheSitesLegend() {
        val d = IndSpecs.defaults()
        val want = site.getJSONArray("specs")
        assertEquals(want.length(), IndSpecs.SPECS.size)
        IndSpecs.SPECS.forEachIndexed { i, s ->
            assertEquals(want.getJSONObject(i).getString("id"), s.id.name.lowercase())
            assertEquals(want.getJSONObject(i).getString("label"), IndSpecs.label(s, d.getValue(s.id)))
        }
    }

    /** Saved choices, good and bad, read back exactly as the site's parseStates (limits, whole numbers, unknown colours). */
    @Test fun savedChoicesAreReadBackAsTheSiteDoes() {
        val raws = site.getJSONArray("raws"); val parsed = site.getJSONArray("parsed")
        for (i in 0 until raws.length()) {
            val raw = raws.opt(i)
            // The site is handed the stored value itself; the app is handed the stored text.
            val text = if (raw == null || raw == JSONObject.NULL) null else if (raw is String) raw else raw.toString()
            val ours = IndSpecs.parse(text)
            val want = parsed.getJSONObject(i)
            for (s in IndSpecs.SPECS) {
                val w = want.getJSONObject(s.id.name.lowercase()); val o = ours.getValue(s.id)
                assertEquals("case $i ${s.id} on", w.getBoolean("on"), o.on)
                assertEquals("case $i ${s.id} color", w.getString("color"), o.color.name.lowercase())
                s.params.forEach { q -> assertEquals("case $i ${s.id}.${q.key}", w.getJSONObject("params").getInt(q.key), o.params[q.key]) }
            }
        }
    }

    @Test fun choicesSurviveAWriteAndARead() {
        val st = IndSpecs.defaults().toMutableMap()
        st[IndId.Macd] = IndSpecs.State(true, mapOf("f" to 8, "s" to 21, "g" to 5), ChartColor.Orange)
        assertEquals(st, IndSpecs.parse(IndSpecs.write(st)))
    }

    @Test fun drawingMathsMatchesTheSite() {
        assertEquals(site.getJSONArray("fib").let { a -> (0 until a.length()).map { a.getDouble(it) } }, DrawMath.FIB_LEVELS)
        val pts = site.getJSONArray("pts"); val meas = site.getJSONArray("meas")
        for (i in 0 until pts.length()) {
            val (a, b) = (0..1).map { pts.getJSONArray(i).getJSONObject(it).let { p -> DrawPoint(p.getDouble("t"), p.getDouble("p")) } }
            val m = DrawMath.measure(a, b, 900.0); val w = meas.getJSONObject(i)
            if (w.isNull("pct")) assertTrue(m.pct.isNaN()) else assertEquals(w.getDouble("pct"), m.pct, 1e-9)
            assertEquals(w.getLong("bars"), m.bars)
            assertEquals(w.getDouble("seconds"), m.seconds, 0.0)
        }
        val durs = site.getJSONArray("durs")
        listOf(0.0, 59.0, 60.0, 3600.0, 3660.0, 86400.0, 90000.0, 93720.0, -1.0).forEachIndexed { i, s -> assertEquals("durationText($s)", durs.getString(i), DrawMath.durationText(s)) }
        val sh = site.getJSONArray("shifts")
        assertEquals(sh.getDouble(0), DrawMath.channelShift(DrawPoint(0.0, 1.0), DrawPoint(10.0, 2.0), DrawPoint(5.0, 3.0)), 1e-12)
        assertEquals(sh.getDouble(1), DrawMath.channelShift(DrawPoint(4.0, 1.0), DrawPoint(4.0, 2.0), DrawPoint(9.0, 7.0)), 1e-12)
    }

    @Test fun everyToolNeedsAsManyTapsAsOnTheSite() {
        val site = mapOf("H" to 1, "V" to 1, "Text" to 1, "Ray" to 2, "Trend" to 2, "Rect" to 2, "Fib" to 2, "Measure" to 2, "Channel" to 3)
        DrawKind.entries.forEach { assertEquals(it.name, site.getValue(it.name), it.needs); assertEquals(it.name, it.needs, it.hints.size) }
    }
}
