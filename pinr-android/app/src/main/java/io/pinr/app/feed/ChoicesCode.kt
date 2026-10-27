package io.pinr.app.feed

import java.util.Base64

/**
 * no account at launch. A person's choices (the looked-up address, hidden coins, the name filter) travel
 * as one code they copy and paste, between phones or between the app and the site. Format version 1, exactly
 * `pinr-live/EXPORT-CODE-FORMAT.md`: `PINR1.` + base64url without padding of the compact JSON
 * `{"v":1,"w":[...],"h":[...],"f":true}`. Made and read on the phone; nothing is sent anywhere.
 */
object ChoicesCode {
    const val PREFIX = "PINR1."
    const val MAX_WALLETS = 10
    const val MAX_HIDDEN = 1_000

    /** What a code holds, after dropping whatever is not valid. [filter] is null when the code has none. */
    data class Choices(val wallets: List<String>, val hidden: List<String>, val filter: Boolean?)

    enum class Refusal(val text: String) { NotACode("That is not a PINR code."), Newer("This code is from a newer PINR.") }

    sealed interface Read {
        data class Ok(val choices: Choices) : Read
        data class Refused(val why: Refusal) : Read
    }

    /** The choices as they are now: the address first, the hidden set lower-case and sorted (same choices, same code), the filter. */
    fun make(wallets: List<String>, hidden: Collection<String>, filter: Boolean): String {
        val w = wallets.take(MAX_WALLETS)
        val h = hidden.map { it.lowercase() }.toSortedSet().take(MAX_HIDDEN)
        val json = """{"v":1,"w":${list(w)},"h":${list(h)},"f":$filter}"""
        return PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray(Charsets.UTF_8))
    }

    /** A compact JSON list of strings, escaped by hand so the bytes are exactly what the format's samples hold. */
    private fun list(items: List<String>): String = items.joinToString(",", "[", "]") { s ->
        buildString {
            append('"')
            for (c in s) when {
                c == '"' -> append("\\\"")
                c == '\\' -> append("\\\\")
                c < ' ' -> append(String.format("\\u%04x", c.code))
                else -> append(c)
            }
            append('"')
        }
    }

    /** Reads a code exactly as the site's `decodeChoices` (world/choicescode.ts): anything not a PINR code is refused whole. */
    fun read(text: String): Read {
        val s = text.jsTrim()
        if (!s.startsWith(PREFIX)) return Read.Refused(Refusal.NotACode)
        val payload = s.removePrefix(PREFIX)
        // The site's b64urlDecode: only base64url letters, never a length of 4n+1, and strict UTF-8.
        if (!payload.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' } || payload.length % 4 == 1) return Read.Refused(Refusal.NotACode)
        val json = try {
            val bytes = Base64.getUrlDecoder().decode(payload)
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(bytes)).toString()
                // The site's TextDecoder drops one leading byte-order mark (its default): so does the app.
                .removePrefix("\uFEFF")
        } catch (e: Exception) {
            return Read.Refused(Refusal.NotACode)
        }
        // As strict as the site's JSON.parse, and an object (not a list, string or null).
        val o = StrictJson.parse(json).getOrNull() as? Map<*, *> ?: return Read.Refused(Refusal.NotACode)
        // `v`: a finite number; above 1 is from a newer PINR; below 1 is not a code.
        val v = o["v"] as? Double ?: return Read.Refused(Refusal.NotACode)
        if (!v.isFinite()) return Read.Refused(Refusal.NotACode)
        if (v > 1) return Read.Refused(Refusal.Newer)
        if (v < 1) return Read.Refused(Refusal.NotACode)
        val wallets = ((o["w"] as? List<*>)?.mapNotNull { (it as? String)?.let(WalletRules::clean)?.first } ?: emptyList()).distinct().take(MAX_WALLETS)
        val hidden = ((o["h"] as? List<*>)?.mapNotNull { (it as? String)?.takeIf { h -> h.jsTrim().isNotEmpty() }?.jsTrim()?.lowercase() } ?: emptyList()).distinct().take(MAX_HIDDEN)
        return Read.Ok(Choices(wallets, hidden, o["f"] as? Boolean))
    }

    /** What a code holds, in the site's words (describeChoices): "1 wallet, 2 hidden coins, name filter off". */
    fun summary(c: Choices): String {
        fun n(k: Int, one: String, many: String) = "$k ${if (k == 1) one else many}"
        val filter = c.filter?.let { "name filter ${if (it) "on" else "off"}" } ?: "name filter unchanged"
        return listOf(n(c.wallets.size, "wallet", "wallets"), n(c.hidden.size, "hidden coin", "hidden coins"), filter).joinToString(", ")
    }
}
