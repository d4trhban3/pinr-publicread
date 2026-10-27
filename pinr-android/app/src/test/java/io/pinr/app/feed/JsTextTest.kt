package io.pinr.app.feed

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The app trims exactly as JavaScript does. `jstrim-site.json` was made in node (generator beside it,
 * jstrim-site.gen.ts.txt): every UTF-16 code unit String.prototype.trim strips, and the site's own decodeChoices,
 * cleanAddress and Number() fed each of them (plus near misses Kotlin or Java count as space) around a real code,
 * a wallet and a number.
 */
class JsTextTest {
    private val site = JSONObject(javaClass.classLoader!!.getResource("jstrim-site.json")!!.readText())

    @Test fun everyCodeUnitIsSpaceExactlyWhenJavaScriptSaysSo() {
        val spaces = site.getJSONArray("spaces").let { a -> (0 until a.length()).map { a.getInt(it) }.toSet() }
        for (c in 0..0xFFFF) assertEquals("U+%04X".format(c), c in spaces, JsText.isSpace(c.toChar()))
        assertEquals("a", "\uFEFF\u2028 a\u3000\u00A0".jsTrim())
        assertEquals("\u001Ca\u0085", "\u001Ca\u0085".jsTrim())
    }

    @Test fun theSitesCodeWalletAndNumberReadersAgreeAroundEveryOne() {
        val cases = site.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val k = cases.getJSONObject(i); val u = "U+%04X".format(k.getInt("c"))
            assertEquals("$u pasted code", k.getBoolean("pastedOk"), ChoicesCode.read(k.getString("pasted")) is ChoicesCode.Read.Ok)
            val inner = ChoicesCode.read(k.getString("inner")) as ChoicesCode.Read.Ok
            assertEquals("$u wallets in a code", list(k, "innerWallets"), inner.choices.wallets)
            assertEquals("$u hidden in a code", list(k, "innerHidden"), inner.choices.hidden)
            val ch = k.getInt("c").toChar().toString()
            assertEquals("$u Solana", k.opt("sol").takeIf { it != JSONObject.NULL }, WalletRules.clean("${ch}So11111111111111111111111111111111111111112$ch")?.first)
            assertEquals("$u EVM", k.opt("evm").takeIf { it != JSONObject.NULL }, WalletRules.clean("${ch}0xAbC0000000000000000000000000000000000001")?.first)
            // A saved period written as text goes through Number(): NaN falls back to the default (20).
            val want = if (k.isNull("num")) 20 else k.getDouble("num").toInt()
            val saved = JSONObject().put("sma", JSONObject().put("params", JSONObject().put("n", "${ch}7$ch"))).toString()
            assertEquals("$u Number()", want, IndSpecs.parse(saved).getValue(IndId.Sma).params["n"])
        }
    }

    /** Number(text) on the texts where Kotlin's toDouble() and JavaScript part ways (hex, binary, octal, suffixes, signs). */
    @Test fun numbersReadAsJavaScriptsNumber() {
        val nums = site.getJSONArray("numbers")
        for (i in 0 until nums.length()) {
            val k = nums.getJSONObject(i); val t = k.getString("t")
            val want = when (val n = k.getString("n")) { "NaN" -> Double.NaN; "Infinity" -> Double.POSITIVE_INFINITY; "-Infinity" -> Double.NEGATIVE_INFINITY; else -> n.toDouble() }
            assertEquals("Number(\"$t\")", want, t.jsNumber(), 0.0)
        }
    }

    private fun list(k: JSONObject, key: String) = k.getJSONArray(key).let { a -> (0 until a.length()).map { a.getString(it) } }
}
