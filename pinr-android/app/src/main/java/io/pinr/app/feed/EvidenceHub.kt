package io.pinr.app.feed

import org.json.JSONArray
import org.json.JSONObject

/**
 * The coin's evidence file as the feed serves it (`/api/evidence?address=`, contract "evidence/1", already cleaned by the server): the rows,
 * the gate's result at launch and PINRai's reading. The words follow the site's `world/orbit.ts` (`describe`,
 * `gateView`, `pinraiView`): a doctor's words (231), what was observed, never a verdict; missing stays missing. Links are https only.
 */
data class EvidenceHub(val rows: List<Row> = emptyList(), val gate: Gate? = null, val pinrai: Pinrai? = null, val fundingNote: String? = null) {
    /** A plain value or a small record of plain values: a String, Double, Boolean or Map. */
    data class Row(
        val fromId: String, val toId: String, val toKind: String, val what: String, val value: Any?, val unit: String?,
        val atMs: Long?, val readMs: Long?, val source: String?, val link: String?, val onchain: Boolean,
    )
    data class GateCoin(val coin: String, val launchedAtMs: Long?, val link: String?)
    sealed class GateItem {
        data class EarlierLookalike(val words: String, val coin: String?, val launchedAtMs: Long?, val link: String?, val creator: String?, val creatorLink: String?) : GateItem()
        data class SameCreatorRelaunch(val words: String, val coins: List<GateCoin>) : GateItem()
        data class Plain(val words: String) : GateItem()
    }
    data class Gate(
        val status: String, val words: List<String>, val items: List<GateItem>, val creatorLink: String?, val otherCoins: List<GateCoin>,
        val launchedAtMs: Long?, val source: String?, val readMs: Long?,
    )
    data class Receipt(val source: String?, val value: Any?, val link: String?, val asOfMs: Long?, val onchain: Boolean)
    data class PinraiItem(val words: String, val reviewed: Boolean, val receipts: List<Receipt>)
    data class Pinrai(val status: String, val readMs: Long?, val model: String?, val items: List<PinraiItem>, val dropped: Int?, val pending: Int?)

    companion object {
        /** The feed's answer: null when the body is not JSON or there is no evidence (`{"evidence": null}`). */
        fun parse(body: String): EvidenceHub? {
            val e = (try { JSONObject(body) } catch (x: Exception) { return null }).opt("evidence") as? JSONObject ?: return null
            fun JSONObject.s(k: String): String? = (opt(k) as? String)
            fun JSONObject.ms(k: String): Long? = (opt(k) as? Number)?.toDouble()?.takeIf { it.isFinite() && it > 0 }?.toLong()
            fun JSONObject.https(k: String): String? = httpsUrl(s(k))
            fun JSONArray?.objs(): List<JSONObject> = this?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? JSONObject } } ?: emptyList()
            fun plain(v: Any?): Any? = when (v) {
                is String -> v
                is Boolean -> v
                is Number -> v.toDouble()
                is JSONObject -> v.keys().asSequence().associateWith { plain(v.opt(it)) }
                else -> null
            }
            fun coin(c: JSONObject): GateCoin? = c.s("coin")?.let { GateCoin(it, c.ms("launchedAtMs"), c.https("link")) }

