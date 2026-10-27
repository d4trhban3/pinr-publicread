package io.pinr.app.feed

import java.net.URLEncoder

/**
 * The outside sites for a coin's full chart and its own pages (the site's `chartLinks`, ui/coinpage.ts): only what applies to the coin's
 * chain; the Pump.fun page only for a Pump.fun coin; the chain's explorer; the launchpad's own page where it has one for a coin;
 * and TradingView last: the coin's own chart where TradingView lists it (`/api/tvsymbol`), else its chart page, whose search box finds the coin
 * (TradingView has no address search by link). The app opens them in the reader's own browser; PINR sends nothing.
 */
object ChartLinks {
    const val TRADINGVIEW_CHART = "https://www.tradingview.com/chart/"
    private val SYMBOL = Regex("^[A-Z0-9_]{2,40}:[A-Z0-9_.\\-]{2,60}$")

    data class Item(val label: String, val url: String)

    /** A TradingView symbol the site accepts (`EXCHANGE:NAME`), else null. */
    fun validSymbol(s: String?): String? = s?.takeIf { SYMBOL.matches(it) }

    fun tradingViewUrl(symbol: String?): String =
        validSymbol(symbol)?.let { "$TRADINGVIEW_CHART?symbol=${URLEncoder.encode(it, "UTF-8").replace("%3A", ":")}" } ?: TRADINGVIEW_CHART

    private fun enc(a: String): String = URLEncoder.encode(a, "UTF-8").replace("+", "%20")

    fun links(address: String, chain: String?, launchpad: String?, tvSymbol: String? = null): List<Item> {
        if (address.isEmpty()) return emptyList()
        val slug = mapOf("solana" to "solana", "base" to "base", "bsc" to "bsc", "bnb" to "bsc", "ethereum" to "ethereum")[(chain ?: "").lowercase()] ?: return emptyList()
        val e = enc(address)
        val lp = launchpad ?: ""
        fun has(p: String) = Regex(p, RegexOption.IGNORE_CASE).containsMatchIn(lp)
        val out = mutableListOf(
            Item("DexScreener", "https://dexscreener.com/$slug/$e"),
            Item("GeckoTerminal", "https://www.geckoterminal.com/$slug/tokens/$e"),
        )
        if (slug == "solana" && has("pump")) out += Item("Pump.fun", "https://pump.fun/coin/$e")
        when (slug) {
            "solana" -> out += Item("Solscan", "https://solscan.io/token/$e")
            "base" -> out += Item("Basescan", "https://basescan.org/token/$e")
            "bsc" -> out += Item("BscScan", "https://bscscan.com/token/$e")
            "ethereum" -> out += Item("Etherscan", "https://etherscan.io/token/$e")
        }
        if (slug == "base" && has("clanker")) out += Item("Clanker", "https://www.clanker.world/clanker/$e")
        if (slug == "base" && has("zora")) out += Item("Zora", "https://zora.co/coin/base:$e")
        if (slug == "base" && has("virtuals")) out += Item("Virtuals", "https://app.virtuals.io/prototypes/$e")
        if (slug == "bsc" && has("four\\.?meme")) out += Item("Four.meme", "https://four.meme/token/$e")
        if (slug == "bsc" && has("flap")) out += Item("Flap", "https://flap.sh/bnb/$e")
        out += Item("TradingView", tradingViewUrl(tvSymbol))
        return out
    }
}
