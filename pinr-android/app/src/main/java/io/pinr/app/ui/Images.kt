package io.pinr.app.ui

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import java.net.HttpURLConnection
import java.net.URL
import java.util.Collections
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

/**
 * Coin pictures, read only from the feed server's `/api/img` (Token.sameServer has already dropped anything else), made
 * small for a tile and kept in memory. No outside image library (PLAN.md): a plain read and Android's own decoder.
 */
object Images {
    private const val TARGET_PX = 128
    private val cache = LruCache<String, ImageBitmap>(400)
    private val failed = Collections.synchronizedSet(HashSet<String>())
    private val gate = Semaphore(6)

    fun cached(url: String?): ImageBitmap? = url?.let { cache.get(it) }

    suspend fun load(url: String): ImageBitmap? {
        cache.get(url)?.let { return it }
        if (url in failed) return null
        return gate.withPermit {
            withContext(Dispatchers.IO) {
                cache.get(url) ?: try {
                    val c = URL(url).openConnection() as HttpURLConnection
                    try {
                        c.connectTimeout = 8000
                        c.readTimeout = 15000
                        c.instanceFollowRedirects = false
                        if (c.responseCode != 200) null else {
                            val bytes = c.inputStream.use { it.readBytes() }
                            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                            var sample = 1
                            while (bounds.outWidth / (sample * 2) >= TARGET_PX && bounds.outHeight / (sample * 2) >= TARGET_PX) sample *= 2
                            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                                ?.asImageBitmap()?.also { cache.put(url, it) }
                        }
                    } finally {
                        c.disconnect()
                    }
                } catch (e: Exception) {
                    null
                }.also { if (it == null) failed += url }
            }
        }
    }
}

/** A feed picture, or nothing until it has loaded (what is under it shows: the tile's soft disc and initial). */
@Composable
fun FeedImage(url: String?, modifier: Modifier = Modifier) {
    val bmp by produceState(Images.cached(url), url) { value = url?.let { Images.load(it) } }
    bmp?.let { Image(it, null, modifier, contentScale = ContentScale.Crop) }
}
