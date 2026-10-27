package io.pinr.app.ui

import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.draw.clip
import io.pinr.app.feed.jsTrim
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.collectAsState
import io.pinr.app.feed.CandleSet
import io.pinr.app.feed.ChartEvent
import io.pinr.app.feed.CoinClient
import io.pinr.app.feed.Dossier
import io.pinr.app.feed.Format
import io.pinr.app.feed.Metric
import io.pinr.app.feed.NoScoreLabel
import io.pinr.app.feed.Timeframe
import io.pinr.app.feed.Token
import kotlinx.coroutines.launch

/**
 * The PINRterminal + DeepScan room for one coin, in the site's look at phone width (ui/terminal.ts and ui/deepscan.ts,
 * one page since a design decision), as the iPhone app draws it: the token bar, the timeframes, the candle chart with its
 * price axis and last-price tag, volume, the PINR Index line pane, then "DeepScan ↓" and the dossier below it. Every figure
 * is a measured reading or a dash.
 */
@Composable
fun CoinPage(token: Token, all: List<Token>, client: CoinClient, watch: WatchStore, insets: PaddingValues, onOpen: (Token) -> Unit, onHide: (Token) -> Unit = {}) {
    val scroll = rememberScrollState()
    val scope = rememberCoroutineScope()
    var deepY by remember { mutableFloatStateOf(0f) }
    var dossier by remember(token.id) { mutableStateOf<Dossier?>(null) }
    var dossierFailed by remember(token.id) { mutableStateOf(false) }
    var hub by remember(token.id) { mutableStateOf<io.pinr.app.feed.EvidenceHub?>(null) }
    var hubLoaded by remember(token.id) { mutableStateOf(false) }
    var tvSymbol by remember(token.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(token.id) { tvSymbol = client.tvSymbol(token.address) }
    LaunchedEffect(token.id) {
        try { hub = client.evidence(token.address) } catch (e: CoinClient.Failure) { }
        hubLoaded = true
    }
    LaunchedEffect(token.id) {
        scroll.scrollTo(0)
        try { dossier = client.dossier(token.address); dossierFailed = false } catch (e: CoinClient.Failure) { dossierFailed = dossier == null }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(scroll).padding(horizontal = 10.dp)
            .padding(top = insets.calculateTopPadding(), bottom = insets.calculateBottomPadding()).testTag("coin-page"),
    ) {
        // The token bar reads the chart's candles, as the site's: the last close and the move over the last 24 hours of them.
        var barCandles by remember(token.id) { mutableStateOf<List<io.pinr.app.feed.Candle>>(emptyList()) }
        var barAsOf by remember(token.id) { mutableStateOf<Long?>(null) }
        FixedTextSize { TokenBar(token, barCandles, barAsOf, watch, onHide) }
        Spacer(Modifier.height(10.dp))
        if (token.label == NoScoreLabel.Vamp) {
            BasicText("This coin is a copy (VAMP). A copy carries no data: only its label.", Modifier.padding(vertical = 30.dp), style = sans(13.sp, Brand.paper.copy(alpha = 0.75f)))
        } else {
            TerminalChart(token, client) { c, at -> barCandles = c; barAsOf = at }
            ChartLinksRow(io.pinr.app.feed.ChartLinks.links(token.address, token.chain, token.launchpad, tvSymbol))
        }
        Box(Modifier.fillMaxWidth().padding(vertical = 18.dp), contentAlignment = Alignment.Center) {
            // The page is padded clear of the header, and a child's place is measured inside that padding: scrolling to
            // it lands the dossier just under the header.
            Pill("DeepScan ↓") { scope.launch { scroll.animateScrollTo(deepY.toInt()) } }
        }
        Rule()
        Column(Modifier.onGloballyPositioned { deepY = it.positionInParent().y }) {
            Box(Modifier.fillMaxWidth().padding(vertical = 14.dp), contentAlignment = Alignment.Center) {
                Pill("↑ Chart") { scope.launch { scroll.animateScrollTo(0) } }
            }
            DeepScanBody(token, dossier, dossierFailed, client, all, onOpen, hub, hubLoaded)
        }
    }
}

/** The site's outlined lime pill ("DeepScan ↓", "↑ Chart"). */
@Composable
fun Pill(text: String, onClick: () -> Unit) {
    BasicText(
        text,
        Modifier.background(Brand.lime.copy(alpha = 0.1f), RoundedCornerShape(50)).border(1.dp, Brand.lime.copy(alpha = 0.55f), RoundedCornerShape(50))
            .clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 10.dp).testTag("pill-$text"),
        style = sans(15.sp, Brand.lime, FontWeight.SemiBold),
    )
}

/** A hairline between sections, as the site's. */
@Composable
fun Rule() { Box(Modifier.fillMaxWidth().height(1.dp).background(Brand.fg.copy(alpha = 0.1f))) }

