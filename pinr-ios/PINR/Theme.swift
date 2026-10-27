import SwiftUI
import UIKit

/// The site's design tokens (pinr-live/src/style.css, `:root` and `[data-theme="light"]`): one live accent
/// (lime) on ink, in a dark and a light look. Every colour follows the look the person chose.
enum Brand {
    static let ink = dyn(0x0A0C0E, 0xEBE4F7)
    /// The text colour (the site's `--text`).
    static let paper = dyn(0xF4EEFF, 0x14161C)
    static let mute = dyn(0x9AA1AE, 0x434A58)
    /// The live accent (`--live`).
    static let lime = dyn(0xD6FF3C, 0x587A00)
    static let mandarin = dyn(0xFF8C1A, 0xD96100)
    static let amber = dyn(0xFFD24A, 0x8A6400)
    static let lilac = Color(hex: 0xCDB6FE)
    static let violet = Color(hex: 0x6C4DFB)
    /// Text on a lime field (`--on-live`).
    static let onLive = dyn(0x0A0C0E, 0xFFFFFF)
    /// Tile glass: black at 80% in the dark look, white at 80% in the light one (`--glass-rgb`).
    static let glass = Color(UIColor { $0.userInterfaceStyle == .light ? UIColor(red: 245 / 255, green: 241 / 255, blue: 251 / 255, alpha: 0.9) : UIColor(white: 0, alpha: 0.8) })
    /// Hairlines, rims and soft fills (`--fg-rgb`), used at low opacity.
    static let fg = dyn(0xFFFFFF, 0x0E121C)
    /// Menus and sheets (`--panel-rgb`).
    static let panel = dyn(0x0A0C0E, 0xF2EEF9)
    /// Kept for older call sites: the glass the cards sit on.
    static let card = glass

    /// The PINRscore colour scale: mandarin at 25 and below, lime at 95 and above, a smooth blend between (scorecolor.ts).
    static func score(_ s: Int) -> Color {
        let t = min(1, max(0, (Double(s) - 25) / 70))
        return Color(UIColor { tr in
            let light = tr.userInterfaceStyle == .light
            let lo: (Double, Double, Double) = light ? (217, 97, 0) : (255, 140, 26)
            let hi: (Double, Double, Double) = light ? (88, 122, 0) : (214, 255, 60)
            return UIColor(red: (lo.0 + (hi.0 - lo.0) * t) / 255, green: (lo.1 + (hi.1 - lo.1) * t) / 255,
                           blue: (lo.2 + (hi.2 - lo.2) * t) / 255, alpha: 1)
        })
    }

    private static func dyn(_ dark: UInt32, _ light: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .light ? UIColor(hex: light) : UIColor(hex: dark) })
    }
}

/// The site's type: SF on Apple devices (the site's `--font` puts -apple-system first), and the system monospace for figures.
/// Reading text follows the phone's text size (Settings > Display > Text Size, and Larger Text), up to 1.6 times;
/// the tiles, the header and the footer keep the site's fixed design sizes (`fsans`, `fmono`).
enum Typo {
    /// Set by the app shell on the main thread; read while drawing.
    nonisolated(unsafe) static var scale: CGFloat = 1

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size * scale, weight: weight, design: .monospaced) }
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size * scale, weight: weight) }
    static func fmono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight, design: .monospaced) }
    static func fsans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight) }

    /// How much larger reading text is drawn for the phone's text size.
    static func factor(_ d: DynamicTypeSize) -> CGFloat {
        switch d {
        case .xSmall: 0.82
        case .small: 0.88
        case .medium: 0.94
        case .large: 1
        case .xLarge: 1.12
        case .xxLarge: 1.24
        case .xxxLarge: 1.35
        case .accessibility1: 1.45
        default: 1.6
        }
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

extension Color {
    init(hex: UInt32) { self.init(uiColor: UIColor(hex: hex)) }
}

/// The site's glass: black at 80% with a bright top-left rim and a dim bottom-right rim, lifted off the background.
struct Glass: ViewModifier {
    var radius: CGFloat
    var heat: Double = 0
    @Environment(\.colorScheme) private var scheme
    /// The light look's tile rim: violet (108, 77, 251) at 24%, with a violet-tinted shadow (the site's light palette, 2026-10-25).
    private var violet: Color { Color(red: 108 / 255, green: 77 / 255, blue: 251 / 255) }

    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Brand.glass))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(scheme == .light ? AnyShapeStyle(violet.opacity(0.24))
                                  : AnyShapeStyle(LinearGradient(colors: [Brand.fg.opacity(0.3), Brand.fg.opacity(0.045), Brand.fg.opacity(0.1)],
                                                                 startPoint: .topLeading, endPoint: .bottomTrailing)), lineWidth: 1)
            )
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Brand.lime.opacity(0.55 * heat), lineWidth: 1)
            )
            .shadow(color: scheme == .light ? violet.opacity(0.10) : .black.opacity(0.35), radius: 1, y: 1)
            .shadow(color: scheme == .light ? violet.opacity(0.16) : .black.opacity(0.4), radius: 14, y: 10)
            .shadow(color: Brand.lime.opacity(0.28 * heat), radius: 13 * heat)
    }
}

extension View {
    func glass(_ radius: CGFloat, heat: Double = 0) -> some View { modifier(Glass(radius: radius, heat: heat)) }
}

/// The PINR wordmark in the look's own file: the light one (art pack 65: the letters and the blade's body in ink) in the light look, never the dark one turned over.
struct WordmarkImage: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View { Image(scheme == .light ? "pinr-wordmark-light" : "pinr-wordmark").resizable() }
}
