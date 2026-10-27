package io.pinr.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorldTest {
    @Test fun theMapIsTheSitesCompass() {
        assertEquals(Room.Arena, Room.entries.single { it.col == 1 && it.row == 0 })
        assertEquals(Room.Discover, Room.entries.single { it.col == 0 && it.row == 1 })
        assertEquals(Room.Pinr, Room.entries.single { it.col == 1 && it.row == 1 })
        assertEquals(Room.Wallet, Room.entries.single { it.col == 2 && it.row == 1 })
        assertEquals(Room.Terminal, Room.entries.single { it.col == 1 && it.row == 2 })
        assertEquals(4, Room.entries.count { it.isAd })
    }

    @Test fun cameraFliesAndBackRetracesTheRoomsVisited() {
        val c = Camera()
        assertEquals(Room.Pinr, c.room)
        assertFalse(c.canGoBack)
        c.go(Room.Discover); c.landed()
        c.go(Room.Terminal); c.landed()
        assertTrue(c.settled)
        c.back(); c.landed()
        assertEquals(Room.Discover, c.room)
        c.back(); c.landed()
        assertEquals(Room.Pinr, c.room)
        assertFalse(c.canGoBack)
    }

    @Test fun theWholeMapDrawsEveryRoomAndBackLeavesIt() {
        val c = Camera()
        c.toggleMap(); c.landed()
        assertTrue(c.map)
        assertFalse(c.settled) // on the map nothing is in place: a tap flies in
        assertEquals(Room.entries.toSet(), c.drawn)
        assertTrue(c.canGoBack)
        c.back(); c.landed()
        assertFalse(c.map)
        assertEquals(Room.Pinr, c.room)
        c.toggleMap(); c.go(Room.AdNE); c.landed()
        assertEquals(Room.AdNE, c.room)
        assertEquals(setOf(Room.AdNE), c.drawn)
    }

    @Test fun theWholeMapFitsBetweenHeaderAndFooter() {
        val l = MapLayout(1080f, 2424f, top = 300f, bottom = 250f)
        val s = l.mapScale(2.625f)
        assertTrue(l.mapY(2.625f) >= 300f)
        assertTrue(l.mapY(2.625f) + l.worldH * s <= 2424f - 250f + 0.5f)
        assertTrue(l.mapX(2.625f) >= 0f)
    }

    @Test fun adCornersAreOurOwnPlaceholdersOnly() {
        val all = listOf(Room.AdNW, Room.AdNE, Room.AdSW, Room.AdSE).flatMap { AdAreas.slots(it) }
        assertEquals(16, all.size)
        assertEquals((listOf("A", "B", "C", "D").flatMap { l -> (1..4).map { "Ad space $l$it" } }), all.map { it.first })
        assertTrue(all.all { it.second == "Wide placeholder" || it.second == "Square placeholder" })
        assertEquals(emptyList<Pair<String, String>>(), AdAreas.slots(Room.Arena))
    }

    @Test fun theNeedlePointsAtEachRoom() {
        assertEquals(180f, needle(Room.Arena))
        assertEquals(0f, needle(Room.Pinr))
        assertEquals(225f, needle(Room.AdNE))
    }
}
