package io.pinr.app.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Dp
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.pinr.app.feed.FeedData
import io.pinr.app.feed.Format
import io.pinr.app.feed.FeedState
import io.pinr.app.feed.PinrFilter
import io.pinr.app.feed.Ranking
import io.pinr.app.feed.Token
import kotlin.math.floor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The PINR page (north on the site's map): the top of the chosen filter's ranking as tiles, 4 across on a phone, over
 * the live background. As on the site and the iPhone app, the ranking is a snapshot taken when a filter is chosen (and
 * once the whole scored set has been read); each tile's own figures stay live.
 */
@Composable
fun PinrRoom(feed: FeedData, filter: PinrFilter, contentPadding: PaddingValues, onOpen: (Token) -> Unit) {
    var order by remember { mutableStateOf<List<String>>(emptyList()) }
    var lastKnown by remember { mutableStateOf<Map<String, Token>>(emptyMap()) }
    var rankedWholeSet by remember { mutableStateOf(false) }
    val wholeSetRead = feed.restTotal?.let { feed.restLoaded >= it } ?: false

    // The effects below run later than the frame that started them: they rank the feed as it is then, not as it was,
    // and away from the screen's thread (the whole scored set is thousands of coins).
    val current by rememberUpdatedState(feed)
    val choices = LocalChoices.current
    var menuFor by remember { mutableStateOf<Token?>(null) }
    suspend fun rerank() {
        val f = current
        // Hidden coins leave the page; kept on this phone only.
        val visible = (choices?.visible(f.all) ?: f.all).filter { it.hasSomethingToShow }
        val ranked = withContext(Dispatchers.Default) { Ranking.rankFeatured(filter, visible, f.moved) }
        order = ranked.map { it.id }
        lastKnown = ranked.associateBy { it.id }
    }
    LaunchedEffect(filter) { rerank() }
    LaunchedEffect(feed.all.isEmpty()) { if (order.isEmpty()) rerank() }
    // the design's purpose is to watch coins arrive: take the ranking again when the feed has changed since the last one.
    LaunchedEffect(filter) {
        var ranked: Long? = null
        while (true) {
            kotlinx.coroutines.delay(10_000)
            val heard = current.lastHeardMs
            if (heard != null && heard != ranked) { ranked = heard; rerank() }
        }
    }
    // Hiding a coin, or showing them again, re-ranks at once.
    LaunchedEffect(choices?.hidden) { if (order.isNotEmpty()) rerank() }
    LaunchedEffect(wholeSetRead) { if (wholeSetRead && !rankedWholeSet) { rankedWholeSet = true; rerank() } }

    // One clock for every ribbon on the page, read only while drawing.
    var seconds by remember { mutableDoubleStateOf(0.0) }
    LaunchedEffect(Unit) { while (true) withFrameMillis { seconds = it / 1000.0 } }
    val time = remember { { seconds } }

    val tiles = remember(order, feed.byId) { order.mapNotNull { feed.byId[it] ?: lastKnown[it] } }

    val mapScale = LocalMapScale.current
    menuFor?.let { t -> HideMenu(t, onHide = { choices?.hide(t) }, onClose = { menuFor = null }) }
    when {
        mapScale < 1f && tiles.isNotEmpty() -> PinrMapRoom(tiles, mapScale, contentPadding)
        feed.state is FeedState.Mismatch -> Notice("The feed speaks a different data contract than this app. Results are not shown until the two agree.", contentPadding)
        tiles.isEmpty() && feed.all.isEmpty() -> Box(Modifier.fillMaxSize().padding(contentPadding), contentAlignment = Alignment.TopCenter) {
            if (feed.state is FeedState.Offline) Notice("Offline · ${(feed.state as FeedState.Offline).reason}", PaddingValues()) else Spinner(Modifier.padding(top = 120.dp))
        }
        tiles.isEmpty() -> Notice(emptyText(filter), contentPadding)
        else -> BoxWithConstraints(Modifier.fillMaxSize()) {
            val perRow = if (maxWidth > maxHeight) 8 else 4 // turned to landscape, twice as many across
            val gap = 10.dp
            val w = floor((maxWidth.value - 20 - gap.value * (perRow - 1)) / perRow).dp
            LazyVerticalGrid(
                columns = GridCells.Fixed(perRow),
                modifier = Modifier.fillMaxSize().testTag("pinr-grid"),
                contentPadding = PaddingValues(
                    start = 10.dp, end = 10.dp,
                    top = contentPadding.calculateTopPadding(), bottom = contentPadding.calculateBottomPadding(),
                ),
                horizontalArrangement = Arrangement.spacedBy(gap),
                verticalArrangement = Arrangement.spacedBy(gap + 2.dp),
            ) {
                items(tiles, key = { it.id }) { t ->
                    // As on the site, a tile opens its coin in PINRterminal + DeepScan.
                    // A press and hold opens the site's one-button menu: "Hide this coin".
                    TileView(t, w, time, Modifier.combinedClickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, onLongClick = { menuFor = t }) { onOpen(t) })
                }
            }
        }
    }
}

