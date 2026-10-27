package io.pinr.app.feed

/**
 * The engine's note is a list of parts joined by ";". A part that only says the engine hit a "technical error" or is "retrying" is a status, not a finding about the
 * coin, so it is never shown (the site's `STATUS_NOTE`, livefeed.ts: /^technical error\b|\bretrying\b/i). What is left is shown; nothing left, no note.
 */
object EngineNote {
    private val STATUS = Regex("^technical error\\b|\\bretrying\\b", RegexOption.IGNORE_CASE)
    fun parts(note: String?): List<String> = note?.split(";")?.map { it.jsTrim() }?.filter { it.isNotEmpty() && !STATUS.containsMatchIn(it) } ?: emptyList()
}
