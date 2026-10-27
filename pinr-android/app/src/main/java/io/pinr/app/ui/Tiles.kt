package io.pinr.app.ui

import io.pinr.app.feed.jsTrim
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.pinr.app.feed.Format
import io.pinr.app.feed.NameFilter
import io.pinr.app.feed.NoScoreLabel
import io.pinr.app.feed.Ranking
import io.pinr.app.feed.Ribbon
import io.pinr.app.feed.Token
import io.pinr.app.feed.TransferFee
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints

/** "Not investment advice" beside a score, as on the site (ui/scorenotice.ts), only on tiles wide enough to carry it. */
object Advice {
    const val LINE = "Not investment advice"
    /** The site shows it on tiles from 145 px wide. */
    val minTileWidth = 145.dp
    fun shows(t: Token): Boolean = Format.corner(t).numeric
}


/**
 * One PINR tile in the site's look (cards.ts and style.css `.card`), as the iPhone app's TileView: black glass with a
 * bright rim; the picture wearing its pair and launchpad badge; the name, cut with an ellipsis; the $ticker in small
 * mono; MC and ATH; the ribbon; then the score at the bottom left on the mandarin-to-lime scale and the coverage at the
 * bottom right. the design's list exactly; no "Early" word. A flagged coin shows its label and no figures.
 */
@Composable
fun TileView(token: Token, width: Dp, time: () -> Double, modifier: Modifier = Modifier) = FixedTextSize { TileBody(token, width, time, modifier) }

