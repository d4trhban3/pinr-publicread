package io.pinr.app.ui

import io.pinr.app.feed.jsTrim
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.pinr.app.feed.ChoicesCode
import io.pinr.app.feed.FeedData
import io.pinr.app.feed.FeedState

/** The site's Data line (main.ts dataView): what the feed is, in its words, and whether to warn. */
fun dataStatus(f: FeedData, nowMs: Long = System.currentTimeMillis()): Triple<String, Boolean, String> = when (val s = f.state) {
    FeedState.Connecting -> Triple("Connecting to the feed server…", false, "Waiting for the feed server.")
    is FeedState.Mismatch -> Triple("The feed speaks a different data contract than this app", true, "Results are not shown until the app and the engine output agree on the data contract.")
    is FeedState.Offline -> if (f.lastHeardMs == null) Triple("Feed server not reachable", true, "The feed server cannot be reached, so there are no tokens to show. Nothing is made up.")
    else Triple(liveLine(f, nowMs) + " · server stopped", true, feedNote(f))
    is FeedState.Live -> Triple(liveLine(f, nowMs), false, feedNote(f))
}

private fun liveLine(f: FeedData, nowMs: Long): String {
    val age = f.asOfMs?.let { " · newest result ${Format2.ago(nowMs - it)} old" } ?: ""
    val cut = f.restTotal?.let { t -> if (t > f.restLoaded) " · loading the rest of the scored set (${f.restLoaded} of $t)" else null } ?: ""
    return "${f.firstPageCount} tokens$age$cut"
}

private fun feedNote(f: FeedData) = if (f.mode == "replay")
    "Real engine results from saved test runs, shown as saved: not live. Anything the engine has not provided (names, prices, charts, trades) shows as missing, not as a made-up value."
else "Real results from the PINR engine. Anything the engine has not provided yet (names, prices, charts, trades) shows as missing, not as a made-up value."

/** The site's short age ("12s", "5m", "3h", "2d"). */
object Format2 {
    fun ago(ms: Long): String {
        val s = maxOf(0L, ms / 1000)
        return when { s < 60 -> "${s}s"; s < 3600 -> "${s / 60}m"; s < 86400 -> "${s / 3600}h"; else -> "${s / 86400}d" }
    }
}

/**
 * Settings (the site's ui/settings.ts, from the menu), in its sections and words: Display, Coin names, Your choices (the
 * choices code of a design decision), Data and About. Everything is kept on this phone; nothing here changes a score.
 */
@Composable
fun SettingsPanel(choices: ChoicesStore, feed: FeedData, onClose: () -> Unit) {
    val ctx = LocalContext.current
    var shown by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf(false) }
    var pasted by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var warn by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<ChoicesCode.Choices?>(null) }

    Column(
        Modifier.fillMaxSize().background(Brand.panel).windowInsetsPadding(WindowInsets.statusBars).windowInsetsPadding(WindowInsets.navigationBars)
            .clickable(remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, indication = null) {}
            .testTag("settings"),
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).clickable(onClick = onClose).semantics { contentDescription = "Close settings" }, contentAlignment = Alignment.Center) {
                GlyphIcon(Glyphs.chevronBack, Brand.paper, 22.dp)
            }
            BasicText("Settings", style = sans(22.sp, Brand.paper, FontWeight.Bold))
        }
        Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Section2("Display") {
                Line("Live background", "The moving art behind everything") { Toggle(choices.background, choices::switchBackground, "Live background") }
                Divider2()
                Line("Moving streams", "Buy and sell streaks on tiles and rows") { Toggle(choices.streams, choices::switchStreams, "Moving streams") }
            }
            Section2("Coin names") {
                Line("Hide rude coin names", "Masks the name, ticker and picture of coins with a rude name") { Toggle(choices.filterNames, choices::setFilter, "Hide rude coin names") }
                Divider2()
                Line("Hidden coins", "Coins you hid with the eye-slash, or by pressing and holding a tile") {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        BasicText("${choices.hidden.size}", style = mono(15.sp, Brand.paper, FontWeight.Medium))
                        if (choices.hidden.isNotEmpty()) { Spacer(Modifier.width(10.dp)); SBtn("Show them again") { choices.unhideAll() } }
                    }
                }
            }
            Section2("Your choices") {
                Line("Copy my choices", "A short code for your hidden coins, name filter and looked-up address. It holds nothing else, and nothing is sent to PINR.") {
                    SBtn(if (copied) "Copied" else "Copy code", tag = "copy-code") {
                        val code = choices.code()
                        (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("PINR choices", code))
                        shown = code; copied = true
                    }
                }
                shown?.let { BasicText(it, Modifier.fillMaxWidth().background(Brand.ink.copy(alpha = 0.5f), RoundedCornerShape(12.dp)).padding(10.dp).testTag("code-box"), style = mono(11.sp, Brand.paper)) }
                Divider2()
                Line("Paste a code", "From another browser or the iPhone app. You will see what it holds before anything changes.") {
                    SBtn("Check code", enabled = pasted.jsTrim().isNotEmpty(), tag = "check-code") {
                        pending = null
                        when (val r = ChoicesCode.read(pasted)) {
                            is ChoicesCode.Read.Ok -> { pending = r.choices; warn = false; message = "This code holds: ${ChoicesCode.summary(r.choices)}. Hidden coins are added to yours; nothing is un-hidden." }
                            is ChoicesCode.Read.Refused -> { warn = true; message = r.why.text }
                        }
                    }
                }
                Box(Modifier.fillMaxWidth().heightIn(min = 64.dp).background(Brand.ink.copy(alpha = 0.5f), RoundedCornerShape(12.dp)).padding(10.dp)) {
                    if (pasted.isEmpty()) BasicText("PINR1.…", style = mono(12.sp, Brand.mute))
                    // A code is typed or pasted exactly: no autocorrect, no capitals.
                    BasicTextField(
                        pasted, { pasted = it; pending = null; message = null }, Modifier.fillMaxWidth().heightIn(min = 44.dp).testTag("code-field"), textStyle = mono(12.sp, Brand.paper), cursorBrush = SolidColor(Brand.lime),
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(autoCorrectEnabled = false, capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.None, keyboardType = androidx.compose.ui.text.input.KeyboardType.Ascii),
                    )
                }
                message?.let { BasicText(it, Modifier.testTag("code-message"), style = sans(13.sp, if (warn) Brand.mandarin else Brand.paper.copy(alpha = 0.85f))) }
                pending?.let { c ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        SBtn("Import", tag = "import-code") {
                            val (added, changed) = choices.apply(c)
                            pending = null; pasted = ""; shown = null; warn = false
                            message = "Imported: $added new hidden ${if (added == 1) "coin" else "coins"}${if (changed) ", and the looked-up address" else ""}."
                        }
                        SBtn("Cancel", quiet = true) { pending = null; message = null }
                    }
                }
            }
            val (status, statusWarn, note) = dataStatus(feed)
            Section2("Data", note = note) {
                Line("Status", null) { BasicText(status, style = sans(13.sp, if (statusWarn) Brand.mandarin else Brand.paper, FontWeight.Medium)) }
            }
            Section2("About") {
                Line("PINR", "Phone-first, living data interface") { BasicText("prototype", style = mono(12.sp, Brand.mute)) }
            }
        }
    }
}

