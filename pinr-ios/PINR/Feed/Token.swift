import Foundation

/// One of the four labels that mean "proven bad: show the label, never a number".
enum NoScoreLabel: String, CaseIterable, Sendable {
    case vamp = "VAMP"
    case botRug = "BOT/RUG"
    case mayhem = "MAYHEM"
    case honeypot = "HONEYPOT"
}

/// A token as the app shows it, made from a `WireToken` by the contract's rules
/// (pinr-live/contract/DATA-CONTRACT.md):
/// - a no-score label always wins: the number is dropped;
/// - a score is a whole number from 1 to 99, otherwise there is none;
/// - an optional figure outside its range is missing, never clamped or guessed;
/// - pictures come only from the feed server itself.
struct Token: Equatable, Identifiable, Sendable {
    struct CopyRef: Equatable, Sendable {
        let address: String
        let ticker: String?
        /// True only when the chain confirmed two different creator wallets.
        let chainProven: Bool
    }

    struct Flow: Equatable, Sendable {
        let buy5m: Double
        let sell5m: Double
        let buy1h: Double
        let sell1h: Double
        let trades5m: Int
        let trades1h: Int
        /// True when buy and sell are numbers of trades, not dollars.
        let isCount: Bool
        /// False when the newest trades do not reach back the whole hour.
        let complete: Bool
    }

    /// A figure's receipt: which source it was read from, and when.
    struct Receipt: Equatable, Sendable {
        let source: String
        let at: Date
    }

    let address: String
    var id: String { address.lowercased() }
    let chain: String?
    let launchpad: String?
    let name: String?
    let ticker: String?
    let imageURL: URL?
    /// 1...99, or nil when there is no number.
    let score: Int?
    /// 0...100.
    let coverage: Double
    let label: NoScoreLabel?
    let note: String?
    var valuationUsd: Double?
    let volume24hUsd: Double?
    let change24hPct: Double?
    var priceSeries: [Double]?
    let launchedAt: Date?
    let asOf: Date?
    let rank: Int?
    var priceUsd: Double?
    let liquidityUsd: Double?
    let quotePair: String?
    let changeWindowHours: Double?
    let priceSource: String?
    var lastTrade: Date?
    let quoteReceipt: Receipt?
    let capReceipt: Receipt?
    /// The all-time-high market cap, only where a launchpad's own record states it; else missing.
    let athUsd: Double?
    let athReceipt: Receipt?
    var flow: Flow?
    let copyOf: CopyRef?
    let possibleCopyOf: CopyRef?
    /// the coin's transfer fee when the feed read one and it keeps the contract's rules; else nil (no row).
    let transferFee: TransferFee?
    /// when the trigger first saw a coin that has no score yet; nil on every scored coin (the feed's `seen` is
    /// true only on a file without a score, and a `seen` beside a score or a label is ignored).
    let seenAt: Date?
    /// Whether the feed sent a price line of two or more points,
    /// whatever the app then makes of it.
    var hasChartLine: Bool = false
    /// The engine's count of the hour's trades, preferred over the feed's DexScreener count on a tile; nil when the engine gave none.
    var hourTrades: Int? = nil

    /// Why a token from the feed could not be shown.
    enum LeftOut: Error, Equatable {
        case noAddress
        case badCoverage
        case unknownLabel(String)
    }

