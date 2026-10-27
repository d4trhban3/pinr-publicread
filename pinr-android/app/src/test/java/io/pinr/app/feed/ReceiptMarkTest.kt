package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** ● on chain, ○ reported; an on-chain row with no link keeps its ● and says so. */
class ReceiptMarkTest {
    @Test fun anOnChainRowWithNoLinkKeepsItsMarkAndSaysSo() {
        assertEquals("●", ReceiptMark.mark(true))
        assertEquals("no receipt link yet", ReceiptMark.note(true, false))
        assertNull(ReceiptMark.note(true, true))
        assertEquals("○", ReceiptMark.mark(false))
        assertNull(ReceiptMark.note(false, false))
        assertEquals("read on chain", ReceiptMark.word(true))
    }
}

class TradesWordsTest {
    @Test fun noTradesReadOnEveryChain() {
        assertEquals("No trades read yet.", TradesWords.NO_TRADES_READ)
        org.junit.Assert.assertFalse(TradesWords.NO_TRADES_READ.contains("few seconds"))
    }
}

class FigureRuleTest {
    @Test fun aValueWithNoSourceIsADashThatSaysNotReadYet() {
        assertEquals(FigureRule.Shown(Format.DASH, true), FigureRule.shown("\$486", hasSource = false, sourced = true))
        assertEquals(FigureRule.Shown("\$486", false), FigureRule.shown("\$486", hasSource = true, sourced = true))
        assertEquals(FigureRule.Shown(Format.DASH, true), FigureRule.shown(Format.DASH, hasSource = false, sourced = true))
        assertEquals(FigureRule.Shown("1m", false), FigureRule.shown("1m", hasSource = false, sourced = false))
    }
    @Test fun aCurveCoinSaysItIsOnItsCurve() {
        assertEquals("On its bonding curve; no pool yet.", FigureRule.noPoolWords("Pump.fun curve"))
        assertEquals("Not checked yet.", FigureRule.noPoolWords("PumpSwap (graduated)"))
        assertEquals("Not checked yet.", FigureRule.noPoolWords(null))
    }
}

class FundingNoteTest {
    @Test fun anEmptyFundersGroupReadsTheNote() {
        val note = "Funding not traced: the launcher is a mass launcher and the fee wallet is brand new."
        val with = EvidenceHub.parse("""{"evidence":{"rows":[],"fundingNote":"$note"}}""")
        val without = EvidenceHub.parse("""{"evidence":{"rows":[]}}""")
        fun empty(h: EvidenceHub?) = EvidenceWords.orbitGroups(h, 1_000_000L).first { it.id == EvidenceWords.GroupId.Funders }.empty
        assertEquals(note, empty(with))
        assertEquals("Where the creator's money came from: not checked yet.", empty(without))
    }
}
