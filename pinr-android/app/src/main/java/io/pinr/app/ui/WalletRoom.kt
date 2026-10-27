package io.pinr.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.pinr.app.feed.ChainName
import io.pinr.app.feed.CoinClient
import io.pinr.app.feed.Format
import io.pinr.app.feed.NameFilter
import io.pinr.app.feed.Token
import io.pinr.app.feed.WalletRules
import io.pinr.app.feed.WalletView
import kotlinx.coroutines.delay

/** The site's dollars on the wallet page (ui/wallet.ts `usd`): money() from $1 up, the exact small amount below (never "$0"). */
fun walletUsd(v: Double): String = if (v >= 1) Format.money(v) else Format.priceCompact(v)

/**
 * "1.23K", "3.4M", "12.35" (the site's `Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 })`):
 * at most two decimals, no trailing zeros, the next unit when rounding reaches a thousand.
 */
fun walletCompact(v: Double): String {
    if (!v.isFinite()) return Format.DASH
    val units = listOf("", "K", "M", "B", "T")
    var x = Math.abs(v)
    var u = 0
    while (u < units.size - 1 && x >= 999.995) { x /= 1000; u++ }
    val body = java.math.BigDecimal(x).setScale(2, java.math.RoundingMode.HALF_EVEN).stripTrailingZeros().toPlainString()
    return (if (v < 0) "-" else "") + body + units[u]
}

/**
 * Wallet (east on the map), in the site's look (ui/wallet.ts, style.css .wl*), view-only since the title, the
 * "View-only" card, "Look up an address", then the address's card and the tracked tokens it holds. Only a public address
 * is ever used; nothing connects to a wallet.
 */
@Composable
fun WalletRoom(choices: ChoicesStore, client: CoinClient, all: Map<String, Token>, insets: PaddingValues, onOpen: (Token) -> Unit) {
    val address = choices.wallet
    var view by remember(address) { mutableStateOf<WalletView?>(null) }
    var failed by remember(address) { mutableStateOf(false) }
    LaunchedEffect(address) {
        // Read now and every 30 seconds while the page is open; a failed read retries shortly.
        while (address != null) {
            try { view = client.wallet(address); failed = false } catch (e: CoinClient.Failure) { failed = view == null }
            delay(if (failed) 8_000 else 30_000)
        }
    }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp)
            .padding(top = insets.calculateTopPadding(), bottom = insets.calculateBottomPadding() + 20.dp).testTag("wallet"),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(Modifier.padding(top = 4.dp, bottom = 2.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            BasicText("Wallet", Modifier.testTag("page-Wallet"), style = sans(34.sp, Brand.paper, FontWeight.Bold).copy(letterSpacing = (-0.03).em))
            BasicText(if (address == null) "Look up what a public wallet address holds." else "What this public address holds.", style = sans(14.sp, Brand.mute))
        }
        if (address != null) {
            ProfileCard(address) { choices.clearWallet() }
            SafetyCard(compact = true)
            Rule()
            Holdings(view, failed, all, onOpen)
            Rule()
            BasicText("Everything here is read from public blockchain data for this one address. PINR is a research tool, not investment advice.", style = sans(11.sp, Brand.mute))
        } else {
            SafetyCard(compact = false)
            Rule()
            AddressEntry(choices)
        }
    }
}

@Composable
private fun Hint(text: String) = BasicText(text, style = sans(13.sp, Brand.mute).copy(lineHeight = 18.sp))

/** The site's "View-only" card: all three points with no address; on an address, the short line and "What view-only means" folded. */
@Composable
private fun SafetyCard(compact: Boolean) {
    var more by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().background(Brand.lime.copy(alpha = 0.07f), RoundedCornerShape(22.dp))
            .border(1.dp, Brand.lime.copy(alpha = 0.35f), RoundedCornerShape(22.dp)).padding(16.dp).testTag("view-only"),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            GlyphIcon(Glyphs.shield, Brand.lime, 22.dp)
            Spacer(Modifier.width(10.dp))
            BasicText(WalletRules.VIEW_ONLY_TITLE, style = sans(17.sp, Brand.lime, FontWeight.SemiBold))
        }
        val points = @Composable {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                WalletRules.VIEW_ONLY_POINTS.forEach { p ->
                    Row { BasicText("•", Modifier.width(14.dp), style = sans(13.5.sp, Brand.paper)); BasicText(p, style = sans(13.5.sp, Brand.paper).copy(lineHeight = 19.sp)) }
                }
            }
        }
        if (compact) {
            BasicText(WalletRules.VIEW_ONLY_SHORT, style = sans(13.5.sp, Brand.paper))
            BasicText((if (more) "▾ " else "▸ ") + "What view-only means", Modifier.clickable { more = !more }, style = sans(13.sp, Brand.lime, FontWeight.SemiBold))
            if (more) points()
        } else points()
    }
}

/** "Look up an address": type or paste a public address. Nothing is connected and no wallet app is involved. */
@Composable
private fun AddressEntry(choices: ChoicesStore) {
    val ctx = LocalContext.current
    var text by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    fun run() { error = choices.viewWallet(text) }
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        BasicText("Look up an address", style = sans(21.sp, Brand.paper, FontWeight.Bold))
        Hint("Paste any wallet address to see which tokens PINR tracks it holds. Nothing is connected and no wallet app is involved.")
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f).height(48.dp).background(Brand.fg.copy(alpha = 0.08f), RoundedCornerShape(14.dp)).padding(horizontal = 14.dp), contentAlignment = Alignment.CenterStart) {
                if (text.isEmpty()) BasicText("0x… or a Solana address", style = mono(14.sp, Brand.mute))
                BasicTextField(
                    text, { text = it }, Modifier.fillMaxWidth().testTag("wallet-address"), singleLine = true,
                    textStyle = mono(14.sp, Brand.paper, FontWeight.Medium), cursorBrush = SolidColor(Brand.lime),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onGo = { run() }),
                )
            }
            Spacer(Modifier.width(8.dp))
            BasicText("View", Modifier.background(Brand.lime, RoundedCornerShape(14.dp)).clickable { run() }.padding(horizontal = 20.dp, vertical = 14.dp).testTag("wallet-view"), style = sans(15.sp, Brand.ink, FontWeight.SemiBold))
        }
        error?.let { BasicText(it, Modifier.testTag("wallet-error"), style = sans(13.sp, Brand.mandarin)) }
    }
}

