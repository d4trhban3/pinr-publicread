import SwiftUI
import UIKit
import VisionKit

/// Wallet (east on the map), in the site's look (ui/wallet.ts, style.css .wl*), view-only since the title,
/// the "View-only" card, "Look up an address" (typed, pasted, or scanned from a QR code), then the address's card and the
/// tracked tokens it holds. Only a public address is ever used; nothing connects to a wallet.
struct WalletRoom: View {
    let insets: RoomInsets
    @Environment(WalletStore.self) private var wallet
    @Environment(FeedStore.self) private var store
    @Environment(CoinSelection.self) private var selection
    @Environment(Camera.self) private var camera

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Wallet").font(Typo.sans(34, .bold)).tracking(-1).foregroundStyle(Brand.paper)
                    Text(wallet.address == nil ? "Look up what a public wallet address holds." : "What this public address holds.")
                        .font(Typo.sans(14)).foregroundStyle(Brand.mute)
                }
                .padding(.top, 4).padding(.bottom, 2)
                if let address = wallet.address {
                    ProfileCard(address: address, chain: wallet.chain) { wallet.clear() }
                    SafetyCard(compact: true)
                    Rule().padding(.top, 10)
                    holdings
                    Rule().padding(.bottom, 8)
                    Text("Everything here is read from public blockchain data for this one address. PINR is a research tool, not investment advice.")
                        .font(Typo.sans(11)).foregroundStyle(Brand.mute)
                } else {
                    SafetyCard(compact: false)
                    Rule().padding(.top, 14)
                    AddressEntry()
                }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 20)
        }
        .safeAreaPadding(.top, insets.top)
        .safeAreaPadding(.bottom, insets.bottom)
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.immediately)
        .task(id: wallet.address) { await wallet.watch(store.baseURL) }
    }

    @ViewBuilder private var holdings: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Tracked tokens held").font(Typo.sans(21, .bold)).foregroundStyle(Brand.paper)
            switch wallet.reading {
            case .idle, .loading:
                Text("Reading the chain…").modifier(Hint())
            case .failed:
                Text("This wallet's balances are not read yet. PINR asks again shortly.").modifier(Hint())
            case .loaded(let v):
                if v.status == "partial" {
                    Text("Not read yet on \(v.unavailable.map(ChainName.of).joined(separator: ", ")). What is shown is real; it may be incomplete.").modifier(Hint())
                }
                if v.status == "error" {
                    Text("This wallet's balances are not read yet. PINR asks again shortly.").modifier(Hint())
                } else if v.holdings.isEmpty {
                    Text("This wallet holds none of the tokens PINR tracks right now.").modifier(Hint())
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Value of tracked tokens held").font(Typo.mono(10.5)).foregroundStyle(Brand.mute)
                        Text(v.totalUsd.map(Self.usd) ?? Format.dash).font(Typo.sans(28, .bold)).monospacedDigit().foregroundStyle(Brand.paper)
                    }
                    .padding(.bottom, 4)
                    if v.holdings.contains(where: { $0.score != nil }) {
                        Text("Social presence unchecked until the X API is connected. This score reads the chain only.").modifier(Hint())
                    }
                    ForEach(v.holdings) { h in row(h) }
                    Text("Only tokens PINR tracks are listed. Tokens without a price are left out of the total.").modifier(Hint()).padding(.top, 4)
                }
            }
        }
        .padding(.top, 8)
    }

    private func row(_ h: WalletView.Holding) -> some View {
        let found = store.all.first { $0.address.lowercased() == h.address.lowercased() }
        return Button { if let t = found { selection.id = t.id; camera.go(.terminal) } } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(rude(h) ? NameFilter.maskedTitle : (h.name ?? WalletRules.short(h.address))).font(Typo.sans(15, .semibold)).foregroundStyle(Brand.paper).lineLimit(1)
                    Text("\(rude(h) ? NameFilter.maskedTicker : (h.ticker ?? "")) · \(Self.compact(h.balance))").font(Typo.mono(11)).foregroundStyle(Brand.mute).lineLimit(1)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(h.usd.map(Self.usd) ?? "no price").font(Typo.mono(13, .bold)).foregroundStyle(Brand.paper)
                    HStack(spacing: 6) {
                        if let l = h.noScoreLabel { Text(l).font(Typo.sans(12, .bold)).foregroundStyle(Brand.mandarin) }
                        else if let s = h.score {
                            Text(String(s)).font(Typo.sans(13, .semibold)).foregroundStyle(Brand.score(s))
                            Text("Chain only").font(Typo.mono(9.5)).foregroundStyle(Brand.lilac)
                        } else { Text(Format.dash).foregroundStyle(Brand.mute) }
                    }
                }
            }
            .frame(minHeight: 58)
            .overlay(alignment: .bottom) { Rectangle().fill(Brand.fg.opacity(0.06)).frame(height: 1) }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScale())
        .disabled(found == nil)
    }

    private func rude(_ h: WalletView.Holding) -> Bool { NameFilter.enabled && (NameFilter.isRude(h.name) || NameFilter.isRude(h.ticker)) }

    /// Dollars for a holding: whole-dollar style from $1 up, the exact small amount below (never a misleading "$0").
    static func usd(_ v: Double) -> String { v >= 1 ? Format.usdCompact(v) : Format.priceCompact(v) }

    /// "1.2K", "3.4M" (the site's compact notation).
    static func compact(_ v: Double) -> String {
        v.formatted(.number.notation(.compactName).precision(.fractionLength(0...2)).locale(Locale(identifier: "en_US")))
    }
}