/** The token bar: the coin in a glass pill on the left, the star and the bell, the price and its 24-hour move on the right. */
@Composable
private fun TokenBar(t: Token, candles: List<io.pinr.app.feed.Candle>, asOfMs: Long?, watch: WatchStore, onHide: (Token) -> Unit) {
    var alerting by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically) {
      // The coin and its three buttons take what the price leaves; on a small phone the coin's name gives way first.
      Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f, fill = false).height(46.dp).background(Brand.glass, RoundedCornerShape(50)).border(1.dp, Brand.fg.copy(alpha = 0.1f), RoundedCornerShape(50))
                .padding(start = 8.dp, end = 14.dp).widthIn(max = 200.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TokenPicture(t, 30.dp)
            Spacer(Modifier.width(8.dp))
            Column {
                BasicText(Format.title(t), style = sans(15.sp, Brand.paper, FontWeight.Bold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                BasicText(Format.ticker(t), style = mono(10.sp, Brand.mute), maxLines = 1)
            }
        }
        // The star keeps the coin on this phone's watchlist; the bell sets a price alert (the site's token bar).
        val on = watch.isWatched(t.address)
        Box(Modifier.size(34.dp, 44.dp).clickable { watch.toggle(t.address) }.semantics { contentDescription = if (on) "Remove from watchlist" else "Add to watchlist" }, contentAlignment = Alignment.Center) {
            GlyphIcon(if (on) Glyphs.starOn else Glyphs.star, if (on) Brand.lime else Brand.paper.copy(alpha = 0.85f), 18.dp)
        }
        val bell = watch.alerts.any { it.key == t.address }
        Box(Modifier.size(34.dp, 44.dp).clickable { alerting = true }.semantics { contentDescription = "Price alerts" }, contentAlignment = Alignment.Center) {
            GlyphIcon(if (bell) Glyphs.bellOn else Glyphs.bell, if (bell) Brand.lime else Brand.paper.copy(alpha = 0.85f), 18.dp)
        }
        // The eye-slash: hide this coin (kept on this phone only); the page then goes back, as on the site.
        Box(Modifier.size(34.dp, 44.dp).clickable { onHide(t) }.semantics { contentDescription = "Hide this coin" }.testTag("hide-coin"), contentAlignment = Alignment.Center) {
            GlyphIcon(Glyphs.eyeOff, Brand.paper.copy(alpha = 0.85f), 18.dp)
        }
      }
        // The price stays at the right edge in every width and is never cut.
        Spacer(Modifier.width(4.dp))
        if (t.label != NoScoreLabel.Vamp) {
            // A price and move from a stale chart carry its read time, as the site's: "$0.0192 · as of 2:32 PM".
            val asOf = if (asOfMs != null && candles.isNotEmpty()) " · ${Format.asOf(asOfMs)}" else ""
            Column(Modifier.widthIn(max = 190.dp), horizontalAlignment = Alignment.End) {
                BasicText(Format.price(candles.lastOrNull()?.close ?: t.priceUsd) + asOf, Modifier.testTag("bar-price"), style = sans(24.sp, Brand.paper, FontWeight.Bold).copy(fontFeatureSettings = "tnum", textAlign = androidx.compose.ui.text.style.TextAlign.End), maxLines = 2)
                io.pinr.app.feed.Ind.change24h(candles)?.takeIf { it.isFinite() }?.let { c ->
                    // The site's line: "▲ 3.4% 24h", "▼ −3.4% 24h".
                    BasicText("${if (c >= 0) "▲" else "▼"} ${Format.change(c).replace("+", "")} 24h$asOf", Modifier.testTag("bar-change"), style = mono(11.sp, if (c >= 0) Brand.lime else Brand.mandarin, FontWeight.Medium), maxLines = 1, softWrap = false)
                }
            }
        }
    }
    if (alerting) AlertSheet(t, watch) { alerting = false }
}

/**
 * The site's terminal chart at phone width (ui/terminal.ts): the timeframes, the chart type, Indicators and View; the
 * newest candle's readout with every switched-on indicator's value; the chart with its panes; and, on its left, the
 * drawing rail (pen, magnet, undo, redo, trash) as the site's (terminaldraw.ts).
 */
