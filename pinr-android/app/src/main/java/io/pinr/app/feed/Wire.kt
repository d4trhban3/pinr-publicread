package io.pinr.app.feed

import org.json.JSONArray
import org.json.JSONObject

/**
 * One token exactly as the feed server sends it (`WireToken` in pinr-live/server/translate.ts). Reading is lenient
 * field by field: an optional field that is absent, null or of the wrong type is missing (null), never a guess. Only
 * `address` and `coverage` are required; a token without them cannot be read and is left out.
 */
data class WireToken(
    val address: String,
    val coverage: Double,
    val score: Double? = null,
    val noScoreLabel: String? = null,
    val chain: String? = null,
    val launchpad: String? = null,
    val name: String? = null,
    val ticker: String? = null,
    val imageUrl: String? = null,
    val note: String? = null,
    val valuationUsd: Double? = null,
    val volume24hUsd: Double? = null,
    val change24hPct: Double? = null,
    val priceSeries: List<Double>? = null,
    val launchedAtMs: Double? = null,
    val asOfMs: Double? = null,
    val rank: Double? = null,
    val priceUsd: Double? = null,
    val liquidityUsd: Double? = null,
    val quotePair: String? = null,
    val changeWindowH: Double? = null,
    val priceSource: String? = null,
    val lastTradeMs: Double? = null,
    val quoteSource: String? = null,
    val quoteAtMs: Double? = null,
    val capSource: String? = null,
    val capAtMs: Double? = null,
    val athUsd: Double? = null,
    val athSource: String? = null,
    val athAtMs: Double? = null,
    val flow: WireFlow? = null,
    val copyOf: WireCopyRef? = null,
    val copyProof: String? = null,
    val possibleCopyOf: WireCopyRef? = null,
    /** The coin's transfer fee, checked on arrival; missing when absent or when it breaks the contract. */
    val transferFee: TransferFee? = null,
    /** a coin the trigger has seen and the engine has not scored yet (`seen: true`, only ever true) and when it first saw it. */
    val seen: Boolean = false,
    val seenAtMs: Double? = null,
    /** The engine's own count of the hour's trades: all or nothing, never a part-hour. */
    val hourTrades: Double? = null,
    /** Where the feed read a figure, and when (`figSrc`: volume, liquidity, pair). */
    val figSrc: Map<String, Pair<String, Double>> = emptyMap(),
)

/** Buy and sell over 5 minutes and an hour (`FlowSummary` in pinr-live/server/trades.ts); basis "count" = trades, not dollars. */
data class WireFlow(
    val buy5m: Double, val sell5m: Double, val buy1h: Double, val sell1h: Double,
    val n5m: Double, val n1h: Double, val lastAt: Double?, val complete: Boolean, val basis: String?,
)

data class WireCopyRef(val address: String, val ticker: String?, val proof: String?)

/** A list of tokens where one unreadable entry is skipped and counted, never fatal to the rest. */
data class LenientTokens(val tokens: List<WireToken>, val unreadable: Int)

/** `/api/tokens`: the first page in full, on every poll, with the feed's mode ("feed" or "replay") and its newest result's time. */
data class WireSnapshot(val contract: String, val tokens: LenientTokens, val mode: String? = null, val asOfMs: Double? = null, val stream: StreamPosition? = null)

/** `/api/tokens/rest?offset=&limit=`: the rest of the scored set, a page at a time. */
data class WireRestPage(val contract: String, val total: Int, val offset: Int, val tokens: LenientTokens)

/** Turns the feed's answers into the shapes above. Each returns null when the answer as a whole is not the expected shape. */
object Wire {
    fun snapshot(body: String): WireSnapshot? = obj(body)?.let { o ->
        val contract = o.str("contract") ?: return null
        val list = o.opt("tokens") as? JSONArray ?: return null
        val at = (o.opt("stream") as? JSONObject)?.let { st -> st.str("boot")?.let { b -> st.whole("seq")?.let { StreamPosition(b, it) } } }
        WireSnapshot(contract, tokens(list), o.str("mode"), o.num("asOfMs"), at)
    }

    fun restPage(body: String): WireRestPage? = obj(body)?.let { o ->
        val contract = o.str("contract") ?: return null
        val total = o.whole("total") ?: return null
        val offset = o.whole("offset") ?: return null
        val list = o.opt("tokens") as? JSONArray ?: return null
        WireRestPage(contract, total, offset, tokens(list))
    }

