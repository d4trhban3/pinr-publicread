package io.pinr.app.ui

import android.content.Context
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.media.MediaPlayer
import android.net.Uri
import android.provider.Settings
import android.view.Surface
import android.view.TextureView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import io.pinr.app.R

/**
 * The site's live background (index.html `#bgvid`): its own looping video, muted, filling the screen and oversized 7%
 * each side (style.css `#bg video`). Under reduced motion (animations off), or until the video plays, the poster still
 * frame stays up instead, as the site does in Low Power Mode. The dot grid over it moves with the camera (WorldView).
 */
@Composable
fun LiveBackground(on: Boolean = true) {
    val ctx = LocalContext.current
    val motion = remember { Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f }
    Box(Modifier.fillMaxSize().background(Brand.ink)) {
        // Settings › Display › Live background off: the plain ink, as on the site.
        if (!on) return@Box
        if (ThemeState.light) {
            // The light look has its own scene in its own colours (the site's pinr-system-teaser-light), no video.
            Image(painterResource(R.drawable.pinr_bg_light), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            return@Box
        }
        Image(painterResource(R.drawable.pinr_bg_poster), null, Modifier.fillMaxSize().scale(1.14f), contentScale = ContentScale.Crop)
        if (motion) {
            AndroidView(factory = { LoopingVideo(it, R.raw.pinr_bg_creep240) }, modifier = Modifier.fillMaxSize().scale(1.14f), onRelease = { it.release() })
        }
    }
}

/**
 * The site's dot grid (engine/grid.ts): faint dots at a steady on-screen spacing that travel with the camera; as the
 * camera pulls back the spacing doubles, so the dots never crowd.
 */
@Composable
fun DotGrid(x: () -> Float, y: () -> Float, scale: () -> Float) {
    Canvas(Modifier.fillMaxSize()) {
        var step = 28.dp.toPx() * scale()
        while (step < 18.dp.toPx()) step *= 2
        val r = 0.6.dp.toPx()
        val c = Brand.fg.copy(alpha = 0.07f)
        var gx = x().mod(step) - step
        while (gx < size.width + step) {
            var gy = y().mod(step) - step
            while (gy < size.height + step) { drawCircle(c, r, Offset(gx, gy)); gy += step }
            gx += step
        }
    }
}

/** A muted, looping video drawn to fill its view (cropped, never stretched), with no sound focus taken. */
private class LoopingVideo(context: Context, private val raw: Int) : TextureView(context), TextureView.SurfaceTextureListener {
    private var player: MediaPlayer? = null
    private var surface: Surface? = null

    init {
        isOpaque = false
        surfaceTextureListener = this
    }

    override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
        val s = Surface(st).also { surface = it }
        player = MediaPlayer().apply {
            setDataSource(context, Uri.parse("android.resource://${context.packageName}/$raw"))
            setSurface(s)
            isLooping = true
            setVolume(0f, 0f)
            setOnVideoSizeChangedListener { _, w, h -> crop(w, h) }
            setOnPreparedListener { it.start() }
            setOnErrorListener { _, _, _ -> true } // the poster stays up
            prepareAsync()
        }
    }

    private fun crop(vw: Int, vh: Int) {
        if (vw == 0 || vh == 0 || width == 0 || height == 0) return
        val k = maxOf(width.toFloat() / vw, height.toFloat() / vh)
        setTransform(Matrix().apply { setScale(vw * k / width, vh * k / height, width / 2f, height / 2f) })
    }

    override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) {
        player?.let { crop(it.videoWidth, it.videoHeight) }
    }

    override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
        release()
        return true
    }

    override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}

    fun release() {
        player?.release()
        player = null
        surface?.release()
        surface = null
    }
}
