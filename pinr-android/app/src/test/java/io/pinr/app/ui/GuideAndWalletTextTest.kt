package io.pinr.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class GuideAndWalletTextTest {
    /** The guide's words equal the site's approved copy, read from the site's file. */
    @Test fun theGuideIsTheApprovedTextWordForWord() {
        val site = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "pinr-live/src/ui/guidecopy.ts") }.firstOrNull { it.exists() }
            ?: return // the site's file is not beside this copy (a lone checkout): nothing to compare against
        // Only the approved sections: since a design decision the file also holds the hidden-score wording after them, which the app does not use.
        val src = site.readText().substringBefore("const HUB_TITLES_DROPPED")
        val strings = Regex("""(title|lead|text): "((?:[^"\\]|\\.)*)"""").findAll(src).map { it.groupValues[1] to it.groupValues[2].replace("\\\"", "\"") }.toList()
        val siteTitles = strings.filter { it.first == "title" }.map { it.second }
        assertEquals(siteTitles, GuideCopy.SECTIONS.map { it.title })
        val appTexts = GuideCopy.SECTIONS.flatMap { s -> s.blocks.flatMap { listOfNotNull(it.lead, it.text) } }
        val siteTexts = strings.filter { it.first != "title" }.map { it.second }
        assertEquals(siteTexts, appTexts)
    }

    @Test fun walletNumbersReadAsTheSites() {
        assertEquals("$1.2K", walletUsd(1234.0))
        assertEquals("$0.500", walletUsd(0.5))
        assertEquals("1.23K", walletCompact(1234.0))
        assertEquals("1.5M", walletCompact(1_500_000.0))
        assertEquals("12.35", walletCompact(12.345))
        assertEquals("999", walletCompact(999.0))
        assertEquals("1M", walletCompact(999_999.0))
    }

    @Test fun theNeverTextsAreTheSites() = assertTrue(io.pinr.app.feed.WalletRules.VIEW_ONLY_POINTS.size == 3)
}
