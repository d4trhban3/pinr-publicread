package io.pinr.app.feed

import java.net.URI
import org.json.JSONArray
import org.json.JSONObject

/**
 * The DeepScan dossier for one coin, as the feed server builds it through its allow-list (pinr-live/server/dossier.ts):
 * public facts with their receipts, one word per check, approved plain sentences, the coin's own links, and the social
 * scan. Never scoring detail. Read as the site and the iPhone app read it.
 */
data class Dossier(
    val available: Boolean,
    val facts: List<Fact>,
    val checks: List<Check>,
    val read: List<String>,
    val links: List<Link>,
    val channels: List<Channel>,
    val social: Social?,
    val flagged: Boolean,
    /** the coin's pool events (observed on chain), or null when the feed's answer carried none. */
    val pool: PoolEvents? = null,
    /** The pool facts in the coin's evidence file, for a coin with no pool-events file (Base, BNB); shown in the Pool section (checklist 6). */
    val poolRows: List<PoolRow> = emptyList(),
) {
    /** One pool fact: whether it was read on chain, and its receipt link (null when the file has none). */
    data class PoolRow(val what: String, val value: String?, val unit: String?, val source: String?, val onchain: Boolean, val link: String?)

    /** A figure: its text or a dash, a value to copy (a wallet address), and its receipt (all three parts, or none). */
    data class Fact(
        val id: String, val label: String, val value: String, val copy: String?, val receipt: Receipt?,
        /** The engine has not read this figure yet (the transfer fee): a dash with "not read yet". */
        val notRead: Boolean = false,
        /** Plain sentences under the figure: which fee case applied and why. */
        val lines: List<String> = emptyList(),
        /** A label beside the figure in the warning style: only "High fee" . */
        val badge: String? = null,
        /** Links under the figure after a lead-in: the launches an observed standard was seen on, the dev group's wallets. */
        val moreLinks: MoreLinks? = null,
    )
    data class MoreLinks(val lead: String, val links: List<Link>)
    data class Receipt(val source: String, val readAtMs: Long, val link: String)

    enum class Band(val word: String) { Strong("Strong"), Fair("Fair"), Weak("Weak"), Clear("Clear"), NoData("No data"), NotRead("Not read") }
    data class Check(val name: String, val band: Band, val reason: String?)

    data class Channel(val id: String, val label: String, val status: Status, val url: String?, val postBy: String?) {
        enum class Status { Listed, NotListed, Unknown }
    }

    data class Link(val label: String, val url: String)

    data class Social(val claims: List<Claim>, val flags: List<String>, val gaps: List<String>, val totals: Map<String, Int>, val scannedAtMs: Long?) {
        data class Claim(val line: String, val result: String, val handle: String?, val postUrl: String?, val removed: Boolean)
    }

    companion object {
        /** The public sources a receipt may name (contract v1.1, `SOURCES` in dossier.ts). Any other name is not a source. */
        val SOURCES = setOf(
            "Pump.fun", "Clanker", "Bankr", "Flap.sh", "four.meme", "Raydium LaunchLab", "DexScreener",
            "CoinGecko", "GeckoTerminal", "Solana chain", "Base chain", "BNB chain", "Jupiter", "Stonk.fun",
        )

        /** What each social result means, in the site's words. */
        val RESULT_WORDS = mapOf(
            "MATCHES" to "Matches the dossier", "DIVERGES" to "Differs from the dossier",
            "UNVERIFIABLE" to "Cannot be checked against the dossier", "NOT CHECKABLE" to "An opinion or promise, not checkable",
        )

        /** "4 claims read: 1 match, 2 differ, 1 cannot be checked, 0 not checkable." (the site's sentence) */
        fun totalsSentence(t: Map<String, Int>): String {
            val m = t["MATCHES"] ?: 0; val d = t["DIVERGES"] ?: 0; val u = t["UNVERIFIABLE"] ?: 0; val n = t["NOT CHECKABLE"] ?: 0
            val total = m + d + u + n
            if (total <= 0) return "No claims were recorded."
            return "$total claim${if (total == 1) "" else "s"} read: $m match, $d differ, $u cannot be checked, $n not checkable."
        }

        /** An http or https address only; anything else is no link. */
        fun webUrl(s: String?): String? = try {
            val u = URI(s ?: return null)
            if ((u.scheme?.lowercase() == "https" || u.scheme?.lowercase() == "http") && !u.host.isNullOrEmpty()) s else null
        } catch (e: Exception) {
            null
        }

        fun parse(body: String): Dossier? {
            val o = try { JSONObject(body) } catch (e: Exception) { return null }
            fun JSONObject.str(k: String): String? = opt(k) as? String
            fun list(k: String): List<JSONObject> = (o.opt(k) as? JSONArray)?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? JSONObject } } ?: emptyList()

            val facts = list("facts").mapIndexedNotNull { i, f ->
                val label = f.str("label")?.jsTrim()?.takeIf { it.isNotEmpty() } ?: return@mapIndexedNotNull null
                val src = f.str("source")
                val ms = (f.opt("readAtMs") as? Number)?.toDouble()
                val link = webUrl(f.str("link"))
                val receipt = if (f.opt("noSource") != true && src != null && src in SOURCES && ms != null && ms.isFinite() && ms > 0 && link != null) {
                    Receipt(src, ms.toLong(), link)
                } else null
                // A figure without its whole receipt is a dash, never a number (contract v1.1).
                val value = if (receipt == null) Format.DASH else f.str("value")?.takeIf { it.isNotEmpty() } ?: Format.DASH
                val lines = (f.opt("lines") as? JSONArray)?.let { a -> (0 until a.length()).mapNotNull { (a.opt(it) as? String)?.takeIf { s -> s.isNotEmpty() }?.take(300) }.take(8) } ?: emptyList()
                val more = (f.opt("moreLinks") as? JSONObject)?.let { m ->
                    val lead = m.str("lead")?.takeIf { it.isNotEmpty() } ?: return@let null
                    val ls = (m.opt("links") as? JSONArray)?.let { a ->
                        (0 until a.length()).mapNotNull { j ->
                            val l = a.opt(j) as? JSONObject ?: return@mapNotNull null
                            Link(l.str("label")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null, webUrl(l.str("url")) ?: return@mapNotNull null)
                        }.take(10)
                    } ?: emptyList()
                    if (ls.isEmpty()) null else MoreLinks(lead.take(40), ls)
                }
                // The older server sent an observed standard's launches as `launchLinks`; the same lines, "launch 1, launch 2".
                val legacy = if (more == null) (f.opt("launchLinks") as? JSONArray)?.let { a ->
                    val ls = (0 until a.length()).mapNotNull { j -> webUrl(a.opt(j) as? String) }.take(10).mapIndexed { j, u -> Link("launch ${j + 1}", u) }
                    if (ls.isEmpty()) null else MoreLinks("Standard observed on", ls)
                } else null
                Fact(
                    f.str("id") ?: "fact-$i", label.take(60), value, if (receipt == null) null else f.str("copy"), receipt,
                    notRead = f.opt("notRead") == true, lines = lines, badge = f.str("badge")?.takeIf { it == "High fee" },
                    moreLinks = (more ?: legacy)?.takeIf { receipt != null },
                )
            }
            val checks = list("checks").mapNotNull { c ->
                val n = c.str("name")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                val b = Band.entries.firstOrNull { it.word == c.str("band") } ?: return@mapNotNull null
                Check(n, b, c.str("reason"))
            }
            val read = (o.opt("read") as? JSONArray)?.let { a -> (0 until a.length()).mapNotNull { (a.opt(it) as? String)?.takeIf { s -> s.isNotEmpty() } } } ?: emptyList()
            val links = list("links").mapNotNull { l -> Link(l.str("label") ?: return@mapNotNull null, webUrl(l.str("url")) ?: return@mapNotNull null) }
            val channels = list("channels").mapNotNull { c ->
                val id = c.str("id") ?: return@mapNotNull null
                val label = c.str("label") ?: return@mapNotNull null
                val st = when (c.str("status")) {
                    "listed" -> Channel.Status.Listed
                    "not_listed" -> Channel.Status.NotListed
                    "unknown" -> Channel.Status.Unknown
                    else -> return@mapNotNull null
                }
                val url = if (st == Channel.Status.Listed) webUrl(c.str("url")) else null
                Channel(id, label, if (st == Channel.Status.Listed && url == null) Channel.Status.Unknown else st, url, c.str("post"))
            }
            val social = (o.opt("social") as? JSONObject)?.let { s ->
                val claims = (s.opt("claims") as? JSONArray)?.let { a ->
                    (0 until a.length()).mapNotNull { i ->
                        val c = a.opt(i) as? JSONObject ?: return@mapNotNull null
                        val line = c.str("line")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                        val r = c.str("result")?.takeIf { it in RESULT_WORDS } ?: return@mapNotNull null
                        val removed = c.opt("removed") == true
                        Social.Claim(line, r, c.str("handle"), if (removed) null else webUrl(c.str("postUrl")), removed)
                    }
                } ?: emptyList()
                val flags = (s.opt("flags") as? JSONArray)?.let { a -> (0 until a.length()).mapNotNull { (a.opt(it) as? JSONObject)?.str("text") } } ?: emptyList()
                val gaps = (s.opt("gaps") as? JSONArray)?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String }.take(5) } ?: emptyList()
                val totals = (s.opt("totals") as? JSONObject)?.let { t -> t.keys().asSequence().mapNotNull { k -> (t.opt(k) as? Number)?.toInt()?.let { k to it } }.toMap() } ?: emptyMap()
                Social(claims, flags, gaps, totals, (s.opt("scannedAtMs") as? Number)?.toLong()?.takeIf { it > 0 })
            }
            fun poolRows(a: JSONArray?): List<PoolRow> = a?.let { arr ->
                (0 until arr.length()).mapNotNull { i ->
                    val r = arr.opt(i) as? JSONObject ?: return@mapNotNull null
                    val what = r.str("what")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    val v = when (val x = r.opt("value")) { is String -> x; is Number -> PoolWords.amount(x.toDouble()); is Boolean -> if (x) "yes" else "no"; else -> null }
                    PoolRow(what, v, r.str("unit"), r.str("source"), r.opt("onchain") == true, webUrl(r.str("link")))
                }
            } ?: emptyList()
            val held = o.str("held") == "flagged"
            return Dossier(o.opt("available") == true, facts, if (held) emptyList() else checks, read, links, channels, social, held, pool = PoolEvents.parse(o.optJSONObject("pool")), poolRows = poolRows(o.opt("poolRows") as? JSONArray))
        }
    }
}
