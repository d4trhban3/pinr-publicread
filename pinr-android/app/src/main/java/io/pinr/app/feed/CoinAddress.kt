package io.pinr.app.feed

import java.net.URI

/** A coin's address, and the links that name one (decision D3: the site opens `pinr.io/?coin=<address>`). */
object CoinAddress {
    private val ADDRESS = Regex("^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$")

    /** An exact Solana (base58, 32 to 44 characters) or EVM (0x and 40 hex digits) address. */
    fun isAddress(s: String): Boolean = ADDRESS.matches(s)

    /** The address a link names, or null: `pinr://coin/<address>`, or `https://pinr.io/?coin=<address>`. Anything else in the link is ignored. */
    fun parse(link: String?): String? {
        val u = try { URI(link ?: return null) } catch (e: Exception) { return null }
        val host = u.host?.lowercase()
        val candidate = when (u.scheme?.lowercase()) {
            "pinr" -> if (host == "coin") u.path?.trim('/')?.takeIf { it.isNotEmpty() && '/' !in it } else null
            "https" -> if (host == "pinr.io" || host == "www.pinr.io") {
                u.rawQuery?.split('&')?.map { it.split('=', limit = 2) }?.firstOrNull { it[0] == "coin" }?.getOrNull(1)
            } else null
            else -> null
        }
        return candidate?.takeIf { isAddress(it) }
    }
}