private struct Hint: ViewModifier {
    func body(content: Content) -> some View { content.font(Typo.sans(13)).foregroundStyle(Brand.mute).lineSpacing(3) }
}

/// The site's "View-only" card: all three points with no address; on an address, the short line and
/// "What view-only means" folded.
private struct SafetyCard: View {
    let compact: Bool
    @State private var more = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.shield").font(.system(size: 20)).accessibilityHidden(true)
                Text(WalletRules.viewOnlyTitle).font(Typo.sans(17, .semibold))
            }
            .foregroundStyle(Brand.lime)
            if compact {
                Text(WalletRules.viewOnlyShort).font(Typo.sans(13.5)).foregroundStyle(Brand.paper)
                DisclosureGroup("What view-only means", isExpanded: $more) { points.padding(.top, 6) }
                    .font(Typo.sans(13, .semibold)).tint(Brand.lime)
            } else {
                points
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Brand.lime.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Brand.lime.opacity(0.35), lineWidth: 1))
    }

    private var points: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(WalletRules.viewOnlyPoints, id: \.self) { p in
                HStack(alignment: .firstTextBaseline, spacing: 8) { Text("•").accessibilityHidden(true); Text(p) }
                    .font(Typo.sans(13.5)).foregroundStyle(Brand.paper)
            }
        }
    }
}

