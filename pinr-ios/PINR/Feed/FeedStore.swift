import Foundation
import Observation

/// Every token the feed serves, kept current the way the site keeps it (pinr-live/src/world/livefeed.ts), a design decision:
/// the first page (`/api/tokens`) and the rest of the scored set (`/api/tokens/rest`, 500 a page) are read once on
/// open, then kept current by the feed's change stream (`/api/stream`: coin seen, score landed, price tick,
/// graduation, coin gone). Only while the stream is not open do the old polls run (the first page every 15 seconds,
/// the rest every minute). Read-only.
@MainActor
@Observable
final class FeedStore {
    enum State: Equatable {
        case connecting
        case live
        /// The feed did not answer; the last tokens heard stay on screen, marked by this state.
        case offline(reason: String)
        /// The feed speaks another contract; nothing is shown until the two agree.
        case mismatch(contract: String)
    }

    static let pollEvery: Duration = .seconds(15)
    static let sweepEvery: Duration = .seconds(60)
    /// The rest is read in pages of 1,000 (the feed's largest), two at a time.
    static let pageSize = 1000
    static let parallelPages = 2

    private(set) var state: State = .connecting
    /// The first page, in the feed's order.
    private(set) var firstPage: [Token] = []
    /// The rest of the scored set from the last whole sweep (or the pages so far, on the first sweep).
    private(set) var rest: [Token] = []
    /// Every token once: the first page, then the rest without the ones already on it. Kept ready, rebuilt only
    /// when either list changes, so screens never rebuild 8,000 tokens on every redraw.
    private(set) var all: [Token] = []
    /// Every token of `all` by its id, kept with it (round 2 of the PINR and Discover pages each built this
    /// 44,000-entry dictionary on every redraw, 27 ms).
    private(set) var byId: [String: Token] = [:]
    /// How many of the rest have been read, and how many the feed says there are.
    private(set) var restLoaded = 0
    private(set) var restTotal: Int?
    /// Tokens the feed sent that could not be shown (no address, a coverage out of range, an unknown label).
    private(set) var leftOut = 0
    private(set) var lastHeard: Date?
    /// The prices and trades the stream brought lately, the newest 300, and how many have come in all: a chart
    /// folds the ones of its own coin it has not seen (those after its own count) into its candles.
    private(set) var recentTicks: [LiveTick] = []
    private(set) var tickCount = 0
    /// Whether the change stream is open now (false: the app is on the fallback polls).
    private(set) var streaming = false
    /// Each token's score change since the app first saw it (for the Movers filter). A token
    /// without a score has no entry: a label or a missing score is not a move.
    private(set) var moved: [String: Int] = [:]
    private var firstScore: [String: Int] = [:]
    /// The newest trade's price per first-page coin and when it came: kept over a slower list price for a minute.
    private var livePrice: [String: (price: Double, at: Date)] = [:]

    /// Coins asked for by their exact address that are on no list: kept apart, so they
    /// never reach a tile, a tab or a count, but the coin page can open them.
    private(set) var found: [String: Token] = [:]

    let baseURL: URL?
    private let session: URLSession
    private let pageDelay: Duration
    private var sweeping = false
    private var copy = StreamCopy()
    private var firstTokens: [String: Token] = [:]
    private var leftOutFirst = 0
    private var leftOutRest = 0

    init(baseURL: URL? = FeedLink.configuredBaseURL(), session: URLSession = .shared, pageDelay: Duration = .milliseconds(50)) {
        self.baseURL = baseURL
        self.session = session
        self.pageDelay = pageDelay
    }

    /// Called whenever the first page or the rest gains, loses or replaces coins as a set. A stream message that only
    /// changes the figures of coins already on the first page skips it (see `applyChanges`).
    private func rebuildAll() {
        let seen = Set(firstPage.map(\.id))
        let list = firstPage + rest.filter { !seen.contains($0.id) }
        all = list
        byId = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }

    // MARK: - Finding one coin by its address

