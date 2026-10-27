package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RankingTest {
    private val now = 1_800_000_000_000L
    private fun t(a: String, score: Int? = null, cov: Double = 50.0, label: NoScoreLabel? = null, cap: Double? = null, ageMin: Double? = null, n5m: Int = 0) =
        Token(
            a, score = score, coverage = cov, label = label, valuationUsd = cap,
            launchedAtMs = ageMin?.let { now - (it * 60_000).toLong() },
            flow = if (n5m > 0) Token.Flow(1.0, 1.0, 1.0, 1.0, n5m, n5m, false, true) else null,
        )

    @Test fun featuredPumpCoinsComeFirstThenOtherLaunchpadsFillTheRoomLeft() {
        fun pad(a: String, score: Int, launchpad: String) = t(a, score).copy(launchpad = launchpad)
        val all = listOf(pad("c1", 99, "Raydium LaunchLab"), pad("p1", 60, "Pump.fun"), pad("p2", 70, "PumpSwap (graduated)"), pad("b1", 80, "Bankr"))
        assertEquals(listOf("p2", "p1", "c1", "b1"), Ranking.rankFeatured(PinrFilter.PinrScore, all, nowMs = now, limit = 10).map { it.address })
        assertEquals(listOf("p2", "p1"), Ranking.rankFeatured(PinrFilter.PinrScore, all, nowMs = now, limit = 2).map { it.address })
    }

    @Test fun pinrscoreShowsOnlyRealScoresBestFirst() {
        val r = Ranking.rank(PinrFilter.PinrScore, listOf(t("a", 40), t("b", 90), t("c", null), t("d", 70, label = NoScoreLabel.Vamp), t("e", 60, cov = 0.0)), nowMs = now)
        assertEquals(listOf("b", "a"), r.map { it.address })
    }

    @Test fun newLaunchesAreUnderAnHourYoungestFirst() {
        val r = Ranking.rank(PinrFilter.New, listOf(t("a", ageMin = 30.0), t("b", ageMin = 5.0), t("c", ageMin = 90.0), t("d")), nowMs = now)
        assertEquals(listOf("b", "a"), r.map { it.address })
    }

    @Test fun trendingPutsBusyBeforeQuietWithNoOrderOfItsOwnForUnscoredCoins() {
        val r = Ranking.rank(PinrFilter.Trending, listOf(t("unread", cov = 0.0, n5m = 300), t("quiet", 50), t("busy", 50, n5m = 100)), nowMs = now)
        assertEquals(listOf("unread", "busy", "quiet"), r.map { it.address })
    }

    /** `trending-site.json` is the site's own `selectAndRank("trending")` over coins seen or scored at different times (generator beside it). */
    @Test fun trendingIsTheSitesOrderScoredFirstThenNewUnscoredThenTheRest() {
        val site = org.json.JSONObject(javaClass.classLoader!!.getResource("trending-site.json")!!.readText())
        val n = site.getLong("now")
        val coins = site.getJSONArray("coins")
        val tokens = (0 until coins.length()).map { i ->
            val c = coins.getJSONObject(i)
            val at = if (c.isNull("offsetMs")) null else n + c.getLong("offsetMs")
            val n5 = c.getInt("trades5m")
            Token(
                c.getString("id"), coverage = if (c.optString("kind") == "seen") 0.0 else 10.0, seen = c.optString("kind") == "seen",
                score = if (c.optString("kind") == "scored") 50 else null, seenAtMs = if (c.optString("kind") == "seen") at else null, asOfMs = if (c.optString("kind") == "scored") at else null,
                flow = if (n5 > 0) Token.Flow(1.0, 1.0, 1.0, 1.0, n5, n5, false, true) else null,
            )
        }
        val want = site.getJSONArray("order").let { a -> (0 until a.length()).map { a.getString(it) } }
        assertEquals(want, Ranking.rank(PinrFilter.Trending, tokens, nowMs = n).map { it.address })
    }

    @Test fun anUnscoredCoinCountsFromWhenItWasMetElseItsLaunchNeverFromAsOf() {
        val h = 3_600_000L
        val list = listOf(
            Token("Retrying", coverage = 0.0, launchedAtMs = now - 72 * h, asOfMs = now - 30_000),
            Token("Seen2h", coverage = 0.0, seen = true, seenAtMs = now - 2 * h),
            Token("Launched1h", coverage = 0.0, launchedAtMs = now - h),
            Token("Scored", score = 40, coverage = 50.0, asOfMs = now - h),
        )
        assertEquals(listOf("Scored", "Launched1h", "Seen2h", "Retrying"), Ranking.rank(PinrFilter.Trending, list, nowMs = now).map { it.address })
    }

    @Test fun baseBnbShowsOnlyThoseChainsNewestFirstByWhenMetElseLaunchAndNoTimeLast() {
        val ago = { s: Long -> now - s * 1000 }
        val list = listOf(
            Token("Sol", coverage = 0.0, chain = "solana", launchedAtMs = ago(10)),
            Token("NoTime", coverage = 0.0, chain = "bsc"),
            Token("OldBase", coverage = 0.0, chain = "base", launchedAtMs = ago(7200)),
            Token("NewBsc", coverage = 0.0, chain = "bsc", launchedAtMs = ago(60)),
            Token("SeenBase", coverage = 0.0, chain = "base", seen = true, seenAtMs = ago(30), launchedAtMs = ago(9000)),
        )
        assertEquals(listOf("SeenBase", "NewBsc", "OldBase", "NoTime"), DiscoverRanking.rank(DiscoverTab.BaseBnb, list).map { it.address })
    }

    @Test fun moversRankTheBiggestSwingFirstAndTiesKeepTheFeedsOrder() {
        val r = Ranking.rank(PinrFilter.Movers, listOf(t("a", 50), t("b", 50), t("c", 50)), moved = mapOf("b" to -9, "c" to 3), nowMs = now)
        assertEquals(listOf("b", "c", "a"), r.map { it.address })
    }

    @Test fun thePageShowsTheTopNinety() {
        assertEquals(90, Ranking.rank(PinrFilter.Trending, (1..200).map { t("c$it", 50) }, nowMs = now).size)
    }

    @Test fun aRibbonNeedsTradesInTheHour() {
        assertNull(Ribbon.of(null))
        assertNull(Ribbon.of(Token.Flow(0.0, 0.0, 0.0, 0.0, 0, 0, false, true)))
        assertEquals(0.75, Ribbon.of(Token.Flow(3.0, 1.0, 0.0, 0.0, 4, 4, false, true))!!.buyShare, 1e-9)
        assertEquals(0.5, Ribbon.of(Token.Flow(2.0, 0.0, 2.0, 0.0, 2, 2, false, true))!!.buyShare, 1e-9) // too few trades to mean a mix
    }
}

