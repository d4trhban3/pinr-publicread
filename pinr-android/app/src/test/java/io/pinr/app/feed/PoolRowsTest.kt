package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Checklist 6: a Base coin's pool state is "none", yet its evidence file has pool rows; the Pool section shows them. */
class PoolRowsTest {
    private val base = """{"available":true,"facts":[],"checks":[],"read":[],"links":[],"channels":[],"pool":{"state":"none","source":null,"asOfMs":null,"events":[]},"poolRows":[{"what":"liquidity locked","value":1,"unit":"share of pool value","source":"Base chain","onchain":true,"link":null},{"what":"trades in pool (Uniswap v4)","value":null,"unit":null,"source":"Base chain","onchain":true,"link":"https://basescan.org/tx/0xabc"}]}"""

    @Test fun aBaseCoinKeepsItsTwoPoolRowsAndARowWithNoLinkHasNone() {
        val d = Dossier.parse(base)!!
        assertEquals("none", d.pool?.state)
        assertEquals(listOf("liquidity locked", "trades in pool (Uniswap v4)"), d.poolRows.map { it.what })
        assertNull(d.poolRows[0].link)
        assertEquals("https://basescan.org/tx/0xabc", d.poolRows[1].link)
    }

    @Test fun anOlderFeedWithoutPoolRowsHasNone() {
        val d = Dossier.parse("""{"available":true,"facts":[],"checks":[],"read":[],"links":[],"channels":[]}""")!!
        assertTrue(d.poolRows.isEmpty())
    }
}