@Composable
private fun TerminalChart(t: Token, client: CoinClient, onCandles: (List<io.pinr.app.feed.Candle>, Long?) -> Unit = { _, _ -> }) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { ChartPrefs(ctx) }
    var tf by remember(t.id) { mutableStateOf(Timeframe.M15) } // the site's terminal opens on 15m
    var set by remember(t.id) { mutableStateOf<CandleSet?>(null) }
    var failed by remember(t.id) { mutableStateOf(false) }
    var events by remember(t.id) { mutableStateOf<List<ChartEvent>>(emptyList()) }
    var metric by remember(t.id) { mutableStateOf<Metric?>(null) }
    var metricRead by remember(t.id) { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    var menu by remember { mutableStateOf<String?>(null) }
    // Drawing: the tool in hand, the points placed so far, the drawings (kept per coin), undo and redo, the selection.
    var tool by remember { mutableStateOf<io.pinr.app.feed.DrawKind?>(null) }
    var toolList by remember { mutableStateOf(false) }
    var magnet by remember { mutableStateOf(true) }
    var pending by remember(t.id) { mutableStateOf<List<io.pinr.app.feed.DrawPoint>>(emptyList()) }
    var drawings by remember(t.id) { mutableStateOf(prefs.drawings(t.address)) }
    var undo by remember(t.id) { mutableStateOf<List<List<io.pinr.app.feed.Drawing>>>(emptyList()) }
    var redo by remember(t.id) { mutableStateOf<List<List<io.pinr.app.feed.Drawing>>>(emptyList()) }
    var selected by remember(t.id) { mutableStateOf<String?>(null) }
    var confirmClear by remember { mutableStateOf(false) }
    var textAt by remember { mutableStateOf<io.pinr.app.feed.DrawPoint?>(null) }
    fun commit(next: List<io.pinr.app.feed.Drawing>) { undo = (undo + listOf(drawings)).takeLast(50); redo = emptyList(); drawings = next; prefs.saveDrawings(t.address, next) }

    // the chart moves with the stream's price and the coin's own trades between reads.
    val live = LocalLiveFeed.current
    val feedNow = live?.data?.collectAsState()?.value
    var tradesSeen by remember(t.id) { mutableStateOf(-1) }
    LaunchedEffect(feedNow?.lastHeardMs) {
        val cur = set ?: return@LaunchedEffect
        if (live == null) return@LaunchedEffect
        val (count, next) = io.pinr.app.feed.LiveCandle.advance(cur, tf, t.id, live, tradesSeen)
        tradesSeen = count
        if (next != null) { set = next; onCandles(next.takeIf { it.drawable }?.candles ?: emptyList(), next.asOf) }
    }
    suspend fun fetch(): CandleSet? = try { client.candles(t.address, tf).also { failed = false } } catch (e: CoinClient.Failure) { failed = true; null }
    LaunchedEffect(t.id, tf) {
        set = null
        set = fetch()
        // As the site: a good or stale answer gives the candles (a stale one with its read time); anything else empties them.
        onCandles(set?.takeIf { it.drawable }?.candles ?: emptyList(), set?.asOf)
    }
    // As the site: a busy, stale or failed answer is asked again after 8 seconds, keeping what is on screen meanwhile.
    LaunchedEffect(t.id, tf, set, failed, attempt) {
        val st = set?.status
        if (!(failed || st == CandleSet.Status.Busy || st == CandleSet.Status.Error || st == CandleSet.Status.Stale)) return@LaunchedEffect
        kotlinx.coroutines.delay(8_000)
        val n = fetch()
        if (n != null) { set = n; onCandles(n.takeIf { it.drawable }?.candles ?: emptyList(), n.asOf) }
        attempt++
    }
    LaunchedEffect(t.id) {
        events = try { client.events(t.address) } catch (e: CoinClient.Failure) { emptyList() }
        metric = try { client.metric(t.address) } catch (e: CoinClient.Failure) { null }
        metricRead = true
    }
    // Market cap = price × supply: the supply from the feed's own two figures (no figure, no market-cap axis).
    val supplyK = if ((t.valuationUsd ?: 0.0) > 0 && (t.priceUsd ?: 0.0) > 0) t.valuationUsd!! / t.priceUsd!! else null
    val mcapAxis = prefs.mcapAxis && supplyK != null
    val barSeconds = mapOf(Timeframe.M1 to 60.0, Timeframe.M5 to 300.0, Timeframe.M15 to 900.0, Timeframe.H1 to 3600.0, Timeframe.H4 to 14400.0, Timeframe.D1 to 86400.0)[tf]!!

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // The site's toolbar on one row (.tmtools): the timeframes share the free width, then the chart type (each
        // tap moves to the next, as the site's), Indicators (lit when any is on) and View.
        // Chrome, so it keeps the site's sizes at any phone text size; under 380 wide the pills and timeframes tighten a
        // little so the row still fits (the site's flex row on a narrow phone).
        FixedTextSize { androidx.compose.foundation.layout.BoxWithConstraints {
        val narrow = maxWidth < 380.dp
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(if (narrow) 6.dp else 8.dp)) {
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                Timeframe.entries.forEach { f ->
                    val on = f == tf
                    Box(
                        Modifier.weight(1f).height(32.dp).background(if (on) Brand.lime else Color.Transparent, RoundedCornerShape(16.dp)).clickable { tf = f }.testTag("tf-${f.code}"),
                        contentAlignment = Alignment.Center,
                    ) { BasicText(f.code, style = sans(if (narrow) 11.sp else 12.5.sp, if (on) Brand.ink else Brand.mute, FontWeight.SemiBold), maxLines = 1, softWrap = false) }
                }
            }
            MenuPill(prefs.kind.label, false, "chart-kind", narrow) { prefs.chooseKind(ChartKind.entries[(prefs.kind.ordinal + 1) % ChartKind.entries.size]); menu = null }
            MenuPill("Indicators", prefs.ind.values.any { it.on } || menu == "ind", "indicators", narrow) { menu = if (menu == "ind") null else "ind" }
            MenuPill("View", menu == "view", "view", narrow) { menu = if (menu == "view") null else "view" }
        }
        } }
        val s = set
        val ok = s?.drawable == true
        val shown = if (ok) s!!.shown else emptyList()
        val chartH = 540 + prefs.ind.count { (id, st) -> st.on && io.pinr.app.feed.IndSpecs.spec(id).where == io.pinr.app.feed.IndSpecs.Where.Pane } * 80
        Box {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (ok) {
                val k = shown.last()
                val move = if (k.open > 0) (k.close - k.open) / k.open * 100 else Double.NaN
                val f: (Double) -> String = { v -> if (mcapAxis) Format.money(v * supplyK!!) else Format.priceCompact(v) }
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("O" to k.open, "H" to k.high, "L" to k.low, "C" to k.close).forEach { (l, v) ->
                            Row { BasicText(l, style = mono(10.sp, Brand.mute)); Spacer(Modifier.width(2.dp)); BasicText(f(v), style = mono(10.sp, Brand.lime)) }
                        }
                        BasicText(if (move.isFinite()) Format.change(move) else Format.DASH, style = mono(10.sp, if (move >= 0) Brand.lime else Brand.mandarin))
                    }
                    androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row { BasicText("Vol ", style = mono(10.sp, Brand.mute)); BasicText(Format.money(k.volume), style = mono(10.sp, Brand.paper)) }
                        metric?.let { m ->
                            Row { BasicText("PINR Index line ", style = mono(10.sp, Brand.mute)); BasicText(Format.fixed(m.series.last().second, 1), style = mono(10.sp, Brand.lime)) }
                            m.signal.lastOrNull()?.let { sg -> Row { BasicText("signal ", style = mono(10.sp, Brand.mute)); BasicText(Format.fixed(sg.second, 1), style = mono(10.sp, SIGNAL_PURPLE)) } }
                        }
                        // Every switched-on indicator's latest value, in its colour (the site's legend).
                        val drawn = if (mcapAxis) shown.map { io.pinr.app.feed.Candle(it.t, it.open * supplyK!!, it.high * supplyK, it.low * supplyK, it.close * supplyK, it.volume) } else shown
                        indicatorRows(if (prefs.kind == ChartKind.Heikin) io.pinr.app.feed.Ind.heikinAshi(drawn) else drawn, prefs.ind).forEach { r ->
                            Row {
                                BasicText("${r.name.jsTrim()} ", style = mono(10.sp, Brand.mute))
                                // The site's legend: "price" as the axis writes it with its $, "plain" without the $, "num" two decimals.
                                val fv: (Double) -> String = { v -> if (mcapAxis) Format.money(v) else Format.priceCompact(v) }
                                BasicText(if (!r.last.isFinite()) Format.DASH else when (r.digits) { Digits.Price -> fv(r.last); Digits.Plain -> fv(r.last).removePrefix("$"); Digits.Num -> Format.fixed(r.last, 2) }, style = mono(10.sp, r.color))
                            }
                        }
                    }
                }
            }
            Box(Modifier.fillMaxWidth().height(540.dp + (prefs.ind.count { (id, st) -> st.on && io.pinr.app.feed.IndSpecs.spec(id).where == io.pinr.app.feed.IndSpecs.Where.Pane } * 80).dp)) {
                if (ok) {
                    TerminalChartCanvas(
                        shown, prefs.kind, prefs.scale, if (mcapAxis) supplyK!! else 1.0, events, metric, prefs.ind, drawings, pending, tool, selected, barSeconds,
                        onTap = { g, pos ->
                            if (pos.x > g.w || pos.y > g.h0) return@TerminalChartCanvas
                            val k = 1.0 / (if (mcapAxis) supplyK!! else 1.0)
                            val tool0 = tool
                            if (tool0 == null) {
                                // No tool in hand: a tap picks the nearest drawing (or lets it go).
                                selected = drawings.minByOrNull { hitDistance(it, g, pos, k) }?.takeIf { hitDistance(it, g, pos, k) < 36f }?.id
                                return@TerminalChartCanvas
                            }
                            var pt = io.pinr.app.feed.DrawPoint(g.t(pos.x), g.p(pos.y) * k)
                            if (magnet) pt = snap(pt, shown, g, pos, k)
                            val pts = pending + pt
                            if (pts.size < tool0.needs) { pending = pts; return@TerminalChartCanvas }
                            pending = emptyList()
                            if (tool0 == io.pinr.app.feed.DrawKind.Text) { textAt = pts[0]; return@TerminalChartCanvas }
                            commit(drawings + io.pinr.app.feed.Drawing("d${System.currentTimeMillis()}", tool0, pts[0], pts.getOrNull(1), pts.getOrNull(2)))
                            tool = null
                        },
                        modifier = Modifier.fillMaxSize().testTag("chart"),
                    )
                    // The rail on the chart's left, as the site's.
                    DrawRail(
                        magnet, undo.isNotEmpty(), redo.isNotEmpty(), selected != null, confirmClear, drawings.isNotEmpty(),
                        onPen = { toolList = !toolList },
                        onMagnet = { magnet = !magnet },
                        onUndo = { undo.lastOrNull()?.let { prev -> redo = redo + listOf(drawings); undo = undo.dropLast(1); drawings = prev; prefs.saveDrawings(t.address, prev); selected = null } },
                        onRedo = { redo.lastOrNull()?.let { next -> undo = undo + listOf(drawings); redo = redo.dropLast(1); drawings = next; prefs.saveDrawings(t.address, next) } },
                        onTrash = {
                            when {
                                selected != null -> { commit(drawings.filterNot { it.id == selected }); selected = null }
                                confirmClear -> { commit(emptyList()); confirmClear = false }
                                drawings.isNotEmpty() -> confirmClear = true
                            }
                        },
                        modifier = Modifier.align(Alignment.TopStart).padding(start = 8.dp, top = 40.dp),
                    )
                    if (toolList) ToolList(tool, Modifier.align(Alignment.TopStart).padding(start = 56.dp, top = 40.dp)) { k -> tool = k; pending = emptyList(); toolList = false; selected = null }
                    // The hint while a tool is in hand ("Tap the first point", …), or the clear-all question.
                    val hint = tool?.let { it.hints[pending.size.coerceAtMost(it.hints.size - 1)] } ?: if (confirmClear) "Tap the bin again to remove every drawing on this coin" else null
                    hint?.let {
                        Row(Modifier.align(Alignment.TopCenter).padding(top = 6.dp).background(Brand.panel.copy(alpha = 0.92f), RoundedCornerShape(50)).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            BasicText(it, style = sans(12.sp, Brand.paper))
                            if (tool != null) { Spacer(Modifier.width(10.dp)); BasicText("Cancel", Modifier.clickable { tool = null; pending = emptyList() }, style = sans(12.sp, Brand.lime, FontWeight.SemiBold)) }
                        }
                    }
                    // A stale chart says so over itself, as the site's status line.
                    s?.asOf?.let { ChartStatus("Showing the chart ${Format.asOf(it)}. PINR asks again shortly.", chartH) }
                } else Box(Modifier.fillMaxSize()) {
                    ChartStatus(
                        // The site's terminal words (it asks again by itself, so there is no button).
                        when {
                            s == null && !failed -> "Loading candles…"
                            s?.status == CandleSet.Status.None -> "No price history yet: the chart source has no candles for this token yet."
                            s?.status == CandleSet.Status.Busy -> "Chart not read yet. PINR asks again shortly."
                            else -> "Price history not read yet. PINR asks again shortly."
                        },
                        chartH,
                    )
                }
            }
        }
        // The site's dropdown panels over the chart's top right, scrolling past 70% of its height (at most 520).
        val menuMax = minOf(0.7f * chartH, 520f).dp
        when (menu) {
            "ind" -> DropPanel(280.dp, menuMax, Modifier.align(Alignment.TopEnd).padding(top = 4.dp, end = 12.dp)) { IndicatorsMenu(prefs) }
            "view" -> DropPanel(250.dp, menuMax, Modifier.align(Alignment.TopEnd).padding(top = 4.dp, end = 12.dp)) {
                Column(Modifier.padding(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    BasicText("AXIS", Modifier.padding(top = 6.dp), style = sans(10.5.sp, Brand.mute, FontWeight.SemiBold).copy(letterSpacing = 1.05.sp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        SegButton("Price", !mcapAxis, true) { prefs.chooseAxis(false) }
                        SegButton("Market cap", mcapAxis, supplyK != null) { prefs.chooseAxis(true) }
                    }
                    if (supplyK == null) BasicText("No market cap for this token yet.", style = sans(11.sp, Brand.mute))
                    BasicText("SCALE", Modifier.padding(top = 6.dp), style = sans(10.5.sp, Brand.mute, FontWeight.SemiBold).copy(letterSpacing = 1.05.sp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { ScaleMode.entries.forEach { sm -> SegButton(sm.label, sm == prefs.scale, true) { prefs.chooseScale(sm) } } }
                }
            }
        }
        }
        // The PINR Index line says so when the engine has no series for this coin yet.
        if (metric == null) BasicText(if (metricRead) "PINR Index line not available for this token yet" else "PINR Index line loading…", style = mono(10.sp, Brand.mute))
        Row {
            Spacer(Modifier.weight(1f))
            if (ok) s?.source?.let { BasicText("${tf.code} · $it", style = mono(9.sp, Brand.mute)) }
        }
    }
    textAt?.let { at ->
        TextNoteDialog(onDone = { txt -> if (txt.jsTrim().isNotEmpty()) commit(drawings + io.pinr.app.feed.Drawing("d${System.currentTimeMillis()}", io.pinr.app.feed.DrawKind.Text, at, text = txt.jsTrim().take(60))); textAt = null; tool = null }, onCancel = { textAt = null; tool = null })
    }
}

/** The magnet: a tap near a candle takes that candle's nearest open, high, low or close, as the site's magnet does. */
private fun snap(pt: io.pinr.app.feed.DrawPoint, c: List<io.pinr.app.feed.Candle>, g: ChartGeometry, pos: androidx.compose.ui.geometry.Offset, k: Double): io.pinr.app.feed.DrawPoint {
    val near = c.minByOrNull { kotlin.math.abs(g.x(it.t.toDouble()) - pos.x) } ?: return pt
    if (kotlin.math.abs(g.x(near.t.toDouble()) - pos.x) > 24f) return pt
    val best = listOf(near.open, near.high, near.low, near.close).minBy { kotlin.math.abs(g.y(it / k) - pos.y) }
    return if (kotlin.math.abs(g.y(best / k) - pos.y) < 40f) io.pinr.app.feed.DrawPoint(near.t.toDouble(), best) else pt
}

/** How far a tap is from a drawing, in pixels (the site's distToSegment), so a tap can pick one. */
private fun hitDistance(d: io.pinr.app.feed.Drawing, g: ChartGeometry, pos: androidx.compose.ui.geometry.Offset, k: Double): Float {
    fun o(p: io.pinr.app.feed.DrawPoint) = androidx.compose.ui.geometry.Offset(g.x(p.t), g.y(p.p / k))
    fun seg(a: androidx.compose.ui.geometry.Offset, b: androidx.compose.ui.geometry.Offset): Float {
        val dx = b.x - a.x; val dy = b.y - a.y; val l2 = dx * dx + dy * dy
        val q = if (l2 == 0f) 0f else (((pos.x - a.x) * dx + (pos.y - a.y) * dy) / l2).coerceIn(0f, 1f)
        return kotlin.math.hypot(pos.x - (a.x + q * dx), pos.y - (a.y + q * dy))
    }
    val a = o(d.a); val b = d.b?.let(::o)
    return when (d.kind) {
        io.pinr.app.feed.DrawKind.H -> kotlin.math.abs(pos.y - a.y)
        io.pinr.app.feed.DrawKind.V -> kotlin.math.abs(pos.x - a.x)
        io.pinr.app.feed.DrawKind.Text -> kotlin.math.hypot(pos.x - a.x, pos.y - a.y)
        io.pinr.app.feed.DrawKind.Rect, io.pinr.app.feed.DrawKind.Measure, io.pinr.app.feed.DrawKind.Fib -> {
            val inX = pos.x in minOf(a.x, b!!.x)..maxOf(a.x, b.x); val inY = pos.y in minOf(a.y, b.y)..maxOf(a.y, b.y)
            if (inX && inY) 0f else minOf(seg(a, androidx.compose.ui.geometry.Offset(b.x, a.y)), seg(a, androidx.compose.ui.geometry.Offset(a.x, b.y)), seg(b, androidx.compose.ui.geometry.Offset(b.x, a.y)), seg(b, androidx.compose.ui.geometry.Offset(a.x, b.y)))
        }
        else -> seg(a, b!!)
    }
}

/** The site's chart status line (.tmstatus): over the chart, 38% down, centred, 12-point mono in the muted colour. */
@Composable
private fun androidx.compose.foundation.layout.BoxScope.ChartStatus(text: String, chartH: Int) {
    BasicText(
        text,
        Modifier.align(Alignment.TopCenter).fillMaxWidth().padding(top = (chartH * 0.38f).dp).padding(horizontal = 28.dp).testTag("chart-status"),
        style = mono(12.sp, Brand.mute).copy(textAlign = androidx.compose.ui.text.style.TextAlign.Center, lineHeight = 16.8.sp),
    )
}

/** The site's toolbar pill (.tmkind, .tmind): 32 high, 12 across, lit lime when on. */
@Composable
private fun MenuPill(text: String, lit: Boolean, tag: String, narrow: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier.height(32.dp).background(if (lit) Brand.lime.copy(alpha = 0.16f) else Brand.fg.copy(alpha = 0.07f), RoundedCornerShape(16.dp))
            .clickable(onClick = onClick).padding(horizontal = if (narrow) 9.dp else 12.dp).testTag(tag),
        contentAlignment = Alignment.Center,
    ) { BasicText(text, style = sans(12.sp, if (lit) Brand.lime else Brand.paper, FontWeight.Medium), maxLines = 1, softWrap = false) }
}

