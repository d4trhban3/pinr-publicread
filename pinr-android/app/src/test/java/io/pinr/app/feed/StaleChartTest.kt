package io.pinr.app.feed

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

/**
 * a "stale" chart answer (the source busy, the last good candles and their read time `asOfMs`) is drawn
 * and says when it was read; it never passes as current, and a status the app does not know is busy (no chart), as
 * `contract/DATA-CONTRACT.md` says.
 */
class StaleChartTest {
    private val k = "[1760000000,1,2,0.5,1.5,10],[1760000900,1.5,2,1,1.8,12]"
    private fun read(body: String) = CoinWire.candles(body)!!

    @Test fun aStaleAnswerIsDrawnWithItsReadTime() {
        val s = read("""{"status":"stale","source":"GeckoTerminal","candles":[$k],"asOfMs":1792152097000}""")
        assertEquals(CandleSet.Status.Stale, s.status)
        assertTrue(s.drawable)
        assertEquals(1792152097000L, s.asOf)
    }

    @Test fun aGoodAnswerIsCurrent() {
        val s = read("""{"status":"ok","source":"GeckoTerminal","candles":[$k],"asOfMs":1792152097000}""")
        assertTrue(s.drawable)
        assertNull("an ok answer is current even if it names a time", s.asOf)
    }

    /** Never current by mistake: stale without its read time or its candles, an unknown word, or no status at all. */
    @Test fun anythingThatCouldPassAsCurrentIsBusy() {
        for (body in listOf(
            """{"status":"stale","source":"GeckoTerminal","candles":[$k]}""",
            """{"status":"stale","source":"GeckoTerminal","candles":[$k],"asOfMs":"1792152097000"}""",
            """{"status":"stale","source":"GeckoTerminal","candles":[$k],"asOfMs":0}""",
            """{"status":"stale","source":"GeckoTerminal","candles":[],"asOfMs":1792152097000}""",
            """{"status":"partial","source":"GeckoTerminal","candles":[$k]}""",
            """{"status":"OK","source":"GeckoTerminal","candles":[$k]}""",
            """{"source":"GeckoTerminal","candles":[$k]}""",
        )) {
            val s = read(body)
            assertEquals(body, CandleSet.Status.Busy, s.status)
            assertFalse(body, s.drawable)
            assertNull(body, s.asOf)
        }
    }

    @Test fun theOtherAnswersAreUnchanged() {
        assertEquals(CandleSet.Status.Busy, read("""{"status":"busy","source":"GeckoTerminal","candles":[]}""").status)
        assertEquals(CandleSet.Status.None, read("""{"status":"none","source":"GeckoTerminal","candles":[]}""").status)
        assertEquals(CandleSet.Status.Error, read("""{"status":"error","source":"GeckoTerminal","candles":[]}""").status)
    }

    /** "as of 2:32 PM" exactly as the site's formatAsOf writes it (made in node, TZ=UTC; generator beside the table). */
    @Test fun asOfReadsAsTheSitesFormatAsOf() {
        val a = JSONArray(javaClass.classLoader!!.getResource("asof-site.json")!!.readText())
        for (i in 0 until a.length()) {
            val r = a.getJSONObject(i)
            assertEquals(r.getString("text"), Format.asOf(r.getLong("ms"), ZoneOffset.UTC))
        }
    }
}
