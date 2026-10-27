import SwiftUI

/// The site's header (ui/header.ts): one glass bar. Left: Back, the PINR wordmark, the light/dark switch.
/// Centre: the PINR guide button, the quiet lime logo in a small rounded tile (the compass moved to the footer's centre).
/// Right: Discovery pipeline, Diagnostics, the filter funnel and the menu.
struct HeaderBar: View {
    @Environment(Camera.self) private var camera
    @Environment(Look.self) private var look
    @Environment(PinrPrefs.self) private var prefs
    @Environment(\.colorScheme) private var scheme
    @State private var sheet: HeaderSheet?
    /// A panel asked for by another panel (the menu's Settings), opened once the first has closed.
    @State private var next: HeaderSheet?
    /// The PINR guide or the Whitepaper, a full page over the view (opened from the header's centre button).
    @State private var page: HeaderPage?

    var body: some View {
        HStack(spacing: 0) {
            Button { camera.back() } label: { Glyph.back.view(size: 22).frame(width: 34, height: 44).contentShape(Rectangle()) }
                .foregroundStyle(camera.canGoBack ? Brand.lime : Brand.mute.opacity(0.5))
                .frame(width: 34, height: 44)
                .accessibilityLabel("Back")
            WordmarkImage().scaledToFit().frame(height: 17).padding(.leading, 2)
                .accessibilityLabel("PINR")
            Button { look.toggle(from: scheme) } label: { Image(systemName: scheme == .dark ? "sun.max" : "moon").font(.system(size: 17)) }
                .foregroundStyle(Brand.paper)
                .frame(width: 36, height: 44)
                .accessibilityLabel(scheme == .dark ? "Switch to light" : "Switch to dark")
            Spacer(minLength: 4)
            GuideButton { page = $0 }
            Spacer(minLength: 4)
            Button { sheet = .pipeline } label: { Glyph.pipe.view(size: 21).frame(width: 34, height: 44).contentShape(Rectangle()) }.frame(width: 34, height: 44).accessibilityLabel("Discovery pipeline")
            Button { sheet = .diagnostics } label: { Glyph.diag.view(size: 21).frame(width: 34, height: 44).contentShape(Rectangle()) }.frame(width: 34, height: 44).accessibilityLabel("Diagnostics")
            Button { sheet = .filters } label: {
                Glyph.filter.view(size: 21).overlay(alignment: .topTrailing) {
                    Circle().fill(Brand.lime).frame(width: 6, height: 6).offset(x: 1, y: -1)
                }
                .frame(width: 34, height: 44).contentShape(Rectangle())
            }
            .foregroundStyle(camera.room == .pinr && !camera.map ? Brand.lime : Brand.lime.opacity(0.55))
            .frame(width: 34, height: 44)
            .accessibilityLabel("Filters")
            Button { sheet = .menu } label: { Glyph.menu.view(size: 22).frame(width: 38, height: 44).contentShape(Rectangle()) }.frame(width: 38, height: 44).accessibilityLabel("Menu")
        }
        .foregroundStyle(Brand.paper)
        .padding(.horizontal, 8)
        .frame(height: 52)
        .background(Capsule().fill(Brand.glass))
        .shadow(color: .black.opacity(0.35), radius: 1, y: 1)
        .shadow(color: .black.opacity(0.5), radius: 14, y: 8)
        .fullScreenCover(item: $page) { p in HeaderPageView(page: p) { page = nil } }
        .sheet(item: $sheet, onDismiss: { if let n = next { next = nil; sheet = n } }) { s in
            // A panel may open another (the menu's Settings): this one closes, then that one opens.
            HeaderSheetView(kind: s) { next = $0; sheet = nil }
                .presentationDetents(s == .settings ? [.large] : [.medium]).presentationBackground(Brand.panel)
        }
    }
}

enum HeaderPage: String, Identifiable { case guide, whitepaper; var id: String { rawValue } }

enum HeaderSheet: String, Identifiable { case pipeline, diagnostics, filters, menu, settings; var id: String { rawValue } }

/// The compass (ui/compass.ts): a game-controller d-pad with the PINR blade at its heart, drawn from the site's 44-point
/// pad. The arm toward the room you are in lights lime (a corner dot for an ad space, the hub for the PINR page), and the
/// blade turns its tip toward that room, the short way round. On the whole map the pad glows lime; tapping it there
/// does nothing more (Back flies in again), as on the site.
struct Compass: View {
    let room: Room
    let map: Bool
    let tap: () -> Void
    @State private var angle: Double = 180

