package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WireTest {
    @Test fun oneUnreadableEntryIsSkippedAndCountedNeverFatal() {
        val s = Wire.snapshot(
            """{"contract":"1.0","tokens":[{"address":"A","coverage":40},{"coverage":3},"junk",{"address":"B","coverage":"x"},{"address":"C","coverage":0}]}""",
        )!!
        assertEquals(listOf("A", "C"), s.tokens.tokens.map { it.address })
        assertEquals(3, s.tokens.unreadable)
    }

    @Test fun anOptionalFieldOfTheWrongTypeIsMissing() {
        val t = Wire.snapshot(
            """{"contract":"1.0","tokens":[{"address":"A","coverage":40,"score":"70","name":7,"valuationUsd":null,"priceSeries":[1,"x"],"flow":{"buy5m":1}}]}""",
        )!!.tokens.tokens.single()
        listOf(t.score, t.name, t.valuationUsd, t.priceSeries, t.flow).forEach { assertNull(it) }
    }

    @Test fun readsTheFeedsRealFields() {
        val t = Wire.snapshot(
            """{"contract":"1.0","tokens":[{"address":"A","coverage":40,"score":70,"ticker":"${'$'}A","quotePair":"A/SOL","flow":{"buy5m":3,"sell5m":1,"buy1h":9,"sell1h":4,"n5m":4,"n1h":13,"lastAt":null,"complete":true,"basis":"count"},"possibleCopyOf":{"address":"B","ticker":null,"proof":"chain"}}]}""",
        )!!.tokens.tokens.single()
        assertEquals(70.0, t.score)
        assertEquals("A/SOL", t.quotePair)
        assertEquals(13.0, t.flow!!.n1h, 0.0)
        assertEquals("count", t.flow!!.basis)
        assertEquals("chain", t.possibleCopyOf!!.proof)
    }

    @Test fun aRestPageNeedsItsCounts() {
        assertEquals(8620, Wire.restPage("""{"contract":"1.0","total":8620,"offset":0,"tokens":[]}""")!!.total)
        assertNull(Wire.restPage("""{"contract":"1.0","offset":0,"tokens":[]}"""))
        assertNull(Wire.restPage("""{"contract":"1.0","total":-1,"offset":0,"tokens":[]}"""))
        assertNull(Wire.snapshot("""{"tokens":[]}"""))
        assertNull(Wire.snapshot("not json"))
    }

    @Test fun aSeenCoinCarriesItsSeenTimeAndOnlyATrueSeenCounts() {
        val t = Wire.snapshot(
            """{"contract":"1.0","tokens":[{"address":"A","coverage":0,"seen":true,"seenAtMs":1790000000000,"asOfMs":1780000000000,"launchpad":"Pump.fun curve"},
              {"address":"B","coverage":0,"seen":true,"asOfMs":1780000000000},{"address":"C","coverage":0,"seen":"yes","seenAtMs":1790000000000},{"address":"D","coverage":50,"asOfMs":1780000000000}]}""",
        )!!.tokens.tokens.map { (Token.make(it, "https://pinr.io") as Token.Made.Shown).token }
        assertEquals(listOf(true, true, false, false), t.map { it.seen })
        assertEquals(listOf(1790000000000L, 1780000000000L, null, null), t.map { it.seenAtMs })
    }
}
