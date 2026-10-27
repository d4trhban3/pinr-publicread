package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContractTest {
    private val labels = listOf("VAMP", "BOT/RUG", "MAYHEM", "HONEYPOT")

    @Test fun acceptsTheFeedsAnswer() {
        val info = Contract.parse("""{"contract":"1.0","noScoreLabels":["VAMP","BOT/RUG","MAYHEM","HONEYPOT"]}""")
        assertEquals(ContractInfo("1.0", labels), info)
        assertTrue(Contract.accepts(info!!))
    }

    @Test fun acceptsAnyMinorOfVersionOne() {
        assertTrue(Contract.accepts(ContractInfo("1.1", labels)))
        assertTrue(Contract.accepts(ContractInfo("1", labels.reversed())))
    }

    @Test fun refusesAnotherMajorVersion() {
        assertFalse(Contract.accepts(ContractInfo("2.0", labels)))
        assertFalse(Contract.accepts(ContractInfo("10.0", labels)))
        assertFalse(Contract.accepts(ContractInfo("", labels)))
    }

    @Test fun refusesADifferentSetOfNoScoreLabels() {
        assertFalse(Contract.accepts(ContractInfo("1.0", labels.dropLast(1))))
        assertFalse(Contract.accepts(ContractInfo("1.0", labels + "SCAM")))
    }

    @Test fun anAnswerOfTheWrongShapeIsNotRead() {
        assertNull(Contract.parse("not json"))
        assertNull(Contract.parse("""{"noScoreLabels":[]}"""))
        assertNull(Contract.parse("""{"contract":1,"noScoreLabels":[]}"""))
        assertNull(Contract.parse("""{"contract":"1.0"}"""))
        assertNull(Contract.parse("""{"contract":"1.0","noScoreLabels":["VAMP",3]}"""))
        assertNull(Contract.parse("""[]"""))
    }
}
