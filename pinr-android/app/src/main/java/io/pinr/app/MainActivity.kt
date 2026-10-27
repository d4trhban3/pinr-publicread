package io.pinr.app

import android.os.Bundle
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import io.pinr.app.feed.FeedLink
import io.pinr.app.feed.FeedStore
import io.pinr.app.ui.PinrApp

class MainActivity : ComponentActivity() {
    /** A `pinr://coin/<address>` link the app was opened with (or handed while running), until the page has used it. */
    private val link = androidx.compose.runtime.mutableStateOf<String?>(null)

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        link.value = intent.dataString
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The bars are transparent; the app sets their icon colour to follow the look (light or dark) while it runs.
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        // The feed's address comes from the build: this Mac's feed in test builds, https://pinr.io in release builds.
        val store = FeedStore(FeedLink.feedUrl(BuildConfig.FEED_URL, release = BuildConfig.HTTPS_ONLY))
        link.value = intent?.dataString
        setContent { PinrApp(store, link.value, onLinkOpened = { link.value = null }) }
    }
}
