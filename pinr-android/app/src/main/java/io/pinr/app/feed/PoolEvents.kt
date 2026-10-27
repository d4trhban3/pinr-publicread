package io.pinr.app.feed

import org.json.JSONObject

/**
 * a coin's pool events as the engine reads them on chain (`frontend-feed/pools/<mint>.json`), served inside the dossier's `pool`
 * (the site's `poolevents.ts`): pool created, liquidity added and removed, the coin creator changed, bought back and burned. Each is an observed fact (●) with
 * its transaction as the receipt. A field the engine did not read is absent, never zero. State "none": no file, not checked yet; "read" with no events: none observed.
 */
data class PoolEvent(
    val atMs: Long, val kind: String, val sig: String, val user: String?, val base: Double?, val quote: Double?, val quoteSymbol: String, val raw: Boolean,
    val poolBase: Double?, val poolQuote: Double?, val oldCreator: String?, val newCreator: String?,
)
data class PoolEvents(val state: String, val source: String?, val asOfMs: Long?, val events: List<PoolEvent>, val chain: String = "solana") {
    companion object {
        val KINDS = setOf("pool created", "liquidity added", "liquidity removed", "coin creator changed", "bought back and burned")
        private val WALLET = Regex("^([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-f]{40})$")
        /** a Solana signature or an EVM 0x hash; a row fitting neither is dropped. */
        private val SIG = Regex("^([1-9A-HJ-NP-Za-km-z]{64,90}|0x[0-9a-f]{64})$")

        /** The dossier's `pool` object, or null when it is missing or unreadable (shown as "not checked yet"). Newest first as served. */
        fun parse(o: JSONObject?): PoolEvents? {
            o ?: return null
            val state = o.opt("state") as? String ?: return null
            if (state != "none" && state != "read") return null
            fun JSONObject.num(k: String): Double? = (opt(k) as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 }
            fun JSONObject.wallet(k: String): String? = (opt(k) as? String)?.takeIf { WALLET.matches(it) }
            val list = o.optJSONArray("events")
            val events = (0 until (list?.length() ?: 0)).mapNotNull { i ->
                val e = list?.optJSONObject(i) ?: return@mapNotNull null
                val kind = e.opt("kind") as? String ?: return@mapNotNull null
                val sig = (e.opt("sig") as? String)?.takeIf { SIG.matches(it) } ?: return@mapNotNull null
                val at = e.num("atMs")?.toLong() ?: return@mapNotNull null
                if (kind !in KINDS) return@mapNotNull null
                PoolEvent(at, kind, sig, e.wallet("user"), e.num("base"), e.num("quote"), (e.opt("quoteSymbol") as? String)?.take(20) ?: "the quote coin",
                    e.opt("raw") == true, e.num("poolBase"), e.num("poolQuote"), e.wallet("oldCreator"), e.wallet("newCreator"))
            }
            return PoolEvents(state, (o.opt("source") as? String)?.take(60), (o.opt("asOfMs") as? Number)?.toLong(), events,
                if (o.opt("chain") == "bnb") "bnb" else if (o.opt("chain") == "base") "base" else "solana")
        }
    }
}

/** The page's words for a pool event (the site's `renderPool`): observed, never a verdict. */
object PoolWords {
    fun amount(n: Double): String = when {
        n >= 1e9 -> String.format(java.util.Locale.US, "%.2fB", n / 1e9)
        n >= 1e6 -> String.format(java.util.Locale.US, "%.2fM", n / 1e6)
        n >= 1e3 -> String.format(java.util.Locale.US, "%.1fK", n / 1e3)
        n >= 1 -> String.format(java.util.Locale.US, "%.2f", n)
        else -> java.math.BigDecimal(n).round(java.math.MathContext(3)).stripTrailingZeros().toPlainString()
    }
    fun short(a: String) = "${a.take(4)}…${a.takeLast(4)}"
    /** The viewer's own clock, as the site draws it: "Oct 25, 12:35 PM" (`zone` only for tests). */
    fun local(ms: Long, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String =
        java.text.SimpleDateFormat("MMM d, h:mm a", java.util.Locale.US).apply { timeZone = zone }.format(java.util.Date(ms))
    /** A coin with no name shows its address, 6 characters then 4 (the site's rule), never a dash. */
    fun shortAddress(a: String) = if (a.length > 12) a.take(6) + "…" + a.takeLast(4) else a
    fun title(kind: String) = kind.replaceFirstChar { it.uppercase() }
    private fun scan(chain: String) = when (chain) { "bnb" -> "https://bscscan.com"; "base" -> "https://basescan.org"; else -> "https://solscan.io" }
    fun txUrl(sig: String, chain: String = "solana") = "${scan(chain)}/tx/$sig"
    fun accountUrl(a: String, chain: String = "solana") = "${scan(chain)}/${if (chain == "solana") "account" else "address"}/$a"

    /** The amounts line ("12.30 SOL and 1.20M tokens"), "" when the engine read none; raw units are said as such. */
    fun what(e: PoolEvent): String {
        val coin = e.base?.let { if (e.raw) "${amount(it)} raw token units" else "${amount(it)} tokens" } ?: ""
        val q = e.quote?.let { if (e.raw) "${amount(it)} raw ${e.quoteSymbol} units" else "${amount(it)} ${e.quoteSymbol}" } ?: ""
        return when (e.kind) {
            "bought back and burned" -> listOf(if (coin.isNotEmpty()) "$coin burned" else "", if (q.isNotEmpty()) "for $q" else "").filter { it.isNotEmpty() }.joinToString(" ")
            "pool created" -> {
                val pb = e.poolBase?.let { if (e.raw) "${amount(it)} raw token units" else "${amount(it)} tokens" } ?: coin
                val pq = e.poolQuote?.let { if (e.raw) "${amount(it)} raw ${e.quoteSymbol} units" else "${amount(it)} ${e.quoteSymbol}" } ?: q
                listOf(pq, pb).filter { it.isNotEmpty() }.joinToString(" and ")
            }
            "coin creator changed" -> ""
            else -> listOf(q, coin).filter { it.isNotEmpty() }.joinToString(" and ")
        }
    }
}
