import AppKit
import WebKit
import AVFoundation

// usage: render page.html out.mp4 width height fps seconds [previewFramesDir]
let a = CommandLine.arguments
let pageURL = URL(fileURLWithPath: a[1]), outURL = URL(fileURLWithPath: a[2])
let W = Int(a[3])!, H = Int(a[4])!, fps = Int(a[5])!, seconds = Double(a[6])!
let previewDir: String? = a.count > 7 ? a[7] : nil
let total = Int(seconds * Double(fps))

NSApplication.shared.setActivationPolicy(.accessory)
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: W, height: H))
let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: W, height: H), styleMask: [.borderless], backing: .buffered, defer: false)
win.contentView = web
win.alphaValue = 0.01
win.ignoresMouseEvents = true
win.orderFrontRegardless()

try? FileManager.default.removeItem(at: outURL)
let writer = try! AVAssetWriter(outputURL: outURL, fileType: .mp4)
let settings: [String: Any] = [
  AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H,
  AVVideoCompressionPropertiesKey: [
    AVVideoQualityKey: 0.75, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoMaxKeyFrameIntervalKey: fps * 2, AVVideoExpectedSourceFrameRateKey: fps, AVVideoAllowFrameReorderingKey: false,
  ] as [String: Any],
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H,
])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

final class Loader: NSObject, WKNavigationDelegate {
  var done: (() -> Void)?
  func webView(_ w: WKWebView, didFinish n: WKNavigation!) { done?() }
}
let loader = Loader()
web.navigationDelegate = loader

func pixelBuffer(from image: NSImage) -> CVPixelBuffer? {
  var pb: CVPixelBuffer?
  CVPixelBufferCreate(nil, W, H, kCVPixelFormatType_32BGRA, [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &pb)
  guard let buf = pb, var rect = Optional(CGRect(x: 0, y: 0, width: image.size.width, height: image.size.height)),
        let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return nil }
  CVPixelBufferLockBaseAddress(buf, [])
  let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: W, height: H, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buf),
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
  ctx.interpolationQuality = .high
  ctx.draw(cg, in: CGRect(x: 0, y: 0, width: W, height: H))
  CVPixelBufferUnlockBaseAddress(buf, [])
  return buf
}

@MainActor func run() async {
  await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
    loader.done = { c.resume() }
    web.loadFileURL(pageURL, allowingReadAccessTo: pageURL.deletingLastPathComponent())
  }
  print("page loaded")
  try? await Task.sleep(nanoseconds: 500_000_000)
  let started = Date()
  for i in 0..<total {
    let t = Double(i) / Double(fps)
    _ = try? await web.callAsyncJavaScript("return await seek(t)", arguments: ["t": t], in: nil, contentWorld: .page)
    try? await Task.sleep(nanoseconds: 40_000_000)
    let cfg = WKSnapshotConfiguration()
    cfg.snapshotWidth = NSNumber(value: W)
    let img: NSImage? = await withCheckedContinuation { c in web.takeSnapshot(with: cfg) { image, _ in c.resume(returning: image) } }
    guard let image = img, let buf = pixelBuffer(from: image) else { print("snapshot failed at frame \(i)"); exit(1) }
    while !input.isReadyForMoreMediaData { try? await Task.sleep(nanoseconds: 2_000_000) }
    adaptor.append(buf, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: CMTimeScale(fps)))
    if let d = previewDir, [0, total / 4, total / 2, total - 1].contains(i) {
      let rep = NSBitmapImageRep(cgImage: image.cgImage(forProposedRect: nil, context: nil, hints: nil)!)
      try? rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(d)/frame_\(i).png"))
    }
    if i % 60 == 0 { print("frame \(i)/\(total)  \(Int(Date().timeIntervalSince(started)))s elapsed") }
  }
  input.markAsFinished()
  await writer.finishWriting()
  print("finished:", writer.status.rawValue, writer.error as Any)
  exit(writer.status == .completed ? 0 : 1)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 900) { print("WATCHDOG: no progress after 25s; navigation finished? \(loader.done == nil)"); exit(3) }
print("starting")
Task { await run() }
RunLoop.main.run()
