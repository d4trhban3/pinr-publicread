package io.pinr.app.feed

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The transfer fee reads and reads out exactly as the site does. `transferfee-site.json` was made in node from
 * the site's own `server/transferfee.ts` (generator beside it): for each fee, whether the contract's rules accept it and the tile's short words.
 */
class TransferFeeTest {
    private val site = org.json.JSONArray(javaClass.classLoader!!.getResource("transferfee-site.json")!!.readText())

    @Test fun everyFeeIsAcceptedOrRefusedAndWordedAsTheSiteDoes() {
        assertTrue(site.length() >= 20)
        for (i in 0 until site.length()) {
            val c = site.getJSONObject(i)
            val fee = TransferFee.fromWire(c.getJSONObject("wire"))
            assertEquals("valid #$i ${c.getJSONObject("wire")}", c.getBoolean("valid"), fee != null)
            if (fee != null) assertEquals("short #$i", c.getString("short").ifEmpty { null }, fee.short())
        }
    }

    @Test fun anAbsentOrNullFeeIsMissingNotZero() {
        assertNull(TransferFee.fromWire(null))
        val t = Wire.snapshot("""{"contract":"1.0","tokens":[{"address":"A","coverage":50},{"address":"B","coverage":50,"transferFee":null},{"address":"C","coverage":50,"transferFee":{"pct":8,"kind":"outside_norm"}}]}""")!!.tokens.tokens
        assertNull(t[0].transferFee); assertNull(t[1].transferFee)
        assertEquals("8% not rewards", t[2].transferFee!!.short())
    }

    @Test fun theDossierFeeBlockCarriesItsLinesBadgeAndLinks() {
        val d = Dossier.parse(
            """{"available":true,"facts":[
              {"id":"transfer_fee","label":"Transfer fee","value":"12% · not a launchpad rewards fee","source":"Solana chain","readAtMs":1760000000000,"link":"https://solscan.io/token/m",
               "lines":["No reason found on chain:","Fees were paid to the dev group (2 wallets, 9 transfers)."],"badge":"High fee"},
              {"id":"fee_dev_payouts","label":"Fees paid to the dev group","value":"9 transfers to 2 wallets","source":"Solana chain","readAtMs":1760000000000,"link":"https://solscan.io/account/c",
               "moreLinks":{"lead":"Paid to","links":[{"label":"Ab12…yz","url":"https://solscan.io/account/Ab12"},{"label":"bad","url":"javascript:x"}]}},
              {"id":"transfer_fee","label":"Transfer fee","value":"—","notRead":true},
              {"id":"transfer_fee","label":"Transfer fee","value":"—","noSource":true,"badge":"Other"}
            ],"checks":[],"read":[],"links":[],"channels":[]}""",
        )!!
        val (fee, dev, unread, nosrc) = d.facts
        assertEquals(listOf("No reason found on chain:", "Fees were paid to the dev group (2 wallets, 9 transfers)."), fee.lines)
        assertEquals("High fee", fee.badge)
        assertEquals(listOf("Ab12…yz"), dev.moreLinks!!.links.map { it.label })
        assertEquals("Paid to", dev.moreLinks!!.lead)
        assertTrue(unread.notRead); assertEquals(Format.DASH, unread.value)
        assertNull(nosrc.badge); assertEquals(Format.DASH, nosrc.value)
    }

    @Test fun theOlderLaunchLinksStillReadAsLaunchNumbers() {
        val d = Dossier.parse(
            """{"available":true,"facts":[{"id":"transfer_fee","label":"Transfer fee","value":"3% · X, at its observed rate","source":"Solana chain","readAtMs":1760000000000,"link":"https://solscan.io/token/m",
              "launchLinks":["https://solscan.io/token/a","https://solscan.io/token/b"]}],"checks":[],"read":[],"links":[],"channels":[]}""",
        )!!
        assertEquals(listOf("launch 1", "launch 2"), d.facts[0].moreLinks!!.links.map { it.label })
        assertEquals("Standard observed on", d.facts[0].moreLinks!!.lead)
    }
}
