package io.pinr.app.feed

/** A chain's name as the page shows it ("Base", "BNB Chain", "Solana"), never the feed's raw id ("base", "bsc"); the site's
 *  pinr-live/src/world/chainname.ts. An id not known here is shown as it came. */
object ChainName {
    fun of(id: String): String = when (id.trim().lowercase()) {
        "solana" -> "Solana"
        "base" -> "Base"
        "bsc", "bnb" -> "BNB Chain"
        "ethereum", "eth" -> "Ethereum"
        else -> id
    }
}
