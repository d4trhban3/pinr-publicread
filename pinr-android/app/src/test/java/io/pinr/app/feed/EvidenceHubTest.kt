package io.pinr.app.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The evidence hub on the coin page: the wire reading and the site's words (world/orbit.ts). */
class EvidenceHubTest {
    private val now = 2_000_000_000_000L
    private val json = """
    {"evidence":{"contract":"evidence/1","asOfMs":$now,
     "rows":[
       {"from":{"kind":"coin","id":"MintMintMintMint1111"},"to":{"kind":"wallet","id":"CreatorCreator2222"},"what":"created by","value":null,"unit":null,"atMs":${now - 600_000},"firstReadMs":null,"readMs":${now - 300_000},"source":"Pump.fun","link":"https://pump.fun/coin/x","onchain":false},
       {"from":{"kind":"wallet","id":"HolderHolder3333"},"to":{"kind":"coin","id":"MintMintMintMint1111"},"what":"holds","value":{"amount":1500000,"dev":true,"sniper":false},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":"Solana chain","link":"http://insecure.example/x","onchain":true},
       {"from":{"kind":"a","id":"b"},"to":{"kind":"c","id":"d"},"what":"something new","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":false},
       {"bad":true}
     ],
     "gate":{"status":"held","words":["Another coin with the same name and ticker launched earlier."],
       "items":[{"kind":"earlier_lookalike","words":"Another coin with the same name and ticker launched earlier.","same":"name and ticker","coin":"EarlierEarlier4444","launchedAtMs":${now - 180_000},"link":"https://pump.fun/coin/e","creator":"OtherOther5555","creatorLink":"https://solscan.io/account/o"}],
       "creator":{"id":"CreatorCreator2222","link":"https://solscan.io/account/c","launchCount":9,"otherCoins":[{"coin":"SecondSecond6666","launchedAtMs":${now - 86_400_000},"link":"https://pump.fun/coin/s"}]},
       "launchedAtMs":$now,"source":"Jupiter","readMs":${now - 60_000}},
     "pinrai":{"status":"read","readMs":${now - 120_000},"model":null,"dropped":2,"pending":null,
       "items":[{"kind":"x","words":"The coin lists an X account that belongs to another project.","reviewed":false,
                 "receipts":[{"source":"X","value":"@other","link":"https://x.com/other","asOfMs":${now - 3_600_000},"onchain":false}]}]}}}
    """.trimIndent()
    private val hub get() = EvidenceHub.parse(json)!!

    @Test fun aBadRowIsDroppedAloneAndAnInsecureLinkIsNotKept() {
        assertEquals(3, hub.rows.size)
        assertEquals("https://pump.fun/coin/x", hub.rows[0].link)
        assertNull(hub.rows[1].link); assertTrue(hub.rows[1].onchain)
    }

    @Test fun aSmallRealAmountIsNeverZero() {
        assertEquals("0.001", PoolWords.amount(0.001)); assertEquals("0.000999", PoolWords.amount(0.00099895))
        assertEquals("0.0000001", PoolWords.amount(0.0000001))
    }

    @Test fun evidenceNullIsNoHub() {
        assertNull(EvidenceHub.parse("""{"evidence":null}"""))
        assertNull(EvidenceHub.parse("not json"))
    }

    @Test fun rowsFallIntoTheSitesSixGroupsInItsWords() {
        val g = EvidenceWords.orbitGroups(hub, now)
        assertEquals(listOf("Creator", "Funders", "Holders", "Pool", "Socials", "Links"), g.map { it.label })
        assertEquals("Created by Creato…2222", g[0].facts[0].text)
        assertEquals(listOf("read 5 min ago", "happened 10 min ago"), listOf(g[0].facts[0].readText, g[0].facts[0].happenedText))
        assertEquals("Holder…3333 holds 1.50M of it · the source marks it: dev", g[2].facts[0].text)
        assertTrue(g[4].facts.isEmpty() && g[4].empty.endsWith("not checked yet."))
        assertEquals("something new", g[5].facts[0].text)
    }

    @Test fun theGateSaysHowMuchEarlierTheLookAlikeLaunchedAndLinksIt() {
        val v = EvidenceWords.gateView(hub.gate, now)!!
        assertEquals("Observed at launch:", v.headline)
        assertEquals(1, v.lines.size); assertEquals("launched 3 min earlier", v.lines[0].whenText)
        assertEquals(listOf("see the earlier coin Earl…4444", "its creator Othe…5555"), v.lines[0].links.map { it.first })
        assertEquals(listOf("Seco…6666", "launched 1 day ago"), listOf(v.others[0].label, v.others[0].whenText))
        assertEquals("read 1 min ago · Jupiter", v.readText)
        assertNull(EvidenceWords.gateView(null, now))
    }

    @Test fun theGateWithNothingFoundAndNotReadYet() {
        val none = EvidenceHub.Gate("passed", listOf("Nothing matching was found at launch."), emptyList(), null, emptyList(), null, null, null)
        assertEquals("Nothing matching was found at launch.", EvidenceWords.gateView(none, now)!!.headline)
        assertEquals("Not checked yet.", EvidenceWords.gateView(none.copy(status = "not read yet", words = emptyList()), now)!!.headline)
    }