            val rows = (e.opt("rows") as? JSONArray).objs().mapNotNull { r ->
                val what = r.s("what") ?: return@mapNotNull null
                val f = r.opt("from") as? JSONObject ?: return@mapNotNull null
                val t = r.opt("to") as? JSONObject ?: return@mapNotNull null
                Row(f.s("id") ?: "", t.s("id") ?: "", t.s("kind") ?: "", what, plain(r.opt("value")), r.s("unit"), r.ms("atMs"), r.ms("readMs"),
                    r.s("source"), r.https("link"), r.opt("onchain") == true)
            }
            val gate = (e.opt("gate") as? JSONObject)?.let { g ->
                val status = g.s("status") ?: return@let null
                val items = (g.opt("items") as? JSONArray).objs().mapNotNull { it ->
                    val words = it.s("words") ?: return@mapNotNull null
                    when (it.s("kind")) {
                        "earlier_lookalike" -> GateItem.EarlierLookalike(words, it.s("coin"), it.ms("launchedAtMs"), it.https("link"), it.s("creator"), it.https("creatorLink"))
                        "same_creator_relaunch" -> GateItem.SameCreatorRelaunch(words, (it.opt("coins") as? JSONArray).objs().mapNotNull(::coin))
                        else -> GateItem.Plain(words)
                    }
                }
                val creator = g.opt("creator") as? JSONObject
                Gate(status, (g.opt("words") as? JSONArray)?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String } } ?: emptyList(), items,
                    creator?.https("link"), (creator?.opt("otherCoins") as? JSONArray).objs().mapNotNull(::coin), g.ms("launchedAtMs"), g.s("source"), g.ms("readMs"))
            }
            val pinrai = (e.opt("pinrai") as? JSONObject)?.let { p ->
                val status = p.s("status") ?: return@let null
                val items = (p.opt("items") as? JSONArray).objs().mapNotNull { it ->
                    val words = it.s("words") ?: return@mapNotNull null
                    PinraiItem(words, it.opt("reviewed") == true, (it.opt("receipts") as? JSONArray).objs().map { r ->
                        Receipt(r.s("source"), plain(r.opt("value")), r.https("link"), r.ms("asOfMs"), r.opt("onchain") == true)
                    })
                }
                Pinrai(status, p.ms("readMs"), p.s("model"), items, (p.opt("dropped") as? Number)?.toInt(), (p.opt("pending") as? Number)?.toInt())
            }
            return EvidenceHub(rows, gate, pinrai, e.s("fundingNote"))
        }

        /** An https link only (the server already cleans; the app checks again). */
        fun httpsUrl(s: String?): String? = try {
            val u = java.net.URI(s ?: return null)
            if (u.scheme?.lowercase() == "https" && !u.host.isNullOrEmpty() && u.userInfo == null) s else null
        } catch (e: Exception) { null }
    }
}

/** The site's words (orbit.ts) over the hub. */
object EvidenceWords {
    /** The gate's own copy lines keep 4…4 (orbit.ts: `short`); evidence rows use the site's `shortAddress` (6…4 above 14 characters). */
    fun gateShort(a: String): String = if (a.length > 8) "${a.take(4)}…${a.takeLast(4)}" else a
    fun short(a: String): String = if (a.length > 14) "${a.take(6)}…${a.takeLast(4)}" else a

    private fun money(n: Double): String = when {
        n >= 1e9 -> "$" + String.format(java.util.Locale.US, "%.1fB", n / 1e9)
        n >= 1e6 -> "$" + String.format(java.util.Locale.US, "%.1fM", n / 1e6)
        n >= 1e3 -> "$" + String.format(java.util.Locale.US, "%.1fK", n / 1e3)
        else -> "$" + Math.round(n)
    }
    private fun amount(n: Double): String = when {
        n >= 1e9 -> String.format(java.util.Locale.US, "%.2fB", n / 1e9)
        n >= 1e6 -> String.format(java.util.Locale.US, "%.2fM", n / 1e6)
        n >= 1e3 -> String.format(java.util.Locale.US, "%.1fK", n / 1e3)
        n > 0 && n < 1 -> PoolWords.amount(n) // three significant digits, written out (site's amount())
        else -> (Math.round(n * 100) / 100.0).let { if (it == Math.floor(it)) it.toLong().toString() else it.toString() }
    }

    enum class GroupId { Creator, Funders, Holders, Pool, Socials, Links }
    val groups = listOf(
        Triple(GroupId.Creator, "Creator", "Who created and launched this coin: not checked yet."),
        Triple(GroupId.Funders, "Funders", "Where the creator's money came from: not checked yet."),
        Triple(GroupId.Holders, "Holders", "Who holds this coin: not checked yet."),
        Triple(GroupId.Pool, "Pool", "Where it trades: not checked yet."),
        Triple(GroupId.Socials, "Socials", "The accounts the coin lists: not checked yet."),
        Triple(GroupId.Links, "Links", "The coin's own documents: not checked yet."),
    )
    private val LINKED = listOf("bought in the creation block", "funded by the creator before launch", "received tokens from the creator", "linked to the creator")

    private fun num(v: Any?): Double? = (v as? Double)?.takeIf { it.isFinite() }
    @Suppress("UNCHECKED_CAST")
    private fun rec(v: Any?): Map<String, Any?> = (v as? Map<String, Any?>) ?: emptyMap()
    private fun whole(n: Double): String = n.toLong().toString()

    /** A number the way the site prints it: no trailing ".0" (JavaScript's String(n)). */
    fun plain(n: Double): String =
        if (n == Math.rint(n) && Math.abs(n) < 1e15) n.toLong().toString() else java.math.BigDecimal(n).setScale(8, java.math.RoundingMode.HALF_EVEN).stripTrailingZeros().toPlainString()

