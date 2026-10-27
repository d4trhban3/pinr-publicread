package io.pinr.app.feed

import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext

/** One read from the feed server: its status code and body. Swapped for a fake in the tests. */
fun interface Http {
    /** Throws when the server cannot be reached. */
    fun get(url: String): Pair<Int, String>

    /**
     * Opens a Server-Sent Events stream and hands each line to [onLine] until it returns false or the stream ends; returns the
     * status code. Throws when the server cannot be reached. Only the real reader (and a test's fake) opens one.
     */
    fun stream(url: String, onLine: (String) -> Boolean): Int = throw java.io.IOException("no stream")
}

/** The real reader: a plain GET, nothing sent but the address, no cache, no redirects. */
object UrlHttp : Http {
    override fun get(url: String): Pair<Int, String> {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 8000
            c.readTimeout = 15000
            c.useCaches = false
            c.instanceFollowRedirects = false
            val code = c.responseCode
            val body = if (code == 200) c.inputStream.bufferedReader().use { it.readText() } else ""
            return code to body
        } finally {
            c.disconnect()
        }
    }

    /** The change stream (`/api/stream`): the feed sends a comment line every 25 s, so 70 s without a byte means it is gone. */
    override fun stream(url: String, onLine: (String) -> Boolean): Int {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 8000
            c.readTimeout = 70_000
            c.useCaches = false
            c.instanceFollowRedirects = false
            c.setRequestProperty("Accept", "text/event-stream")
            val code = c.responseCode
            if (code == 200) c.inputStream.bufferedReader().use { r ->
                while (true) {
                    val line = r.readLine() ?: break
                    if (!onLine(line)) break
                }
            }
            return code
        } finally {
            c.disconnect()
        }
    }
}

/** Everything the screens read from the feed, as one value so a screen always sees a consistent set. */
data class FeedData(
    val state: FeedState = FeedState.Connecting,
    /** Every token once: the first page, then the rest without the ones already on it. */
    val all: List<Token> = emptyList(),
    /** The same tokens by id, built with them away from the screen's thread. */
    val byId: Map<String, Token> = emptyMap(),
    val firstPageCount: Int = 0,
    /** How many of the rest have been read, and how many the feed says there are. */
    val restLoaded: Int = 0,
    val restTotal: Int? = null,
    /** Tokens the feed sent that could not be shown (no address, a coverage out of range, an unknown label). */
    val leftOut: Int = 0,
    val lastHeardMs: Long? = null,
    /** Each token's score change since the app first saw it (for Movers). A label or a missing score is not a move. */
    val moved: Map<String, Int> = emptyMap(),
    /** The feed's mode ("feed": the engine's results; "replay": saved runs) and its newest result's time. */
    val mode: String? = null,
    val asOfMs: Long? = null,
)

/**
 * Every token the feed serves, kept current the way the site keeps it (pinr-live/src/world/livefeed.ts) and the iPhone
 * app (FeedStore.swift): `/api/contract` once, then the first page (`/api/tokens`) and the rest of the scored set
 * (`/api/tokens/rest`, 1,000 a page) once on open, then kept current by the feed's change stream (`/api/stream`, a design decision:
 * coin seen, score landed, price tick, graduation, coin gone). Only while the stream is not open do the old polls run (the
 * first page every 15 seconds, the rest every minute). Read-only.
 */
