package io.pinr.app.feed

import java.net.URI

/** One of the four labels that mean "proven bad: show the label, never a number". */
enum class NoScoreLabel(val text: String) {
    Vamp("VAMP"), BotRug("BOT/RUG"), Mayhem("MAYHEM"), Honeypot("HONEYPOT");

    companion object {
        fun of(text: String): NoScoreLabel? = entries.firstOrNull { it.text == text }
    }
}

/**
 * A token as the app shows it, made from a [WireToken] by the contract's rules (pinr-live/contract/DATA-CONTRACT.md),
 * the same rules as the site and the iPhone app (pinr-ios/PINR/Feed/Token.swift):
 * - a no-score label always wins: the number is dropped;
 * - a score is a whole number from 1 to 99, otherwise there is none;
 * - an optional figure outside its range is missing, never clamped or guessed;
 * - pictures come only from the feed server itself.
 * Times are milliseconds since 1970.
 */
data class Token(
    val address: String,
    val chain: String? = null,
    val launchpad: String? = null,
    val name: String? = null,
    val ticker: String? = null,
    val imageUrl: String? = null,
    /** 1..99, or null when there is no number. */
    val score: Int? = null,
    /** 0..100. */
    val coverage: Double,
    val label: NoScoreLabel? = null,
    val note: String? = null,
    val valuationUsd: Double? = null,
    val volume24hUsd: Double? = null,
    val change24hPct: Double? = null,
    val priceSeries: List<Double>? = null,
    val launchedAtMs: Long? = null,
    val asOfMs: Long? = null,
    val rank: Int? = null,
    val priceUsd: Double? = null,
    val liquidityUsd: Double? = null,
    val quotePair: String? = null,
    val changeWindowHours: Double? = null,
    val priceSource: String? = null,
    val lastTradeMs: Long? = null,
    val quoteReceipt: Receipt? = null,
    val capReceipt: Receipt? = null,
    /** The all-time-high market cap, only where a launchpad's own record states it; else missing. */
    val athUsd: Double? = null,
    val athReceipt: Receipt? = null,
    val flow: Flow? = null,
    val copyOf: CopyRef? = null,
    val possibleCopyOf: CopyRef? = null,
    /** The transfer fee, when the engine has read it; a copy (VAMP) never shows one. */
    val transferFee: TransferFee? = null,
    /** A coin the trigger has seen and the engine has not scored yet, and when it first saw it (else its read time). */
    val seen: Boolean = false,
    val seenAtMs: Long? = null,
    /** The engine's count of the hour's trades, preferred over the feed's DexScreener count on a tile; null when the engine gave none. */
    val hourTrades: Int? = null,
    /** The receipts of the feed's own figures: "volume", "liquidity", "pair" (`figSrc`). */
    val figSrc: Map<String, Receipt> = emptyMap(),
    /** Whether the feed sent a price line of two or more points. */
    val hasChartLine: Boolean = false,
) {
    /** Coins are compared without regard to letter case, as on the site. */
    val id: String get() = address.lowercase()

    /**
     * the PINR page's tiles hold back a coin that has neither a picture nor a chart line yet; it joins as soon as it
     * has one. It stays on Discover, in search and on its own page (the site's `hasSomethingToShow`).
     */
    val hasSomethingToShow: Boolean get() = imageUrl != null || hasChartLine

    /** A figure's receipt: which source it was read from, and when. */
    data class Receipt(val source: String, val atMs: Long)

    data class Flow(
        val buy5m: Double, val sell5m: Double, val buy1h: Double, val sell1h: Double,
        val trades5m: Int, val trades1h: Int,
        /** True when buy and sell are numbers of trades, not dollars. */
        val isCount: Boolean,
        /** False when the newest trades do not reach back the whole hour. */
        val complete: Boolean,
    )

    /** [chainProven] is true only when the chain confirmed two different creator wallets. */
    data class CopyRef(val address: String, val ticker: String?, val chainProven: Boolean)

    /** Why a token from the feed could not be shown. */
    enum class LeftOut { NoAddress, BadCoverage, UnknownLabel }

    sealed interface Made {
        data class Shown(val token: Token) : Made
        data class Left(val why: LeftOut) : Made
    }

    companion object {
        /** Builds a token from the feed's record. [feedBase] is the feed server's address; a picture anywhere else is dropped. */
        fun make(w: WireToken, feedBase: String?): Made {
            val address = w.address.jsTrim()
            if (address.isEmpty()) return Made.Left(LeftOut.NoAddress)
            if (!w.coverage.isFinite() || w.coverage !in 0.0..100.0) return Made.Left(LeftOut.BadCoverage)
            val label = w.noScoreLabel?.let { NoScoreLabel.of(it) ?: return Made.Left(LeftOut.UnknownLabel) }
            val score = if (label != null) null else w.score?.let(::wholeScore)
            return Made.Shown(
                Token(
                    address = address,
                    chain = text(w.chain),
                    launchpad = text(w.launchpad),
                    name = text(w.name),
                    ticker = text(w.ticker),
                    imageUrl = sameServer(w.imageUrl, feedBase),
                    score = score,
                    coverage = w.coverage,
                    label = label,
                    note = text(w.note),
                    valuationUsd = w.valuationUsd.finite { it >= 0 },
                    volume24hUsd = w.volume24hUsd.finite { it >= 0 },
                    change24hPct = w.change24hPct.finite { it > -100 },
                    priceSeries = w.priceSeries?.let { LiveCandle.head(it, w.priceUsd) }?.takeIf { s -> s.size in 2..500 && s.all { it.isFinite() && it > 0 } },
                    launchedAtMs = w.launchedAtMs?.let(::time),
                    asOfMs = w.asOfMs?.let(::time),
                    rank = w.rank.finite { it >= 0 && it == Math.floor(it) && it < Int.MAX_VALUE }?.toInt(),
                    priceUsd = w.priceUsd.finite { it > 0 },
                    liquidityUsd = w.liquidityUsd.finite { it >= 0 },
                    quotePair = text(w.quotePair),
                    changeWindowHours = w.changeWindowH.finite { it > 0 },
                    priceSource = text(w.priceSource),
                    lastTradeMs = w.lastTradeMs?.let(::time),
                    quoteReceipt = receipt(w.quoteSource, w.quoteAtMs),
                    capReceipt = receipt(w.capSource, w.capAtMs),
                    athUsd = w.athUsd.finite { it > 0 },
                    athReceipt = receipt(w.athSource, w.athAtMs),
                    flow = w.flow?.let(::flow),
                    copyOf = w.copyOf?.let { copyRef(it, w.copyProof) },
                    possibleCopyOf = w.possibleCopyOf?.let { copyRef(it, it.proof) },
                    transferFee = w.transferFee,
                    seen = w.seen,
                    seenAtMs = if (w.seen) (w.seenAtMs ?: w.asOfMs)?.let(::time) else null,
                    hourTrades = w.hourTrades?.toInt(),
                    hasChartLine = (w.priceSeries?.size ?: 0) >= 2,
                    figSrc = w.figSrc.mapNotNull { (k, v) -> receipt(v.first, v.second)?.let { k to it } }.toMap(),
                ),
            )
        }

        /** A score is a whole number from 1 to 99; anything else means there is no number. */
        fun wholeScore(v: Double): Int? = if (v.isFinite() && v == Math.floor(v) && v in 1.0..99.0) v.toInt() else null

        /**
         * A picture address is kept only when it points at the feed server itself (the server serves
         * `/api/img?a=<address>`); anything else is dropped: the phone only talks to the feed server.
         */
        fun sameServer(raw: String?, base: String?): String? {
            val r = text(raw) ?: return null
            base ?: return null
            return try {
                val b = URI(base)
                val u = b.resolve(r)
                if (u.scheme == b.scheme && u.host == b.host && u.port == b.port && u.rawPath == "/api/img" && u.rawUserInfo == null) u.toString() else null
            } catch (e: Exception) {
                null
            }
        }

        private inline fun Double?.finite(ok: (Double) -> Boolean): Double? = this?.takeIf { it.isFinite() && ok(it) }
        private fun text(s: String?): String? = s?.let(Invisible::strip)?.jsTrim()?.takeIf { it.isNotEmpty() }
        private fun time(ms: Double): Long? = if (ms.isFinite() && ms > 0) ms.toLong() else null
        private fun receipt(source: String?, atMs: Double?): Receipt? {
            val s = text(source) ?: return null
            val at = atMs?.let(::time) ?: return null
            return Receipt(s, at)
        }
        private fun flow(f: WireFlow): Flow? {
            val figures = listOf(f.buy5m, f.sell5m, f.buy1h, f.sell1h, f.n5m, f.n1h)
            if (!figures.all { it.isFinite() && it >= 0 }) return null
            return Flow(f.buy5m, f.sell5m, f.buy1h, f.sell1h, f.n5m.toInt(), f.n1h.toInt(), f.basis == "count", f.complete)
        }
        private fun copyRef(r: WireCopyRef, proof: String?): CopyRef? =
            text(r.address)?.let { CopyRef(it, text(r.ticker), proof == "chain") }
    }
}