    /// A coin by its exact address: from the lists if it is there, else asked of the feed (`/api/token/find`; a quiet coin comes back
    /// marked quiet). Nil for an unknown address or a hidden copy.
    func find(_ address: String) async -> Token? {
        let id = address.lowercased()
        if let t = byId[id] ?? found[id] { return t }
        guard CoinAddress.isAddress(address), let baseURL else { return nil }
        var url = baseURL.appending(path: "api/token/find")
        url.append(queryItems: [URLQueryItem(name: "address", value: address)])
        struct Answer: Decodable { let token: WireToken? }
        guard let (answer, _, _, _) = try? await Self.fetch(session, url, Answer.self), let w = answer.token else { return nil }
        guard case .success(let t) = Token.make(from: w, feedBase: baseURL) else { return nil }
        found[t.id] = t
        return t
    }

    // MARK: - Reading

    /// Reads the first page once.
    func poll() async {
        guard let baseURL else { state = .offline(reason: "No feed address in this build"); return }
        do {
            let (snap, tokens, bad, answer) = try await Self.read(session, baseURL.appending(path: "api/tokens"), base: baseURL) { (w: WireSnapshot) in w.tokens }
            guard Contract.acceptsVersion(snap.contract) else { return refuse(snap.contract) }
            noteScores(tokens)
            copy.load(rows: StreamCopy.rows(of: answer), position: snap.stream)
            firstTokens = Dictionary(tokens.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
            firstPage = tokens
            rebuildAll()
            leftOutFirst = bad
            leftOut = leftOutFirst + leftOutRest
            lastHeard = Date()
            state = .live
        } catch let FetchError.status(code) {
            state = .offline(reason: "The feed answered \(code)")
        } catch is DecodingError {
            state = .offline(reason: "The feed's answer could not be read")
        } catch {
            state = .offline(reason: "The feed cannot be reached")
        }
    }

    private struct RestPart: Sendable {
        let page: WireRestPage
        let tokens: [Token]
        let bad: Int
    }

    private func readRest(_ offset: Int, chains: String? = nil) async -> RestPart? {
        guard let baseURL else { return nil }
        var url = baseURL.appending(path: "api/tokens/rest")
        url.append(queryItems: [URLQueryItem(name: "offset", value: String(offset)),
                                URLQueryItem(name: "limit", value: String(Self.pageSize))])
        if let chains { url.append(queryItems: [URLQueryItem(name: "chains", value: chains)]) }
        guard let (page, tokens, bad, _) = try? await Self.read(session, url, base: baseURL, { (w: WireRestPage) in w.tokens }) else { return nil }
        return RestPart(page: page, tokens: tokens, bad: bad)
    }

    /// Base and BNB Chain coins from the rest list, read on their own (a design decision; `chains=base,bsc`): one page, a second or two,
    /// instead of waiting for the whole sweep. Kept for the Discover tab.
    private(set) var chainCoins: [Token] = []
    private(set) var chainCoinsLoaded = false
    func loadChainCoins() async {
        guard let part = await readRest(0, chains: "base,bsc") else { return }
        chainCoins = part.tokens
        chainCoinsLoaded = true
    }

    /// Reads the rest of the scored set: the first page tells how many there are, then the others come `parallelPages` at a
    /// time. A failed
    /// page ends this sweep and keeps what the last whole sweep found; the next sweep starts again.
    func sweep() async {
        guard baseURL != nil, state == .live, !sweeping else { return }
        sweeping = true
        defer { sweeping = false }
        let firstSweep = restTotal == nil
        guard let head = await readRest(0) else { return }
        guard Contract.acceptsVersion(head.page.contract) else { return refuse(head.page.contract) }
        let total = head.page.total
        var collected = head.tokens
        var bad = head.bad
        noteScores(head.tokens)
        if firstSweep {
            rest = collected
            rebuildAll()
            restTotal = total
            restLoaded = min(total, head.page.tokens.tokens.count + head.page.tokens.unreadable)
        }
        let offsets = Array(stride(from: Self.pageSize, to: total, by: Self.pageSize))
        var at = 0
        while at < offsets.count, !Task.isCancelled {
            let wave = Array(offsets[at ..< min(at + Self.parallelPages, offsets.count)])
            at += wave.count
            let parts: [Int: RestPart] = await withTaskGroup(of: (Int, RestPart?).self) { group in
                for o in wave { group.addTask { (o, await self.readRest(o)) } }
                var got: [Int: RestPart] = [:]
                for await (o, part) in group { if let part { got[o] = part } }
                return got
            }
            for o in wave {
                guard let part = parts[o] else { return }
                guard Contract.acceptsVersion(part.page.contract) else { return refuse(part.page.contract) }
                collected += part.tokens
                bad += part.bad
                noteScores(part.tokens)
            }
            if firstSweep {
                rest = collected
                rebuildAll()
                restLoaded = min(total, wave.last! + Self.pageSize)
            }
            try? await Task.sleep(for: pageDelay)
        }
        rest = collected
        rebuildAll()
        restTotal = total
        restLoaded = total
        leftOutRest = bad
        leftOut = leftOutFirst + leftOutRest
    }

    /// Keeps reading while the app is open: both lists once, then the change stream; the polls only while the stream is not open.
    func run() async {
        var lastSweep: ContinuousClock.Instant?
        let stream = Task { await self.streamLoop() }
        defer { stream.cancel() }
        while !Task.isCancelled {
            if !streaming {
                await poll()
                if state == .live, lastSweep.map({ $0.duration(to: .now) >= Self.sweepEvery }) ?? true {
                    lastSweep = .now
                    Task { await self.sweep() }
                }
            }
            try? await Task.sleep(for: Self.pollEvery)
        }
    }

    // MARK: - The change stream

    /// Opens `/api/stream` from where the first page stands and keeps it open; a dropped stream is tried again after a few
    /// seconds, one the server refused (full) after a minute. While it is down, `run` polls.
    func streamLoop() async {
        while !Task.isCancelled {
            var wait: Duration = .seconds(5)
            if state == .live, copy.position != nil {
                switch await readStream() {
                case .refused: wait = .seconds(60)
                case .ended, .reloaded: break
                }
                streaming = false
            }
            try? await Task.sleep(for: wait)
        }
    }

    enum StreamEnd { case ended, refused, reloaded }

    /// One run of the stream: opens it, applies each message, returns when it ends.
    func readStream() async -> StreamEnd {
        guard let baseURL, let position = copy.position else { return .ended }
        var url = baseURL.appending(path: "api/stream")
        url.append(queryItems: [URLQueryItem(name: "boot", value: position.boot), URLQueryItem(name: "since", value: String(position.seq))])
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 70
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        do {
            let (bytes, response) = try await session.bytes(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200 else { return code == 503 ? .refused : .ended }
            streaming = true
            var lines = SSELines()
            for try await line in bytes.lines {
                guard let message = lines.take(line) else { continue }
                if await handleStream(event: message.event, data: message.data) == .reloaded { return .reloaded }
            }
        } catch {}
        return .ended
    }

    /// One stream message: `changes` is applied; `reset` (or a change this copy cannot follow) reads both lists again.
    func handleStream(event: String, data: String) async -> StreamEnd {
        switch event {
        case "reset":
            await reload()
            return .reloaded
        case "changes":
            switch copy.apply(Data(data.utf8)) {
            case .ignored: return .ended
            case .reset:
                await reload()
                return .reloaded
            case .applied(let changed, let gone, let restRows, let restGone, let ticks):
                applyChanges(changed: changed, gone: gone, restRows: restRows, restGone: restGone)
                foldTrades(ticks)
                if !ticks.isEmpty {
                    tickCount += ticks.count
                    recentTicks = Array((recentTicks + ticks).suffix(300))
                }
                return .ended
            }
        default:
            return .ended
        }
    }

    /// The stream cannot follow (or said so): read the first page and the rest again, and open the stream from there.
    private func reload() async {
        copy.clear()
        await poll()
        await sweep()
    }

    private func applyChanges(changed: [String], gone: [String], restRows: [[String: Any]], restGone: [String]) {
        var touched: [Token] = []
        var sameSet = gone.isEmpty && restRows.isEmpty && restGone.isEmpty
        for key in changed {
            if firstTokens[key] == nil { sameSet = false }
            guard let wire = copy.wire(key), case .success(let t) = Token.make(from: wire, feedBase: baseURL) else { continue }
            // A trade's price from the last minute stays over this list price.
            let kept = livePrice[key].flatMap { Date().timeIntervalSince($0.at) < LiveFold.holdSeconds ? $0.price : nil }
            let shown = kept.map { t.repriced(to: $0) } ?? t
            firstTokens[key] = shown
            touched.append(shown)
        }
        for key in gone { firstTokens[key] = nil }
        noteScores(touched)
        let page = copy.order.compactMap { firstTokens[$0] }
        if page.count != firstPage.count { sameSet = false }
        firstPage = page
        if !restRows.isEmpty || !restGone.isEmpty {
            var next = rest
            var at = Dictionary(next.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { _, b in b })
            var fresh: [Token] = []
            for row in restRows {
                guard let wire = StreamCopy.wire(row), case .success(let t) = Token.make(from: wire, feedBase: baseURL) else { continue }
                if let i = at[t.id] {
                    if i < next.count { next[i] = t } else { fresh[i - next.count] = t }
                } else {
                    at[t.id] = next.count + fresh.count
                    fresh.append(t)
                }
            }
            next += fresh
            if !restGone.isEmpty {
                let goneSet = Set(restGone)
                next.removeAll { goneSet.contains($0.id) }
            }
            noteScores(fresh)
            rest = next
        }
        if sameSet {
            // Only figures changed on coins already on the first page: swap them in place, no rebuild of the 44,000.
            all.replaceSubrange(0 ..< page.count, with: page)
            for t in touched { byId[t.id] = t }
        } else {
            rebuildAll()
        }
        lastHeard = Date()
    }

    /// Folds each trade of a stream message into its first-page coin (price, market cap, line, ribbon), in place.
    private func foldTrades(_ ticks: [LiveTick]) {
        var changed: [String: Token] = [:]
        for tick in ticks where tick.usd != nil {
            guard let current = changed[tick.address] ?? firstTokens[tick.address] else { continue }
            let folded = current.folded(tick)
            if folded.priceUsd == tick.price { livePrice[tick.address] = (tick.price, Date()) }
            changed[tick.address] = folded
        }
        guard !changed.isEmpty else { return }
        for (id, t) in changed { firstTokens[id] = t }
        firstPage = firstPage.map { changed[$0.id] ?? $0 }
        all.replaceSubrange(0 ..< min(firstPage.count, all.count), with: firstPage)
        for (id, t) in changed { byId[id] = t }
    }

    // MARK: - Helpers

    private enum FetchError: Error, Sendable { case status(Int) }

    /// Reads one answer and turns it into tokens away from the main thread, so the screen never waits on
    /// thousands of coins being read (the rest of the scored set is 17 pages).
    private nonisolated static func fetch<T: Decodable & Sendable>(_ session: URLSession, _ url: URL, _ type: T.Type) async throws -> (T, Int, Int, Data) {
        try await Task.detached(priority: .userInitiated) {
            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = 15
            let (data, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200 else { throw FetchError.status(code) }
            return (try JSONDecoder().decode(T.self, from: data), 0, 0, data)
        }.value
    }

    private nonisolated static func read<T: Decodable & Sendable>(_ session: URLSession, _ url: URL, base: URL?,
                                                                 _ list: @escaping @Sendable (T) -> LenientTokens) async throws -> (T, [Token], Int, Data) {
        try await Task.detached(priority: .userInitiated) {
            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = 15
            let (data, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200 else { throw FetchError.status(code) }
            let wire = try JSONDecoder().decode(T.self, from: data)
            let (tokens, bad) = build(list(wire), base: base)
            return (wire, tokens, bad, data)
        }.value
    }

    private nonisolated static func build(_ list: LenientTokens, base: URL?) -> ([Token], Int) {
        var out: [Token] = []
        var bad = list.unreadable
        for w in list.tokens {
            switch Token.make(from: w, feedBase: base) {
            case .success(let t): out.append(t)
            case .failure: bad += 1
            }
        }
        return (out, bad)
    }

    private func noteScores(_ tokens: [Token]) {
        for t in tokens {
            guard let s = Ranking.scoreOf(t) else { continue }
            if let first = firstScore[t.id] {
                if s != first { moved[t.id] = s - first } else { moved[t.id] = nil }
            } else {
                firstScore[t.id] = s
            }
        }
    }

    private func refuse(_ contract: String) {
        firstPage = []
        rest = []
        rebuildAll()
        restLoaded = 0
        restTotal = nil
        state = .mismatch(contract: contract)
    }
}