    /** A share (0 to 1) as a percent, never rounded up to 100%; null when not a share (orbit.ts `share`). */
    fun share(s: Double?): String? {
        if (s == null || s < 0 || s > 1) return null
        val p = s * 100
        return plain(if (p >= 1) Math.floor(p * 100) / 100 else java.math.BigDecimal(p).round(java.math.MathContext(2)).toDouble()) + "%"
    }

    fun duration(sec: Double): String = when {
        sec < 120 -> "${Math.round(sec)} s"
        sec < 7200 -> "${Math.round(sec / 60)} min"
        else -> "${Math.round(sec / 3600)} h"
    }

    private fun grouped(n: Double): String = java.text.NumberFormat.getNumberInstance(java.util.Locale.US).apply { maximumFractionDigits = 3 }.format(n)

    /** Which group a row belongs to and how it reads (orbit.ts `describe`). An unknown row still shows, under Links, in the source's words. */
    fun describe(r: EvidenceHub.Row): Pair<GroupId, String> {
        val to = short(r.toId); val from = short(r.fromId); val w = r.what
        return when (w) {
            "created by" -> GroupId.Creator to "Created by $to"
            "launched by" -> GroupId.Creator to "Launched by $to"
            "fee receiver at launch" -> GroupId.Creator to "Launch fees went to $to"
            "coins launched (the launchpad's list)" -> {
                val n = num(r.value)?.let(::whole) ?: (r.value as? String)
                GroupId.Creator to (if (n == null) "$from has launched other coins (the launchpad's list)" else "$from has launched $n coins (the launchpad's list)")
            }
            "copies of this coin launched" -> GroupId.Creator to "${num(r.value)?.let(::whole) ?: "Some"} copies of this coin were launched by the same creator"
            "funded" -> GroupId.Funders to (num(r.value)?.let { "$from sent ${amount(it)} ${r.unit ?: "SOL"} to $to" } ?: "$from funded $to")
            "holds" -> {
                val v = rec(r.value)
                val marks = listOf("dev", "sniper", "bundler").filter { v[it] == true }
                val tail = if (marks.isEmpty()) "" else " · the source marks it: ${marks.joinToString(", ")}"
                // Base and BNB rows give a share of the supply, and a note on who the wallet is (a burn address, a launchpad's curve)
                val held = num(v["amount"])?.let { "${amount(it)} of it" } ?: share(num(v["share"]))?.let { "$it of the supply" } ?: "this coin"
                val note = (v["note"] as? String)?.let { " · $it" } ?: ""
                GroupId.Holders to "$from holds $held$tail$note"
            }
            "holds (dev team)" -> GroupId.Holders to (share(num(rec(r.value)["share"]))?.let { "The dev team's wallets hold $it of it" } ?: "The dev team's wallets hold this coin")
            "holders counted" -> GroupId.Holders to (num(r.value)?.let { "${grouped(it)} ${if (it == 1.0) "wallet holds" else "wallets hold"} this coin" } ?: "Holders counted")
            "dev moves" -> {
                val v = rec(r.value)
                val parts = listOfNotNull(
                    num(v["members"])?.let { "${plain(it)} ${if (it == 1.0) "wallet" else "wallets"}" },
                    num(v["acquired"])?.let { "${amount(it)} tokens acquired" },
                    num(v["half_out_after_s"])?.let { "half sent on after ${duration(it)}" },
                )
                GroupId.Creator to "The creator's tokens moved${if (parts.isEmpty()) "" else " · " + parts.joinToString(", ")}"
            }
            "bought at launch" -> {
                val v = rec(r.value)
                val coin = (r.unit ?: "").split("/").first().trim().ifEmpty { "ETH" }
                val parts = listOfNotNull(num(v["tokens"])?.let { "${amount(it)} tokens" }, num(v["eth"])?.let { "for ${plain(it)} $coin" })
                GroupId.Creator to "$from bought at launch${if (parts.isEmpty()) "" else " · " + parts.joinToString(" ")}"
            }
            "is a contract (a launch service, not a person)" -> GroupId.Creator to "$from is a contract (a launch service, not a person)"
            "owned by (contract owner)" -> {
                val v = rec(r.value)
                val parts = listOfNotNull(v["template"] as? String, (v["can"] as? String)?.let { "the owner can: $it" }).filter { it.isNotEmpty() }
                GroupId.Creator to "Contract owner: $to${if (parts.isEmpty()) "" else " · " + parts.joinToString(" · ")}"
            }
            "creator rewards paid to" -> GroupId.Creator to "Creator rewards go to $to"
            "tax paid to" -> GroupId.Creator to "Tax goes to $to"
            "launched on" -> GroupId.Pool to "Launched on ${r.toId}"
            "trades in pool (Uniswap v4)" -> GroupId.Pool to "Trades in the Uniswap v4 pool $to"
            "liquidity locked" -> GroupId.Pool to "Liquidity locked${share(num(r.value))?.let { ": $it of the pool" } ?: ""} · ${r.toId}"
            "liquidity held by Zora's hook" -> {
                val v = rec(r.value)
                // what the owners can do with it is always shown
                val can = (v["owners_can"] as? String)?.let { "; its owners can $it" } ?: ""
                GroupId.Pool to "Zora's hook holds ${share(num(v["locked_share"])) ?: "some"} of the pool's liquidity$can"
            }
            "trading tax" -> {
                val v = rec(r.value)
                fun pct(n: Double?) = n?.let { "${plain(it)}%" } ?: "–"
                GroupId.Pool to "Trading tax: buy ${pct(num(v["buy_pct"]))}, sell ${pct(num(v["sell_pct"]))}"
            }
            "trades in pool" -> GroupId.Pool to "Trades in the pool $to${share(num(rec(r.value)["lp_burned_share"]))?.let { " · $it of its LP tokens burned" } ?: ""}"
            "market pair" -> {
                val v = rec(r.value)
                val parts = listOfNotNull((v["dex"] as? String)?.let { "on $it" }, num(v["market_cap"])?.let { "market cap ${money(it)}" }, num(v["liquidity_usd"])?.let { "liquidity ${money(it)}" })
                GroupId.Pool to "Market pair $to${if (parts.isEmpty()) "" else " · " + parts.joinToString(", ")}"
            }
            "trades on" -> GroupId.Pool to "Trades on ${r.toId}"
            "launched" -> GroupId.Pool to "Launched"
            "lists its own link" -> {
                val name = when (r.toKind) { "x" -> "X account"; "telegram" -> "Telegram"; "site" -> "website"; else -> "link" }
                GroupId.Socials to "Lists its own $name"
            }
            "X check" -> GroupId.Socials to "X check ran"
            "creator's Zora profile" -> GroupId.Socials to "Creator's Zora profile @${r.toId}"
            "creator's linked account" -> {
                val v = rec(r.value)
                val who = (v["username"] as? String)?.let { "@$it" } ?: r.toId
                GroupId.Socials to "Creator's linked account $who${num(v["followers"])?.let { " · ${grouped(it)} followers" } ?: ""}"
            }
            "metadata document" -> GroupId.Links to "Metadata document"
            "copy of the template" -> GroupId.Links to ((r.value as? String)?.let { "Contract is a copy of $it" } ?: "Contract is a copy of a template")
            "GoPlus security check (a lead)" -> GroupId.Links to "GoPlus check (a lead): ${(r.value as? String) ?: "read"}"
            else -> if (w.startsWith("dev team: ")) GroupId.Creator to "Dev team wallet, ${w.substring(10)}: $to" else if (w in LINKED) GroupId.Creator to "Linked wallet $to · $w" else GroupId.Links to w
        }
    }

