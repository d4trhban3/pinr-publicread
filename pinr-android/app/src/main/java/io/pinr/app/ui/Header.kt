package io.pinr.app.ui

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.pinr.app.R

/** What a header button opens. */
enum class HeaderPanel { Pipeline, Diagnostics, Filters, Menu }

/**
 * The site's header (pinr-live/src/ui/header.ts), as the iPhone app draws it: one glass bar. Left: Back, the PINR
 * wordmark, the light/dark switch. Centre: the PINR guide button, the quiet lime logo (the compass moved to the footer's centre). Right: Discovery pipeline,
 * Diagnostics, the filter funnel (lit on the PINR page) and the menu.
 */
@Composable
fun HeaderBar(room: Room, map: Boolean, canGoBack: Boolean, onBack: () -> Unit, onGuide: () -> Unit, onPanel: (HeaderPanel) -> Unit, modifier: Modifier = Modifier) =
    FixedTextSize { HeaderBody(room, map, canGoBack, onBack, onGuide, onPanel, modifier) }

@Composable
private fun HeaderBody(room: Room, map: Boolean, canGoBack: Boolean, onBack: () -> Unit, onGuide: () -> Unit, onPanel: (HeaderPanel) -> Unit, modifier: Modifier) {
    // A narrow phone: the buttons and the GUIDE button are a little smaller so nothing is squeezed or over another, and under 340 dp the wordmark steps aside.
    val widthDp = LocalConfiguration.current.screenWidthDp
    val narrow = widthDp < 400
    val bw = if (narrow) 30.dp else 34.dp
    Row(
        modifier.fillMaxWidth().height(52.dp).glass(26.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HeaderButton("Back", bw, onBack) { GlyphIcon(Glyphs.back, if (canGoBack) Brand.lime else Brand.mute.copy(alpha = 0.5f), 22.dp) }
        if (widthDp >= 340) Image(wordmarkPainter(), "PINR", Modifier.padding(start = 2.dp).height(17.dp))
        // The sun (in the dark look) or the moon (in the light one) switches the look and keeps the choice, as on the site.
        val hctx = androidx.compose.ui.platform.LocalContext.current
        HeaderButton(if (ThemeState.light) "Switch to dark" else "Switch to light", if (narrow) 32.dp else 36.dp, { ThemeState.toggle(hctx) }) {
            GlyphIcon(if (ThemeState.light) Glyphs.moon else Glyphs.sun, Brand.paper, 19.dp)
        }
        Spacer(Modifier.weight(1f))
        GuideButton(onClick = onGuide, compact = narrow)
        Spacer(Modifier.weight(1f))
        HeaderButton("Discovery pipeline", bw, { onPanel(HeaderPanel.Pipeline) }) { GlyphIcon(Glyphs.pipe, Brand.paper, 21.dp) }
        HeaderButton("Diagnostics", bw, { onPanel(HeaderPanel.Diagnostics) }) { GlyphIcon(Glyphs.diag, Brand.paper, 21.dp) }
        HeaderButton("Filters", bw, { onPanel(HeaderPanel.Filters) }) {
            val c = if (room == Room.Pinr && !map) Brand.lime else Brand.lime.copy(alpha = 0.55f)
            Box {
                GlyphIcon(Glyphs.filter, c, 21.dp)
                Box(Modifier.align(Alignment.TopEnd).offset(1.dp, (-1).dp).size(6.dp).background(Brand.lime, CircleShape))
            }
        }
        HeaderButton("Menu", if (narrow) 34.dp else 38.dp, { onPanel(HeaderPanel.Menu) }) { GlyphIcon(Glyphs.menu, Brand.paper, 22.dp) }
    }
}

@Composable
private fun HeaderButton(label: String, width: Dp, onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(
        Modifier.size(width, 44.dp)
            .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label }
            .testTag("header-$label"),
        contentAlignment = Alignment.Center,
    ) { content() }
}

/**
 * The compass (pinr-live/src/ui/compass.ts), as the iPhone app draws it: a d-pad with the PINR blade at its heart, from
 * the site's 44-point pad. The arm toward the room you are in lights lime (a corner dot for an ad space, the hub for the
 * guide), and the blade turns its tip toward that room, the short way round. Tapping it pulls back to the whole map; on
 * the map the pad glows lime and a tap does nothing more (Back flies in again), as on the site.
 */