/** tiles. */
class Tile260Test {
    @Test fun aTradesSizeIsItsHeightABuyRidesAboveTheLineASellBelowSwoopingAtNow() {
        assertEquals(-0.17, Ribbon.sizeOffset(1.0, true, 0.5), 1e-9)
        assertEquals(0.17, Ribbon.sizeOffset(1.0, false, 0.5), 1e-9)
        assertEquals(0.0, Ribbon.sizeOffset(0.0, true, 1.0), 1e-9)
        assertEquals(-0.17 * 1.6, Ribbon.sizeOffset(1.0, true, 1.0), 1e-9)
        assertEquals(0.17, Ribbon.sizeOffset(2.0, false, 0.0), 1e-9)
    }

    @Test fun theHoursTradesRideBesideTheMarketCapADashWhenNoSourceCountsThemAndCountsAreShort() {
        assertEquals("\$3.9K · — tx", Format.tilePlusTrades("\$3.9K", null))
        assertEquals("\$3.9K · 20 tx/1h", Format.tilePlusTrades("\$3.9K", Token.Flow(1.0, 1.0, 1.0, 1.0, 3, 20, false, true)))
        assertEquals(listOf("87", "1,240", "12.4K", "1.2M"), listOf(87, 1240, 12_400, 1_200_000).map { Format.countShort(it) })
    }
}

