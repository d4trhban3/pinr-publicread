package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FeedUrlTest {
    @Test fun releaseReadsHttpsOnly() {
        assertEquals("https://pinr.io", FeedLink.feedUrl("https://pinr.io", release = true))
        assertEquals("https://pinr.io", FeedLink.feedUrl("https://pinr.io/", release = true))
        assertNull(FeedLink.feedUrl("http://pinr.io", release = true))
        assertNull(FeedLink.feedUrl("http://10.0.2.2:8787", release = true))
    }

    @Test fun testBuildsMayReadThisMac() {
        assertEquals("http://10.0.2.2:8787", FeedLink.feedUrl("http://10.0.2.2:8787", release = false))
        assertEquals("https://pinr.io", FeedLink.feedUrl("https://pinr.io", release = false))
    }

    @Test fun anythingElseLeavesTheAppWithoutAFeed() {
        assertNull(FeedLink.feedUrl(null, release = false))
        assertNull(FeedLink.feedUrl("", release = false))
        assertNull(FeedLink.feedUrl("ftp://pinr.io", release = false))
        assertNull(FeedLink.feedUrl("pinr.io", release = false))
        assertNull(FeedLink.feedUrl("https://pinr.io/api", release = true)) // the app adds /api itself
        assertNull(FeedLink.feedUrl("https://user@pinr.io", release = true))
    }
}