/** The site's dropdown panel (.tmindmenu): over the chart, glass, scrolling when taller than [maxHeight]. */
@Composable
private fun DropPanel(width: androidx.compose.ui.unit.Dp, maxHeight: androidx.compose.ui.unit.Dp, modifier: Modifier, content: @Composable () -> Unit) {
    Box(
        modifier.width(width).heightIn(max = maxHeight).background(Brand.panel.copy(alpha = 0.94f), RoundedCornerShape(16.dp))
            .border(1.dp, Brand.fg.copy(alpha = 0.12f), RoundedCornerShape(16.dp)).verticalScroll(rememberScrollState()).padding(6.dp).testTag("drop-panel"),
    ) { content() }
}

@Composable
private fun MenuCard(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().background(Brand.panel, RoundedCornerShape(18.dp)).border(1.dp, Brand.fg.copy(alpha = 0.1f), RoundedCornerShape(18.dp)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp), content = content)
}

@Composable
private fun MenuChoice(text: String, on: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        BasicText(text, Modifier.weight(1f), style = sans(14.sp, if (on) Brand.lime else Brand.paper, FontWeight.Medium))
        if (on) Box(Modifier.size(6.dp).background(Brand.lime, androidx.compose.foundation.shape.CircleShape))
    }
}

@Composable
private fun SegButton(text: String, on: Boolean, enabled: Boolean, onClick: () -> Unit) {
    BasicText(
        text,
        Modifier.background(if (on) Brand.lime else Brand.fg.copy(alpha = 0.08f), RoundedCornerShape(50)).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp),
        style = sans(13.sp, (if (on) Brand.ink else Brand.paper).copy(alpha = if (enabled) 1f else 0.4f), FontWeight.SemiBold),
    )
}

