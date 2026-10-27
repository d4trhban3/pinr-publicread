import Foundation

/// Reads one coin's chart, tape, events and dossier from the feed server. Read-only, and only for
/// a coin the feed lists (the server refuses any other address).
struct CoinClient: Sendable {
    let baseURL: URL?
    let session: URLSession

    enum Failure: Error, Equatable { case noFeed, status(Int), unreadable, unreachable }

    func candles(_ address: String, _ tf: Timeframe) async throws -> CandleSet {
        let w: WireCandles = try await get("api/candles", ["address": address, "tf": tf.rawValue])
        return w.set
    }

    func tape(_ address: String) async throws -> Tape {
        let w: WireTape = try await get("api/trades", ["address": address])
        return w.tape
    }

    func events(_ address: String) async throws -> [ChartEvent] {
        let w: WireEvents = try await get("api/events", ["address": address])
        return w.events
    }

    func metric(_ address: String) async throws -> Metric? {
        let w: WireMetric = try await get("api/metric", ["address": address])
        return w.metric
    }

    func dossier(_ address: String) async throws -> Dossier {
        let w: WireDossier = try await get("api/dossier", ["address": address])
        return w.dossier
    }

    /// The coin's evidence file (rows, the gate's result, PINRai's reading), or nil when the feed has none.
    func evidence(_ address: String) async throws -> EvidenceHub? {
        let w: WireEvidence = try await get("api/evidence", ["address": address])
        return w.hub
    }

    /// TradingView's own symbol for the coin where it lists it (`/api/tvsymbol`), else nil. A failed read is "not known".
    func tvSymbol(_ address: String) async -> String? {
        struct W: Decodable { let symbol: String? }
        let w: W? = try? await get("api/tvsymbol", ["address": address])
        return ChartLinks.validSymbol(w?.symbol)
    }

    private func get<T: Decodable>(_ path: String, _ query: [String: String]) async throws -> T {
        guard let baseURL else { throw Failure.noFeed }
        var url = baseURL.appending(path: path)
        url.append(queryItems: query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) })
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 20
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) } catch { throw Failure.unreachable }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw Failure.status(code) }
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw Failure.unreadable }
    }
}

extension Format {
    /// The site's formatPrice: two decimals from a dollar up (with thousands commas past 1,000), three significant
    /// digits below a dollar ("$0.000457", "$0.0345", "$0.500"); a dash when missing.
    static func price(_ v: Double?) -> String {
        guard let v, v.isFinite, v > 0 else { return dash }
        if v >= 1000 { return "$" + v.formatted(.number.precision(.fractionLength(2)).locale(Locale(identifier: "en_US"))) }
        let decimals = min(14, max(2, 2 - Int(log10(v).rounded(.down))))
        return "$" + String(format: "%.\(v >= 1 ? 2 : decimals)f", locale: Locale(identifier: "en_US_POSIX"), v)
    }

    /// The site's formatPriceCompact, for tight spaces: under $0.0001 the count of zeros after the point as a small
    /// subscript, then three digits ("$0.0₄495"); otherwise as `price`.
    static func priceCompact(_ v: Double?) -> String {
        guard let v, v.isFinite, v > 0 else { return dash }
        if v >= 0.0001 { return price(v) }
        let zeros = -Int(log10(v).rounded(.down)) - 1
        var digits = String(Int((v * pow(10, Double(zeros + 3))).rounded()))
        while digits.count < 3 { digits = "0" + digits }
        let sub = String(zeros).map { "₀₁₂₃₄₅₆₇₈₉"[String.Index(utf16Offset: Int(String($0))!, in: "₀₁₂₃₄₅₆₇₈₉")] }
        return "$0.0" + String(sub) + digits.prefix(3)
    }

    /// "12s ago", "5m ago", "3h ago", "2d ago".
    static func ago(_ d: Date, now: Date = Date()) -> String {
        let s = max(0, now.timeIntervalSince(d))
        if s < 60 { return "\(Int(s))s ago" }
        if s < 3600 { return "\(Int(s / 60))m ago" }
        if s < 86400 * 2 { return "\(Int(s / 3600))h ago" }
        return "\(Int(s / 86400))d ago"
    }

    /// Dollars in full for a trade: "$1,234", "$12.50".
    static func usd(_ v: Double) -> String {
        v >= 100 ? "$" + Int(v.rounded()).formatted(.number.locale(Locale(identifier: "en_US")))
                 : "$" + String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), v)
    }
}