@Composable
private fun TileBody(token: Token, width: Dp, time: () -> Double, modifier: Modifier) {
    val k = maxOf(0.8f, width.value / 86f)
    Column(
        modifier.size(width, width * 1.52f).glass((14 * k).dp)
            .padding(horizontal = (6 * k).dp, vertical = (7 * k).dp)
            .clearAndSetSemantics { contentDescription = spoken(token) }
            .testTag("tile-${token.id}"),
    ) {
        TokenPicture(token, (26 * k).dp)
        Column(Modifier.padding(top = (4 * k).dp), verticalArrangement = Arrangement.spacedBy((2 * k).dp)) {
            BasicText(Format.title(token), style = sans((10 * k).sp, Brand.paper, FontWeight.SemiBold).copy(letterSpacing = (-0.012).em), maxLines = 1, overflow = TextOverflow.Ellipsis)
            BasicText(Format.ticker(token), style = mono((6.5 * k).sp, Brand.mute), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        // The facts take the room between the name and the ribbon; a short tile drops rows from the end.
        TileFacts(token, k, Modifier.weight(1f).fillMaxWidth().padding(top = (6 * k).dp))
        RibbonView(Ribbon.of(token.flow), (2.2 * k).dp, time, tileHeight = (width.value * 1.52f).dp, modifier = Modifier.padding(top = (2 * k).dp).fillMaxWidth().height((12 * k).dp))
        Row(verticalAlignment = Alignment.Bottom) {
            ScoreText(token, (21 * k).sp)
            Spacer(Modifier.weight(1f))
            CoverageStack(token, (7.5 * k).sp, advice = width >= Advice.minTileWidth)
        }
    }
}

/**
 * What a tile carries besides its picture, name, score and ribbon (cards.ts writeFacts): the market cap, the all-time high, and the
 * transfer fee when the coin has one. A fee outside the rewards norm takes the top line, so a short tile drops ATH then MC first; a
 * rewards fee at its standard comes last, so it is the first line a short tile drops. A flagged coin shows none of them.
 */
@Composable
private fun TileFacts(token: Token, k: Float, modifier: Modifier) {
    if (token.label != null) { Spacer(modifier); return }
    val fee = token.transferFee?.short()
    val first = fee != null && token.transferFee?.kind == TransferFee.Kind.OutsideNorm
    val rows = buildList<Pair<String, String>> {
        if (first) add("Fee" to fee!!)
        add("MC" to Format.tilePlusTrades(Format.money(token.valuationUsd), token.flow, token.hourTrades))
        add("ATH" to Format.money(token.athUsd))
        if (fee != null && !first) add("Fee" to fee)
    }
    val gap = (2 * k).dp
    // Rows that do not fit the room left are not placed: the last ones go first.
    Layout(content = { rows.forEach { (l, v) -> FactRow(l, v, (7.5 * k).sp, fit = l == "Fee" || l == "MC") } }, modifier = modifier) { measurables, c ->
        val g = gap.roundToPx()
        var y = 0
        val placed = mutableListOf<Pair<androidx.compose.ui.layout.Placeable, Int>>()
        for (m in measurables) {
            val p = m.measure(c.copy(minWidth = 0, minHeight = 0, maxHeight = Constraints.Infinity))
            val top = if (placed.isEmpty()) 0 else y + g
            if (top + p.height > c.maxHeight) break
            placed += p to top
            y = top + p.height
        }
        layout(c.maxWidth, c.maxHeight) { placed.forEach { (p, top) -> p.placeRelative(0, top) } }
    }
}

private fun spoken(t: Token): String {
    val parts = mutableListOf(Format.title(t), Format.ticker(t))
    when {
        t.label != null -> parts += "labelled ${t.label.text}, no score"
        Format.corner(t).numeric -> parts += "PINRscore ${t.score}, coverage ${Format.coverage(t.coverage)}"
        else -> parts += if (t.coverage > 0) "no score" else "unscored"
    }
    if (t.label == null) {
        parts += "market cap ${Format.money(t.valuationUsd)}"
        t.athUsd?.let { parts += "all-time high ${Format.money(it)}" }
        t.transferFee?.short()?.let { parts += "fee $it" }
    }
    return parts.joinToString(", ")
}

/**
 * The coin's picture (a circle; a soft disc with its initial until it has one), wearing the dark badge pill with its
 * pair and launchpad marks at the lower right, as on the site (`.pbadge`). A copy (VAMP) shows neither its picture nor
 * marks; a masked name shows no picture (moderation.ts applyMask).
 */
@Composable
fun TokenPicture(token: Token, size: Dp, marks: Boolean = true) {
    Box(Modifier.size(size)) {
        Box(
            Modifier.size(size).clip(CircleShape)
                .background(Brush.radialGradient(listOf(Brand.fg.copy(alpha = 0.22f), Brand.fg.copy(alpha = 0.06f))))
                .border(1.dp, Brand.fg.copy(alpha = 0.18f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            BasicText(Format.title(token).take(1).uppercase(), style = sans((size.value * 0.46f).sp, Brand.mute, FontWeight.SemiBold))
            if (token.label != NoScoreLabel.Vamp && !NameFilter.masks(token)) FeedImage(token.imageUrl, Modifier.fillMaxSize())
        }
        // The pair and launchpad badge; the site leaves it off where a picture stands alone (Similar tokens).
        val marks = if (!marks || token.label == NoScoreLabel.Vamp) emptyList() else listOfNotNull(Mark.pair(token), Mark.pad(token))
        if (marks.isNotEmpty()) {
            Row(
                Modifier.wrapContentSize(unbounded = true).offset(size * 0.6f, size * 0.62f)
                    .background(Color(0xEB080A10), RoundedCornerShape(50))
                    .border(1.dp, Color.White.copy(alpha = 0.16f), RoundedCornerShape(50))
                    .padding(horizontal = size * 0.06f, vertical = size * 0.04f),
                horizontalArrangement = Arrangement.spacedBy(size * 0.04f),
            ) {
                marks.forEach { MarkView(it, Modifier.size(size * 0.4f)) }
            }
        }
    }
}

/**
 * The score place, as the site's (cards.ts, model.ts `statusLook`): the number on the mandarin-to-lime scale; a label
 * (never with a number) in mandarin and smaller; a dash in mute when nothing was read or there is no number.
 */
@Composable
fun ScoreText(token: Token, size: TextUnit) {
    val c = Format.corner(token)
    when {
        c.flagged -> BasicText(
            c.score, style = sans(size * 0.42f, Brand.mandarin, FontWeight.Bold), maxLines = 1,
            autoSize = TextAutoSize.StepBased(minFontSize = size * 0.25f, maxFontSize = size * 0.42f),
        )
        c.numeric -> {
            val n = c.score.toInt()
            BasicText(n.toString(), style = sans(size, Brand.score(n), FontWeight.SemiBold).copy(letterSpacing = (-0.04).em, fontFeatureSettings = "tnum"))
        }
        else -> BasicText(c.score, Modifier.testTag("score-dash"), style = sans(size, Brand.mute, FontWeight.SemiBold))
    }
}

/** The coverage as on the site: the figure (a dash at 0) over its word ("coverage", "unscored", or "no data" under a label). */
@Composable
fun CoverageStack(token: Token, size: TextUnit, advice: Boolean = false) {
    val c = Format.corner(token)
    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(1.5.dp)) {
        BasicText(c.coverage, style = mono(size, Brand.paper.copy(alpha = 0.85f), FontWeight.Medium), maxLines = 1)
        BasicText(c.word, style = mono(size * 0.74f, Brand.mute), maxLines = 1)
        if (advice && c.numeric) BasicText(Advice.LINE, style = sans(size * 0.78f, Brand.mute, FontWeight.Medium), maxLines = 1)
    }
}

/** "MC $32.30M": the label in mute, the figure in the text colour, both mono, as the site's `.frow`. */
@Composable
fun FactRow(label: String, value: String, size: TextUnit, fit: Boolean = false) {
    Row(horizontalArrangement = Arrangement.spacedBy((size.value * 0.6f).dp), verticalAlignment = Alignment.Bottom) {
        BasicText(label, style = mono(size, Brand.mute), maxLines = 1)
        // The fee's words ("12.5% not rewards") are longer than a figure: set smaller to fit the tile, never cut.
        if (fit) BasicText(
            value, Modifier.weight(1f, fill = false), style = mono(size * 1.12f, Brand.paper, FontWeight.Medium), maxLines = 1,
            autoSize = TextAutoSize.StepBased(minFontSize = size * 0.6f, maxFontSize = size * 1.12f, stepSize = 0.25.sp),
        )
        else BasicText(value, style = mono(size * 1.12f, Brand.paper, FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Clip)
    }
}

/**
 * The ribbon in the site's look (flow.ts, streams.ts): short trade streaks, lime for buys and mandarin for sells,
 * riding toward "now" at the right; a trade's size is its height, never its thickness. [time] is
 * read only while drawing, so a moving ribbon redraws without rebuilding the tile. Nothing when no trades in the hour.
 */
@Composable
fun RibbonView(ribbon: Ribbon?, dash: Dp, time: () -> Double, modifier: Modifier = Modifier, tileHeight: Dp = 130.dp) {
    // Settings › Display › Moving streams off: no streaks, as on the site.
    if (ribbon == null || LocalChoices.current?.streams == false) { Spacer(modifier); return }
    Canvas(modifier) {
        val t = time()
        val d = dash.toPx()
        val mid = size.height / 2
        for (i in 0 until Ribbon.STREAKS) {
            val (u, buy) = ribbon.streak(i, t)
            val (y, big) = Ribbon.lane(i)
            val w = d * (0.5f + 0.9f * big.toFloat())
            val h = d * 0.55f
            // a trade's SIZE is its HEIGHT: a buy rides above the line and a sell below it, up to 17% of the tile's height,
            // swooping a further 60% in the last 18% of the ribbon; real trades are drawn solid, a mix counted in trades is faint and near the line.
            val sz = if (ribbon.isCount) big * 0.25 else big
            val top = mid + (Ribbon.sizeOffset(sz, buy, u) * tileHeight.toPx()).toFloat() + ((y - 0.5) * d * 1.2).toFloat() - h / 2
            drawRoundRect(
                (if (buy) Brand.lime else Brand.mandarin).copy(alpha = if (ribbon.isCount) 0.35f else 0.95f),
                topLeft = Offset((u * (size.width + w) - w).toFloat(), top),
                size = Size(w, h), cornerRadius = CornerRadius(h / 2),
            )
        }
    }
}

/** The pair and launchpad marks on a coin's picture (world/marks.ts), drawn from the site's shapes as the iPhone app does. */
enum class Mark {
    Sol, Eth, Bnb, Usdt, Usdc, Pump, Stonk, LaunchLab, Clanker, Bankr, Flap, FourMeme;

    companion object {
        /** The coin a pair trades against (the site's `pairOf`); another coin is not drawn. */
        fun pair(t: Token): Mark? {
            t.quotePair?.let { qp ->
                when (qp.substringAfterLast('/').jsTrim().uppercase()) {
                    "SOL", "WSOL" -> return Sol
                    "ETH", "WETH" -> return Eth
                    "BNB", "WBNB" -> return Bnb
                    "USDT" -> return Usdt
                    "USDC" -> return Usdc
                    "" -> {}
                    else -> return null
                }
            }
            return when (t.chain?.lowercase()) {
                "solana" -> Sol
                "base", "ethereum" -> Eth
                "bsc", "bnb" -> Bnb
                else -> null
            }
        }

        /** The launchpad's mark (the site's `padOf`). */
        fun pad(t: Token): Mark? {
            val l = t.launchpad?.lowercase() ?: return null
            return when {
                "pump" in l -> Pump
                "stonk" in l -> Stonk // Stonk.fun, on Raydium LaunchLab
                "launchlab" in l -> LaunchLab // Raydium LaunchLab, platform not read yet
                "clanker" in l -> Clanker
                "bankr" in l -> Bankr
                "flap" in l -> Flap
                "four" in l -> FourMeme
                else -> null
            }
        }
    }
}

/** One mark, drawn in a 24 by 24 box. */
@Composable
fun MarkView(mark: Mark, modifier: Modifier) {
    val measurer = rememberTextMeasurer()
    Canvas(modifier) {
        val k = size.width / 24f
        fun poly(c: Color, vararg pts: Pair<Float, Float>) {
            val p = Path().apply {
                moveTo(pts[0].first * k, pts[0].second * k)
                pts.drop(1).forEach { lineTo(it.first * k, it.second * k) }
                close()
            }
            drawPath(p, c)
        }
        fun disc(c: Color, letter: String, ink: Color = Color.White) {
            drawCircle(c, 11f * k, Offset(12f * k, 12f * k))
            val text = measurer.measure(letter, TextStyle(color = ink, fontSize = (13f * k).toSp(), fontWeight = FontWeight.Bold))
            drawText(text, topLeft = Offset(12f * k - text.size.width / 2f, 12.4f * k - text.size.height / 2f))
        }
        when (mark) {
            Mark.Sol -> {
                poly(Color(0xFF19F0A0), 7f to 5.6f, 20.5f to 5.6f, 17.5f to 8.8f, 4f to 8.8f)
                poly(Color(0xFF6F8DF5), 4f to 10.4f, 17.5f to 10.4f, 20.5f to 13.6f, 7f to 13.6f)
                poly(Color(0xFF9945FF), 7f to 15.2f, 20.5f to 15.2f, 17.5f to 18.4f, 4f to 18.4f)
            }
            Mark.Eth -> {
                poly(Color(0xFF9AA4D0), 12f to 2f, 18f to 12f, 12f to 15.6f, 6f to 12f)
                poly(Color(0xFFC3C9E8), 12f to 17f, 18f to 13.2f, 12f to 22f, 6f to 13.2f)
            }
            Mark.Bnb -> for ((cx, cy) in listOf(12f to 5.9f, 6.2f to 11.7f, 17.8f to 11.7f, 12f to 17.5f, 12f to 11.7f)) {
                poly(Color(0xFFF3BA2F), cx to cy - 2.5f, cx + 2.5f to cy, cx to cy + 2.5f, cx - 2.5f to cy)
            }
            Mark.Pump -> pill(k)
            Mark.Stonk -> disc(Color(0xFF22C55E), "S")
            Mark.LaunchLab -> disc(Color(0xFF5A4FCF), "L")
            Mark.Usdt -> disc(Color(0xFF26A17B), "T")
            Mark.Usdc -> disc(Color(0xFF2775CA), "$")
            Mark.Clanker -> disc(Color(0xFF6A4CFF), "C")
            Mark.Bankr -> disc(Color(0xFF1D1D1F), "B")
            Mark.Flap -> disc(Color(0xFFEF7D2D), "F")
            Mark.FourMeme -> disc(Color(0xFFF3BA2F), "4", Color(0xFF1D1D1F))
        }
    }
}

/** Pump.fun's pill: green and white halves, turned 45 degrees, with a dark rim. */
private fun DrawScope.pill(k: Float) {
    rotate(-45f, Offset(12f * k, 12f * k)) {
        val r = CornerRadius(4.5f * k)
        drawRoundRect(Color(0xFF5FD9A0), Offset(4.5f * k, 7.5f * k), Size(7.5f * k, 9f * k), r)
        drawRect(Color(0xFF5FD9A0), Offset(9f * k, 7.5f * k), Size(3f * k, 9f * k))
        drawRoundRect(Color.White, Offset(12f * k, 7.5f * k), Size(7.5f * k, 9f * k), r)
        drawRect(Color.White, Offset(12f * k, 7.5f * k), Size(3f * k, 9f * k))
        drawRoundRect(Color(0xFF1D3D30), Offset(4.5f * k, 7.5f * k), Size(15f * k, 9f * k), r, style = Stroke(1.2f * k))
    }
}