    @Test fun pinraiShowsItsWordsAndReceiptsWithDotsAndOffShowsOnlyTheHeadline() {
        val v = EvidenceWords.pinraiView(hub.pinrai, now)!!
        assertEquals("Observed in the evidence:", v.headline); assertNull(v.counts)
        val r = v.lines[0].receipts[0]
        assertEquals(Triple("X: @other", false, "1 h ago"), Triple(r.text, r.onchain, r.whenText))
        val off = EvidenceHub.Pinrai("off", null, null, listOf(EvidenceHub.PinraiItem("x", true, emptyList())), null, null)
        val o = EvidenceWords.pinraiView(off, now)!!
        assertEquals("PINRai is switched off.", o.headline); assertTrue(o.lines.isEmpty())
    }

    @Test fun baseAndBnbRowsLandInTheirGroupsInPlainWordsWithZorasOwnersCanAlwaysShown() {
        val j = """{"evidence":{"contract":"evidence/1","asOfMs":1,"rows":[
       {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"what":"holds","value":{"share":0.99997700085,"note":"Four.meme launchpad (its curve holds the unsold supply)"},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"what":"holds","value":{"share":2.29991407603e-5},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"what":"holds (dev team)","value":{"wallets":9948.97,"share":0.87},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"count","id":"holders"},"what":"holders counted","value":1234,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"what":"dev moves","value":{"members":1,"acquired":22999.14},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"dev team: reward admin","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"what":"bought at launch","value":{"eth":0.5,"tokens":9948.97},"unit":"ETH / tokens","atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"contract","id":"launch service"},"what":"is a contract (a launch service, not a person)","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"owned by (contract owner)","value":{"can":"change the buy and sell tax rates; withdraw tokens","template":"AgentTokenV4 (verified)"},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"creator rewards paid to","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"tax paid to","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"launchpad","id":"Four.meme"},"what":"launched on","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"pool","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"trades in pool (Uniswap v4)","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"locker","id":"Clanker locker"},"what":"liquidity locked","value":1,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"contract","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"liquidity held by Zora's hook","value":{"locked_share":1,"owners_can":"move it into another pool on Zora's approved list; no one can withdraw it"},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"check","id":"tax"},"what":"trading tax","value":{"buy_pct":1,"sell_pct":3},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"pool","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"trades in pool","value":{"lp_burned_share":1},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"zora","id":"basefolio"},"what":"creator's Zora profile","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"x","id":"https://x.com/777humdrum777"},"what":"creator's linked account","value":{"username":"777humdrum777","followers":805},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"contract","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"copy of the template","value":"FlapTaxTokenV3 (verified, no mint/pause/blacklist)","unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
       {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"check","id":"GoPlus"},"what":"GoPlus security check (a lead)","value":"nothing flagged","unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true}
        ]}}"""
        val h = EvidenceHub.parse(j)!!
        val g = EvidenceWords.orbitGroups(h, now).associate { it.id to it.facts.map { f -> f.text } }
        assertEquals(listOf("0x654b…fe03 holds 99.99% of the supply · Four.meme launchpad (its curve holds the unsold supply)", "0x654b…fe03 holds 0.0023% of the supply", "The dev team's wallets hold 87% of it", "1,234 wallets hold this coin"), g[EvidenceWords.GroupId.Holders])
        assertEquals(listOf("The creator's tokens moved · 1 wallet, 23.0K tokens acquired", "Dev team wallet, reward admin: 0x654b…fe03", "0x654b…fe03 bought at launch · 9.9K tokens for 0.5 ETH", "0x654b…fe03 is a contract (a launch service, not a person)", "Contract owner: 0x654b…fe03 · AgentTokenV4 (verified) · the owner can: change the buy and sell tax rates; withdraw tokens", "Creator rewards go to 0x654b…fe03", "Tax goes to 0x654b…fe03"), g[EvidenceWords.GroupId.Creator])
        assertEquals(listOf("Launched on Four.meme", "Trades in the Uniswap v4 pool 0x654b…fe03", "Liquidity locked: 100% of the pool · Clanker locker", "Zora's hook holds 100% of the pool's liquidity; its owners can move it into another pool on Zora's approved list; no one can withdraw it", "Trading tax: buy 1%, sell 3%", "Trades in the pool 0x654b…fe03 · 100% of its LP tokens burned"), g[EvidenceWords.GroupId.Pool])
        assertEquals(listOf("Creator's Zora profile @basefolio", "Creator's linked account @777humdrum777 · 805 followers"), g[EvidenceWords.GroupId.Socials])
        assertEquals(listOf("Contract is a copy of FlapTaxTokenV3 (verified, no mint/pause/blacklist)", "GoPlus check (a lead): nothing flagged"), g[EvidenceWords.GroupId.Links])
    }

    @Test fun aSmallFundingIsNeverRoundedToZero() {
        fun row(v: String, u: String) = """{"from":{"kind":"wallet","id":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111"},"to":{"kind":"wallet","id":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2222"},"what":"funded","value":$v,"unit":"$u","atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true}"""
        val j = """{"evidence":{"contract":"evidence/1","asOfMs":1,"rows":[${row("0.001", "BNB")},${row("0.000999", "ETH")},${row("2.5", "BNB")}]}}"""
        val t = EvidenceWords.orbitGroups(EvidenceHub.parse(j)!!, now)[1].facts.map { it.text }
        assertEquals(listOf("0xaaaa…1111 sent 0.001 BNB to 0xbbbb…2222", "0xaaaa…1111 sent 0.000999 ETH to 0xbbbb…2222", "0xaaaa…1111 sent 2.5 BNB to 0xbbbb…2222"), t)
    }
}