class FeedStore(
    val baseUrl: String?,
    private val http: Http = UrlHttp,
    private val pageDelayMs: Long = 50,
) {
    private val _data = MutableStateFlow(FeedData())
    val data: StateFlow<FeedData> = _data

    private var firstPage: List<Token> = emptyList()
    private var mode: String? = null
    private var asOfMs: Long? = null
    private var rest: List<Token> = emptyList()
    private var leftOutFirst = 0
    private var leftOutRest = 0
    private val firstScore = HashMap<String, Int>()
    private val moved = HashMap<String, Int>()
    private val lock = Mutex()
    private var sweeping = false
    private val copy = StreamCopy()
    private val firstTokens = HashMap<String, Token>()
    /** The newest trade's price per first-page coin and when it came: kept over a slower list price for a minute. */
    private val livePrice = HashMap<String, Pair<Double, Long>>()

    /** The prices and trades the stream brought lately, the newest 300, and how many have come in all. */
    @Volatile var recentTicks: List<LiveTick> = emptyList()
        private set
    @Volatile var tickCount = 0
        private set

    /** Whether the change stream is open now (false: the app is on the fallback polls). */
    @Volatile var streaming = false
        private set

    /** Asks the feed which contract it speaks; a different one stops everything with "Mismatch". */
    suspend fun checkContract(): FeedState {
        val base = baseUrl ?: return setState(FeedState.Offline("No feed address in this build"))
        val s = read("$base/api/contract") { body ->
            Contract.parse(body)?.let { if (Contract.accepts(it)) FeedState.Live(it.contract) else FeedState.Mismatch(it.contract) }
        }
        return when (s) {
            is Read.Ok -> {
                if (s.value is FeedState.Mismatch) refuse(s.value.contract)
                s.value
            }
            is Read.Failed -> setState(FeedState.Offline(s.reason))
        }
    }

    /** Reads the first page once. */
    suspend fun poll() {
        val base = baseUrl ?: run { setState(FeedState.Offline("No feed address in this build")); return }
        when (val r = read("$base/api/tokens") { body -> Wire.snapshot(body)?.let { Triple(it, build(it.tokens), org.json.JSONObject(body).optJSONArray("tokens")) } }) {
            is Read.Failed -> setState(FeedState.Offline(r.reason))
            is Read.Ok -> lock.withLockSafe {
                val (snap, built, raw) = r.value
                if (!Contract.acceptsVersion(snap.contract)) return@withLockSafe refuse(snap.contract)
                noteScores(built.first)
                copy.load(raw ?: org.json.JSONArray(), snap.stream)
                firstTokens.clear()
                for (t in built.first) firstTokens[t.id] = t
                firstPage = built.first
                leftOutFirst = built.second
                mode = snap.mode
                asOfMs = snap.asOfMs?.takeIf { it > 0 }?.toLong()
                publish(FeedState.Live(snap.contract), heard = true)
            }
        }
    }

    /**
     * Base and BNB Chain coins from the rest list, read on their own (a design decision, `chains=base,bsc`): one page, a second or two,
     * instead of waiting for the whole sweep. Null when the feed did not answer.
     */
    suspend fun chainCoins(): List<Token>? {
        val base = baseUrl ?: return null
        val r = read("$base/api/tokens/rest?offset=0&limit=$PAGE_SIZE&chains=base,bsc") { body -> Wire.restPage(body)?.let { build(it.tokens).first } }
        return (r as? Read.Ok)?.value
    }

    /**
     * Coins asked for by their exact address that are on no list: kept apart so they never
     * reach a tile, a tab or a count, but the coin page can open them.
     */
    val found = java.util.concurrent.ConcurrentHashMap<String, Token>()

    /** A coin by its exact address: from the lists if it is there, else asked of the feed (`/api/token/find`). Null for an unknown address or a hidden copy. */
    suspend fun find(address: String): Token? {
        val id = address.lowercase()
        _data.value.byId[id]?.let { return it }
        found[id]?.let { return it }
        val base = baseUrl ?: return null
        if (!CoinAddress.isAddress(address)) return null
        val r = read("$base/api/token/find?address=${java.net.URLEncoder.encode(address, "UTF-8")}") { body ->
            (try { org.json.JSONObject(body) } catch (e: Exception) { null })?.let { o ->
                (o.opt("token") as? org.json.JSONObject)?.let(Wire::token)?.let { w -> (Token.make(w, baseUrl) as? Token.Made.Shown)?.token }
            }
        }
        val t = (r as? Read.Ok)?.value ?: return null
        found[t.id] = t
        return t
    }

    private class RestPart(val page: WireRestPage, val tokens: List<Token>, val bad: Int)

    private suspend fun readRest(base: String, offset: Int): RestPart? {
        val r = read("$base/api/tokens/rest?offset=$offset&limit=$PAGE_SIZE") { body -> Wire.restPage(body)?.let { it to build(it.tokens) } }
        if (r !is Read.Ok) return null
        return RestPart(r.value.first, r.value.second.first, r.value.second.second)
    }

    /**
     * Reads the rest of the scored set: the first page tells how many there are, then the others come [PARALLEL_PAGES] at a time
     * . A failed page ends this sweep and
     * keeps what the last whole sweep found; the next sweep starts again.
     */
    suspend fun sweep() {
        val base = baseUrl ?: return
        if (_data.value.state !is FeedState.Live || sweeping) return
        sweeping = true
        try {
            val firstSweep = _data.value.restTotal == null
            val head = readRest(base, 0) ?: return
            if (!Contract.acceptsVersion(head.page.contract)) { lock.withLockSafe { refuse(head.page.contract) }; return }
            val total = head.page.total
            val collected = ArrayList<Token>(head.tokens)
            var bad = head.bad
            lock.withLockSafe {
                noteScores(head.tokens)
                if (firstSweep) {
                    rest = ArrayList(collected)
                    publish(_data.value.state, restLoaded = minOf(total, head.page.tokens.tokens.size + head.page.tokens.unreadable), restTotal = total)
                }
            }
            val offsets = (PAGE_SIZE until total step PAGE_SIZE).toList()
            for (wave in offsets.chunked(PARALLEL_PAGES)) {
                val parts = coroutineScope { wave.map { o -> async { readRest(base, o) } }.awaitAll() }
                for (part in parts) {
                    part ?: return
                    if (!Contract.acceptsVersion(part.page.contract)) { lock.withLockSafe { refuse(part.page.contract) }; return }
                }
                for (part in parts) { collected += part!!.tokens; bad += part.bad }
                lock.withLockSafe {
                    parts.forEach { noteScores(it!!.tokens) }
                    if (firstSweep) {
                        rest = ArrayList(collected)
                        publish(_data.value.state, restLoaded = minOf(total, wave.last() + PAGE_SIZE), restTotal = total)
                    }
                }
                delay(pageDelayMs)
            }
            lock.withLockSafe {
                rest = ArrayList(collected)
                leftOutRest = bad
                publish(_data.value.state, restLoaded = total, restTotal = total)
            }
        } finally {
            sweeping = false
        }
    }

    /** Keeps reading while the screen is open: the contract until it answers, then both lists once and the change stream; the polls only while the stream is not open. */
    suspend fun run() = coroutineScope {
        while (isActive && checkContract() !is FeedState.Live) {
            if (_data.value.state is FeedState.Mismatch) return@coroutineScope
            delay(POLL_EVERY_MS)
        }
        launch { streamLoop() }
        var lastSweep = 0L
        while (isActive) {
            if (!streaming) {
                poll()
                val now = System.currentTimeMillis()
                if (_data.value.state is FeedState.Live && now - lastSweep >= SWEEP_EVERY_MS) {
                    lastSweep = now
                    launch { sweep() }
                }
            }
            if (_data.value.state is FeedState.Mismatch) return@coroutineScope
            delay(POLL_EVERY_MS)
        }
    }

    // The change stream

    enum class StreamEnd { Ended, Refused, Reloaded }

    /**
     * Opens `/api/stream` from where the first page stands and keeps it open; a dropped stream is tried again after a few
     * seconds, one the server refused (full) after a minute. While it is down, [run] polls.
     */
    suspend fun streamLoop() {
        while (currentCoroutineContext().isActive) {
            var wait = STREAM_RETRY_MS
            if (_data.value.state is FeedState.Live && copy.position != null) {
                if (readStream() == StreamEnd.Refused) wait = STREAM_REFUSED_MS
                streaming = false
            }
            delay(wait)
        }
    }

    /** One run of the stream: opens it, applies each message, returns when it ends. */
    suspend fun readStream(): StreamEnd {
        val base = baseUrl ?: return StreamEnd.Ended
        val at = copy.position ?: return StreamEnd.Ended
        val sse = SseLines()
        val messages = kotlinx.coroutines.channels.Channel<Pair<String, String>>(kotlinx.coroutines.channels.Channel.UNLIMITED)
        return coroutineScope {
            val reader = launch(Dispatchers.IO) {
                try {
                    val code = http.stream("$base/api/stream?boot=${at.boot}&since=${at.seq}") { line ->
                        if (isActive) streaming = true
                        sse.take(line)?.let { messages.trySend(it) }
                        isActive
                    }
                    if (code != 200) streaming = false
                    messages.trySend((if (code == 503) "refused" else "end") to "")
                } catch (e: Exception) {
                    messages.trySend("end" to "")
                } finally {
                    messages.close()
                }
            }
            var end = StreamEnd.Ended
            for ((event, data) in messages) {
                if (event == "refused") { end = StreamEnd.Refused; break }
                if (event == "end") break
                if (handleStream(event, data) == StreamEnd.Reloaded) { end = StreamEnd.Reloaded; break }
            }
            reader.cancel()
            end
        }
    }

    /** One stream message: `changes` is applied; `reset` (or a change this copy cannot follow) reads both lists again. */
    suspend fun handleStream(event: String, data: String): StreamEnd {
        when (event) {
            "reset" -> { reload(); return StreamEnd.Reloaded }
            "changes" -> {
                // The copy is changed only under the lock, where `poll()` loads it.
                var outcome: StreamCopy.Outcome = StreamCopy.Outcome.Ignored
                lock.withLockSafe {
                    outcome = copy.apply(data)
                    (outcome as? StreamCopy.Outcome.Applied)?.let {
                        applyChanges(it)
                        if (it.ticks.isNotEmpty()) { recentTicks = (recentTicks + it.ticks).takeLast(300); tickCount += it.ticks.size }
                    }
                }
                if (outcome == StreamCopy.Outcome.Reset) { reload(); return StreamEnd.Reloaded }
            }
        }
        return StreamEnd.Ended
    }

    /** The stream cannot follow (or said so): read the first page and the rest again; the stream opens again from there. */
    private suspend fun reload() {
        lock.withLockSafe { copy.clear() }
        streaming = false
        poll()
        sweep()
    }

    /** Folds each trade of a stream message into its first-page coin (price, market cap, line, ribbon); the caller publishes the page. */
    private fun foldTrades(ticks: List<LiveTick>) {
        var any = false
        for (tick in ticks) {
            if (tick.usd == null) continue
            val current = firstTokens[tick.address] ?: continue
            val folded = current.foldedTrade(tick)
            firstTokens[tick.address] = folded
            if (folded.priceUsd == tick.price) livePrice[tick.address] = tick.price to System.currentTimeMillis()
            any = true
        }
        if (any) firstPage = copy.order.mapNotNull { firstTokens[it] }
    }

    private fun applyChanges(o: StreamCopy.Outcome.Applied) {
        val touched = ArrayList<Token>()
        for (key in o.changed) {
            val w = copy.wire(key) ?: continue
            val m = Token.make(w, baseUrl)
            if (m is Token.Made.Shown) {
                // A trade's price from the last minute stays over this list price.
                val kept = livePrice[key]?.takeIf { System.currentTimeMillis() - it.second < LiveFold.HOLD_MS }?.first
                val shown = if (kept != null) m.token.repricedTo(kept) else m.token
                firstTokens[key] = shown; touched += shown
            }
        }
        for (key in o.gone) firstTokens.remove(key)
        noteScores(touched)
        firstPage = copy.order.mapNotNull { firstTokens[it] }
        foldTrades(o.ticks)
        if (o.rest.isNotEmpty() || o.restGone.isNotEmpty()) {
            val next = ArrayList(rest)
            val at = HashMap<String, Int>(next.size * 2)
            next.forEachIndexed { i, t -> at[t.id] = i }
            val fresh = ArrayList<Token>()
            for (row in o.rest) {
                val w = Wire.token(row) ?: continue
                val t = (Token.make(w, baseUrl) as? Token.Made.Shown)?.token ?: continue
                val i = at[t.id]
                if (i == null) { at[t.id] = next.size + fresh.size; fresh += t }
                else if (i < next.size) next[i] = t
                else fresh[i - next.size] = t
            }
            next += fresh
            if (o.restGone.isNotEmpty()) { val g = o.restGone.toHashSet(); next.removeAll { it.id in g } }
            noteScores(fresh)
            rest = next
        }
        publish(_data.value.state, heard = true)
    }

    // Helpers

    private sealed interface Read<out T> {
        data class Ok<T>(val value: T) : Read<T>
        data class Failed(val reason: String) : Read<Nothing>
    }

    /** Reads one answer and turns it into tokens away from the screen's thread. */
    private suspend fun <T : Any> read(url: String, parse: (String) -> T?): Read<T> = withContext(Dispatchers.IO) {
        try {
            val (code, body) = http.get(url)
            if (code != 200) return@withContext Read.Failed("The feed answered $code")
            parse(body)?.let { Read.Ok(it) } ?: Read.Failed("The feed's answer could not be read")
        } catch (e: Exception) {
            Read.Failed("The feed cannot be reached")
        }
    }

    private fun build(list: LenientTokens): Pair<List<Token>, Int> {
        val out = ArrayList<Token>(list.tokens.size)
        var bad = list.unreadable
        for (w in list.tokens) {
            when (val m = Token.make(w, baseUrl)) {
                is Token.Made.Shown -> out += m.token
                is Token.Made.Left -> bad++
            }
        }
        return out to bad
    }

    private fun noteScores(tokens: List<Token>) {
        for (t in tokens) {
            val s = Ranking.scoreOf(t) ?: continue
            val first = firstScore[t.id]
            if (first == null) firstScore[t.id] = s else if (s != first) moved[t.id] = s - first else moved.remove(t.id)
        }
    }

    private fun publish(state: FeedState, heard: Boolean = false, restLoaded: Int? = null, restTotal: Int? = null) {
        val seen = firstPage.mapTo(HashSet()) { it.id }
        val prev = _data.value
        val all = firstPage + rest.filter { it.id !in seen }
        _data.value = prev.copy(
            state = state,
            all = all,
            byId = all.associateBy { it.id },
            firstPageCount = firstPage.size,
            restLoaded = restLoaded ?: prev.restLoaded,
            restTotal = restTotal ?: prev.restTotal,
            leftOut = leftOutFirst + leftOutRest,
            lastHeardMs = if (heard) System.currentTimeMillis() else prev.lastHeardMs,
            moved = HashMap(moved),
            mode = mode,
            asOfMs = asOfMs,
        )
    }

    /** The feed speaks another contract: nothing is shown until the two agree. */
    private fun refuse(contract: String) {
        firstPage = emptyList()
        rest = emptyList()
        _data.value = FeedData(state = FeedState.Mismatch(contract))
    }

    /** Offline keeps the last tokens heard on screen, marked by the state. */
    private fun setState(s: FeedState): FeedState {
        if (_data.value.state !is FeedState.Mismatch) _data.value = _data.value.copy(state = s)
        return s
    }

    private suspend inline fun Mutex.withLockSafe(block: () -> Unit) {
        lock()
        try { block() } finally { unlock() }
    }

    companion object {
        const val POLL_EVERY_MS = 15_000L
        const val SWEEP_EVERY_MS = 60_000L
        /** The rest is read in pages of 1,000 (the feed's largest), two at a time. */
        const val PAGE_SIZE = 1000
        const val PARALLEL_PAGES = 2
        const val STREAM_RETRY_MS = 5_000L
        const val STREAM_REFUSED_MS = 60_000L
    }
}
