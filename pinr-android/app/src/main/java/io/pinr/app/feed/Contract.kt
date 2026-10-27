package io.pinr.app.feed

import org.json.JSONObject

/**
 * The feed server's answer to `/api/contract`: which data contract it speaks, and the four labels that always mean
 * "no score" (pinr-live/contract/DATA-CONTRACT.md).
 */
data class ContractInfo(val contract: String, val noScoreLabels: List<String>)

object Contract {
    /** The major contract version this app understands. The site and the iPhone app refuse any other and say "Mismatch". */
    const val SUPPORTED_MAJOR = "1"

    /** The labels the contract names. A feed naming a different set disagrees on what "no score" means: a mismatch too. */
    val EXPECTED_NO_SCORE_LABELS = setOf("VAMP", "BOT/RUG", "MAYHEM", "HONEYPOT")

    /** True when the app can show this feed's data. */
    fun accepts(info: ContractInfo): Boolean =
        acceptsVersion(info.contract) && info.noScoreLabels.toSet() == EXPECTED_NO_SCORE_LABELS

    /** True when a version's major part is the one this app understands (every `/api/tokens` answer carries it too). */
    fun acceptsVersion(version: String): Boolean = version.split(".").first() == SUPPORTED_MAJOR

    /** Reads the feed's answer; null when it is not the expected shape (never a guess). */
    fun parse(body: String): ContractInfo? = try {
        val o = JSONObject(body)
        val contract = o.get("contract") as? String
        val labels = o.optJSONArray("noScoreLabels")
        if (contract == null || labels == null) null
        else ContractInfo(contract, (0 until labels.length()).map { labels.get(it) as? String ?: return null })
    } catch (e: Exception) {
        null
    }
}