/** The profile card: the address's own colours, its short form, its chain, "Viewing only", Copy and Clear. */
@Composable
private fun ProfileCard(address: String, clear: () -> Unit) {
    val ctx = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    val (a, b, c) = WalletRules.avatarHues(address)
    val chain = WalletRules.chain(address)
    Column(Modifier.fillMaxWidth().glass(22.dp).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(64.dp).background(
                    Brush.radialGradient(listOf(Color.hsl(a.toFloat(), 0.85f, 0.62f), Color.hsl(b.toFloat(), 0.8f, 0.55f), Color.hsl(c.toFloat(), 0.75f, 0.45f))), CircleShape,
                ).border(2.dp, Brand.fg.copy(alpha = 0.25f), CircleShape),
            )
            Spacer(Modifier.width(14.dp))
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                BasicText(WalletRules.short(address), style = mono(19.sp, Brand.paper, FontWeight.SemiBold))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    WalletChip(if (chain == WalletRules.Chain.Solana) "Solana" else "BNB Chain · Base")
                    WalletChip("Viewing only")
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SmallButton(if (copied) "Copied" else "Copy", Brand.paper) {
                (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("address", address)); copied = true
            }
            SmallButton("Clear", Brand.mandarin, clear)
        }
    }
}

@Composable
private fun WalletChip(t: String) = BasicText(t, Modifier.background(Brand.fg.copy(alpha = 0.08f), RoundedCornerShape(12.dp)).padding(horizontal = 10.dp, vertical = 4.dp), style = sans(11.5.sp, Brand.mute, FontWeight.Medium))

@Composable
private fun SmallButton(t: String, color: Color, onClick: () -> Unit) =
    BasicText(t, Modifier.background(Brand.fg.copy(alpha = 0.09f), RoundedCornerShape(50)).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 9.dp), style = sans(13.sp, color, FontWeight.SemiBold))

/** "Tracked tokens held", in the site's words, with a row per holding; a row opens its coin when the feed lists it. */
@Composable
private fun Holdings(v: WalletView?, failed: Boolean, all: Map<String, Token>, onOpen: (Token) -> Unit) {
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        BasicText("Tracked tokens held", style = sans(21.sp, Brand.paper, FontWeight.Bold))
        when {
            v == null && !failed -> Hint("Reading the chain…")
            v == null || v.status == "error" -> Hint("This wallet's balances are not read yet. PINR asks again shortly.")
            else -> {
                if (v.status == "partial") Hint("Not read yet on ${v.unavailable.joinToString(", ") { ChainName.of(it) }}. What is shown is real; it may be incomplete.")
                if (v.holdings.isEmpty()) Hint("This wallet holds none of the tokens PINR tracks right now.")
                else {
                    Column(Modifier.padding(bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        BasicText("Value of tracked tokens held", style = mono(10.5.sp, Brand.mute))
                        BasicText(v.totalUsd?.let(::walletUsd) ?: Format.DASH, style = sans(28.sp, Brand.paper, FontWeight.Bold).copy(fontFeatureSettings = "tnum"))
                    }
                    if (v.holdings.any { it.score != null }) Hint(SCORE_NOTICE)
                    v.holdings.forEach { h -> HoldingRow(h, all[h.address.lowercase()], onOpen) }
                    Box(Modifier.padding(top = 4.dp)) { Hint("Only tokens PINR tracks are listed. Tokens without a price are left out of the total.") }
                }
            }
        }
    }
}

@Composable
private fun HoldingRow(h: WalletView.Holding, found: Token?, onOpen: (Token) -> Unit) {
    val rude = NameFilter.enabled && (NameFilter.isRude(h.name) || NameFilter.isRude(h.ticker))
    Column {
        Row(Modifier.fillMaxWidth().heightIn(min = 58.dp).clickable(enabled = found != null) { found?.let(onOpen) }, verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                BasicText(if (rude) NameFilter.MASKED_NAME else h.name ?: WalletRules.short(h.address), style = sans(15.sp, Brand.paper, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                BasicText("${if (rude) NameFilter.MASKED_TICKER else h.ticker ?: ""} · ${walletCompact(h.balance)}", style = mono(11.sp, Brand.mute), maxLines = 1)
            }
            Spacer(Modifier.width(8.dp))
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                BasicText(h.usd?.let(::walletUsd) ?: "no price", style = mono(13.sp, Brand.paper, FontWeight.Bold))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    when {
                        h.noScoreLabel != null -> BasicText(h.noScoreLabel, style = sans(12.sp, Brand.mandarin, FontWeight.Bold))
                        h.score != null -> { BasicText(h.score.toString(), style = sans(13.sp, Brand.score(h.score), FontWeight.SemiBold)); BasicText("Chain only", style = mono(9.5.sp, Brand.lilac)) }
                        else -> BasicText(Format.DASH, style = sans(13.sp, Brand.mute))
                    }
                }
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Brand.fg.copy(alpha = 0.06f)))
    }
}
