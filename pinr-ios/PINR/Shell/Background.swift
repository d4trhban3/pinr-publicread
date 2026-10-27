import AVFoundation
import SwiftUI
import UIKit

/// The site's live background (index.html `#bgvid`): its own looping video, muted, filling the screen. Under
/// reduced motion, or if the video cannot play, the poster still frame stays up instead (as the site does in
/// Low Power Mode). In the light look its own scene is shown instead, with no video.
struct LiveBackground: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            Brand.ink
            if scheme == .light {
                // The light look has its own scene in its own colours (the site's pinr-system-teaser-light), no video.
                if let art = UIImage(named: "pinr-bg-light.png") { Image(uiImage: art).resizable().scaledToFill() }
            } else {
                if let poster = UIImage(named: "pinr-bg-poster.jpg") {
                    Image(uiImage: poster).resizable().scaledToFill()
                }
                if !reduceMotion {
                    LoopingVideo(name: "pinr-bg-creep240", ext: "mp4")
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct LoopingVideo: UIViewRepresentable {
    let name: String
    let ext: String

    func makeUIView(context: Context) -> PlayerView {
        let v = PlayerView()
        if let url = Bundle.main.url(forResource: name, withExtension: ext) { v.play(url) }
        return v
    }

    func updateUIView(_ uiView: PlayerView, context: Context) {}

    final class PlayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        private var looper: AVPlayerLooper?
        private let player = AVQueuePlayer()

        func play(_ url: URL) {
            let item = AVPlayerItem(url: url)
            looper = AVPlayerLooper(player: player, templateItem: item)
            player.isMuted = true
            player.preventsDisplaySleepDuringVideoPlayback = false
            (layer as? AVPlayerLayer)?.player = player
            (layer as? AVPlayerLayer)?.videoGravity = .resizeAspectFill
            backgroundColor = .clear
            player.play()
        }
    }
}

/// The site's dot grid (engine/grid.ts): faint dots at a steady on-screen spacing that travel with the camera.
struct DotGrid: View {
    let offset: CGPoint
    let scale: CGFloat

    var body: some View {
        Canvas { ctx, size in
            // Keep the on-screen spacing steady at every zoom, as the site crossfades between grids.
            var step: CGFloat = 28 * scale
            while step < 18 { step *= 2 }
            let ox = offset.x.truncatingRemainder(dividingBy: step)
            let oy = offset.y.truncatingRemainder(dividingBy: step)
            var x = ox - step
            while x < size.width + step {
                var y = oy - step
                while y < size.height + step {
                    ctx.fill(Path(ellipseIn: CGRect(x: x - 0.6, y: y - 0.6, width: 1.2, height: 1.2)), with: .color(Brand.fg.opacity(0.07)))
                    y += step
                }
                x += step
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
