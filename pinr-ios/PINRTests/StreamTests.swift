import Foundation
import Testing
@testable import PINR

private func row(_ address: String, _ extra: String = "") -> [String: Any] {
    let json = #"{"address":"\#(address)","coverage":50,"score":60\#(extra)}"#
    return (try! JSONSerialization.jsonObject(with: Data(json.utf8))) as! [String: Any]
}

private func message(_ seq: Int, boot: String = "b1", seen: String = "[]", score: String = "[]", tick: String = "[]", gone: String = "[]",
                     rest: String = "[]", restGone: String = "[]") -> Data {
    Data(#"{"boot":"\#(boot)","seq":\#(seq),"seen":\#(seen),"score":\#(score),"graduation":[],"tick":\#(tick),"gone":\#(gone),"rest":\#(rest),"restGone":\#(restGone)}"#.utf8)
}

@Suite("The change stream's copy of the first page")
struct StreamCopyTests {
    private func copy() -> StreamCopy {
        var c = StreamCopy()
        c.load(rows: [row("AbC", #","valuationUsd":1000"#), row("dEf")], position: StreamPosition(boot: "b1", seq: 10))
        return c
    }

    @Test("A tick merges only the changed fields; null takes a field away; order is kept")
    func tickMerges() {
        var c = copy()
        guard case .applied(let changed, _, _, _, _) = c.apply(message(11, tick: #"[{"address":"abc","valuationUsd":2000,"score":null}]"#)) else { Issue.record("not applied"); return }
        #expect(changed == ["abc"])
        #expect(c.order == ["abc", "def"])
        #expect(c.wire("abc")?.valuationUsd == 2000)
        #expect(c.wire("abc")?.score == nil)
        #expect(c.position == StreamPosition(boot: "b1", seq: 11))
    }

    @Test("A coin seen joins last; a coin gone leaves")
    func seenAndGone() {
        var c = copy()
        _ = c.apply(message(11, seen: #"[{"address":"New1","coverage":0}]"#))
        #expect(c.order == ["abc", "def", "new1"])
        guard case .applied(_, let gone, _, _, _) = c.apply(message(12, gone: #"["abc"]"#)) else { Issue.record("not applied"); return }
        #expect(gone == ["abc"])
        #expect(c.order == ["def", "new1"])
        #expect(c.wire("abc") == nil)
    }

    @Test("An old message is ignored; a skipped number or another boot asks for a fresh read")
    func resets() {
        var c = copy()
        guard case .ignored = c.apply(message(10)) else { Issue.record("old one not ignored"); return }
        guard case .reset = c.apply(message(12)) else { Issue.record("gap not a reset"); return }
        guard case .reset = c.apply(message(11, boot: "other")) else { Issue.record("boot not a reset"); return }
        #expect(c.position == StreamPosition(boot: "b1", seq: 10))
    }

    @Test("The scored set's rows and departures are passed on")
    func restRows() {
        var c = copy()
        guard case .applied(_, _, let rest, let restGone, _) = c.apply(message(11, rest: #"[{"address":"R1","coverage":50}]"#, restGone: #"["R2"]"#)) else { Issue.record("not applied"); return }
        #expect(rest.count == 1)
        #expect(restGone == ["r2"])
    }

    @Test("Server-Sent Events: a data line completes the message named before it")
    func sseLines() {
        var l = SSELines()
        #expect(l.take("retry: 5000") == nil)
        #expect(l.take("id: b1.11") == nil)
        #expect(l.take("event: changes") == nil)
        let m = l.take(#"data: {"seq":11}"#)
        #expect(m?.event == "changes")
        #expect(m?.data == #"{"seq":11}"#)
        #expect(l.take(": ping") == nil)
        #expect(l.take("data: x")?.event == "message")
    }

    @Test("A coin with neither a picture nor a chart is held back from the tiles")
    func holdBack() throws {
        func token(_ extra: String) throws -> Token {
            let w = try JSONDecoder().decode(WireToken.self, from: Data(#"{"address":"A1","coverage":0\#(extra)}"#.utf8))
            guard case .success(let t) = Token.make(from: w, feedBase: feedBase) else { throw CocoaError(.coderInvalidValue) }
            return t
        }
        #expect(try !token("").hasSomethingToShow)
        #expect(try token(#","priceSeries":[1,2,3]"#).hasSomethingToShow)
        #expect(try token(#","priceSeries":[1,0]"#).hasSomethingToShow) // the site counts any two points
        #expect(try !token(#","priceSeries":[1]"#).hasSomethingToShow)
        #expect(try token(#","imageUrl":"/api/img?u=a""#).hasSomethingToShow)
    }
}

@MainActor
@Suite("The store follows the stream", .serialized)
struct FeedStoreStreamTests {
    @Test("Opened once, then changes arrive by stream; a gap reads the lists again")
    func followsStream() async {
        let first = #"{"contract":"1.0","mode":"feed","asOfMs":1,"files":2,"stream":{"boot":"b1","seq":5},"tokens":[{"address":"A1","coverage":50,"score":60,"valuationUsd":10},{"address":"A2","coverage":50,"score":61}],"problems":[]}"#
        StubFeed.asked = []
        StubFeed.answer = { url in
            switch url.path {
            case "/api/tokens": return (200, first)
            case "/api/tokens/rest": return (200, #"{"contract":"1.0","total":0,"offset":0,"tokens":[]}"#)
            default: return (404, "{}")
            }
        }
        let store = FeedStore(baseURL: feedBase, session: StubFeed.session(), pageDelay: .zero)
        await store.poll()
        #expect(store.firstPage.count == 2)
        _ = await store.handleStream(event: "changes", data: String(decoding: message(6, boot: "b1", tick: #"[{"address":"a1","valuationUsd":99}]"#, rest: #"[{"address":"R1","coverage":50}]"#), as: UTF8.self))
        #expect(store.firstPage.first?.valuationUsd == 99)
        #expect(store.rest.map(\.id) == ["r1"])
        let end = await store.handleStream(event: "changes", data: String(decoding: message(9, boot: "b1"), as: UTF8.self))
        #expect(end == .reloaded)
        #expect(StubFeed.asked.filter { $0 == "/api/tokens" }.count == 2)
    }
}

@Suite("the design's shown facts")
struct Facts197Tests {
    @Test("A Jupiter or Stonk.fun fact with a whole receipt shows its value, not a dash")
    func newSources() throws {
        let rows = #"""
        [{"id":"holder_count","label":"Holders","value":"1,204 wallets","source":"Jupiter","readAtMs":1791650000000,"link":"https://jup.ag/tokens/A"},
         {"id":"rewards_paid","label":"Rewards paid","value":"12.35 SOL","source":"Stonk.fun","readAtMs":1791650000000,"link":"https://www.stonkfun.xyz/token/A"}]
        """#
        let facts = try JSONDecoder().decode(WireDossier.self, from: Data(#"{"available":true,"facts":\#(rows)}"#.utf8)).dossier.facts
        #expect(facts.map(\.value) == ["1,204 wallets", "12.35 SOL"])
    }
}

@MainActor
@Suite("The stream loop", .serialized)
struct StreamLoopTests {
    @Test("After the first page is read, the loop opens the stream and applies what it sends; polling stops")
    func opensTheStream() async {
        let first = #"{"contract":"1.0","mode":"feed","asOfMs":1,"files":1,"stream":{"boot":"b1","seq":5},"tokens":[{"address":"A1","coverage":50,"valuationUsd":10}],"problems":[]}"#
        let sse = "retry: 5000\n\nid: b1.6\nevent: changes\ndata: " + String(decoding: message(6, boot: "b1", tick: #"[{"address":"a1","valuationUsd":99}]"#), as: UTF8.self) + "\n\n"
        StubFeed.asked = []
        StubFeed.answer = { url in
            switch url.path {
            case "/api/tokens": return (200, first)
            case "/api/stream": return (200, sse)
            case "/api/tokens/rest": return (200, #"{"contract":"1.0","total":0,"offset":0,"tokens":[]}"#)
            default: return (404, "{}")
            }
        }
        let store = FeedStore(baseURL: feedBase, session: StubFeed.session(), pageDelay: .zero)
        await store.poll()
        let loop = Task { await store.streamLoop() }
        try? await Task.sleep(for: .milliseconds(800))
        loop.cancel()
        #expect(StubFeed.asked.contains { $0.hasPrefix("/api/stream?") })
        #expect(store.firstPage.first?.valuationUsd == 99)
    }
}

@MainActor
@Suite("The kept list and by-id table", .serialized)
struct KeptListTests {
    @Test("A tick swaps figures in place; a coin seen or gone rebuilds; `byId` always agrees with `all`")
    func keptListsAgree() async {
        let first = #"{"contract":"1.0","mode":"feed","asOfMs":1,"files":2,"stream":{"boot":"b1","seq":5},"tokens":[{"address":"A1","coverage":50,"valuationUsd":10},{"address":"A2","coverage":50}],"problems":[]}"#
        StubFeed.answer = { url in
            switch url.path {
            case "/api/tokens": return (200, first)
            case "/api/tokens/rest": return (200, #"{"contract":"1.0","total":2,"offset":0,"tokens":[{"address":"R1","coverage":50},{"address":"R2","coverage":50}]}"#)
            default: return (404, "{}")
            }
        }
        let s = FeedStore(baseURL: feedBase, session: StubFeed.session(), pageDelay: .zero)
        await s.poll()
        await s.sweep()
        #expect(s.all.map(\.id) == ["a1", "a2", "r1", "r2"])
        _ = await s.handleStream(event: "changes", data: String(decoding: message(6, tick: #"[{"address":"a1","valuationUsd":77}]"#), as: UTF8.self))
        #expect(s.all.map(\.id) == ["a1", "a2", "r1", "r2"])
        #expect(s.all[0].valuationUsd == 77 && s.byId["a1"]?.valuationUsd == 77)
        _ = await s.handleStream(event: "changes", data: String(decoding: message(7, seen: #"[{"address":"N1","coverage":0}]"#), as: UTF8.self))
        #expect(s.all.map(\.id) == ["a1", "a2", "n1", "r1", "r2"])
        #expect(s.byId.keys.sorted() == ["a1", "a2", "n1", "r1", "r2"])
        _ = await s.handleStream(event: "changes", data: String(decoding: message(8, gone: #"["a2"]"#), as: UTF8.self))
        #expect(s.all.map(\.id) == ["a1", "n1", "r1", "r2"] && s.byId["a2"] == nil)
    }
}

@Suite("Live charts")
struct LiveCandleTests {
    private func set(_ rows: [(Double, Double, Double, Double, Double, Double)], status: CandleSet.Status = .ok) -> CandleSet {
        CandleSet(candles: rows.map { Candle(time: Date(timeIntervalSince1970: $0.0), open: $0.1, high: $0.2, low: $0.3, close: $0.4, volume: $0.5) }, source: "x", status: status)
    }

    @Test("A price inside the newest candle moves its high, low and close and adds no volume")
    func sameCandle() throws {
        let s = set([(0, 1, 2, 1, 1.5, 10)])
        let n = try #require(LiveCandle.fold(s, .m1, price: 3, at: Date(timeIntervalSince1970: 30)))
        #expect(n.candles.count == 1 && n.candles[0].high == 3 && n.candles[0].close == 3 && n.candles[0].low == 1 && n.candles[0].volume == 10)
    }

    @Test("A later minute opens a new candle at the last close; a trade adds its dollars")
    func newCandle() throws {
        let s = set([(0, 1, 2, 1, 1.5, 10)])
        let n = try #require(LiveCandle.fold(s, .m1, price: 1.2, at: Date(timeIntervalSince1970: 125), usd: 40))
        #expect(n.candles.count == 2 && n.candles[1].open == 1.5 && n.candles[1].low == 1.2 && n.candles[1].high == 1.5 && n.candles[1].volume == 40)
        #expect(n.candles[1].time == Date(timeIntervalSince1970: 120))
    }

    @Test("A price alone never starts a chart; a trade may; an older time or a stale chart changes nothing")
    func startsAndGuards() {
        let empty = set([])
        #expect(LiveCandle.fold(empty, .m1, price: 1, at: Date(timeIntervalSince1970: 60)) == nil)
        #expect(LiveCandle.fold(empty, .m1, price: 1, at: Date(timeIntervalSince1970: 60), usd: 5, start: true)?.candles.count == 1)
        #expect(LiveCandle.fold(set([(120, 1, 1, 1, 1, 0)]), .m1, price: 2, at: Date(timeIntervalSince1970: 30)) == nil)
        #expect(LiveCandle.fold(set([(0, 1, 1, 1, 1, 0)], status: .stale), .m1, price: 2, at: Date(timeIntervalSince1970: 30)) == nil)
        #expect(LiveCandle.fold(set([(0, 1, 1, 1, 1, 0)]), .m1, price: .nan, at: Date(timeIntervalSince1970: 30)) == nil)
    }

    @Test("A tracked line gets the live price as its newest point only when it has two points and the price moved; never past 500")
    func head() {
        #expect(LiveCandle.head([1, 2], price: 3) == [1, 2, 3])
        #expect(LiveCandle.head([1, 2], price: 2) == [1, 2])
        #expect(LiveCandle.head([1], price: 3) == [1])
        #expect(LiveCandle.head(Array(repeating: 1.0, count: 500), price: 2).count == 500)
    }

    @Test("A trade in the stream message reaches the store's recent trades")
    @MainActor func tradesFromStream() async {
        let first = #"{"contract":"1.0","mode":"feed","asOfMs":1,"files":1,"stream":{"boot":"b1","seq":5},"tokens":[{"address":"A1","coverage":50}],"problems":[]}"#
        StubFeed.answer = { url in url.path == "/api/tokens" ? (200, first) : (404, "{}") }
        let s = FeedStore(baseURL: feedBase, session: StubFeed.session(), pageDelay: .zero)
        await s.poll()
        let msg = #"{"boot":"b1","seq":6,"seen":[],"score":[],"graduation":[],"tick":[],"gone":[],"rest":[],"restGone":[],"trades":[{"address":"A1","atMs":1700000000000,"side":"buy","priceUsd":0.5,"usd":12}]}"#
        _ = await s.handleStream(event: "changes", data: msg)
        #expect(s.tickCount == 1 && s.recentTicks.first?.address == "a1" && s.recentTicks.first?.usd == 12)
    }

    @Test("Only a price the message carries for a coin reaches a chart: a quiet coin grows no candles")
    @MainActor func quietCoinGrowsNothing() async {
        let first = #"{"contract":"1.0","mode":"feed","asOfMs":1,"files":2,"stream":{"boot":"b1","seq":5},"tokens":[{"address":"A1","coverage":50,"priceUsd":1.1},{"address":"A2","coverage":50,"priceUsd":2}],"problems":[]}"#
        StubFeed.answer = { url in url.path == "/api/tokens" ? (200, first) : (404, "{}") }
        let s = FeedStore(baseURL: feedBase, session: StubFeed.session(), pageDelay: .zero)
        await s.poll()
        // A message about another coin, and one about A2 that changes no price.
        _ = await s.handleStream(event: "changes", data: String(decoding: message(6, tick: #"[{"address":"a2","priceUsd":2.5},{"address":"a1","valuationUsd":9}]"#), as: UTF8.self))
        #expect(s.recentTicks.map(\.address) == ["a2"])
        let chart = CandleSet(candles: [Candle(time: Date(timeIntervalSince1970: 0), open: 1, high: 1, low: 1, close: 1, volume: 0)], source: "x", status: .ok)
        var seen = 0
        #expect(LiveCandle.advance(chart, .m1, id: "a1", store: s, seen: &seen) == nil)
        #expect(LiveCandle.advance(chart, .m1, id: "a2", store: s, seen: &seen) == nil) // already counted: nothing new since `seen`
        seen = 0
        #expect(LiveCandle.advance(chart, .m1, id: "a2", store: s, seen: &seen) != nil)
    }
}

@Suite("a design decision and the candle size")
struct FeaturedTests {
    private func token(_ address: String, _ launchpad: String?, score: Int) throws -> Token {
        let pad = launchpad.map { #","launchpad":"\#($0)""# } ?? ""
        let w = try JSONDecoder().decode(WireToken.self, from: Data(#"{"address":"\#(address)","coverage":50,"score":\#(score),"imageUrl":"/api/img?a=\#(address)"\#(pad)}"#.utf8))
        guard case .success(let t) = Token.make(from: w, feedBase: feedBase) else { throw CocoaError(.coderInvalidValue) }
        return t
    }

    @Test("Pump.fun and PumpSwap coins come first by the filter's own order; the rest fill the room left")
    func featuredFirst() throws {
        let all = [try token("C1", "Raydium LaunchLab", score: 99), try token("P1", "Pump.fun curve", score: 50), try token("P2", "PumpSwap (graduated)", score: 70),
                   try token("B1", nil, score: 80)]
        #expect(Ranking.rankFeatured(.pinrscore, all, limit: 10).map(\.address) == ["P2", "P1", "C1", "B1"])
        #expect(Ranking.rankFeatured(.pinrscore, all, limit: 2).map(\.address) == ["P2", "P1"])
        #expect(Ranking.rankFeatured(.pinrscore, all, limit: 3).map(\.address) == ["P2", "P1", "C1"])
    }

    @Test("A chart takes the candle size the feed gave (bucketSec), not the one asked")
    func bucket() throws {
        let w = try JSONDecoder().decode(WireCandles.self, from: Data(#"{"source":"Solana chain","status":"ok","bucketSec":15,"candles":[[30,1,1,1,1,0]]}"#.utf8))
        #expect(w.set.bucketSec == 15)
        let n = try #require(LiveCandle.fold(w.set, .m15, price: 2, at: Date(timeIntervalSince1970: 47)))
        #expect(n.candles.count == 2 && n.candles[1].time == Date(timeIntervalSince1970: 45))
    }
}
