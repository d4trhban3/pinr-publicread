package io.pinr.app.feed

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** the coin page's Pool section. */
class PoolEventsTest {
    private val sig = "5" + "J".repeat(87)
    private val wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    private val body = """{"state":"read","source":"Solana chain","asOfMs":1792950000000,"events":[
        {"atMs":1792950000000,"kind":"liquidity added","sig":"$sig","user":"$wallet","base":1200000,"quote":12.3,"quoteSymbol":"SOL","raw":false},
        {"atMs":1792940000000,"kind":"bought back and burned","sig":"$sig","base":500,"quote":1.5,"quoteSymbol":"SOL","raw":true},
        {"atMs":1792930000000,"kind":"coin creator changed","sig":"$sig","oldCreator":"$wallet","newCreator":"$wallet","quoteSymbol":"SOL","raw":false},
        {"atMs":1,"kind":"something else","sig":"$sig"},{"atMs":2,"kind":"pool created","sig":"short"}]}"""

    @Test fun theEventsAreReadNewestFirstAsServedAndABadOneIsDroppedAlone() {
        val p = PoolEvents.parse(JSONObject(body))!!
        assertEquals("read", p.state); assertEquals(3, p.events.size)
        assertEquals(listOf("liquidity added", "bought back and burned", "coin creator changed"), p.events.map { it.kind })
    }

    @Test fun noFileIsNotCheckedYetAndAnUnreadableAnswerIsNoPool() {
        assertEquals("none", PoolEvents.parse(JSONObject("""{"state":"none","events":[]}"""))!!.state)
        assertNull(PoolEvents.parse(JSONObject("""{"state":"weird"}""")))
        assertNull(PoolEvents.parse(null))
    }

    @Test fun aZeroXHashIsAReceiptTooTheChainNamesTheExplorerAndAHashFittingNeitherIsDropped() {
        val h = "0x" + "cd".repeat(32); val a = "0x" + "ab".repeat(20)
        val json = """{"state":"read","chain":"base","events":[{"atMs":1792950000000,"kind":"pool created","sig":"$h","user":"$a"},{"atMs":1792950000001,"kind":"liquidity added","sig":"0xzz"}]}"""
        val p = PoolEvents.parse(JSONObject(json))!!
        assertEquals("base", p.chain); assertEquals(1, p.events.size); assertEquals(a, p.events[0].user)
        assertEquals("https://basescan.org/tx/$h", PoolWords.txUrl(h, p.chain))
        assertEquals("https://bscscan.com/address/$a", PoolWords.accountUrl(a, "bnb"))
        assertEquals("solana", PoolEvents.parse(JSONObject(body))!!.chain)
    }

    @Test fun theWordsAreObservedAmountsRawUnitsSaidAsSuchAndTheSitesAmountFormat() {
        val e = PoolEvents.parse(JSONObject(body))!!.events
        assertEquals("12.30 SOL and 1.20M tokens", PoolWords.what(e[0]))
        assertEquals("500.00 raw token units burned for 1.50 raw SOL units", PoolWords.what(e[1]))
        assertEquals("", PoolWords.what(e[2]))
        assertEquals("Liquidity added", PoolWords.title(e[0].kind))
        assertEquals("Oct 25, 5:40 PM", PoolWords.local(1792950000000, java.util.TimeZone.getTimeZone("UTC")))
        assertEquals("Oct 25, 11:40 AM", PoolWords.local(1792950000000, java.util.TimeZone.getTimeZone("America/Denver")))
        assertEquals("AAxKPE…pump", PoolWords.shortAddress("AAxKPE8TEUfLH7txHppZNk5aP5V2i7PEZL6qf8Rwpump"))
        assertTrue(PoolWords.txUrl(sig).startsWith("https://solscan.io/tx/")); assertEquals("0.00123", PoolWords.amount(0.00123))
    }
}

class EngineNoteTest {
    @Test fun aStatusPartIsNeverShownAsAFindingTheRestIsAndNothingLeftIsNoNote() {
        assertEquals(emptyList<String>(), EngineNote.parts("Technical error, retrying"))
        assertEquals(listOf("no dev wallet read", "thin liquidity"), EngineNote.parts("no dev wallet read; Technical error, retrying; thin liquidity"))
        assertEquals(emptyList<String>(), EngineNote.parts("Retrying the holders read"))
        assertEquals(emptyList<String>(), EngineNote.parts(null))
    }
}
