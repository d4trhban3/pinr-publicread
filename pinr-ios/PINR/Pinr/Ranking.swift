import Foundation

/// The PINR page's filters, as on the site (pinr-live/src/world/filters.ts). A filter chooses which
/// tiles show and ranks them, best first; the page shows the top of that ranking.
enum PinrFilter: String, CaseIterable, Identifiable, Sendable {
    case trending, movers, new, pinrscore

    var id: String { rawValue }

    var label: String {
        switch self {
        case .trending: "Trending"
        case .movers: "Movers"
        case .new: "New Launches"
        case .pinrscore: "PINRscore"
        }
    }

    var hint: String {
        switch self {
        case .trending: "Most active right now"
        case .movers: "Biggest score swings"
        case .new: "Under an hour old"
        case .pinrscore: "Real, scored projects by score"
        }
    }
}

enum Ranking {
    /// How many tiles the page shows (the site's base; a setting later).
    static let pageSize = 90
    /// A launch younger than this is a New Launch.
    static let newLaunchMinutes = 60.0
    /// Seconds for the "just traded" boost to halve.
    static let recentHalfLife = 90.0

    /// the PINR page features Pump.fun and PumpSwap (graduated) coins. They are ranked first by the filter's own order;
    /// coins from other launchpads stay shown, ranked the same way, only in the room left after them (Discover and search list every
    /// coin as before). The same test as the launchpad mark.
    static func rankFeatured(_ filter: PinrFilter, _ tokens: [Token], moved: [String: Int] = [:], now: Date = Date(), limit: Int = pageSize) -> [Token] {
        let featured = tokens.filter { Mark.pad($0) == .pump }
        let first = rank(filter, featured, moved: moved, now: now, limit: limit)
        guard first.count < limit else { return first }
        let others = rank(filter, tokens.filter { Mark.pad($0) != .pump }, moved: moved, now: now, limit: limit - first.count)
        return first + others
    }

    /// The top `limit` of a filter's ranking. `order` is the feed's own order (the tie-breaker);
    /// `moved` is each token's score change since the app opened (for Movers).
    static func rank(_ filter: PinrFilter, _ tokens: [Token], moved: [String: Int] = [:],
                     now: Date = Date(), limit: Int = pageSize) -> [Token] {
        let weights = baseWeights(tokens)
        let indexed = tokens.enumerated().map { (i: $0.offset, t: $0.element) }
        func sorted(_ rows: [(i: Int, t: Token)], by measure: ((i: Int, t: Token)) -> Double?, ascending: Bool = false) -> [Token] {
            let scored = rows.map { (row: $0, m: measure($0)) }
            return scored.sorted { a, b in
                switch (a.m, b.m) {
                case let (x?, y?) where x != y: return ascending ? x < y : x > y
                case (nil, _?): return false
                case (_?, nil): return true
                default: return a.row.i < b.row.i
                }
            }.map(\.row.t)
        }

        switch filter {
        case .pinrscore:
            let withScore = indexed.filter { scoreOf($0.t) != nil }
            return Array(sorted(withScore) { scoreOf($0.t).map(Double.init) }.prefix(limit))
        case .new:
            let fresh = indexed.filter { ageMinutes($0.t, now: now).map { $0 < newLaunchMinutes } ?? false }
            return Array(sorted(fresh, by: { ageMinutes($0.t, now: now) }, ascending: true).prefix(limit))
        case .movers:
            return Array(sorted(indexed) { row in Double(abs(moved[row.t.id] ?? 0)) }.prefix(limit))
        case .trending:
            // The site's one tile order: coins scored in the last 24 hours first, newest-scored first;
            // then unscored coins first met in the last 24 hours, newest first; then the rest by what is moving. No order of the app's own.
            func newest(_ pick: ((i: Int, t: Token)) -> Date?) -> [(i: Int, t: Token)] {
                indexed.compactMap { row in pick(row).map { (row: row, at: $0) } }
                    .sorted { $0.at != $1.at ? $0.at > $1.at : $0.row.i < $1.row.i }.map(\.row)
            }
            let scoredNew = newest { scoreOf($0.t) != nil ? Self.recentAt($0.t, now: now) : nil }
            let unscoredNew = newest { scoreOf($0.t) == nil ? Self.recentAt($0.t, now: now) : nil }
            let recent = scoredNew + unscoredNew
            let others = indexed.filter { recentAt($0.t, now: now) == nil }
            let measure: ((i: Int, t: Token)) -> Double? = { trendScore($0.t, base: weights[$0.i], now: now) }
            return Array((recent.map(\.t) + sorted(others, by: measure)).prefix(limit))
        }
    }

    /// How long a coin counts as just seen or just scored (the site's RECENT_MS, the feed server's first page).
    static let recentWindow: TimeInterval = 24 * 3600

    /// When a coin counts from, if that was in the last 24 hours (and not in the future); nil otherwise. The site's `firstPageKey` input:
    /// a scored coin counts from when it was last scored; an unscored one from when PINR first met it, else from its launch (never from
    /// its `as_of`, which a "technical error, retrying" coin moves on every retry).
    static func recentAt(_ t: Token, now: Date) -> Date? {
        let from = scoreOf(t) != nil ? t.asOf : (t.seenAt ?? t.launchedAt)
        guard let d = from else { return nil }
        let age = now.timeIntervalSince(d)
        return age <= recentWindow && age >= -60 ? d : nil
    }

    /// The PINRscore as a number, or nil (unscored, flagged, nothing loaded): never zero.
    static func scoreOf(_ t: Token) -> Int? {
        guard t.label == nil, t.coverage > 0 else { return nil }
        return t.score
    }

    /// True when PINR has read the token: a score, a label, or some coverage.
    static func isRead(_ t: Token) -> Bool { t.score != nil || t.label != nil || t.coverage > 0 }

    static func ageMinutes(_ t: Token, now: Date) -> Double? {
        t.launchedAt.map { max(0, now.timeIntervalSince($0) / 60) }
    }

    /// Long-term weight from market cap, on a log scale across the set: 0.2 to 0.74; 0.12 when unknown
    /// (the site's `importances`).
    static func baseWeights(_ tokens: [Token]) -> [Double] {
        let logs = tokens.map { t in t.valuationUsd.flatMap { $0 > 0 ? log10($0) : nil } }
        let known = logs.compactMap { $0 }
        guard let lo = known.min(), let hi = known.max() else { return logs.map { _ in 0.12 } }
        return logs.map { l in l.map { 0.2 + 0.54 * (hi > lo ? ($0 - lo) / (hi - lo) : 0.5) } ?? 0.12 }
    }

    /// What is happening now (the site's `trendScore`): busy and just-traded count most; size breaks ties.
    /// The site also adds the tile's on-screen animation weight; the app uses the size weight in its place.
    static func trendScore(_ t: Token, base: Double, now: Date) -> Double {
        let recent: Double = t.lastTrade.map { 0.6 * pow(0.5, max(0, now.timeIntervalSince($0)) / recentHalfLife) } ?? 0
        let busy: Double = t.flow.map { $0.trades5m > 0 ? min(1, log10(1 + Double($0.trades5m)) / 2.5) : 0 } ?? 0
        return 0.4 * base + recent + 0.9 * busy
    }
}
