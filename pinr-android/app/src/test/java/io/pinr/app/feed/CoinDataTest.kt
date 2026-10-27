package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The per-coin answers (candles, tape, events, PINRmetric, dossier) read as the site and the iPhone app read them. */
class CoinDataTest {
    @Test fun candlesKeepOnlyWholeRowsOldestFirst() {
        val s = CoinWire.candles(
            """{"tf":"5m","source":"GeckoTerminal","status":"ok","candles":[[200,1,2,0.5,1.5,10],[100,1,1.2,0.9,1.1,5],[300,1,0.5,2,1,1],[400,-1,2,1,1,1],[500,1,2,1,1],["x",1,2,1,1,1],[600,1,2,1,1,null]]}""",
        )!!
        assertEquals(listOf(100L, 200L), s.candles.map { it.t })
        assertEquals(CandleSet.Status.Ok, s.status)
        assertEquals("GeckoTerminal", s.source)
    }

    @Test fun aBusyChartSourceIsSaidNotHidden() {
        val s = CoinWire.candles("""{"tf":"1m","source":"GeckoTerminal","candles":[],"status":"busy"}""")!!
        assertEquals(CandleSet.Status.Busy, s.status)
        assertTrue(s.candles.isEmpty())
        // No status at all is not a known answer: busy, no chart.
        assertEquals(CandleSet.Status.Busy, CoinWire.candles("""{"candles":[]}""")!!.status)
    }

    @Test fun theLiteChartGoesLogPastSixTimes() {
        val k = { t: Long, lo: Double, hi: Double -> Candle(t, lo, hi, lo, hi, 1.0) }
        assertTrue(CandleSet(listOf(k(1, 1.0, 2.0), k(2, 2.0, 7.0)), null, CandleSet.Status.Ok).logScale)
        assertFalse(CandleSet(listOf(k(1, 1.0, 2.0), k(2, 2.0, 5.0)), null, CandleSet.Status.Ok).logScale)
    }

    @Test fun theTapeKeepsOnlyRealTrades() {
        val v = CoinWire.trades(
            """{"none":false,"trades":[[100,"buy",5],[101,"sell",2.5],[102,"hold",1],[103,"buy",0],[0,"buy",3]],"complete":false,"coversFrom":90,"asOf":110,"summary":{"buy5m":5,"sell5m":2.5,"buy1h":5,"sell1h":2.5,"n5m":2,"n1h":2,"complete":false}}""",
        )!!
        assertEquals(listOf(Trade(100, true, 5.0), Trade(101, false, 2.5)), v.trades)
        assertEquals(90L, v.coversFrom)
        assertEquals(2, v.summary!!.trades1h)
        assertTrue(CoinWire.trades("""{"none":true,"trades":[],"complete":false,"coversFrom":null,"asOf":null,"summary":null}""")!!.none)
    }

    @Test fun pressureWindowsAreTheSites() {
        val f = Token.Flow(5.0, 1.0, 9.0, 3.0, 2, 6, false, true)
        val capped = TradesView(false, emptyList(), complete = false, coversFrom = 1000, asOf = 1100, summary = f)
        assertEquals(listOf(PressureWindow("Newest trades (last 2 min)", 9.0, 3.0, 6, true)), pressureWindows(capped, 1120))
        assertEquals(listOf(PressureWindow("Newest trades (last 60 s)", 9.0, 3.0, 6, true)), pressureWindows(capped, 1060))
        val hour = pressureWindows(capped, 1000 + 1200)
        assertEquals("Last hour (at least)", hour[1].label)
        val full = pressureWindows(capped.copy(complete = true), 5000)
        assertEquals(listOf("Last 5 minutes", "Last hour"), full.map { it.label })
        assertTrue(pressureWindows(capped.copy(summary = null), 1100).isEmpty())
    }

    @Test fun eventsAndTheMetricAreReadLeniently() {
        val e = CoinWire.events("""{"events":[{"t":20,"kind":"score","tone":"good","text":"Score 40"},{"t":0,"kind":"x","text":"no date"},{"t":10,"kind":"flag","tone":"bad","text":"MAYHEM"}]}""")!!
        assertEquals(listOf(10L, 20L), e.map { it.t })
        assertNull(CoinWire.metric("""{"metric":{"series":[[1,36]]}}"""))
        assertNull(CoinWire.metric("""{"metric":null}"""))
        val m = CoinWire.metric("""{"metric":{"timeframe":"scan","series":[[2,40],[1,36]],"signal":[[1,36]],"histogram":[[1,0]],"levels":[50,"x"]}}""")!!
        assertEquals(listOf(1L to 36.0, 2L to 40.0), m.series)
        assertEquals(listOf(50.0), m.levels)
    }

