package io.pinr.app.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/**
 * A corner of the map: four labelled placeholder slots, as on the site (ui/pages.ts) and the iPhone app (AdRoom).
 * PINR's own placeholders, never a real brand or project name: "Ad space A1" to "D4" (A north-west,
 * B north-east, C south-west, D south-east), slots 1 and 4 wide. Nothing here is a real placement.
 */
object AdAreas {
    private val letters = mapOf(Room.AdNW to "A", Room.AdNE to "B", Room.AdSW to "C", Room.AdSE to "D")

    fun slots(r: Room): List<Pair<String, String>> = letters[r]?.let { l ->
        (1..4).map { i -> "Ad space $l$i" to if (i == 1 || i == 4) "Wide placeholder" else "Square placeholder" }
    } ?: emptyList()

    /** The site's own gradients (AD_GRADIENTS), handed out in turn so neighbouring slots look different. */
    val gradients: List<List<Long>> = listOf(
        listOf(0xFF9B6BFF, 0xFF5EC6C0, 0xFF7DFFB4), listOf(0xFF4AA8FF, 0xFF8F7BFF, 0xFFD6FF3C), listOf(0xFFFF8C1A, 0xFFFF5E8A, 0xFFB86BFF),
        listOf(0xFFD6FF3C, 0xFF5EE0A0, 0xFF4AA8FF), listOf(0xFFFF5E8A, 0xFFFF8C1A, 0xFFFFD23C), listOf(0xFF5EC6C0, 0xFF4AA8FF, 0xFF9B6BFF),
    )

    fun offset(r: Room): Int = listOf(Room.AdNW, Room.AdNE, Room.AdSW, Room.AdSE).indexOf(r).coerceAtLeast(0) * 2
}

@Composable
fun AdRoom(r: Room, insets: PaddingValues) {
    BoxWithConstraints(Modifier.fillMaxSize().padding(insets)) {
        // The site lays a room out about 340 wide and scales it to the screen, so the slots are drawn at its sizes times that.
        val k = (minOf(maxWidth.value / 340f, maxHeight.value / 560f)).coerceIn(0.6f, 1.4f)
        val slots = AdAreas.slots(r)
        val o = AdAreas.offset(r)
        Column(
            Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("ads-${r.name}"),
            verticalArrangement = Arrangement.spacedBy((12 * k).dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            BasicText(
                "ADVERTISEMENT · PLACEHOLDER",
                style = TextStyle(color = Brand.mute, fontSize = (10 * k).sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium, letterSpacing = 0.18.em),
            )
            Slot(slots[0], AdAreas.gradients[o % 6], wide = true, k = k)
            Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy((12 * k).dp)) {
                Slot(slots[1], AdAreas.gradients[(o + 1) % 6], wide = false, k = k)
                Slot(slots[2], AdAreas.gradients[(o + 2) % 6], wide = false, k = k)
            }
            Slot(slots[3], AdAreas.gradients[(o + 3) % 6], wide = true, k = k)
        }
    }
}

@Composable
private fun ColumnScope.Slot(s: Pair<String, String>, g: List<Long>, wide: Boolean, k: Float) =
    SlotBox(Modifier.weight(1f).fillMaxWidth(), s, g, wide, k)

@Composable
private fun RowScope.Slot(s: Pair<String, String>, g: List<Long>, wide: Boolean, k: Float) =
    SlotBox(Modifier.weight(1f).fillMaxSize(), s, g, wide, k)

@Composable
private fun SlotBox(modifier: Modifier, s: Pair<String, String>, g: List<Long>, wide: Boolean, k: Float) {
    val radius: Dp = (20 * k).dp
    Box(
        modifier.drawBehind {
            drawRoundRect(
                Brand.fg.copy(alpha = 0.2f), cornerRadius = CornerRadius(radius.toPx()),
                style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 4.dp.toPx()))),
            )
        }.padding(10.dp),
    ) {
        Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy((10 * k).dp)) {
            val size = ((if (wide) 34 else 19) * k).sp
            BasicText(
                s.first, maxLines = 1,
                style = TextStyle(brush = Brush.linearGradient(g.map { Color(it) }), fontSize = size, fontWeight = FontWeight.Bold, letterSpacing = (if (wide) -0.035 else -0.03).em),
                autoSize = TextAutoSize.StepBased(minFontSize = size * 0.6f, maxFontSize = size),
            )
            // Inside the slot with room to spare: a square slot's label wraps onto two lines, as on the site.
            BasicText(
                s.second.uppercase(),
                Modifier.fillMaxWidth(if (wide) 1f else 0.72f),
                style = TextStyle(color = Brand.mute, fontSize = (10 * k).sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium, letterSpacing = 0.1.em, textAlign = TextAlign.Center),
            )
        }
        BasicText(
            "AD",
            Modifier.align(Alignment.TopEnd).padding(top = (9 * k).dp, end = (11 * k).dp)
                .border(1.dp, Brand.fg.copy(alpha = 0.18f), RoundedCornerShape((5 * k).dp))
                .padding(horizontal = (5 * k).dp, vertical = (3 * k).dp),
            style = TextStyle(color = Brand.mute, fontSize = (8 * k).sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, letterSpacing = 0.14.em),
        )
    }
}
