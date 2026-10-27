package io.pinr.app.ui

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.pinr.app.feed.Format
import io.pinr.app.feed.PriceAlert
import io.pinr.app.feed.Token
import io.pinr.app.feed.Watch
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** The watchlist and alerts on this phone (the site's localStorage keys `pinr.watchlist` and `pinr.alerts`). */
class WatchStore(context: Context) {
    private val prefs = context.getSharedPreferences("pinr", Context.MODE_PRIVATE)

    var watch by mutableStateOf(read("pinr.watchlist") { a -> (0 until a.length()).mapNotNull { (a.opt(it) as? String)?.takeIf { s -> s.isNotEmpty() } } })
        private set
    var alerts by mutableStateOf(read("pinr.alerts") { a ->
        (0 until a.length()).mapNotNull { i ->
            val o = a.opt(i) as? JSONObject ?: return@mapNotNull null
            val level = (o.opt("level") as? Number)?.toDouble() ?: return@mapNotNull null
            val dir = o.opt("dir") as? String
            if (!level.isFinite() || level <= 0 || (dir != "up" && dir != "down")) return@mapNotNull null
            PriceAlert(o.optString("id"), o.optString("key"), o.optString("ticker"), level, dir, o.optLong("created"))
        }
    })
        private set
    /** The newest alert that fired, shown for ten seconds. */
    var toast by mutableStateOf<String?>(null)
        private set
    private var toastUntil = 0L

    private fun <T> read(key: String, f: (JSONArray) -> List<T>): List<T> =
        try { prefs.getString(key, null)?.let { f(JSONArray(it)) } ?: emptyList() } catch (e: Exception) { emptyList() }

    fun isWatched(address: String) = address in watch

    fun toggle(address: String) {
        watch = Watch.toggle(watch, address)
        prefs.edit().putString("pinr.watchlist", JSONArray(watch).toString()).apply()
    }

    /** Adds an alert; returns the site's message when it cannot be set. */
    fun addAlert(t: Token, level: Double): String? {
        if (t.priceUsd == null) return "No price yet for this token, so an alert cannot be set."
        val dir = Watch.alertDir(level, t.priceUsd) ?: return "Enter a price different from the current one."
        val a = PriceAlert("a" + UUID.randomUUID().toString().take(8), t.address, if (t.ticker == null) Format.title(t) else Format.ticker(t), level, dir, System.currentTimeMillis())
        alerts = Watch.add(alerts, a)
        save()
        return null
    }

    fun remove(a: PriceAlert) { alerts = alerts.filterNot { it.id == a.id }; save() }

    /** Called with each new reading of the feed. */
    fun check(tokens: List<Token>) {
        if (System.currentTimeMillis() > toastUntil) toast = null
        if (alerts.isEmpty()) return
        val prices = tokens.associate { it.address to it.priceUsd }
        val (fired, waiting) = Watch.check(alerts) { prices[it] }
        if (fired.isEmpty()) return
        alerts = waiting
        save()
        toast = Watch.toast(fired)
        toastUntil = System.currentTimeMillis() + 10_000
    }

    private fun save() {
        val a = JSONArray(alerts.map { JSONObject().put("id", it.id).put("key", it.key).put("ticker", it.ticker).put("level", it.level).put("dir", it.dir).put("created", it.created) })
        prefs.edit().putString("pinr.alerts", a.toString()).apply()
    }
}
