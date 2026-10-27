package io.pinr.app.feed

/** Where the app stands with the feed server. */
sealed interface FeedState {
    data object Connecting : FeedState
    data class Live(val contract: String) : FeedState
    data class Offline(val reason: String) : FeedState
    data class Mismatch(val contract: String) : FeedState
}

/** The feed server's address rule (the reading itself is [FeedStore]'s). */
object FeedLink {
    /**
     * A release build reads only an HTTPS address (https://pinr.io, so its calls go to https://pinr.io/api/…);
     * anything else leaves it without a feed rather than reading in the clear. Test builds may read this Mac.
     */
    fun feedUrl(text: String?, release: Boolean): String? {
        val t = text?.jsTrim()?.trimEnd('/') ?: return null
        val m = Regex("^(https?)://([^/:?#@]+)(:\\d+)?$", RegexOption.IGNORE_CASE).matchEntire(t) ?: return null
        val scheme = m.groupValues[1].lowercase()
        return if (release && scheme != "https") null else t
    }
}
