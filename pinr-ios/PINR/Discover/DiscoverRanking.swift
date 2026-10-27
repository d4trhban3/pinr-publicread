import Foundation

/// The Discover tabs, as on the site (pinr-live/src/world/discoverlist.ts).
enum DiscoverTab: String, CaseIterable, Identifiable, Sendable {
    case trending, movers, fresh, pinrscore, basebnb

    var id: String { rawValue }

    var label: String {
        switch self {
        case .movers: "Top Movers"
        case .trending: "Trending"
        case .fresh: "Fresh Launches"
        case .pinrscore: "PINRscore"
        case .basebnb: "Base/BNB"
        }
    }

    var hint: String {
        switch self {
        case .movers: "Largest 24h moves"
        case .trending: "Most active right now"
        case .fresh: "Under an hour old"
        case .pinrscore: "Scored tokens, by PINRscore"
        case .basebnb: "Base and BNB Chain coins, newest first"
        }
    }
}

enum DiscoverRanking {
    /// Rows the list shows.
    static let rows = 30
    /// An address is searched only from this many characters on.
    static let addressQueryMin = 6

    /// The rows for a tab, or for a search. A search looks through every coin, not just the tab's,
    /// and ranks the biggest first.
    static func rank(_ tab: DiscoverTab, _ tokens: [Token], query: String = "", now: Date = Date()) -> [Token] {
        var q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.hasPrefix("$") { q.removeFirst() }
        if !q.isEmpty {
            let weights = Ranking.baseWeights(tokens)
            return tokens.enumerated()
                .filter { matches($0.element, q) }
                .sorted { a, b in weights[a.offset] != weights[b.offset] ? weights[a.offset] > weights[b.offset] : a.offset < b.offset }
                .prefix(rows)
                .map(\.element)
        }
        switch tab {
        case .movers:
            // A coin with no price change ranks below every coin that has one: missing is not zero, and not a move.
            return tokens.enumerated()
                .sorted { a, b in
                    switch (a.element.change24hPct.map(abs), b.element.change24hPct.map(abs)) {
                    case let (x?, y?) where x != y: return x > y
                    case (nil, _?): return false
                    case (_?, nil): return true
                    default: return a.offset < b.offset
                    }
                }
                .prefix(rows)
                .map(\.element)
        case .trending: return Ranking.rank(.trending, tokens, now: now, limit: rows)
        case .fresh: return Ranking.rank(.new, tokens, now: now, limit: rows)
        case .pinrscore: return Ranking.rank(.pinrscore, tokens, now: now, limit: rows)
        case .basebnb: return baseBnb(tokens)
        }
    }

    /// Base and BNB Chain coins, newest first (the time PINR first met the coin, else its launch; a coin with neither goes
    /// last), ties in the feed's order. The server has already left out quiet coins and copies (within one chain); the app adds only
    /// the person's own hides, which the caller applies.
    static func baseBnb(_ tokens: [Token]) -> [Token] {
        let chains: Set<String> = ["base", "bsc"]
        return tokens.enumerated()
            .filter { $0.element.chain.map { chains.contains($0.lowercased()) } ?? false }
            .sorted { a, b in
                switch (a.element.seenAt ?? a.element.launchedAt, b.element.seenAt ?? b.element.launchedAt) {
                case let (x?, y?) where x != y: return x > y
                case (nil, _?): return false
                case (_?, nil): return true
                default: return a.offset < b.offset
                }
            }
            .prefix(rows)
            .map(\.element)
    }

    static func matches(_ t: Token, _ q: String) -> Bool {
        if let n = t.name, n.lowercased().contains(q) { return true }
        if let tk = t.ticker, tk.lowercased().contains(q) { return true }
        return q.count >= addressQueryMin && t.address.lowercased().contains(q)
    }
}

/// The lite chart's line: the feed's last-day price series, drawn on a log scale when it spans a lot.
struct LiteChart: Equatable {
    let points: [Double]
    /// True when the highest price is over six times the lowest (the site's rule).
    let logScale: Bool
    let rising: Bool
    /// Whose history it is, small in the corner: "1h · GeckoTerminal", or "PINR tape · tracked".
    let label: String?

    init?(_ t: Token) {
        guard t.label != .vamp, let s = t.priceSeries, s.count >= 2, let lo = s.min(), let hi = s.max() else { return nil }
        points = s
        logScale = lo > 0 && hi / lo > 6
        rising = s.last! >= s.first!
        label = t.priceSource.map { $0.hasPrefix("PINR") ? "\($0) · tracked" : "1h · \($0)" }
    }
}
