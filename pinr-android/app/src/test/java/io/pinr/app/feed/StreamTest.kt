package io.pinr.app.feed

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamTest {
    private fun copy(): StreamCopy = StreamCopy().apply {
        load(JSONArray("""[{"address":"AbC","coverage":50,"score":60,"valuationUsd":1000},{"address":"dEf","coverage":50}]"""), StreamPosition("b1", 10))
    }

    private fun msg(seq: Int, boot: String = "b1", seen: String = "[]", score: String = "[]", tick: String = "[]", gone: String = "[]", rest: String = "[]", restGone: String = "[]") =
        """{"boot":"$boot","seq":$seq,"seen":$seen,"score":$score,"graduation":[],"tick":$tick,"gone":$gone,"rest":$rest,"restGone":$restGone}"""

    @Test fun aTickMergesOnlyTheChangedFieldsAndNullTakesAFieldAway() {
        val c = copy()
        val o = c.apply(msg(11, tick = """[{"address":"abc","valuationUsd":2000,"score":null}]""")) as StreamCopy.Outcome.Applied
        assertEquals(listOf("abc"), o.changed)
        assertEquals(listOf("abc", "def"), c.order)
        assertEquals(2000.0, c.wire("abc")!!.valuationUsd!!, 0.0)
        assertNull(c.wire("abc")!!.score)
        assertEquals(StreamPosition("b1", 11), c.position)
    }

    @Test fun aCoinSeenJoinsLastAndACoinGoneLeaves() {
        val c = copy()
        c.apply(msg(11, seen = """[{"address":"New1","coverage":0}]"""))
        assertEquals(listOf("abc", "def", "new1"), c.order)
        val o = c.apply(msg(12, gone = """["abc"]""")) as StreamCopy.Outcome.Applied
        assertEquals(listOf("abc"), o.gone)
        assertEquals(listOf("def", "new1"), c.order)
        assertNull(c.wire("abc"))
    }

    @Test fun anOldMessageIsIgnoredAndAGapOrAnotherBootAsksForAFreshRead() {
        val c = copy()
        assertEquals(StreamCopy.Outcome.Ignored, c.apply(msg(10)))
        assertEquals(StreamCopy.Outcome.Reset, c.apply(msg(12)))
        assertEquals(StreamCopy.Outcome.Reset, c.apply(msg(11, boot = "other")))
        assertEquals(StreamPosition("b1", 10), c.position)
    }

    @Test fun serverSentEventsADataLineCompletesTheMessageNamedBeforeIt() {
        val l = SseLines()
        assertNull(l.take("retry: 5000")); assertNull(l.take("id: b1.11")); assertNull(l.take("event: changes"))
        assertEquals("changes" to """{"seq":11}""", l.take("""data: {"seq":11}"""))
        assertNull(l.take(": ping"))
        assertEquals("message" to "x", l.take("data: x"))
    }

    @Test fun aCoinWithNeitherPictureNorChartIsHeldBackFromTheTiles() {
        fun tok(extra: String) = (Token.make(Wire.token(org.json.JSONObject("""{"address":"A1","coverage":0$extra}"""))!!, "http://feed") as Token.Made.Shown).token
        assertFalse(tok("").hasSomethingToShow)
        assertTrue(tok(""","priceSeries":[1,2,3]""").hasSomethingToShow)
        assertTrue(tok(""","priceSeries":[1,0]""").hasSomethingToShow) // the site counts any two points
        assertFalse(tok(""","priceSeries":[1]""").hasSomethingToShow)
        assertTrue(tok(""","imageUrl":"/api/img?u=a"""").hasSomethingToShow)
    }

    @Test fun theStoreFollowsTheStreamAndAGapReadsTheListsAgain() = runBlocking {
        val base = "http://feed"
        val first = """{"contract":"1.0","stream":{"boot":"b1","seq":5},"tokens":[{"address":"A1","coverage":50,"valuationUsd":10},{"address":"A2","coverage":50}]}"""
        val http = object : Http {
            val asked = mutableListOf<String>()
            override fun get(url: String): Pair<Int, String> {
                asked += url
                return when (url) {
                    "$base/api/tokens" -> 200 to first
                    "$base/api/tokens/rest?offset=0&limit=1000" -> 200 to """{"contract":"1.0","total":0,"offset":0,"tokens":[]}"""
                    else -> throw java.io.IOException("unreachable")
                }
            }
        }
        val s = FeedStore(base, http, pageDelayMs = 0)
        s.poll()
        assertEquals(2, s.data.value.firstPageCount)
        s.handleStream("changes", msg(6, tick = """[{"address":"a1","valuationUsd":99}]""", rest = """[{"address":"R1","coverage":50}]"""))
        assertEquals(99.0, s.data.value.all.first().valuationUsd!!, 0.0)
        assertEquals(listOf("a1", "a2", "r1"), s.data.value.all.map { it.id })
        assertEquals(FeedStore.StreamEnd.Reloaded, s.handleStream("changes", msg(9)))
        assertEquals(2, http.asked.count { it == "$base/api/tokens" })
    }

    @Test fun jupiterAndStonkFunAreSourcesAReceiptMayName() {
        assertTrue("Jupiter" in Dossier.SOURCES && "Stonk.fun" in Dossier.SOURCES)
    }
}

class SweepTest {
    @Test fun theRestIsReadInPagesOfAThousandTwoAtATimeAndKeptInOrder() = runBlocking {
        val base = "http://feed"
        fun page(offset: Int, total: Int) = """{"contract":"1.0","total":$total,"offset":$offset,"tokens":[${(offset until minOf(total, offset + 1000)).joinToString(",") { """{"address":"R$it","coverage":40}""" }}]}"""
        val http = Http { url ->
            when {
                url == "$base/api/tokens" -> 200 to """{"contract":"1.0","tokens":[]}"""
                url.startsWith("$base/api/tokens/rest?offset=") -> 200 to page(url.substringAfter("offset=").substringBefore("&").toInt(), 2403)
                else -> throw java.io.IOException("unreachable")
            }
        }
        val s = FeedStore(base, http, pageDelayMs = 0)
        s.poll()
        s.sweep()
        val d = s.data.value
        assertEquals(2403, d.all.size)
        assertEquals("R0", d.all.first().address)
        assertEquals("R2402", d.all.last().address)
        assertEquals(2403, d.restLoaded)
    }
}