/**
 * The Indicators menu (terminalind.ts): every indicator with a box, its name and settings, and where it is drawn; the
 * gear opens its settings (whole numbers inside their limits) and its colour.
 */
@Composable
private fun IndicatorsMenu(prefs: ChartPrefs) {
    var open by remember { mutableStateOf<io.pinr.app.feed.IndId?>(null) }
    Column {
        io.pinr.app.feed.IndSpecs.SPECS.forEach { spec ->
            val st = prefs.ind[spec.id]!!
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f).height(40.dp).clip(RoundedCornerShape(10.dp)).clickable { prefs.setInd(spec.id, st.copy(on = !st.on)) }.padding(horizontal = 10.dp).testTag("ind-${spec.id.name}"), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(16.dp).background(if (st.on) Brand.lime else Color.Transparent, RoundedCornerShape(5.dp)).border(1.5.dp, if (st.on) Brand.lime else Brand.fg.copy(alpha = 0.35f), RoundedCornerShape(5.dp)))
                    Spacer(Modifier.width(10.dp))
                    BasicText(io.pinr.app.feed.IndSpecs.label(spec, st), style = sans(13.sp, Brand.paper, FontWeight.Medium), maxLines = 1, softWrap = false)
                    Spacer(Modifier.weight(1f).widthIn(min = 8.dp))
                    BasicText(when (spec.where) { io.pinr.app.feed.IndSpecs.Where.Pane -> "own pane"; io.pinr.app.feed.IndSpecs.Where.Volume -> "on volume"; else -> "on price" }, style = sans(11.sp, Brand.mute), maxLines = 1, softWrap = false)
                }
                if (spec.params.isNotEmpty() || spec.pickColor) {
                    BasicText("⚙", Modifier.clickable { open = if (open == spec.id) null else spec.id }.padding(horizontal = 6.dp, vertical = 8.dp).semantics { contentDescription = "${spec.name} settings" }, style = sans(14.sp, if (open == spec.id) Brand.lime else Brand.mute))
                }
            }
            if (open == spec.id) {
                Column(Modifier.padding(start = 12.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    spec.params.forEach { q ->
                        val v = st.params[q.key]!!
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            BasicText(q.label, Modifier.width(80.dp), style = sans(12.sp, Brand.mute))
                            BasicText("−", Modifier.clickable { prefs.setInd(spec.id, st.copy(params = st.params + (q.key to io.pinr.app.feed.IndSpecs.clamp(q, (v - 1).toDouble())))) }.padding(horizontal = 10.dp, vertical = 2.dp), style = sans(18.sp, Brand.paper))
                            BasicText("$v", Modifier.width(40.dp), style = mono(14.sp, Brand.paper).copy(textAlign = androidx.compose.ui.text.style.TextAlign.Center))
                            BasicText("+", Modifier.clickable { prefs.setInd(spec.id, st.copy(params = st.params + (q.key to io.pinr.app.feed.IndSpecs.clamp(q, (v + 1).toDouble())))) }.padding(horizontal = 10.dp, vertical = 2.dp), style = sans(18.sp, Brand.paper))
                        }
                    }
                    if (spec.pickColor) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        io.pinr.app.feed.ChartColor.entries.forEach { cc ->
                            Box(Modifier.size(22.dp).background(chartColor(cc), androidx.compose.foundation.shape.CircleShape).border(2.dp, if (st.color == cc) Brand.paper else Color.Transparent, androidx.compose.foundation.shape.CircleShape)
                                .clickable { prefs.setInd(spec.id, st.copy(color = cc)) }.semantics { contentDescription = "Colour ${cc.name.lowercase()}" })
                        }
                    }
                }
            }
        }
    }
}