/** the PvP Arena, and the engine's hourly count on tiles. */
class ArenaTest {
    @Test fun aGroupsMembersThe500PlusFloorAndTheDashesABadGroupOrMemberIsDroppedAlone() {
        val json = """{"groups":[{"id":"g1","title":"musepad","ticker":"${'$'}musepad","members":[
            {"address":"A1","name":"musepad","ticker":"${'$'}musepad","chain":"solana","launchpad":"PumpSwap (graduated)","launchedAtMs":1792950084000,"recentTrades":500,"recentUsd":20893.3,"recentAtLeast":true,"volume24hUsd":58086,"xPosts":0,"hasX":true,"change24hPct":12.5,"valuationUsd":41802,"earliest":true},
            {"address":"B1","name":"musepad","chain":"bsc","recentTrades":0,"recentUsd":0,"recentAtLeast":false,"volume24hUsd":null,"xPosts":null,"hasX":false,"change24hPct":null,"valuationUsd":null,"earliest":false},
            {"name":"no address"}]},{"title":"no id"}]}"""
        val g = ArenaWire.parse(json)!!
        assertEquals(1, g.size); assertEquals(2, g[0].members.size)
        val a = g[0].members[0]; val b = g[0].members[1]
        assertEquals(listOf("${'$'}20.9K+ · 500+ tx", "0 posts", "true"), listOf(a.recentText, a.xText, a.earliest.toString()))
        assertEquals(listOf("${Format.money(0.0)} · 0 tx", "—"), listOf(b.recentText, b.xText)); assertNull(b.volume24h); assertNull(b.valuation)
    }

    @Test fun aMemberWhose30MinuteFiguresWereNotReadYetShowsADashAndAMissingFieldCountsAsRead() {
        val json = """{"groups":[{"id":"g","title":"t","ticker":"${'$'}t","members":[{"address":"A1","recentKnown":false,"recentTrades":0,"recentUsd":0},{"address":"B1","recentTrades":3,"recentUsd":12}]}]}"""
        val m = ArenaWire.parse(json)!![0].members
        assertEquals("—", m[0].recentText); assertEquals("${Format.money(12.0)} · 3 tx", m[1].recentText)
    }

    @Test fun aNameOrTickerMadeOnlyOfInvisibleCharactersCountsAsMissingAndTheShortAddressShows() {
        val json = """{"groups":[{"id":"g","title":"t","ticker":"${'$'}t","members":[{"address":"AbCdEfGhIjKlMnOpQrSt","name":"\u200B\u2060\u3164","ticker":"\u200B","recentTrades":0,"recentUsd":0}]}]}"""
        val m = ArenaWire.parse(json)!![0].members[0]
        assertNull(m.name); assertNull(m.ticker)
    }

    @Test fun theEnginesHourlyTradeCountIsPreferredOnATileThenTheFeedsThenADash() {
        val flow = Token.Flow(1.0, 1.0, 1.0, 1.0, 3, 20, false, true)
        assertEquals("${'$'}1K · 87 tx/1h", Format.tilePlusTrades("${'$'}1K", flow, 87))
        assertEquals("${'$'}1K · 20 tx/1h", Format.tilePlusTrades("${'$'}1K", flow))
        assertEquals("${'$'}1K · — tx", Format.tilePlusTrades("${'$'}1K", null))
    }
}

class InvisibleTest {
    @Test fun zeroWidthAndInvisibleCharactersAreTakenOutOfNamesAndTickersPlainTextEmojiAndAccentsStay() {
        assertEquals("Blind Ape", Invisible.strip("Blind\u2060 Ape"))
        assertEquals("abcdef", Invisible.strip("a\u200Bb\u200Dc\uFEFFd\u00ADe\u202Ef"))
        assertEquals("Café \uD83D\uDC38 ÿ", Invisible.strip("Café \uD83D\uDC38 ÿ"))
        // A joiner between two emoji stays (one built emoji); a lone joiner goes; a variation selector 16 stays only after an emoji; spaces collapse.
        assertEquals("\uD83D\uDC68\u200D\uD83D\uDCBB Dev", Invisible.strip("\uD83D\uDC68\u200D\uD83D\uDCBB Dev"))
        assertEquals("ab \uD83D\uDC68", Invisible.strip("a\u200Db \uD83D\uDC68\u200D"))
        assertEquals("\u2764\uFE0F x", Invisible.strip("\u2764\uFE0F x\uFE0F"))
        assertEquals("a b", Invisible.strip("  a \u0007  b\u3164 "))
    }
}
