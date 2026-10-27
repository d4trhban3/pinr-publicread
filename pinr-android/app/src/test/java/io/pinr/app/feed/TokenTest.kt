package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The contract's rules for each token (DATA-CONTRACT.md), the same as the site's and the iPhone app's. */
class TokenTest {
    private val base = "http://10.0.2.2:8787"
    private fun make(w: WireToken) = Token.make(w, base)
    private fun shown(w: WireToken) = (make(w) as Token.Made.Shown).token

    @Test fun aNoScoreLabelAlwaysDropsTheNumber() {
        for (l in listOf("VAMP", "BOT/RUG", "MAYHEM", "HONEYPOT")) {
            val t = shown(WireToken("A", 50.0, score = 42.0, noScoreLabel = l))
            assertNull(t.score)
            assertEquals(l, t.label?.text)
            assertEquals(l, Format.score(t))
        }
    }

    @Test fun aScoreIsAWholeNumberFrom1To99() {
        assertEquals(1, shown(WireToken("A", 50.0, score = 1.0)).score)
        assertEquals(99, shown(WireToken("A", 50.0, score = 99.0)).score)
        for (bad in listOf(0.0, 100.0, 42.5, -3.0, Double.NaN, Double.POSITIVE_INFINITY)) {
            assertNull("score $bad", shown(WireToken("A", 50.0, score = bad)).score)
        }
    }

    @Test fun aTokenThatCannotBeShownIsLeftOutWithItsReason() {
        assertEquals(Token.Made.Left(Token.LeftOut.NoAddress), make(WireToken("  ", 50.0)))
        assertEquals(Token.Made.Left(Token.LeftOut.BadCoverage), make(WireToken("A", 101.0)))
        assertEquals(Token.Made.Left(Token.LeftOut.BadCoverage), make(WireToken("A", -1.0)))
        assertEquals(Token.Made.Left(Token.LeftOut.UnknownLabel), make(WireToken("A", 50.0, noScoreLabel = "SCAM")))
    }

    @Test fun aFigureOutOfItsRangeIsMissingNeverClampedOrGuessed() {
        val t = shown(
            WireToken(
                "A", 50.0, valuationUsd = -1.0, volume24hUsd = Double.NaN, change24hPct = -100.0, priceUsd = 0.0,
                athUsd = 0.0, liquidityUsd = -5.0, rank = 2.5, changeWindowH = 0.0, launchedAtMs = 0.0, name = "  ",
                priceSeries = listOf(1.0), flow = WireFlow(1.0, -1.0, 1.0, 1.0, 1.0, 1.0, null, true, null),
            ),
        )
        listOf(t.valuationUsd, t.volume24hUsd, t.change24hPct, t.priceUsd, t.athUsd, t.liquidityUsd, t.rank, t.changeWindowHours,
            t.launchedAtMs, t.name, t.priceSeries, t.flow).forEach { assertNull(it) }
        assertEquals(Format.DASH, Format.usdCompact(t.valuationUsd))
    }

    @Test fun picturesComeOnlyFromTheFeedServer() {
        assertEquals("$base/api/img?a=X", Token.sameServer("/api/img?a=X", base))
        assertEquals("$base/api/img?a=X", Token.sameServer("$base/api/img?a=X", base))
        assertNull(Token.sameServer("https://evil.example/api/img?a=X", base))
        assertNull(Token.sameServer("http://10.0.2.2:9999/api/img?a=X", base))
        assertNull(Token.sameServer("/api/other?a=X", base))
        assertNull(Token.sameServer("//evil.example/api/img", base))
        assertNull(Token.sameServer("http://u@10.0.2.2:8787/api/img", base))
        assertNull(Token.sameServer("/api/img", null))
    }

    @Test fun receiptsNeedBothSourceAndTime() {
        val t = shown(WireToken("A", 50.0, capSource = "GeckoTerminal", capAtMs = 1.7e12, athSource = "Pump.fun"))
        assertEquals(Token.Receipt("GeckoTerminal", 1_700_000_000_000), t.capReceipt)
        assertNull(t.athReceipt)
    }

    @Test fun coinsAreComparedWithoutLetterCase() {
        assertEquals(shown(WireToken("AbC", 1.0)).id, shown(WireToken("abc", 1.0)).id)
        assertTrue(shown(WireToken("AbC", 1.0)).address == "AbC")
    }
}
