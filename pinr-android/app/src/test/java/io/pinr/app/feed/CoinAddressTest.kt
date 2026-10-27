package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Opening one coin by its address (decision D3): which strings and links name a coin. */
class CoinAddressTest {
    private val sol = "AAxKPE8TEUfLH7txHppZNk5aP5V2i7PEZL6qf8Rwpump"
    private val evm = "0x4200000000000000000000000000000000000006"

    @Test fun anExactSolanaOrEvmAddressAndNothingElse() {
        assertTrue(CoinAddress.isAddress(sol) && CoinAddress.isAddress(evm))
        assertFalse(CoinAddress.isAddress("") || CoinAddress.isAddress("pepe") || CoinAddress.isAddress("0x1234"))
        assertFalse(CoinAddress.isAddress("$sol ") || CoinAddress.isAddress("0OIl$sol")) // 0, O, I, l are not base58
    }

    @Test fun theAppsOwnLinkAndTheSitesCoinLinkNameACoinOtherLinksAndHostsDoNot() {
        assertEquals(sol, CoinAddress.parse("pinr://coin/$sol"))
        assertEquals(evm, CoinAddress.parse("https://pinr.io/?coin=$evm"))
        assertEquals(sol, CoinAddress.parse("https://pinr.io/?coin=$sol&x=1"))
        assertNull(CoinAddress.parse("https://evil.example/?coin=$sol"))
        assertNull(CoinAddress.parse("http://pinr.io/?coin=$sol"))
        assertNull(CoinAddress.parse("pinr://wallet/$sol"))
        assertNull(CoinAddress.parse("https://pinr.io/?coin=nonsense"))
        assertNull(CoinAddress.parse("https://pinr.io/"))
        assertNull(CoinAddress.parse(null))
    }
}