/** A section: its name in small spaced capitals, then its rows on a glass card (style.css .ssec). */
@Composable
private fun Section2(title: String, note: String? = null, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        BasicText(title.uppercase(), Modifier.padding(start = 8.dp), style = mono(11.sp, Brand.mute, FontWeight.SemiBold).copy(letterSpacing = 0.22.em))
        Column(
            Modifier.fillMaxWidth().background(Brand.glass, RoundedCornerShape(24.dp)).border(1.dp, Brand.fg.copy(alpha = 0.1f), RoundedCornerShape(24.dp)).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) { content() }
        note?.let { BasicText(it, Modifier.padding(horizontal = 8.dp), style = sans(12.sp, Brand.mute)) }
    }
}

@Composable
private fun Line(label: String, hint: String?, right: @Composable () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            BasicText(label, style = sans(16.sp, Brand.paper, FontWeight.SemiBold))
            hint?.let { BasicText(it, style = sans(13.sp, Brand.mute)) }
        }
        Spacer(Modifier.width(12.dp))
        right()
    }
}

@Composable
private fun Divider2() = Box(Modifier.fillMaxWidth().padding(0.dp).background(Brand.fg.copy(alpha = 0.08f)).heightIn(min = 1.dp, max = 1.dp))

/** The site's switch (.stoggle): lime when on, with its knob. */
@Composable
private fun Toggle(on: Boolean, set: (Boolean) -> Unit, label: String) {
    val x by animateFloatAsState(if (on) 20f else 0f, label = "knob")
    Box(
        Modifier.size(48.dp, 28.dp).background(if (on) Brand.lime else Brand.fg.copy(alpha = 0.16f), RoundedCornerShape(50))
            .clickable(role = Role.Switch) { set(!on) }.semantics { contentDescription = label; stateDescription = if (on) "On" else "Off" }
            .padding(3.dp),
    ) { Box(Modifier.offset(x.dp).size(22.dp).background(if (on) Brand.ink else Brand.paper, CircleShape)) }
}

/** The site's settings button (.sbtn): a lime-edged capsule; "quiet" is the grey one (Cancel). */
@Composable
private fun SBtn(text: String, quiet: Boolean = false, enabled: Boolean = true, tag: String? = null, onClick: () -> Unit) {
    BasicText(
        text,
        Modifier.background(if (quiet) Color.Transparent else Brand.lime.copy(alpha = 0.12f), RoundedCornerShape(50))
            .border(1.dp, if (quiet) Brand.fg.copy(alpha = 0.2f) else Brand.lime.copy(alpha = 0.45f), RoundedCornerShape(50))
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp, vertical = 8.dp)
            .let { if (tag != null) it.testTag(tag) else it },
        style = sans(14.sp, (if (quiet) Brand.paper else Brand.lime).copy(alpha = if (enabled) 1f else 0.45f), FontWeight.SemiBold),
    )
}
