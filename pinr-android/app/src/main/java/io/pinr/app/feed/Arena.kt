package io.pinr.app.feed

import org.json.JSONArray
import org.json.JSONObject

/**
 * the PvP Arena (north-east room). Each contested coin's versions side by side, ranked strictly by the last 30 minutes' volume, then X
 * presence, then the chart (the server ranks them: `/api/arena`, the engine's pvp-1 battle groups). Observed figures only: a dash is a figure no source gave,
 * never a zero; "earliest launch" is what the launch times show, not a judgement. A "+" after a figure means only the newest 500 trades are kept.
 */
data class ArenaMember(
    val address: String, val name: String?, val ticker: String?, val chain: String?, val launchpad: String?, val imageUrl: String?,
    val launchedAtMs: Long?, val recentTrades: Int, val recentUsd: Double,
    /** True when the figures are a floor: only the newest 500 trades are kept. */
    val recentAtLeast: Boolean,
    val volume24h: Double?, val change24h: Double?, val valuation: Double?, val xPosts: Int?, val hasX: Boolean, val earliest: Boolean,
    /** False when the 30-minute figures were not read yet (the site's `recentKnown`); a missing field counts as read. */
    val recentKnown: Boolean = true,
) {
    val id: String get() = address.lowercase()

    /** "$20.9K+ · 500+ tx" when the count is a floor, else "$1.2K · 327 tx". */
    val recentText: String get() { if (!recentKnown) return Format.DASH; val plus = if (recentAtLeast) "+" else ""; return "${Format.money(recentUsd)}$plus · $recentTrades$plus tx" }
    val xText: String get() = xPosts?.let { "$it post${if (it == 1) "" else "s"}" } ?: if (hasX) "linked" else Format.DASH
}

data class ArenaGroup(val id: String, val title: String, val ticker: String, val members: List<ArenaMember>)

object ArenaWire {
    fun parse(body: String): List<ArenaGroup>? {
        val o = try { JSONObject(body) } catch (e: Exception) { return null }
        val list = o.opt("groups") as? JSONArray ?: return null
        fun JSONObject.num(k: String): Double? = (opt(k) as? Number)?.toDouble()?.takeIf { it.isFinite() }
        fun JSONObject.str(k: String): String? = opt(k) as? String
        return (0 until list.length()).mapNotNull { gi ->
            val g = list.opt(gi) as? JSONObject ?: return@mapNotNull null
            val id = g.str("id") ?: return@mapNotNull null
            val ms = g.opt("members") as? JSONArray ?: return@mapNotNull null
            val members = (0 until ms.length()).mapNotNull { mi ->
                val m = ms.opt(mi) as? JSONObject ?: return@mapNotNull null
                val a = m.str("address")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                ArenaMember(
                    a, m.str("name")?.let(Invisible::strip)?.ifEmpty { null }, m.str("ticker")?.let(Invisible::strip)?.ifEmpty { null }, m.str("chain"), m.str("launchpad"), EvidenceHub.httpsUrl(m.str("imageUrl")),
                    m.num("launchedAtMs")?.toLong(), (m.num("recentTrades") ?: 0.0).toInt(), m.num("recentUsd") ?: 0.0, m.opt("recentAtLeast") == true,
                    m.num("volume24hUsd"), m.num("change24hPct"), m.num("valuationUsd"), m.num("xPosts")?.toInt(), m.opt("hasX") == true, m.opt("earliest") == true, m.opt("recentKnown") != false,
                )
            }
            if (members.isEmpty()) null else ArenaGroup(id, g.str("title")?.let(Invisible::strip) ?: Format.DASH, g.str("ticker")?.let(Invisible::strip) ?: "", members)
        }
    }
}
