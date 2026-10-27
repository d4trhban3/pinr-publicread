import SwiftUI
import UIKit

/// Settings (the site's ui/settings.ts, reached from the menu): "Coin names" as on the site, and the choices code of
/// a design decision, so a person can carry their choices to another phone or to the site without an account.
struct SettingsPanel: View {
    @Environment(ModerationStore.self) private var moderation
    @Environment(WalletStore.self) private var wallet
    @State private var pasted = ""
    @State private var message: String?
    @State private var copied = false
    @State private var pending: ChoicesCode.Choices?
    @State private var shown: String?
    @State private var warn = false

    var body: some View {
        @Bindable var moderation = moderation
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Settings").font(Typo.sans(22, .bold))

                section("Coin names") {
                    row("Hide rude coin names", "Masks the name, ticker and picture of coins with a rude name") {
                        Toggle("", isOn: $moderation.filterNames).labelsHidden()
                    }
                    divider
                    row("Hidden coins", "Coins you hid by pressing and holding a tile or a card") {
                        HStack(spacing: 10) {
                            Text("\(moderation.hidden.count)").font(Typo.sans(15, .bold))
                            if !moderation.hidden.isEmpty {
                                Button("Show them again") { moderation.unhideAll() }.buttonStyle(SBtn())
                            }
                        }
                    }
                }

                // Your choices, in the site's words: one code to copy and paste into the site or
                // another phone. No account, nothing is sent to PINR.
                section("Your choices") {
                    row("Copy my choices", "A short code for your hidden coins, name filter and looked-up address. It holds nothing else, and nothing is sent to PINR.") {
                        Button(copied ? "Copied" : "Copy code") { copy() }
                            .buttonStyle(SBtn()).accessibilityIdentifier("copy-code")
                    }
                    if let shown {
                        Text(shown).font(Typo.mono(11)).textSelection(.enabled).lineLimit(4)
                            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Brand.ink.opacity(0.5)))
                            .accessibilityLabel("Your choices code")
                    }
                    divider
                    row("Paste a code", "From the website or another phone. You will see what it holds before anything changes.") {
                        Button("Check code") { check() }
                            .buttonStyle(SBtn())
                            .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("check-code")
                    }
                    TextField("Paste a choices code", text: $pasted, axis: .vertical)
                        .font(Typo.mono(12)).lineLimit(2...4)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(10).background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Brand.ink.opacity(0.5)))
                        .accessibilityIdentifier("code-field")
                    PasteButton(payloadType: String.self) { strings in
                        Task { @MainActor in pasted = strings.first ?? "" }
                    }
                    .buttonBorderShape(.capsule)
                    if let message {
                        Text(message).font(Typo.sans(13))
                            .foregroundStyle(warn ? Brand.mandarin : Brand.paper.opacity(0.85))
                            .accessibilityIdentifier("code-message")
                    }
                    if pending != nil {
                        HStack(spacing: 10) {
                            Button("Import") { take() }
                                .buttonStyle(SBtn())
                                .accessibilityIdentifier("import-code")
                            Button("Cancel") { pending = nil; message = nil }
                                .buttonStyle(SBtn(quiet: true))
                        }
                    }
                }
            }
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        // Editing the pasted text starts over (clearing it after an import keeps the import's message).
        .onChange(of: pasted) { _, new in if !new.isEmpty { pending = nil; message = nil } }
    }

    private func copy() {
        let code = ChoicesCode.current(moderation: moderation, wallet: wallet)
        UIPasteboard.general.string = code
        shown = code
        copied = true
        Task { try? await Task.sleep(for: .seconds(2)); copied = false }
    }

    private func check() {
        pending = nil
        switch ChoicesCode.read(pasted) {
        case .success(let c):
            pending = c
            warn = false
            message = "This code holds: \(ChoicesCode.summary(c)). Hidden coins are added to yours; nothing is un-hidden."
        case .failure(let r):
            warn = true
            message = r.text
        }
    }

    private func take() {
        guard let c = pending else { return }
        let r = ChoicesCode.apply(c, moderation: moderation, wallet: wallet)
        pending = nil
        pasted = ""
        shown = nil
        warn = false
        message = "Imported: \(r.hiddenAdded) new hidden \(r.hiddenAdded == 1 ? "coin" : "coins")\(r.walletChanged ? ", and the looked-up address" : "")."
    }

    private var divider: some View { Rectangle().fill(Brand.fg.opacity(0.08)).frame(height: 1).accessibilityHidden(true) }

    private func section(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased()).font(Typo.mono(11, .semibold)).tracking(2.4).foregroundStyle(Brand.mute).padding(.leading, 8)
            VStack(alignment: .leading, spacing: 14) { content() }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Brand.glass))
                .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Brand.fg.opacity(0.1), lineWidth: 1))
        }
    }

    private func row(_ label: String, _ hint: String, @ViewBuilder _ right: () -> some View) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(Typo.sans(16, .semibold))
                Text(hint).font(Typo.sans(13)).foregroundStyle(Brand.mute)
            }
            Spacer(minLength: 8)
            right()
        }
        .accessibilityElement(children: .combine)
    }
}

/// The site's settings button (.sbtn): a lime-edged capsule; "quiet" is the grey one (Cancel).
private struct SBtn: ButtonStyle {
    var quiet = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typo.sans(14, .semibold))
            .foregroundStyle(quiet ? Brand.paper : Brand.lime)
            .padding(.horizontal, 14).frame(height: 36)
            .background(Capsule().fill(quiet ? Color.clear : Brand.lime.opacity(0.12)))
            .overlay(Capsule().strokeBorder(quiet ? Brand.fg.opacity(0.2) : Brand.lime.opacity(0.45), lineWidth: 1))
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.45)
            .fixedSize()
    }
}