    fun tokens(list: JSONArray): LenientTokens {
        val ok = ArrayList<WireToken>(list.length())
        var bad = 0
        for (i in 0 until list.length()) {
            val t = (list.opt(i) as? JSONObject)?.let(::token)
            if (t != null) ok += t else bad++
        }
        return LenientTokens(ok, bad)
    }

    private fun o2num(h: JSONObject, k: String): Double? = (h.opt(k) as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 }

    fun token(o: JSONObject): WireToken? {
        val address = o.str("address") ?: return null
        val coverage = o.num("coverage") ?: return null
        return WireToken(
            address = address,
            coverage = coverage,
            score = o.num("score"),
            noScoreLabel = o.str("noScoreLabel"),
            chain = o.str("chain"),
            launchpad = o.str("launchpad"),
            name = o.str("name"),
            ticker = o.str("ticker"),
            imageUrl = o.str("imageUrl"),
            note = o.str("note"),
            valuationUsd = o.num("valuationUsd"),
            volume24hUsd = o.num("volume24hUsd"),
            change24hPct = o.num("change24hPct"),
            priceSeries = (o.opt("priceSeries") as? JSONArray)?.let { a ->
                (0 until a.length()).map { (a.opt(it) as? Number)?.toDouble() ?: return@let null }
            },
            launchedAtMs = o.num("launchedAtMs"),
            asOfMs = o.num("asOfMs"),
            rank = o.num("rank"),
            priceUsd = o.num("priceUsd"),
            liquidityUsd = o.num("liquidityUsd"),
            quotePair = o.str("quotePair"),
            changeWindowH = o.num("changeWindowH"),
            priceSource = o.str("priceSource"),
            lastTradeMs = o.num("lastTradeMs"),
            quoteSource = o.str("quoteSource"),
            quoteAtMs = o.num("quoteAtMs"),
            capSource = o.str("capSource"),
            capAtMs = o.num("capAtMs"),
            athUsd = o.num("athUsd"),
            athSource = o.str("athSource"),
            athAtMs = o.num("athAtMs"),
            flow = (o.opt("flow") as? JSONObject)?.let(::flow),
            copyOf = (o.opt("copyOf") as? JSONObject)?.let(::copyRef),
            copyProof = o.str("copyProof"),
            possibleCopyOf = (o.opt("possibleCopyOf") as? JSONObject)?.let(::copyRef),
            transferFee = TransferFee.fromWire(o.opt("transferFee") as? JSONObject),
            seen = o.opt("seen") == true,
            seenAtMs = o.num("seenAtMs"),
            hourTrades = (o.opt("hourTrades") as? JSONObject)?.let { h -> o2num(h, "n") },
            figSrc = (o.opt("figSrc") as? JSONObject)?.let { f ->
                listOf("volume", "liquidity", "pair").mapNotNull { k ->
                    val r = f.opt(k) as? JSONObject ?: return@mapNotNull null
                    val src = r.str("source") ?: return@mapNotNull null
                    val at = r.num("atMs") ?: return@mapNotNull null
                    k to (src to at)
                }.toMap()
            } ?: emptyMap(),
        )
    }

    private fun flow(o: JSONObject): WireFlow? = WireFlow(
        buy5m = o.num("buy5m") ?: return null, sell5m = o.num("sell5m") ?: return null,
        buy1h = o.num("buy1h") ?: return null, sell1h = o.num("sell1h") ?: return null,
        n5m = o.num("n5m") ?: return null, n1h = o.num("n1h") ?: return null,
        lastAt = o.num("lastAt"), complete = o.opt("complete") as? Boolean ?: return null, basis = o.str("basis"),
    )

    private fun copyRef(o: JSONObject): WireCopyRef? =
        WireCopyRef(o.str("address") ?: return null, o.str("ticker"), o.str("proof"))

    private fun obj(body: String): JSONObject? = try { JSONObject(body) } catch (e: Exception) { null }
    private fun JSONObject.str(k: String): String? = opt(k) as? String
    private fun JSONObject.num(k: String): Double? = (opt(k) as? Number)?.toDouble()?.takeIf { !it.isNaN() }
    private fun JSONObject.whole(k: String): Int? = (opt(k) as? Number)?.toDouble()?.takeIf { it >= 0 && it == Math.floor(it) && it < Int.MAX_VALUE }?.toInt()
}