@Composable
fun Compass(room: Room, map: Boolean, onTap: () -> Unit) {
    // The needle's running angle (not screen state): each new room turns it the short way round, never the long way.
    val angle = remember { floatArrayOf(needle(room)) }
    val target = remember(room) {
        angle[0] += (needle(room) - angle[0] + 540f).mod(360f) - 180f
        angle[0]
    }
    val shown by animateFloatAsState(target, spring(dampingRatio = 0.6f, stiffness = Spring.StiffnessLow), label = "needle")
    fun fill(lit: Boolean): Color = if (map) Brand.lime.copy(alpha = 0.4f) else if (lit) Brand.lime else Brand.fg.copy(alpha = 0.16f)
    fun dot(lit: Boolean): Color = if (map) Brand.lime.copy(alpha = 0.4f) else if (lit) Brand.lime else Brand.fg.copy(alpha = 0.22f)

    Box(
        Modifier.size(52.dp, 48.dp)
            .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button) { if (!map) onTap() }
            .semantics { contentDescription = "See the whole site. You are in ${room.title}." }
            .testTag("compass"),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(44.dp)) {
            Arm(fill(room == Room.Arena), 15, 1.5f, 14, 15)
            Arm(fill(room == Room.Terminal), 15, 27.5f, 14, 15)
            Arm(fill(room == Room.Discover), 1.5f, 15, 15, 14)
            Arm(fill(room == Room.Wallet), 27.5f, 15, 15, 14)
            for ((r, at) in listOf(Room.AdNW to (7 to 7), Room.AdNE to (37 to 7), Room.AdSW to (7 to 37), Room.AdSE to (37 to 37))) {
                Box(Modifier.offset((at.first - 2).dp, (at.second - 2).dp).size(4.dp).background(dot(room == r), CircleShape))
            }
            val hubLit = room == Room.Pinr && !map
            Box(
                Modifier.offset(11.dp, 11.dp).size(22.dp)
                    .background(Brand.glass.copy(alpha = 0.95f), CircleShape)
                    .border(if (hubLit) 1.6.dp else 1.dp, if (hubLit) Brand.lime else Brand.fg.copy(alpha = 0.2f), CircleShape),
            )
            Image(
                painterResource(R.drawable.blade_large), null,
                Modifier.offset((22 - 1.8).dp, (22 - 15).dp).size(3.6.dp, 30.dp).rotate(shown),
            )
        }
    }
}

@Composable
private fun Arm(color: Color, x: Number, y: Number, w: Int, h: Int) {
    Box(Modifier.offset(x.toFloat().dp, y.toFloat().dp).size(w.dp, h.dp).background(color, RoundedCornerShape(4.5.dp)))
}

/**
 * Degrees clockwise from north of each room, seen from the centre (compass.ts BEARING); the art's tip points down, so it
 * turns 180 more; at the centre it rests upright.
 */
fun needle(r: Room): Float = when (r) {
    Room.Arena -> 180f
    Room.AdNE -> 225f
    Room.Wallet -> 270f
    Room.AdSE -> 315f
    Room.Terminal -> 360f
    Room.AdSW -> 405f
    Room.Discover -> 450f
    Room.AdNW -> 495f
    Room.Pinr -> 0f
}

/** The header's centre "PINR GUIDE" button (the PINR wordmark and its matching GUIDE wordmark): a tap offers the PINR guide or the Whitepaper. */
@Composable
fun GuideButton(onClick: () -> Unit, compact: Boolean = false) {
    val mark = if (compact) 10.5.dp else 13.dp
    Box(
        Modifier.size(if (compact) 82.dp else 104.dp, 48.dp).clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = "PINR guide" }.testTag("guide-button"),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier.height(40.dp).clip(RoundedCornerShape(50)).background(Brand.fg.copy(alpha = 0.07f)).border(1.dp, Brand.fg.copy(alpha = 0.14f), RoundedCornerShape(50)).padding(horizontal = if (compact) 7.dp else 10.dp),
            horizontalArrangement = Arrangement.spacedBy(if (compact) 4.dp else 5.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            Image(wordmarkPainter(), null, Modifier.height(mark))
            Image(painterResource(if (ThemeState.light) R.drawable.guide_wordmark_light else R.drawable.guide_wordmark), null, Modifier.height(mark))
        }
    }
}
