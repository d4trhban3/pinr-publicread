package io.pinr.app.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.pinr.app.R

/**
 * The words of the PINR guide (the centre page), exactly as pinr-live/src/ui/guidecopy.ts holds them: a design decision, the
 * operator's approved text. Public wording: change a word only on the site first, on the operator's say-so.
 */
object GuideCopy {
    /** A paragraph or a bullet, with an optional bold opening; **…** marks a bold word inside. */
    data class Block(val bullet: Boolean, val lead: String?, val text: String)
    data class Section(val title: String, val blocks: List<Block>)

    private fun p(lead: String?, text: String) = Block(false, lead, text)
    private fun li(lead: String?, text: String) = Block(true, lead, text)

    val SECTIONS = listOf(
        Section("Where everything is", listOf(
            p("Discover", "is the search page and the market pulse: Trending, Top Movers, Fresh Launches and PINRscore lists, each card showing the coin, its market cap and all-time high, a small chart, and the score with its coverage."),
            p("PINR", "is the home page: every scored coin as a tile, biggest and most active first, so you see what the scanner is looking at."),
            p("PINRbot DeepScan", "is one page per coin: the live chart on top, then the dossier below it: the score, the recent trades, the checks, the facts, the written read, the coin's own links and what the posts about it say."),
            p("Wallet / Profile", "reads a wallet's public holdings. It cannot sign, send or approve anything."),
            p("PvP Arena", "sits above PINR: every version of a contested coin side by side, the leader first."),
            p(null, "PINR is the centre of the map. The compass in the centre of the footer opens the whole map. The PINR GUIDE button in the centre of the header opens this guide or the Whitepaper. The footer takes you to the main pages."),
        )),
        Section("Why the site is laid out this way", listOf(
            p(null, "Every page answers one question. PINR: what is moving. Discover: where is the coin I am looking for. DeepScan: what is the evidence for this one coin. Wallet: what do I hold. Everything starts at a coin, and every figure on the way carries where it came from and when it was read, so you can check it yourself instead of trusting a label."),
        )),
        Section("What a score is, and is not", listOf(
            p(null, "PINR's summary, from 1 to 99, of what its checks found. Beside every score is its **coverage**: how much of the picture was actually read. A score with low coverage is an early, partial look. A high score means \"no bad pattern found\". It does not say the coin is good, and it does not say what the price will do. When PINR has not read something, the page says \"not read\" and the reason. It never fills a gap with a guess, and a dash means \"not measured\"."),
        )),
        Section("How PINR scans", listOf(
            p(null, "New launches are watched as they appear. A coin gets scored on its own; the busiest coins are scored first, so the list you see is led by what the market is paying attention to. A first score is often chain-only and early, and it is read again as more can be read. Social posts are read separately: what a post claims is set beside what the chain shows, the lines are shown to you, and they never change a score."),
        )),
        Section("The data, one kind at a time", listOf(
            li("Chain facts:", "who created the coin, who paid for the launch, how many coins that wallet launched before, the pool and what it holds. Source: the public Solana chain, with a link to the explorer for each figure."),
            li("Launchpad facts:", "the coin's own record on its launchpad (its name, picture, links, market cap, all-time high). Source: the launchpad."),
            li("Market figures:", "price, liquidity, volume, pair. Source: the market data service named on each figure, with the time it was read."),
            li("Social lines:", "what the coin's linked posts say, shown with a link to the post, never scored."),
            p(null, "Every figure shows its source, how long ago it was read, and where to look. If a figure has no source, it says \"no source\" and is not used."),
        )),
        Section("What PINR does for each kind of trader", listOf(
            p("New to this:", "start on PINR or Discover, tap a coin, read the score with its coverage first, then scroll the dossier from the top. The plain words (Strong, Fair, Weak, Clear, Not read) are there so you do not need to know what a check does."),
            p("Everyday trader:", "use Fresh Launches and Top Movers to find coins fast, and read the checks and the recent trades before you decide anything. Compare the market cap with the all-time high."),
            p("Experienced:", "the chart has timeframes, indicators and drawing tools, and every dossier figure links to its source so you can verify it. Use the facts list for the launcher's history."),
            p("Large holders:", "watch who launched the coin, how long it has traded and how much liquidity sits behind it, and look at the top-holder check once it is read. A coin with low coverage tells you what has not been looked at yet."),
            p("Funds and desks:", "the whole site is a research tool built on sourced, timestamped readings. Nothing on it is advice or a recommendation, and every number with a source line can be traced to its source."),
        )),
        Section("What PINR does not do", listOf(
            p(null, "It does not tell you what to buy or sell. It does not predict price. It does not move your wallet. It shows what was read, from where, and when, and it says plainly what it could not read."),
        )),
    )

    /** The block's words with its bold opening and any **bold** piece (the site's richText). */
    fun rich(b: Block): AnnotatedString = buildAnnotatedString {
        b.lead?.let { withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(it) }; append(" ") }
        b.text.split("**").forEachIndexed { i, part -> if (i % 2 == 1) withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(part) } else append(part) }
    }

    /** Every word on the page, for the test that keeps it equal to the approved text. */
    fun plain(): String = SECTIONS.joinToString("\n") { s -> s.title + "\n" + s.blocks.joinToString("\n") { (it.lead?.let { l -> "$l " } ?: "") + it.text } }
}

/**
 * The PINR guide (ui/guide.ts, style.css .gd*): the blade badge with its lime glow, the title, then each section on a
 * soft 5% card, 22 round, as the site's. Plain reading: no data and no buttons.
 */
@Composable
fun GuideRoom(insets: PaddingValues) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp)
            .padding(top = insets.calculateTopPadding(), bottom = insets.calculateBottomPadding()).testTag("guide"),
    ) {
        Column(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 22.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Image(
                painterResource(R.drawable.blade_guide), null,
                Modifier.height(120.dp).width(15.12.dp).shadow(26.dp, ambientColor = Brand.lime.copy(alpha = 0.35f), spotColor = Brand.lime.copy(alpha = 0.35f), clip = false),
            )
            BasicText("PINR guide", Modifier.testTag("page-Guide"), style = sans(34.sp, Brand.paper, FontWeight.Bold).copy(letterSpacing = (-0.03).em, lineHeight = 36.sp))
        }
        GuideCopy.SECTIONS.forEach { s ->
            Column(
                Modifier.fillMaxWidth().padding(bottom = 18.dp).background(Brand.fg.copy(alpha = 0.05f), RoundedCornerShape(22.dp)).padding(16.dp),
            ) {
                BasicText(s.title, Modifier.padding(bottom = 12.dp), style = sans(20.sp, Brand.paper, FontWeight.Bold))
                var prev: Boolean? = null
                s.blocks.forEach { b ->
                    // The site's spacing: 10 between paragraphs or a paragraph and the list, 8 between bullets.
                    val gap = when { prev == null -> 0; prev == true && b.bullet -> 8; else -> 10 }
                    val style = sans(14.5.sp, Brand.paper).copy(lineHeight = 22.5.sp)
                    if (b.bullet) {
                        Row(Modifier.padding(top = gap.dp, start = 4.dp)) {
                            BasicText("•", Modifier.width(14.dp), style = style)
                            BasicText(GuideCopy.rich(b), style = style)
                        }
                    } else {
                        BasicText(GuideCopy.rich(b), Modifier.padding(top = gap.dp), style = style)
                    }
                    prev = b.bullet
                }
            }
        }
    }
}
