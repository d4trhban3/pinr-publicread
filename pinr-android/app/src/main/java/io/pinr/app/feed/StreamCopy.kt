package io.pinr.app.feed

import org.json.JSONArray
import org.json.JSONObject

/** Where a list stands in the feed's change stream (`stream: {boot, seq}` on `/api/tokens`, a design decision). */
data class StreamPosition(val boot: String, val seq: Int)

/**
 * The app's copy of the first page, kept current by `/api/stream` (the same rules as `ListCopy` in
 * pinr-live/src/world/livefeed.ts and `StreamCopy` in the iPhone app): the page is read once, then each `changes` message
 * is applied to it. A message from another boot, or one that skips a number (something was missed), asks for a fresh read.
 * Rows are kept as the feed sent them, so a message that carries only the changed fields is merged field by field; a field
 * the feed sends as null is taken away.
 */
class StreamCopy {
    var position: StreamPosition? = null
        private set
    /** The first page's coins, lower-cased addresses, in the order the feed sent them (new coins come last). */
    val order = ArrayList<String>()
    private val rows = HashMap<String, JSONObject>()

    sealed interface Outcome {
        /** Nothing to do: a message this copy already includes, or one that could not be read. */
        data object Ignored : Outcome
        /** The copy cannot follow (another boot, a skipped number): read the lists again. */
        data object Reset : Outcome
        /** `changed` first-page coins changed, `gone` left it; `rest` and `restGone` are the scored set's rows and departures. */
        data class Applied(val changed: List<String>, val gone: List<String>, val rest: List<JSONObject>, val restGone: List<String>, val ticks: List<LiveTick> = emptyList()) : Outcome
    }

    /** Takes the first page as the feed sent it (the `tokens` array) and where the list stands. */
    fun load(list: JSONArray, at: StreamPosition?) {
        order.clear()
        rows.clear()
        for (i in 0 until list.length()) {
            val row = list.optJSONObject(i) ?: continue
            val key = (row.opt("address") as? String)?.lowercase() ?: continue
            if (key !in rows) order += key
            rows[key] = row
        }
        position = at
    }

    /** Forgets the position, so nothing is applied until the lists are read again. */
    fun clear() { position = null }

    fun apply(data: String): Outcome {
        val o = try { JSONObject(data) } catch (e: Exception) { return Outcome.Ignored }
        val boot = o.opt("boot") as? String ?: return Outcome.Ignored
        val seq = (o.opt("seq") as? Number)?.toInt() ?: return Outcome.Ignored
        val at = position
        if (at == null || boot != at.boot) return Outcome.Reset
        if (seq <= at.seq) return Outcome.Ignored
        if (seq > at.seq + 1) return Outcome.Reset
        val changed = LinkedHashSet<String>()
        val priced = ArrayList<Pair<String, Double>>()
        fun noteIfPriced(key: String, row: JSONObject) { (row.opt("priceUsd") as? Number)?.toDouble()?.takeIf { it > 0 && it.isFinite() }?.let { priced += key to it } }
        for (row in objects(o, "seen")) {
            val key = (row.opt("address") as? String)?.lowercase() ?: continue
            if (key !in rows) order += key
            rows[key] = row
            changed += key
            noteIfPriced(key, row)
        }
        for (name in listOf("score", "graduation", "tick")) {
            for (part in objects(o, name)) {
                val key = (part.opt("address") as? String)?.lowercase() ?: continue
                val row = rows[key] ?: continue
                for (field in part.keys()) if (part.isNull(field)) row.remove(field) else row.put(field, part.get(field))
                changed += key
                noteIfPriced(key, part)
            }
        }
        val gone = strings(o, "gone")
        if (gone.isNotEmpty()) {
            val goneSet = gone.toHashSet()
            for (k in gone) rows.remove(k)
            order.removeAll { it in goneSet }
        }
        position = StreamPosition(boot, seq)
        // The prices this message carries for coins on the first page (a chart folds those, never a price it merely holds).
        val now = System.currentTimeMillis()
        val trades = objects(o, "trades").mapNotNull { t ->
            val address = (t.opt("address") as? String)?.lowercase() ?: return@mapNotNull null
            val ms = (t.opt("atMs") as? Number)?.toDouble() ?: return@mapNotNull null
            val price = (t.opt("priceUsd") as? Number)?.toDouble() ?: return@mapNotNull null
            val usd = (t.opt("usd") as? Number)?.toDouble() ?: return@mapNotNull null
            if (!(price > 0) || !price.isFinite() || !ms.isFinite()) null else LiveTick(address, ms.toLong(), price, usd, (t.opt("side") as? String)?.lowercase()?.let { side -> if (side == "buy") true else if (side == "sell") false else null })
        }
        return Outcome.Applied(changed.filter { it in rows }, gone, objects(o, "rest"), strings(o, "restGone"), priced.map { LiveTick(it.first, now, it.second, null) } + trades)
    }

    /** One first-page coin as a token the app can read, from its merged row. */
    fun wire(key: String): WireToken? = rows[key]?.let(Wire::token)

    private fun objects(o: JSONObject, name: String): List<JSONObject> =
        (o.opt(name) as? JSONArray)?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } } ?: emptyList()

    private fun strings(o: JSONObject, name: String): List<String> =
        (o.opt(name) as? JSONArray)?.let { a -> (0 until a.length()).mapNotNull { (a.opt(it) as? String)?.lowercase() } } ?: emptyList()
}

/** Server-Sent Events, one line at a time (the feed sends one `data:` line per message). */
class SseLines {
    private var event: String? = null

    /** The message this line completes, if it does: its event name (`message` when none was sent) and data. */
    fun take(line: String): Pair<String, String>? {
        if (line.startsWith("event:")) {
            event = line.substring(6).trim()
            return null
        }
        if (!line.startsWith("data:")) return null
        val name = event ?: "message"
        event = null
        return name to line.substring(5).trim()
    }
}