    data class Fact(val text: String, val onchain: Boolean, val readText: String?, val happenedText: String?, val source: String?, val link: String?)
    data class Group(val id: GroupId, val label: String, val empty: String, val facts: List<Fact>)

    /** The six groups, always, in ring order; a group with no facts says so. */
    fun orbitGroups(hub: EvidenceHub?, nowMs: Long): List<Group> {
        val by = HashMap<GroupId, MutableList<Fact>>()
        for (r in hub?.rows.orEmpty()) {
            val (g, text) = describe(r)
            by.getOrPut(g) { mutableListOf() }.add(Fact(text, r.onchain, Format.scoredAgo(r.readMs, nowMs)?.let { "read $it" }, Format.scoredAgo(r.atMs, nowMs)?.let { "happened $it" }, r.source, r.link))
        }
        // The engine did not trace the funding: an empty Funders group says why, not "not checked yet".
        val note = hub?.fundingNote
        return groups.map { (id, label, empty) -> Group(id, label, if (id == GroupId.Funders && by[id].isNullOrEmpty() && note != null) note else empty, by[id].orEmpty()) }
    }

    // The gate
    data class GateLine(val words: String, val whenText: String?, val links: List<Pair<String, String>>)
    data class OtherCoin(val label: String, val whenText: String?, val link: String?)
    data class GateView(val headline: String, val lines: List<GateLine>, val others: List<OtherCoin>, val creatorLink: String?, val readText: String?)

