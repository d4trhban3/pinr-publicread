package io.pinr.app.feed

import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Reads one coin's chart, tape, events, PINRmetric and dossier from the feed server. Read-only, and only for a coin the
 * feed lists (the server refuses any other address). Each call throws [Failure] when there is no answer to show.
 */
class CoinClient(private val baseUrl: String?, private val http: Http = UrlHttp) {
    class Failure(val reason: String) : Exception(reason)

    suspend fun candles(address: String, tf: Timeframe): CandleSet = get("api/candles", "address" to address, "tf" to tf.code) { CoinWire.candles(it) }
    suspend fun trades(address: String): TradesView = get("api/trades", "address" to address) { CoinWire.trades(it) }
    suspend fun events(address: String): List<ChartEvent> = get("api/events", "address" to address) { CoinWire.events(it) }
    suspend fun metric(address: String): Metric? = get("api/metric", "address" to address) { body -> CoinWire.metric(body) ?: NoMetric }.takeIf { it !== NoMetric } as Metric?
    /** The coin's evidence file (rows, the gate's result, PINRai's reading), or null when the feed has none. */
    suspend fun evidence(address: String): EvidenceHub? = get("api/evidence", "address" to address) { body -> EvidenceHub.parse(body) ?: NoEvidence }.takeIf { it !== NoEvidence } as EvidenceHub?
    /** TradingView's own symbol for the coin where it lists it (`/api/tvsymbol`), else null. A failed read is "not known". */
    suspend fun tvSymbol(address: String): String? = try {
        get("api/tvsymbol", "address" to address) { body -> org.json.JSONObject(body).let { o -> ChartLinks.validSymbol(o.opt("symbol") as? String) ?: "" } }.ifEmpty { null }
    } catch (e: Exception) { null }
    suspend fun dossier(address: String): Dossier = get("api/dossier", "address" to address) { Dossier.parse(it) }
    /** A public address's tracked holdings (`/api/wallet`): the address is the only thing sent, and nothing is kept by the server. */
    suspend fun wallet(address: String): WalletView = get("api/wallet", "address" to address) { WalletView.parse(it) }

    /** Stands for "the feed answered, and there is no metric" (not a failure). */
    private object NoMetric

    /** Stands for "the feed answered, and there is no evidence file" (not a failure). */
    private object NoEvidence

    private suspend fun <T : Any> get(path: String, vararg q: Pair<String, String>, parse: (String) -> T?): T = withContext(Dispatchers.IO) {
        val base = baseUrl ?: throw Failure("No feed address in this build")
        val query = q.sortedBy { it.first }.joinToString("&") { (k, v) -> "$k=${URLEncoder.encode(v, "UTF-8")}" }
        val (code, body) = try { http.get("$base/$path?$query") } catch (e: Exception) { throw Failure("The feed did not answer") }
        if (code != 200) throw Failure("The feed answered $code")
        parse(body) ?: throw Failure("The feed's answer could not be read")
    }
}
