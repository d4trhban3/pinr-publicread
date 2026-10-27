package io.pinr.app.feed

import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.min
import kotlin.math.sin

/**
 * A tile's ribbon: trade streaks, lime for buys and mandarin for sells, in the real mix (pinr-live/src/world/livefeed.ts
 * and flow.ts; the iPhone app's Ribbon.swift). No trades in the last hour: no ribbon ([of] gives null).
 */
class Ribbon private constructor(
    /** Share of buys, 0..1. */
    val buyShare: Double,
    /** How fast the streaks travel, in ribbon lengths a second: calm coins drift, busy ones rush. */
    val speed: Double,
    /** True when the mix is counted in trades, not dollars (drawn faint). */
    val isCount: Boolean = false,
) {
    /** Where streak [i] is at time [t] seconds (0 = oldest edge, 1 = now), and whether it is a buy. */
    fun streak(i: Int, t: Double): Pair<Double, Boolean> {
        val u = (hash(i) + t * speed).mod(1.0)
        return u to (hash(i + 7919) < buyShare)
    }

    companion object {
        /** Below this many trades a mix means little, so the streaks show an even mix. */
        const val MIN_TRADES = 3
        const val STREAKS = 10

        fun of(flow: Token.Flow?): Ribbon? {
            val f = flow ?: return null
            if (f.trades1h <= 0) return null
            fun share(b: Double, s: Double) = if (b + s > 0) b / (b + s) else 0.5
            val hour = if (f.trades1h >= MIN_TRADES) share(f.buy1h, f.sell1h) else 0.5
            val buy = if (f.trades5m >= MIN_TRADES) share(f.buy5m, f.sell5m) else hour
            val busy = if (f.trades5m > 0) min(1.0, log10(1.0 + f.trades5m) / 2.5) else 0.0
            return Ribbon(buy, 0.05 + 0.35 * busy, f.isCount)
        }

        /** How far a trade of this size (0..1) rides from the line, in tile heights: up (negative) for a buy, down for a sell; near "now" (u = 1) it swoops further. */
        const val SIZE_RANGE = 0.17
        const val SWOOP = 0.6
        fun sizeOffset(size: Double, buy: Boolean, u: Double): Double {
            val s = size.coerceIn(0.0, 1.0)
            val tail = if (u > 0.82) SWOOP * Math.pow((u - 0.82) / 0.18, 2.0) else 0.0
            return (if (buy) -1 else 1) * s * SIZE_RANGE * (1 + tail)
        }

        /** Each streak's height in the band (0 top, 1 bottom) and its size (0 small, 1 big): fixed per streak. */
        fun lane(i: Int): Pair<Double, Double> = hash(i + 104_729) to hash(i + 1_299_709)

        /** A fixed spread in 0 until 1 for each streak, the same on every frame (the iPhone app's hash). */
        fun hash(i: Int): Double {
            val x = sin(i * 12.9898 + 78.233) * 43758.5453
            return x - floor(x)
        }
    }
}
