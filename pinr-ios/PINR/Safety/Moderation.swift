import SwiftUI
import Foundation
import Observation

/// Coin names and pictures are made by strangers (PLAN.md, Apple's review, risk 2). Two tools, both kept on this
/// phone only: a simple word filter that masks rude names (on unless switched off), and a per-coin Hide.
enum NameFilter {
    /// Word stems that mark a name as rude. Matched inside a word, case and accents ignored, with common
    /// letter swaps undone (0→o, 1→i, 3→e, 4→a, 5→s, $→s, @→a). Short and deliberately plain; extend as needed.
    static let stems = [
        "fuck", "fuk", "shit", "cunt", "pussy", "dick", "cock", "bitch", "whore", "slut", "porn", "penis", "vagina",
        "boob", "tits", "anal", "cum", "nigg", "fagg", "retard", "rape", "nazi", "hitler", "kkk", "jizz", "dildo", "wank",
    ]
    /// Stems short enough to sit inside harmless words: matched only as a whole word ("cum" in "document" stays).
    static let wholeWordOnly: Set<String> = ["cum", "anal", "kkk", "tits", "dick", "cock", "rape", "fuk", "porn"]

    /// Set by the app from the person's choice (Filters panel); on by default.
    nonisolated(unsafe) static var enabled = true

    /// Names that contain a stem but are not rude.
    static let allowed: Set<String> = ["moby dick"]

    static func isRude(_ text: String?) -> Bool {
        guard var text, !text.isEmpty else { return false }
        // A ticker's leading "$" is not a letter swap ("$HIT" is not "shit").
        while text.hasPrefix("$") { text.removeFirst() }
        let plain = normalise(text)
        if allowed.contains(plain.trimmingCharacters(in: .whitespaces)) { return false }
        // Matched inside one word at a time, never across a space ("Satoshi Tajiri" is not rude).
        let words = plain.split(whereSeparator: { !$0.isLetter }).map(String.init)
        for s in stems {
            if wholeWordOnly.contains(s) ? words.contains(s) : words.contains(where: { $0.contains(s) }) { return true }
        }
        return false
    }

    static func normalise(_ s: String) -> String {
        let swaps: [Character: Character] = ["0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "$": "s", "@": "a", "!": "i"]
        let folded = s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: .init(identifier: "en_US"))
        return String(folded.lowercased().map { swaps[$0] ?? $0 })
    }

    /// True when this coin's name or ticker is masked right now.
    static func masks(_ t: Token) -> Bool { enabled && (isRude(t.name) || isRude(t.ticker)) }

    static let maskedTitle = "Name hidden"
    static let maskedTicker = "$•••"
}

/// The coins this person has hidden (long-press a tile or card, or the coin page's menu), and the filter switch.
@MainActor
@Observable
final class ModerationStore {
    private(set) var hidden: Set<String>
    var filterNames: Bool {
        didSet { NameFilter.enabled = filterNames; defaults.set(filterNames, forKey: "pinr.filterNames") }
    }
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        hidden = Set(defaults.stringArray(forKey: "pinr.hidden") ?? [])
        filterNames = defaults.object(forKey: "pinr.filterNames") as? Bool ?? true
        NameFilter.enabled = filterNames
    }

    func isHidden(_ t: Token) -> Bool { hidden.contains(t.id) }

    func hide(_ t: Token) { hidden.insert(t.id); save() }
    func unhide(_ id: String) { hidden.remove(id); save() }
    func unhideAll() { hidden.removeAll(); save() }

    /// A choices code's hidden coins: added to the ones already hidden; nothing is un-hidden.
    func add(_ ids: some Sequence<String>) { hidden.formUnion(ids.map { $0.lowercased() }); save() }

    /// The list without the coins this person hid.
    func visible(_ tokens: [Token]) -> [Token] { hidden.isEmpty ? tokens : tokens.filter { !hidden.contains($0.id) } }

    private func save() { defaults.set(Array(hidden), forKey: "pinr.hidden") }
}

/// "Hide this coin" (a long press on a tile or a Discover card, or the coin page's menu).
struct HideButton: View {
    let token: Token
    @Environment(ModerationStore.self) private var moderation
    var body: some View {
        Button(role: .destructive) { moderation.hide(token) } label: { Label("Hide this coin", systemImage: "eye.slash") }
    }
}