    var body: some View {
        Button(action: { if !map { tap() } }) {
            ZStack(alignment: .topLeading) {
                arm(.arena, x: 15, y: 1.5, w: 14, h: 15)
                arm(.terminal, x: 15, y: 27.5, w: 14, h: 15)
                arm(.discover, x: 1.5, y: 15, w: 15, h: 14)
                arm(.wallet, x: 27.5, y: 15, w: 15, h: 14)
                dot(.adNW, 7, 7); dot(.adNE, 37, 7); dot(.adSW, 7, 37); dot(.adSE, 37, 37)
                Circle().fill(Brand.glass.opacity(0.95)).frame(width: 22, height: 22).offset(x: 11, y: 11)
                Circle().strokeBorder(room == .pinr && !map ? Brand.lime : Brand.fg.opacity(0.2), lineWidth: room == .pinr && !map ? 1.6 : 1)
                    .frame(width: 22, height: 22).offset(x: 11, y: 11)
                    .shadow(color: room == .pinr && !map ? Brand.lime.opacity(0.8) : .clear, radius: 3)
                Image("pinr-blade-large").resizable().scaledToFit().frame(width: 3.6, height: 30)
                    .rotationEffect(.degrees(angle))
                    .offset(x: 22 - 1.8, y: 22 - 15)
            }
            .frame(width: 44, height: 44, alignment: .topLeading)
            .frame(width: 52, height: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScale())
        .onAppear { angle = Self.needle(room) }
        .onChange(of: room) {
            // Turn the short way round, never the long way.
            let target = Self.needle(room)
            let turn = (target - angle + 540).truncatingRemainder(dividingBy: 360) - 180
            withAnimation(.spring(response: 0.6, dampingFraction: 0.6)) { angle += turn }
        }
        .accessibilityLabel("See the whole site. You are in \(room.title).")
        .accessibilityIdentifier("compass")
    }

    /// Degrees clockwise from north of each room, seen from the centre (compass.ts BEARING); the art's tip points down,
    /// so it turns 180 more; at the centre it rests upright.
    nonisolated static func needle(_ r: Room) -> Double {
        let bearing: Double? = switch r {
        case .arena: 0
        case .adNE: 45
        case .wallet: 90
        case .adSE: 135
        case .terminal: 180
        case .adSW: 225
        case .discover: 270
        case .adNW: 315
        case .pinr: nil
        }
        return bearing.map { $0 + 180 } ?? 0
    }

    private func fill(lit: Bool) -> Color {
        if map { return Brand.lime.opacity(0.4) }
        return lit ? Brand.lime : Brand.fg.opacity(0.16)
    }

    private func arm(_ r: Room, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) -> some View {
        let lit = room == r && !map
        return RoundedRectangle(cornerRadius: 4.5).fill(fill(lit: lit)).frame(width: w, height: h)
            .shadow(color: lit ? Brand.lime.opacity(0.8) : .clear, radius: 2)
            .offset(x: x, y: y)
    }

    private func dot(_ r: Room, _ cx: CGFloat, _ cy: CGFloat) -> some View {
        let lit = room == r && !map
        return Circle().fill(map ? Brand.lime.opacity(0.4) : lit ? Brand.lime : Brand.fg.opacity(0.22)).frame(width: 4, height: 4)
            .offset(x: cx - 2, y: cy - 2)
    }
}

/// The header's centre "PINR GUIDE" button (the PINR wordmark and its matching GUIDE wordmark): a tap offers the PINR guide or the Whitepaper, each a full page over the view.
struct GuideButton: View {
    @Environment(\.colorScheme) private var scheme
    let choose: (HeaderPage) -> Void
    @State private var asking = false

    var body: some View {
        Button { asking = true } label: {
            HStack(spacing: 5) {
                WordmarkImage().scaledToFit().frame(height: 13)
                Image(scheme == .light ? "guide-wordmark-light" : "guide-wordmark").resizable().scaledToFit().frame(height: 13)
            }
            .padding(.horizontal, 10).frame(height: 40)
            .background(Capsule().fill(Brand.fg.opacity(0.07)))
            .overlay(Capsule().strokeBorder(Brand.fg.opacity(0.14), lineWidth: 1))
            .frame(height: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScale())
        .accessibilityLabel("PINR guide")
        .accessibilityIdentifier("guide-button")
        .confirmationDialog("PINR guide", isPresented: $asking) {
            Button("PINR guide") { choose(.guide) }
            Button("Whitepaper") { choose(.whitepaper) }
            Button("Cancel", role: .cancel) {}
        }
    }
}

/// The guide or the Whitepaper as a full page over the view, with its own back button.
struct HeaderPageView: View {
    let page: HeaderPage
    let close: () -> Void

