package io.pinr.app.feed

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveCandleTest {
    private fun set(vararg rows: Candle, status: CandleSet.Status = CandleSet.Status.Ok) = CandleSet(rows.toList(), "x", status)

    @Test fun aPriceInsideTheNewestCandleMovesHighLowCloseAndAddsNoVolume() {
        val n = LiveCandle.fold(set(Candle(0, 1.0, 2.0, 1.0, 1.5, 10.0)), Timeframe.M1, 3.0, 30_000)!!
        assertEquals(1, n.candles.size)
        assertEquals(listOf(3.0, 3.0, 1.0, 10.0), listOf(n.candles[0].high, n.candles[0].close, n.candles[0].low, n.candles[0].volume))
    }

    @Test fun aLaterMinuteOpensANewCandleAtTheLastCloseAndATradeAddsItsDollars() {
        val n = LiveCandle.fold(set(Candle(0, 1.0, 2.0, 1.0, 1.5, 10.0)), Timeframe.M1, 1.2, 125_000, usd = 40.0)!!
        assertEquals(2, n.candles.size)
        val c = n.candles[1]
        assertEquals(listOf(120L, 1.5, 1.5, 1.2, 40.0), listOf(c.t, c.open, c.high, c.low, c.volume))
    }

    @Test fun aChartFoldsAtTheCandleSizeTheFeedGaveNotTheOneAsked() {
        val n = LiveCandle.fold(set(Candle(30, 1.0, 1.0, 1.0, 1.0, 0.0)).copy(bucketSec = 15), Timeframe.M15, 2.0, 47_000, usd = 1.0)!!
        assertEquals(listOf(30L, 45L), n.candles.map { it.t })
        assertEquals(15L, n.bucketSec)
    }

    @Test fun aPriceAloneNeverStartsAChartATradeMayAndOldOrStaleChangesNothing() {
        assertNull(LiveCandle.fold(set(), Timeframe.M1, 1.0, 60_000))
        assertEquals(1, LiveCandle.fold(set(), Timeframe.M1, 1.0, 60_000, usd = 5.0, start = true)!!.candles.size)
        assertNull(LiveCandle.fold(set(Candle(120, 1.0, 1.0, 1.0, 1.0, 0.0)), Timeframe.M1, 2.0, 30_000))
        assertNull(LiveCandle.fold(set(Candle(0, 1.0, 1.0, 1.0, 1.0, 0.0), status = CandleSet.Status.Stale), Timeframe.M1, 2.0, 30_000))
        assertNull(LiveCandle.fold(set(Candle(0, 1.0, 1.0, 1.0, 1.0, 0.0)), Timeframe.M1, Double.NaN, 30_000))
    }

    @Test fun aTrackedLineGetsTheLivePriceOnlyWhenItHasTwoPointsAndThePriceMovedNeverPast500() {
        assertEquals(listOf(1.0, 2.0, 3.0), LiveCandle.head(listOf(1.0, 2.0), 3.0))
        assertEquals(listOf(1.0, 2.0), LiveCandle.head(listOf(1.0, 2.0), 2.0))
        assertEquals(listOf(1.0), LiveCandle.head(listOf(1.0), 3.0))
        assertEquals(500, LiveCandle.head(List(500) { 1.0 }, 2.0).size)
    }

    @Test fun aTradeInTheStreamMessageReachesTheStoresRecentTrades() = runBlocking {
        val base = "http://feed"
        val http = Http { url ->
            if (url == "$base/api/tokens") 200 to """{"contract":"1.0","stream":{"boot":"b1","seq":5},"tokens":[{"address":"A1","coverage":50}]}""" else throw java.io.IOException("x")
        }
        val s = FeedStore(base, http, pageDelayMs = 0)
        s.poll()
        s.handleStream("changes", """{"boot":"b1","seq":6,"seen":[],"score":[],"graduation":[],"tick":[],"gone":[],"rest":[],"restGone":[],"trades":[{"address":"A1","atMs":1700000000000,"side":"buy","priceUsd":0.5,"usd":12}]}""")
        assertEquals(1, s.tickCount)
        assertTrue(s.recentTicks.first().address == "a1" && s.recentTicks.first().usd == 12.0)
    }

    @Test fun onlyAPriceTheMessageCarriesForACoinReachesItsChartSoAQuietCoinGrowsNoCandles() = runBlocking {
        val base = "http://feed"
        val http = Http { url ->
            if (url == "$base/api/tokens") 200 to """{"contract":"1.0","stream":{"boot":"b1","seq":5},"tokens":[{"address":"A1","coverage":50,"priceUsd":1.1},{"address":"A2","coverage":50,"priceUsd":2}]}""" else throw java.io.IOException("x")
        }
        val s = FeedStore(base, http, pageDelayMs = 0)
        s.poll()
        s.handleStream("changes", """{"boot":"b1","seq":6,"seen":[],"score":[],"graduation":[],"tick":[{"address":"a2","priceUsd":2.5},{"address":"a1","valuationUsd":9}],"gone":[],"rest":[],"restGone":[]}""")
        assertEquals(listOf("a2"), s.recentTicks.map { it.address })
        val chart = CandleSet(listOf(Candle(0, 1.0, 1.0, 1.0, 1.0, 0.0)), "x", CandleSet.Status.Ok)
        assertNull(LiveCandle.advance(chart, Timeframe.M1, "a1", s, 0).second)
        assertNull(LiveCandle.advance(chart, Timeframe.M1, "a2", s, 1).second)
        assertTrue(LiveCandle.advance(chart, Timeframe.M1, "a2", s, 0).second != null)
    }
}
