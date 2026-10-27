package io.pinr.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** the team's T1 on android-6: the chart's axes take round steps, and volume reads as the chart library's volume scale. */
class ChartScaleTest {
    private fun r(l: List<Double>) = l.map { Math.round(it * 1e6) / 1e6 }

    @Test fun priceStepsAreRound() {
        // The site's 15m XTO axis: 0.0250 to 0.0500 in steps of 0.0050.
        assertEquals(listOf(0.025, 0.03, 0.035, 0.04, 0.045, 0.05), r(niceTicks(0.0249, 0.0501, 6)))
        assertEquals(listOf(0.0, 2.5, 5.0, 7.5, 10.0), r(niceTicks(0.0, 10.0, 4)))
        // The volume pane's scale (about three steps): 0, 500, 1,000 for a top bar near 1,000.
        assertEquals(listOf(0.0, 500.0, 1000.0), r(niceTicks(0.0, 1100.0, 3)))
        assertEquals(emptyList<Double>(), niceTicks(5.0, 5.0, 4))
    }

    @Test fun volumeLabelsReadAsTheSitesFmtAxis() {
        // the team's V1: the site's own picture reads "200,000.00" and "100,000.00".
        assertEquals("200,000.00", volumeLabel(200_000.0))
        assertEquals("100,000.00", volumeLabel(100_000.0))
        assertEquals("500.00", volumeLabel(500.0))
        assertEquals("0.500", volumeLabel(0.5))
        // the team's V1b: the site's fmtAxis(0) is formatPriceCompact(0), a dash.
        assertEquals("—", volumeLabel(0.0))
    }

    @Test fun theSignalIsTheSitesPurple() = assertEquals(0xFF8F5CFF.toInt(), SIGNAL_PURPLE.value.shr(32).toInt())
}