    @Test fun similarTokensAreSameChainAndClose() {
        val now = 1_800_000_000_000L
        val base = Token("a", chain = "solana", coverage = 1.0, valuationUsd = 1e6, launchedAtMs = now - 3_600_000, launchpad = "Pump.fun")
        val near = Token("b", chain = "solana", coverage = 1.0, valuationUsd = 2e6, launchedAtMs = now - 3_600_000, launchpad = "Pump.fun")
        val far = Token("c", chain = "solana", coverage = 1.0, valuationUsd = 1e9)
        val other = Token("d", chain = "base", coverage = 1.0, valuationUsd = 1e6)
        assertEquals(listOf("b"), Similar.tokens(base, listOf(base, near, far, other), nowMs = now).map { it.address })
    }
}

class DossierTest {
    private val body = """{"available":true,
      "facts":[{"id":"valuation","label":"Valuation","value":"${'$'}322,823,996","source":"Solana chain","readAtMs":1792073347000,"link":"https://pump.fun/coin/X"},
               {"id":"x","label":"Unsourced","value":"${'$'}5","source":"Somewhere","readAtMs":1,"link":"https://a.b/"},
               {"id":"y","label":"No link","value":"7","source":"Pump.fun","readAtMs":1,"link":"javascript:alert(1)"},
               {"id":"w","label":"Launcher wallet","value":"7rdr…apTk","copy":"7rdrFULL","source":"Pump.fun","readAtMs":1,"link":"https://solscan.io/a"}],
      "checks":[{"name":"Liquidity lock","band":"Strong"},{"name":"Top holders","band":"Not read","reason":"could not be read"},{"name":"Bad","band":"Excellent"}],
      "read":["One line.",""],
      "links":[{"label":"X","url":"https://x.com/a"},{"label":"Bad","url":"ftp://a"}],
      "channels":[{"id":"x","label":"X","status":"listed","url":"https://x.com/a"},{"id":"w","label":"Website","status":"listed","url":"nope"},{"id":"t","label":"Telegram","status":"not_listed"}],
      "social":{"claims":[{"line":"Says A","result":"MATCHES","postUrl":"https://x.com/p/1"},{"line":"Says B","result":"MAYBE"}],"totals":{"MATCHES":1},"gaps":["a"]}}"""

    @Test fun aFigureWithoutItsWholeReceiptIsADash() {
        val d = Dossier.parse(body)!!
        assertEquals("${'$'}322,823,996", d.facts[0].value)
        assertEquals("Solana chain", d.facts[0].receipt!!.source)
        assertEquals(Format.DASH, d.facts[1].value) // not a named public source
        assertNull(d.facts[1].receipt)
        assertEquals(Format.DASH, d.facts[2].value) // not a web link
        assertEquals("7rdrFULL", d.facts[3].copy)
    }

    @Test fun checksLinksChannelsAndSocialAreKeptOnlyWhenWhole() {
        val d = Dossier.parse(body)!!
        assertEquals(listOf("Liquidity lock", "Top holders"), d.checks.map { it.name })
        assertEquals("could not be read", d.checks[1].reason)
        assertEquals(listOf("One line."), d.read)
        assertEquals(listOf("X"), d.links.map { it.label })
        assertEquals(listOf(Dossier.Channel.Status.Listed, Dossier.Channel.Status.Unknown, Dossier.Channel.Status.NotListed), d.channels.map { it.status })
        assertEquals(1, d.social!!.claims.size)
        assertEquals("1 claim read: 1 match, 0 differ, 0 cannot be checked, 0 not checkable.", Dossier.totalsSentence(d.social!!.totals))
        assertEquals("No claims were recorded.", Dossier.totalsSentence(emptyMap()))
    }

    @Test fun aFlaggedCoinShowsNoChecks() {
        val d = Dossier.parse("""{"available":true,"held":"flagged","checks":[{"name":"A","band":"Strong"}]}""")!!
        assertTrue(d.flagged)
        assertTrue(d.checks.isEmpty())
    }
}

