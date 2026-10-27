package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FormatTest {
    @Test fun moneyReadsAsOnTheSite() {
        assertEquals("$376.11M", Format.usdCompact(376_110_000.0))
        assertEquals("$1.20K", Format.usdCompact(1_200.0))
        assertEquals("$950", Format.usdCompact(950.0))
        assertEquals("$4.50", Format.usdCompact(4.5))
        assertEquals("$1.00M", Format.usdCompact(999_999.0))
        assertEquals("$0.00", Format.usdCompact(0.0))
        assertEquals(Format.DASH, Format.usdCompact(null))
        assertEquals(Format.DASH, Format.usdCompact(-1.0))
    }

    @Test fun changeReadsAsOnTheSite() {
        assertEquals("+38.4%", Format.change(38.4))
        assertEquals("−12.0%", Format.change(-12.0))
        assertEquals("+1,250%", Format.change(1250.0))
        assertEquals("+38.4% · 5h", Format.change(38.4, 5.0))
        assertEquals("+38.4%", Format.change(38.4, 24.0))
        assertEquals(Format.DASH, Format.change(null))
    }

    @Test fun aMissingNameIsAShortenedAddress() {
        assertEquals("7xKX…9fQa", Format.title(Token("7xKXabcdefgh9fQa", coverage = 1.0)))
        assertEquals("short", Format.title(Token("short", coverage = 1.0)))
        assertEquals(Format.DASH, Format.ticker(Token("A", coverage = 1.0)))
        assertEquals("45%", Format.coverage(45.2))
        assertEquals(Format.DASH, Format.score(Token("A", coverage = 1.0)))
    }

    @Test fun theNameFilterMasksRudeNamesAsTheSiteDoes() {
        assertTrue(NameFilter.isRude("Wet Ass Pussy"))
        assertTrue(NameFilter.isRude("FUCK U CAT"))
        assertTrue(NameFilter.isRude("sh1t coin"))
        assertTrue(NameFilter.isRude("cum"))
        assertFalse(NameFilter.isRude("document"))
        assertFalse(NameFilter.isRude("Moby Dick"))
        assertFalse(NameFilter.isRude("\$HIT"))
        assertFalse(NameFilter.isRude("Satoshi Tajiri"))
        val t = Token("A", name = "Wet Ass Pussy", ticker = "\$WAP", coverage = 1.0)
        assertEquals(NameFilter.MASKED_NAME, Format.title(t))
        assertEquals(NameFilter.MASKED_TICKER, Format.ticker(t))
    }
}
