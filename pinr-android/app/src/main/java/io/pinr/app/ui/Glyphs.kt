package io.pinr.app.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.unit.Dp

/**
 * The site's own line icons (pinr-live/src/ui/header.ts and tabbar.ts), from their 24 by 24 paths: stroked 1.6 wide,
 * round ends, in the current colour. Circles are written as two arcs.
 */
object Glyphs {
    private fun circle(cx: Double, cy: Double, r: Double) = "M${cx - r},${cy}a$r,$r 0 1,0 ${2 * r},0a$r,$r 0 1,0 ${-2 * r},0"

    private fun glyph(name: String, vararg paths: String): ImageVector = glyphW(name, 1.6f, null, *paths)

    private fun glyphW(name: String, width: Float, fill: Color?, vararg paths: String): ImageVector =
        ImageVector.Builder(name, Dp(24f), Dp(24f), 24f, 24f).apply {
            paths.forEach { d ->
                addPath(
                    PathParser().parsePathString(d).toNodes(),
                    fill = fill?.let { SolidColor(it) },
                    stroke = SolidColor(Color.White), strokeLineWidth = width,
                    strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    /** The magnifying glass (tabbar.ts). */
    val discover = glyph("discover", circle(10.5, 10.5, 6.5), "M15.5 15.5L21 21")
    /** The pie chart (tabbar.ts). */
    val deepscan = glyph("deepscan", "M12 3a9 9 0 109 9h-9z", "M15 3.5a8.5 8.5 0 015.5 5.5H15z")
    val wallet = glyph(
        "wallet", "M4 7.5A2.5 2.5 0 016.5 5H17v3", "M4 7.5V17a2 2 0 002 2h13V8H6.5A2.5 2.5 0 014 7.5z", circle(16.0, 13.5, 1.1),
    )
    val back = glyph("back", "M19 12H5M11 6l-6 6 6 6")
    val sun = glyph("sun", circle(12.0, 12.0, 4.0), "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4")
    /** The whitepaper page's icon (whitepaper.ts): a sheet with its folded corner and two lines. */
    val whitepaper = glyph("whitepaper", "M7 3h7l4 4v14H7z", "M14 3v4h4M10 12h5M10 16h5")
    val moon = glyph("moon", "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z")
    val pipe = glyph(
        "pipe", circle(5.0, 6.0, 2.0), circle(12.0, 12.0, 2.0), circle(19.0, 18.0, 2.0),
        "M7 6h3.5A1.5 1.5 0 0112 7.5V10M12 14v2a2 2 0 002 2h3",
    )
    val diag = glyph("diag", "M3 12h4l2.2-6 4.2 12 2.2-6H21")
    val filter = glyph("filter", "M3.5 5h17l-6.4 7.6V19l-4.2-2v-4.4z")
    val menu = glyph("menu", "M4 7h16M4 12h16M4 17h16")
    /** The terminal's star and bell (ui/terminal.ts), stroked 1.8; filled when on. */
    private const val STAR = "m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9-4.3-4.1 5.9-.8z"
    private const val BELL = "M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4"
    val star = glyphW("star", 1.8f, null, STAR)
    val starOn = glyphW("star-on", 1.8f, Color.White, STAR)
    val bell = glyphW("bell", 1.8f, null, BELL)
    val bellOn = glyphW("bell-on", 1.8f, Color.White, BELL)
    /** The wallet page's shield with its check (ui/wallet.ts CHECK_ICON), and the eye-slash of Hide (hidemenu.ts). */
    val shield = glyphW("shield", 1.9f, null, "M12 3 5 6v5c0 4.4 2.9 8.3 7 10 4.1-1.7 7-5.6 7-10V6z", "m9 12 2.2 2.2L15.5 10")
    val eyeOff = glyphW("eye-off", 1.8f, null, "M3 12s3.5-6 9-6c1.7 0 3.2.5 4.5 1.3M21 12s-3.5 6-9 6c-1.7 0-3.2-.5-4.5-1.3M10 10.3a2.5 2.5 0 0 0 3.7 3.4M4 4l16 16")
    /** The menu's own symbols (header.ts MENU_ITEMS). */
    val pinrGrid = glyph("grid", "M5.8,4h2.8a1.8,1.8 0 0 1 1.8,1.8v2.8a1.8,1.8 0 0 1-1.8,1.8H5.8a1.8,1.8 0 0 1-1.8-1.8V5.8A1.8,1.8 0 0 1 5.8,4z",
        "M15.4,4h2.8a1.8,1.8 0 0 1 1.8,1.8v2.8a1.8,1.8 0 0 1-1.8,1.8h-2.8a1.8,1.8 0 0 1-1.8-1.8V5.8A1.8,1.8 0 0 1 15.4,4z",
        "M5.8,13.6h2.8a1.8,1.8 0 0 1 1.8,1.8v2.8a1.8,1.8 0 0 1-1.8,1.8H5.8a1.8,1.8 0 0 1-1.8-1.8v-2.8a1.8,1.8 0 0 1 1.8-1.8z",
        "M15.4,13.6h2.8a1.8,1.8 0 0 1 1.8,1.8v2.8a1.8,1.8 0 0 1-1.8,1.8h-2.8a1.8,1.8 0 0 1-1.8-1.8v-2.8a1.8,1.8 0 0 1 1.8-1.8z")
    val guideArrow = glyph("guide", "M5 19L19 5M14 5h5v5")
    /** The drawing rail (terminalbase.ts ICON_PEN, ICON_MAGNET, ICON_UNDO, ICON_REDO, ICON_TRASH). */
    val pen = glyph("pen", "M4 20h4L19 9l-4-4L4 16z", "m13 7 4 4")
    val magnet = glyph("magnet", "M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z", "M6 8h4M14 8h4")
    val undo = glyph("undo", "M9 7 4 12l5 5", "M4 7h10a5 5 0 0 1 0 10h-3")
    val redo = glyph("redo", "m15 7 5 5-5 5", "M20 7H10a5 5 0 0 0 0 10h3")
    val trash = glyph("trash", "M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12")
    /** Settings' back chevron (settings.ts). */
    val chevronBack = glyph("chevron", "M15 5l-7 7 7 7")
    val siteMap = glyph("map", "M6.5,3.5h11a3,3 0 0 1 3,3v11a3,3 0 0 1-3,3h-11a3,3 0 0 1-3-3v-11a3,3 0 0 1 3-3z", "M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17")
    /** The search pill's lens (ui/discover.ts). */
    val search = glyph("search", circle(10.5, 10.5, 6.5), "M15.5 15.5L21 21")
}

@Composable
fun GlyphIcon(v: ImageVector, tint: Color, size: Dp, modifier: Modifier = Modifier) {
    Image(rememberVectorPainter(v), null, modifier.size(size), colorFilter = ColorFilter.tint(tint))
}
