package io.pinr.app.feed

/**
 * A JSON reader exactly as strict as the site's `JSON.parse` (RFC 8259 / ECMA-404): double-quoted keys and strings only,
 * no trailing commas, no comments, nothing after the value but whitespace (space, tab, line feed, carriage return). A
 * repeated key is accepted and the last one wins, as `JSON.parse` does. Used for the choices code, so a
 * damaged code is refused here exactly when the site refuses it. Values come back as Map, List, String, Double, Boolean
 * or null; null is returned for the whole text when it is not JSON.
 */
object StrictJson {
    private object Null

    fun parse(text: String): Result<Any?> {
        val p = P(text)
        return try {
            p.ws()
            val v = p.value()
            p.ws()
            if (p.i != text.length) Result.failure(IllegalArgumentException("text after the value")) else Result.success(if (v === Null) null else v)
        } catch (e: IllegalArgumentException) {
            Result.failure(e)
        }
    }

    private class P(val s: String) {
        var i = 0

        fun fail(why: String): Nothing = throw IllegalArgumentException("$why at $i")

        fun ws() { while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++ }

        fun value(): Any = when {
            i >= s.length -> fail("end of text")
            s[i] == '{' -> obj()
            s[i] == '[' -> arr()
            s[i] == '"' -> str()
            s[i] == '-' || s[i] in '0'..'9' -> num()
            s.startsWith("true", i) -> { i += 4; true }
            s.startsWith("false", i) -> { i += 5; false }
            s.startsWith("null", i) -> { i += 4; Null }
            else -> fail("unexpected character")
        }

        fun obj(): Map<String, Any?> {
            i++
            val m = LinkedHashMap<String, Any?>()
            ws()
            if (i < s.length && s[i] == '}') { i++; return m }
            while (true) {
                ws()
                if (i >= s.length || s[i] != '"') fail("a key must be a double-quoted string")
                val k = str()
                ws()
                if (i >= s.length || s[i] != ':') fail("expected ':'")
                i++
                ws()
                val v = value()
                m.remove(k) // a repeated key: the last one wins
                m[k] = if (v === Null) null else v
                ws()
                when {
                    i < s.length && s[i] == ',' -> i++
                    i < s.length && s[i] == '}' -> { i++; return m }
                    else -> fail("expected ',' or '}'")
                }
            }
        }

        fun arr(): List<Any?> {
            i++
            val l = ArrayList<Any?>()
            ws()
            if (i < s.length && s[i] == ']') { i++; return l }
            while (true) {
                ws()
                val v = value()
                l += if (v === Null) null else v
                ws()
                when {
                    i < s.length && s[i] == ',' -> i++
                    i < s.length && s[i] == ']' -> { i++; return l }
                    else -> fail("expected ',' or ']'")
                }
            }
        }

        fun str(): String {
            i++
            val b = StringBuilder()
            while (true) {
                if (i >= s.length) fail("unterminated string")
                val c = s[i++]
                when {
                    c == '"' -> return b.toString()
                    c < ' ' -> fail("a control character in a string")
                    c == '\\' -> {
                        if (i >= s.length) fail("unterminated escape")
                        when (val e = s[i++]) {
                            '"' -> b.append('"'); '\\' -> b.append('\\'); '/' -> b.append('/')
                            'b' -> b.append('\b'); 'f' -> b.append('\u000C'); 'n' -> b.append('\n'); 'r' -> b.append('\r'); 't' -> b.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) fail("short \\u escape")
                                val h = s.substring(i, i + 4)
                                if (!h.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) fail("bad \\u escape")
                                b.append(h.toInt(16).toChar()); i += 4
                            }
                            else -> fail("bad escape \\$e")
                        }
                    }
                    else -> b.append(c)
                }
            }
        }

        fun num(): Double {
            val start = i
            if (s[i] == '-') i++
            if (i >= s.length) fail("bad number")
            if (s[i] == '0') i++
            else if (s[i] in '1'..'9') { while (i < s.length && s[i] in '0'..'9') i++ }
            else fail("bad number")
            if (i < s.length && s[i] == '.') {
                i++
                if (i >= s.length || s[i] !in '0'..'9') fail("bad fraction")
                while (i < s.length && s[i] in '0'..'9') i++
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                if (i >= s.length || s[i] !in '0'..'9') fail("bad exponent")
                while (i < s.length && s[i] in '0'..'9') i++
            }
            return s.substring(start, i).toDouble() // 1e999 reads as Infinity, as in JavaScript
        }
    }
}