class SiteFormatsTest {
    @Test fun pricesReadAsTheSitesFormatPrice() {
        assertEquals("$0.0448", Format.price(0.0448))
        assertEquals("$0.000457", Format.price(0.000457))
        assertEquals("$0.500", Format.price(0.5))
        assertEquals("$1.50", Format.price(1.5))
        assertEquals("$1,234.50", Format.price(1234.5))
        assertEquals(Format.DASH, Format.price(0.0))
        assertEquals("$0.0₄495", Format.priceCompact(0.0000495))
        assertEquals("$0.0₅495", Format.priceCompact(0.00000495))
        assertEquals("$0.0₇922", Format.priceCompact(0.0000000922))
        assertEquals("$0.0448", Format.priceCompact(0.0448))
        assertEquals("−$1.20", Format.priceChange(-1.2))
        assertEquals("$950.00", Format.money2(950.0)) // under $1,000 the trades list uses the compact price
        assertEquals("$1.5K", Format.money2(1500.0))
    }

    @Test fun agesReadAsTheSites() {
        assertEquals("1m", Format.ageText(0.2))
        assertEquals("41m", Format.ageText(41.0))
        assertEquals("3h", Format.ageText(170.0))
        assertEquals("2d", Format.ageText(60.0 * 50))
        assertEquals(Format.DASH, Format.ageText(null))
        val now = 1_800_000_000_000L
        assertEquals("just now", Format.scoredAgo(now - 30_000, now))
        assertEquals("41 min ago", Format.scoredAgo(now - 41 * 60_000, now))
        assertEquals("5 h ago", Format.scoredAgo(now - 5 * 3_600_000, now))
        assertEquals("1 day ago", Format.scoredAgo(now - 25 * 3_600_000, now))
        assertNull(Format.scoredAgo(null, now))
        assertEquals("12s", Format.tradeAgo(12))
        assertEquals("5m", Format.tradeAgo(300))
        assertEquals("2h", Format.tradeAgo(7200))
    }

    @Test fun aFlaggedCopyNotConfirmedIsUnchecked() {
        assertEquals("unchecked", Format.flagWord(Token("a", label = NoScoreLabel.Vamp, coverage = 0.0)))
        assertEquals("confirmed", Format.flagWord(Token("a", label = NoScoreLabel.Vamp, coverage = 0.0, copyOf = Token.CopyRef("b", null, true))))
        assertEquals("confirmed", Format.flagWord(Token("a", label = NoScoreLabel.Mayhem, coverage = 0.0)))
    }
}

class DiscoverAndWatchTest {
    @Test fun searchFindsByNameTickerOrLongAddressBiggestFirst() {
        val a = Token("AAAAAAAAAA1", name = "Doge Pepe", ticker = "\$DOPE", coverage = 1.0, valuationUsd = 1e3)
        val b = Token("BBBBBBBBBB2", name = "Pepe Max", ticker = "\$PMAX", coverage = 1.0, valuationUsd = 1e6)
        assertEquals(listOf("BBBBBBBBBB2", "AAAAAAAAAA1"), DiscoverRanking.rank(DiscoverTab.Trending, listOf(a, b), "pepe").map { it.address })
        assertEquals(listOf("AAAAAAAAAA1"), DiscoverRanking.rank(DiscoverTab.Trending, listOf(a, b), "\$dope").map { it.address })
        assertTrue(DiscoverRanking.rank(DiscoverTab.Trending, listOf(a, b), "aaaaa").isEmpty()) // under six characters
        assertEquals(1, DiscoverRanking.rank(DiscoverTab.Trending, listOf(a, b), "aaaaaa").size)
    }

    @Test fun moversPutAMissingChangeLast() {
        val ts = listOf(Token("a", coverage = 1.0), Token("b", coverage = 1.0, change24hPct = -40.0), Token("c", coverage = 1.0, change24hPct = 12.0))
        assertEquals(listOf("b", "c", "a"), DiscoverRanking.rank(DiscoverTab.Movers, ts).map { it.address })
    }

    @Test fun alertsFireOnlyOnARealPrice() {
        val up = PriceAlert("1", "k", "\$K", 2.0, "up", 0)
        val down = PriceAlert("2", "k", "\$K", 1.0, "down", 0)
        assertEquals("up", Watch.alertDir(2.0, 1.5))
        assertNull(Watch.alertDir(1.5, 1.5))
        assertNull(Watch.alertDir(2.0, null))
        val (fired, waiting) = Watch.check(listOf(up, down)) { 2.1 }
        assertEquals(listOf(up), fired)
        assertEquals(listOf(down), waiting)
        assertTrue(Watch.check(listOf(up)) { null }.first.isEmpty())
        assertEquals("Alert: \$K rose to $2.00 (+1 more)", Watch.toast(listOf(up, down)))
        assertEquals(listOf("x"), Watch.toggle(emptyList(), "x"))
        assertTrue(Watch.toggle(listOf("x"), "x").isEmpty())
    }
}
