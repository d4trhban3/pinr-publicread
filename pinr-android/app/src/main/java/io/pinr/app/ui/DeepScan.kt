package io.pinr.app.ui

import io.pinr.app.feed.jsTrim
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.pinr.app.feed.CandleSet
import io.pinr.app.feed.CoinClient
import io.pinr.app.feed.EngineNote
import io.pinr.app.feed.EvidenceHub
import io.pinr.app.feed.PoolWords
import io.pinr.app.feed.FigureRule
import io.pinr.app.feed.ReceiptMark
import io.pinr.app.feed.TradesWords
import io.pinr.app.feed.EvidenceWords
import io.pinr.app.feed.Dossier
import io.pinr.app.feed.Format
import io.pinr.app.feed.NoScoreLabel
import io.pinr.app.feed.Similar
import io.pinr.app.feed.Timeframe
import io.pinr.app.feed.Token
import io.pinr.app.feed.TradesView
import io.pinr.app.feed.pressureWindows
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay

/** The site's notice beside a score (ui/scorenotice.ts SCORE_NOTICE). Public copy: change it only on the site first. */
const val SCORE_NOTICE = "Social presence unchecked until the X API is connected. This score reads the chain only."

/**
 * The DeepScan dossier in the site's order and words (ui/deepscan.ts): the score, Recent trades, Checks, Evidence, The
 * read, Social and callouts, Social (not scored), Similar tokens, Stats, and the fine print. Plain sections under bold
 * headings, divided by hairlines; one tinted word per check; every figure with its source line.
 */
@Composable
fun DeepScanBody(
    t: Token, d: Dossier?, failed: Boolean, client: CoinClient, all: List<Token>, onOpen: (Token) -> Unit,
    hub: EvidenceHub? = null, hubLoaded: Boolean = false,
) {
    Column {
        ScoreBlock(t)
        Rule()
        if (t.label != NoScoreLabel.Vamp) { TradesSection(t, client); Rule() }
        if (t.label != NoScoreLabel.Vamp) { PoolSection(d, t.launchpad); Rule() }
        if (t.label != NoScoreLabel.Vamp) { EvidenceHubBlock(hub, hubLoaded); Rule() }
        if (d != null) {
            if (!d.available) { Section("DeepScan") { Prose("PINR has no dossier for this coin yet. Nothing is shown in its place.") }; Rule() }
            Checks(d); Rule()
            Evidence(d); Rule()
            if (d.read.isNotEmpty()) {
                // The site's paragraphs (.dsreadp): 14 point, a 10 point gap after each.
                Section("The read") {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        d.read.forEach { BasicText(it, style = sans(14.sp, Brand.paper).copy(lineHeight = 20.3.sp)) }
                    }
                }
                Rule()
            }
            Callouts(d); Rule()
            Social(d); Rule()
        } else {
            Section("DeepScan") { Prose(if (failed) "Not read yet. PINR asks again shortly." else "Loading…") }
            Rule()
        }
        SimilarSection(t, all, onOpen); Rule()
        StatsSection(t, d, client)
        BasicText(
            "Everything on this page is a measured reading or a dash. A dash means it was not measured. PINR is a research tool, not investment advice.",
            Modifier.padding(vertical = 18.dp), style = sans(11.sp, Brand.mute),
        )
        BottomBar(t)
    }
}

/** The site's bar at the foot of the page (deepscan.ts `.dsbar`): the 24-hour volume, and "Copy contract". */
@Composable
private fun BottomBar(t: Token) {
    val ctx = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().padding(bottom = 12.dp).glass(30.dp).padding(start = 20.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            BasicText("24h volume", style = mono(11.sp, Brand.mute))
            BasicText(Format.money(t.volume24hUsd), style = sans(17.sp, Brand.paper, FontWeight.Bold))
        }
        BasicText(
            if (copied) "Copied" else "Copy contract",
            Modifier.background(Brand.lime, RoundedCornerShape(50)).clickable {
                (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("contract", t.address))
                copied = true
            }.padding(horizontal = 24.dp, vertical = 12.dp).testTag("copy-contract"),
            style = sans(15.sp, Brand.ink, FontWeight.SemiBold),
        )
    }
}

// The pieces

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        BasicText(title, Modifier.padding(bottom = 6.dp), style = sans(21.sp, Brand.paper, FontWeight.Bold))
        content()
    }
}

@Composable
private fun Prose(text: String, paper: Boolean = false) {
    BasicText(text, style = sans(13.5.sp, if (paper) Brand.paper else Brand.mute).copy(lineHeight = 19.sp))
}