/** The site's hide menu (hidemenu.ts): the coin's name and one action, "Hide this coin". */
@Composable
fun HideMenu(t: Token, onHide: () -> Unit, onClose: () -> Unit) {
    androidx.compose.ui.window.Dialog(onDismissRequest = onClose) {
        androidx.compose.foundation.layout.Column(Modifier.background(Brand.panel, androidx.compose.foundation.shape.RoundedCornerShape(16.dp)).padding(14.dp)) {
            BasicText(Format.title(t), Modifier.padding(bottom = 8.dp), style = TextStyle(color = Brand.mute, fontSize = 12.sp))
            androidx.compose.foundation.layout.Row(
                Modifier.clickable { onHide(); onClose() }.padding(vertical = 6.dp).testTag("hide-this-coin"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                GlyphIcon(Glyphs.eyeOff, Brand.paper, 18.dp)
                androidx.compose.foundation.layout.Spacer(Modifier.size(10.dp))
                BasicText("Hide this coin", style = TextStyle(color = Brand.paper, fontSize = 15.sp))
            }
        }
    }
}

private fun emptyText(f: PinrFilter): String = when (f) {
    PinrFilter.New -> "No coins under an hour old right now."
    PinrFilter.Movers -> "No score has moved since the app opened."
    PinrFilter.PinrScore -> "No scored coins yet."
    PinrFilter.Trending -> "Nothing to show yet."
}

@Composable
fun Notice(text: String, padding: PaddingValues) {
    Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
        BasicText(
            text, Modifier.padding(top = 60.dp, start = 24.dp, end = 24.dp).fillMaxWidth().testTag("notice"),
            style = TextStyle(color = Brand.paper.copy(alpha = 0.75f), fontSize = 13.sp, textAlign = TextAlign.Center),
        )
    }
}

/** A small lime arc turning, while the first tokens load. */
@Composable
fun Spinner(modifier: Modifier = Modifier) {
    val turn by rememberInfiniteTransition(label = "spin").animateFloat(0f, 360f, infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart), label = "turn")
    Canvas(modifier.size(22.dp)) {
        drawArc(Brand.lime, turn, 270f, false, Offset.Zero, Size(size.width, size.height), style = Stroke(2.dp.toPx(), cap = StrokeCap.Round))
    }
}

/**
 * The PINR room as the whole map shows it: the site re-lays its tiles out at the camera's zoom (cards.ts `lodFor`,
 * `LABEL_PX`), so a tile stays readable: 4 across and 5 down, the name about 9.3 points on screen, the score large, then
 * coverage, market cap and all-time high, dropped from the bottom when they do not fit.
 */
@Composable
fun PinrMapRoom(tiles: List<Token>, scale: Float, insets: PaddingValues) {
    // On the map the room has no header or footer over it: its tiles fill the room, as on the site's map.
    BoxWithConstraints(Modifier.fillMaxSize().padding(16.dp)) {
        val gap = 10.dp
        val w = (maxWidth - gap * 3) / 4
        val h = (maxHeight - gap * 4) / 5
        val u = 1f / scale // one point on screen, in the room's own units
        Column(verticalArrangement = Arrangement.spacedBy(gap)) {
            tiles.take(20).chunked(4).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                    row.forEach { MapTile(it, w, h, u) }
                }
            }
        }
    }
}

@Composable
private fun MapTile(t: Token, w: Dp, h: Dp, u: Float) = FixedTextSize { MapTileBody(t, w, h, u) }

@Composable
private fun MapTileBody(t: Token, w: Dp, h: Dp, u: Float) {
    val c = Format.corner(t)
    val label = 9.3f * u // the site's LABEL_PX on screen
    val small = 5.6f * u
    val pad = 2.5f * u
    val pic = 7f * u
    val score = 12f * u
    // What fits, by priority from the top: name and score always; then coverage, market cap, all-time high.
    val base = pad * 2 + pic + label * 1.3f + score * 1.25f
    val line = small * 1.3f
    val avail = h.value
    val figs = when {
        avail >= base + line * 3 -> 2
        avail >= base + line * 2 -> 1
        else -> 0
    }
    val cov = avail >= base + line
    Column(Modifier.size(w, h).glass((14 * u).coerceAtMost(28f).dp).padding(pad.dp)) {
        TokenPicture(t, pic.dp)
        BasicText(
            Format.title(t), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = (1.5f * u).dp),
            style = TextStyle(color = Brand.paper, fontSize = label.sp, fontWeight = FontWeight.SemiBold),
        )
        if (figs >= 1 && t.label == null) MapFig("MC", Format.money(t.valuationUsd), small)
        if (figs >= 2 && t.label == null) MapFig("ATH", Format.money(t.athUsd), small)
        Spacer(Modifier.weight(1f))
        Row(verticalAlignment = Alignment.Bottom) {
            ScoreText(t, score.sp)
            Spacer(Modifier.weight(1f))
            if (cov) BasicText(c.coverage, style = TextStyle(color = Brand.paper.copy(alpha = 0.85f), fontSize = small.sp, fontFamily = FontFamily.Monospace), maxLines = 1)
        }
    }
}

@Composable
private fun MapFig(k: String, v: String, size: Float) {
    BasicText("$k $v", maxLines = 1, overflow = TextOverflow.Clip, style = TextStyle(color = Brand.mute, fontSize = size.sp, fontFamily = FontFamily.Monospace))
}
