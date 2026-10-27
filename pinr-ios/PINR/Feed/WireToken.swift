import Foundation

/// One token exactly as the feed server sends it (`WireToken` in pinr-live/server/translate.ts).
/// Decoding is lenient field by field: an optional field that is absent, null or of the wrong
/// type is missing (nil), never a guess. Only `address` and `coverage` are required; a token
/// without them cannot be read and is left out.
struct WireToken: Decodable, Equatable, Sendable {
    let address: String
    let coverage: Double
    let score: Double?
    let noScoreLabel: String?
    let chain: String?
    let launchpad: String?
    let name: String?
    let ticker: String?
    let imageUrl: String?
    let note: String?
    let valuationUsd: Double?
    let volume24hUsd: Double?
    let change24hPct: Double?
    let priceSeries: [Double]?
    let launchedAtMs: Double?
    let asOfMs: Double?
    let rank: Double?
    let priceUsd: Double?
    let liquidityUsd: Double?
    let quotePair: String?
    let changeWindowH: Double?
    let priceSource: String?
    let lastTradeMs: Double?
    let quoteSource: String?
    let quoteAtMs: Double?
    let capSource: String?
    let capAtMs: Double?
    let athUsd: Double?
    let athSource: String?
    let athAtMs: Double?
    let flow: WireFlow?
    let copyOf: WireCopyRef?
    let copyProof: String?
    let possibleCopyOf: WireCopyRef?
    let transferFee: WireTransferFee?
    let seen: Bool?
    let seenAtMs: Double?
    /// The engine's own count of the hour's trades: all or nothing, never a part-hour.
    let hourTrades: WireHourTrades?

    private enum Key: String, CodingKey {
        case address, coverage, score, noScoreLabel, chain, launchpad, name, ticker, imageUrl, note
        case valuationUsd, volume24hUsd, change24hPct, priceSeries, launchedAtMs, asOfMs, rank
        case priceUsd, liquidityUsd, quotePair, changeWindowH, priceSource, lastTradeMs
        case quoteSource, quoteAtMs, capSource, capAtMs, athUsd, athSource, athAtMs, flow, copyOf, copyProof, possibleCopyOf, transferFee, seen, seenAtMs, hourTrades
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        address = try c.decode(String.self, forKey: .address)
        coverage = try c.decode(Double.self, forKey: .coverage)
        func opt<T: Decodable>(_ key: Key) -> T? { (try? c.decodeIfPresent(T.self, forKey: key)) ?? nil }
        score = opt(.score)
        noScoreLabel = opt(.noScoreLabel)
        chain = opt(.chain)
        launchpad = opt(.launchpad)
        name = opt(.name)
        ticker = opt(.ticker)
        imageUrl = opt(.imageUrl)
        note = opt(.note)
        valuationUsd = opt(.valuationUsd)
        volume24hUsd = opt(.volume24hUsd)
        change24hPct = opt(.change24hPct)
        priceSeries = opt(.priceSeries)
        launchedAtMs = opt(.launchedAtMs)
        asOfMs = opt(.asOfMs)
        rank = opt(.rank)
        priceUsd = opt(.priceUsd)
        liquidityUsd = opt(.liquidityUsd)
        quotePair = opt(.quotePair)
        changeWindowH = opt(.changeWindowH)
        priceSource = opt(.priceSource)
        lastTradeMs = opt(.lastTradeMs)
        quoteSource = opt(.quoteSource)
        quoteAtMs = opt(.quoteAtMs)
        capSource = opt(.capSource)
        capAtMs = opt(.capAtMs)
        athUsd = opt(.athUsd)
        athSource = opt(.athSource)
        athAtMs = opt(.athAtMs)
        flow = opt(.flow)
        copyOf = opt(.copyOf)
        copyProof = opt(.copyProof)
        possibleCopyOf = opt(.possibleCopyOf)
        transferFee = opt(.transferFee)
        seen = opt(.seen)
        seenAtMs = opt(.seenAtMs)
        hourTrades = opt(.hourTrades)
    }
}

struct WireHourTrades: Decodable, Sendable, Equatable { let n: Double? }

/// Buy and sell over 5 minutes and an hour (`FlowSummary` in pinr-live/server/trades.ts).
/// `basis == "count"` means the figures are numbers of trades, not dollars.
struct WireFlow: Decodable, Equatable, Sendable {
    let buy5m: Double
    let sell5m: Double
    let buy1h: Double
    let sell1h: Double
    let n5m: Double
    let n1h: Double
    let lastAt: Double?
    let complete: Bool
    let basis: String?
}

struct WireCopyRef: Decodable, Equatable, Sendable {
    let address: String
    let ticker: String?
    let proof: String?
}

/// A list of tokens where one unreadable entry is skipped and counted, never fatal to the rest.
struct LenientTokens: Decodable, Sendable {
    let tokens: [WireToken]
    let unreadable: Int

    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        var ok: [WireToken] = []
        var bad = 0
        while !c.isAtEnd {
            if let t = try? c.decode(WireToken.self) { ok.append(t) } else {
                bad += 1
                _ = try? c.decode(Skip.self)
            }
        }
        tokens = ok
        unreadable = bad
    }

    /// Steps over one entry of any shape (a failed decode does not move the list on).
    private struct Skip: Decodable {
        init(from decoder: Decoder) throws {}
    }
}

/// `/api/tokens`: the first page in full, on every poll.
struct WireSnapshot: Decodable, Sendable {
    let contract: String
    let mode: String?
    let asOfMs: Double?
    let tokens: LenientTokens
    /// Where the list stands in `/api/stream` ; absent on an older feed, and then there is no stream.
    let stream: StreamPosition?

    private enum Key: String, CodingKey { case contract, mode, asOfMs, tokens, stream }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        contract = try c.decode(String.self, forKey: .contract)
        mode = (try? c.decodeIfPresent(String.self, forKey: .mode)) ?? nil
        asOfMs = (try? c.decodeIfPresent(Double.self, forKey: .asOfMs)) ?? nil
        tokens = try c.decode(LenientTokens.self, forKey: .tokens)
        stream = (try? c.decodeIfPresent(StreamPosition.self, forKey: .stream)) ?? nil
    }
}

/// `/api/tokens/rest?offset=&limit=`: the rest of the scored set, a page at a time, in lite form.
struct WireRestPage: Decodable, Sendable {
    let contract: String
    let total: Int
    let offset: Int
    let tokens: LenientTokens
}
