package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** a trade from the stream moves the tile at once. */
class LiveFoldTest {
    private val at = 2_000_000_000_000L
    private fun coin(price: Double? = 2.0, cap: Double? = 1000.0) = Token(
        "A", coverage = 50.0, priceUsd = price, valuationUsd = cap, priceSeries = listOf(1.0, 2.0),
        flow = Token.Flow(10.0, 5.0, 20.0, 15.0, 3, 8, false, true),
    )

    @Test fun thePriceBecomesTheTradesTheCapScalesByNewOverOldAndTheLineGetsItsNewestPoint() {
        val t = coin().foldedTrade(LiveTick("a", at, 3.0, 4.0, true))
        assertEquals(listOf(3.0, 1500.0), listOf(t.priceUsd, t.valuationUsd))
        assertEquals(listOf(1.0, 2.0, 3.0), t.priceSeries); assertEquals(at, t.lastTradeMs)
    }

    @Test fun aCoinWithNoCapKeepsNoneAndACoinWithNoOldPriceKeepsItsCap() {
        val noCap = coin(cap = null).foldedTrade(LiveTick("a", at, 3.0, 4.0, true))
        assertNull(noCap.valuationUsd); assertEquals(3.0, noCap.priceUsd)
        val noPrice = coin(price = null).foldedTrade(LiveTick("a", at, 3.0, 4.0, false))
        assertEquals(1000.0, noPrice.valuationUsd); assertEquals(3.0, noPrice.priceUsd)
    }

    @Test fun theRibbonTakesTheTradeDollarsToTheRightSideAndOneMoreTradeInTheCount() {
        val buy = coin().foldedTrade(LiveTick("a", at, 3.0, 4.0, true)).flow!!
        assertEquals(listOf(14.0, 5.0, 24.0), listOf(buy.buy5m, buy.sell5m, buy.buy1h)); assertEquals(listOf(4, 9), listOf(buy.trades5m, buy.trades1h))
        val sell = coin().foldedTrade(LiveTick("a", at, 3.0, 4.0, false)).flow!!
        assertEquals(listOf(10.0, 9.0, 19.0), listOf(sell.buy5m, sell.sell5m, sell.sell1h))
        assertEquals(3, coin().foldedTrade(LiveTick("a", at, 3.0, null, null)).flow!!.trades5m)
    }

    @Test fun anOlderTradeDoesNotMoveTheLastTradeTimeBackAndABadPriceChangesNothing() {
        val newer = coin().foldedTrade(LiveTick("a", at, 3.0, 1.0, true))
        val older = newer.foldedTrade(LiveTick("a", at - 60_000, 2.5, 1.0, true))
        assertEquals(listOf(at, 3.0), listOf(older.lastTradeMs, older.priceUsd)); assertEquals(newer.flow!!.trades5m + 1, older.flow!!.trades5m)
        assertEquals(2.0, coin().repricedTo(0.0).priceUsd); assertEquals(2.0, coin().repricedTo(Double.NaN).priceUsd)
    }
}
