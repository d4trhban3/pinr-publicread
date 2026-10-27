package io.pinr.app.feed

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedStoreTest {
    private val base = "http://feed"
    private val contract = """{"contract":"1.0","noScoreLabels":["VAMP","BOT/RUG","MAYHEM","HONEYPOT"]}"""
    private fun tok(a: String) = """{"address":"$a","coverage":40}"""

    /** A pretend feed server: each address answers a fixed status and body. */
    private class Fake(val answers: Map<String, Pair<Int, String>>) : Http {
        val asked = mutableListOf<String>()
        override fun get(url: String): Pair<Int, String> {
            asked += url
            return answers[url] ?: throw java.io.IOException("unreachable")
        }
    }

    @Test fun readsTheFirstPageAndTheRestWithoutDuplicates() = runBlocking {
        val http = Fake(
            mapOf(
                "$base/api/contract" to (200 to contract),
                "$base/api/tokens" to (200 to """{"contract":"1.0","tokens":[${tok("A")},${tok("B")}]}"""),
                "$base/api/tokens/rest?offset=0&limit=1000" to (200 to """{"contract":"1.0","total":3,"offset":0,"tokens":[${tok("b")},${tok("C")},{"address":"D","coverage":400}]}"""),
            ),
        )
        val s = FeedStore(base, http, pageDelayMs = 0)
        assertTrue(s.checkContract() is FeedState.Live)
        s.poll()
        s.sweep()
        val d = s.data.value
        assertEquals(FeedState.Live("1.0"), d.state)
        assertEquals(listOf("A", "B", "C"), d.all.map { it.address }) // "b" is B again; D's coverage is out of range
        assertEquals(1, d.leftOut)
        assertEquals(3, d.restLoaded)
        assertEquals(3, d.restTotal)
        assertEquals(setOf("a", "b", "c"), d.byId.keys)
    }

    @Test fun anotherContractShowsNothing() = runBlocking {
        val http = Fake(
            mapOf(
                "$base/api/contract" to (200 to contract),
                "$base/api/tokens" to (200 to """{"contract":"2.0","tokens":[${tok("A")}]}"""),
            ),
        )
        val s = FeedStore(base, http)
        s.checkContract()
        s.poll()
        assertEquals(FeedState.Mismatch("2.0"), s.data.value.state)
        assertTrue(s.data.value.all.isEmpty())
    }

    @Test fun aContractWithOtherLabelsIsAMismatchToo() = runBlocking {
        val s = FeedStore(base, Fake(mapOf("$base/api/contract" to (200 to """{"contract":"1.0","noScoreLabels":["VAMP"]}"""))))
        assertEquals(FeedState.Mismatch("1.0"), s.checkContract())
    }

    @Test fun offlineKeepsTheLastTokensHeard() = runBlocking {
        val answers = mutableMapOf("$base/api/tokens" to (200 to """{"contract":"1.0","tokens":[${tok("A")}]}"""))
        val s = FeedStore(base, Fake(answers))
        s.poll()
        answers["$base/api/tokens"] = 500 to ""
        s.poll()
        assertEquals(FeedState.Offline("The feed answered 500"), s.data.value.state)
        assertEquals(listOf("A"), s.data.value.all.map { it.address })
        answers.remove("$base/api/tokens")
        s.poll()
        assertEquals(FeedState.Offline("The feed cannot be reached"), s.data.value.state)
    }

    @Test fun noAddressInTheBuildMeansNoFeed() = runBlocking {
        val s = FeedStore(null, Fake(emptyMap()))
        s.poll()
        assertEquals(FeedState.Offline("No feed address in this build"), s.data.value.state)
    }

    @Test fun movesAreCountedFromTheFirstScoreSeen() = runBlocking {
        val answers = mutableMapOf("$base/api/tokens" to (200 to """{"contract":"1.0","tokens":[{"address":"A","coverage":40,"score":50}]}"""))
        val s = FeedStore(base, Fake(answers))
        s.poll()
        answers["$base/api/tokens"] = 200 to """{"contract":"1.0","tokens":[{"address":"A","coverage":40,"score":57}]}"""
        s.poll()
        assertEquals(mapOf("a" to 7), s.data.value.moved)
    }
}
