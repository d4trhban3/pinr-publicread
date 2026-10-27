package io.pinr.app.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.max
import kotlin.math.min

/**
 * The look the person sees: light or dark. It follows the phone until the person taps the sun or moon in the header (as on the site and the
 * iPhone app), and the choice is kept on this phone. Every [Brand] colour reads it while drawing, so a change redraws everything at once.
 */
object ThemeState {
    /** True = light, false = dark, null = follow the phone. */
    var choice by mutableStateOf<Boolean?>(null)
    /** Whether the phone is in its dark look (set by the app shell). */
    var systemDark by mutableStateOf(true)
    val light: Boolean get() = choice ?: !systemDark

    private const val FILE = "pinr.look"
    private const val KEY = "choice"

    /** Reads the saved choice ("light", "dark"; anything else follows the phone). */
    fun load(ctx: Context) {
        choice = try {
            when (ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY, null)) { "light" -> true; "dark" -> false; else -> null }
        } catch (e: Exception) { null }
    }

    /** The sun or moon: switch to the other look and keep it. */
    fun toggle(ctx: Context) {
        val next = !light
        choice = next
        try { ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY, if (next) "light" else "dark").apply() } catch (e: Exception) {}
    }
}

/**
 * The site's design tokens (pinr-live/src/style.css `:root` and `[data-theme="light"]`): one live accent (lime) on ink, in a dark and a
 * light look, as on the iPhone app (Theme.swift). Each colour follows [ThemeState].
 */
object Brand {
    private fun pick(dark: Long, light: Long): Color = Color(if (ThemeState.light) light else dark)

    val ink: Color get() = pick(0xFF0A0C0E, 0xFFEBE4F7)
    /** The text colour (`--text`). */
    val paper: Color get() = pick(0xFFF4EEFF, 0xFF14161C)
    val mute: Color get() = pick(0xFF9AA1AE, 0xFF434A58)
    /** The live accent (`--live`). */
    val lime: Color get() = pick(0xFFD6FF3C, 0xFF587A00)
    val mandarin: Color get() = pick(0xFFFF8C1A, 0xFFD96100)
    val amber: Color get() = pick(0xFFFFD24A, 0xFF8A6400)
    val lilac = Color(0xFFCDB6FE)
    val violet = Color(0xFF6C4DFB)
    /** Text on a lime field (`--on-live`). */
    val onLive: Color get() = pick(0xFF0A0C0E, 0xFFFFFFFF)
    /** Tile and bar glass: black at 80% in the dark look, white at 80% in the light one (`--glass-rgb`). */
    val glass: Color get() = if (ThemeState.light) Color(0xE6F5F1FB) else Color(0xCC000000)
    /** Hairlines, rims and soft fills (`--fg-rgb`), used at low opacity. */
    val fg: Color get() = pick(0xFFFFFFFF, 0xFF0E121C)
    /** Menus and sheets (`--panel-rgb`). */
    val panel: Color get() = pick(0xFF0A0C0E, 0xFFF2EEF9)
    /** Mismatch is the one red the site uses for the feed status. */
    val alarm = Color(0xFFFF4D4D)

    /** The PINRscore colour scale: mandarin at 25 and below, lime at 95 and above, a smooth blend between (scorecolor.ts). */
    fun score(s: Int): Color {
        val t = min(1f, max(0f, (s - 25) / 70f))
        val light = ThemeState.light
        val lo = if (light) floatArrayOf(217f, 97f, 0f) else floatArrayOf(255f, 140f, 26f)
        val hi = if (light) floatArrayOf(88f, 122f, 0f) else floatArrayOf(214f, 255f, 60f)
        return Color(
            red = (lo[0] + (hi[0] - lo[0]) * t) / 255f,
            green = (lo[1] + (hi[1] - lo[1]) * t) / 255f,
            blue = (lo[2] + (hi[2] - lo[2]) * t) / 255f,
        )
    }

}

/** The site's glass: black at 80% with a bright top-left rim and a dim bottom-right rim, lifted off the background. */
fun Modifier.glass(radius: Dp, shape: Shape = RoundedCornerShape(radius)): Modifier = this
    .shadow(10.dp, shape, clip = false, ambientColor = if (ThemeState.light) Color(0xFF6C4DFB) else Color.Black, spotColor = if (ThemeState.light) Color(0xFF6C4DFB) else Color.Black)
    .background(Brand.glass, shape)
    .border(
        1.dp,
        // The light look's rim: violet (108, 77, 251) at 24% (the site's light palette, 2026-10-25).
        if (ThemeState.light) Brush.linearGradient(listOf(Color(0x3D6C4DFB), Color(0x3D6C4DFB)))
        else Brush.linearGradient(listOf(Brand.fg.copy(alpha = 0.3f), Brand.fg.copy(alpha = 0.045f), Brand.fg.copy(alpha = 0.1f))),
        shape,
    )

/**
 * The site's design sizes on the tiles, the header and the footer: drawn at their fixed size whatever the phone's text
 * size, as the iPhone app does (its `fsans`/`fmono`); reading text elsewhere follows the phone's size, up to 1.6 times.
 */
@androidx.compose.runtime.Composable
fun FixedTextSize(content: @androidx.compose.runtime.Composable () -> Unit) {
    val d = androidx.compose.ui.platform.LocalDensity.current
    androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(d.density, 1f)) { content() }
}

/** Reading text grows with the phone's text size, at most 1.6 times (the iPhone app's limit). */
@androidx.compose.runtime.Composable
fun CappedTextSize(content: @androidx.compose.runtime.Composable () -> Unit) {
    val d = androidx.compose.ui.platform.LocalDensity.current
    androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(d.density, minOf(d.fontScale, 1.6f))) { content() }
}

/** The PINR wordmark in the look's own file: the light one (art pack 65, ink letters) in the light look, never the dark one turned over. */
@androidx.compose.runtime.Composable
fun wordmarkPainter() = androidx.compose.ui.res.painterResource(if (ThemeState.light) io.pinr.app.R.drawable.pinr_wordmark_light else io.pinr.app.R.drawable.pinr_wordmark)
