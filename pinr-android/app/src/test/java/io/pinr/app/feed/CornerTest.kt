package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Test

/** the team's M1 and C1 on android-3: the tile's money and its score and coverage corner are the site's. */
class CornerTest {
    @Test fun tileMoneyIsTheSitesMoney() {
        // The site's own figures from the READY's pictures, and money()'s edges (discoverlist.ts).
        assertEquals("$305.9K", Format.money(305_890.0))
        assertEquals("$717.9K", Format.money(717_930.0))
        assertEquals("$112.0K", Format.money(112_050.0))
        assertEquals("$46.23M", Format.money(46_230_000.0))
        assertEquals("$1.20B", Format.money(1_200_000_000.0))
        assertEquals("$4500.00B", Format.money(4.5e12)) // no T on the site
        assertEquals("$950", Format.money(950.4))
        assertEquals("$5", Format.money(4.5))
        assertEquals(Format.DASH, Format.money(0.0))
        assertEquals(Format.DASH, Format.money(-3.0))
        assertEquals(Format.DASH, Format.money(null))
    }

    @Test fun aScoredCoinShowsItsNumberOverCoverage() =
        assertEquals(Format.Corner("64", numeric = true, flagged = false, coverage = "49%", word = "coverage"), Format.corner(Token("A", score = 64, coverage = 49.0)))

    @Test fun aCoinWithNothingReadIsADashOverUnscored() {
        assertEquals(Format.Corner(Format.DASH, false, false, Format.DASH, "unscored"), Format.corner(Token("A", coverage = 0.0)))
        // A score with coverage 0 is still a dash (the site never shows a number with nothing read).
        assertEquals(Format.Corner(Format.DASH, false, false, Format.DASH, "unscored"), Format.corner(Token("A", score = 40, coverage = 0.0)))
    }

    @Test fun aReadCoinWithNoNumberIsADashOverItsCoverage() =
        assertEquals(Format.Corner(Format.DASH, false, false, "61%", "coverage"), Format.corner(Token("A", coverage = 61.0)))

    @Test fun aFlaggedCoinShowsItsLabelOverNoDataNeverZeroPercent() {
        assertEquals(Format.Corner("MAYHEM", false, true, Format.DASH, "no data"), Format.corner(Token("A", label = NoScoreLabel.Mayhem, coverage = 0.0)))
        assertEquals(Format.Corner("VAMP", false, true, "30%", "no data"), Format.corner(Token("A", label = NoScoreLabel.Vamp, coverage = 30.0)))
    }
}

class ToFixedTest {
    @Test fun roundsLikeTheSitesToFixed() {
        // JavaScript: (112.05).toFixed(1) = "112.0", (1.005).toFixed(2) = "1.00", (2.5).toFixed(0) = "3", (0.125).toFixed(2) = "0.13".
        assertEquals("112.0", Format.fixed(112.05, 1))
        assertEquals("1.00", Format.fixed(1.005, 2))
        assertEquals("3", Format.fixed(2.5, 0))
        assertEquals("0.13", Format.fixed(0.125, 2))
    }
}
