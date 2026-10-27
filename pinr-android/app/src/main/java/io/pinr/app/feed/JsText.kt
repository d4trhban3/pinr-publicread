package io.pinr.app.feed

/**
 * JavaScript's whitespace, so the app trims exactly as the site does (ECMAScript's WhiteSpace and LineTerminator:
 * String.prototype.trim and Number() strip these and nothing else). Kotlin's own trim() differs both ways: it keeps
 * U+FEFF and strips U+001C to U+001F. Tested code unit by code unit against node in JsTextTest.
 */
object JsText {
    fun isSpace(c: Char): Boolean = when (c) {
        '\u0009', '\u000A', '\u000B', '\u000C', '\u000D', ' ', '\u00A0', '\u1680', '\u2028', '\u2029',
        '\u202F', '\u205F', '\u3000', '\uFEFF' -> true
        else -> c in '\u2000'..'\u200A'
    }
}

/** String.prototype.trim. */
fun String.jsTrim(): String = trim(JsText::isSpace)

/**
 * JavaScript's Number(text) (ECMAScript StringNumericLiteral): trimmed as above; empty is 0; 0x/0b/0o whole numbers
 * without a sign; otherwise an optional sign, Infinity or a decimal with an optional exponent; anything else NaN.
 * Kotlin's toDouble() differs: it also strips control characters and takes "7d", "7f" and hex fractions.
 */
fun String.jsNumber(): Double {
    val t = jsTrim()
    if (t.isEmpty()) return 0.0
    fun radix(prefix: Char, r: Int, digits: Regex): Double? =
        if (t.length > 2 && t[0] == '0' && t[1].lowercaseChar() == prefix && digits.matches(t.substring(2)))
            t.substring(2).fold(0.0) { a, ch -> a * r + Character.digit(ch, r) } else null
    radix('x', 16, Regex("[0-9a-fA-F]+"))?.let { return it }
    radix('b', 2, Regex("[01]+"))?.let { return it }
    radix('o', 8, Regex("[0-7]+"))?.let { return it }
    return if (Regex("[+-]?(Infinity|(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?)").matches(t)) t.toDouble() else Double.NaN
}
