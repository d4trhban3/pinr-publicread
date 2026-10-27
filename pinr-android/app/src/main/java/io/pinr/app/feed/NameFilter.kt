package io.pinr.app.feed

import java.text.Normalizer

/**
 * The rude-name filter, word for word the site's: coin names and
 * pictures are made by strangers, so a name or ticker with one of these stems is shown as "Name hidden" / "$•••" and
 * its picture is left out. On unless switched off (the switch comes with Settings, PLAN.md step 8). Nothing changes a score.
 */
object NameFilter {
    private val STEMS = listOf(
        "fuck", "fuk", "shit", "cunt", "pussy", "dick", "cock", "bitch", "whore", "slut", "porn", "penis", "vagina",
        "boob", "tits", "anal", "cum", "nigg", "fagg", "retard", "rape", "nazi", "hitler", "kkk", "jizz", "dildo", "wank",
    )
    /** Stems short enough to sit inside harmless words: matched only as a whole word ("cum" in "document" stays). */
    private val WHOLE_WORD_ONLY = setOf("cum", "anal", "kkk", "tits", "dick", "cock", "rape", "fuk", "porn")
    private val ALLOWED = setOf("moby dick")
    private val SWAPS = mapOf('0' to 'o', '1' to 'i', '3' to 'e', '4' to 'a', '5' to 's', '$' to 's', '@' to 'a', '!' to 'i')

    const val MASKED_NAME = "Name hidden"
    const val MASKED_TICKER = "$•••"

    @Volatile var enabled = true

    fun normalise(s: String): String {
        val folded = Normalizer.normalize(s, Normalizer.Form.NFKD).replace(Regex("[\\u0300-\\u036f]"), "").lowercase()
        return folded.map { SWAPS[it] ?: it }.joinToString("")
    }

    fun isRude(text: String?): Boolean {
        if (text.isNullOrEmpty()) return false
        // A ticker's leading "$" is not a letter swap ("$HIT" is not "shit").
        val plain = normalise(text.trimStart('$'))
        if (plain.jsTrim() in ALLOWED) return false
        // Matched inside one word at a time, never across a space.
        val words = plain.split(Regex("[^\\p{L}]+")).filter { it.isNotEmpty() }
        return STEMS.any { s -> if (s in WHOLE_WORD_ONLY) s in words else words.any { it.contains(s) } }
    }

    /** True when this coin's name, ticker and picture are masked right now. */
    fun masks(t: Token): Boolean = enabled && (isRude(t.name) || isRude(t.ticker))
}