    /** "3 min earlier", "2 h earlier"; null when either time is missing or the other coin is not earlier. */
    fun earlierBy(thisMs: Long?, thatMs: Long?): String? {
        if (thisMs == null || thatMs == null || thatMs >= thisMs) return null
        val min = maxOf(1L, Math.round((thisMs - thatMs) / 60_000.0))
        if (min < 60) return "$min min earlier"
        val h = Math.round(min / 60.0)
        return if (h < 48) "$h h earlier" else "${Math.round(h / 24.0)} days earlier"
    }

    fun gateView(g: EvidenceHub.Gate?, nowMs: Long): GateView? {
        if (g == null) return null
        val lines = mutableListOf<GateLine>()
        for (it in g.items) when (it) {
            is EvidenceHub.GateItem.EarlierLookalike -> {
                val links = listOfNotNull(
                    it.link?.let { l -> (it.coin?.let { c -> "see the earlier coin ${gateShort(c)}" } ?: "see the earlier coin") to l },
                    it.creatorLink?.let { l -> (it.creator?.let { c -> "its creator ${gateShort(c)}" } ?: "its creator") to l },
                )
                lines += GateLine(it.words, earlierBy(g.launchedAtMs, it.launchedAtMs)?.let { e -> "launched $e" }, links)
            }
            is EvidenceHub.GateItem.SameCreatorRelaunch -> lines += GateLine(it.words, null, it.coins.mapNotNull { c -> c.link?.let { l -> "see ${gateShort(c.coin)}" to l } })
            is EvidenceHub.GateItem.Plain -> lines += GateLine(it.words, null, emptyList())
        }
        val headline = when {
            g.status == "not read yet" -> "Not checked yet."
            lines.isNotEmpty() -> "Observed at launch:"
            else -> g.words.firstOrNull() ?: "Nothing matching was found at launch."
        }
        // A line the items did not carry (the file's own words) still shows once.
        if (g.status != "not read yet" && lines.isNotEmpty()) {
            val seen = lines.map { it.words }.toSet()
            g.words.filter { it !in seen }.forEach { lines += GateLine(it, null, emptyList()) }
        }
        val others = g.otherCoins.map { c -> OtherCoin(gateShort(c.coin), Format.scoredAgo(c.launchedAtMs, nowMs)?.let { "launched $it" }, c.link) }
        val read = Format.scoredAgo(g.readMs, nowMs)
        return GateView(headline, lines, others, g.creatorLink, read?.let { "read $it${g.source?.let { s -> " · $s" } ?: ""}" } ?: g.source?.let { "source: $it" })
    }

    // PINRai's reading
    data class ReceiptLine(val text: String, val onchain: Boolean, val whenText: String?, val link: String?)
    data class PinraiLine(val words: String, val reviewed: Boolean, val receipts: List<ReceiptLine>)
    data class PinraiView(val headline: String, val lines: List<PinraiLine>, val counts: String?, val readText: String?)

    private fun words(v: Any?): String = when (v) {
        null -> ""
        is Boolean -> if (v) "yes" else "no"
        is Double -> if (v == Math.floor(v) && Math.abs(v) < 1e15) v.toLong().toString() else v.toString()
        is String -> v
        else -> ""
    }

    fun pinraiView(p: EvidenceHub.Pinrai?, nowMs: Long): PinraiView? {
        if (p == null) return null
        val lines = p.items.map { it ->
            PinraiLine(it.words, it.reviewed, it.receipts.map { r ->
                val text = listOfNotNull(r.source, words(r.value)).filter { s -> s.isNotEmpty() }.joinToString(": ")
                ReceiptLine(text.ifEmpty { "see the source" }, r.onchain, Format.scoredAgo(r.asOfMs, nowMs), r.link)
            })
        }
        val headline = when {
            p.status == "off" -> "PINRai is switched off."
            p.status == "not read yet" -> "Not read yet."
            lines.isNotEmpty() -> "Observed in the evidence:"
            else -> "Read, and no sign of the developer's intent was found in the evidence."
        }
        // The model name and the "set aside / waiting" counts stay on /control; an older server that still sends them is read and ignored.
        val ago = Format.scoredAgo(p.readMs, nowMs)
        return PinraiView(headline, if (p.status == "read") lines else emptyList(), null, ago?.let { "read $it" })
    }
}
