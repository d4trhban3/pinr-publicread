package io.pinr.app.feed

import org.json.JSONArray
import org.json.JSONObject

/**
 * The wallet rules, as the site's (pinr-live/src/world/wallet.ts). THE PROMISE: the app only ever learns a
 * PUBLIC address, typed or pasted. Nothing here connects to a wallet, signs, sends, approves or switches network, and
 * `scripts/check.sh` fails the build if a signing or sending call or a wallet library appears.
 */
object WalletRules {
    enum class Chain { Evm, Solana }

    /** The site's "View-only" card, word for word. */
    const val VIEW_ONLY_TITLE = "View-only"
    val VIEW_ONLY_POINTS = listOf(
        "You paste a public wallet address and PINR shows what it holds. That is public blockchain data, the same thing anyone can see on a block explorer.",
        "PINR does not connect to your wallet. It never asks for a signature, a seed phrase or a private key. If anything asks you for them, it is not PINR: stop.",
        "The address is remembered on this device only. You can clear it at any time.",
    )
    /** The short form shown over an address (ui/wallet.ts). */
    const val VIEW_ONLY_SHORT = "PINR only looks up this public address. It does not connect to your wallet."
    const val NOT_AN_ADDRESS = "That is not a wallet address. Check it and try again."

    private val EVM = Regex("^0x[0-9a-fA-F]{40}$")
    private val SOL = Regex("^[1-9A-HJ-NP-Za-km-z]{32,44}$")

    fun chain(s: String): Chain? = when {
        EVM.matches(s) -> Chain.Evm
        SOL.matches(s) -> Chain.Solana
        else -> null
    }

    /** An address in its one proper form (EVM lower-case, Solana as given), or null when it is not an address (cleanAddress). */
    fun clean(raw: String): Pair<String, Chain>? {
        val s = raw.jsTrim()
        val c = chain(s) ?: return null
        return (if (c == Chain.Evm) s.lowercase() else s) to c
    }

    /** "0x1a2b…9f0e" / "7xKX…Nq4P" (shortAddr). */
    fun short(a: String): String = if (a.length > 13) a.take(6) + "…" + a.takeLast(4) else a

    /** The site's avatar: three hues from the address (FNV-1a), the same on every device (avatarColors). */
    fun avatarHues(address: String): Triple<Int, Int, Int> {
        var h = 2166136261L
        for (ch in address.lowercase()) {
            h = h xor ch.code.toLong()
            h = (h * 16777619L) and 0xFFFFFFFFL
        }
        val hue = (h % 360).toInt()
        return Triple(hue, (hue + 70) % 360, (hue + 200) % 360)
    }
}

/** `/api/wallet?address=` (server/wallet.ts): the tracked tokens an address holds, from public balances. */
data class WalletView(val status: String, val holdings: List<Holding>, val totalUsd: Double?, val unavailable: List<String>) {
    data class Holding(
        val address: String, val chain: String, val name: String?, val ticker: String?, val balance: Double,
        /** balance × price, or null when there is no price (left out of the total) */
        val usd: Double?, val score: Int?, val noScoreLabel: String?,
    )

    companion object {
        fun parse(body: String): WalletView? {
            val o = try { JSONObject(body) } catch (e: Exception) { return null }
            fun num(v: Any?) = (v as? Number)?.toDouble()?.takeIf { it.isFinite() }
            val holdings = (o.opt("holdings") as? JSONArray)?.let { a ->
                (0 until a.length()).mapNotNull { i ->
                    val h = a.opt(i) as? JSONObject ?: return@mapNotNull null
                    val address = (h.opt("address") as? String)?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    val balance = num(h.opt("balance"))?.takeIf { it >= 0 } ?: return@mapNotNull null
                    val label = h.opt("noScoreLabel") as? String
                    // A label always wins; a score is a whole 1 to 99 or none (the contract's rules, as everywhere else).
                    val score = if (label != null) null else num(h.opt("score"))?.let(Token::wholeScore)
                    Holding(address, h.opt("chain") as? String ?: "", h.opt("name") as? String, h.opt("ticker") as? String, balance,
                        num(h.opt("usd"))?.takeIf { it >= 0 }, score, label)
                }
            } ?: emptyList()
            val unavailable = (o.opt("unavailable") as? JSONArray)?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String } } ?: emptyList()
            return WalletView(o.opt("status") as? String ?: "error", holdings, num(o.opt("totalUsd"))?.takeIf { it >= 0 }, unavailable)
        }
    }
}
