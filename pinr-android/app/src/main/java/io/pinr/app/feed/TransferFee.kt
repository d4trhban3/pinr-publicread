package io.pinr.app.feed

import java.math.BigDecimal
import java.math.RoundingMode
import org.json.JSONArray
import org.json.JSONObject

/**
 * A coin's transfer fee as the feed sends it on a token (`TransferFee` in pinr-live/server/transferfee.ts, a design decision):
 * the rate in percent and whether it is a launchpad rewards program's fee within that program's standard or outside that norm.
 * Plain words only; nothing here is a score. The server has already checked the fact; this checks it again by the same rules, and
 * a fee that breaks them is missing (no row on the tile), never a guess.
 */
data class TransferFee(
    val pct: Double,
    val kind: Kind,
    val program: String? = null,
    val standardPct: Double? = null,
) {
    enum class Kind(val word: String) { None("none"), RewardsStandard("rewards_standard"), StandardUnknown("standard_unknown"), OutsideNorm("outside_norm") }

    /** The tile's short value (its label is "Fee"); null when the coin has no fee, so the tile shows no row. */
    fun short(): String? = when {
        kind == Kind.None -> null
        kind == Kind.RewardsStandard || kind == Kind.StandardUnknown -> "${pctText(pct)} rewards"
        program != null -> "${pctText(pct)} above rate"
        else -> "${pctText(pct)} not rewards"
    }

    companion object {
        private val PROGRAM_OK = Regex("^[A-Za-z0-9_ .\\-()]{1,40}$")

        /** The site's `${Number(p.toFixed(2))}%`: two places at most, no trailing zeros. */
        fun pctText(p: Double): String {
            val d = BigDecimal(p).setScale(2, RoundingMode.HALF_UP).stripTrailingZeros()
            return (if (d.signum() == 0) "0" else d.toPlainString()) + "%"
        }

        private fun isPct(v: Any?): Boolean = v is Number && v.toDouble().let { it.isFinite() && it in 0.0..100.0 }

        /** The wire's `transferFee` object, or null when it is absent or breaks the contract's rules (`feeFromFact`). */
        fun fromWire(o: JSONObject?): TransferFee? {
            o ?: return null
            if (!isPct(o.opt("pct"))) return null
            val pct = (o.opt("pct") as Number).toDouble()
            val kind = Kind.entries.firstOrNull { it.word == o.opt("kind") } ?: return null
            val rawProgram = o.opt("program")
            val program = (rawProgram as? String)?.jsTrim()?.takeIf { PROGRAM_OK.matches(it) }
            if (rawProgram != null && rawProgram != JSONObject.NULL && program == null) return null
            val rawStd = o.opt("standardPct")
            val hasStd = rawStd != null && rawStd != JSONObject.NULL
            if (hasStd && !isPct(rawStd)) return null
            val std = if (hasStd) (rawStd as Number).toDouble() else null
            val rawBasis = o.opt("standardBasis")
            val basis = rawBasis as? String
            val hasBasis = rawBasis != null && rawBasis != JSONObject.NULL
            if (hasBasis && basis != "settings" && basis != "observed") return null
            if (hasStd != hasBasis) return null
            val links = o.opt("standardLinks") as? JSONArray
            if (basis == "observed" && !(links != null && links.length() in 1..10)) return null
            if (basis != "observed" && o.opt("standardLinks") != null && o.opt("standardLinks") != JSONObject.NULL) return null
            if (std != null && program == null) return null
            return when (kind) {
                Kind.None -> if (pct == 0.0 && program == null) TransferFee(0.0, kind) else null
                else -> when {
                    pct == 0.0 -> null
                    kind == Kind.RewardsStandard -> if (program != null && std != null && pct <= std) TransferFee(pct, kind, program, std) else null
                    kind == Kind.StandardUnknown -> if (program != null && std == null) TransferFee(pct, kind, program) else null
                    else -> if (program == null || (std != null && pct > std)) TransferFee(pct, kind, program, std) else null
                }
            }
        }
    }
}
