import Foundation

/// a coin's pool events as the engine reads them on chain (`frontend-feed/pools/<mint>.json`), served inside the dossier's `pool`
/// (the site's `poolevents.ts`): pool created, liquidity added and removed, the coin creator changed, bought back and burned. Each is an observed fact (●)
/// with its transaction as the receipt. A field the engine did not read is absent, never zero. State "none": no file, not checked yet; "read" with no
/// events: none observed.
struct PoolEvents: Equatable, Sendable, Decodable {
    struct Event: Equatable, Sendable, Identifiable {
        let atMs: Double, kind: String, sig: String
        let user: String?, base: Double?, quote: Double?
        let quoteSymbol: String, raw: Bool
        let poolBase: Double?, poolQuote: Double?, oldCreator: String?, newCreator: String?
        var id: String { "\(sig)-\(kind)-\(atMs)" }
    }
    let state: String
    let source: String?
    let asOfMs: Double?
    let events: [Event]
    /// "solana", "bnb" or "base": names the explorer
    let chain: String

    static let kinds: Set<String> = ["pool created", "liquidity added", "liquidity removed", "coin creator changed", "bought back and burned"]

    private struct E: Decodable {
        let atMs: Double?, kind: String?, sig: String?, user: String?, base: Double?, quote: Double?, quoteSymbol: String?, raw: Bool?
        let poolBase: Double?, poolQuote: Double?, oldCreator: String?, newCreator: String?
    }
    private enum Key: String, CodingKey { case state, source, asOfMs, events, chain }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let state = try c.decode(String.self, forKey: .state)
        guard state == "none" || state == "read" else { throw DecodingError.dataCorruptedError(forKey: .state, in: c, debugDescription: "unknown state") }
        self.state = state
        source = ((try? c.decodeIfPresent(String.self, forKey: .source)) ?? nil).map { String($0.prefix(60)) }
        asOfMs = (try? c.decodeIfPresent(Double.self, forKey: .asOfMs)) ?? nil
        let ch = ((try? c.decodeIfPresent(String.self, forKey: .chain)) ?? nil) ?? "solana"
        chain = ch == "bnb" || ch == "base" ? ch : "solana"
        func num(_ v: Double?) -> Double? { v.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil } }
        func wallet(_ v: String?) -> String? { v.flatMap { Self.isWallet($0) ? $0 : nil } }
        let list = ((try? c.decodeIfPresent([Lenient<E>].self, forKey: .events)) ?? nil) ?? []
        events = list.compactMap(\.value).compactMap { e in
            guard let kind = e.kind, Self.kinds.contains(kind), let sig = e.sig, Self.isSig(sig), let at = num(e.atMs) else { return nil }
            return Event(atMs: at, kind: kind, sig: sig, user: wallet(e.user), base: num(e.base), quote: num(e.quote),
                         quoteSymbol: e.quoteSymbol.map { String($0.prefix(20)) } ?? "the quote coin", raw: e.raw == true,
                         poolBase: num(e.poolBase), poolQuote: num(e.poolQuote), oldCreator: wallet(e.oldCreator), newCreator: wallet(e.newCreator))
        }
    }

    static func isWallet(_ s: String) -> Bool { s.range(of: "^([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-f]{40})$", options: .regularExpression) != nil }
    static func isSig(_ s: String) -> Bool { s.range(of: "^([1-9A-HJ-NP-Za-km-z]{64,90}|0x[0-9a-f]{64})$", options: .regularExpression) != nil }
}

/// The page's words for a pool event (the site's `renderPool`): observed, never a verdict.
enum PoolWords {
    static func amount(_ n: Double) -> String {
        let us = Locale(identifier: "en_US")
        if n >= 1e9 { return String(format: "%.2fB", locale: us, n / 1e9) }
        if n >= 1e6 { return String(format: "%.2fM", locale: us, n / 1e6) }
        if n >= 1e3 { return String(format: "%.1fK", locale: us, n / 1e3) }
        if n >= 1 { return String(format: "%.2f", locale: us, n) }
        guard n > 0, n.isFinite else { return "0" }
        // three significant digits, written out, never an exponent (0.001, 0.000999)
        let digits = max(0, 2 - Int(log10(n).rounded(.down)))
        var t = String(format: "%.\(min(digits, 14))f", locale: Locale(identifier: "en_US_POSIX"), n)
        if t.contains(".") { while t.hasSuffix("0") { t.removeLast() }; if t.hasSuffix(".") { t.removeLast() } }
        return t
    }
    static func short(_ a: String) -> String { "\(a.prefix(4))…\(a.suffix(4))" }
    /// A coin with no name shows its address, 6 characters then 4 (the site's rule), never a dash.
    static func shortAddress(_ a: String) -> String { a.count > 12 ? "\(a.prefix(6))…\(a.suffix(4))" : a }
    static func title(_ kind: String) -> String { kind.prefix(1).uppercased() + kind.dropFirst() }
    /// The viewer's own clock, as the site draws it: "Oct 25, 12:35 PM" (`zone` only for tests).
    static func local(_ ms: Double, zone: TimeZone = .current) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US"); f.timeZone = zone; f.dateFormat = "MMM d, h:mm a"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
    private static func scan(_ chain: String) -> String { chain == "bnb" ? "https://bscscan.com" : chain == "base" ? "https://basescan.org" : "https://solscan.io" }
    static func txURL(_ sig: String, chain: String = "solana") -> URL? { URL(string: "\(scan(chain))/tx/\(sig)") }
    static func accountURL(_ a: String, chain: String = "solana") -> URL? { URL(string: "\(scan(chain))/\(chain == "solana" ? "account" : "address")/\(a)") }

    /// The amounts line ("12.30 SOL and 1.20M tokens"), "" when the engine read none; raw units are said as such.
    static func what(_ e: PoolEvents.Event) -> String {
        func tokens(_ v: Double?) -> String { v.map { e.raw ? "\(amount($0)) raw token units" : "\(amount($0)) tokens" } ?? "" }
        func quote(_ v: Double?) -> String { v.map { e.raw ? "\(amount($0)) raw \(e.quoteSymbol) units" : "\(amount($0)) \(e.quoteSymbol)" } ?? "" }
        let coin = tokens(e.base), q = quote(e.quote)
        switch e.kind {
        case "bought back and burned": return [coin.isEmpty ? "" : "\(coin) burned", q.isEmpty ? "" : "for \(q)"].filter { !$0.isEmpty }.joined(separator: " ")
        case "pool created":
            let pb = e.poolBase != nil ? tokens(e.poolBase) : coin, pq = e.poolQuote != nil ? quote(e.poolQuote) : q
            return [pq, pb].filter { !$0.isEmpty }.joined(separator: " and ")
        case "coin creator changed": return ""
        default: return [q, coin].filter { !$0.isEmpty }.joined(separator: " and ")
        }
    }
}
