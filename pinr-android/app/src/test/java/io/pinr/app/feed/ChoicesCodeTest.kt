package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The choices code, exactly `pinr-live/EXPORT-CODE-FORMAT.md`: its two samples and its six refusals. */
class ChoicesCodeTest {
    private val sampleA = "PINR1.eyJ2IjoxLCJ3IjpbIjB4MjJhZjMzZmU0OWZkMWZhODBjNzE0OTc3M2RkZTU4OTBkM2M3NmYzYiJdLCJoIjpbIjNrem1oZGd1ZThrcWxrZzdxNDVxanM4Y3ptZDd1dWhmd2Rla24yNGpwdW1wIiwiajdmMmJwZjlzYmRzcHo4am1objl4dnJ4dG96aG5nZXFhZHJ2YnJkcHVtcCJdLCJmIjpmYWxzZX0"
    private val sampleB = "PINR1.eyJ2IjoxLCJ3IjpbIjNpZFlOcVhFNGZBSkpOVUh1akdUYlFOSEN6aEg1Mkh3WnlHb1hCSjJiem5XIiwiMHgyMmFmMzNmZTQ5ZmQxZmE4MGM3MTQ5NzczZGRlNTg5MGQzYzc2ZjNiIl0sImgiOltdLCJmIjp0cnVlLCJ4IjoiYSBrZXkgYSByZWFkZXIgZG9lcyBub3Qga25vdyJ9"
    private val evm = "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b"
    private val hiddenA = listOf("3kzmhdgue8kqlkg7q45qjs8czmd7uuhfwdekn24jpump", "j7f2bpf9sbdspz8jmhn9xvrxtozhngeqadrvbrdpump")

    @Test fun makesSampleAByteForByte() {
        // Given in another order and case: the code sorts and lower-cases, so the same choices always make the same code.
        assertEquals(sampleA, ChoicesCode.make(listOf(evm), listOf("J7F2BPF9SBDSPZ8JMHN9XVRXTOZHNGEQADRVBRDPUMP", hiddenA[0]), false))
    }

    @Test fun readsSampleA() =
        assertEquals(ChoicesCode.Read.Ok(ChoicesCode.Choices(listOf(evm), hiddenA, false)), ChoicesCode.read(sampleA))

    @Test fun readsSampleBAndIgnoresTheUnknownKey() {
        val r = ChoicesCode.read("  $sampleB\n") as ChoicesCode.Read.Ok
        assertEquals(listOf("3idYNqXE4fAJJNUHujGTbQNHCzhH52HwZyGoXBJ2bznW", evm), r.choices.wallets)
        assertTrue(r.choices.hidden.isEmpty())
        assertEquals(true, r.choices.filter)
    }

    @Test fun refusesTheSixCases() {
        val payload = sampleA.removePrefix("PINR1.")
        fun refusal(s: String) = (ChoicesCode.read(s) as ChoicesCode.Read.Refused).why
        assertEquals(ChoicesCode.Refusal.NotACode, refusal("PINR1."))
        assertEquals(ChoicesCode.Refusal.NotACode, refusal("PINR2.$payload"))
        assertEquals(ChoicesCode.Refusal.NotACode, refusal("PINR1." + payload.substring(0, 10) + "!" + payload.substring(11)))
        assertEquals(ChoicesCode.Refusal.NotACode, refusal("hello"))
        val list = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("[1,2]".toByteArray())
        assertEquals(ChoicesCode.Refusal.NotACode, refusal("PINR1.$list"))
        val v2 = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("""{"v":2,"w":[],"h":[],"f":true}""".toByteArray())
        assertEquals(ChoicesCode.Refusal.Newer, refusal("PINR1.$v2"))
        assertEquals("That is not a PINR code.", ChoicesCode.Refusal.NotACode.text)
        assertEquals("This code is from a newer PINR.", ChoicesCode.Refusal.Newer.text)
    }

    @Test fun badEntriesAreDroppedAndAMissingFilterIsKept() {
        val raw = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("""{"v":1,"w":["nope","0xABCDEF0123456789abcdef0123456789ABCDEF01"],"h":["  AbC ","",5]}""".toByteArray())
        val c = (ChoicesCode.read("PINR1.$raw") as ChoicesCode.Read.Ok).choices
        assertEquals(listOf("0xabcdef0123456789abcdef0123456789abcdef01"), c.wallets)
        assertEquals(listOf("abc"), c.hidden)
        assertNull(c.filter)
        assertEquals("1 wallet, 1 hidden coin, name filter unchanged", ChoicesCode.summary(c))
        assertEquals("2 wallets, 0 hidden coins, name filter on", ChoicesCode.summary(ChoicesCode.Choices(listOf("a", "b"), emptyList(), true)))
    }
}