/** A row with a hairline under it: the left side and what sits at the right. */
@Composable
private fun Row2(leading: @Composable () -> Unit, trailing: @Composable () -> Unit) {
    Column {
        Row(Modifier.fillMaxWidth().padding(vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { leading() }
            Spacer(Modifier.width(8.dp))
            trailing()
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Brand.fg.copy(alpha = 0.07f)))
    }
}

/** Small spaced capitals, as the site's sub-headings ("WHERE THIS TOKEN LISTS ITSELF"). */
@Composable
private fun Caps(text: String, modifier: Modifier = Modifier) {
    BasicText(text.uppercase(), modifier.padding(bottom = 2.dp), style = sans(11.sp, Brand.mute, FontWeight.Bold).copy(letterSpacing = 0.14.em))
}

enum class Tone { Good, Fair, Weak, Clear, None }

/** The site's tinted word chips. */
@Composable
fun WordChip(text: String, tone: Tone) {
    val fg = when (tone) { Tone.Good -> Brand.lime; Tone.Fair -> Brand.amber; Tone.Weak -> Brand.mandarin; Tone.Clear -> Brand.paper; Tone.None -> Brand.mute }
    val bg = when (tone) {
        Tone.Good -> Brand.lime.copy(alpha = 0.14f); Tone.Fair -> Brand.amber.copy(alpha = 0.16f); Tone.Weak -> Brand.mandarin.copy(alpha = 0.16f)
        Tone.Clear, Tone.None -> Brand.fg.copy(alpha = 0.09f)
    }
    BasicText(text, Modifier.background(bg, RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 4.dp), style = sans(12.sp, fg, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** Which tint a check's word wears (the site's bandClass). */
fun bandTone(b: Dossier.Band): Tone = when (b) {
    Dossier.Band.Strong -> Tone.Good
    Dossier.Band.Fair -> Tone.Fair
    Dossier.Band.Weak -> Tone.Weak
    Dossier.Band.Clear -> Tone.Clear
    Dossier.Band.NoData, Dossier.Band.NotRead -> Tone.None
}

/** One check's word; "Not read" carries its reason in the same chip, as on the site. */
@Composable
private fun BandChip(b: Dossier.Band, reason: String?) =
    WordChip(if (b == Dossier.Band.NotRead) listOfNotNull(b.word, reason).joinToString(" · ") else b.word, bandTone(b))

private fun open(ctx: Context, url: String) {
    // Opens the reader's own browser at a public page: PINR sends nothing.
    try { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (e: Exception) {}
}

/** "Solana chain · read 3 h ago  View", or "no source" when the receipt is not whole (deepscan.ts receiptLine). */
@Composable
private fun SourceLine(source: String?, atMs: Long?, link: String?) {
    val ctx = LocalContext.current
    val ago = Format.scoredAgo(atMs)
    if (source == null || ago == null) { BasicText("no source", style = mono(10.sp, Brand.mute)); return }
    Row {
        BasicText("$source · read $ago", style = mono(10.sp, Brand.mute), maxLines = 1)
        if (link != null) {
            // The site's receipt: the link stands a little apart, with no dot before it.
            Spacer(Modifier.width(8.dp))
            BasicText("View", Modifier.clickable { open(ctx, link) }, style = mono(10.sp, Brand.paper.copy(alpha = 0.85f)).copy(textDecoration = TextDecoration.Underline))
        }
    }
}

/**
 * The score (deepscan.ts): the ring in the score's colour with the number inside and "PINRSCORE" under it (a flagged
 * coin: the ring full in mandarin and its label); beside it what it rests on, the notice under a number, and the
 * engine's findings as chips.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ScoreBlock(t: Token) {
    val c = Format.corner(t)
    Row(Modifier.padding(vertical = 18.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(108.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.size(108.dp)) {
                val sw = size.width * 9 / 120
                val inset = size.width * 8 / 120
                val box = Size(size.width - inset * 2, size.height - inset * 2)
                drawArc(Brand.fg.copy(alpha = 0.09f), 0f, 360f, false, Offset(inset, inset), box, style = Stroke(sw))
                when {
                    c.flagged -> drawArc(Brand.mandarin, -90f, 360f, false, Offset(inset, inset), box, style = Stroke(sw))
                    c.numeric -> drawArc(Brand.score(c.score.toInt()), -90f, 360f * c.score.toInt() / 100, false, Offset(inset, inset), box, style = Stroke(sw, cap = StrokeCap.Round))
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                when {
                    c.flagged -> BasicText(c.score, style = sans(16.sp, Brand.mandarin, FontWeight.Bold))
                    c.numeric -> BasicText(c.score, style = sans(34.sp, Brand.score(c.score.toInt()), FontWeight.SemiBold).copy(fontFeatureSettings = "tnum"))
                    else -> BasicText(c.score, style = sans(34.sp, Brand.mute, FontWeight.SemiBold))
                }
                BasicText("PINRSCORE", style = mono(8.5.sp, Brand.mute, FontWeight.Medium).copy(letterSpacing = 0.12.em))
            }
        }
        Spacer(Modifier.width(18.dp))
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            BasicText(coverageLine(t), style = mono(12.5.sp, Brand.mute, FontWeight.Medium))
            if (c.numeric) BasicText(SCORE_NOTICE, style = sans(11.sp, Brand.mute))
            val findings = EngineNote.parts(t.note)
            if (findings.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    findings.forEach { BasicText(it, Modifier.background(Brand.fg.copy(alpha = 0.07f), RoundedCornerShape(14.dp)).padding(horizontal = 10.dp, vertical = 6.dp), style = sans(12.sp, Brand.paper, FontWeight.Medium)) }
                }
            }
        }
    }
}

/** The line beside the ring (deepscan.ts covLine with copynote.ts flagLine). */
fun coverageLine(t: Token): String {
    val c = Format.corner(t)
    if (c.flagged) {
        return if (t.label == NoScoreLabel.Vamp) {
            if (t.copyOf?.chainProven == true) "Copy confirmed from Pump.fun's record: no score is shown" else "Possible copy, not confirmed yet (creators not checked yet): no score is shown"
        } else "Labelled by the checks: no score is shown"
    }
    if (t.coverage <= 0) return "Nothing measured yet"
    val ago = if (c.numeric) Format.scoredAgo(t.asOfMs) else null
    return "${Format.coverage(t.coverage)} of the readings loaded" + (ago?.let { " · scored $it" } ?: "")
}

/**
 * Recent trades, as the site's trades list (ui/tradeslist.ts): the pressure windows, the receipt, a warning when only the
 * newest trades were read, ten trades (more on request), and the window they cover. Read again every few seconds.
 */
@Composable
private fun TradesSection(t: Token, client: CoinClient) {
    var view by remember(t.id) { mutableStateOf<TradesView?>(null) }
    var state by remember(t.id) { mutableStateOf("loading") }
    var more by remember(t.id) { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis() / 1000) }
    // trades the stream brings for this coin go on top at once (newest last, as the tape's list is); the next tape read takes over the ones it holds.
    val store = io.pinr.app.ui.LocalLiveFeed.current
    val feedNow = store?.data?.collectAsState()?.value
    var live by remember(t.id) { mutableStateOf<List<io.pinr.app.feed.Trade>>(emptyList()) }
    var seen by remember(t.id) { mutableStateOf(-1) }
    LaunchedEffect(feedNow?.lastHeardMs) {
        if (store == null) return@LaunchedEffect
        val count = store.tickCount
        val fresh = if (seen < 0) 0 else minOf(count - seen, store.recentTicks.size)
        seen = count
        if (fresh <= 0) return@LaunchedEffect
        val add = store.recentTicks.takeLast(fresh).filter { it.address == t.id && it.usd != null && it.usd > 0 && it.isBuy != null }
            .map { io.pinr.app.feed.Trade(it.atMs / 1000, it.isBuy == true, it.usd!!) }
        if (add.isNotEmpty()) { live = (live + add).takeLast(40); now = System.currentTimeMillis() / 1000 }
    }
    LaunchedEffect(t.id) {
        seen = store?.tickCount ?: -1
        while (true) {
            try { view = client.trades(t.address); state = "ok" } catch (e: CoinClient.Failure) { if (view == null) state = "error" }
            now = System.currentTimeMillis() / 1000
            delay(if (view?.none == false) 10_000 else 3_000)
        }
    }
    Section("Recent trades") {
        val v = view
        when {
            state == "loading" -> Prose("Loading trades…")
            state == "error" || v == null -> Prose("Trades are not read yet. PINR asks again shortly.")
            v.none || v.trades.isEmpty() -> Prose(if (v.none) TradesWords.NO_TRADES_READ else "No trades in the list yet.")
            else -> {
                pressureWindows(v, now).forEach { w -> PressureLine(w.label, w.buy, w.sell, w.n, w.atLeast) }
                v.asOf?.let { BasicText("Pump.fun · read ${maxOf(0, now - it)} s ago", style = mono(10.sp, Brand.mute)) }
                if (!v.complete) BasicText(
                    "Only the newest trades could be read for this coin, so the list may not reach back to the start of the window. This is not a full tape.",
                    style = sans(12.5.sp, Brand.mandarin),
                )
                val shownN = if (more) maxOf(10, 40) else 10
                val clock = SimpleDateFormat("HH:mm:ss", Locale.US)
                // The site's rows (tradeslist.ts `.trrow`): the time, the side, the dollars at the right, then how long ago.
                Column {
                    val newest = v.trades.lastOrNull()?.t ?: 0L
                    (v.trades + live.filter { it.t > newest }).takeLast(shownN).reversed().forEach { tr ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                            BasicText(clock.format(Date(tr.t * 1000)), Modifier.width(76.dp), style = mono(12.sp, Brand.mute))
                            BasicText(if (tr.buy) "Buy" else "Sell", Modifier.weight(1f), style = mono(12.sp, if (tr.buy) Brand.lime else Brand.mandarin, FontWeight.Bold))
                            BasicText(Format.money2(tr.usd), style = mono(12.sp, Brand.paper))
                            BasicText(Format.tradeAgo(maxOf(0, now - tr.t)), Modifier.width(40.dp), style = mono(11.sp, Brand.mute).copy(textAlign = androidx.compose.ui.text.style.TextAlign.End))
                        }
                        Box(Modifier.fillMaxWidth().height(1.dp).background(Brand.fg.copy(alpha = 0.07f)))
                    }
                }
                if (v.trades.size > 10) {
                    BasicText(if (more) "Show fewer" else "Show more", Modifier.padding(top = 6.dp).clickable { more = !more }, style = sans(13.sp, Brand.lime, FontWeight.SemiBold))
                }
                v.coversFrom?.let {
                    val since = SimpleDateFormat("MMM d, HH:mm", Locale.US).format(Date(it * 1000))
                    Prose("Trades since $since. Sizes are in US dollars at the time of the trade.")
                }
            }
        }
    }
}

/** One pressure line (tradeslist.ts `pressure`): the window and its trade count, a bar, then buys and sells in dollars. */
@Composable
private fun PressureLine(label: String, buy: Double, sell: Double, n: Int, atLeast: Boolean) {
    val al = if (atLeast) "at least " else ""
    Column(Modifier.padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row {
            BasicText(label, Modifier.weight(1f), style = sans(13.sp, Brand.paper.copy(alpha = 0.85f)))
            BasicText("$al${if (n == 1) "1 trade" else "$n trades"}", style = sans(13.sp, Brand.paper.copy(alpha = 0.85f)))
        }
        Box(Modifier.fillMaxWidth().height(8.dp).background(if (buy + sell > 0) Brand.mandarin else Brand.fg.copy(alpha = 0.08f), RoundedCornerShape(50))) {
            if (buy + sell > 0) Box(Modifier.fillMaxWidth((buy / (buy + sell)).toFloat()).height(8.dp).background(Brand.lime, RoundedCornerShape(50)))
        }
        Row {
            BasicText("Buys $al${Format.money2(buy)}", Modifier.weight(1f), style = mono(13.sp, Brand.lime, FontWeight.Bold))
            BasicText("Sells $al${Format.money2(sell)}", style = mono(13.sp, Brand.mandarin, FontWeight.Bold))
        }
    }
}

@Composable
private fun Checks(d: Dossier) {
    Section("Checks") {
        when {
            d.flagged -> Prose("This token carries a label, so its checks are not shown.")
            d.checks.isEmpty() -> Prose(Format.DASH)
            else -> d.checks.filter { it.name != "Social link" }.forEach { c ->
                Row2({ BasicText(c.name, style = sans(14.sp, Brand.paper)) }) { BandChip(c.band, c.reason) }
            }
        }
    }
}

@Composable
private fun Evidence(d: Dossier) {
    val ctx = LocalContext.current
    Section("Evidence") {
        if (d.facts.isEmpty()) Prose(Format.DASH)
        d.facts.forEach { f ->
            if (f.notRead || f.lines.isNotEmpty() || f.badge != null || f.moreLinks != null || f.id == "transfer_fee" || f.id == "fee_dev_payouts") { FeeFact(f); return@forEach }
            Row2({
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    BasicText(f.label, style = sans(13.sp, Brand.paper.copy(alpha = 0.85f)))
                    SourceLine(f.receipt?.source, f.receipt?.readAtMs, f.receipt?.link)
                }
            }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    BasicText(f.value, style = mono(13.sp, Brand.paper, FontWeight.Bold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    f.copy?.let { v ->
                        var copied by remember { mutableStateOf(false) }
                        Spacer(Modifier.width(8.dp))
                        BasicText(
                            if (copied) "Copied" else "Copy",
                            Modifier.background(Brand.fg.copy(alpha = 0.1f), RoundedCornerShape(50)).clickable {
                                (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("address", v))
                                copied = true
                            }.padding(horizontal = 10.dp, vertical = 5.dp).semantics { contentDescription = "Copy the address" },
                            style = sans(12.sp, Brand.paper, FontWeight.SemiBold),
                        )
                    }
                }
            }
        }
    }
}

/**
 * The transfer fee and the fees paid to the dev group: the label and the figure in words that
 * may run to two lines, "High fee" beside it in the warning style, the receipt or "not read yet", the case sentences, then the links
 * to look at. Words come from the server's allow-list; nothing is composed here.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FeeFact(f: Dossier.Fact) {
    val ctx = LocalContext.current
    Column {
        Column(Modifier.fillMaxWidth().padding(vertical = 11.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            FlowRow(verticalArrangement = Arrangement.spacedBy(4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                BasicText(f.label, style = sans(13.sp, Brand.paper.copy(alpha = 0.85f)))
                BasicText(f.value, style = mono(13.sp, Brand.paper, FontWeight.Bold))
                f.badge?.let { WordChip(it, Tone.Weak) }
            }
            if (f.notRead) BasicText("not read yet", style = mono(10.sp, Brand.mute)) else SourceLine(f.receipt?.source, f.receipt?.readAtMs, f.receipt?.link)
            f.lines.forEach { BasicText(it, Modifier.padding(top = 2.dp), style = sans(12.5.sp, Brand.paper)) }
            f.moreLinks?.let { m ->
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    BasicText("${m.lead} ", style = mono(10.sp, Brand.mute))
                    m.links.forEachIndexed { i, k ->
                        BasicText(
                            k.label + if (i < m.links.size - 1) "," else "", Modifier.clickable { open(ctx, k.url) }.semantics { contentDescription = "${m.lead} ${k.label}" },
                            style = mono(10.sp, Brand.paper.copy(alpha = 0.85f)).copy(textDecoration = TextDecoration.Underline),
                        )
                    }
                }
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Brand.fg.copy(alpha = 0.07f)))
    }
}

@Composable
private fun Callouts(d: Dossier) {
    val ctx = LocalContext.current
    Section("Social and callouts") {
        Caps("Where this token lists itself")
        d.channels.forEach { c ->
            Row2({ BasicText(c.label, style = sans(14.sp, Brand.paper)) }) {
                when (c.status) {
                    Dossier.Channel.Status.Listed -> c.url?.let { u ->
                        Box(Modifier.clickable { open(ctx, u) }) { WordChip(c.postBy?.let { "A post by @$it · open" } ?: "Listed · open", Tone.Good) }
                    }
                    Dossier.Channel.Status.NotListed -> WordChip("Not listed", Tone.Weak)
                    Dossier.Channel.Status.Unknown -> WordChip("Not read", Tone.None)
                }
            }
        }
        d.checks.firstOrNull { it.name == "Social link" }?.let { l ->
            Row2({ BasicText("Links lead back to the token", style = sans(14.sp, Brand.paper)) }) { BandChip(l.band, null) }
        }
        Caps("Not measured yet", Modifier.padding(top = 10.dp))
        listOf(
            "Follower counts and how old the accounts are", "How active the posts are, and who engages with them",
            "Callouts: other accounts or tapes mentioning the token",
        ).forEach { BasicText("•  $it", Modifier.padding(vertical = 2.dp), style = sans(13.sp, Brand.paper)) }
        Box(Modifier.padding(top = 6.dp)) { Prose("PINR does not read these yet. They are shown as not measured, never as zero, and they do not move the score.") }
    }
}

@Composable
private fun Social(d: Dossier) {
    val ctx = LocalContext.current
    Section("Social (not scored)") {
        // The site's note (.dsscannote) keeps 8 points under it before what follows.
        BasicText("$SCORE_NOTICE Nothing here moves the score.", Modifier.padding(bottom = 8.dp), style = sans(11.sp, Brand.mute).copy(lineHeight = 15.4.sp))
        val s = d.social
        if (s == null) {
            Prose("No social scan has been run for this coin yet. Nothing is claimed either way.")
        } else {
            Prose(Dossier.totalsSentence(s.totals), paper = true)
            s.flags.forEach { BasicText(it, style = sans(13.sp, Brand.mandarin)) }
            s.claims.forEach { c ->
                Column(Modifier.padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    BasicText(c.line, style = sans(13.sp, Brand.paper))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        WordChip(Dossier.RESULT_WORDS[c.result] ?: "", when (c.result) { "MATCHES" -> Tone.Good; "DIVERGES" -> Tone.Weak; else -> Tone.None })
                        Spacer(Modifier.width(8.dp))
                        if (c.removed) BasicText("post removed", style = mono(10.sp, Brand.mute))
                        else c.postUrl?.let { u -> BasicText("post", Modifier.clickable { open(ctx, u) }, style = mono(10.sp, Brand.lime).copy(textDecoration = TextDecoration.Underline)) }
                    }
                }
            }
            s.gaps.forEach { BasicText("Not read: $it", style = mono(10.sp, Brand.mute)) }
        }
    }
}

/** Similar tokens (world/similar.ts): same chain, close in size and age, from measured facts only; tap one to open it. */
@Composable
private fun SimilarSection(t: Token, all: List<Token>, onOpen: (Token) -> Unit) {
    val list = remember(t.id, all.size) { Similar.tokens(t, all, 5) }
    Section("Similar tokens") {
        if (list.isEmpty()) Prose("No coin close enough in chain, size and age to compare.")
        list.forEach { s ->
            Row(
                Modifier.fillMaxWidth().height(54.dp).glass(26.dp).clickable { onOpen(s) }.padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TokenPicture(s, 36.dp, marks = false)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    BasicText(if (s.ticker == null) Format.title(s) else Format.ticker(s), style = sans(15.sp, Brand.paper, FontWeight.Bold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val age = Format.ageText(s.launchedAtMs?.let { (System.currentTimeMillis() - it) / 60_000.0 })
                    BasicText("${Format.money(s.valuationUsd)} · $age old", style = sans(13.sp, Brand.mute))
                }
                val c = Format.corner(s)
                when {
                    c.flagged -> BasicText(c.score, style = sans(13.sp, Brand.mandarin, FontWeight.Bold))
                    c.numeric -> BasicText(c.score, style = sans(20.sp, Brand.score(c.score.toInt()), FontWeight.SemiBold))
                    else -> BasicText(c.score, style = sans(20.sp, Brand.mute))
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

/**
 * Stats, as the site's (deepscan.ts): the app's own figures with their source and time, the day's open, high and low
 * from the chart source, and the coin's plain facts. A dash has nothing to source.
 */
@Composable
private fun StatsSection(t: Token, d: Dossier?, client: CoinClient) {
    var day by remember(t.id) { mutableStateOf<CandleSet?>(null) }
    var dayAt by remember(t.id) { mutableLongStateOf(0L) }
    LaunchedEffect(t.id) { day = try { client.candles(t.address, Timeframe.H1) } catch (e: CoinClient.Failure) { null }; dayAt = System.currentTimeMillis() }
    val last = day?.takeIf { it.drawable }?.candles?.takeLast(24).orEmpty()
    // The receipt's time is when the candles were read: a stale answer's own read time, not when it was asked.
    val chartSrc: Pair<String?, Long?> = if (last.isNotEmpty() && day?.source != null) (if (day?.source == "PINR tape") "Pump.fun" else day?.source) to (day?.asOf ?: dayAt) else null to null
    val valuation = d?.facts?.firstOrNull { it.id == "valuation" }?.receipt
    val cap: Pair<String?, Long?> = t.capReceipt?.let { it.source to it.atMs } ?: valuation?.let { it.source to it.readAtMs } ?: (null to null)
    fun rc(k: String): Pair<String?, Long?> = t.figSrc[k]?.let { it.source to it.atMs } ?: (null to null)
    val dayVol = last.sumOf { it.volume }
    val stats: List<Triple<String, String, Pair<String?, Long?>?>> = listOf(
        Triple("Market cap", Format.money(t.valuationUsd), cap),
        Triple("All-time high (market cap)", Format.money(t.athUsd), if (t.athUsd != null) t.athReceipt?.let { it.source to it.atMs } ?: (null to null) else (null to null)),
        Triple("Liquidity", Format.money(t.liquidityUsd), rc("liquidity")),
        // A figure a source gave beats a sum of the chart's candles (which can be thin on a young coin).
        Triple("24h volume", if (t.volume24hUsd != null) Format.money(t.volume24hUsd) else if (last.isNotEmpty()) Format.money(dayVol) else Format.DASH, if (t.volume24hUsd != null) rc("volume") else chartSrc),
        Triple("24h open", last.firstOrNull()?.let { Format.priceCompact(it.open) } ?: Format.DASH, chartSrc),
        Triple("24h high", last.maxOfOrNull { it.high }?.let { Format.priceCompact(it) } ?: Format.DASH, chartSrc),
        Triple("24h low", last.minOfOrNull { it.low }?.let { Format.priceCompact(it) } ?: Format.DASH, chartSrc),
        Triple("Quote pair", t.quotePair ?: Format.DASH, rc("pair")),
        Triple("Age", Format.ageText(t.launchedAtMs?.let { (System.currentTimeMillis() - it) / 60_000.0 }), null),
        Triple("Chain", t.chain ?: Format.DASH, null),
        Triple("Launchpad", t.launchpad ?: Format.DASH, null),
        Triple("Coverage", Format.coverage(t.coverage), null),
        Triple("Contract", if (t.address.length > 14) t.address.take(6) + "…" + t.address.takeLast(4) else t.address, null),
    )
    Section("Stats") {
        stats.forEach { (label, value0, receipt) ->
            // the team, 26 Oct: a figure is shown only with its source named; with none it is a dash that says "not read yet".
            val f = FigureRule.shown(value0, hasSource = receipt?.first != null && receipt.second != null, sourced = receipt != null)
            Row2({
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    BasicText(label, style = sans(13.5.sp, Brand.paper))
                    if (f.notRead) BasicText("not read yet", style = mono(10.sp, Brand.mute))
                    else if (receipt != null && f.value != Format.DASH) SourceLine(receipt.first, receipt.second, null)
                }
            }) { BasicText(f.value, style = mono(13.sp, Brand.paper, FontWeight.Bold), maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
}

// The evidence hub

/**
 * "At launch" (the gate's result), PINRai's reading with its receipts, then the evidence rows in the site's six groups (world/orbit.ts).
 * A doctor's words: what was observed, never a verdict. ● read on chain, ○ reported by the source named.
 */
@Composable
private fun EvidenceHubBlock(hub: EvidenceHub?, loaded: Boolean) {
    val ctx = LocalContext.current
    val now = System.currentTimeMillis()
    @Composable fun LinkText(text: String, url: String) =
        BasicText(text, Modifier.clickable { open(ctx, url) }, style = mono(11.sp, Brand.paper.copy(alpha = 0.85f)).copy(textDecoration = TextDecoration.Underline))
    @Composable fun Meta(text: String) = BasicText(text, style = mono(10.5.sp, Brand.mute))
    if (!loaded) { Section("Evidence") { Prose("Loading…") }; return }
    if (hub == null) { Section("Evidence") { Prose("No evidence has been recorded for this coin yet.") }; return }

    EvidenceWords.gateView(hub.gate, now)?.let { g ->
        Section("At launch") {
            BasicText(g.headline, style = sans(13.5.sp, Brand.paper, FontWeight.SemiBold))
            g.lines.forEach { l ->
                Column(Modifier.padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    BasicText(l.words, style = sans(13.sp, Brand.paper.copy(alpha = 0.9f)))
                    l.whenText?.let { Meta(it) }
                    l.links.forEach { (label, url) -> LinkText(label, url) }
                }
            }
            if (g.others.isNotEmpty()) {
                Caps("The creator's other coins")
                g.others.take(5).forEach { c ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (c.link != null) LinkText(c.label, c.link) else BasicText(c.label, style = mono(11.sp, Brand.paper.copy(alpha = 0.85f)))
                        c.whenText?.let { Meta(it) }
                    }
                }
            }
            g.creatorLink?.let { LinkText("See the creator", it) }
            g.readText?.let { Meta(it) }
        }
        Rule()
    }
    EvidenceWords.pinraiView(hub.pinrai, now)?.let { p ->
        Section("PINRai") {
            BasicText(p.headline, style = sans(13.5.sp, Brand.paper, FontWeight.SemiBold))
            p.lines.forEach { l ->
                Column(Modifier.padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    BasicText(l.words, style = sans(13.sp, Brand.paper.copy(alpha = 0.9f)))
                    if (!l.reviewed) Meta("not reviewed yet")
                    l.receipts.forEach { r ->
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            BasicText(ReceiptMark.mark(r.onchain), Modifier.semantics { contentDescription = ReceiptMark.word(r.onchain) }, style = mono(11.sp, Brand.mute))
                            if (r.link != null) LinkText(r.text, r.link) else BasicText(r.text, style = mono(11.sp, Brand.paper.copy(alpha = 0.85f)))
                            r.whenText?.let { Meta(it) }
                            ReceiptMark.note(r.onchain, r.link != null)?.let { Meta(it) }
                        }
                    }
                }
            }
            p.counts?.let { Meta(it) }
            p.readText?.let { Meta(it) }
        }
        Rule()
    }
    Section("Evidence trail") {
        Prose("Every fact says what it is, whether it was read on chain (●) or only reported (○), and where to see it. Nothing here is a verdict.")
        EvidenceWords.orbitGroups(hub, now).forEach { g ->
            Caps(g.label)
            if (g.facts.isEmpty()) Prose(g.empty)
            g.facts.forEach { f ->
                Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        BasicText(ReceiptMark.mark(f.onchain), Modifier.semantics { contentDescription = ReceiptMark.word(f.onchain) }, style = mono(11.sp, Brand.mute))
                        BasicText(f.text, style = sans(13.sp, Brand.paper.copy(alpha = 0.9f)))
                    }
                    val meta = listOfNotNull(f.source, f.readText, f.happenedText, ReceiptMark.note(f.onchain, f.link != null)).joinToString(" · ")
                    if (meta.isNotEmpty()) Meta(meta)
                    f.link?.let { LinkText("See the evidence", it) }
                }
            }
        }
    }
}

/**
 * the Pool section (the site's `renderPool`): pool created, liquidity added and removed, the coin creator changed, bought back and burned,
 * newest first. Each is an observed fact (●) with who, how much, when (UTC) and a link to its transaction. No file: "Not checked yet."; a file with no events:
 * "No pool events observed."
 */
@Composable
private fun PoolSection(d: Dossier?, launchpad: String? = null) {
    val ctx = LocalContext.current
    @Composable fun LinkText(text: String, url: String) =
        BasicText(text, Modifier.clickable { open(ctx, url) }, style = mono(11.sp, Brand.paper.copy(alpha = 0.85f)).copy(textDecoration = TextDecoration.Underline))
    Section("Pool") {
        val p = d?.pool
        when {
            d == null -> Prose("Loading…")
            (p == null || p.state == "none") && d.poolRows.isNotEmpty() -> {
                // No pool-events file (Base, BNB): the pool facts the evidence file holds, each ● only with its receipt link (checklist 6).
                d.poolRows.forEach { r ->
                    Column(Modifier.padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            BasicText(ReceiptMark.mark(r.onchain), Modifier.semantics { contentDescription = ReceiptMark.word(r.onchain) }, style = mono(11.sp, Brand.mute))
                            BasicText(r.what.replaceFirstChar { it.uppercase() }, style = sans(13.sp, Brand.paper, FontWeight.SemiBold))
                        }
                        val shown = r.value?.let { v -> if (r.unit == "share of pool value" && v.toDoubleOrNull() != null) "${Math.round(v.toDouble() * 100)}% of the pool's value" else if (r.unit != null) "$v ${r.unit}" else v }
                        BasicText(listOfNotNull(shown, r.source ?: "source not stated").joinToString(" · "), style = mono(10.5.sp, Brand.mute))
                        if (r.link != null) LinkText("View receipt", r.link) else BasicText("no receipt link yet", style = mono(10.5.sp, Brand.mute))
                    }
                }
                BasicText("From this coin's evidence file. Pool events are not read for this coin yet.", style = mono(10.sp, Brand.mute))
            }
            p == null || p.state == "none" -> Prose(FigureRule.noPoolWords(launchpad))
            p.events.isEmpty() -> Prose("No pool events observed.")
            else -> {
                p.events.forEach { e ->
                    Column(Modifier.padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            BasicText("●", Modifier.semantics { contentDescription = "read on chain" }, style = mono(11.sp, Brand.mute))
                            BasicText(PoolWords.title(e.kind), style = sans(13.sp, Brand.paper, FontWeight.SemiBold))
                        }
                        val what = PoolWords.what(e)
                        if (what.isNotEmpty()) BasicText(what, style = sans(13.sp, Brand.paper.copy(alpha = 0.9f)))
                        if (e.kind == "coin creator changed") {
                            e.oldCreator?.let { LinkText("from ${PoolWords.short(it)}", PoolWords.accountUrl(it, p.chain)) }
                            e.newCreator?.let { LinkText("to ${PoolWords.short(it)}", PoolWords.accountUrl(it, p.chain)) }
                        } else e.user?.let { LinkText("by ${PoolWords.short(it)}", PoolWords.accountUrl(it, p.chain)) }
                        BasicText(PoolWords.local(e.atMs), style = mono(10.5.sp, Brand.mute))
                        LinkText("View transaction", PoolWords.txUrl(e.sig, p.chain))
                    }
                }
                BasicText(
                    "Observed on chain${p.source?.let { " ($it)" } ?: ""}${p.asOfMs?.let { ", read ${PoolWords.local(it)}" } ?: ""}. Pool history from before PINR listed the coin is not read yet.",
                    style = mono(10.sp, Brand.mute),
                )
            }
        }
    }
}