/** The site's drawing rail (terminaldraw.ts): pen (the tools), magnet, undo, redo and the bin. */
@Composable
private fun DrawRail(
    magnet: Boolean, canUndo: Boolean, canRedo: Boolean, hasSelection: Boolean, confirmClear: Boolean, hasDrawings: Boolean,
    onPen: () -> Unit, onMagnet: () -> Unit, onUndo: () -> Unit, onRedo: () -> Unit, onTrash: () -> Unit, modifier: Modifier,
) {
    Column(
        modifier.background(Brand.panel.copy(alpha = 0.85f), RoundedCornerShape(16.dp)).border(1.dp, Brand.fg.copy(alpha = 0.1f), RoundedCornerShape(16.dp)).padding(vertical = 6.dp).testTag("draw-rail"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        RailButton(Glyphs.pen, "Drawing tools", Brand.paper, onPen)
        RailButton(Glyphs.magnet, if (magnet) "Magnet on" else "Magnet off", if (magnet) Brand.lime else Brand.mute, onMagnet)
        RailButton(Glyphs.undo, "Undo", Brand.paper.copy(alpha = if (canUndo) 1f else 0.35f), onUndo)
        RailButton(Glyphs.redo, "Redo", Brand.paper.copy(alpha = if (canRedo) 1f else 0.35f), onRedo)
        RailButton(Glyphs.trash, if (hasSelection) "Delete this drawing" else "Remove every drawing", if (confirmClear) Brand.mandarin else Brand.paper.copy(alpha = if (hasDrawings) 1f else 0.35f), onTrash)
    }
}

@Composable
private fun RailButton(v: androidx.compose.ui.graphics.vector.ImageVector, label: String, tint: Color, onClick: () -> Unit) {
    Box(Modifier.size(40.dp).clickable(onClick = onClick).semantics { contentDescription = label }, contentAlignment = Alignment.Center) { GlyphIcon(v, tint, 20.dp) }
}

/** The list of drawing tools, each with the site's name. */
@Composable
private fun ToolList(current: io.pinr.app.feed.DrawKind?, modifier: Modifier, pick: (io.pinr.app.feed.DrawKind) -> Unit) {
    Column(modifier.background(Brand.panel, RoundedCornerShape(14.dp)).border(1.dp, Brand.fg.copy(alpha = 0.12f), RoundedCornerShape(14.dp)).padding(6.dp).testTag("tool-list")) {
        io.pinr.app.feed.DrawKind.entries.forEach { k ->
            BasicText(k.label, Modifier.clickable { pick(k) }.padding(horizontal = 10.dp, vertical = 7.dp).testTag("tool-${k.name}"), style = sans(13.sp, if (k == current) Brand.lime else Brand.paper, FontWeight.Medium))
        }
    }
}

/** The words of a text note (at most 60 characters, as the site keeps). */
@Composable
private fun TextNoteDialog(onDone: (String) -> Unit, onCancel: () -> Unit) {
    var text by remember { mutableStateOf("") }
    androidx.compose.ui.window.Dialog(onDismissRequest = onCancel) {
        Column(Modifier.fillMaxWidth().background(Brand.panel, RoundedCornerShape(18.dp)).padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            BasicText("Text note", style = sans(16.sp, Brand.paper, FontWeight.Bold))
            Box(Modifier.fillMaxWidth().background(Brand.fg.copy(alpha = 0.08f), RoundedCornerShape(12.dp)).padding(12.dp)) {
                BasicTextField(text, { text = it.take(60) }, Modifier.fillMaxWidth().testTag("note-field"), singleLine = true, textStyle = sans(15.sp, Brand.paper), cursorBrush = SolidColor(Brand.lime))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                BasicText("Place", Modifier.background(Brand.lime, RoundedCornerShape(50)).clickable { onDone(text) }.padding(horizontal = 18.dp, vertical = 9.dp), style = sans(14.sp, Brand.ink, FontWeight.SemiBold))
                BasicText("Cancel", Modifier.clickable(onClick = onCancel).padding(horizontal = 12.dp, vertical = 9.dp), style = sans(14.sp, Brand.paper))
            }
        }
    }
}

/** The bell's panel: the price now, a price to be alerted at, and this coin's waiting alerts (the site's alert menu). */
@Composable
private fun AlertSheet(t: Token, watch: WatchStore, onClose: () -> Unit) {
    var text by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    androidx.compose.ui.window.Dialog(onDismissRequest = onClose) {
        Column(Modifier.fillMaxWidth().background(Brand.panel, RoundedCornerShape(22.dp)).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            BasicText("Price alert · now ${Format.price(t.priceUsd).let { if (it == Format.DASH) "unknown" else it }}", style = sans(16.sp, Brand.paper, FontWeight.Bold))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f).height(40.dp).background(Brand.fg.copy(alpha = 0.08f), RoundedCornerShape(50)).padding(horizontal = 12.dp), contentAlignment = Alignment.CenterStart) {
                    if (text.isEmpty()) BasicText("Alert me at (USD)", style = mono(14.sp, Brand.mute))
                    BasicTextField(text, { text = it }, singleLine = true, textStyle = mono(14.sp, Brand.paper), cursorBrush = SolidColor(Brand.lime), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                }
                Spacer(Modifier.width(8.dp))
                BasicText(
                    "Add alert",
                    Modifier.background(Brand.lime, RoundedCornerShape(50)).clickable {
                        val level = text.replace("$", "").replace(",", "").toDoubleOrNull() ?: Double.NaN
                        message = watch.addAlert(t, level)
                        if (message == null) text = ""
                    }.padding(horizontal = 14.dp, vertical = 11.dp),
                    style = sans(14.sp, Brand.ink, FontWeight.SemiBold),
                )
            }
            message?.let { BasicText(it, style = sans(12.sp, Brand.mandarin)) }
            watch.alerts.filter { it.key == t.address }.forEach { a ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    BasicText("${if (a.dir == "up") "Rises to" else "Falls to"} ${Format.price(a.level)}", Modifier.weight(1f), style = mono(12.sp, Brand.paper))
                    BasicText("✕", Modifier.clickable { watch.remove(a) }.padding(6.dp).semantics { contentDescription = "Remove this alert" }, style = sans(14.sp, Brand.mute))
                }
            }
            BasicText("Alerts are checked while PINR is open on this device.", style = sans(11.sp, Brand.mute))
        }
    }
}

/** "Full charts and pages elsewhere": the links as small capsules, under the chart; each opens in the reader's own browser. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun ChartLinksRow(items: List<io.pinr.app.feed.ChartLinks.Item>) {
    if (items.isEmpty()) return
    val ctx = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxWidth().padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        BasicText("FULL CHARTS AND PAGES ELSEWHERE", style = mono(10.5.sp, Brand.mute, androidx.compose.ui.text.font.FontWeight.Bold))
        androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items.forEach { i ->
                BasicText(
                    i.label,
                    Modifier.clip(RoundedCornerShape(50)).background(Brand.fg.copy(alpha = 0.07f)).clickable {
                        try { ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(i.url)).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (e: Exception) {}
                    }.padding(horizontal = 12.dp, vertical = 7.dp),
                    style = mono(11.5.sp, Brand.paper.copy(alpha = 0.9f), androidx.compose.ui.text.font.FontWeight.Medium),
                )
            }
        }
    }
}
