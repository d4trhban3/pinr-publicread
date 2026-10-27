package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The coin page's outside links (the site's `chartLinks`, ui/coinpage.ts). */
class ChartLinksTest {
    private fun labels(chain: String?, lp: String?, tv: String? = null) = ChartLinks.links("Addr1", chain, lp, tv).map { it.label }

    @Test fun aPumpFunCoinGetsTheTwoChartSitesItsOwnPageTheExplorerAndTradingViewLast() {
        assertEquals(listOf("DexScreener", "GeckoTerminal", "Pump.fun", "Solscan", "TradingView"), labels("solana", "Pump.fun curve"))
        assertTrue("Pump.fun" in labels("solana", "PumpSwap (graduated)"))
        assertTrue("Pump.fun" !in labels("solana", "Raydium LaunchLab"))
    }

    @Test fun baseAndBnbChainGetTheirExplorerAndTheLaunchpadsOwnPage() {
        assertEquals(listOf("DexScreener", "GeckoTerminal", "Basescan", "Clanker", "TradingView"), labels("base", "Clanker"))
        assertTrue("Zora" in labels("base", "Zora") && "Virtuals" in labels("base", "Virtuals"))
        assertEquals(listOf("DexScreener", "GeckoTerminal", "BscScan", "Four.meme", "TradingView"), labels("bsc", "Four.meme"))
        assertTrue("Flap" in labels("bnb", "Flap"))
        assertTrue("Clanker" !in labels("bsc", "Flap"))
    }

    @Test fun anUnknownChainOrNoAddressHasNoLinksAndTheAddressIsPathEncoded() {
        assertTrue(labels("tron", null).isEmpty() && labels(null, null).isEmpty())
        assertTrue(ChartLinks.links("", "solana", null).isEmpty())
        assertEquals("https://dexscreener.com/base/a%2Fb%20c", ChartLinks.links("a/b c", "base", null)[0].url)
    }

    @Test fun tradingViewOpensTheCoinsChartOnlyForAValidSymbolElseItsChartPage() {
        assertEquals("https://www.tradingview.com/chart/?symbol=RAYDIUM:BONKSOL", ChartLinks.tradingViewUrl("RAYDIUM:BONKSOL"))
        assertEquals("https://www.tradingview.com/chart/", ChartLinks.tradingViewUrl("bad symbol"))
        assertEquals("https://www.tradingview.com/chart/", ChartLinks.tradingViewUrl(null))
        assertNull(ChartLinks.validSymbol("javascript:alert(1)"))
    }
}