    var body: some View {
        // The background sits behind the page (not beside it), so its picture never widens the page past the screen.
        ZStack {
            VStack(spacing: 0) {
                HStack {
                    Button(action: close) { Glyph.back.view(size: 22).frame(width: 44, height: 44) }
                        .foregroundStyle(Brand.lime).accessibilityLabel("Close")
                    Text(page == .guide ? "PINR guide" : "Whitepaper").font(Typo.sans(17, .semibold)).foregroundStyle(Brand.paper)
                    Spacer()
                }
                .padding(.horizontal, 8)
                if page == .guide {
                    GuideRoom(insets: RoomInsets(top: 8, bottom: 24))
                } else {
                    // One card with its icon and "Coming soon", and a note under it (the site's whitepaper page).
                    VStack(spacing: 14) {
                        VStack(spacing: 12) {
                            Image(systemName: "doc.text").font(.system(size: 36)).foregroundStyle(Brand.lime)
                            Text("Coming soon").font(Typo.sans(20, .bold)).foregroundStyle(Brand.paper)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 36)
                        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Brand.fg.opacity(0.05)))
                        Text("The PINR whitepaper will be read here.").font(Typo.sans(13)).foregroundStyle(Brand.mute)
                    }
                    .padding(.horizontal, 16).padding(.top, 12)
                    .frame(maxHeight: .infinity, alignment: .top)
                }
            }
        }
        // A plain page, as the site's: the same solid panel as Settings, no moving art behind it.
        .background { Brand.panel.ignoresSafeArea() }
    }
}

/// The site's press: the control shrinks to 92% while held.
struct PressScale: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.scaleEffect(configuration.isPressed ? 0.92 : 1).animation(.easeOut(duration: 0.2), value: configuration.isPressed)
    }
}

/// The site's footer (ui/tabbar.ts): five tabs in the same glass. Discover | PINR | the PINR guide (a lime
/// button, the centre of the map) | PINRbot DeepScan | Wallet and profile. Each tab flies the camera to its room.
struct FooterBar: View {
    @Environment(Camera.self) private var camera

    var body: some View {
        HStack(spacing: 0) {
            tab(.discover); tab(.pinr)
            // The compass at the centre: where you are, and a tap pulls back to the whole map ("see the whole site").
            Compass(room: camera.room, map: camera.map) { camera.toggleMap() }.frame(maxWidth: .infinity).frame(height: 48)
            tab(.terminal); tab(.wallet)
        }
        .padding(.horizontal, 4)
        .frame(height: 56)
        .background(Capsule().fill(Brand.glass))
        .shadow(color: .black.opacity(0.35), radius: 1, y: 1)
        .shadow(color: .black.opacity(0.55), radius: 14, y: -6)
    }

    private func tab(_ r: Room) -> some View {
        Button { camera.go(r) } label: { label(r).frame(maxWidth: .infinity).frame(height: 48).contentShape(Rectangle()) }
            .accessibilityLabel(r == .terminal ? "PINRbot DeepScan" : r.title)
            .accessibilityAddTraits(on(r) ? .isSelected : [])
            .accessibilityIdentifier("tab-\(r.rawValue)")
    }

    private func on(_ r: Room) -> Bool { !camera.map && camera.room == r }

    @ViewBuilder private func label(_ r: Room) -> some View {
        let lit = on(r)
        VStack(spacing: 3) {
            switch r {
            case .pinr:
                // The wordmark with a small "page" centred below it (the site's `wmpage`).
                VStack(spacing: 1) {
                    WordmarkImage().scaledToFit().frame(height: 14)
                    Text("page").font(Typo.fmono(9, .medium)).foregroundStyle(lit ? Brand.lime : Brand.mute)
                }
                .opacity(lit ? 1 : 0.7)
            case .discover:
                Glyph.discover.view(size: 24).foregroundStyle(lit ? Brand.lime : Brand.mute)
            case .terminal:
                Glyph.deepscan.view(size: 24).foregroundStyle(lit ? Brand.lime : Brand.mute)
            default:
                Glyph.wallet.view(size: 24).foregroundStyle(lit ? Brand.lime : Brand.mute)
            }
        }
        .overlay(alignment: .bottom) {
            if lit && r != .pinr { Circle().fill(Brand.lime).frame(width: 4, height: 4).offset(y: 9) }
        }
    }
}

/// The light/dark look: follows the phone until the person taps the sun or moon, as on the site.
@MainActor
@Observable
final class Look {
    var choice: ColorScheme?

    func toggle(from current: ColorScheme) {
        choice = current == .dark ? .light : .dark
        UserDefaults.standard.set(choice == .light ? "light" : "dark", forKey: "pinr.theme")
    }

    init() {
        switch UserDefaults.standard.string(forKey: "pinr.theme") {
        case "light": choice = .light
        case "dark": choice = .dark
        default: choice = nil
        }
    }
}