/// "Look up an address": type, paste, or scan a QR code. Nothing is connected and no wallet app is involved.
private struct AddressEntry: View {
    @Environment(WalletStore.self) private var wallet
    @State private var text = ""
    @State private var error: String?
    @State private var scanning = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Look up an address").font(Typo.sans(21, .bold)).foregroundStyle(Brand.paper)
            Text("Paste any wallet address to see which tokens PINR tracks it holds. Nothing is connected and no wallet app is involved.")
                .font(Typo.sans(13)).foregroundStyle(Brand.mute)
            HStack(spacing: 8) {
                TextField("", text: $text, prompt: Text("0x… or a Solana address").foregroundStyle(Brand.mute))
                    .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.go)
                    .font(Typo.mono(14, .medium)).foregroundStyle(Brand.paper)
                    .padding(.horizontal, 14).frame(height: 48)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Brand.fg.opacity(0.08)))
                    .onSubmit(run)
                    .accessibilityIdentifier("wallet-address")
                Button(action: run) {
                    Text("View").font(Typo.sans(15, .semibold)).foregroundStyle(Brand.onLive)
                        .padding(.horizontal, 20).frame(height: 48)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Brand.lime))
                }
            }
            HStack(spacing: 8) {
                // The system's paste button: it reads the clipboard only when tapped, with no permission prompt.
                PasteButton(payloadType: String.self) { strings in
                    if let s = strings.first { Task { @MainActor in text = s; run() } }
                }
                .buttonBorderShape(.capsule).tint(Brand.fg.opacity(0.12)).labelStyle(.titleAndIcon)
                if Scanner.available {
                    Button { scanning = true } label: {
                        Label("Scan a QR code", systemImage: "qrcode.viewfinder").font(Typo.sans(13, .semibold))
                            .foregroundStyle(Brand.paper).padding(.horizontal, 14).frame(height: 34)
                            .background(Capsule().fill(Brand.fg.opacity(0.09)))
                    }
                }
            }
            if let error { Text(error).font(Typo.sans(13)).foregroundStyle(Brand.mandarin) }
        }
        .padding(.top, 8)
        .sheet(isPresented: $scanning) {
            Scanner { code in scanning = false; text = code; run() }.ignoresSafeArea()
        }
    }

    private func run() { error = wallet.view(text) }
}

/// The profile card: the address's own colours, its short form, its chain, "Viewing only", Copy and Clear.
private struct ProfileCard: View {
    let address: String
    let chain: WalletRules.Chain?
    let clear: () -> Void
    @State private var copied = false

    var body: some View {
        let (a, b, c) = WalletRules.avatarHues(address)
        VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .center, spacing: 14) {
            Circle()
                .fill(RadialGradient(colors: [Color(hue: a / 360, saturation: 0.85, brightness: 0.95), Color(hue: b / 360, saturation: 0.8, brightness: 0.85),
                                              Color(hue: c / 360, saturation: 0.75, brightness: 0.7)], center: UnitPoint(x: 0.3, y: 0.25), startRadius: 0, endRadius: 40))
                .overlay(Circle().strokeBorder(Brand.fg.opacity(0.25), lineWidth: 2))
                .frame(width: 64, height: 64)
            VStack(alignment: .leading, spacing: 10) {
                Text(WalletRules.short(address)).font(Typo.mono(19, .semibold)).foregroundStyle(Brand.paper)
                HStack(spacing: 6) {
                    chip(chain == .solana ? "Solana" : "BNB Chain · Base", on: false)
                    chip("Viewing only", on: false)
                }
            }
            Spacer(minLength: 0)
        }
        // The site's actions row sits under the address, on its own line.
        HStack(spacing: 8) {
            Button(copied ? "Copied" : "Copy") { UIPasteboard.general.string = address; copied = true }.buttonStyle(Small(warn: false))
            Button("Clear", action: clear).buttonStyle(Small(warn: true))
        }
        }
        .padding(16)
        .glass(22)
    }

    private func chip(_ t: String, on: Bool) -> some View {
        Text(t).font(Typo.sans(11.5, .medium)).foregroundStyle(on ? Brand.lime : Brand.mute)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 12).fill(on ? Brand.lime.opacity(0.16) : Brand.fg.opacity(0.08)))
    }

    private struct Small: ButtonStyle {
        let warn: Bool
        func makeBody(configuration: Configuration) -> some View {
            configuration.label.font(Typo.sans(13, .semibold)).foregroundStyle(warn ? Brand.mandarin : Brand.paper)
                .padding(.horizontal, 16).frame(height: 36).background(Capsule().fill(Brand.fg.opacity(0.09)))
                .opacity(configuration.isPressed ? 0.7 : 1)
        }
    }
}

/// The camera, reading QR codes only, through Apple's own scanner. Only offered on a phone that has a camera.
private struct Scanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    @MainActor static var available: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
                                           isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(found: found) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        init(found: @escaping (String) -> Void) { self.found = found }
        func dataScanner(_ s: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case let .barcode(b) in items { if let v = b.payloadStringValue { s.stopScanning(); found(v); return } }
        }
    }
}
