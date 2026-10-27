package io.pinr.app.feed

/** ● read on chain, ○ reported. An on-chain fact with no receipt link keeps its ● and says so beside it; the site's
 *  pinr-live/src/ui/orbit.ts does the same. */
object ReceiptMark {
    fun mark(onchain: Boolean): String = if (onchain) "●" else "○"
    fun word(onchain: Boolean): String = if (onchain) "read on chain" else "reported"
    /** The words beside an on-chain row that has no link yet; null otherwise. */
    fun note(onchain: Boolean, hasLink: Boolean): String? = if (onchain && !hasLink) "no receipt link yet" else null
}

/** What a coin with no trade read says (the site's NO_TRADES_READ in pinr-live/src/ui/tradeslist.ts), the same on every chain. */
object TradesWords {
    const val NO_TRADES_READ = "No trades read yet."
}

/** The site's pinr-live/src/world/figures.ts: a figure is shown only with its source named; a curve coin has no pool yet. */
object FigureRule {
    data class Shown(val value: String, val notRead: Boolean)
    fun shown(value: String, hasSource: Boolean, sourced: Boolean): Shown = when {
        !sourced -> Shown(value, false)
        value == Format.DASH -> Shown(value, true)
        hasSource -> Shown(value, false)
        else -> Shown(Format.DASH, true)
    }
    const val ON_CURVE = "On its bonding curve; no pool yet."
    fun noPoolWords(launchpad: String?): String {
        val lp = (launchpad ?: "").lowercase()
        return if (lp.contains("curve") || (lp.contains("launchlab") && !lp.contains("graduat"))) ON_CURVE else "Not checked yet."
    }
}