class WalletTest {
    @Test fun addressesAreTheSites() {
        assertEquals("0x22af33fe49fd1fa80c7149773dde5890d3c76f3b" to WalletRules.Chain.Evm, WalletRules.clean(" 0x22AF33FE49FD1FA80C7149773DDE5890D3C76F3B "))
        assertEquals("3idYNqXE4fAJJNUHujGTbQNHCzhH52HwZyGoXBJ2bznW" to WalletRules.Chain.Solana, WalletRules.clean("3idYNqXE4fAJJNUHujGTbQNHCzhH52HwZyGoXBJ2bznW"))
        assertNull(WalletRules.clean("hello"))
        assertNull(WalletRules.clean("0x123"))
        assertEquals("3idYNq…bznW", WalletRules.short("3idYNqXE4fAJJNUHujGTbQNHCzhH52HwZyGoXBJ2bznW"))
    }

    @Test fun theFeedsWalletAnswerIsRead() {
        val empty = WalletView.parse("""{"status":"ok","holdings":[],"totalUsd":null,"unavailable":[]}""")!!
        assertEquals("ok", empty.status)
        assertTrue(empty.holdings.isEmpty())
        assertNull(empty.totalUsd)
        val v = WalletView.parse("""{"status":"partial","holdings":[{"address":"A","chain":"solana","name":"X","ticker":"${'$'}X","balance":12.5,"usd":3.2,"score":40,"noScoreLabel":null},{"address":"B","chain":"solana","balance":1,"score":40,"noScoreLabel":"VAMP"},{"address":"","balance":1}],"totalUsd":3.2,"unavailable":["base"]}""")!!
        assertEquals(2, v.holdings.size)
        assertEquals(40, v.holdings[0].score)
        assertNull(v.holdings[1].score)
        assertEquals(listOf("base"), v.unavailable)
    }
}

/**
 * the team's X1: the code is read exactly as strictly as the site's JSON.parse. Each text below is where org.json and
 * JSON.parse disagreed; the expected answer is JSON.parse's (node), and the app must give the same.
 */
class StrictJsonTest {
    private fun code(json: String) = "PINR1." + java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray())
    private fun refused(json: String) = ChoicesCode.read(code(json)) is ChoicesCode.Read.Refused

    @Test fun refusesWhatJsonParseRefuses() {
        assertTrue(refused("{v:1,w:[],h:['ABC'],f:false}")) // unquoted keys, single quotes
        assertTrue(refused("""{"v":1} trailing"""))         // text after the value
        assertTrue(refused("""{"v":1,"h":["a",],}"""))      // trailing commas
        assertTrue(refused("""{"v":01}"""))                 // a leading zero
        assertTrue(refused("""{"v":1,}"""))
        assertTrue(refused("""{"v":1}/*c*/"""))             // a comment
        assertTrue(refused("""{"v":+1}"""))
        assertTrue(refused("""{"v":.5}"""))
        assertTrue(refused("""{"v":1,"h":["a${"\t"}b"]}"""))  // a raw tab inside a string
        assertTrue(refused("""{"v":NaN}"""))
        assertTrue(refused("""{"v":1e999}"""))              // Infinity: v is not finite
    }

    @Test fun acceptsWhatJsonParseAccepts() {
        // A repeated key: JSON.parse keeps the last.
        assertEquals(ChoicesCode.Read.Ok(ChoicesCode.Choices(emptyList(), emptyList(), true)), ChoicesCode.read(code("""{"v":1,"v":1,"f":false,"f":true}""")))
        assertTrue(ChoicesCode.read(code(" \n{\"v\":1.0}\r\n ")) is ChoicesCode.Read.Ok)       // whitespace around, 1.0 is 1
        assertEquals(listOf("é"), (ChoicesCode.read(code("""{"v":1,"h":["É"]}""")) as ChoicesCode.Read.Ok).choices.hidden)
        assertEquals(ChoicesCode.Refusal.Newer, (ChoicesCode.read(code("""{"v":1.5}""")) as ChoicesCode.Read.Refused).why)
        assertEquals(ChoicesCode.Refusal.NotACode, (ChoicesCode.read(code("""{"v":0.5}""")) as ChoicesCode.Read.Refused).why)
    }

    @Test fun oneLeadingByteOrderMarkIsDroppedAsTheSitesTextDecoderDoes() {
        // the team's X2 (corpus line 35): the site accepts it; a second mark, or one later in the text, is still refused.
        assertTrue(ChoicesCode.read(code("\uFEFF{\"v\":1}")) is ChoicesCode.Read.Ok)
        assertTrue(refused("\uFEFF\uFEFF{\"v\":1}"))
        assertTrue(refused(" \uFEFF{\"v\":1}"))
    }

    @Test fun theParserItself() {
        assertEquals(mapOf("a" to listOf(1.0, "x", null, true)), StrictJson.parse("""{"a":[1,"x",null,true]}""").getOrNull())
        assertTrue(StrictJson.parse("").isFailure)
        assertTrue(StrictJson.parse("[1 2]").isFailure)
        assertTrue(StrictJson.parse("tru").isFailure)
    }
}
