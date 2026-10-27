import Foundation

/// no account at launch. A person's choices (the looked-up address, hidden coins, the name filter) travel
/// as one code they copy and paste, between phones or between the app and the site. Format version 1 shared with the site
/// in `pinr-live/EXPORT-CODE-FORMAT.md`: `PINR1.` + base64url (no padding) of the compact JSON `{"v":1,"w":[],"h":[],"f":true}`.
/// The code is made and read on the phone; nothing is sent anywhere.
enum ChoicesCode {
    static let prefix = "PINR1."
    static let maxWallets = 10
    static let maxHidden = 1_000

    /// What a code holds, after dropping whatever is not valid.
    struct Choices: Equatable {
        /// Clean addresses, newest first; this app keeps one profile, so it uses the first.
        var wallets: [String]
        /// Lower-case coin addresses.
        var hidden: [String]
        /// The name filter, or nil when the code has none (the switch then stays as it is).
        var filter: Bool?
    }

    enum Refusal: Error, Equatable {
        case notACode, newer

        var text: String {
            switch self {
            case .notACode: "That is not a PINR code."
            case .newer: "This code is from a newer PINR."
            }
        }
    }

    // MARK: making it

    /// The choices as they are now: the address first, the hidden set sorted (the same choices always make the same
    /// code), the filter switch.
    static func make(wallets: [String], hidden: some Sequence<String>, filter: Bool) -> String {
        let w = Array(wallets.prefix(maxWallets))
        let h = Array(Set(hidden.map { $0.lowercased() }).sorted().prefix(maxHidden))
        let json = #"{"v":1,"w":"# + list(w) + #","h":"# + list(h) + #","f":"# + (filter ? "true" : "false") + "}"
        return prefix + base64url(Data(json.utf8))
    }

    /// A compact JSON list of strings (keys and order are fixed by hand, as the format asks; only the values are encoded).
    private static func list(_ items: [String]) -> String {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return (try? String(decoding: e.encode(items), as: UTF8.self)) ?? "[]"
    }

    private static func base64url(_ d: Data) -> String {
        d.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: reading it

    static func read(_ text: String) -> Result<Choices, Refusal> {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.hasPrefix(prefix) else { return .failure(.notACode) }
        let payload = String(s.dropFirst(prefix.count))
        guard !payload.isEmpty,
              payload.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }),
              let data = fromBase64url(payload),
              let utf8 = String(data: data, encoding: .utf8),
              let object = try? JSONSerialization.jsonObject(with: Data(utf8.utf8)),
              let o = object as? [String: Any]
        else { return .failure(.notACode) }

        // `v`: the number 1; a higher number is from a newer PINR; anything else is not a code.
        guard let v = o["v"] as? NSNumber, !isBool(v) else { return .failure(.notACode) }
        if v.doubleValue > 1 { return .failure(.newer) }
        guard v.doubleValue == 1 else { return .failure(.notACode) }

        var seen = Set<String>()
        let wallets = ((o["w"] as? [Any]) ?? [])
            .compactMap { ($0 as? String).flatMap(WalletRules.clean)?.address }
            .filter { seen.insert($0).inserted }
        var seenCoin = Set<String>()
        let hidden = ((o["h"] as? [Any]) ?? [])
            .compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { !$0.isEmpty && seenCoin.insert($0).inserted }
        let filter = (o["f"] as? NSNumber).flatMap { isBool($0) ? $0.boolValue : nil }
        return .success(Choices(wallets: Array(wallets.prefix(maxWallets)), hidden: Array(hidden.prefix(maxHidden)), filter: filter))
    }

    private static func fromBase64url(_ s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        if b.count % 4 == 1 { return nil }
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }

    /// JSON `true`/`false` arrive as NSNumber too; only a real boolean counts as one.
    private static func isBool(_ n: NSNumber) -> Bool { CFGetTypeID(n) == CFBooleanGetTypeID() }

    /// What a code holds, in the site's words (`describeChoices`): "1 wallet, 2 hidden coins, name filter off".
    static func summary(_ c: Choices) -> String {
        func n(_ k: Int, _ one: String, _ many: String) -> String { "\(k) \(k == 1 ? one : many)" }
        let filter = c.filter.map { "name filter \($0 ? "on" : "off")" } ?? "name filter unchanged"
        return [n(c.wallets.count, "wallet", "wallets"), n(c.hidden.count, "hidden coin", "hidden coins"), filter].joined(separator: ", ")
    }
}

extension ChoicesCode {
    /// This phone's code: the looked-up address, the hidden coins and the filter switch.
    @MainActor static func current(moderation: ModerationStore, wallet: WalletStore) -> String {
        make(wallets: wallet.address.map { [$0] } ?? [], hidden: moderation.hidden, filter: moderation.filterNames)
    }

    /// Takes a read code in, as the format says: hidden coins are added, the filter takes the code's value (kept when
    /// the code has none), the profile becomes the code's first wallet (none in the code: the current one stays).
    @MainActor @discardableResult
    static func apply(_ c: Choices, moderation: ModerationStore, wallet: WalletStore) -> (hiddenAdded: Int, walletChanged: Bool) {
        let before = moderation.hidden
        moderation.add(c.hidden)
        if let f = c.filter { moderation.filterNames = f }
        var changed = false
        if let first = c.wallets.first, first != wallet.address { _ = wallet.view(first); changed = true }
        return (moderation.hidden.subtracting(before).count, changed)
    }
}
