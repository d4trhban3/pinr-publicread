package io.pinr.app.ui

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.pinr.app.feed.ChoicesCode
import io.pinr.app.feed.NameFilter
import io.pinr.app.feed.Token
import io.pinr.app.feed.WalletRules
import org.json.JSONArray

/**
 * A person's choices, kept on this phone only (the site keeps them in the browser under the same names: `pinr.hidden`,
 * `pinr.filterNames`, `pinr.wallet`): the coins they hid, the rude-name filter, the one public address
 * they look up, and the two Display switches. Nothing here is sent anywhere or changes a score.
 */
class ChoicesStore(context: Context) {
    private val prefs = context.getSharedPreferences("pinr", Context.MODE_PRIVATE)

    var hidden by mutableStateOf(
        try { prefs.getString("pinr.hidden", null)?.let { s -> JSONArray(s).let { a -> (0 until a.length()).mapNotNull { (a.opt(it) as? String)?.lowercase() } }.toSet() } ?: emptySet() }
        catch (e: Exception) { emptySet() },
    )
        private set
    var filterNames by mutableStateOf(prefs.getString("pinr.filterNames", null) != "false")
        private set
    var wallet by mutableStateOf(prefs.getString("pinr.wallet", null)?.let { WalletRules.clean(it)?.first })
        private set
    var background by mutableStateOf(prefs.getBoolean("pinr.background", true))
        private set
    var streams by mutableStateOf(prefs.getBoolean("pinr.streams", true))
        private set

    init { NameFilter.enabled = filterNames }

    fun isHidden(t: Token) = t.id in hidden
    fun visible(list: List<Token>): List<Token> = if (hidden.isEmpty()) list else list.filter { it.id !in hidden }

    fun hide(t: Token) = storeHidden(hidden + t.id)
    fun unhide(t: Token) = storeHidden(hidden - t.id)
    fun unhideAll() = storeHidden(emptySet())

    private fun storeHidden(s: Set<String>) {
        hidden = s
        prefs.edit().putString("pinr.hidden", JSONArray(s.sorted()).toString()).apply()
    }

    fun setFilter(on: Boolean) {
        filterNames = on
        NameFilter.enabled = on
        prefs.edit().putString("pinr.filterNames", on.toString()).apply()
    }

    fun switchBackground(on: Boolean) { background = on; prefs.edit().putBoolean("pinr.background", on).apply() }
    fun switchStreams(on: Boolean) { streams = on; prefs.edit().putBoolean("pinr.streams", on).apply() }

    /** Looks up an address; returns the site's message when it is not one. */
    fun viewWallet(raw: String): String? {
        val c = WalletRules.clean(raw) ?: return WalletRules.NOT_AN_ADDRESS
        wallet = c.first
        prefs.edit().putString("pinr.wallet", c.first).apply()
        return null
    }

    fun clearWallet() { wallet = null; prefs.edit().remove("pinr.wallet").apply() }

    /** This phone's code: the looked-up address, the hidden coins and the filter switch. */
    fun code(): String = ChoicesCode.make(listOfNotNull(wallet), hidden, filterNames)

    /**
     * Takes a read code in, as the format says: hidden coins are added (nothing is un-hidden), the filter takes the code's
     * value (kept when it has none), the address becomes the code's first wallet (none in the code: the current one stays).
     */
    fun apply(c: ChoicesCode.Choices): Pair<Int, Boolean> {
        val before = hidden
        storeHidden(hidden + c.hidden.map { it.lowercase() }.take(ChoicesCode.MAX_HIDDEN))
        c.filter?.let(::setFilter)
        val first = c.wallets.firstOrNull()
        val changed = first != null && first != wallet
        if (changed) viewWallet(first!!)
        return (hidden - before).size to changed
    }
}
