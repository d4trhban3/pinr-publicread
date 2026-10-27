package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Test

class ChainNameTest {
    @Test fun namesEachChainTheFeedSends() {
        assertEquals(listOf("Base", "BNB Chain", "Solana", "Ethereum"), listOf("base", "bsc", "solana", "ethereum").map(ChainName::of))
    }
    @Test fun anUnknownIdStaysAsItCame() = assertEquals("tron", ChainName.of("tron"))
}
