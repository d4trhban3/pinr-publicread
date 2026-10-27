package io.pinr.app.feed

/**
 * Coin names and tickers with the invisible characters taken out (the site's `visibletext.ts`; the team, 2026-10-25: the Arena showed "Blind Ape" with a hidden
 * U+2060 inside). Out go the format characters (zero-width space, joiners and non-joiners, the word joiner, the byte order mark, direction marks and overrides, the
 * soft hyphen, invisible maths operators), the variation selectors and tags, and the characters that draw as a blank (Hangul fillers, the braille blank, a combining
 * grapheme joiner). A zero-width joiner between two emoji stays, so an emoji built from parts still draws as one, and variation selector 16 stays straight after an
 * emoji. Control characters become spaces, runs of space become one, and the ends are trimmed.
 */
object Invisible {
    private val BLANKS = setOf(0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x2800, 0x3164, 0xFFA0) + (0x180B..0x180F)

    /** A pictographic character (the emoji family; digits and # * are not): the main emoji and symbol blocks. */
    private fun isPicto(c: Int): Boolean =
        c in 0x1F000..0x1FAFF || c in 0x2600..0x27BF || c in 0x2300..0x23FF && c > 0x238C || c in 0x2B00..0x2BFF || c in 0x2190..0x21FF || c in 0x2900..0x297F ||
            c == 0x00A9 || c == 0x00AE || c == 0x203C || c == 0x2049 || c == 0x2122 || c == 0x2139 || c == 0x3030 || c == 0x303D || c == 0x3297 || c == 0x3299
    private fun isSelector(c: Int) = c in 0xFE00..0xFE0F

    fun strip(text: String): String {
        val chars = text.codePoints().toArray()
        val out = StringBuilder(text.length)
        for ((i, c) in chars.withIndex()) {
            if (c == 0x200D) {
                var p = i - 1
                while (p >= 0 && isSelector(chars[p])) p--
                if (p >= 0 && isPicto(chars[p]) && i + 1 < chars.size && isPicto(chars[i + 1])) out.appendCodePoint(c)
                continue
            }
            if (c == 0xFE0F && i > 0 && isPicto(chars[i - 1])) { out.appendCodePoint(c); continue }
            if (Character.getType(c) == Character.FORMAT.toInt() || isSelector(c) || c in BLANKS || c in 0xE0000..0xE007F || c in 0xE0100..0xE01EF) continue
            out.appendCodePoint(if (c < 0x20 || c in 0x7F..0x9F) 0x20 else c)
        }
        return out.toString().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
    }
}
