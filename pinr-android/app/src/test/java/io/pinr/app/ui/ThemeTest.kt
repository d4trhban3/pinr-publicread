package io.pinr.app.ui

import androidx.compose.ui.graphics.Color
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The light and dark looks (the site's `:root` and `[data-theme="light"]`, the iPhone app's Theme.swift). */
class ThemeTest {
    @After fun reset() { ThemeState.choice = null; ThemeState.systemDark = true }

    @Test fun theLookFollowsThePhoneUntilAChoiceIsMade() {
        ThemeState.systemDark = true
        assertTrue(!ThemeState.light)
        ThemeState.systemDark = false
        assertTrue(ThemeState.light)
        ThemeState.choice = false // the person picked dark on a light phone
        assertTrue(!ThemeState.light)
        ThemeState.choice = true
        ThemeState.systemDark = true
        assertTrue(ThemeState.light)
    }

    @Test fun theBrandColoursAreTheSitesInBothLooks() {
        ThemeState.choice = false
        assertEquals(Color(0xFF0A0C0E), Brand.ink); assertEquals(Color(0xFFF4EEFF), Brand.paper); assertEquals(Color(0xFFD6FF3C), Brand.lime)
        assertEquals(Color(0xCC000000), Brand.glass); 
        ThemeState.choice = true
        assertEquals(Color(0xFFEBE4F7), Brand.ink); assertEquals(Color(0xFF14161C), Brand.paper); assertEquals(Color(0xFF587A00), Brand.lime)
        assertEquals(Color(0xE6F5F1FB), Brand.glass)
    }

    @Test fun theScoreScaleRunsMandarinToLimeInBothLooks() {
        ThemeState.choice = false
        assertEquals(Color(255 / 255f, 140 / 255f, 26 / 255f), Brand.score(10))
        assertEquals(Color(214 / 255f, 255 / 255f, 60 / 255f), Brand.score(99))
        ThemeState.choice = true
        assertEquals(Color(217 / 255f, 97 / 255f, 0f), Brand.score(10))
        assertEquals(Color(88 / 255f, 122 / 255f, 0f), Brand.score(99))
    }
}