    /// Builds a token from the feed's record. `feedBase` is the feed server's address; a
    /// picture anywhere else is dropped (the phone only talks to the feed server).
    static func make(from w: WireToken, feedBase: URL?) -> Result<Token, LeftOut> {
        let address = w.address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else { return .failure(.noAddress) }
        guard w.coverage.isFinite, (0...100).contains(w.coverage) else { return .failure(.badCoverage) }

        var label: NoScoreLabel?
        if let raw = w.noScoreLabel {
            guard let known = NoScoreLabel(rawValue: raw) else { return .failure(.unknownLabel(raw)) }
            label = known
        }
        let score: Int? = label != nil ? nil : w.score.flatMap(wholeScore)

        var made = Token(
            address: address,
            chain: text(w.chain),
            launchpad: text(w.launchpad),
            name: text(w.name),
            ticker: text(w.ticker),
            imageURL: sameServer(w.imageUrl, feedBase),
            score: score,
            coverage: w.coverage,
            label: label,
            note: text(w.note),
            valuationUsd: w.valuationUsd.flatMap { $0 >= 0 ? $0 : nil }.flatMap(finite),
            volume24hUsd: w.volume24hUsd.flatMap { $0 >= 0 ? $0 : nil }.flatMap(finite),
            change24hPct: w.change24hPct.flatMap { $0 > -100 ? $0 : nil }.flatMap(finite),
            priceSeries: w.priceSeries.map { LiveCandle.head($0, price: w.priceUsd) }.flatMap(series),
            launchedAt: w.launchedAtMs.flatMap(date),
            asOf: w.asOfMs.flatMap(date),
            rank: w.rank.flatMap { $0 >= 0 && $0 == $0.rounded() && $0 < Double(Int.max) ? Int($0) : nil },
            priceUsd: w.priceUsd.flatMap { $0 > 0 ? $0 : nil }.flatMap(finite),
            liquidityUsd: w.liquidityUsd.flatMap { $0 >= 0 ? $0 : nil }.flatMap(finite),
            quotePair: text(w.quotePair),
            changeWindowHours: w.changeWindowH.flatMap { $0 > 0 ? $0 : nil }.flatMap(finite),
            priceSource: text(w.priceSource),
            lastTrade: w.lastTradeMs.flatMap(date),
            quoteReceipt: receipt(w.quoteSource, w.quoteAtMs),
            capReceipt: receipt(w.capSource, w.capAtMs),
            athUsd: w.athUsd.flatMap { $0 > 0 ? $0 : nil }.flatMap(finite),
            athReceipt: receipt(w.athSource, w.athAtMs),
            flow: w.flow.flatMap(flow),
            copyOf: w.copyOf.flatMap { copyRef($0, proof: w.copyProof) },
            possibleCopyOf: w.possibleCopyOf.flatMap { copyRef($0, proof: $0.proof) },
            transferFee: w.transferFee?.fee,
            seenAt: w.seen == true && score == nil && label == nil ? w.seenAtMs.flatMap(date) ?? w.asOfMs.flatMap(date) : nil,
            hasChartLine: (w.priceSeries?.count ?? 0) >= 2
        )
        made.hourTrades = w.hourTrades?.n.flatMap { $0.isFinite && $0 >= 0 ? Int($0) : nil }
        return .success(made)
    }

    // MARK: - The field rules

    /// A score is a whole number from 1 to 99; anything else means there is no number.
    static func wholeScore(_ v: Double) -> Int? {
        guard v.isFinite, v == v.rounded(), (1...99).contains(v) else { return nil }
        return Int(v)
    }

    private static func finite(_ v: Double) -> Double? { v.isFinite ? v : nil }

    private static func text(_ s: String?) -> String? {
        guard let t = s.map(Invisible.strip)?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }

    private static func date(_ ms: Double) -> Date? {
        guard ms.isFinite, ms > 0 else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }

    /// A price line has 2 to 500 positive numbers, oldest first; otherwise there is none.
    private static func series(_ s: [Double]) -> [Double]? {
        guard (2...500).contains(s.count), s.allSatisfy({ $0.isFinite && $0 > 0 }) else { return nil }
        return s
    }

    private static func receipt(_ source: String?, _ atMs: Double?) -> Receipt? {
        guard let s = text(source), let at = atMs.flatMap(date) else { return nil }
        return Receipt(source: s, at: at)
    }

    private static func flow(_ f: WireFlow) -> Flow? {
        let figures = [f.buy5m, f.sell5m, f.buy1h, f.sell1h, f.n5m, f.n1h]
        guard figures.allSatisfy({ $0.isFinite && $0 >= 0 }) else { return nil }
        return Flow(buy5m: f.buy5m, sell5m: f.sell5m, buy1h: f.buy1h, sell1h: f.sell1h,
                    trades5m: Int(f.n5m), trades1h: Int(f.n1h), isCount: f.basis == "count", complete: f.complete)
    }

    private static func copyRef(_ r: WireCopyRef, proof: String?) -> CopyRef? {
        guard let a = text(r.address) else { return nil }
        return CopyRef(address: a, ticker: text(r.ticker), chainProven: proof == "chain")
    }

    /// A picture address is kept only when it points at the feed server itself
    /// (the server serves `/api/img?a=<address>`); anything else is dropped.
    static func sameServer(_ raw: String?, _ base: URL?) -> URL? {
        guard let raw = text(raw), let base,
              let url = URL(string: raw, relativeTo: base)?.absoluteURL,
              url.scheme == base.scheme, url.host == base.host, url.port == base.port,
              url.path == "/api/img" else { return nil }
        return url
    }
}

extension Token {
    /// the PINR page's tiles hold back a coin that has neither a picture nor a chart line yet; it joins as soon
    /// as it has one. It stays on Discover, in search and on its own page (the site's `hasSomethingToShow`).
    var hasSomethingToShow: Bool { imageURL != nil || hasChartLine }
}
